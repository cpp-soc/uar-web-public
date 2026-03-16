export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data?: T;
  message?: string;
}

export interface ApiErrorResponse {
  success?: false;
  error: string;
  details?: string;
  code?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface RateLimitHeaders {
  'X-RateLimit-Limit': string;
  'X-RateLimit-Remaining': string;
  'X-RateLimit-Reset': string;
  'Retry-After'?: string;
}
export interface AccessRequestsResponse {
  requests: import('./admin').AccessRequest[];
  total?: number;
}

export interface VPNAccountsResponse {
  accounts: import('./admin').VPNAccount[];
  total?: number;
}

export interface SupportTicketsResponse {
  tickets: import('./admin').SupportTicket[];
  total?: number;
}

export interface EventsResponse {
  events: import('./admin').Event[];
  total?: number;
}

export interface BatchCreationsResponse {
  batches: import('./admin').BatchCreation[];
  total?: number;
}

export interface SyncStatusResponse {
  accounts: import('./admin').SyncStatusAccount[];
  latestSync?: {
    id: string;
    createdAt: string;
    status: string;
  };
}
export interface BulkActionResponse {
  success: boolean;
  updatedCount: number;
  skippedCount?: number;
  errors?: Array<{
    id: string;
    error: string;
  }>;
}

export interface StatusChangeResponse {
  success: boolean;
  previousStatus: string;
  newStatus: string;
  message?: string;
}
export interface AuditLogEntry {
  id: string;
  createdAt: string;
  action: string;
  category: string;
  username: string;
  targetId?: string;
  targetType?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
}

export interface AuditLogsResponse {
  logs: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}
