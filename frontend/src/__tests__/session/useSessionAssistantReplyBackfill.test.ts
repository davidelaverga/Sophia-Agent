import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionAssistantReplyBackfill } from '../../app/session/useSessionAssistantReplyBackfill';
import type { BuilderCompletionEventV1 } from '../../app/types/builder-completion';

const { getSessionMessagesMock, recordCaptureEventMock } = vi.hoisted(() => ({
  getSessionMessagesMock: vi.fn(),
  recordCaptureEventMock: vi.fn(),
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  getSessionMessages: getSessionMessagesMock,
  isError: (result: { success: boolean }) => !result.success,
}));

vi.mock('../../app/lib/session-capture', () => ({
  recordSophiaCaptureEvent: recordCaptureEventMock,
}));

vi.mock('../../app/lib/debug-logger', () => ({
  debugLog: vi.fn(),
}));

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{ type: 'text'; text: string }>;
};

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

type HarnessProps = {
  chatStatus: ChatStatus;
  builderCompletion: BuilderCompletionEventV1 | null;
  initialMessages?: ChatMessage[];
};

function transcriptResponse(messages: Array<{ id: string; role: 'user' | 'sophia'; content: string }>) {
  return {
    success: true as const,
    data: {
      session_id: 'sess-1',
      thread_id: 'thread-1',
      messages: messages.map((message) => ({ ...message, created_at: '2026-06-10T02:44:06Z' })),
    },
  };
}

function useHarness({ chatStatus, builderCompletion, initialMessages = [] }: HarnessProps) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialMessages);

  useSessionAssistantReplyBackfill({
    enabled: true,
    backendSessionId: 'sess-1',
    userId: 'user-1',
    chatMessages,
    chatStatus,
    builderCompletion,
    setChatMessages,
    setMessageTimestamp: vi.fn(),
  });

  return { chatMessages, setChatMessages };
}

