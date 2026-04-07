import { getServerAuthToken } from '../../../lib/auth/server-auth';

import { BACKEND_URL, IS_PRODUCTION, SOPHIA_ASSISTANT_ID, secureLog } from './config';

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

function shouldRetryWithFreshThread(response: Response, errorText: string, hadThreadId: boolean): boolean {
  if (!hadThreadId) {
    return false;
  }

  if (response.status !== 404) {
    return false;
  }

  return errorText.toLowerCase().includes('thread or assistant not found');
}

function resolveRitual(sessionType?: string): string | null {
  if (!sessionType) return null;

  if (sessionType === 'prepare' || sessionType === 'debrief' || sessionType === 'reset' || sessionType === 'vent') {
    return sessionType;
  }

  return null;
}

async function createThread(authToken: string | null): Promise<string> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(`${BACKEND_URL}/threads`, {
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
  const authToken = await getServerAuthToken();
  const ritual = resolveRitual(backendPayload.session_type);

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const runStream = async (threadId: string): Promise<Response> => {
    return fetch(`${backendUrl}/${threadId}/runs/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assistant_id: SOPHIA_ASSISTANT_ID,
        input: {
          messages: [{ role: 'user', content: backendPayload.message }],
        },
        config: {
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

  let threadId = backendPayload.thread_id || await createThread(authToken || null);
  let upstream = await runStream(threadId);

  if (shouldRetryWithFreshThread(upstream, await upstream.clone().text(), !!backendPayload.thread_id)) {
    const staleThreadId = threadId;
    threadId = await createThread(authToken || null);
    upstream = await runStream(threadId);

    if (!IS_PRODUCTION) {
      secureLog('[/api/chat] stale DeerFlow thread detected, retried with fresh thread', {
        staleThreadId,
        newThreadId: threadId,
      });
    }
  }

  if (!IS_PRODUCTION) {
    secureLog('[/api/chat] forwarding to DeerFlow thread', {
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
