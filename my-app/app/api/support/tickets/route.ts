import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkRateLimitAsync, getClientIp, RateLimitPresets } from '@/lib/ratelimit';
import { getSessionFromCookies } from '@/lib/session';

async function checkUserAuth() {
  const session = await getSessionFromCookies();

  if (!session) {
    return null;
  }

  return { username: session.username, isAdmin: session.isAdmin };
}

export async function POST(request: NextRequest) {
  try {
    const clientIp = getClientIp(request);
    const rateLimitResult = await checkRateLimitAsync(clientIp, RateLimitPresets.requestSubmission);
    
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { 
          error: 'Too many support ticket submissions. Please try again later.',
          retryAfter: Math.ceil((rateLimitResult.reset - Date.now()) / 1000),
        },
        { 
          status: 429,
          headers: {
            'X-RateLimit-Limit': rateLimitResult.limit.toString(),
            'X-RateLimit-Remaining': rateLimitResult.remaining.toString(),
            'X-RateLimit-Reset': new Date(rateLimitResult.reset).toISOString(),
            'Retry-After': Math.ceil((rateLimitResult.reset - Date.now()) / 1000).toString(),
          },
        }
      );
    }

    const auth = await checkUserAuth();

    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized - You must be logged in' }, { status: 401 });
    }

    const body = await request.json();
    const { subject, category, severity, body: ticketBody, relatedRequestId } = body;

    if (!subject || !ticketBody) {
      return NextResponse.json(
        { error: 'Subject and message body are required' },
        { status: 400 }
      );
    }

    // Validate category if provided
    if (category && !['SDC', 'SOC'].includes(category)) {
      return NextResponse.json(
        { error: 'Category must be either SDC or SOC' },
        { status: 400 }
      );
    }

    // Validate severity if provided
    if (severity && !['low', 'medium', 'high', 'critical'].includes(severity)) {
      return NextResponse.json(
        { error: 'Severity must be low, medium, high, or critical' },
        { status: 400 }
      );
    }

    // Validate relatedRequestId if provided
    if (relatedRequestId) {
      const requestExists = await prisma.accessRequest.findUnique({
        where: { id: relatedRequestId },
        select: { id: true },
      });

      if (!requestExists) {
        return NextResponse.json(
          { error: 'Related access request not found' },
          { status: 400 }
        );
      }
    }

    // Use transaction to create ticket and initial status log
    const ticket = await prisma.$transaction(async (tx: any) => {
      const newTicket = await tx.supportTicket.create({
        data: {
          subject: subject.trim(),
          category: category || null,
          severity: severity || null,
          body: ticketBody.trim(),
          username: auth.username,
          status: 'open',
          relatedRequestId: relatedRequestId || null,
        },
      });

      await tx.ticketStatusLog.create({
        data: {
          ticketId: newTicket.id,
          oldStatus: null,
          newStatus: 'open',
          changedBy: auth.username,
          isStaff: auth.isAdmin,
        },
      });

      return newTicket;
    });

    // Get user's email if they have an associated access request
    let userEmail: string | null = null;
    if (relatedRequestId) {
      const request = await prisma.accessRequest.findUnique({
        where: { id: relatedRequestId },
        select: { email: true },
      });
      userEmail = request?.email || null;
    } else {
      // Try to find email from any access request with this username
      const request = await prisma.accessRequest.findFirst({
        where: { ldapUsername: auth.username },
        select: { email: true },
        orderBy: { createdAt: 'desc' },
      });
      userEmail = request?.email || null;
    }

    // Send notification to admin about new ticket (async, don't wait)
    import('@/lib/email').then(({ sendNewTicketNotificationToAdmin }) => {
      sendNewTicketNotificationToAdmin({
        ticketId: ticket.id,
        subject: ticket.subject,
        category: ticket.category,
        severity: ticket.severity,
        username: auth.username,
        userEmail,
        body: ticket.body,
      }).catch((error) => {
        console.error('[Ticket Creation] Failed to send admin notification:', error);
      });
    });

    return NextResponse.json(
      {
        message: 'Support ticket created successfully',
        ticketId: ticket.id,
        ticket,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating support ticket:', error);
    return NextResponse.json(
      { error: 'Failed to create support ticket' },
      { status: 500 }
    );
  }
}

// Get all tickets for the logged-in user
export async function GET() {
  try {
    const auth = await checkUserAuth();

    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const tickets = await prisma.supportTicket.findMany({
      where: { username: auth.username },
      orderBy: { createdAt: 'desc' },
      include: {
        responses: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return NextResponse.json({ tickets });
  } catch (error) {
    console.error('Error fetching support tickets:', error);
    return NextResponse.json(
      { error: 'Failed to fetch support tickets' },
      { status: 500 }
    );
  }
}