function renderHarness(initialProps: HarnessProps) {
  return renderHook((props: HarnessProps) => useHarness(props), { initialProps });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const builderCompletion: BuilderCompletionEventV1 = {
  task_id: 'task-1',
  run_id: 'run-1',
  status: 'success',
} as BuilderCompletionEventV1;

describe('useSessionAssistantReplyBackfill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSessionMessagesMock.mockReset();
    recordCaptureEventMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends the final assistant reply when a stream turn ends with no assistant text', async () => {
    getSessionMessagesMock.mockResolvedValue(transcriptResponse([
      { id: 'm-user-1', role: 'user', content: 'Hey Sophia!' },
      { id: 'm-ai-1', role: 'sophia', content: 'The build is underway — I will let you know.' },
    ]));

    const { result, rerender } = renderHarness({
      chatStatus: 'ready',
      builderCompletion: null,
      initialMessages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hey Sophia!' }] },
      ],
    });

    rerender({ chatStatus: 'streaming', builderCompletion: null });
    rerender({ chatStatus: 'ready', builderCompletion: null });

    await advance(1_500);

    const assistantMessages = result.current.chatMessages.filter((message) => message.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      id: 'm-ai-1',
      parts: [{ type: 'text', text: 'The build is underway — I will let you know.' }],
    });

    // Resolved batches cancel later retries — no second fetch at 6s.
    await advance(10_000);
    expect(getSessionMessagesMock).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a reply the stream already appended', async () => {
    getSessionMessagesMock.mockResolvedValue(transcriptResponse([
      { id: 'm-user-1', role: 'user', content: 'Build me a page' },
      { id: 'm-ai-1', role: 'sophia', content: 'Done! Your page is ready.' },
    ]));

    const { result, rerender } = renderHarness({
      chatStatus: 'ready',
      builderCompletion: null,
      initialMessages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Build me a page' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Done!  Your page is ready.' }] },
      ],
    });

    rerender({ chatStatus: 'ready', builderCompletion });
    await advance(20_000);

    expect(result.current.chatMessages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    const outcomes = recordCaptureEventMock.mock.calls.map(([event]) => event.payload.assistantMessageBackfillResult);
    expect(outcomes).toContain('dedupe-suppressed');
    expect(outcomes).not.toContain('appended');
  });

  it('suppresses a backfill copy that differs only by curly apostrophes', async () => {
    getSessionMessagesMock.mockResolvedValue(transcriptResponse([
      { id: 'm-user-1', role: 'user', content: 'Build me a page' },
      { id: 'm-ai-1', role: 'sophia', content: 'Starting the build now — I’ll have it back to you shortly.' },
    ]));

    const { result, rerender } = renderHarness({
      chatStatus: 'ready',
      builderCompletion: null,
      initialMessages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Build me a page' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: "Starting the build now — I'll have it back to you shortly." }] },
      ],
    });

    rerender({ chatStatus: 'ready', builderCompletion });
    await advance(20_000);

    expect(result.current.chatMessages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    const outcomes = recordCaptureEventMock.mock.calls.map(([event]) => event.payload.assistantMessageBackfillResult);
    expect(outcomes).toContain('dedupe-suppressed');
    expect(outcomes).not.toContain('appended');
  });

  it('suppresses a backfill copy already contained in the streamed bubble', async () => {
    const sentence = "Starting the build now — I'll have it back to you shortly.";
    getSessionMessagesMock.mockResolvedValue(transcriptResponse([
      { id: 'm-user-1', role: 'user', content: 'Build me a page' },
      { id: 'm-ai-1', role: 'sophia', content: sentence },
    ]));

    const { result, rerender } = renderHarness({
      chatStatus: 'ready',
      builderCompletion: null,
      initialMessages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Build me a page' }] },
        // Doubled-stream shape: the live bubble already contains the sentence twice.
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: `${sentence}\n\n${sentence}` }] },
      ],
    });

    rerender({ chatStatus: 'ready', builderCompletion });
    await advance(20_000);

    expect(result.current.chatMessages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    const outcomes = recordCaptureEventMock.mock.calls.map(([event]) => event.payload.assistantMessageBackfillResult);
    expect(outcomes).toContain('dedupe-suppressed');
    expect(outcomes).not.toContain('appended');
  });

  it('retries after builder completion until the wakeup reply lands, then appends once', async () => {
    getSessionMessagesMock
      .mockResolvedValueOnce(transcriptResponse([
        { id: 'm-user-1', role: 'user', content: 'Build me a page' },
      ]))
      .mockResolvedValueOnce(transcriptResponse([
        { id: 'm-user-1', role: 'user', content: 'Build me a page' },
        { id: 'm-ai-wakeup', role: 'sophia', content: 'Your page is ready — take a look!' },
      ]));

    const { result, rerender } = renderHarness({
      chatStatus: 'ready',
      builderCompletion: null,
      initialMessages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Build me a page' }] },
      ],
    });

    rerender({ chatStatus: 'ready', builderCompletion });

    await advance(4_000);
    expect(result.current.chatMessages.filter((message) => message.role === 'assistant')).toHaveLength(0);

    await advance(5_000);
    const assistantMessages = result.current.chatMessages.filter((message) => message.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe('m-ai-wakeup');

    // The third scheduled retry (16s) is cancelled once the reply appended.
    await advance(20_000);
    expect(getSessionMessagesMock).toHaveBeenCalledTimes(2);
    expect(result.current.chatMessages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });

  it('appends nothing when the transcript ends with a user message (tool-call-only turn)', async () => {
    getSessionMessagesMock.mockResolvedValue(transcriptResponse([
      { id: 'm-user-1', role: 'user', content: 'Hey Sophia!' },
    ]));

    const { result, rerender } = renderHarness({
      chatStatus: 'ready',
      builderCompletion: null,
      initialMessages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hey Sophia!' }] },
      ],
    });

    rerender({ chatStatus: 'streaming', builderCompletion: null });
    rerender({ chatStatus: 'ready', builderCompletion: null });

    await advance(10_000);

    expect(result.current.chatMessages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    const outcomes = recordCaptureEventMock.mock.calls.map(([event]) => event.payload.assistantMessageBackfillResult);
    expect(outcomes).toContain('no-candidate');
    expect(outcomes).not.toContain('appended');
  });

  it('does not trigger a backfill when the stream already appended assistant text', async () => {
    const { result, rerender } = renderHarness({
      chatStatus: 'ready',
      builderCompletion: null,
      initialMessages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hey Sophia!' }] },
      ],
    });

    rerender({ chatStatus: 'streaming', builderCompletion: null });

    // The live stream appends the assistant reply during the turn.
    act(() => {
      result.current.setChatMessages((prev) => [
        ...prev,
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi! Good to see you.' }] },
      ]);
    });

    rerender({ chatStatus: 'ready', builderCompletion: null });

    await advance(10_000);
    expect(getSessionMessagesMock).not.toHaveBeenCalled();
  });

  it('emits only safe telemetry fields (no raw text, payloads, or secrets)', async () => {
    getSessionMessagesMock.mockResolvedValue(transcriptResponse([
      { id: 'm-user-1', role: 'user', content: 'Build me a page' },
      { id: 'm-ai-1', role: 'sophia', content: 'Your page is ready — take a look!' },
    ]));

    const { rerender } = renderHarness({
      chatStatus: 'ready',
      builderCompletion: null,
      initialMessages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Build me a page' }] },
      ],
    });

    rerender({ chatStatus: 'ready', builderCompletion });
    await advance(4_000);

    expect(recordCaptureEventMock).toHaveBeenCalled();
    for (const [event] of recordCaptureEventMock.mock.calls) {
      expect(event.category).toBe('companion');
      expect(event.name).toBe('assistant-reply-backfill');
      const payload = event.payload as Record<string, unknown>;
      expect(payload.rawProviderPayloadExcluded).toBe(true);
      expect(payload.providerSecretsExcluded).toBe(true);
      expect(typeof payload.assistantMessageVisibleCount).toBe('number');
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('Your page is ready');
      expect(serialized).not.toContain('Build me a page');
      for (const value of Object.values(payload)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });
});
