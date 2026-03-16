import { NextRequest, NextResponse } from 'next/server';
import { listUsersInOU } from '@/lib/ldap';
import { checkAdminAuthWithRateLimit } from '@/lib/adminAuth';
import { prisma } from '@/lib/prisma';
import { logAuditAction, AuditActions, AuditCategories, getIpAddress, getUserAgent } from '@/lib/audit-log';

export async function GET(request: NextRequest) {
  try {
    const { admin, response } = await checkAdminAuthWithRateLimit(request);

    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [ldapUsers, vpnAccounts] = await Promise.all([
      listUsersInOU(),
      prisma.vPNAccount.findMany({
        select: {
          username: true,
          status: true,
          portalType: true,
          email: true,
        }
      })
    ]);

    // Create a map of all unique usernames
    const userMap = new Map<string, any>();

    // Process LDAP users
    ldapUsers.forEach((u: any) => {
      userMap.set(u.username.toLowerCase(), {
        ...u,
        vpnDetails: null
      });
    });

    // Process VPN accounts
    vpnAccounts.forEach((vpn: any) => {
      const usernameLower = vpn.username.toLowerCase();
      const existing = userMap.get(usernameLower);

      if (existing) {
        existing.vpnDetails = {
          status: vpn.status,
          portalType: vpn.portalType
        };
      } else {
        // VPN-only user (e.g. external)
        userMap.set(usernameLower, {
          username: vpn.username,
          displayName: vpn.username, // Fallback
          email: vpn.email,
          dn: '',
          description: 'VPN Account',
          accountEnabled: vpn.status === 'active',
          accountExpires: null,
          whenCreated: '',
          memberOf: [],
          vpnDetails: {
            status: vpn.status,
            portalType: vpn.portalType
          }
        });
      }
    });

    const users = Array.from(userMap.values());

    // Log viewing the user list
    await logAuditAction({
      action: AuditActions.VIEW_USER_LIST,
      category: AuditCategories.USER,
      username: admin.username,
      details: {
        userCount: users.length,
        adCount: ldapUsers.length,
        vpnCount: vpnAccounts.length
      },
      ipAddress: getIpAddress(request),
      userAgent: getUserAgent(request),
    });

    return NextResponse.json({ users });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch users from Active Directory', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
