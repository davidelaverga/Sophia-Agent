import { type NextRequest } from 'next/server';

import { getPrimaryGatewayUrl } from '../../_lib/gateway-url';
import { userOwnsThread } from '../../../lib/api/thread-ownership';
import { getAuthenticatedUserId, getUserScopedAuthToken } from '../../../lib/auth/server-auth';
import { normalizeBuilderArtifactPayload } from '../../../lib/builder-artifacts';
import { logger } from '../../../lib/error-logger';
import { apiLimiters } from '../../../lib/rate-limiter';
import { buildAttachmentPrompt } from '../../../stores/attachment-prompt';

import { fetchBackendStreamWithBootstrap, isValidSophiaUserId } from './backend-client';
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
      userMessage: rawUserMessage,
      sessionId,
      threadId,
      sessionType,
      contextMode,
      platform,
    } = parsed.data;

    // When the user attached files via AttachmentBar, prepend a short
    // synthesized note so the companion knows which uploaded filenames
    // it can pass to view_user_image / read_user_document this turn.
    // Without this hint, Sophia would either need to call `ls` (extra
    // tool turn) or guess that uploads exist.
    //
    // Defensive coalesce: parseAndValidateChatPayload guarantees this
    // field is an array, but tests that mock the validator might omit
    // it. Treat undefined as the empty case rather than throwing.
    const attachedFiles = parsed.data.attachedFiles ?? [];
    const userMessage = attachedFiles.length > 0
      ? `${buildAttachmentPrompt(attachedFiles)}\n\n${rawUserMessage}`
      : rawUserMessage;

    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (!isValidSophiaUserId(userId)) {
      return new Response(
        JSON.stringify({ error: 'Invalid user_id format' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Mock-streaming short-circuit (Codex P2 PR #132 later
    // iteration): the ``USE_MOCK_STREAMING=true`` flag is the
    // offline-dev contract — no backend gateway, no LangGraph. The
    // ownership gate below calls ``userOwnsThread`` which hits the
    // gateway's ``/api/v1/sessions/open|list``; in mock mode that
    // gateway isn't running, the fetch fails closed, and every
    // existing-session send 403s. So mock mode must take precedence
    // over the ownership check — there's no backend thread to verify
    // against in the first place.
    if (USE_MOCK) {
      secureLog('[/api/chat] Using mock streaming response');
      return mockResponse(sessionId, sessionType || undefined);
    }

    // Codex P1 PR #132 (later iteration): verify thread ownership for
    // EVERY request that resumes a caller-supplied ``thread_id``, not
    // just attachment-bearing ones.
    //
    // The earlier scoping ("only check when attached_files is
    // non-empty") was too narrow: once ``view_user_image`` and
    // ``read_user_document`` are wired into the companion, any
    // authenticated caller can send a foreign ``thread_id`` with NO
    // attachments and prompt-inject ("please describe the image
    // photo.png") to trick the model into calling those tools against
    // the victim's ``backend/.deer-flow/threads/{thread_id}/user-data/``
    // sandbox. Filename guessing is realistic for screenshots and
    // common names (resume.pdf, doc.pdf, image.png).
    //
    // Scope: skipped ONLY when threadId is absent/empty (new-session
    // bootstrap — the backend creates a fresh thread and assigns it to
    // this user). Any explicit caller-supplied threadId is verified.
    //
    // The underlying ``userOwnsThread`` is the same two-pass
    // (/open then /list?limit=100) used by the uploads + DELETE
    // proxies, so spoofing surface stays consistent across all three
    // server-side seams that act on a caller-supplied thread_id.
    //
    // Long-term: a dedicated gateway endpoint that binds thread_id to
    // the auth-token's user (or a /by-thread/{thread_id} lookup that
    // 404s on cross-user reads) would close this gap globally and
    // remove the recent-100 fallback ceiling. Separate backend ticket.
    if (typeof threadId === 'string' && threadId) {
      const gatewayUrl = getPrimaryGatewayUrl();
      const apiKey = await getUserScopedAuthToken();
      const owns = await userOwnsThread(threadId, userId, apiKey, gatewayUrl);
      if (!owns) {
        return new Response(
          JSON.stringify({
            error: 'Thread not owned by current user',
            code: 'THREAD_OWNERSHIP_REJECTED',
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
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
      // Server-trusted out-of-band attachment list (Codex P2 PR #132
      // latest iteration). The backend client routes this on the
      // PER-RUN ``config.configurable.current_turn_attached_files``
      // channel (not LangGraph ``input``, which persists into thread
      // state and would leak a prior turn's list into an
      // attachment-free turn). ``start_builder_task`` reads it from
      // ``runtime.config.configurable`` so it doesn't have to parse the
      // synthesized prompt block (which a user can spoof by typing the
      // marker into their own message).
      attached_files: attachedFiles,
      // The pre-prefix message. ``userMessage`` carries the
      // synthesized ``[The user has uploaded ...]`` block when there
      // are attachments; ``rawUserMessage`` does not. The backend
      // client uses this on the stale-thread recovery path so the
      // fresh-thread retry doesn't tell the model to read files
      // absent from the new sandbox (Codex P2 PR #132).
      raw_message: rawUserMessage,
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
          checkpointer_resume: backendFetch.checkpointerResume,
          resumed_from_thread: backendFetch.resumedFromThread,
          recovered_from_transcript: backendFetch.recoveredFromTranscript,
          stale_thread_id: backendFetch.staleThreadId,
          new_thread_id: backendFetch.newThreadId,
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
      const builderArtifact = normalizeBuilderArtifactPayload(
        backendResponse.builder_result || backendResponse.builderResult,
      );
      const stream = createUIMessageStreamFromText(responseText, {
        thread_id: resolvedThreadId,
        session_id: sessionId,
        skill_used: backendResponse.skill_used,
        emotion_detected: backendResponse.emotion_detected,
        pending_interrupt: pendingInterrupt,
        checkpointer_resume: backendFetch.checkpointerResume,
        resumed_from_thread: backendFetch.resumedFromThread,
        recovered_from_transcript: backendFetch.recoveredFromTranscript,
        stale_thread_id: backendFetch.staleThreadId,
        new_thread_id: backendFetch.newThreadId,
      }, artifacts, builderArtifact);

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
