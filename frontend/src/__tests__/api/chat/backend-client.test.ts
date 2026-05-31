import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerAuthTokenMock = vi.fn();
const secureLogMock = vi.fn();

vi.mock('../../../app/lib/auth/server-auth', () => ({
  getUserScopedAuthToken: (...args: unknown[]) => getServerAuthTokenMock(...args),
}));

vi.mock('../../../app/api/chat/_lib/config', () => ({
  IS_PRODUCTION: false,
  SOPHIA_ASSISTANT_ID: 'sophia_companion',
  secureLog: (...args: unknown[]) => secureLogMock(...args),
}));

import {
  fetchBackendStreamWithBootstrap,
  isValidSophiaUserId,
  type BackendStreamPayload,
} from '../../../app/api/chat/_lib/backend-client';

const basePayload: BackendStreamPayload = {
  message: 'Hello Sophia',
  session_id: '123e4567-e89b-12d3-a456-426614174000',
  user_id: 'user-123',
  context_mode: 'life',
  platform: 'text',
  language: 'en',
};

describe('fetchBackendStreamWithBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerAuthTokenMock.mockResolvedValue('');
  });

  it('falls back to direct LangGraph when the local proxy bootstrap request fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ thread_id: 'thread-live-123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      basePayload,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:2026/api/langgraph/threads',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:2024/threads',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:2024/threads/thread-live-123/runs/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.threadId).toBe('thread-live-123');
    expect(result.upstream.status).toBe(200);
    expect(secureLogMock).toHaveBeenCalledWith(
      '[/api/chat] local langgraph proxy unavailable, retrying direct backend',
      expect.objectContaining({ fallbackBackendUrl: 'http://127.0.0.1:2024/threads' }),
    );
  });

  it('falls back to direct LangGraph when an existing thread hits a proxy 503', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('proxy unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        thread_id: 'thread-existing-123',
      },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:2026/api/langgraph/threads/thread-existing-123/runs/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:2024/threads/thread-existing-123/runs/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.threadId).toBe('thread-existing-123');
    expect(result.upstream.status).toBe(200);
  });

  it('does not pre-read successful SSE responses for existing threads', async () => {
    const cloneTextMock = vi.fn().mockResolvedValue('event: message\ndata: ok\n\n');
    const upstreamResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      clone: vi.fn(() => ({ text: cloneTextMock })),
    } as unknown as Response;

    const fetchMock = vi.fn().mockResolvedValueOnce(upstreamResponse);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        thread_id: 'thread-existing-456',
      },
    );

    expect(result.threadId).toBe('thread-existing-456');
    expect(result.upstream).toBe(upstreamResponse);
    expect(upstreamResponse.clone).not.toHaveBeenCalled();
    expect(cloneTextMock).not.toHaveBeenCalled();
  });

  it('still retries stale 404 thread responses by reading the error body', async () => {
    const staleThreadCloneTextMock = vi.fn().mockResolvedValue('Thread or assistant not found');
    const staleThreadResponse = {
      ok: false,
      status: 404,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      clone: vi.fn(() => ({ text: staleThreadCloneTextMock })),
    } as unknown as Response;

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(staleThreadResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({ thread_id: 'thread-fresh-789' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        thread_id: 'thread-stale-123',
      },
    );

    expect(staleThreadResponse.clone).toHaveBeenCalledTimes(1);
    expect(staleThreadCloneTextMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:2026/api/langgraph/threads',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:2026/api/langgraph/threads/thread-fresh-789/runs/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.threadId).toBe('thread-fresh-789');
    expect(result.upstream.status).toBe(200);
  });

  it('reseeds a fresh thread from bounded transcript when the old thread is missing', async () => {
    getServerAuthTokenMock.mockResolvedValue('user-token');
    const staleThreadResponse = {
      ok: false,
      status: 404,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      clone: vi.fn(() => ({ text: vi.fn().mockResolvedValue('Thread or assistant not found') })),
    } as unknown as Response;

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(staleThreadResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [
          { role: 'user', content: 'For this conversation only, the phrase is amber bridge.' },
          { role: 'sophia', content: 'Got it for this thread.' },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ thread_id: 'thread-recovered-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        thread_id: 'thread-missing-1',
        message: 'What was the phrase?',
      },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/api\/v1\/sessions\/123e4567-e89b-12d3-a456-426614174000\/messages\?user_id=user-123$/),
      expect.objectContaining({ method: 'GET' }),
    );
    const runBody = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    expect(runBody.input.messages).toHaveLength(2);
    expect(runBody.input.messages[0].content).toContain('amber bridge');
    expect(runBody.input.messages[1]).toEqual({ role: 'user', content: 'What was the phrase?' });
    expect(result.threadId).toBe('thread-recovered-1');
    expect(result.checkpointerResume).toBe(false);
    expect(result.resumedFromThread).toBe(false);
    expect(result.recoveredFromTranscript).toBe(true);
    expect(result.staleThreadId).toBe('thread-missing-1');
    expect(result.newThreadId).toBe('thread-recovered-1');
  });

  it('drops attached_files on the fresh-thread recovery run (Codex P2 PR #132)', async () => {
    // The uploaded bytes live in the STALE thread's sandbox. The
    // fresh thread has an empty uploads dir, so the recovery run must
    // send current_turn_attached_files: [] — otherwise Sophia is
    // prompted to view_user_image / read_user_document for files that
    // don't exist in the new sandbox.
    getServerAuthTokenMock.mockResolvedValue('user-token');
    const staleThreadResponse = {
      ok: false,
      status: 404,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      clone: vi.fn(() => ({ text: vi.fn().mockResolvedValue('Thread or assistant not found') })),
    } as unknown as Response;

    const fetchMock = vi.fn()
      // 1: runStream on stale thread → 404
      .mockResolvedValueOnce(staleThreadResponse)
      // 2: fetchContinuationReseedMessages → GET messages (empty)
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      // 3: createThread → fresh thread id
      .mockResolvedValueOnce(new Response(JSON.stringify({ thread_id: 'thread-recovered-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      // 4: runStream on fresh thread → SSE 200
      .mockResolvedValueOnce(new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        thread_id: 'thread-with-uploads',
        // ``message`` carries the synthesized attachment block (as the
        // post-handler would have prefixed it); ``raw_message`` is the
        // user's original text.
        message:
          '[The user has uploaded 2 file(s) for this turn.\n- report.png\n- spec.pdf]\n\nwhat is in these?',
        raw_message: 'what is in these?',
        attached_files: ['report.png', 'spec.pdf'],
      },
    );

    // The FIRST (stale-thread) run carried the real attachment list
    // AND the prefixed message (so the model knows to view them).
    const staleRunBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    // Per-run channel (Codex P2 PR #132 latest): rides config.configurable,
    // NOT input — input is persisted into thread state and would leak a
    // prior turn's list into a later attachment-free turn.
    expect(staleRunBody.config.configurable.current_turn_attached_files).toEqual(['report.png', 'spec.pdf']);
    expect(staleRunBody.input.current_turn_attached_files).toBeUndefined();
    expect(staleRunBody.input.messages.at(-1).content).toContain('The user has uploaded');

    // The FRESH-thread recovery run (4th fetch) drops the attachment
    // list AND uses the RAW message (no attachment block) — the bytes
    // aren't in the new sandbox, so the model must not be told to
    // view_user_image / read_user_document them.
    const freshRunBody = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    expect(freshRunBody.config.configurable.current_turn_attached_files).toEqual([]);
    expect(freshRunBody.input.current_turn_attached_files).toBeUndefined();
    const freshLastMsg = freshRunBody.input.messages.at(-1);
    expect(freshLastMsg.content).toBe('what is in these?');
    expect(freshLastMsg.content).not.toContain('The user has uploaded');
  });

  it('sends attached_files on the normal (non-recovery) run', async () => {
    // Happy path: an existing thread that responds 200 carries the
    // current-turn attachment list straight through.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        thread_id: 'thread-ok',
        attached_files: ['photo.png'],
      },
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    // Per-run channel: config.configurable, not input (Codex P2 PR #132).
    expect(body.config.configurable.current_turn_attached_files).toEqual(['photo.png']);
    expect(body.input.current_turn_attached_files).toBeUndefined();
  });

  it('accepts production auth provider user_id shapes', () => {
    expect(isValidSophiaUserId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isValidSophiaUserId('clx8k2n9s0000abcd1234efgh')).toBe(true);
    expect(isValidSophiaUserId('user.with-dots+plus@example.com')).toBe(true);
    expect(isValidSophiaUserId('auth0:abc|def')).toBe(true);
    expect(isValidSophiaUserId('a'.repeat(128))).toBe(true);
  });

  it('rejects unsafe user ids before forwarding to LangGraph', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchBackendStreamWithBootstrap(
      'http://localhost:2026/api/langgraph/threads',
      {
        ...basePayload,
        user_id: 'user..bad',
      },
    )).rejects.toThrow('Invalid user_id format');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
