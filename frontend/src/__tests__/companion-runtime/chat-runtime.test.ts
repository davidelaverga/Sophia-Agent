import { renderHook } from '@testing-library/react';
import type { UIMessage, UIMessageChunk } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useChatMock = vi.fn();

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: unknown) => useChatMock(options),
}));

import { useCompanionChatRuntime } from '../../app/companion-runtime/chat-runtime';
import { TurnErrorReportingChatTransport } from '../../app/companion-runtime/turn-error-transport';

const userMessage = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: 'Research batteries.' }] });

function sseResponse(chunks: UIMessageChunk[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

describe('TurnErrorReportingChatTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports an error chunk with the id of the message that started the turn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'start' },
      { type: 'error', errorText: 'memory_context_rotation_required' },
    ])));
    const report = vi.fn();
    const transport = new TurnErrorReportingChatTransport({ api: '/api/chat' }, report);

    const stream = await transport.sendMessages({
      chatId: 'chat-1', trigger: 'submit-message', messageId: undefined, abortSignal: undefined,
      messages: [userMessage('earlier'), userMessage('source-message-1')],
    });
    const chunks = await drain(stream);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('source-message-1', 'memory_context_rotation_required');
    // The SDK still receives every chunk unchanged.
    expect(chunks.map((chunk) => chunk.type)).toEqual(['start', 'error']);
  });

  it('reports a rejected request and rethrows it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"memory_context_rotation_required"}', { status: 409 })));
    const report = vi.fn();
    const transport = new TurnErrorReportingChatTransport({ api: '/api/chat' }, report);

    await expect(transport.sendMessages({
      chatId: 'chat-1', trigger: 'submit-message', messageId: undefined, abortSignal: undefined,
      messages: [userMessage('source-message-2')],
    })).rejects.toThrow();
    expect(report).toHaveBeenCalledWith('source-message-2', '{"error":"memory_context_rotation_required"}');
  });

  it('reports nothing for a turn that completes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([{ type: 'start' }, { type: 'finish' }])));
    const report = vi.fn();
    const transport = new TurnErrorReportingChatTransport({ api: '/api/chat' }, report);

    await drain(await transport.sendMessages({
      chatId: 'chat-1', trigger: 'submit-message', messageId: undefined, abortSignal: undefined,
      messages: [userMessage('source-message-3')],
    }));
    expect(report).not.toHaveBeenCalled();
  });
});

describe('useCompanionChatRuntime', () => {
  it('sends through the turn-error reporting transport', () => {
    useChatMock.mockReturnValue({
      messages: [], sendMessage: vi.fn(), status: 'ready', error: undefined, setMessages: vi.fn(), stop: vi.fn(),
    });

    renderHook(() => useCompanionChatRuntime({
      chatRequestBody: { session_id: 'session-1' },
      handleDataPart: vi.fn(),
      handleFinish: vi.fn(),
      showUsageLimitModal: vi.fn(),
      recordConnectivityFailure: vi.fn(),
      showToast: vi.fn(),
      onTurnError: vi.fn(),
    }));

    const options = useChatMock.mock.calls[0][0] as { transport: unknown };
    expect(options.transport).toBeInstanceOf(TurnErrorReportingChatTransport);
  });
});
