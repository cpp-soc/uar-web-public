import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { searchLDAPUser } from '@/lib/ldap';
import { checkAdminAuthWithRateLimit } from '@/lib/adminAuth';
import { checkRateLimitAsync, getClientIp } from '@/lib/ratelimit';
import { logAuditAction, AuditActions, AuditCategories, getIpAddress, getUserAgent } from '@/lib/audit-log';

export async function POST(
  request: NextRequest
) {
  try {
    const { admin, response } = await checkAdminAuthWithRateLimit(request);

    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { username, requestId } = body;

    if (!username) {
      return NextResponse.json(
        { error: 'Username is required' },
        { status: 400 }
      );
    }

    // Add aggressive rate limiting for enumeration prevention: 20 requests per minute per username
    // Using username as identifier instead of just IP to allow checking both domain and VPN usernames
    const clientIp = getClientIp(request);
    const rateLimitResult = await checkRateLimitAsync(clientIp, {
      maxRequests: 20,
      windowMs: 60 * 1000, // 1 minute
      identifier: username.toLowerCase(), // Rate limit per username being checked
    });
    
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 }
      );
    }

    // Add random delay to prevent timing attacks (100-300ms)
    await new Promise(resolve => 
      setTimeout(resolve, 100 + Math.random() * 200)
    );

    // Check if username exists in Active Directory (works for both LDAP and VPN accounts)
    // This checks the actual AD to see if the account already exists
    let available = true;
    let source = '';
    let existingRequestId = '';
    
    try {
      const ldapUser = await searchLDAPUser(username);
      
      if (ldapUser) {
        available = false;
        source = 'ldap';
      }
    } catch (ldapError) {
      console.error('LDAP search error:', ldapError);
      // Continue to database check even if LDAP search fails
    }

    // Check if username exists in database for active/pending requests
    // This checks both ldapUsername (domain account) and vpnUsername fields
    // to prevent conflicts across all account types
    // NOTE: We exclude 'rejected' requests to allow username reuse after denial
    if (available) {
      const whereClause: any = {
        OR: [
          { ldapUsername: username },
          { vpnUsername: username }
        ],
        status: {
          notIn: ['rejected'] // Exclude rejected requests - usernames can be reused
        }
      };
      if (requestId) {
        whereClause.NOT = { id: requestId };
      }
      const existingRequest = await prisma.accessRequest.findFirst({
        where: whereClause,
      });

      if (existingRequest) {
        available = false;
        source = 'database';
        existingRequestId = existingRequest.id;
      }
    }

    // Log audit action
    await logAuditAction({
      action: AuditActions.CHECK_USERNAME,
      category: AuditCategories.USER,
      username: admin.username,
      details: {
        checkedUsername: username,
        available,
        source,
        existingRequestId: existingRequestId || undefined,
      },
      ipAddress: getIpAddress(request),
      userAgent: getUserAgent(request),
    });

    if (available) {
      return NextResponse.json({ 
        available: true,
        message: `Username "${username}" is available`
      });
    } else {
      return NextResponse.json({ 
        available: false,
        message: source === 'ldap' 
          ? `Username "${username}" already exists in Active Directory`
          : `Username "${username}" is already in use in a pending request`,
        existingRequestId: existingRequestId || undefined,
        source
      });
    }
  } catch (error) {
    console.error('Error checking username:', error);
    return NextResponse.json(
      { error: 'Failed to check username availability' },
      { status: 500 }
    );
  }
}
