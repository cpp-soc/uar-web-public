import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkAdminAuthWithRateLimit } from '@/lib/adminAuth';
import logger from '@/lib/logger';
import { logAuditAction, AuditActions, AuditCategories, getIpAddress, getUserAgent } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

// GET /api/admin/settings - Get system settings
export async function GET(request: NextRequest) {
  try {
    const { admin, response } = await checkAdminAuthWithRateLimit(request);
    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get or create settings
    let settings = await prisma.systemSettings.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    // If no settings exist, create default settings
    if (!settings) {
      settings = await prisma.systemSettings.create({
        data: {
          loginDisabled: false,
          internalRegistrationDisabled: false,
          externalRegistrationDisabled: false,
          globalNotificationBanner: null,
          notificationBannerType: null,
          manualOverride: false,
        },
      });
      
      logger.info('Created default system settings', {
        action: 'create_default_settings',
        settingsId: settings.id,
        createdBy: admin.username,
      });
    }

    return NextResponse.json({ settings });
  } catch (error) {
    logger.error('Error fetching system settings', {
      action: 'fetch_settings',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json(
      { error: 'Failed to fetch system settings' },
      { status: 500 }
    );
  }
}

// PATCH /api/admin/settings - Update system settings
export async function PATCH(request: NextRequest) {
  try {
    const { admin, response } = await checkAdminAuthWithRateLimit(request);
    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      loginDisabled,
      internalRegistrationDisabled,
      externalRegistrationDisabled,
      globalNotificationBanner,
      notificationBannerType,
      manualOverride,
      emailFrom,
      adminEmail,
      facultyEmail,
      studentDirectorEmails,
    } = body;

    // Validate notification banner type
    const validBannerTypes = ['info', 'warning', 'error', 'success', null];
    if (notificationBannerType !== undefined && !validBannerTypes.includes(notificationBannerType)) {
      return NextResponse.json(
        { error: 'Invalid notification banner type' },
        { status: 400 }
      );
    }

    // Get current settings
    let currentSettings = await prisma.systemSettings.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    // If no settings exist, create them
    if (!currentSettings) {
      currentSettings = await prisma.systemSettings.create({
        data: {
          loginDisabled: false,
          internalRegistrationDisabled: false,
          externalRegistrationDisabled: false,
          globalNotificationBanner: null,
          notificationBannerType: null,
          manualOverride: false,
        },
      });
    }

    // Check if trying to re-enable logins when manual override is active
    if (currentSettings.manualOverride && currentSettings.loginDisabled && loginDisabled === false) {
      return NextResponse.json(
        { error: 'Login re-enabling is locked. Manual database override is required to unlock this setting.' },
        { status: 403 }
      );
    }

    // Prepare update data
    const updateData: any = {
      lastModifiedBy: admin.username,
    };

    if (loginDisabled !== undefined) updateData.loginDisabled = loginDisabled;
    if (internalRegistrationDisabled !== undefined) updateData.internalRegistrationDisabled = internalRegistrationDisabled;
    if (externalRegistrationDisabled !== undefined) updateData.externalRegistrationDisabled = externalRegistrationDisabled;
    if (globalNotificationBanner !== undefined) updateData.globalNotificationBanner = globalNotificationBanner;
    if (notificationBannerType !== undefined) updateData.notificationBannerType = notificationBannerType;
    
    // Update manualOverride if login is being disabled
    if (manualOverride !== undefined) {
      updateData.manualOverride = manualOverride;
    }

    // Update email configuration
    if (emailFrom !== undefined) updateData.emailFrom = emailFrom;
    if (adminEmail !== undefined) updateData.adminEmail = adminEmail;
    if (facultyEmail !== undefined) updateData.facultyEmail = facultyEmail;
    if (studentDirectorEmails !== undefined) updateData.studentDirectorEmails = studentDirectorEmails;

    const updatedSettings = await prisma.systemSettings.update({
      where: { id: currentSettings.id },
      data: updateData,
    });

    // Clear email config cache when email settings are updated
    if (emailFrom !== undefined || adminEmail !== undefined || facultyEmail !== undefined || studentDirectorEmails !== undefined) {
      const { clearEmailConfigCache } = await import('@/lib/email-config');
      clearEmailConfigCache();
    }

    logger.info('System settings updated', {
      action: 'update_settings',
      settingsId: updatedSettings.id,
      updatedBy: admin.username,
      changes: updateData,
    });

    // Log the settings update to audit log
    await logAuditAction({
      action: AuditActions.UPDATE_SETTINGS,
      category: AuditCategories.SETTINGS,
      username: admin.username,
      targetId: updatedSettings.id,
      targetType: 'SystemSettings',
      details: {
        changes: updateData,
        loginDisabled: updatedSettings.loginDisabled,
        internalRegistrationDisabled: updatedSettings.internalRegistrationDisabled,
        externalRegistrationDisabled: updatedSettings.externalRegistrationDisabled,
        manualOverride: updatedSettings.manualOverride,
      },
      ipAddress: getIpAddress(request),
      userAgent: getUserAgent(request),
    });

    return NextResponse.json({ 
      settings: updatedSettings,
      message: 'Settings updated successfully',
    });
  } catch (error) {
    logger.error('Error updating system settings', {
      action: 'update_settings',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    
    // Log the failed settings update
    const { admin } = await checkAdminAuthWithRateLimit(request);
    if (admin) {
      await logAuditAction({
        action: AuditActions.UPDATE_SETTINGS,
        category: AuditCategories.SETTINGS,
        username: admin.username,
        targetType: 'SystemSettings',
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        ipAddress: getIpAddress(request),
        userAgent: getUserAgent(request),
      });
    }
    
    return NextResponse.json(
      { error: 'Failed to update system settings' },
      { status: 500 }
    );
  }
}
