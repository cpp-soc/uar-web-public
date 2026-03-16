import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendRejectionEmail } from '@/lib/email';
import { checkAdminAuthWithRateLimit } from '@/lib/adminAuth';
import { deleteLDAPUser, disableLDAPUser, setLDAPUserExpiration } from '@/lib/ldap';
import { logAuditAction, AuditActions, AuditCategories, getIpAddress, getUserAgent } from '@/lib/audit-log';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { admin, response } = await checkAdminAuthWithRateLimit(request);

    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const resolvedParams = await params;
    const body = await request.json();
    const { reason } = body;

    if (!reason || !reason.trim()) {
      return NextResponse.json(
        { error: 'Rejection reason is required' },
        { status: 400 }
      );
    }

    const accessRequest = await prisma.accessRequest.findUnique({
      where: { id: resolvedParams.id },
    });

    if (!accessRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    // Allow rejection from any non-terminal state
    if (accessRequest.status === 'approved' || accessRequest.status === 'rejected') {
      return NextResponse.json(
        { error: 'Request has already been processed and cannot be rejected' },
        { status: 400 }
      );
    }

    // AUTOMATIC CLEANUP: Delete LDAP accounts and VPN records if they were created
    // This enables clean retry and prevents orphaned accounts
    // SAFETY: Only deletes accounts that belong to THIS request (verified by request ID)
    const needsLdapCleanup = accessRequest.accountCreatedAt !== null;
    const cleanupResults: Array<{ username: string; success: boolean; method?: string; error?: string }> = [];

    // VPN Account Cleanup
    // Find and delete any VPN account records associated with this request
    const vpnAccountToDelete = await prisma.vPNAccount.findFirst({
      where: { accessRequestId: resolvedParams.id },
    });

    if (vpnAccountToDelete) {
      try {
        console.log(`[Rejection Cleanup] Deleting VPN account record: ${vpnAccountToDelete.username} (status: ${vpnAccountToDelete.status})`);
        
        // Log the deletion in the status log before deleting
        await prisma.vPNAccountStatusLog.create({
          data: {
            accountId: vpnAccountToDelete.id,
            oldStatus: vpnAccountToDelete.status,
            newStatus: 'deleted',
            changedBy: admin.username,
            reason: 'Request rejected before account was activated',
          },
        });

        // Delete the VPN account record completely since it was never activated
        await prisma.vPNAccount.delete({
          where: { id: vpnAccountToDelete.id },
        });

        console.log(`[Rejection Cleanup] ✅ Successfully deleted VPN account record: ${vpnAccountToDelete.username}`);
      } catch (vpnError) {
        console.error(`[Rejection Cleanup] ⚠️ Failed to delete VPN account record:`, vpnError);
        // Continue with rejection even if VPN cleanup fails
      }
    }

    if (needsLdapCleanup) {
      const accountsToCleanup: string[] = [];
      
      if (accessRequest.ldapUsername) {
        accountsToCleanup.push(accessRequest.ldapUsername);
      }
      
      if (accessRequest.vpnUsername && accessRequest.vpnUsername !== accessRequest.ldapUsername) {
        accountsToCleanup.push(accessRequest.vpnUsername);
      }

      // SAFETY CHECK: Only cleanup if request is not approved
      // Approved accounts should NEVER be automatically deleted
      if (accessRequest.status === 'approved') {
        console.error(`[Rejection Cleanup] BLOCKED: Cannot cleanup approved request ${resolvedParams.id}`);
        throw new Error('Cannot reject an approved request. Approved accounts must be manually disabled if needed.');
      }

      for (const username of accountsToCleanup) {
        try {
          // Try deletion first (cleanest approach)
          // Pass request ID for safety verification - will only delete if account belongs to this request
          await deleteLDAPUser(username, accessRequest.id);
          cleanupResults.push({ username, success: true, method: 'deleted' });
          console.log(`[Rejection Cleanup] Successfully deleted LDAP account: ${username} (request: ${accessRequest.id})`);
        } catch (deleteError) {
          console.warn(`[Rejection Cleanup] Delete failed for ${username}, attempting disable`, deleteError);
          
          try {
            // Fallback: disable and expire
            await disableLDAPUser(username);
            await setLDAPUserExpiration(username, new Date());
            cleanupResults.push({ username, success: true, method: 'disabled' });
            console.log(`[Rejection Cleanup] Successfully disabled LDAP account: ${username}`);
          } catch (disableError) {
            const errorMsg = disableError instanceof Error ? disableError.message : 'Unknown error';
            cleanupResults.push({ username, success: false, error: errorMsg });
            console.error(`[Rejection Cleanup] Failed to cleanup ${username}:`, disableError);
          }
        }
      }

      // If any cleanup failed, log it but continue with rejection
      const failedCleanups = cleanupResults.filter(r => !r.success);
      if (failedCleanups.length > 0) {
        console.error('[Rejection Cleanup] Some LDAP accounts could not be cleaned up:', failedCleanups);
        
        // Log to database for manual follow-up
        await prisma.requestComment.create({
          data: {
            requestId: resolvedParams.id,
            comment: `⚠️ LDAP cleanup partially failed during rejection. Manual verification needed for: ${
              failedCleanups.map(f => `${f.username} (${f.error})`).join(', ')
            }`,
            author: 'System',
            type: 'system',
          },
        }).catch((commentError: unknown) => {
          console.error('Failed to log cleanup failure:', commentError);
        });
      }
    }

    const result = await prisma.accessRequest.updateMany({
      where: { 
        id: resolvedParams.id,
        status: { notIn: ['approved', 'rejected'] }
      },
      data: {
        status: 'rejected',
        rejectionReason: reason,
        rejectedBy: admin.username,
        rejectedAt: new Date(),
      },
    });

    if (result.count === 0) {
      const current = await prisma.accessRequest.findUnique({
        where: { id: resolvedParams.id },
        select: { status: true }
      });
      
      return NextResponse.json({ 
        error: `Cannot reject request. Current status: ${current?.status}` 
      }, { status: 400 });
    }

    const updatedRequest = await prisma.accessRequest.findUnique({
      where: { id: resolvedParams.id },
    });

    if (!updatedRequest) {
      return NextResponse.json({ error: 'Request not found after update' }, { status: 404 });
    }

    // Create a rejection comment for tracking
    let commentText = `Request rejected.\n\nReason: ${reason}`;
    
    // Add VPN cleanup info to comment
    if (vpnAccountToDelete) {
      commentText += `\n\nVPN account record automatically deleted: ${vpnAccountToDelete.username} (status was: ${vpnAccountToDelete.status})`;
    }
    
    // Add LDAP cleanup info to comment
    if (cleanupResults.length > 0) {
      const successfulCleanups = cleanupResults.filter(r => r.success);
      if (successfulCleanups.length > 0) {
        commentText += `\n\nLDAP accounts automatically cleaned up: ${
          successfulCleanups.map(r => `${r.username} (${r.method})`).join(', ')
        }`;
      }
    }
    
    await prisma.requestComment.create({
      data: {
        requestId: resolvedParams.id,
        comment: commentText,
        author: admin.username,
        type: 'rejection',
      },
    });

    // Send rejection email to user
    await sendRejectionEmail(
      updatedRequest.email,
      updatedRequest.name,
      reason
    );

    // Log the rejection action
    await logAuditAction({
      action: AuditActions.REJECT_REQUEST,
      category: AuditCategories.ACCESS_REQUEST,
      username: admin.username,
      targetId: resolvedParams.id,
      targetType: 'AccessRequest',
      details: {
        requestName: updatedRequest.name,
        requestEmail: updatedRequest.email,
        rejectionReason: reason,
        vpnAccountDeleted: vpnAccountToDelete ? vpnAccountToDelete.username : null,
        ldapCleanup: cleanupResults,
        emailSent: true,
      },
      ipAddress: getIpAddress(request),
      userAgent: getUserAgent(request),
    });

    return NextResponse.json({ 
      success: true, 
      request: updatedRequest 
    });
  } catch (error) {
    console.error('Error rejecting request:', error);
    
    // Log the failed rejection attempt
    const resolvedParams = await params;
    const { admin } = await checkAdminAuthWithRateLimit(request);
    if (admin) {
      await logAuditAction({
        action: AuditActions.REJECT_REQUEST,
        category: AuditCategories.ACCESS_REQUEST,
        username: admin.username,
        targetId: resolvedParams.id,
        targetType: 'AccessRequest',
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        ipAddress: getIpAddress(request),
        userAgent: getUserAgent(request),
      });
    }
    
    return NextResponse.json(
      { error: 'Failed to reject request' },
      { status: 500 }
    );
  }
}
