import { NextRequest, NextResponse } from 'next/server';
import { checkAdminAuthWithRateLimit } from '@/lib/adminAuth';
import { prisma } from '@/lib/prisma';
import { logAuditAction, AuditActions, AuditCategories, getIpAddress, getUserAgent } from '@/lib/audit-log';

export async function GET(request: NextRequest) {
  try {
    // Verify admin session with rate limiting
    const { admin, response } = await checkAdminAuthWithRateLimit(request);
    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const action = searchParams.get('action') || undefined;
    const category = searchParams.get('category') || undefined;
    const username = searchParams.get('username') || undefined;
    const targetType = searchParams.get('targetType') || undefined;
    const success = searchParams.get('success');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const search = searchParams.get('search') || undefined;

    // Build where clause
    const where: any = {};
    
    if (action) where.action = action;
    if (category) where.category = category;
    if (username) where.username = { contains: username, mode: 'insensitive' };
    if (targetType) where.targetType = targetType;
    if (success !== null && success !== undefined) {
      where.success = success === 'true';
    }
    
    // Date range filter
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Search across multiple fields
    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } },
        { targetType: { contains: search, mode: 'insensitive' } },
        { details: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Calculate offset
    const skip = (page - 1) * limit;

    // Fetch logs with pagination
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Parse details JSON for each log
    const logsWithParsedDetails = logs.map((log: { id: string; details: string | null; [key: string]: unknown }) => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null,
    }));

    // Log this view action
    await logAuditAction({
      action: AuditActions.VIEW_AUDIT_LOGS,
      category: AuditCategories.LOGS,
      username: admin.username,
      details: {
        page,
        limit,
        filters: { action, category, username, targetType, success, startDate, endDate, search },
        totalResults: total,
      },
      ipAddress: getIpAddress(request),
      userAgent: getUserAgent(request),
    });

    return NextResponse.json({
      logs: logsWithParsedDetails,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 }
    );
  }
}

// Export stats endpoint for dashboard
export async function POST(request: NextRequest) {
  try {
    // Verify admin session

    const { admin, response } = await checkAdminAuthWithRateLimit(request);
    if (!admin || response) {
      return response || NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { action: statsAction } = body;

    if (statsAction === 'get_stats') {
      // Get stats for the last 24 hours, 7 days, and 30 days
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [last24h, last7d, last30d, topUsers, topActions, actionsByCategory] = await Promise.all([
        prisma.auditLog.count({ where: { createdAt: { gte: oneDayAgo } } }),
        prisma.auditLog.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
        prisma.auditLog.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
        
        // Top 5 most active users in last 7 days
        prisma.auditLog.groupBy({
          by: ['username'],
          where: { createdAt: { gte: sevenDaysAgo } },
          _count: { username: true },
          orderBy: { _count: { username: 'desc' } },
          take: 5,
        }),
        
        // Top 10 most common actions in last 7 days
        prisma.auditLog.groupBy({
          by: ['action'],
          where: { createdAt: { gte: sevenDaysAgo } },
          _count: { action: true },
          orderBy: { _count: { action: 'desc' } },
          take: 10,
        }),

        // Actions by category in last 7 days
        prisma.auditLog.groupBy({
          by: ['category'],
          where: { createdAt: { gte: sevenDaysAgo } },
          _count: { category: true },
          orderBy: { _count: { category: 'desc' } },
        }),
      ]);

      return NextResponse.json({
        stats: {
          last24Hours: last24h,
          last7Days: last7d,
          last30Days: last30d,
          topUsers: topUsers.map((u: { username: string; _count: { username: number } }) => ({ username: u.username, count: u._count.username })),
          topActions: topActions.map((a: { action: string; _count: { action: number } }) => ({ action: a.action, count: a._count.action })),
          actionsByCategory: actionsByCategory.map((c: { category: string; _count: { category: number } }) => ({ category: c.category, count: c._count.category })),
        },
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Error processing audit log request:', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}
