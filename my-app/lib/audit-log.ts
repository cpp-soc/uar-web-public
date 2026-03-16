import { prisma } from '@/lib/prisma';
import logger from '@/lib/logger';

export interface AuditLogEntry {
  action: string;
  category: string;
  username: string;
  targetId?: string;
  targetType?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  success?: boolean;
  errorMessage?: string;
}

/**
 * Logs an admin action to the audit log
 * @param entry The audit log entry data
 */
export async function logAuditAction(entry: AuditLogEntry): Promise<void> {
  // Log to stdout/Splunk first
  logger.info(entry.action, {
    type: 'audit_log',
    ...entry,
    details: entry.details // Pass object directly for JSON logging
  });

  try {
    // Log to database
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        category: entry.category,
        username: entry.username,
        targetId: entry.targetId,
        targetType: entry.targetType,
        details: entry.details ? JSON.stringify(entry.details) : null,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        success: entry.success ?? true,
        errorMessage: entry.errorMessage,
      },
    });
  } catch (error) {
    console.error('Failed to log audit action:', error);
    throw error instanceof Error
      ? error
      : new Error('Unknown error occurred while writing audit log');
  }
}

/**
 * Helper to extract IP address from request headers
 */
export function getIpAddress(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return request.headers.get('x-real-ip') || undefined;
}

/**
 * Helper to get user agent from request
 */
export function getUserAgent(request: Request): string | undefined {
  return request.headers.get('user-agent') || undefined;
}

// Action types for consistency
export const AuditActions = {
  // Navigation
  VIEW_PAGE: 'view_page',
  SWITCH_TAB: 'switch_tab',
  ADMIN_LOGOUT: 'admin_logout',

  // Access Requests
  VIEW_REQUEST: 'view_request',
  APPROVE_REQUEST: 'approve_request',
  REJECT_REQUEST: 'reject_request',
  ACKNOWLEDGE_REQUEST: 'acknowledge_request',
  CREATE_ACCOUNT: 'create_account',
  UPDATE_ACCOUNT: 'update_account',
  MOVE_BACK_REQUEST: 'move_back_request',
  UNDO_FACULTY_NOTIFICATION: 'undo_faculty_notification',
  SEND_TO_FACULTY: 'send_to_faculty',
  ADD_COMMENT: 'add_comment',
  RESEND_VERIFICATION_EMAIL: 'resend_verification_email',
  RESEND_ACTIVATION_EMAIL: 'resend_activation_email',
  ADMIN_TRIGGER_PASSWORD_RESET: 'admin_trigger_password_reset',

  // Events
  VIEW_EVENT_LIST: 'view_event_list',
  CREATE_EVENT: 'create_event',
  UPDATE_EVENT: 'update_event',
  DELETE_EVENT: 'delete_event',
  ACTIVATE_EVENT: 'activate_event',
  DEACTIVATE_EVENT: 'deactivate_event',
  VIEW_EVENT: 'view_event',

  // Users
  VIEW_USER: 'view_user',
  VIEW_USER_LIST: 'view_user_list',
  SEARCH_USERS: 'search_users',
  UPDATE_USER: 'update_user',
  DELETE_USER: 'delete_user',
  DISABLE_USER: 'disable_user',
  ENABLE_USER: 'enable_user',

  // Batch Accounts
  CREATE_BATCH: 'create_batch',
  VIEW_BATCH: 'view_batch',
  VIEW_BATCH_DETAILS: 'view_batch_details',

  // VPN Management
  CREATE_VPN_ACCOUNT: 'create_vpn_account',
  UPDATE_VPN_ACCOUNT: 'update_vpn_account',
  DELETE_VPN_ACCOUNT: 'delete_vpn_account',
  DISABLE_VPN_ACCOUNT: 'disable_vpn_account',
  ENABLE_VPN_ACCOUNT: 'enable_vpn_account',
  SEND_VPN_TO_FACULTY: 'send_vpn_to_faculty',
  VIEW_VPN_ACCOUNT: 'view_vpn_account',
  CLEAR_VPN_IMPORT_QUEUE: 'clear_vpn_import_queue',
  VPN_COMMENT: 'vpn_comment',

  // Support Tickets
  VIEW_TICKET: 'view_ticket',
  CREATE_TICKET_RESPONSE: 'create_ticket_response',
  UPDATE_TICKET_STATUS: 'update_ticket_status',
  CLOSE_TICKET: 'close_ticket',
  REOPEN_TICKET: 'reopen_ticket',

  // Blocklist
  ADD_BLOCKLIST: 'add_blocklist',
  REMOVE_BLOCKLIST: 'remove_blocklist',
  UPDATE_BLOCKLIST: 'update_blocklist',
  VIEW_BLOCKLIST: 'view_blocklist',

  // Settings
  UPDATE_SETTINGS: 'update_settings',
  TOGGLE_LOGIN: 'toggle_login',
  TOGGLE_REGISTRATION: 'toggle_registration',
  CREATE_NOTIFICATION: 'create_notification',
  UPDATE_NOTIFICATION: 'update_notification',
  DELETE_NOTIFICATION: 'delete_notification',

  // Logs
  VIEW_AUDIT_LOGS: 'view_audit_logs',
  EXPORT_AUDIT_LOGS: 'export_audit_logs',

  // Search & Check Operations
  CHECK_USERNAME: 'check_username',
  SEARCH_AD: 'search_ad',

  // Cleanup Operations
  RUN_CLEANUP: 'run_cleanup',

  // Infrastructure Operations
  SYNC_INFRASTRUCTURE: 'sync_infrastructure',
  VIEW_SYNC_RESULTS: 'view_sync_results',
  VIEW_SYNC_STATUS: 'view_sync_status',

  // List View Operations
  VIEW_REQUESTS_LIST: 'view_requests_list',
  VIEW_TICKETS_LIST: 'view_tickets_list',
  VIEW_VPN_ACCOUNTS_LIST: 'view_vpn_accounts_list',
  VIEW_IMPORT_DETAILS: 'view_import_details',

  // Manual Assignment
  MANUAL_ASSIGN_REQUEST: 'manual_assign_request',

  // Account Lifecycle Management
  CREATE_LIFECYCLE_ACTION: 'create_lifecycle_action',
  PROCESS_LIFECYCLE_ACTION: 'process_lifecycle_action',
  CANCEL_LIFECYCLE_ACTION: 'cancel_lifecycle_action',
  RETRY_LIFECYCLE_ACTION: 'retry_lifecycle_action',
  DELETE_LIFECYCLE_ACTION: 'delete_lifecycle_action',
  CREATE_LIFECYCLE_BATCH: 'create_lifecycle_batch',
  DISABLE_AD_ACCOUNT: 'disable_ad_account',
  ENABLE_AD_ACCOUNT: 'enable_ad_account',
  REVOKE_VPN_ACCESS: 'revoke_vpn_access',
  RESTORE_VPN_ACCESS: 'restore_vpn_access',
  PROMOTE_VPN_ROLE: 'promote_vpn_role',
  DEMOTE_VPN_ROLE: 'demote_vpn_role',
  VIEW_LIFECYCLE_ACTIONS: 'view_lifecycle_actions',
  VIEW_LIFECYCLE_HISTORY: 'view_lifecycle_history',

  // AD Account Comments
  CREATE_AD_COMMENT: 'create_ad_comment',
  UPDATE_AD_COMMENT: 'update_ad_comment',
  DELETE_AD_COMMENT: 'delete_ad_comment',
  PIN_AD_COMMENT: 'pin_ad_comment',
  UNPIN_AD_COMMENT: 'unpin_ad_comment',

  // Generic API Request Logging
  ADMIN_API_REQUEST: 'admin_api_request',

  // Group Management
  VIEW_GROUP_LIST: 'view_group_list',
  ADD_GROUP_MEMBER: 'add_group_member',
  REMOVE_GROUP_MEMBER: 'remove_group_member',

  // Authentication
  LOGIN_SUCCESS: 'login_success',
} as const;

