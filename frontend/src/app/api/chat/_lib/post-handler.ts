import { type NextRequest } from 'next/server';

import { logger } from '../../../lib/error-logger';
import { apiLimiters } from '../../../lib/rate-limiter';

import { fetchBackendStreamWithBootstrap } from './backend-client';
import { parseAndValidateChatPayload } from './chat-request';
import {
  AI_SDK_STREAM_HEADER,
  BACKEND_CHAT_ENDPOINT,
  BACKEND_URL,
  IS_PRODUCTION,
  USE_MOCK,
  secureLog,
} from './config';
import { getMockResponse } from './mock';
import {
  createSSEToUIMessageStream,
  createUIMessageStreamFromText,
  normalizeArtifactsV1,
} from './stream-transformers';

function parseBackendErrorMessage(errorText: string, status: number): string {
  let backendErrorMessage = `Backend error: ${status}`;
  try {
    const parsedError = JSON.parse(errorText) as { detail?: string; error?: string; message?: string };
    backendErrorMessage =
      parsedError.detail ||
      parsedError.error ||
      parsedError.message ||
      backendErrorMessage;
  } catch {
    if (errorText.trim()) {
      backendErrorMessage = errorText;
    }
  }
  return backendErrorMessage;
}

function mockResponse(sessionId: string, sessionType: string | undefined): Response {
  const preset = sessionType?.replace('_', '') || 'default';
  const mockText = getMockResponse(preset);
  const stream = createUIMessageStreamFromText(mockText, {
    thread_id: sessionId,
    session_id: sessionId,
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      [AI_SDK_STREAM_HEADER]: 'v1',
    },
  });
}

function backendUnavailableResponse(error: unknown): Response {
  logger.logError(error, { component: 'api/chat', action: 'backend_fetch' });
  return new Response(
    JSON.stringify({
      error: 'Backend unavailable',
      offline: true,
      message: 'Connection lost. Your message will be queued.',
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'X-Offline-Mode': 'true',
      },
    },
  );
}

function serviceUnavailableResponse(error: unknown): Response {
  logger.logError(error, { component: 'api/chat', action: 'service_unavailable' });
  return new Response(
    JSON.stringify({
      error: 'Service unavailable',
      offline: true,
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'X-Offline-Mode': 'true',
      },
    },
  );
}

export async function handleChatPost(req: NextRequest): Promise<Response> {
  if (!apiLimiters.chat.checkSync()) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Please slow down.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const payload = await req.json();

    secureLog('[/api/chat] stream protocol enforced', {
      resolved_protocol: 'data',
      use_ui_message_stream: true,
    });

    secureLog('[/api/chat] Request received');

    const parsed = parseAndValidateChatPayload(payload);
    if (parsed.kind === 'invalid') {
      return parsed.response;
    }

    const {
      userMessage,
      sessionId,
      userId,
      threadId,
      sessionType,
      contextMode,
      platform,
    } = parsed.data;

    if (USE_MOCK) {
      secureLog('[/api/chat] Using mock streaming response');
      return mockResponse(sessionId, sessionType || undefined);
    }

    const backendPayload = {
      message: userMessage,
      session_id: sessionId,
      user_id: userId,
      thread_id: threadId,
      session_type: sessionType,
      context_mode: contextMode,
      platform,
      language: 'en' as const,
    };

    const backendUrl = `${BACKEND_URL}${BACKEND_CHAT_ENDPOINT}`;
    secureLog('[/api/chat] Forwarding to SSE backend');

    try {
      const backendFetch = await fetchBackendStreamWithBootstrap(backendUrl, backendPayload);
      const upstream = backendFetch.upstream;
      const responseThreadId = backendFetch.threadId;

      if (!upstream.ok) {
        const errorText = await upstream.text();
        logger.logError(new Error(`Backend SSE error: ${upstream.status}`), {
          component: 'api/chat',
          action: 'backend_sse_error',
          metadata: { status: upstream.status },
        });
        if (!IS_PRODUCTION) {
          secureLog('[/api/chat] Error details', { errorText });
        }

        const backendErrorMessage = parseBackendErrorMessage(errorText, upstream.status);

        if (upstream.status === 401 || upstream.status === 403) {
          return new Response(
            JSON.stringify({
              error: backendErrorMessage || 'Authentication required',
              auth: false,
              code: 'PROXY_AUTH_REJECTED',
              backend_status: upstream.status,
            }),
            {
              status: upstream.status,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
        }

        if (upstream.status >= 400 && upstream.status < 500) {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          const retryAfter = upstream.headers.get('retry-after');
          if (retryAfter) {
            headers['Retry-After'] = retryAfter;
          }

          return new Response(
            JSON.stringify({
              error: backendErrorMessage,
              code: upstream.status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'BACKEND_CLIENT_ERROR',
              backend_status: upstream.status,
              auth: true,
            }),
            {
              status: upstream.status,
              headers,
            },
          );
        }

        const mockText = `${getMockResponse('default')} (Note: I'm in offline mode right now)`;
        const stream = createUIMessageStreamFromText(mockText, {
          session_id: sessionId,
        });
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Offline-Mode': 'true',
            [AI_SDK_STREAM_HEADER]: 'v1',
          },
        });
      }

      const contentType = upstream.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream') && upstream.body) {
        secureLog('[/api/chat] Proxying SSE stream');

        const transformStream = createSSEToUIMessageStream(upstream.body, {
          thread_id: responseThreadId,
          session_id: sessionId,
        });
        return new Response(transformStream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            [AI_SDK_STREAM_HEADER]: 'v1',
          },
        });
      }

      const backendResponse = await upstream.json();
      secureLog('[/api/chat] Backend returned JSON, simulating stream', {
        hasResponse: !!backendResponse.response,
        skillUsed: backendResponse.skill_used,
      });

      const responseText = backendResponse.response || backendResponse.content || 'I understand. Tell me more.';
      const pendingInterrupt = backendResponse.pending_interrupt
        ?? backendResponse.pendingInterrupt
        ?? backendResponse?.meta?.pending_interrupt
        ?? backendResponse?.metadata?.pending_interrupt
        ?? null;
      const resolvedThreadId = backendResponse.thread_id || responseThreadId || threadId || sessionId;

      const artifacts = normalizeArtifactsV1(backendResponse.artifacts || backendResponse.ritual_artifacts);
      const stream = createUIMessageStreamFromText(responseText, {
        thread_id: resolvedThreadId,
        session_id: sessionId,
        skill_used: backendResponse.skill_used,
        emotion_detected: backendResponse.emotion_detected,
        pending_interrupt: pendingInterrupt,
      }, artifacts);

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          [AI_SDK_STREAM_HEADER]: 'v1',
        },
      });
    } catch (fetchError) {
      return backendUnavailableResponse(fetchError);
    }
  } catch (error) {
    return serviceUnavailableResponse(error);
  }
}
