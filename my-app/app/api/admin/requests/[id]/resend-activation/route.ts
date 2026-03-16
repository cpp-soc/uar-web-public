import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { checkAdminAuthWithRateLimit } from '@/lib/adminAuth';
import { sendAccountActivationEmail } from '@/lib/email';
import { appLogger } from '@/lib/logger';
import {
    AuditActions,
    AuditCategories,
    getIpAddress,
    getUserAgent,
    logAuditAction,
} from '@/lib/audit-log';

/**
 * Admin endpoint to resend an activation email for an internal access request
 * POST /api/admin/requests/[id]/resend-activation
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { admin, response } = await checkAdminAuthWithRateLimit(request);

        if (!admin || response) {
            return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id: requestId } = await params;

        const accessRequest = await prisma.accessRequest.findUnique({
            where: { id: requestId },
            select: {
                id: true,
                name: true,
                email: true,
                status: true,
                isInternal: true,
                ldapUsername: true,
            },
        });

        if (!accessRequest) {
            return NextResponse.json({ error: 'Request not found' }, { status: 404 });
        }

        // Validation checks
        if (!accessRequest.isInternal) {
            return NextResponse.json(
                { error: 'Activation emails can only be sent for internal users' },
                { status: 400 }
            );
        }

        if (accessRequest.status !== 'approved') {
            return NextResponse.json(
                { error: 'Activation emails can only be sent for approved requests' },
                { status: 400 }
            );
        }

        if (!accessRequest.ldapUsername) {
            return NextResponse.json(
                { error: 'Cannot send activation email: LDAP username is missing' },
                { status: 400 }
            );
        }

        // Generate new token
        const activationToken = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(activationToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

        // Upsert the token (update if exists, create if not)
        // We purposefully reset 'used', 'attempts' and update 'expiresAt' to make the new token valid
        await prisma.accountActivationToken.upsert({
            where: { accessRequestId: requestId },
            update: {
                tokenHash,
                expiresAt,
                used: false,
                usedAt: null,
                attempts: 0,
                createdAt: new Date(), // Reset created date to now
            },
            create: {
                accessRequestId: requestId,
                tokenHash,
                expiresAt,
            },
        });

        try {
            await sendAccountActivationEmail(
                accessRequest.email,
                accessRequest.name,
                accessRequest.ldapUsername,
                activationToken,
                expiresAt
            );

            appLogger.info('Activation email resent', {
                requestId,
                adminUser: admin.username,
                email: accessRequest.email,
            });

            await logAuditAction({
                action: AuditActions.RESEND_ACTIVATION_EMAIL || 'RESEND_ACTIVATION_EMAIL', // Fallback if enum not updated yet
                category: AuditCategories.ACCESS_REQUEST,
                username: admin.username,
                targetId: requestId,
                targetType: 'AccessRequest',
                details: {
                    email: accessRequest.email,
                    name: accessRequest.name,
                    username: accessRequest.ldapUsername,
                },
                ipAddress: getIpAddress(request),
                userAgent: getUserAgent(request),
            });

            return NextResponse.json({
                success: true,
                message: 'Activation email sent successfully',
            });

        } catch (emailError) {
            appLogger.error('Failed to send activation email', {
                requestId,
                error: emailError instanceof Error ? emailError.message : 'Unknown error',
            });

            return NextResponse.json(
                { error: 'Failed to send activation email' },
                { status: 500 }
            );
        }

    } catch (error) {
        appLogger.error('Unexpected error resending activation', {
            error: error instanceof Error ? error.message : 'Unknown error',
        });

        return NextResponse.json(
            { error: 'An unexpected error occurred' },
            { status: 500 }
        );
    }
}
