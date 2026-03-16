import { NextRequest, NextResponse } from 'next/server';
import { sendAccountReadyEmail, sendAccountActivationEmail } from '@/lib/email';
import { enableLDAPUser } from '@/lib/ldap';
import { prisma } from '@/lib/prisma';
import { checkAdminAuthWithRateLimit } from '@/lib/adminAuth';
import { decryptPassword } from '@/lib/encryption';
import { logAuditAction, AuditActions, AuditCategories, getIpAddress, getUserAgent } from '@/lib/audit-log';
import { extractBronconame } from '@/lib/validation';
import { randomBytes, createHash } from 'crypto';

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
    const { message } = body;

    const accessRequest = await prisma.accessRequest.findUnique({
      where: { id: resolvedParams.id },
    });

    if (!accessRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    if (!accessRequest.isVerified) {
      return NextResponse.json(
        { error: 'Cannot approve unverified request' },
        { status: 400 }
      );
    }

    // Check required credentials based on account type
    if (!accessRequest.ldapUsername) {
      return NextResponse.json(
        { error: 'LDAP username must be set by Student Directors before approval' },
        { status: 400 }
      );
    }

    // External users need password set by Student Directors
    if (!accessRequest.isInternal && !accessRequest.accountPassword) {
      return NextResponse.json(
        { error: 'Account credentials must be set by Student Directors before approval for external users' },
        { status: 400 }
      );
    }

    // External users also need VPN Username
    if (!accessRequest.isInternal && !accessRequest.vpnUsername) {
      return NextResponse.json(
        { error: 'VPN Username must be set for external users before approval' },
        { status: 400 }
      );
    }

    // enable the user bc we disable them incase we reject the request
    try {
      await enableLDAPUser(accessRequest.ldapUsername);
      
      // Enable account if it's different from LDAP username
      if (!accessRequest.isInternal && accessRequest.vpnUsername && accessRequest.vpnUsername !== accessRequest.ldapUsername) {
        await enableLDAPUser(accessRequest.vpnUsername);
      }
    } catch (ldapError) {
      console.error('Error enabling LDAP accounts:', ldapError);
      return NextResponse.json(
        { error: 'Failed to enable account(s) in Active Directory' },
        { status: 500 }
      );
    }

    const result = await prisma.accessRequest.updateMany({
      where: { 
        id: resolvedParams.id,
        status: 'pending_faculty'
      },
      data: {
        status: 'approved',
        approvedAt: new Date(),
        approvedBy: admin.username,
        approvalMessage: message || null,
        accountCreatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      const current = await prisma.accessRequest.findUnique({
        where: { id: resolvedParams.id },
        select: { status: true }
      });
      
      return NextResponse.json({ 
        error: `Request status is ${current?.status}, expected pending_faculty` 
      }, { status: 400 });
    }

    const updatedRequest = await prisma.accessRequest.findUnique({
      where: { id: resolvedParams.id },
    });

    if (!updatedRequest) {
      return NextResponse.json({ error: 'Request not found after update' }, { status: 404 });
    }

    // Create an approval comment
    let commentText: string;
    if (updatedRequest.isInternal) {
      commentText = `Request approved by ${admin.username}. LDAP account enabled in Active Directory. Activation link sent to ${updatedRequest.email}.`;
    } else {
      commentText = `Request approved by ${admin.username}. LDAP account(s) enabled in Active Directory. Credentials sent to ${updatedRequest.email}.`;
    }
    if (message && message.trim()) {
      commentText += `\n\nFollow-up message: ${message}`;
    }
    
    await prisma.requestComment.create({
      data: {
        requestId: resolvedParams.id,
        comment: commentText,
        author: admin.username,
        type: 'system',
      },
    });

    // Send appropriate email based on user type
    console.log('[Approval] Preparing to send email to:', updatedRequest.email);
    console.log('[Approval] Request details:', {
      id: updatedRequest.id,
      name: updatedRequest.name,
      email: updatedRequest.email,
      ldapUsername: updatedRequest.ldapUsername,
      isInternal: updatedRequest.isInternal,
      hasPassword: !!updatedRequest.accountPassword
    });
    
    try {
      if (updatedRequest.isInternal) {
        // Internal users: Generate activation token for password setting
        const activationToken = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(activationToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await prisma.accountActivationToken.create({
          data: {
            accessRequestId: updatedRequest.id,
            tokenHash,
            expiresAt,
          },
        });

        await sendAccountActivationEmail(
          updatedRequest.email,
          updatedRequest.name,
          updatedRequest.ldapUsername!,
          activationToken,
          expiresAt
        );
        console.log('[Approval] ✅ Activation email sent successfully to:', updatedRequest.email);
      } else {
        // External users: Send password via email (existing flow)
        const decryptedPassword = decryptPassword(updatedRequest.accountPassword!);
        console.log('[Approval] Password decrypted successfully');
        
        await sendAccountReadyEmail(
          updatedRequest.email,
          updatedRequest.name,
          updatedRequest.ldapUsername!,
          decryptedPassword,
          !updatedRequest.isInternal,
          message || undefined
        );
        console.log('[Approval] ✅ Email sent successfully to:', updatedRequest.email);
      }
    } catch (emailError) {
      console.error('[Approval] ❌ Failed to send email:', emailError);
      // Re-throw to trigger outer error handling
      throw new Error(`Failed to send email: ${emailError instanceof Error ? emailError.message : 'Unknown error'}`);
    }

    // After successful email send, update VPN account status to 'active' in VPN Management tab
    // For internal users with @cpp.edu email, extract bronconame from email for VPN username
    let vpnAccountUsername: string;
    if (accessRequest.isInternal) {
      vpnAccountUsername = extractBronconame(accessRequest.email) || accessRequest.ldapUsername!;
    } else {
      vpnAccountUsername = accessRequest.vpnUsername || accessRequest.ldapUsername!;
    }
    
    try {
      const vpnAccount = await prisma.vPNAccount.findUnique({
        where: { username: vpnAccountUsername },
      });

      if (vpnAccount) {
        await prisma.vPNAccount.update({
          where: { id: vpnAccount.id },
          data: {
            status: 'active',
            createdByFaculty: true,
            facultyCreatedAt: new Date(),
          },
        });

        // Create status log for VPN account activation
        await prisma.vPNAccountStatusLog.create({
          data: {
            accountId: vpnAccount.id,
            oldStatus: 'pending_faculty',
            newStatus: 'active',
            changedBy: admin.username,
            reason: 'Faculty approved and email sent successfully',
          },
        });
      }
    } catch (vpnError) {
      console.error('Error updating VPN account status:', vpnError);
      // Continue even if VPN account update fails - the main approval and email are complete
    }

    // Log the approval action
    await logAuditAction({
      action: AuditActions.APPROVE_REQUEST,
      category: AuditCategories.ACCESS_REQUEST,
      username: admin.username,
      targetId: resolvedParams.id,
      targetType: 'AccessRequest',
      details: {
        requestName: updatedRequest.name,
        requestEmail: updatedRequest.email,
        ldapUsername: updatedRequest.ldapUsername,
        vpnUsername: updatedRequest.vpnUsername,
        isInternal: updatedRequest.isInternal,
        approvalMessage: message,
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
    console.error('Error approving request:', error);
    
    // Log the failed approval attempt
    const resolvedParams = await params;
    const { admin } = await checkAdminAuthWithRateLimit(request);
    if (admin) {
      await logAuditAction({
        action: AuditActions.APPROVE_REQUEST,
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
      { error: 'Failed to approve request' },
      { status: 500 }
    );
  }
}
