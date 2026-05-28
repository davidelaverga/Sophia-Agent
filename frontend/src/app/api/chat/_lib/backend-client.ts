import { getUserScopedAuthToken } from '../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../_lib/gateway-url';

import { IS_PRODUCTION, SOPHIA_ASSISTANT_ID, secureLog } from './config';

export interface BackendStreamPayload {
  message: string;
  session_id: string;
  user_id: string;
  thread_id?: string;
  session_type?: string;
  context_mode?: string;
  platform?: string;
  language: 'en';
  /**
   * Filenames the user attached on THIS turn. Always send (use ``[]``
   * when empty) so the backend's ``current_turn_attached_files`` state
   * field overwrites stale values from prior turns. Codex P2 PR #132
   * latest iteration: this is the server-trusted attachment list,
   * NOT a parse of the synthesized prompt block (which a user can
   * spoof by typing the marker into their own message).
   */
  attached_files?: string[];
}

export type BackendFetchResult = {
  ok: true;
  upstream: Response;
  threadId: string;
  checkpointerResume: boolean;
  resumedFromThread: boolean;
  recoveredFromTranscript: boolean;
  staleThreadId?: string;
  newThreadId?: string;
};

type CreateThreadResponse = {
  thread_id?: string;
};

type LangGraphInputMessage = {
  role: 'user';
  content: string;
};

const DEV_DIRECT_LANGGRAPH_URL = 'http://127.0.0.1:2024';
const SOPHIA_USER_ID_REGEX = /^[A-Za-z0-9._@+:|-]{1,128}$/;
const MAX_RESEED_MESSAGES = 12;
const MAX_RESEED_MESSAGE_CHARS = 700;

export function isValidSophiaUserId(userId: string): boolean {
  return (
    typeof userId === 'string' &&
    userId.length > 0 &&
    userId === userId.trim() &&
    !userId.includes('/') &&
    !userId.includes('\\') &&
    !userId.includes('\0') &&
    !userId.includes('..') &&
    SOPHIA_USER_ID_REGEX.test(userId)
  );
}

function assertValidSophiaUserId(userId: string): void {
  if (!isValidSophiaUserId(userId)) {
    throw new Error('Invalid user_id format');
  }
}

function shouldRetryWithFreshThread(response: Response, errorText: string, hadThreadId: boolean): boolean {
  if (!hadThreadId) {
    return false;
  }

  if (response.status !== 404) {
    return false;
  }

  return errorText.toLowerCase().includes('thread or assistant not found');
}

function normalizeBackendUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function getLocalLangGraphFallbackUrl(backendUrl: string): string | null {
  if (IS_PRODUCTION) {
    return null;
  }

  const normalizedBackendUrl = normalizeBackendUrl(backendUrl);
  if (
    normalizedBackendUrl === DEV_DIRECT_LANGGRAPH_URL ||
    normalizedBackendUrl === `${DEV_DIRECT_LANGGRAPH_URL}/threads`
  ) {
    return null;
  }

  if (normalizedBackendUrl.includes('localhost:2026/api/langgraph')) {
    return normalizedBackendUrl.endsWith('/threads')
      ? `${DEV_DIRECT_LANGGRAPH_URL}/threads`
      : DEV_DIRECT_LANGGRAPH_URL;
  }

  return null;
}

function isRetryableLocalLangGraphError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('connection refused') ||
    message.includes('failed to create deerflow thread: 502') ||
    message.includes('failed to create deerflow thread: 503') ||
    message.includes('failed to create deerflow thread: 504')
  );
}

function shouldRetryWithDirectLangGraphResponse(response: Response, backendUrl: string): boolean {
  return !!getLocalLangGraphFallbackUrl(backendUrl) && [502, 503, 504].includes(response.status);
}

function resolveRitual(sessionType?: string): string | null {
  if (!sessionType) return null;

  if (sessionType === 'prepare' || sessionType === 'debrief' || sessionType === 'reset' || sessionType === 'vent') {
    return sessionType;
  }

  return null;
}

