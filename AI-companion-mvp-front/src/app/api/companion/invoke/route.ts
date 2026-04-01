/**
 * Companion Invoke API Route
 * Phase 3 - Subphase 3.3
 * 
 * POST /api/companion/invoke
 * 
 * Proxies companion invoke requests to the backend.
 * Supports: quick_question, plan_reminder, tilt_reset, micro_debrief
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiLimiters } from '../../../lib/rate-limiter';
import { getServerAuthHeader } from '../../../lib/auth/server-auth';
import { debugLog } from '../../../lib/debug-logger';
import { logger } from '../../../lib/error-logger';

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function POST(req: NextRequest) {
  // Rate limiting check
  if (!apiLimiters.companion.checkSync()) {
    return NextResponse.json(
      { error: 'Too many requests. Please slow down.' },
      { status: 429 }
    );
  }

  try {
    const body = await req.json();
    
    const {
      invoke_type,
      transcript,
      thread_id,
      session_context,
    } = body;
    
    // Validate invoke_type
    const validTypes = ['quick_question', 'plan_reminder', 'tilt_reset', 'micro_debrief'];
    if (!validTypes.includes(invoke_type)) {
      return NextResponse.json(
        { error: `Invalid invoke_type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }
    
    // Forward to backend — 🔒 token read from httpOnly cookie server-side
    const backendResponse = await fetch(`${BACKEND_URL}/api/v1/companion/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getServerAuthHeader(),
      },
      body: JSON.stringify({
        invoke_type,
        transcript,
        thread_id,
        session_context,
      }),
    });
    
    if (!backendResponse.ok) {
      const errorText = await backendResponse.text();
      logger.logError(new Error(`Backend error: ${backendResponse.status}`), {
        component: 'api/companion/invoke',
        action: 'backend_response',
        metadata: { status: backendResponse.status, errorText },
      });
      
      // Return mock response ONLY in development if backend is unavailable
      if (process.env.NODE_ENV !== 'production' && (backendResponse.status === 404 || backendResponse.status === 500 || backendResponse.status === 502)) {
        debugLog('companion/invoke', 'Backend unavailable/error, returning mock response');
        return NextResponse.json(getMockResponse(invoke_type, transcript));
      }
      
      return NextResponse.json(
        { error: 'Backend error' },
        { status: backendResponse.status }
      );
    }
    
    const data = await backendResponse.json();
    return NextResponse.json(data);
    
  } catch (error) {
    logger.logError(error, { component: 'api/companion/invoke', action: 'invoke_post' });
    
    // For development: return mock response if backend is down
    if (process.env.NODE_ENV !== 'production' && error instanceof TypeError && error.message.includes('fetch')) {
      const body = await req.clone().json().catch(() => ({}));
      return NextResponse.json(getMockResponse(body.invoke_type || 'quick_question', body.transcript || ''));
    }
    
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// =============================================================================
// MOCK RESPONSES (for development)
// =============================================================================

function getMockResponse(invokeType: string, _transcript: string) {
  const mockResponses: Record<string, { message: string; tts_style?: string }> = {
    quick_question: {
      message: "Good question! Based on what you've shared, I think the key thing to remember is to stay focused on one thing at a time. What specifically would you like me to clarify?",
    },
    plan_reminder: {
      message: "Here's what we've established so far:\n\n1. **Main goal**: Stay calm and focused\n2. **Key strategy**: Take breaks when feeling frustrated\n3. **Reminder**: Progress over perfection\n\nWould you like to adjust any of these?",
    },
    tilt_reset: {
      message: "Let's take a quick reset. 🧘\n\nTake a deep breath in... hold it... and release slowly.\n\nRemember: This moment doesn't define you. You've got this. What's one small thing you can focus on right now?",
      tts_style: 'calming',
    },
    micro_debrief: {
      message: "Quick reflection time! 📝\n\nLooking at what just happened:\n• What went well?\n• What would you do differently?\n• What's one takeaway to carry forward?\n\nNo pressure to answer all—just pick one that resonates.",
    },
  };
  
  const mock = mockResponses[invokeType] || { message: "I'm here to help. What would you like to explore?" };
  
  return {
    assistant_message: mock.message,
    artifacts: {},
    tts_style: mock.tts_style || null,
    thread_id: `mock_${Date.now()}`,
    invoke_type: invokeType,
  };
}
