import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkAdminAuthWithRateLimit } from '@/lib/adminAuth';
import { searchLDAPUser } from '@/lib/ldap';
import { logAuditAction } from '@/lib/audit-log';

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  let vpnUsername: string | undefined;
  let adminUsername = 'unknown';
  
  try {
    const { admin, response } = await checkAdminAuthWithRateLimit(request);
    if (admin) {
      adminUsername = admin.username;
    }
    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { recordId, adUsername, matchNotes } = body;

    if (!recordId || !adUsername) {
      return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    }

    // Look up AD account to get details
    let adDisplayName = null;
    let adEmail = null;
    let adDepartment = null;
    let ldapLookupSuccess = false;
    
    try {
      const adDetails = await searchLDAPUser(adUsername);
      if (adDetails && adDetails.attributes) {
        ldapLookupSuccess = true;
        // Extract attributes from LDAP response
        for (const attr of adDetails.attributes) {
          if (attr.type === 'cn' && attr.values.length > 0) {
            adDisplayName = attr.values[0];
          } else if (attr.type === 'mail' && attr.values.length > 0) {
            adEmail = attr.values[0];
          } else if (attr.type === 'department' && attr.values.length > 0) {
            adDepartment = attr.values[0];
          }
        }
      }
    } catch (error) {
      console.error('LDAP lookup error:', error);
    }

    // Use transaction for atomic update
    const result = await prisma.$transaction(async (tx: any) => {
      // Update the import record with AD match
      const updated = await tx.vPNImportRecord.update({
        where: { id: recordId },
        data: {
          matchStatus: 'matched',
          adUsername,
          adDisplayName,
          adEmail,
          adDepartment,
          matchedBy: admin.username,
          matchedAt: new Date(),
          matchNotes: matchNotes || null,
        },
        select: {
          id: true,
          vpnUsername: true,
          importId: true,
          adUsername: true,
          matchStatus: true,
        },
      });

      vpnUsername = updated.vpnUsername;

      // Update the import's matched count
      const matchedCount = await tx.vPNImportRecord.count({
        where: {
          importId: updated.importId,
          matchStatus: 'matched',
        },
      });

      await tx.vPNImport.update({
        where: { id: updated.importId },
        data: { matchedRecords: matchedCount },
      });

      return updated;
    });

    const duration = Date.now() - startTime;

    // Log successful match
    await logAuditAction({
      category: 'vpn',
      action: 'vpn_user_matched',
      username: admin.username,
      targetType: 'VPNImportRecord',
      targetId: recordId,
      details: {
        vpnUsername: result.vpnUsername,
        adUsername,
        adDisplayName,
        adEmail,
        ldapLookupSuccess,
        matchNotes,
        duration: `${duration}ms`,
      },
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
      success: true,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    console.error('AD match error:', {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      vpnUsername,
      duration: `${duration}ms`,
    });

    // Log failed match attempt (let audit log failures bubble to prevent untracked admin actions)
    await logAuditAction({
      category: 'vpn',
      action: 'vpn_user_match_failed',
      username: adminUsername,
      targetType: 'VPNImportRecord',
      targetId: 'N/A',
      details: {
        error: errorMessage,
        vpnUsername,
        duration: `${duration}ms`,
      },
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
      success: false,
      errorMessage,
    });

    return NextResponse.json(
      { 
        error: 'Failed to match AD account',
      },
      { status: 500 }
    );
  }
}

// Update match status without AD username (for marking as no_match or conflict)
export async function PATCH(request: NextRequest) {
  const startTime = Date.now();
  let adminUsername = 'unknown';

  try {
    const { admin, response } = await checkAdminAuthWithRateLimit(request);
    if (admin) {
      adminUsername = admin.username;
    }
    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }    const body = await request.json();
    const { recordId, matchStatus, matchNotes } = body;

    if (!recordId || !matchStatus) {
      return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    }

    const updated = await prisma.vPNImportRecord.update({
      where: { id: recordId },
      data: {
        matchStatus,
        matchNotes: matchNotes || null,
        matchedBy: admin.username,
        matchedAt: new Date(),
      },
      select: {
        id: true,
        vpnUsername: true,
        matchStatus: true,
      },
    });

    const duration = Date.now() - startTime;

    // Log status update
    await logAuditAction({
      category: 'vpn',
      action: 'vpn_match_status_updated',
      username: admin.username,
      targetType: 'VPNImportRecord',
      targetId: recordId,
      details: {
        vpnUsername: updated.vpnUsername,
        matchStatus,
        matchNotes,
        duration: `${duration}ms`,
      },
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
      success: true,
    });

    return NextResponse.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    console.error('Update match status error:', {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      duration: `${duration}ms`,
    });

    // Log failed status update (allow failures to bubble to avoid losing audit coverage)
    await logAuditAction({
      category: 'vpn',
      action: 'vpn_match_status_update_failed',
      username: adminUsername,
      targetType: 'VPNImportRecord',
      targetId: 'N/A',
      details: {
        error: errorMessage,
        duration: `${duration}ms`,
      },
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
      success: false,
      errorMessage,
    });

    return NextResponse.json(
      { 
        error: 'Failed to update match status',
      },
      { status: 500 }
    );
  }
}
