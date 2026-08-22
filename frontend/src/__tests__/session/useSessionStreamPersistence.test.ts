import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStreamPersistence } from '../../app/session/useSessionStreamPersistence';
import { useSessionStore } from '../../app/stores/session-store';
import type {
  SessionMessageItem,
  SessionMessagesPersistRequest,
  SessionMessagesResponse,
} from '../../app/types/session';

const SESSION_ONE = '11111111-1111-4111-8111-111111111111';
const SESSION_TWO = '22222222-2222-4222-8222-222222222222';

const { getSessionMessagesMock, persistSessionMessagesMock } = vi.hoisted(() => ({
  getSessionMessagesMock: vi.fn(),
  persistSessionMessagesMock: vi.fn(),
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  getSessionMessages: (...args: unknown[]) => getSessionMessagesMock(...args),
  isError: (value: { success?: boolean }) => value?.success === false,
  persistSessionMessages: (...args: unknown[]) => persistSessionMessagesMock(...args),
}));

vi.mock('../../app/lib/debug-logger', () => ({
  debugLog: vi.fn(),
}));

function historyResponse({
  sessionId = SESSION_ONE,
  threadId = 'thread-1',
  revision = 0,
  messages = [],
  accepted = true,
  conflict = false,
  rejectionReason = null,
}: {
  sessionId?: string;
  threadId?: string;
  revision?: number;
  messages?: SessionMessageItem[];
  accepted?: boolean;
  conflict?: boolean;
  rejectionReason?: SessionMessagesResponse['rejection_reason'];
}) {
  return {
    success: true as const,
    data: {
      session_id: sessionId,
      thread_id: threadId,
      messages,
      message_revision: revision,
      accepted,
      duplicate: false,
      conflict,
      deleted_count: 0,
      rejection_reason: rejectionReason,
    },
  };
}

function responseMessages(body: SessionMessagesPersistRequest): SessionMessageItem[] {
  return body.messages.map((message) => ({
    id: message.message_id ?? message.id ?? 'missing-id',
    role: message.role === 'user' ? 'user' : 'sophia',
    content: message.content,
    created_at: message.created_at ?? null,
    source: message.source ?? 'text',
    final: message.final ?? true,
    approximate: message.approximate ?? false,
    turn_id: message.turn_id ?? null,
    provider_event_id: message.provider_event_id ?? null,
  }));
}

