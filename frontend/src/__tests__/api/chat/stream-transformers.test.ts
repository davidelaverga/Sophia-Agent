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

function buildControlledSseStream() {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
    }),

    enqueue(chunk: string) {
      if (!controllerRef) {
        throw new Error('controlled SSE stream not initialized');
      }

      controllerRef.enqueue(encoder.encode(chunk));
    },

    close() {
      controllerRef?.close();
    },
  };
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
      'event: values\r\ndata: {"values":{"current_artifact":{"takeaway":"Stay grounded","reflection":"What felt different this time?","skill_loaded":"active_listening","voice_emotion_primary":"calm"},"builder_result":{"artifact_title":"Sprint brief","artifact_type":"document","artifact_path":"outputs/sprint-brief.md","decisions_made":[]}}}\r\n\r\n',
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
    expect(objectEvents.some((event) => event.type === 'data-builderArtifactV1')).toBe(true);
    expect(objectEvents.some((event) => event.type === 'data-sophia_meta')).toBe(true);

    const extracted = extractTextFromUiMessageStreamDump(rawDump);
    expect(extracted).toContain('Hello world');
  });

  it('emits transformed text chunks before the upstream stream closes', async () => {
    const controlled = buildControlledSseStream();
    const transformed = createSSEToUIMessageStream(controlled.stream);
    const reader = transformed.getReader();
    const decoder = new TextDecoder();

    const firstChunkPromise = reader.read();

    controlled.enqueue(
      'event: messages\ndata: [{"type":"AIMessageChunk","content":[{"type":"text","text":"Hello"}]},{}]\n\n',
    );

    const readChunkWithTimeout = () => Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for transformed chunk')), 250);
      }),
    ]);

    const firstChunk = await Promise.race([
      firstChunkPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for first transformed chunk')), 250);
      }),
    ]);

    expect(firstChunk.done).toBe(false);
    const secondChunk = await readChunkWithTimeout();
    const thirdChunk = await readChunkWithTimeout();
    const earlyDump = [firstChunk, secondChunk, thirdChunk]
      .filter((chunk): chunk is ReadableStreamReadResult<Uint8Array> & { done: false } => !chunk.done)
      .map((chunk) => decoder.decode(chunk.value, { stream: true }))
      .join('');

    expect(earlyDump).toContain('"type":"start"');
    expect(earlyDump).toContain('"type":"text-start"');
    expect(earlyDump).toContain('"type":"text-delta"');

    controlled.enqueue('event: done\ndata: {"status":"complete"}\n\n');
    controlled.close();

    while (true) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
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
      {
        artifact_title: 'Sprint brief',
        artifact_type: 'document',
        artifact_path: 'outputs/sprint-brief.md',
        decisions_made: [],
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
    expect(objectEvents.some((event) => event.type === 'data-builderArtifactV1')).toBe(true);
    expect(objectEvents.some((event) => event.type === 'data-sophia_meta')).toBe(true);
    expect(String(objectEvents[objectEvents.length - 1].type)).toBe('finish');
    expect(events[events.length - 1]).toBe('[DONE]');

    const extracted = extractTextFromUiMessageStreamDump(rawDump);
    expect(extracted).toContain('Centered response');
  });

  it('emits builder task lifecycle parts for builder background events', async () => {
    const upstream = buildSseStream([
      'event: task_started\ndata: {"task_id":"task-builder-1","description":"Builder: document about the dangers of war"}\n\n',
      'event: task_running\ndata: {"task_id":"task-builder-1","message":{"content":[{"type":"text","text":"Drafting the brief."}]},"message_index":2,"total_messages":4}\n\n',
      'event: task_cancelled\ndata: {"task_id":"task-builder-1","error":"Execution cancelled by user"}\n\n',
      'event: done\ndata: {"status":"complete"}\n\n',
    ]);

    const transformed = createSSEToUIMessageStream(upstream);
    const rawDump = await readStreamAsString(transformed);
    const objectEvents = parseDataEventsFromDump(rawDump).filter(
      (event): event is Record<string, unknown> => typeof event === 'object' && event !== null,
    );

    const builderTaskEvents = objectEvents.filter((event) => event.type === 'data-builderTaskV1');
    expect(builderTaskEvents).toHaveLength(3);
    expect(builderTaskEvents[0]).toMatchObject({
      data: {
        phase: 'running',
        taskId: 'task-builder-1',
        label: 'Builder: document about the dangers of war',
      },
    });
    expect(builderTaskEvents[1]).toMatchObject({
      data: {
        phase: 'running',
        taskId: 'task-builder-1',
        detail: 'Drafting the brief.',
        messageIndex: 2,
        totalMessages: 4,
      },
    });
    expect(builderTaskEvents[2]).toMatchObject({
      data: {
        phase: 'cancelled',
        taskId: 'task-builder-1',
        detail: 'Execution cancelled by user',
      },
    });
  });

  it('emits builder task parts from nested values builder_task state', async () => {
    const upstream = buildSseStream([
      'event: values\ndata: {"values":{"builder_task":{"task_id":"task-builder-2","status":"queued","description":"Builder: voice transport brief"}}}\n\n',
      'event: values\ndata: {"values":{"builder_task":{"task_id":"task-builder-2","status":"synthesized","description":"Builder: voice transport brief"},"builder_result":{"artifact_title":"Voice transport brief","artifact_type":"document","artifact_path":"outputs/voice-transport-brief.md","decisions_made":[]}}}\n\n',
      'event: done\ndata: {"status":"complete"}\n\n',
    ]);

    const transformed = createSSEToUIMessageStream(upstream);
    const rawDump = await readStreamAsString(transformed);
    const objectEvents = parseDataEventsFromDump(rawDump).filter(
      (event): event is Record<string, unknown> => typeof event === 'object' && event !== null,
    );

    const builderTaskEvents = objectEvents.filter((event) => event.type === 'data-builderTaskV1');
    expect(builderTaskEvents).toHaveLength(2);
    expect(builderTaskEvents[0]).toMatchObject({
      data: {
        phase: 'running',
        taskId: 'task-builder-2',
        label: 'Builder: voice transport brief',
      },
    });
    expect(builderTaskEvents[1]).toMatchObject({
      data: {
        phase: 'completed',
        taskId: 'task-builder-2',
        label: 'Builder: voice transport brief',
      },
    });
  });
});
