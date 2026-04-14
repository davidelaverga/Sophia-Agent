import { getUserScopedAuthToken } from '../../../lib/auth/server-auth';

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
}

export type BackendFetchResult = { ok: true; upstream: Response; threadId: string };

type CreateThreadResponse = {
  thread_id?: string;
};

const DEV_DIRECT_LANGGRAPH_URL = 'http://127.0.0.1:2024';

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

export async function fetchBackendStreamWithBootstrap(
  backendUrl: string,
  backendPayload: BackendStreamPayload,
): Promise<BackendFetchResult> {
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

  const runStream = async (threadId: string): Promise<Response> => {
    return fetch(`${activeBackendUrl}/${threadId}/runs/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assistant_id: SOPHIA_ASSISTANT_ID,
        input: {
          messages: [{ role: 'user', content: backendPayload.message }],
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

  const runStreamWithFallback = async (threadId: string): Promise<Response> => {
    try {
      let response = await runStream(threadId);

      if (!response.ok && shouldRetryWithDirectLangGraphResponse(response, activeBackendUrl) && switchToDirectLangGraph(`stream returned ${response.status}`)) {
        response = await runStream(threadId);
      }

      return response;
    } catch (error) {
      if (!isRetryableLocalLangGraphError(error) || !switchToDirectLangGraph(error instanceof Error ? error.message : 'stream bootstrap failed')) {
        throw error;
      }

      return runStream(threadId);
    }
  };

  let threadId = backendPayload.thread_id || await createThreadWithFallback();
  let upstream = await runStreamWithFallback(threadId);

  if (shouldRetryWithFreshThread(upstream, await upstream.clone().text(), !!backendPayload.thread_id)) {
    const staleThreadId = threadId;
    threadId = await createThreadWithFallback();
    upstream = await runStreamWithFallback(threadId);

    if (!IS_PRODUCTION) {
      secureLog('[/api/chat] stale DeerFlow thread detected, retried with fresh thread', {
        staleThreadId,
        newThreadId: threadId,
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
  };
}