function activeSession(sessionId = SESSION_ONE, threadId = 'thread-1') {
  return {
    sessionId,
    threadId,
    userId: 'user-1',
    presetType: 'open' as const,
    contextMode: 'life' as const,
    status: 'active' as const,
    voiceMode: false,
    startedAt: '2026-04-15T00:00:00.000Z',
    lastActivityAt: '2026-04-15T00:00:00.000Z',
    isActive: true,
    companionInvokesCount: 0,
  };
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe('useSessionStreamPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSessionMessagesMock.mockReset();
    persistSessionMessagesMock.mockReset();
    getSessionMessagesMock.mockResolvedValue(historyResponse({}));
    persistSessionMessagesMock.mockImplementation((
      sessionId: string,
      body: SessionMessagesPersistRequest,
    ) => Promise.resolve(historyResponse({
      sessionId,
      threadId: body.thread_id ?? 'thread-1',
      revision: body.base_revision + 1,
      messages: responseMessages(body),
    })));
    useSessionStore.setState({ session: activeSession() });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    act(() => useSessionStore.getState().clearSession());
  });

  it('seeds the authoritative revision before persisting an ordered snapshot', async () => {
    getSessionMessagesMock.mockResolvedValue(historyResponse({ revision: 7 }));
    const updateMessages = vi.fn();

    renderHook(() =>
      useSessionStreamPersistence({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'restore this later',
            createdAt: '2026-04-15T00:01:00.000Z',
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'I will keep the thread warm.',
            createdAt: '2026-04-15T00:01:05.000Z',
          },
        ],
        chatStatus: 'ready',
        updateMessages,
      }),
    );

    await advance(200);

    expect(getSessionMessagesMock).toHaveBeenCalledWith(SESSION_ONE, 'user-1');
    expect(persistSessionMessagesMock).toHaveBeenCalledWith(
      SESSION_ONE,
      expect.objectContaining({
        user_id: 'user-1',
        thread_id: 'thread-1',
        base_revision: 7,
        messages: expect.arrayContaining([
          expect.objectContaining({ message_id: 'user-1', content: 'restore this later' }),
          expect.objectContaining({ message_id: 'assistant-1', content: 'I will keep the thread warm.' }),
        ]),
      }),
      'user-1',
    );
  });

  it('resets and reseeds revision state when the active session changes', async () => {
    getSessionMessagesMock.mockImplementation((sessionId: string) => Promise.resolve(historyResponse({
      sessionId,
      threadId: sessionId === SESSION_ONE ? 'thread-1' : 'thread-2',
      revision: sessionId === SESSION_ONE ? 4 : 12,
    })));
    const updateMessages = vi.fn();
    const firstMessages = [{
      id: 'first-user',
      role: 'user' as const,
      content: 'first session',
      createdAt: '2026-04-15T00:01:00.000Z',
    }];

    const { rerender } = renderHook(
      ({ messages }) => useSessionStreamPersistence({
        messages,
        chatStatus: 'ready',
        updateMessages,
      }),
      { initialProps: { messages: firstMessages } },
    );
    await advance(200);

    act(() => {
      useSessionStore.setState({ session: activeSession(SESSION_TWO, 'thread-2') });
    });
    rerender({
      messages: [{
        id: 'second-user',
        role: 'user',
        content: 'restored second session',
        createdAt: '2026-04-15T00:02:00.000Z',
      }],
    });
    await advance(200);

    expect(persistSessionMessagesMock).toHaveBeenNthCalledWith(
      1,
      SESSION_ONE,
      expect.objectContaining({ base_revision: 4 }),
      'user-1',
    );
    expect(persistSessionMessagesMock).toHaveBeenNthCalledWith(
      2,
      SESSION_TWO,
      expect.objectContaining({ base_revision: 12 }),
      'user-1',
    );
  });

  it('reseeds the same restored session after a page reload', async () => {
    getSessionMessagesMock
      .mockResolvedValueOnce(historyResponse({ revision: 5 }))
      .mockResolvedValueOnce(historyResponse({ revision: 8 }));

    const firstPage = renderHook(() => useSessionStreamPersistence({
      messages: [{
        id: 'before-reload',
        role: 'user',
        content: 'before reload',
        createdAt: '2026-04-15T00:01:00.000Z',
      }],
      chatStatus: 'ready',
      updateMessages: vi.fn(),
    }));
    await advance(200);
    firstPage.unmount();

    renderHook(() => useSessionStreamPersistence({
      messages: [{
        id: 'after-reload',
        role: 'user',
        content: 'after reload',
        createdAt: '2026-04-15T00:02:00.000Z',
      }],
      chatStatus: 'ready',
      updateMessages: vi.fn(),
    }));
    await advance(200);

    expect(persistSessionMessagesMock).toHaveBeenNthCalledWith(
      1,
      SESSION_ONE,
      expect.objectContaining({ base_revision: 5 }),
      'user-1',
    );
    expect(persistSessionMessagesMock).toHaveBeenNthCalledWith(
      2,
      SESSION_ONE,
      expect.objectContaining({ base_revision: 8 }),
      'user-1',
    );
  });

  it('serializes writes and coalesces overlap to the newest pending snapshot', async () => {
    let resolveFirst: ((value: ReturnType<typeof historyResponse>) => void) | undefined;
    const firstWrite = new Promise<ReturnType<typeof historyResponse>>((resolve) => {
      resolveFirst = resolve;
    });
    persistSessionMessagesMock
      .mockImplementationOnce(() => firstWrite)
      .mockImplementationOnce((sessionId: string, body: SessionMessagesPersistRequest) => (
        Promise.resolve(historyResponse({
          sessionId,
          revision: 2,
          messages: responseMessages(body),
        }))
      ));
    const updateMessages = vi.fn();

    const { rerender } = renderHook(
      ({ content }) => useSessionStreamPersistence({
        messages: [{
          id: `message-${content}`,
          role: 'user',
          content,
          createdAt: `2026-04-15T00:01:0${content.length}.000Z`,
        }],
        chatStatus: 'ready',
        updateMessages,
      }),
      { initialProps: { content: 'one' } },
    );

    await advance(200);
    expect(persistSessionMessagesMock).toHaveBeenCalledTimes(1);

    rerender({ content: 'two' });
    await advance(200);
    rerender({ content: 'newest' });
    await advance(200);
    expect(persistSessionMessagesMock).toHaveBeenCalledTimes(1);

    resolveFirst?.(historyResponse({
      revision: 1,
      messages: [{
        id: 'message-one',
        role: 'user',
        content: 'one',
        created_at: '2026-04-15T00:01:03.000Z',
      }],
    }));
    await advance(0);

    expect(persistSessionMessagesMock).toHaveBeenCalledTimes(2);
    const secondBody = persistSessionMessagesMock.mock.calls[1]?.[1] as SessionMessagesPersistRequest;
    expect(secondBody.base_revision).toBe(1);
    expect(secondBody.messages.map((message) => message.content)).toEqual(['newest']);
  });

  it('refetches and rebases local additions without resurrecting a deleted baseline row', async () => {
    const acceptedA: SessionMessageItem = {
      id: 'message-a',
      role: 'user',
      content: 'keep me',
      created_at: '2026-04-15T00:01:00.000Z',
    };
    const deletedB: SessionMessageItem = {
      id: 'message-b',
      role: 'sophia',
      content: 'deleted in another tab',
      created_at: '2026-04-15T00:01:01.000Z',
    };
    getSessionMessagesMock
      .mockResolvedValueOnce(historyResponse({ revision: 2, messages: [acceptedA, deletedB] }))
      .mockResolvedValueOnce(historyResponse({ revision: 3, messages: [acceptedA] }));
    persistSessionMessagesMock
      .mockResolvedValueOnce(historyResponse({
        revision: 3,
        messages: [acceptedA],
        accepted: false,
        conflict: true,
        rejectionReason: 'revision_conflict',
      }))
      .mockImplementationOnce((sessionId: string, body: SessionMessagesPersistRequest) => (
        Promise.resolve(historyResponse({
          sessionId,
          revision: 4,
          messages: responseMessages(body),
        }))
      ));
    const updateMessages = vi.fn();

    renderHook(() => useSessionStreamPersistence({
      messages: [
        { id: 'message-a', role: 'user', content: 'keep me', createdAt: '2026-04-15T00:01:00.000Z' },
        { id: 'message-b', role: 'assistant', content: 'deleted in another tab', createdAt: '2026-04-15T00:01:01.000Z' },
        { id: 'message-c', role: 'user', content: 'new in this tab', createdAt: '2026-04-15T00:01:02.000Z' },
      ],
      chatStatus: 'ready',
      updateMessages,
    }));

    await advance(200);
    await advance(0);

    expect(getSessionMessagesMock).toHaveBeenCalledTimes(2);
    expect(persistSessionMessagesMock).toHaveBeenCalledTimes(2);
    const rebasedBody = persistSessionMessagesMock.mock.calls[1]?.[1] as SessionMessagesPersistRequest;
    expect(rebasedBody.base_revision).toBe(3);
    expect(rebasedBody.messages.map((message) => message.message_id)).toEqual([
      'message-a',
      'message-c',
    ]);
    expect(updateMessages).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'message-a', content: 'keep me' }),
      expect.objectContaining({ id: 'message-c', content: 'new in this tab' }),
    ]);
  });

  it('rejects an unseeded stale snapshot instead of resurrecting deleted rows', async () => {
    const authoritative: SessionMessageItem = {
      id: 'message-a',
      role: 'user',
      content: 'authoritative row',
      created_at: '2026-04-15T00:01:00.000Z',
    };
    getSessionMessagesMock
      .mockResolvedValueOnce({
        success: false,
        error: 'seed unavailable',
        code: 'NETWORK_ERROR',
      })
      .mockResolvedValueOnce(historyResponse({ revision: 6, messages: [authoritative] }));
    persistSessionMessagesMock.mockResolvedValueOnce(historyResponse({
      revision: 6,
      messages: [authoritative],
      accepted: false,
      conflict: true,
      rejectionReason: 'revision_conflict',
    }));
    const updateMessages = vi.fn();

    renderHook(() => useSessionStreamPersistence({
      messages: [
        {
          id: 'deleted-stale-row',
          role: 'assistant',
          content: 'must stay deleted',
          createdAt: '2026-04-15T00:01:01.000Z',
        },
        {
          id: 'unclassified-local-row',
          role: 'user',
          content: 'cannot safely rebase without a baseline',
          createdAt: '2026-04-15T00:01:02.000Z',
        },
      ],
      chatStatus: 'ready',
      updateMessages,
    }));

    await advance(200);
    await advance(0);

    expect(persistSessionMessagesMock).toHaveBeenCalledTimes(1);
    expect(persistSessionMessagesMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ base_revision: 0 }),
    );
    expect(getSessionMessagesMock).toHaveBeenCalledTimes(2);
    expect(updateMessages).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'message-a', content: 'authoritative row' }),
    ]);
  });

  it('includes the last-known base revision in lifecycle beacons', async () => {
    getSessionMessagesMock.mockResolvedValue(historyResponse({ revision: 9 }));
    const sendBeacon = vi.fn((_url: string | URL, _data?: BodyInit | null) => true);
    const NativeBlob = Blob;
    class CapturingBlob extends NativeBlob {
      readonly sourceParts: BlobPart[];

      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        this.sourceParts = parts;
      }
    }
    vi.stubGlobal('Blob', CapturingBlob);
    vi.stubGlobal('navigator', {
      ...navigator,
      sendBeacon,
    });

    renderHook(() => useSessionStreamPersistence({
      messages: [{
        id: 'voice-user-1',
        role: 'user',
        content: 'flush this safely',
        createdAt: '2026-04-15T00:01:00.000Z',
      }],
      chatStatus: 'ready',
      updateMessages: vi.fn(),
    }));

    await advance(0);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const beaconBlob = sendBeacon.mock.calls[0]?.[1] as CapturingBlob;
    const body = JSON.parse(String(beaconBlob.sourceParts[0]));
    expect(body.base_revision).toBe(9);
    expect(body.messages[0].message_id).toBe('voice-user-1');
  });

  it('does not persist a UI-only fallback greeting', async () => {
    useSessionStore.setState((state) => ({
      session: state.session ? { ...state.session, greetingMessageId: 'greeting-1' } : state.session,
    }));

    renderHook(() => useSessionStreamPersistence({
      messages: [{
        id: 'greeting-1',
        role: 'assistant',
        content: "I'm here with you. What's on your mind?",
        createdAt: '2026-04-15T00:00:00.000Z',
      }],
      chatStatus: 'ready',
      updateMessages: vi.fn(),
    }));

    await advance(200);
    expect(persistSessionMessagesMock).not.toHaveBeenCalled();
  });

  it('persists only finalized visible messages while an assistant response is streaming', async () => {
    renderHook(() => useSessionStreamPersistence({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Can you repeat that?',
          createdAt: '2026-04-15T00:01:00.000Z',
        },
        {
          id: 'assistant-streaming',
          role: 'assistant',
          content: 'Of co',
          createdAt: '2026-04-15T00:01:03.000Z',
        },
      ],
      chatStatus: 'streaming',
      updateMessages: vi.fn(),
    }));

    await advance(800);
    const body = persistSessionMessagesMock.mock.calls[0]?.[1] as SessionMessagesPersistRequest;
    expect(body.messages).toEqual([
      expect.objectContaining({ message_id: 'user-1', final: true, incomplete: false }),
    ]);
  });
});
