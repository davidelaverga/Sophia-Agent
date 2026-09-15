import { getUserScopedAuthToken } from '../../../lib/auth/server-auth';
import { sourceActionSchema, type SourceAction } from '../../../lib/memory-source-contract';
import { getPrimaryGatewayUrl } from '../../_lib/gateway-url';

import { IS_PRODUCTION, SOPHIA_ASSISTANT_ID, secureLog } from './config';
import { createRunCompletionCheck } from './run-completion';

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
   * when empty). Routed on fresh ``config.configurable
   * .current_turn_attached_files``, not message state. Configurable is
   * also merged with stored configuration by the installed server: explicit
   * empty values and backend auth-hook clearing fence stale selections.
   * Codex P2 PR #132 latest iteration: this is the server-trusted
   * attachment list, NOT a parse of the synthesized prompt block
   * (which a user can spoof by typing the marker into their message).
   */
  attached_files?: string[];
  /**
   * The user's message BEFORE the post-handler prefixed it with the
   * synthesized ``[The user has uploaded ...]`` attachment block.
   * Codex P2 PR #132: on the stale-thread recovery path the bytes
   * live in the OLD sandbox, so the fresh-thread run must use this
   * raw message (no attachment block) — otherwise the model is still
   * told to call ``view_user_image`` / ``read_user_document`` for
   * files absent from the new sandbox. When there were no
   * attachments this equals ``message``.
   */
  raw_message?: string;
  memory_source_action?: SourceAction;
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
  confirmCompletion?: () => Promise<boolean>;
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
  signal?: AbortSignal,
): Promise<BackendFetchResult> {
  signal?.throwIfAborted();
  assertValidSophiaUserId(backendPayload.user_id);
  if (Object.prototype.hasOwnProperty.call(backendPayload, 'memory_source_action')) {
    const action = sourceActionSchema.safeParse(backendPayload.memory_source_action);
    if (!action.success || !backendPayload.thread_id
      || action.data.thread_id !== backendPayload.thread_id
      || action.data.content !== backendPayload.message
      || action.data.content !== (backendPayload.raw_message ?? backendPayload.message)
      || (backendPayload.attached_files !== undefined
        && (!Array.isArray(backendPayload.attached_files) || backendPayload.attached_files.length > 0))) {
      throw new Error('memory_source_action_scope_invalid');
    }
  }
  if (Object.prototype.hasOwnProperty.call(backendPayload, 'memory_source_attachment_keys')) {
    throw new Error('memory_source_upload_unavailable');
  }
  if (backendPayload.memory_source_action) {
    // Capture before the first await; caller mutation during token retrieval
    // must not substitute another action or attachment selection.
    backendPayload = { ...backendPayload,
      memory_source_action: sourceActionSchema.parse(backendPayload.memory_source_action),
      attached_files: [],
    };
  }
  const authToken = await getUserScopedAuthToken();
  signal?.throwIfAborted();
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
    // Codex P2 PR #132: explicit per-call attachment list. The normal
    // path passes ``backendPayload.attached_files``; the stale-thread
    // recovery path passes ``[]`` because the uploaded bytes live in
    // the OLD thread's sandbox, not the freshly-created one — telling
    // Sophia to ``view_user_image`` files that don't exist in the new
    // sandbox would make attachments fail exactly on the recovery
    // path this client otherwise supports.
    attachedFiles: string[] = backendPayload.attached_files ?? [],
  ): Promise<Response> => {
    // Codex P2 PR #132: when this run carries attachments, use the
    // post-handler's prefixed message (it names the uploaded files so
    // the model knows to call view_user_image / read_user_document).
    // When it does NOT (no attachments, OR the stale-thread recovery
    // path that forces attachedFiles=[]), use the RAW message so the
    // model isn't told to read files that aren't in this sandbox.
    // ``raw_message`` equals ``message`` when there were no
    // attachments, so the no-attachment path is unaffected.
    const messageContent =
      attachedFiles.length > 0
        ? backendPayload.message
        : (backendPayload.raw_message ?? backendPayload.message);
    return fetch(`${activeBackendUrl}/${threadId}/runs/stream`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        assistant_id: SOPHIA_ASSISTANT_ID,
        input: {
          messages: [
            ...preludeMessages,
            { role: 'user', content: messageContent, ...(backendPayload.memory_source_action ? { id: backendPayload.memory_source_action.message_id } : {}) },
          ],
        },
        config: {
          recursion_limit: 150,
          configurable: {
            user_id: backendPayload.user_id,
            platform: backendPayload.platform || 'text',
            ritual,
            context_mode: backendPayload.context_mode || 'life',
            thread_id: threadId,
            ...(backendPayload.memory_source_action ? {
              memory_source_action: backendPayload.memory_source_action,
              memory_source_session_id: backendPayload.session_id,
            } : {}),
            // Server-trusted attachment list (Codex P2 PR #132 latest
            // iteration). Always sent — empty array when no attachments.
            // Configurable is also merged with stored config. Always send
            // [] for no legacy files; the server auth hook separately clears
            // absent canonical request/proof slots before that merge.
            // start_builder_task reads it via
            // runtime.config.configurable instead of parsing the
            // synthesized prompt block (which a user can spoof by
            // typing the marker into their own message).
            current_turn_attached_files: attachedFiles,
          },
        },
        stream_mode: ['messages-tuple', 'values'],
      }),
    });
  };

  const createThreadWithFallback = async (): Promise<string> => {
    signal?.throwIfAborted();
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
    attachedFiles: string[] = backendPayload.attached_files ?? [],
  ): Promise<Response> => {
    signal?.throwIfAborted();
    try {
      let response = await runStream(threadId, preludeMessages, attachedFiles);

      if (!backendPayload.memory_source_action && !response.ok && shouldRetryWithDirectLangGraphResponse(response, activeBackendUrl) && switchToDirectLangGraph(`stream returned ${response.status}`)) {
        response = await runStream(threadId, preludeMessages, attachedFiles);
      }

      return response;
    } catch (error) {
      if (signal?.aborted || backendPayload.memory_source_action || !isRetryableLocalLangGraphError(error) || !switchToDirectLangGraph(error instanceof Error ? error.message : 'stream bootstrap failed')) {
        throw error;
      }

      return runStream(threadId, preludeMessages, attachedFiles);
    }
  };

  let threadId = backendPayload.thread_id || await createThreadWithFallback();
  const startedWithThreadId = !!backendPayload.thread_id;
  let upstream = await runStreamWithFallback(threadId);
  let checkpointerResume = startedWithThreadId;
  let recoveredFromTranscript = false;
  let staleThreadId: string | undefined;
  let newThreadId: string | undefined;

  if (!backendPayload.memory_source_action && !upstream.ok && shouldRetryWithFreshThread(upstream, await upstream.clone().text(), !!backendPayload.thread_id)) {
    staleThreadId = threadId;
    const reseedMessages = await fetchContinuationReseedMessages(authToken || null, backendPayload);
    threadId = await createThreadWithFallback();
    newThreadId = threadId;
    recoveredFromTranscript = reseedMessages.length > 0;
    checkpointerResume = false;
    // Codex P2 PR #132: the user's uploaded files live in the OLD
    // (stale) thread's sandbox. The fresh thread has an empty uploads
    // dir, so pass ``[]`` for attached_files — otherwise Sophia would
    // be prompted to ``view_user_image`` / ``read_user_document`` for
    // filenames that don't exist in the new sandbox, failing exactly
    // on the recovery path. Migrating the bytes across sandboxes would
    // need a gateway copy endpoint (separate ticket); for now we drop
    // the attachment hint so the turn degrades to text-only instead of
    // hallucinating tool calls on missing files.
    upstream = await runStreamWithFallback(threadId, reseedMessages, []);

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
    ...(backendPayload.memory_source_action ? {
      confirmCompletion: createRunCompletionCheck({ backendUrl: activeBackendUrl, threadId, upstream, token: authToken, signal }),
    } : {}),
    threadId,
    checkpointerResume,
    resumedFromThread: startedWithThreadId && !staleThreadId,
    recoveredFromTranscript,
    staleThreadId,
    newThreadId,
  };
}
