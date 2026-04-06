/**
 * Memory Feedback API Route
 * Proxies POST /api/memory/feedback -> backend /api/v1/memories/feedback
 */

import { type NextRequest, NextResponse } from 'next/server';

import { getServerAuthToken } from '../../../lib/auth/server-auth';
import { logger } from '../../../lib/error-logger';

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface MemoryFeedbackRequest {
  action: 'approve' | 'reject';
  memory_text: string;
  category?: string;
  session_id?: string;
  original_memory_id?: string;
  reason?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as MemoryFeedbackRequest;

    if (!body?.memory_text) {
      return NextResponse.json(
        { error: 'memory_text is required' },
        { status: 400 }
      );
    }

    if (body.action !== 'approve' && body.action !== 'reject') {
      return NextResponse.json(
        { error: 'action must be approve or reject' },
        { status: 400 }
      );
    }

    const backendResponse = await fetch(
      `${BACKEND_URL}/api/v1/memories/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await getServerAuthToken()}`,
        },
        body: JSON.stringify(body),
      }
    );

    const responseText = await backendResponse.text();

    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: {
        'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    logger.logError(error, { component: 'api/memory/feedback', action: 'submit_feedback' });
    return NextResponse.json(
      { error: 'Failed to submit memory feedback' },
      { status: 500 }
    );
  }
}
