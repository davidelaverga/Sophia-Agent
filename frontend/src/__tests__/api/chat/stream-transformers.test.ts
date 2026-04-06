import { describe, expect, it } from 'vitest';
import {
  createSSEToUIMessageStream,
  createUIMessageStreamFromText,
} from '../../../app/api/chat/_lib/stream-transformers';
import { extractTextFromUiMessageStreamDump } from '../../../app/lib/ui-message-stream-parser';

function buildSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = chunks.join('');

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

async function readStreamAsString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

function parseDataEventsFromDump(rawDump: string): Array<Record<string, unknown> | string> {
  return rawDump
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const dataLine = chunk
        .split('\n')
        .find((line) => line.startsWith('data:'));

      if (!dataLine) return '';

      const payload = dataLine.slice(5).trim();
      if (payload === '[DONE]') {
        return '[DONE]';
      }

      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return payload;
      }
    });
}

describe('stream-transformers token sanitization', () => {
  it('removes leaked USER_MESSAGE in ui-message stream protocol', async () => {
    const upstream = buildSseStream([
      'event: token\ndata: {"token":"\\n\\n  Hello"}\n\n',
      'event: token\ndata: {"token":" there"}\n\n',
      'event: token\ndata: {"token":"\\nUSER_MESSAGE:\\nLeaked prompt"}\n\n',
      'event: done\ndata: {"status":"complete"}\n\n',
    ]);

    const transformed = createSSEToUIMessageStream(upstream);
    const rawDump = await readStreamAsString(transformed);
    const extracted = extractTextFromUiMessageStreamDump(rawDump);

    expect(extracted).toContain('Hello there');
    expect(extracted).not.toContain('USER_MESSAGE:');
    expect(extracted).not.toContain('Leaked prompt');
    expect(extracted.startsWith('Hello')).toBe(true);
  });

  it('stops output when natural response placeholder leaks mid-stream', async () => {
    const upstream = buildSseStream([
      'event: token\ndata: {"token":"Hello"}\n\n',
      'event: token\ndata: {"token":" there"}\n\n',
      'event: token\ndata: {"token":"\n[Natural response above]"}\n\n',
      'event: done\ndata: {"status":"complete"}\n\n',
    ]);

    const transformed = createSSEToUIMessageStream(upstream);
    const rawDump = await readStreamAsString(transformed);
    const extracted = extractTextFromUiMessageStreamDump(rawDump);

    expect(extracted).toContain('Hello there');
    expect(extracted).not.toContain('[Natural response above]');
  });

  it('keeps AI SDK UI stream envelope contract for upstream SSE tokens', async () => {
    const upstream = buildSseStream([
      'event: token\ndata: {"token":"Hello"}\n\n',
      'event: token\ndata: {"token":" world"}\n\n',
      'event: artifacts_complete\ndata: {"artifacts":{"takeaway":"Breathe"}}\n\n',
      'event: response_complete\ndata: {"skill_used":"chat","emotion":"calm","thread_id":"th_123"}\n\n',
      'event: done\ndata: {"status":"complete"}\n\n',
    ]);

    const transformed = createSSEToUIMessageStream(upstream);
    const rawDump = await readStreamAsString(transformed);
    const events = parseDataEventsFromDump(rawDump);

    const eventTypes = events
      .filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
      .map((event) => String(event.type || ''));

    expect(eventTypes[0]).toBe('start');
    expect(eventTypes[1]).toBe('text-start');
    expect(eventTypes).toContain('text-delta');
    expect(eventTypes).toContain('data-artifactsV1');
    expect(eventTypes).toContain('data-sophia_meta');
    expect(eventTypes).toContain('text-end');
    expect(eventTypes[eventTypes.length - 1]).toBe('finish');
    expect(events[events.length - 1]).toBe('[DONE]');

    const extracted = extractTextFromUiMessageStreamDump(rawDump);
    expect(extracted).toContain('Hello world');
  });

  it('transforms DeerFlow messages and values SSE into UI stream parts', async () => {
    const upstream = buildSseStream([
      'event: messages\r\ndata: [{"type":"AIMessageChunk","content":[{"type":"text","text":"Hello"}]},{"run_id":"run_123"}]\r\n\r\n',
      'event: messages\r\ndata: [{"type":"AIMessageChunk","content":[{"type":"text","text":" world"}]},{}]\r\n\r\n',
      'event: values\r\ndata: {"values":{"current_artifact":{"takeaway":"Stay grounded","reflection":"What felt different this time?","skill_loaded":"active_listening","voice_emotion_primary":"calm"}}}\r\n\r\n',
    ]);

    const transformed = createSSEToUIMessageStream(upstream, {
      session_id: 'session_123',
      thread_id: 'thread_abc',
    });
    const rawDump = await readStreamAsString(transformed);
    const events = parseDataEventsFromDump(rawDump);
    const objectEvents = events.filter(
      (event): event is Record<string, unknown> => typeof event === 'object' && event !== null,
    );

    expect(objectEvents.some((event) => event.type === 'data-artifactsV1')).toBe(true);
    expect(objectEvents.some((event) => event.type === 'data-sophia_meta')).toBe(true);

    const extracted = extractTextFromUiMessageStreamDump(rawDump);
    expect(extracted).toContain('Hello world');
  });

  it('emits canonical envelope and metadata for synthetic text stream fallback', async () => {
    const stream = createUIMessageStreamFromText(
      'Centered response',
      {
        thread_id: 'thread_abc',
        session_id: 'session_123',
        skill_used: 'chat',
      },
      {
        artifacts_status: 'complete',
        takeaway: 'Stay grounded',
      },
    );

    const rawDump = await readStreamAsString(stream);
    const events = parseDataEventsFromDump(rawDump);
    const objectEvents = events.filter(
      (event): event is Record<string, unknown> => typeof event === 'object' && event !== null,
    );

    expect(String(objectEvents[0].type)).toBe('start');
    expect(String(objectEvents[1].type)).toBe('text-start');
    expect(objectEvents.some((event) => event.type === 'data-artifactsV1')).toBe(true);
    expect(objectEvents.some((event) => event.type === 'data-sophia_meta')).toBe(true);
    expect(String(objectEvents[objectEvents.length - 1].type)).toBe('finish');
    expect(events[events.length - 1]).toBe('[DONE]');

    const extracted = extractTextFromUiMessageStreamDump(rawDump);
    expect(extracted).toContain('Centered response');
  });
});
