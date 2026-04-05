/**
 * Resume API Route
 * Phase 2 - Sprint 1
 * 
 * Handles interrupt resume actions:
 * - User accepts/dismisses/snoozes an interrupt card
 * - Forwards decision to backend
 * - Streams continuation response back to client
 * 
 * This enables permissioned UX for:
 * - Debrief offers
 * - Reset offers
 * - Nudge offers
 * - Micro-dialogs (breathing style, plan choice, etc.)
 */

import { NextRequest } from 'next/server';
import type { InterruptKind } from '../../lib/session-types';
import { getServerAuthToken } from '../../lib/auth/server-auth';
import { debugLog } from '../../lib/debug-logger';
import { logger } from '../../lib/error-logger';

// ============================================================================
// CONFIGURATION
// ============================================================================

const RENDER_BACKEND_URL = process.env.RENDER_BACKEND_URL || 'http://localhost:8000';
const BACKEND_RESUME_ENDPOINT = '/api/v1/chat/text/resume';

// Demo mode flag — only explicit opt-in, never activate in production by accident
const USE_MOCK_STREAMING = process.env.USE_MOCK_STREAMING === 'true';

// ============================================================================
// MOCK RESPONSES (for development)
// ============================================================================

const MOCK_RESUME_RESPONSES: Record<InterruptKind, Record<string, string[]>> = {
  DEBRIEF_OFFER: {
    accept: [
      "Great, let's do a quick debrief. ",
      "Looking back at this session, what stood out to you? ",
      "Take a moment to notice how you're feeling right now."
    ],
    decline: [
      "No problem. ",
      "Feel free to reach out whenever you're ready to reflect."
    ],
    snooze: [
      "Got it, I'll check back with you later. ",
      "Take your time."
    ],
  },
  RESET_OFFER: {
    accept: [
      "Let's reset together. ",
      "Take a deep breath in... ",
      "And slowly exhale. ",
      "Notice your shoulders dropping. ",
      "You're doing great."
    ],
    decline: [
      "Okay, no problem. ",
      "I'm here if you change your mind. ",
      "Just let me know if you need anything."
    ],
    later: [
      "Got it, one more game. ",
      "I'll check back with you after. ",
      "Good luck!"
    ],
    snooze: [
      "I'll remind you in a bit. ",
      "Focus on what you need to right now."
    ],
  },
  NUDGE_OFFER: {
    accept: [
      "Perfect timing. ",
      "Let's check in with how you're doing. ",
      "What's your energy level right now?"
    ],
    decline: [
      "No worries. ",
      "I'll be here when you need me."
    ],
    snooze: [
      "I'll nudge you again later. "
    ],
  },
  MICRO_DIALOG: {
    'breathing_style': [
      "Let's do some box breathing. ",
      "Inhale for 4 seconds... ",
      "Hold for 4 seconds... ",
      "Exhale for 4 seconds... ",
      "Hold for 4 seconds. ",
      "Repeat with me."
    ],
    'plan_choice': [
      "Good choice. ",
      "I've noted that for your session. ",
      "Let's proceed with that plan."
    ],
    default: [
      "Got it. ",
      "Let me adjust based on your preference."
    ],
  },
};

async function createMockResumeStream(
  kind: InterruptKind, 
  optionId: string
): Promise<ReadableStream> {
  const kindResponses = MOCK_RESUME_RESPONSES[kind] || MOCK_RESUME_RESPONSES.NUDGE_OFFER;
  const responses = kindResponses[optionId] || kindResponses.accept || kindResponses.default || ["Understood. "];
  const fullResponse = responses.join('');
  
  const encoder = new TextEncoder();
  
  return new ReadableStream({
    async start(controller) {
      // Simulate processing delay
      await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 150));
      
      // Stream character by character
      for (const char of fullResponse) {
        controller.enqueue(encoder.encode(char));
        
        const delay = char === ' ' ? 25 + Math.random() * 15 
                    : char === '.' ? 120 + Math.random() * 80
                    : 12 + Math.random() * 18;
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      controller.close();
    },
  });
}