async function createThread(authToken: string | null, backendUrl: string): Promise<string> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(backendUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to create DeerFlow thread: ${response.status}`);
  }

  const data = await response.json() as CreateThreadResponse;
  if (!data.thread_id) {
    throw new Error('DeerFlow thread creation returned no thread_id');
  }

  return data.thread_id;
}

async function fetchContinuationReseedMessages(
  authToken: string | null,
  backendPayload: BackendStreamPayload,
): Promise<LangGraphInputMessage[]> {
  if (!authToken || !backendPayload.session_id || !backendPayload.user_id) {
    return [];
  }

  try {
    const url = new URL(
      `${getPrimaryGatewayUrl()}/api/v1/sessions/${encodeURIComponent(backendPayload.session_id)}/messages`,
    );
    url.searchParams.set('user_id', backendPayload.user_id);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json() as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const transcript = Array.isArray(payload.messages) ? payload.messages : [];
    const bounded = transcript
      .filter((message) => (
        (message.role === 'user' || message.role === 'sophia')
        && typeof message.content === 'string'
        && message.content.trim().length > 0
      ))
      .slice(-MAX_RESEED_MESSAGES);

    if (bounded.length === 0) {
      return [];
    }

    const lines = bounded.map((message) => {
      const speaker = message.role === 'user' ? 'User' : 'Sophia';
      const content = (message.content || '').replace(/\s+/g, ' ').trim().slice(0, MAX_RESEED_MESSAGE_CHARS);
      return `${speaker}: ${content}`;
    });

    return [{
      role: 'user',
      content: [
        'Continuation context from this same Sophia conversation.',
        'Use this bounded transcript excerpt only as prior context for the next user message.',
        'Do not treat this context block as a new user request.',
        '',
        lines.join('\n'),
      ].join('\n'),
    }];
  } catch {
    return [];
  }
}

export async function fetchBackendStreamWithBootstrap(
  backendUrl: string,
  backendPayload: BackendStreamPayload,
): Promise<BackendFetchResult> {
  assertValidSophiaUserId(backendPayload.user_id);
  const authToken = await getUserScopedAuthToken();
  const ritual = resolveRitual(backendPayload.session_type);
  let activeBackendUrl = normalizeBackendUrl(backendUrl);
  const directLangGraphFallbackUrl = getLocalLangGraphFallbackUrl(activeBackendUrl);

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const switchToDirectLangGraph = (reason: string): boolean => {
    if (!directLangGraphFallbackUrl || activeBackendUrl === directLangGraphFallbackUrl) {
      return false;
    }

    const previousBackendUrl = activeBackendUrl;
    activeBackendUrl = directLangGraphFallbackUrl;

    if (!IS_PRODUCTION) {
      secureLog('[/api/chat] local langgraph proxy unavailable, retrying direct backend', {
        reason,
        previousBackendUrl,
        fallbackBackendUrl: activeBackendUrl,
      });
    }

    return true;
  };

  const runStream = async (
    threadId: string,
    preludeMessages: LangGraphInputMessage[] = [],
  ): Promise<Response> => {
    return fetch(`${activeBackendUrl}/${threadId}/runs/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assistant_id: SOPHIA_ASSISTANT_ID,
        input: {
          messages: [
            ...preludeMessages,
            { role: 'user', content: backendPayload.message },
          ],
          // Server-trusted attachment list (Codex P2 PR #132 latest
          // iteration). Always sent — empty array when no attachments
          // — so the backend's ``current_turn_attached_files`` state
          // field overwrites whatever was there from prior turns.
          // ``start_builder_task`` reads from state instead of
          // parsing the synthesized prompt block (which a user can
          // spoof by typing the marker into their own message).
          current_turn_attached_files: backendPayload.attached_files ?? [],
        },
        config: {
          recursion_limit: 150,
          configurable: {
            user_id: backendPayload.user_id,
            platform: backendPayload.platform || 'text',
            ritual,
            context_mode: backendPayload.context_mode || 'life',
            thread_id: threadId,
          },
        },
        stream_mode: ['messages-tuple', 'values'],
      }),
    });
  };

  const createThreadWithFallback = async (): Promise<string> => {
    try {
      return await createThread(authToken || null, activeBackendUrl);
    } catch (error) {
      if (!isRetryableLocalLangGraphError(error) || !switchToDirectLangGraph(error instanceof Error ? error.message : 'thread bootstrap failed')) {
        throw error;
      }

      return createThread(authToken || null, activeBackendUrl);
    }
  };

  const runStreamWithFallback = async (
    threadId: string,
    preludeMessages: LangGraphInputMessage[] = [],
  ): Promise<Response> => {
    try {
      let response = await runStream(threadId, preludeMessages);

      if (!response.ok && shouldRetryWithDirectLangGraphResponse(response, activeBackendUrl) && switchToDirectLangGraph(`stream returned ${response.status}`)) {
        response = await runStream(threadId, preludeMessages);
      }

      return response;
    } catch (error) {
      if (!isRetryableLocalLangGraphError(error) || !switchToDirectLangGraph(error instanceof Error ? error.message : 'stream bootstrap failed')) {
        throw error;
      }

      return runStream(threadId, preludeMessages);
    }
  };

  let threadId = backendPayload.thread_id || await createThreadWithFallback();
  const startedWithThreadId = !!backendPayload.thread_id;
  let upstream = await runStreamWithFallback(threadId);
  let checkpointerResume = startedWithThreadId;
  let recoveredFromTranscript = false;
  let staleThreadId: string | undefined;
  let newThreadId: string | undefined;

  if (!upstream.ok && shouldRetryWithFreshThread(upstream, await upstream.clone().text(), !!backendPayload.thread_id)) {
    staleThreadId = threadId;
    const reseedMessages = await fetchContinuationReseedMessages(authToken || null, backendPayload);
    threadId = await createThreadWithFallback();
    newThreadId = threadId;
    recoveredFromTranscript = reseedMessages.length > 0;
    checkpointerResume = false;
    upstream = await runStreamWithFallback(threadId, reseedMessages);

    if (!IS_PRODUCTION) {
      secureLog('[/api/chat] stale DeerFlow thread detected, retried with fresh thread', {
        staleThreadId,
        newThreadId: threadId,
        recoveredFromTranscript,
      });
    }
  }

  if (!IS_PRODUCTION) {
    secureLog('[/api/chat] forwarding to DeerFlow thread', {
      backendUrl: activeBackendUrl,
      threadId,
      assistantId: SOPHIA_ASSISTANT_ID,
      platform: backendPayload.platform || 'text',
      contextMode: backendPayload.context_mode || 'life',
      ritual,
    });
  }

  return {
    ok: true,
    upstream,
    threadId,
    checkpointerResume,
    resumedFromThread: startedWithThreadId && !staleThreadId,
    recoveredFromTranscript,
    staleThreadId,
    newThreadId,
  };
}