// Categories for organizing logs
export const AuditCategories = {
  NAVIGATION: 'navigation',
  ACCESS_REQUEST: 'access_request',
  EVENT: 'event',
  USER: 'user',
  GROUP: 'group',
  BATCH: 'batch',
  VPN: 'vpn',
  SUPPORT: 'support',
  BLOCKLIST: 'blocklist',
  SETTINGS: 'settings',
  LOGS: 'logs',
  LIFECYCLE: 'lifecycle',
  SYNC_STATUS: 'sync_status',
  SESSION: 'session',
  SEARCH: 'search',
  AUTH: 'auth',
} as const;

/**
 * Categorize admin API request by pathname
 */
export function categorizeRequest(pathname: string): string {
  if (pathname.includes('/requests')) return AuditCategories.ACCESS_REQUEST;
  if (pathname.includes('/events')) return AuditCategories.EVENT;
  if (pathname.includes('/users')) return AuditCategories.USER;
  if (pathname.includes('/vpn')) return AuditCategories.VPN;
  if (pathname.includes('/support')) return AuditCategories.SUPPORT;
  if (pathname.includes('/batch')) return AuditCategories.BATCH;
  if (pathname.includes('/lifecycle')) return AuditCategories.LIFECYCLE;
  if (pathname.includes('/settings')) return AuditCategories.SETTINGS;
  if (pathname.includes('/logs')) return AuditCategories.LOGS;
  if (pathname.includes('/sessions')) return AuditCategories.SESSION;
  if (pathname.includes('/sync-status')) return AuditCategories.SYNC_STATUS;
  if (pathname.includes('/search')) return AuditCategories.SEARCH;
  if (pathname.includes('/blocklist')) return AuditCategories.BLOCKLIST;
  if (pathname.includes('/track-view')) return AuditCategories.NAVIGATION;
  return AuditCategories.NAVIGATION;
}