// ============================================================================
// ROUTE HANDLER
// ============================================================================

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    
    // Support both new flat format and legacy nested format
    let thread_id: string;
    let session_id: string;
    let user_id: string;
    let interrupt_kind: InterruptKind;
    let selected_option_id: string;
    let context: Record<string, unknown> | undefined;
    
    if (payload.resume) {
      // Legacy nested format from frontend types
      thread_id = payload.thread_id;
      session_id = payload.session_id;
      user_id = payload.user_id || 'user-default';
      interrupt_kind = payload.resume.kind;
      selected_option_id = payload.resume.option_id;
      context = payload.resume.extra;
    } else {
      // Flat format matching backend schema
      thread_id = payload.thread_id;
      session_id = payload.session_id;
      user_id = payload.user_id || 'user-default';
      interrupt_kind = payload.interrupt_kind;
      selected_option_id = payload.selected_option_id;
      context = payload.context;
    }
    
    if (!thread_id || !session_id || !interrupt_kind || !selected_option_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: thread_id, session_id, interrupt_kind, selected_option_id' }),
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    debugLog('/api/resume', 'Request', {
      sessionId: session_id,
      threadId: thread_id,
      kind: interrupt_kind,
      optionId: selected_option_id,
      useMock: USE_MOCK_STREAMING,
    });

    // ========================================================================
    // MOCK MODE (development without backend)
    // ========================================================================
    if (USE_MOCK_STREAMING) {
      debugLog('/api/resume', 'Using mock streaming response');
      
      const mockStream = await createMockResumeStream(interrupt_kind, selected_option_id);
      
      return new Response(mockStream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Mock-Response': 'true',
        },
      });
    }

    // ========================================================================
    // PRODUCTION MODE (proxy to Render backend)
    // ========================================================================
    
    // Build backend payload matching ResumeRequest schema
    const backendPayload = {
      thread_id,
      session_id,
      user_id,
      interrupt_kind,
      selected_option_id,
      context: {
        ...(context || {}),
        language:
          typeof context?.language === 'string' && context.language.trim().length > 0
            ? context.language
            : 'en',
      },
    };
    
    debugLog('/api/resume', 'Forwarding to backend', {
      url: RENDER_BACKEND_URL + BACKEND_RESUME_ENDPOINT,
    });

    const upstream = await fetch(RENDER_BACKEND_URL + BACKEND_RESUME_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${await getServerAuthToken()}`,
        // Hint to backend: UI language is English.
        // Backend may ignore this, but it helps prevent accidental Spanish replies.
        'Accept-Language': 'en',
        'X-UI-Language': 'en',
      },
      body: JSON.stringify(backendPayload),
    });

    if (!upstream.ok) {
      logger.logError(new Error(`Backend error: ${upstream.status} ${upstream.statusText}`), {
        component: 'api/resume',
        action: 'backend_response',
      });

      const upstreamErrorText = await upstream.text().catch(() => '');
      const interruptExpiredOrInvalid =
        upstream.status === 410 ||
        upstream.status === 404 ||
        /interrupt expired|offer expired|invalid interrupt|interrupt invalid/i.test(upstreamErrorText);
      
      // Check for expired interrupt
      if (interruptExpiredOrInvalid) {
        return new Response(
          JSON.stringify({ 
            error: 'Interrupt expired',
            code: 'INTERRUPT_EXPIRED',
          }),
          { 
            status: 410,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      
      return new Response(
        JSON.stringify({ 
          error: 'Backend temporarily unavailable',
          status: upstream.status,
        }),
        { 
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const contentType = upstream.headers.get('Content-Type') || 'text/plain; charset=utf-8';

    // Some backends return a JSON payload (with metadata like emotion/session type) instead of a text stream.
    // The client should never render that metadata directly.
    if (contentType.includes('application/json')) {
      const payload = await upstream.json().catch(() => null);
      const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
      const text =
        (record && typeof record.response === 'string' ? record.response : null) ||
        (record && typeof record.assistant_message === 'string' ? record.assistant_message : null) ||
        (record && typeof record.message === 'string' ? record.message : null) ||
        '';

      return new Response(text, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
          ...(process.env.NODE_ENV !== 'production' ? { 'X-Resume-Json': 'true' } : {}),
        },
      });
    }

    if (!upstream.body) {
      return new Response(
        JSON.stringify({ error: 'Empty response from backend' }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Pass-through the stream for text/plain streaming responses
    return new Response(upstream.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      },
    });

  } catch (error) {
    logger.logError(error, { component: 'api/resume', action: 'resume_post' });
    
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error',
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// ============================================================================
// OPTIONS (CORS preflight)
// ============================================================================

export async function OPTIONS(req: NextRequest) {
  const allowedOrigins = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.CORS_ALLOWED_ORIGIN,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  const requestOrigin = req.headers.get('origin');
  const allowOrigin = requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : undefined;

  return new Response(null, {
    status: 204,
    headers: allowOrigin
      ? {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Vary': 'Origin',
        }
      : {
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
  });
}
