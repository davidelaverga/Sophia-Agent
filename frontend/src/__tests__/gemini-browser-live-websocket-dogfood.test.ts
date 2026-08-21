import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearCoreviewToolBridgeForTests,
  registerCoreviewToolBridge,
} from '../app/lib/coreview-actions';
import {
  clearCoreviewArtifactTextRegistryForTests,
  registerCoreviewArtifactText,
  registerCoreviewArtifactTextStatus,
} from '../app/lib/coreview-artifact-text';
import {
  clearCoreviewBuilderToolBridgeForTests,
  registerCoreviewBuilderToolBridge,
} from '../app/lib/coreview-builder-actions';
import {
  buildGeminiArtifactFrameRealtimeInput,
  buildGeminiArtifactTextReaderHint,
  buildGeminiLiveWebSocketUrl,
  categorizeGeminiProviderEvent,
  classifyArtifactReviewUserIntent,
  classifyGeminiProviderEventForRelay,
  connectGeminiBrowserLiveDogfood,
  connectGeminiBrowserLiveFromBootstrap,
  createGeminiConversationAudioRecorder,
  createGeminiOutputAudioPlaybackController,
  isGeminiServerInterruptedEvent,
  isGeminiSetupCompleteMessage,
  isRelayableGeminiProviderEvent,
  pcm16BytesToFloat32,
  pcm16Base64FromFloat32,
  readGeminiOutputAudioChunks,
  readGeminiConfiguredToolNames,
  recordGeminiProviderEventTelemetry,
  createGeminiProviderEventCategoryCounts,
  createGeminiRelayClassificationCounts,
  readGeminiToolCallsFromEvent,
  type GeminiBrowserLiveDogfoodRelayDiagnostic,
  type GeminiBrowserLiveDogfoodRelayStatus,
  type GeminiBrowserLiveDogfoodStage,
  type GeminiBrowserLiveDogfoodInterruptionDiagnostic,
  type GeminiBargeInTranscriptHandoffDiagnostic,
  type GeminiBrowserLiveDogfoodToolLoopDiagnostic,
} from '../app/lib/gemini-browser-live-websocket-dogfood';

const emitArtifactArgs = {
  session_goal: 'Probe Gemini artifacts.',
  active_goal: 'Confirm backend tool loop.',
  next_step: 'Read the debug page.',
  takeaway: 'Tool response returned.',
  reflection: null,
  tone_estimate: 2,
  tone_target: 2.5,
  active_tone_band: 'engagement',
  skill_loaded: 'active_listening',
  ritual_phase: 'freeform.tool_loop',
  voice_emotion_primary: 'calm',
  voice_emotion_secondary: 'sympathetic',
  voice_speed: 'normal',
};
const emitArtifactArgsPreview = `${JSON.stringify(emitArtifactArgs).slice(0, 179)}...`;

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

class FakeWebSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(
    readonly url: string,
    private readonly options: { autoSetupComplete?: boolean; failToolResponseSend?: boolean } = {},
  ) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({} as Event);
    });
  }

  send(data: string) {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.toolResponse && this.options.failToolResponseSend) {
      throw new Error('toolResponse send blocked by test socket');
    }
    this.sent.push(data);
    if (parsed.setup && this.options.autoSetupComplete !== false) {
      queueMicrotask(() => this.emitMessage({ setupComplete: {} }));
    }
  }

  close(code = 1000, reason = 'test close') {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
  }

  emitMessage(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  emitRawMessage(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitError() {
    this.onerror?.({} as Event);
  }

  emitClose(code = 1006, reason = 'provider closed test socket', wasClean = false) {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }
}

class FakeAudioBufferSource {
  buffer: AudioBuffer | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
}

class FakeAudioContext {
  sampleRate = 48000;
  currentTime = 10;
  state: AudioContextState = 'suspended';
  destination = {} as AudioDestinationNode;
  readonly createdSources: FakeAudioBufferSource[] = [];
  readonly createdGains: Array<{ connect: ReturnType<typeof vi.fn> }> = [];
  readonly merger = { connect: vi.fn() };
  readonly mediaStreamDestination = { stream: {} as MediaStream };
  readonly processor = {
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  readonly source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  close = vi.fn(async () => undefined);
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  createMediaStreamSource = vi.fn(() => this.source as unknown as MediaStreamAudioSourceNode);
  createScriptProcessor = vi.fn(() => this.processor as unknown as ScriptProcessorNode);
  createMediaStreamDestination = vi.fn(() => this.mediaStreamDestination as unknown as MediaStreamAudioDestinationNode);
  createChannelMerger = vi.fn(() => this.merger as unknown as ChannelMergerNode);
  createGain = vi.fn(() => {
    const gain = { connect: vi.fn() };
    this.createdGains.push(gain);
    return gain as unknown as GainNode;
  });
  createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => ({
    copyToChannel: vi.fn(),
    duration: length / sampleRate,
  }) as unknown as AudioBuffer);
  createBufferSource = vi.fn(() => {
    const source = new FakeAudioBufferSource();
    this.createdSources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
}

function makeGeminiBrowserSessionFetch(sessionId = 'browser-gemini-1', audioCaptureEnabled = false) {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session_id: sessionId,
          websocket_url: 'wss://gemini.example/live',
          ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
          setup: {
            model: 'models/gemini-3.1-flash-live-preview',
            inputAudioTranscription: {},
            tools: [{ functionDeclarations: [{ name: 'emit_artifact' }] }],
          },
          stream_url: `/api/sophia/voice/dogfood/gemini/events?session_id=${sessionId}`,
          audio_capture_enabled: audioCaptureEnabled,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
}

describe('Gemini browser Live WebSocket dogfood connector', () => {
  afterEach(() => {
    clearCoreviewArtifactTextRegistryForTests();
    clearCoreviewToolBridgeForTests();
    clearCoreviewBuilderToolBridgeForTests();
  });

  it('builds the constrained Live WebSocket URL with only the ephemeral token', () => {
    expect(
      buildGeminiLiveWebSocketUrl(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
        'auth_tokens/gemini-browser-test',
      ),
    ).toContain('access_token=auth_tokens%2Fgemini-browser-test');
    expect(isGeminiSetupCompleteMessage({ setupComplete: {} })).toBe(true);
    expect(isGeminiSetupCompleteMessage({ serverContent: {} })).toBe(false);

    const encoded = pcm16Base64FromFloat32(new Float32Array([0, 1, -1]), 16000);
    expect(Buffer.from(encoded, 'base64')).toHaveLength(6);
  });

  it('builds the experimental artifact still-frame realtimeInput video payload without telemetry fields', () => {
    expect(buildGeminiArtifactFrameRealtimeInput({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    })).toEqual({
      realtimeInput: {
        video: {
          mimeType: 'image/jpeg',
          data: 'base64-frame',
        },
      },
    });
    expect(buildGeminiArtifactTextReaderHint('artifact-1')).toEqual({
      realtimeInput: {
        text: expect.stringContaining('artifact_id: artifact-1'),
      },
    });
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).toContain('artifact-1');
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).toContain('Do not answer this context message');
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).toContain('use coreview_add_annotation');
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).toContain('Do not use coreview_refresh_view for annotation requests');
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).toContain('use coreview_focus_anchor');
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).toContain('coreview_request_artifact_update');
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).toContain('Do not call edit_builder_artifact');
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).not.toMatch(/schema|tool_call_id/i);
    expect(JSON.stringify(buildGeminiArtifactTextReaderHint('artifact-1'))).not.toContain('base64-frame');
  });

  it('classifies artifact review create/update intent conservatively', () => {
    expect(classifyArtifactReviewUserIntent('Can you review this and tell me what changed?')).toBe('analysis');
    expect(classifyArtifactReviewUserIntent('what do you see?')).toBe('analysis');
    expect(classifyArtifactReviewUserIntent('review this')).toBe('analysis');
    expect(classifyArtifactReviewUserIntent('what would you improve visually?')).toBe('analysis');
    expect(classifyArtifactReviewUserIntent('what exact title does it show?')).toBe('analysis');
    expect(classifyArtifactReviewUserIntent('go one by one')).toBe('analysis');
    expect(classifyArtifactReviewUserIntent('create a new artifact')).toBe('create_update');
    expect(classifyArtifactReviewUserIntent('rewrite this artifact')).toBe('create_update');
    expect(classifyArtifactReviewUserIntent('save this as a new version')).toBe('create_update');
    expect(classifyArtifactReviewUserIntent('update the document')).toBe('create_update');
    expect(classifyArtifactReviewUserIntent('Please update this artifact with the revised summary.')).toBe('create_update');
    expect(classifyArtifactReviewUserIntent('Turn this into a document I can save.')).toBe('create_update');
    expect(classifyArtifactReviewUserIntent('   ')).toBe('unknown');
  });

  it('decodes Gemini output PCM16 little-endian bytes into normalized float samples', () => {
    const samples = pcm16BytesToFloat32(new Uint8Array([
      0x00, 0x00,
      0xff, 0x7f,
      0x00, 0x80,
      0x00, 0x40,
    ]));

    expect(samples).toHaveLength(4);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(32767 / 32768, 5);
    expect(samples[2]).toBe(-1);
    expect(samples[3]).toBeCloseTo(0.5, 5);
  });

  it('tees captured assistant audio to the speakers and resumes a suspended context', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const recorder = createGeminiConversationAudioRecorder(
      fakeAudioContext as unknown as AudioContext,
    );

    expect(recorder).not.toBeNull();
    expect(fakeAudioContext.createdGains[1]?.connect).toHaveBeenCalledWith(fakeAudioContext.destination);

    const diagnostics: unknown[] = [];
    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: makeGeminiBrowserSessionFetch('browser-gemini-audio', true) as typeof fetch,
      webSocketFactory: (url) => new FakeWebSocket(url),
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onAudioContextDiagnostics: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(fakeAudioContext.resume).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        stateBefore: 'suspended',
        stateAfter: 'running',
        resumeAttempted: true,
        resumeSucceeded: true,
      }),
      expect.objectContaining({
        stateBefore: 'running',
        stateAfter: 'running',
        resumeAttempted: false,
        resumeSucceeded: null,
      }),
    ]);
    expect(fakeAudioContext.createdGains[1]?.connect).toHaveBeenCalledWith(fakeAudioContext.destination);

    await connection.close();
  });

  it('schedules successive Gemini output audio chunks sequentially and clears playback state', () => {
    const fakeAudioContext = new FakeAudioContext();
    fakeAudioContext.currentTime = 5;
    const player = createGeminiOutputAudioPlaybackController(fakeAudioContext as unknown as AudioContext);
    const chunk = Buffer.from([0x00, 0x00, 0x00, 0x00]).toString('base64');

    expect(player.playBase64Chunk(chunk)).toBe(true);
    expect(player.playBase64Chunk(chunk)).toBe(true);

    const starts = fakeAudioContext.createdSources.map((source) => source.start.mock.calls[0]?.[0] as number);
    expect(starts[0]).toBe(5);
    expect(starts[1]).toBeCloseTo(5 + 2 / 24000, 7);
    expect(starts[1]).toBeGreaterThan(starts[0] ?? 0);
    expect(player.snapshot().nextPlaybackTime).toBeCloseTo(5 + 4 / 24000, 7);
    expect(player.snapshot().activeSourceCount).toBe(2);

    player.stop();

    expect(fakeAudioContext.createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fakeAudioContext.createdSources[1]?.stop).toHaveBeenCalledTimes(1);
    expect(fakeAudioContext.createdSources[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(fakeAudioContext.createdSources[1]?.disconnect).toHaveBeenCalledTimes(1);
    expect(player.snapshot()).toEqual({ nextPlaybackTime: 0, activeSourceCount: 0, playbackGeneration: 1 });
  });

  it('records bounded non-raw diagnostics for scheduled Gemini output audio chunks', () => {
    const fakeAudioContext = new FakeAudioContext();
    fakeAudioContext.currentTime = 12;
    const diagnostics: unknown[] = [];
    const player = createGeminiOutputAudioPlaybackController(fakeAudioContext as unknown as AudioContext, {
      maxDiagnostics: 2,
      onChunkDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const chunk = Buffer.from([0x00, 0x00, 0x00, 0x00]).toString('base64');

    const played = player.playEvent({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: chunk } },
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: chunk } },
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: chunk } },
          ],
        },
      },
    }, {
      providerReceiveSequence: 7,
      providerRelaySequence: 4,
      providerReceivedAt: '2026-05-20T12:00:00.000Z',
      relayCorrelationId: 'gemini-event-7',
      providerPrimaryCategory: 'serverContent',
      providerCategories: ['serverContent', 'modelTurnAudio'],
    });

    expect(played).toBe(3);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      providerReceiveSequence: 7,
      providerRelaySequence: 4,
      providerReceivedAt: '2026-05-20T12:00:00.000Z',
      relayCorrelationId: 'gemini-event-7',
      chunkIndex: 0,
      chunksInEvent: 3,
      byteLength: 4,
      base64Length: chunk.length,
      duplicateOrdinal: 1,
      audioContextCurrentTime: 12,
      scheduledStartTime: 12,
      scheduled: true,
      playbackGeneration: 0,
      dropReason: null,
      activeSourceCountBefore: 0,
      activeSourceCountAfter: 1,
    });
    expect(diagnostics[1]).toMatchObject({
      chunkIndex: 1,
      duplicateOrdinal: 2,
      scheduledStartTime: 12 + 2 / 24000,
      activeSourceCountBefore: 1,
      activeSourceCountAfter: 2,
      playbackGeneration: 0,
    });
    expect((diagnostics[0] as { chunkHash?: unknown }).chunkHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('reads Gemini audio chunks from camelCase and snake_case modelTurn inlineData parts', () => {
    expect(readGeminiOutputAudioChunks({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }],
        },
      },
    })).toEqual(['AAAA']);
    expect(readGeminiOutputAudioChunks({
      server_content: {
        model_turn: {
          parts: [{ inline_data: { mime_type: 'audio/pcm;rate=24000', data: 'AQABAA==' } }],
        },
      },
    })).toEqual(['AQABAA==']);
  });

  it('categorizes provider events and records compact correlation telemetry', () => {
    const event = {
      responseId: 'provider-response-1',
      serverContent: {
        inputTranscription: { text: 'hello' },
        outputTranscription: { text: 'hi' },
        modelTurn: {
          parts: [
            { text: 'hi' },
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } },
            { functionCall: { id: 'nested-call-1', name: 'emit_artifact', args: emitArtifactArgs } },
          ],
        },
      },
    };

    expect(categorizeGeminiProviderEvent(event)).toEqual([
      'serverContent',
      'inputTranscription',
      'outputTranscription',
      'modelTurnAudio',
      'modelTurnText',
      'toolCall',
    ]);
    expect(readGeminiToolCallsFromEvent(event)).toEqual([
      expect.objectContaining({ id: 'nested-call-1', name: 'emit_artifact' }),
    ]);

    const telemetry = recordGeminiProviderEventTelemetry(
      createGeminiProviderEventCategoryCounts(),
      createGeminiRelayClassificationCounts(),
      event,
      '2026-05-20T00:00:00.000Z',
    );
    expect(telemetry.categoryCounts.serverContent.count).toBe(1);
    expect(telemetry.categoryCounts.toolCall.count).toBe(1);
    expect(telemetry.relayClassification).toBe('critical');
    expect(telemetry.relayClassificationCounts.critical.count).toBe(1);
    expect(telemetry.responseId).toBe('provider-response-1');
    expect(telemetry.toolCallIds).toEqual(['nested-call-1']);
    expect(telemetry.outputAudioChunkCount).toBe(1);
    expect(telemetry.hasInputTranscriptionText).toBe(true);
    expect(telemetry.hasOutputTranscriptionText).toBe(true);
    expect(telemetry.inputTranscriptionTextPreview).toBe('hello');
    expect(telemetry.outputTranscriptionTextPreview).toBe('hi');
  });

  it('treats string-shaped Gemini input transcription as critical provider text', () => {
    const event = { serverContent: { inputTranscription: 'Review this section please.' } };

    expect(categorizeGeminiProviderEvent(event)).toEqual(['serverContent', 'inputTranscription']);
    expect(classifyGeminiProviderEventForRelay(event)).toMatchObject({
      classification: 'critical',
      reason: 'input_transcription_updates_public_user_transcript',
      shouldRelay: true,
    });

    const telemetry = recordGeminiProviderEventTelemetry(
      createGeminiProviderEventCategoryCounts(),
      createGeminiRelayClassificationCounts(),
      event,
      '2026-05-20T00:00:00.000Z',
    );
    expect(telemetry.hasInputTranscriptionText).toBe(true);
    expect(telemetry.inputTranscriptionTextPreview).toBe('Review this section please.');
    expect(telemetry.categoryCounts.inputTranscription.count).toBe(1);
  });

  it('recognizes only meaningful Gemini provider events as relayable', () => {
    expect(isRelayableGeminiProviderEvent({})).toBe(false);
    expect(isRelayableGeminiProviderEvent('')).toBe(false);
    expect(isRelayableGeminiProviderEvent({ serverContent: {} })).toBe(false);
    expect(isRelayableGeminiProviderEvent({ serverContent: { outputTranscription: { text: '' } } })).toBe(false);
    expect(isRelayableGeminiProviderEvent({ setupComplete: {} })).toBe(true);
    expect(isRelayableGeminiProviderEvent({ setup_complete: {} })).toBe(true);
    expect(isRelayableGeminiProviderEvent({ serverContent: { outputTranscription: { text: 'Hi.' } } })).toBe(true);
    expect(isRelayableGeminiProviderEvent({ serverContent: { inputTranscription: 'Hi Sophia.' } })).toBe(true);
    expect(isRelayableGeminiProviderEvent({
      toolCall: {
        functionCalls: [{ id: 'artifact-call-1', name: 'emit_artifact', args: emitArtifactArgs }],
      },
    })).toBe(true);
    expect(readGeminiToolCallsFromEvent({
      toolCall: {
        functionCalls: [{ id: 'artifact-call-1', name: 'emit_artifact', args: emitArtifactArgs }],
      },
    })).toEqual([
      {
        id: 'artifact-call-1',
        name: 'emit_artifact',
        args: emitArtifactArgs,
        argsPreview: emitArtifactArgsPreview,
      },
    ]);
    const memoryToolCalls = readGeminiToolCallsFromEvent({
      toolCall: {
        functionCalls: [
          {
            id: 'memory-call-1',
            name: 'retrieve_memories',
            args: {
              query: 'favorite childhood movie secret phrase',
              user_id: 'model-user-id',
              categories: ['preference'],
            },
          },
        ],
      },
    });
    expect(memoryToolCalls).toEqual([
      {
        id: 'memory-call-1',
        name: 'retrieve_memories',
        args: {
          query_length: 'favorite childhood movie secret phrase'.length,
          query_fingerprint: expect.stringMatching(/^fnv1a32:[a-f0-9]{8}$/),
          raw_query_excluded: true,
          ignored_model_arg_names: ['user_id', 'categories'],
        },
        argsPreview: expect.stringContaining('raw_query_excluded'),
      },
    ]);
    expect(JSON.stringify(memoryToolCalls)).not.toContain('favorite childhood movie secret phrase');
    expect(JSON.stringify(memoryToolCalls)).not.toContain('model-user-id');
    const readArtifactToolCalls = readGeminiToolCallsFromEvent({
      toolCall: {
        functionCalls: [
          {
            id: 'read-artifact-call-1',
            name: 'read_artifact_text',
            args: {
              artifact_id: 'coreview-fixture-q3-launch-review',
              query: 'What exact number is in the table?',
            },
          },
        ],
      },
    });
    expect(readArtifactToolCalls[0]?.args).toMatchObject({
      artifact_id: 'coreview-fixture-q3-launch-review',
      query_length: 'What exact number is in the table?'.length,
      query_fingerprint: expect.stringMatching(/^fnv1a32:[a-f0-9]{8}$/),
      raw_query_excluded: true,
    });
    expect(JSON.stringify(readArtifactToolCalls)).not.toContain('What exact number is in the table?');
    expect(readGeminiConfiguredToolNames({
      tools: [
        { googleSearch: {} },
        {
          functionDeclarations: [
            { name: 'emit_artifact' },
            { name: 'start_builder_task' },
            { name: 'check_async_task' },
          ],
        },
      ],
    })).toEqual(['check_async_task', 'emit_artifact', 'google_search', 'start_builder_task']);
  });

  it('classifies Gemini provider events by backend continuity importance', () => {
    expect(classifyGeminiProviderEventForRelay({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }],
        },
      },
    })).toMatchObject({
      classification: 'skip',
      shouldRelay: false,
      reason: 'pure_output_audio_is_played_locally',
    });
    expect(classifyGeminiProviderEventForRelay({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } })).toMatchObject({
      classification: 'skip',
      shouldRelay: false,
      reason: 'session_resumption_update_is_browser_local_until_resume_is_used',
    });
    expect(classifyGeminiProviderEventForRelay({ usageMetadata: { totalTokenCount: 42 } })).toMatchObject({
      classification: 'summary',
      shouldRelay: false,
    });
    expect(classifyGeminiProviderEventForRelay({ serverContent: { inputTranscription: { text: 'hello' } } })).toMatchObject({
      classification: 'critical',
      shouldRelay: true,
    });
    expect(classifyGeminiProviderEventForRelay({ toolCallCancellation: { ids: ['tool-call-1'] } })).toMatchObject({
      classification: 'critical',
      shouldRelay: true,
    });
    expect(classifyGeminiProviderEventForRelay({
      toolCall: {
        functionCalls: [{ id: 'artifact-call-1', name: 'emit_artifact', args: emitArtifactArgs }],
      },
    })).toMatchObject({
      classification: 'critical',
      shouldRelay: true,
      reason: 'tool_call_requires_backend_execution',
    });
    expect(classifyGeminiProviderEventForRelay({
      toolCall: {
        functionCalls: [{ id: 'builder-call-1', name: 'start_builder_task', args: { description: 'Draft a page.' } }],
      },
    })).toMatchObject({
      classification: 'critical',
      shouldRelay: true,
    });
  });

  it('starts backend dogfood, opens Gemini WSS, waits for setupComplete, relays events, and cleans up', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-1',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              inputAudioTranscription: {},
              tools: [{ functionDeclarations: [{ name: 'emit_artifact' }] }],
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const stoppedTrack = vi.fn();
    const localStream = {
      getTracks: () => [{ stop: stoppedTrack }],
    } as unknown as MediaStream;
    const fakeAudioContext = new FakeAudioContext();
    const stages: GeminiBrowserLiveDogfoodStage[] = [];
    const relayStatuses: GeminiBrowserLiveDogfoodRelayStatus[] = [];
    const providerEvents: unknown[] = [];
    const interruptionDiagnostics: GeminiBrowserLiveDogfoodInterruptionDiagnostic[] = [];
    const staleSuppressionDiagnostics: unknown[] = [];
    const inputAudioDiagnostics: unknown[] = [];
    const handoffDiagnostics: GeminiBargeInTranscriptHandoffDiagnostic[] = [];
    const outputAudioDetected = vi.fn();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'browser-gemini-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => localStream),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onStage: (stage) => stages.push(stage),
      onProviderEvent: (event) => providerEvents.push(event),
      onRelayStatus: (status) => relayStatuses.push(status),
      onOutputAudio: outputAudioDetected,
      onInterruption: (diagnostic) => interruptionDiagnostics.push(diagnostic),
      onStaleOutputSuppression: (diagnostic) => staleSuppressionDiagnostics.push(diagnostic),
      onInputAudioActivity: (diagnostic) => inputAudioDiagnostics.push(diagnostic),
      onBargeInTranscriptHandoff: (diagnostic) => handoffDiagnostics.push(diagnostic),
    });

    expect(connection.sessionId).toBe('browser-gemini-1');
    expect(connection.streamUrl).toBe('/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1');
    expect(connection.websocketUrl).toBe('wss://gemini.example/live?access_token=auth_tokens%2Fgemini-browser-test');
    expect(connection.relayUrl).toBeNull();
    expect(connection.publicEventBoundary).toBeNull();
    expect(connection.transport).toBeNull();
    expect(connection.setupComplete).toBe(true);
    expect(stages).toEqual([
      'starting_backend_session',
      'requesting_microphone',
      'opening_websocket',
      'sending_setup',
      'waiting_setup_complete',
      'connected',
      'streaming_audio',
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/sophia/voice/dogfood/gemini/browser-session',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(websocket?.sent[0]).toBe(JSON.stringify({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        inputAudioTranscription: {},
        tools: [{ functionDeclarations: [{ name: 'emit_artifact' }] }],
      },
    }));
    expect(providerEvents).toEqual([{ setupComplete: {} }]);

    connection.sendText('hello');
    expect(websocket?.sent.at(-1)).toBe(JSON.stringify({ realtimeInput: { text: 'hello' } }));

    fakeAudioContext.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0, 0.25, -0.25, 0.5, -0.5, 0.75]) },
      outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(6) },
    } as unknown as AudioProcessingEvent);

    const audioMessage = JSON.parse(websocket?.sent.at(-1) ?? '{}') as { realtimeInput?: { audio?: { data?: string; mimeType?: string } } };
    expect(audioMessage.realtimeInput?.audio?.mimeType).toBe('audio/pcm;rate=16000');
    expect(typeof audioMessage.realtimeInput?.audio?.data).toBe('string');

    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
    await vi.waitFor(() => expect(relayStatuses).toEqual(['active', 'active']));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/sophia/voice/dogfood/gemini/relay',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/sophia/voice/dogfood/gemini/relay',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    const setupRelayBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    const transcriptRelayBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(setupRelayBody).toMatchObject({
      session_id: 'browser-gemini-1',
      event: { setupComplete: {} },
      provider_receive_sequence: 1,
      provider_relay_sequence: 1,
      provider_primary_category: 'setupComplete',
      provider_categories: ['setupComplete'],
    });
    expect(transcriptRelayBody).toMatchObject({
      session_id: 'browser-gemini-1',
      event: { serverContent: { outputTranscription: { text: 'Hi.' } } },
      provider_receive_sequence: 2,
      provider_relay_sequence: 2,
      provider_primary_category: 'serverContent',
      provider_categories: ['serverContent', 'outputTranscription'],
    });
    expect(typeof setupRelayBody.provider_received_at).toBe('string');
    expect(typeof setupRelayBody.relay_correlation_id).toBe('string');

    websocket?.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAABAA==' } }],
        },
      },
    });
    await vi.waitFor(() => expect(outputAudioDetected).toHaveBeenCalledTimes(1));
    expect(fakeAudioContext.createdSources).toHaveLength(1);
    expect(fakeAudioContext.createdSources[0]?.start).toHaveBeenCalledWith(10);

    fakeAudioContext.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
      outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(4) },
    } as unknown as AudioProcessingEvent);
    expect(fakeAudioContext.createdSources[0]?.stop).not.toHaveBeenCalled();
    expect(inputAudioDiagnostics.at(-1)).toEqual(expect.objectContaining({
      eventType: 'input_audio_frame_sent',
      assistantAudioActive: true,
      bargeInConfirmed: false,
      bargeInCandidateFrameCount: 1,
      suppressionDeferredReason: 'input_frame_only_not_barge_in',
      inputFrameOnlyNotBargeInCount: 1,
    }));
    expect(handoffDiagnostics).toEqual([]);

    const fetchCallsAfterIncidentalFrame = fetchMock.mock.calls.length;
    websocket?.emitMessage({
      responseId: 'gemini-old-response',
      serverContent: {
        responseId: 'gemini-old-response',
        outputTranscription: { text: 'This assistant tail is still valid before confirmed interruption.' },
      },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(fetchCallsAfterIncidentalFrame + 1));
    expect(staleSuppressionDiagnostics).toEqual([]);

    const interruptionEvent = { responseId: 'gemini-old-response', serverContent: { responseId: 'gemini-old-response', interrupted: true } };
    expect(isGeminiServerInterruptedEvent(interruptionEvent)).toBe(true);
    websocket?.emitMessage(interruptionEvent);
    await vi.waitFor(() => expect(interruptionDiagnostics).toHaveLength(1));

    expect(interruptionDiagnostics[0]).toEqual(expect.objectContaining({
      reason: 'server_interrupted',
      playbackFlushed: true,
      playbackStateBefore: expect.objectContaining({ activeSourceCount: 1, playbackGeneration: 0 }),
      playbackStateAfter: { nextPlaybackTime: 0, activeSourceCount: 0, playbackGeneration: 1 },
      playbackGeneration: 1,
      interruptedResponseIds: ['gemini-old-response'],
      bargeInConfirmationSource: 'provider_interruption',
      bargeInConfirmationReason: 'gemini_server_interrupted_event',
    }));
    expect(fakeAudioContext.createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fakeAudioContext.createdSources[0]?.disconnect).toHaveBeenCalledTimes(1);

    const fetchCallsAfterInterruption = fetchMock.mock.calls.length;
    websocket?.emitMessage({
      responseId: 'gemini-old-response',
      serverContent: { responseId: 'gemini-old-response', outputTranscription: { text: 'Done and ready. Old tail.' } },
    });
    await vi.waitFor(() => expect(staleSuppressionDiagnostics).toEqual([
      expect.objectContaining({
        outputType: 'transcript',
        reason: 'interrupted_response_id',
        responseId: 'gemini-old-response',
        playbackGeneration: 1,
        bargeInConfirmationSource: 'provider_interruption',
        staleSuppressionArmedBy: 'provider_interruption',
      }),
    ]));
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallsAfterInterruption);

    expect(connection.flushOutputAudio()).toEqual({ nextPlaybackTime: 0, activeSourceCount: 0, playbackGeneration: 2 });

    await connection.close();

    expect(fakeAudioContext.createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fakeAudioContext.createdSources[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(stoppedTrack).toHaveBeenCalledTimes(1);
    expect(fakeAudioContext.processor.disconnect).toHaveBeenCalledTimes(1);
    expect(fakeAudioContext.source.disconnect).toHaveBeenCalledTimes(1);
    expect(fakeAudioContext.close).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/sophia/voice/dogfood/gemini/disconnect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ session_id: 'browser-gemini-1' }),
        keepalive: true,
      }),
    );
    expect(relayStatuses.at(-1)).toBe('disconnected');
  });

  it('does not send artifact frames while the still-frame flag is off', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: false,
    });
    const sentCountAfterSetup = websocket?.sent.length ?? 0;

    const result = await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    });
    connection.sendText('hello');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('coreview_still_frame_feature_flag_disabled');
    expect(websocket?.sent).toHaveLength(sentCountAfterSetup + 1);
    expect(websocket?.sent.at(-1)).toBe(JSON.stringify({ realtimeInput: { text: 'hello' } }));

    await connection.close();
  });

  it('sends an experimental video artifact frame only when the still-frame flag is on', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    const result = await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      supported: true,
      websocketSendAccepted: true,
      providerAcceptedFrame: false,
      websocketReadyStateBefore: 1,
      websocketReadyStateAfter: 1,
      websocketOpenBeforeSend: true,
      websocketOpenAfterSend: true,
      framePayloadSchemaVersion: 'realtimeInput.video.v1',
      frameBytes: 12,
      frameDimensions: { width: 640, height: 360 },
      mimeType: 'image/jpeg',
      rawFrameExcluded: true,
    }));
    expect(websocket?.sent.at(-1)).toBe(JSON.stringify({
      realtimeInput: {
        video: {
          mimeType: 'image/jpeg',
          data: 'base64-frame',
        },
      },
    }));

    await connection.close();
  });

  it('buffers review-mode audio until matching assistant text is known safe', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    });
    const audioChunk = Buffer.from([0x00, 0x00]).toString('base64');

    websocket?.emitMessage({
      responseId: 'review-safe-response-1',
      serverContent: {
        responseId: 'review-safe-response-1',
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: audioChunk } },
          ],
        },
      },
    });
    await Promise.resolve();
    expect(fakeAudioContext.createdSources).toHaveLength(0);

    websocket?.emitMessage({
      responseId: 'review-safe-response-1',
      serverContent: {
        responseId: 'review-safe-response-1',
        outputTranscription: { text: 'The title is clean and the spacing feels balanced.' },
      },
    });
    await vi.waitFor(() => expect(fakeAudioContext.createdSources).toHaveLength(1));

    await connection.close();
  });

  it('suppresses tool-schema-like assistant output during artifact review before relay or playback', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    });
    const callsAfterFrame = fetchMock.mock.calls.length;
    const audioChunk = Buffer.from([0x00, 0x00]).toString('base64');

    websocket?.emitMessage({
      serverContent: {
        responseId: 'review-leak-response-1',
        modelTurn: {
          parts: [
            { text: 'tool_call_id: review-leak-1 schema' },
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: audioChunk } },
          ],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFrame);
    expect(fakeAudioContext.createdSources).toHaveLength(0);

    await connection.close();
  });

  it('drops buffered review-mode audio when later assistant text is prompt or tool leakage', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    });
    const callsAfterFrame = fetchMock.mock.calls.length;
    const audioChunk = Buffer.from([0x00, 0x00]).toString('base64');

    websocket?.emitMessage({
      responseId: 'review-leak-response-2',
      serverContent: {
        responseId: 'review-leak-response-2',
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: audioChunk } },
          ],
        },
      },
    });
    await Promise.resolve();
    expect(fakeAudioContext.createdSources).toHaveLength(0);

    websocket?.emitMessage({
      responseId: 'review-leak-response-2',
      serverContent: {
        responseId: 'review-leak-response-2',
        outputTranscription: { text: 'artifact_id: artifact-1' },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFrame);
    expect(fakeAudioContext.createdSources).toHaveLength(0);

    await connection.close();
  });

  it('suppresses internal builder recovery language during artifact review', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    });
    const callsAfterFrame = fetchMock.mock.calls.length;
    const audioChunk = Buffer.from([0x00, 0x00]).toString('base64');

    websocket?.emitMessage({
      responseId: 'review-leak-response-recovery',
      serverContent: {
        responseId: 'review-leak-response-recovery',
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: audioChunk } },
          ],
        },
      },
    });
    await Promise.resolve();
    expect(fakeAudioContext.createdSources).toHaveLength(0);

    websocket?.emitMessage({
      responseId: 'review-leak-response-recovery',
      serverContent: {
        responseId: 'review-leak-response-recovery',
        outputTranscription: {
          text: 'I am having a slight issue tracking that specific task, so try listing all the builds.',
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFrame);
    expect(fakeAudioContext.createdSources).toHaveLength(0);

    await connection.close();
  });

  it('returns a safe unavailable result when the Gemini WebSocket is already closed', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    websocket?.emitClose(4000, 'provider rejected previous frame', false);
    const result = await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      supported: true,
      websocketSendAccepted: false,
      websocketReadyStateBefore: 3,
      websocketReadyStateAfter: 3,
      websocketOpenBeforeSend: false,
      websocketOpenAfterSend: false,
      websocketCloseCode: 4000,
      websocketCloseReasonSafe: 'provider rejected previous frame',
      error: 'gemini_live_websocket_not_open',
      rawFrameExcluded: true,
    }));

    await connection.close();
  });

  it('reports frame_send_closed_gemini_websocket when the socket closes after the frame send', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });
    const originalSend = websocket?.send.bind(websocket);
    if (!websocket || !originalSend) throw new Error('test websocket missing');
    websocket.send = (data: string) => {
      originalSend(data);
      if (data.includes('"video"')) {
        queueMicrotask(() => websocket?.emitClose(1007, 'invalid video frame payload', false));
      }
    };

    const result = await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      supported: true,
      websocketSendAccepted: true,
      websocketReadyStateBefore: 1,
      websocketReadyStateAfter: 3,
      websocketOpenBeforeSend: true,
      websocketOpenAfterSend: false,
      websocketCloseCode: 1007,
      websocketCloseReasonSafe: 'invalid video frame payload',
      websocketClosedAfterFrameSend: true,
      error: 'frame_send_closed_gemini_websocket',
      rawFrameExcluded: true,
    }));
    expect(result.timeFromFrameSendToCloseMs).not.toBeNull();
  });

  it('captures usageMetadata image_count after an artifact frame when Gemini emits it', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;
    const providerTelemetry: unknown[] = [];

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
      onProviderEventTelemetry: (telemetry) => providerTelemetry.push(telemetry),
    });
    const originalSend = websocket?.send.bind(websocket);
    if (!websocket || !originalSend) throw new Error('test websocket missing');
    websocket.send = (data: string) => {
      originalSend(data);
      if (data.includes('"video"')) {
        queueMicrotask(() => websocket?.emitMessage({
          usageMetadata: {
            image_count: 1,
            video_duration_seconds: 0.25,
            audio_duration_seconds: 2,
            total_token_count: 123,
          },
        }));
      }
    };

    const result = await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      visualSourceKind: 'canvas_element',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    }, { coreviewSendStage: 'start' });

    expect(result.imageCountAfterFrame).toBe(1);
    expect(result.videoDurationSecondsAfterFrame).toBe(0.25);
    expect(result.audioDurationSecondsAfterFrame).toBe(2);
    expect(result.providerAcceptedFrame).toBe(true);
    expect(result.usageMetadataAfterFrame).toEqual({
      imageCount: 1,
      videoDurationSeconds: 0.25,
      audioDurationSeconds: 2,
      totalTokenCount: 123,
      rawUsageMetadataExcluded: true,
    });
    expect(providerTelemetry.at(-1)).toMatchObject({
      usageMetadata: {
        imageCount: 1,
        videoDurationSeconds: 0.25,
        audioDurationSeconds: 2,
        totalTokenCount: 123,
        rawUsageMetadataExcluded: true,
      },
    });

    await connection.close();
  });

  it('attaches safe artifact review context to relayed tool calls after a confirmed frame', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch();
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    await connection.sendArtifactFrame({
      artifactId: 'artifact-1',
      visualSourceKind: 'canvas_element',
      data: 'base64-frame',
      mimeType: 'image/jpeg',
      byteLength: 12,
      dimensions: { width: 640, height: 360 },
      rawFrameExcluded: true,
    }, { coreviewSendStage: 'start' });
    connection.sendText('Create a new artifact from this.');

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'artifact-call-1', name: 'emit_artifact', args: { takeaway: 'Avoid churn.' } },
        ],
      },
    });

    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    const relayBody = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;

    expect(relayBody).toMatchObject({
      session_id: 'browser-gemini-1',
      artifact_review_context: {
        active: true,
        artifact_id: 'artifact-1',
        source: 'coreview_still_frame',
        user_intent: 'create_update',
        raw_transcript_excluded: true,
        raw_artifact_text_excluded: true,
      },
    });
    expect(JSON.stringify(relayBody.artifact_review_context)).not.toContain('Create a new artifact');

    await connection.close();
  });

  it('keeps multiple raw input frames as candidates without suppressing assistant audio', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-sustained-barge-in',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview' },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-sustained-barge-in',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const fakeAudioContext = new FakeAudioContext();
    const staleSuppressionDiagnostics: unknown[] = [];
    const inputAudioDiagnostics: unknown[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onStaleOutputSuppression: (diagnostic) => staleSuppressionDiagnostics.push(diagnostic),
      onInputAudioActivity: (diagnostic) => inputAudioDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAABAA==' } }],
        },
      },
    });
    await vi.waitFor(() => expect(fakeAudioContext.createdSources).toHaveLength(1));

    for (let index = 0; index < 4; index += 1) {
      fakeAudioContext.processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) },
        outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(4096) },
      } as unknown as AudioProcessingEvent);
    }

    expect(fakeAudioContext.createdSources[0]?.stop).not.toHaveBeenCalled();
    expect(inputAudioDiagnostics.at(-1)).toEqual(expect.objectContaining({
      eventType: 'input_audio_frame_sent',
      assistantAudioActive: true,
      bargeInConfirmed: false,
      bargeInConfirmationSource: 'none',
      bargeInCandidateFrameCount: 4,
      staleSuppressionArmedAt: null,
      suppressionDeferredReason: 'barge_in_confirmation_pending',
      inputFrameOnlyNotBargeInCount: 4,
      candidateFramesDidNotConfirmCount: 4,
      rawAssistantUserOverlapMs: expect.any(Number),
      confirmedAssistantUserOverlapMs: 0,
    }));

    websocket?.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAABAA==' } }],
        },
      },
    });

    await vi.waitFor(() => expect(fakeAudioContext.createdSources).toHaveLength(2));
    expect(staleSuppressionDiagnostics).toEqual([]);

    await connection.close();
  });

  it('confirms provider input transcription without flushing already scheduled assistant audio', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-provider-transcription-barge-in',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-provider-transcription-barge-in',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const fakeAudioContext = new FakeAudioContext();
    const staleSuppressionDiagnostics: unknown[] = [];
    const handoffDiagnostics: GeminiBargeInTranscriptHandoffDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onStaleOutputSuppression: (diagnostic) => staleSuppressionDiagnostics.push(diagnostic),
      onBargeInTranscriptHandoff: (diagnostic) => handoffDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      serverContent: {
        outputTranscription: { text: 'Let me lay this out clearly.' },
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAABAA==' } }],
        },
      },
    });
    await vi.waitFor(() => expect(fakeAudioContext.createdSources).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 380));

    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'Actually pause there' } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/sophia/voice/dogfood/gemini/relay',
      expect.objectContaining({ body: expect.stringContaining('Actually pause there') }),
    ));
    await vi.waitFor(() => expect(handoffDiagnostics).toHaveLength(1));
    expect(handoffDiagnostics[0]).toEqual(expect.objectContaining({
      text: 'Actually pause there',
      transcriptPreview: 'Actually pause there',
      captured: true,
      promoted: true,
      newTurnDispatched: true,
      newTurnDispatchBlockedReason: 'none',
      bargeInTranscriptCapturedCount: 1,
      bargeInTranscriptPromotedCount: 1,
      bargeInNewTurnDispatchCount: 1,
    }));
    expect(websocket?.sent.map((message) => JSON.parse(message))).toContainEqual({
      realtimeInput: { text: 'Actually pause there' },
    });
    expect(fakeAudioContext.createdSources[0]?.stop).not.toHaveBeenCalled();

    const sentCountAfterPromotion = websocket?.sent.length ?? 0;
    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'Actually pause there' } } });
    await vi.waitFor(() => expect(handoffDiagnostics).toHaveLength(2));
    expect(handoffDiagnostics[1]).toEqual(expect.objectContaining({
      captured: true,
      promoted: false,
      duplicateSuppressed: true,
      newTurnDispatched: false,
      bargeInTranscriptDuplicateSuppressedCount: 1,
    }));
    expect(websocket?.sent).toHaveLength(sentCountAfterPromotion);

    websocket?.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAABAA==' } }],
        },
      },
    });

    await vi.waitFor(() => expect(staleSuppressionDiagnostics).toHaveLength(1));
    expect(staleSuppressionDiagnostics).toEqual([
      expect.objectContaining({
        outputType: 'audio',
        reason: 'barge_in_generation_active',
        bargeInConfirmed: true,
        bargeInConfirmationSource: 'provider_input_transcription',
        staleSuppressionArmedBy: 'provider_input_transcription',
        assistantAudioDropReason: 'barge_in_generation_active',
      }),
    ]);
    expect(fakeAudioContext.createdSources).toHaveLength(1);

    await connection.close();
  });

  it('decays unconfirmed input-frame candidates when frames stop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-candidate-decay',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview' },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-candidate-decay',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const fakeAudioContext = new FakeAudioContext();
    const inputAudioDiagnostics: unknown[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onInputAudioActivity: (diagnostic) => inputAudioDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAABAA==' } }],
        },
      },
    });
    await vi.waitFor(() => expect(fakeAudioContext.createdSources).toHaveLength(1));

    const performanceNowSpy = vi.spyOn(performance, 'now');
    try {
      performanceNowSpy.mockReturnValue(0);
      fakeAudioContext.processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) },
        outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(4096) },
      } as unknown as AudioProcessingEvent);
      expect(inputAudioDiagnostics.at(-1)).toEqual(expect.objectContaining({
        bargeInConfirmed: false,
        bargeInCandidateFrameCount: 1,
        suppressionDeferredReason: 'input_frame_only_not_barge_in',
      }));

      performanceNowSpy.mockReturnValue(700);
      fakeAudioContext.processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) },
        outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(4096) },
      } as unknown as AudioProcessingEvent);

      expect(inputAudioDiagnostics.at(-1)).toEqual(expect.objectContaining({
        bargeInConfirmed: false,
        bargeInCandidateFrameCount: 1,
        suppressionDeferredReason: 'input_frame_only_not_barge_in',
        inputFrameOnlyNotBargeInCount: 2,
      }));
      expect(fakeAudioContext.createdSources[0]?.stop).not.toHaveBeenCalled();
    } finally {
      performanceNowSpy.mockRestore();
      await connection.close();
    }
  });

  it('does not POST audio-only events before critical tool and transcription relays', async () => {
    const artifactToolResponse = {
      toolResponse: {
        functionResponses: [
          { id: 'artifact-priority-call', name: 'emit_artifact', response: { ok: true } },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-priority',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', tools: [{ functionDeclarations: [{ name: 'emit_artifact' }] }] },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-priority',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [{ type: 'gemini_tool_response', payload: artifactToolResponse }],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 25; index += 1) {
      websocket?.emitMessage({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }],
          },
        },
      });
    }
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'The important words.' } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/sophia/voice/dogfood/gemini/relay',
      expect.objectContaining({
        body: expect.any(String),
      }),
    );

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [{ id: 'artifact-priority-call', name: 'emit_artifact', args: emitArtifactArgs }],
      },
    });
    await vi.waitFor(() => expect(websocket?.sent).toContain(JSON.stringify(artifactToolResponse)));
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/sophia/voice/dogfood/gemini/relay',
      expect.objectContaining({
        body: expect.any(String),
      }),
    );

    await connection.close();
  });

  it('does not drop raw Gemini outputTranscription fragments while preserving relay sequence numbers', async () => {
    const firstPartialRelay = deferredResponse();
    const relayTraces: unknown[] = [];
    const coalescingDiagnostics: unknown[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-coalescing',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-coalescing',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(() => firstPartialRelay.promise)
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onRelayTrace: (trace) => relayTraces.push(trace),
      onRelayCoalescingDiagnostic: (diagnostic) => coalescingDiagnostics.push(diagnostic),
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    websocket?.emitMessage({ serverContent: { outputTranscription: { text: "You're asking" } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'for a' } } });
    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'deeper' } } });
    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'understanding' } } });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(coalescingDiagnostics).toHaveLength(0);

    firstPartialRelay.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    const firstRelayBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    const secondRelayBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as Record<string, unknown>;
    const thirdRelayBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as Record<string, unknown>;
    const fourthRelayBody = JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body)) as Record<string, unknown>;
    expect(firstRelayBody).toMatchObject({
      provider_receive_sequence: 2,
      provider_relay_sequence: 2,
      event: { serverContent: { outputTranscription: { text: "You're asking" } } },
    });
    expect(secondRelayBody).toMatchObject({
      provider_receive_sequence: 3,
      provider_relay_sequence: 3,
      event: { serverContent: { outputTranscription: { text: 'for a' } } },
    });
    expect(thirdRelayBody).toMatchObject({
      provider_receive_sequence: 4,
      provider_relay_sequence: 4,
      event: { serverContent: { outputTranscription: { text: 'deeper' } } },
    });
    expect(fourthRelayBody).toMatchObject({
      provider_receive_sequence: 5,
      provider_relay_sequence: 5,
      event: { serverContent: { outputTranscription: { text: 'understanding' } } },
    });
    expect(relayTraces.at(-1)).toMatchObject({
      throughput: {
        transcriptPartialsCoalesced: 0,
        transcriptPartialsDropped: 0,
        transcriptPartialsSent: 4,
        transcriptCoalescingDisabledReason: 'provider_output_transcription_is_delta_like',
      },
    });

    await connection.close();
  });

  it('does not skip provider relay sequence after a failed critical relay', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-relay-reuse',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-relay-reuse',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response('transient relay failure', { status: 502 }))
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const failedSetupBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(failedSetupBody).toMatchObject({
      event: { setupComplete: {} },
      provider_relay_sequence: 1,
    });

    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'Can you hear this turn?' } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const inputRelayBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(inputRelayBody).toMatchObject({
      event: { serverContent: { inputTranscription: { text: 'Can you hear this turn?' } } },
      provider_relay_sequence: 1,
      provider_primary_category: 'serverContent',
      provider_categories: ['serverContent', 'inputTranscription'],
    });

    await connection.close();
  });

  it('keeps user transcripts, tools, cancellations, and boundaries non-droppable behind a blocked transcript fragment', async () => {
    const firstPartialRelay = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-critical-events',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-critical-events',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(() => firstPartialRelay.promise)
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'Blocked fragment.' } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'user words' } } });
    websocket?.emitMessage({
      toolCall: {
        functionCalls: [{ id: 'artifact-critical-call', name: 'emit_artifact', args: emitArtifactArgs }],
      },
    });
    websocket?.emitMessage({ toolCallCancellation: { ids: ['artifact-critical-call'] } });
    websocket?.emitMessage({ serverContent: { turnComplete: true } });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    firstPartialRelay.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));

    const queuedBodies = fetchMock.mock.calls.slice(3, 7).map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
    expect(queuedBodies.map((body) => body.provider_relay_sequence)).toEqual([3, 4, 5, 6]);
    expect(queuedBodies[0]).toMatchObject({
      event: { serverContent: { inputTranscription: { text: 'user words' } } },
    });
    expect(queuedBodies[1]).toMatchObject({
      event: {
        toolCall: {
          functionCalls: [{ id: 'artifact-critical-call', name: 'emit_artifact', args: emitArtifactArgs }],
        },
      },
    });
    expect(queuedBodies[2]).toMatchObject({
      event: { toolCallCancellation: { ids: ['artifact-critical-call'] } },
    });
    expect(queuedBodies[3]).toMatchObject({
      event: { serverContent: { turnComplete: true } },
    });

    await connection.close();
  });

  it('never coalesces final assistant transcript boundary events behind pending partials', async () => {
    const firstPartialRelay = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-final-boundary',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-final-boundary',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(() => firstPartialRelay.promise)
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'Partial in flight.' } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'Queued partial.' } } });
    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'Final caption.' }, turnComplete: true } });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    firstPartialRelay.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    const queuedPartialBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as Record<string, unknown>;
    const finalBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as Record<string, unknown>;
    expect(queuedPartialBody).toMatchObject({
      provider_relay_sequence: 3,
      event: { serverContent: { outputTranscription: { text: 'Queued partial.' } } },
    });
    expect(finalBody).toMatchObject({
      provider_relay_sequence: 4,
      event: { serverContent: { outputTranscription: { text: 'Final caption.' }, turnComplete: true } },
    });

    await connection.close();
  });

  it('sends audioStreamEnd and gates microphone frames while Gemini mic is manually muted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-muted',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', tools: [] },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-muted',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const track = { enabled: true, stop: vi.fn() };
    const localStream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const fakeAudioContext = new FakeAudioContext();
    const inputAudioDiagnostics: unknown[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => localStream),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onInputAudioActivity: (diagnostic) => inputAudioDiagnostics.push(diagnostic),
    });

    connection.setMicrophoneMuted(true);
    expect(track.enabled).toBe(false);
    expect(websocket?.sent.at(-1)).toBe(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    expect(inputAudioDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'manual_mute_on', micState: 'muted' }),
      expect.objectContaining({ eventType: 'input_audio_stream_paused', micState: 'muted' }),
      expect.objectContaining({ eventType: 'input_audio_stream_end_sent', audioStreamEndSent: true }),
    ]));
    const sentCountAfterMute = websocket?.sent.length ?? 0;

    fakeAudioContext.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.25, 0.5, -0.5]) },
      outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(4) },
    } as unknown as AudioProcessingEvent);
    expect(websocket?.sent).toHaveLength(sentCountAfterMute);

    connection.setMicrophoneMuted(false);
    expect(track.enabled).toBe(true);
    fakeAudioContext.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.25, 0.5, -0.5]) },
      outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(4) },
    } as unknown as AudioProcessingEvent);

    const audioMessage = JSON.parse(websocket?.sent.at(-1) ?? '{}') as { realtimeInput?: { audio?: { mimeType?: string } } };
    expect(audioMessage.realtimeInput?.audio?.mimeType).toBe('audio/pcm;rate=16000');
    expect(inputAudioDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'manual_mute_off', micState: 'unmuted' }),
      expect.objectContaining({
        eventType: 'input_audio_frame_sent',
        micState: 'unmuted',
        audioFrameSequence: 1,
        framesRepresented: 1,
        frameByteLength: expect.any(Number),
        frameDurationMs: expect.any(Number),
      }),
    ]));
    expect(JSON.stringify(inputAudioDiagnostics)).not.toContain('data');

    await connection.close();
  });

  it('connects from a production bootstrap using production relay and disconnect aliases', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const stoppedTrack = vi.fn();
    const localStream = {
      getTracks: () => [{ stop: stoppedTrack }],
    } as unknown as MediaStream;
    const fakeAudioContext = new FakeAudioContext();
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: 'user-1',
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-prod-1',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/prod-test' },
        setup: { model: 'models/gemini-live', tools: [] },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-1',
        provider_event_relay_url: '/api/sophia/voice/gemini/relay',
        disconnect_url: '/api/sophia/voice/gemini/disconnect',
        public_event_boundary: 'SophiaEventNormalizer',
        transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
      },
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => localStream),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
    });

    expect(connection.sessionId).toBe('gemini-prod-1');
    expect(connection.streamUrl).toBe('/api/sophia/voice/gemini/events?session_id=gemini-prod-1');
    expect(connection.relayUrl).toBe('/api/sophia/voice/gemini/relay');
    expect(connection.publicEventBoundary).toBe('SophiaEventNormalizer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sophia/voice/gemini/relay',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );

    await connection.close();

    expect(stoppedTrack).toHaveBeenCalledTimes(1);
    expect(websocket?.readyState).toBe(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/sophia/voice/gemini/disconnect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ session_id: 'gemini-prod-1' }),
        keepalive: true,
      }),
    );
  });

  it('handles Coreview tool calls in the browser and sends a direct Gemini toolResponse', async () => {
    registerCoreviewToolBridge(async (call) => {
      const pageNumber = Number(call.args.page_number ?? 1);
      const annotation = call.name === 'coreview_add_annotation';
      return {
      ok: true,
      action: annotation ? 'add_annotation' : 'set_view',
      artifact_id: 'coreview-real-artifact-report-pdf',
      artifact_path: 'outputs/report.pdf',
      artifact_title: 'report.pdf',
      renderer_kind: 'pdf',
      page_index: pageNumber - 1,
      page_number: pageNumber,
      page_count: 3,
      zoom: 1,
      fit_mode: 'page',
      view_signature: 'view-signature-after',
      stale: false,
      refresh_attempted: !annotation,
      refresh_result: annotation ? 'not_requested' : 'success',
      blocked_reason: null,
      result_summary: annotation
        ? 'Added a comment to the title on page 1.'
        : 'Switched to page 2 of 3. Refresh succeeded.',
      command_source: 'gemini_tool',
      preserved_mic: true,
      preserved_review: true,
      view_ready_wait_ms: 25,
      view_signature_before: 'view-signature-before',
      view_signature_after: 'view-signature-after',
      exact_text_available: true,
      visual_frame_fresh: true,
      review_active: true,
      annotation_overlay_captured: annotation ? true : false,
      annotation_id: annotation ? 'comment-1' : null,
      annotation_kind: annotation ? 'comment' : null,
      annotation_anchor_type: annotation ? 'current_title' : null,
      annotation_color: annotation ? 'yellow' : null,
      annotation_page_index: annotation ? 0 : null,
      annotation_count: annotation ? 1 : null,
      highlight_count: annotation ? 0 : null,
      comment_count: annotation ? 1 : null,
      annotation_action_source: annotation ? 'sophia' : null,
      focus_anchor_type: null,
      focused_rect: null,
      artifact_stable_identity: 'thread:thread-1|path:outputs/report.pdf|renderer:pdf',
      rebind_status: 'not_attempted',
      rebind_attempted: false,
      rebind_result: 'not_attempted',
      rebind_reason: null,
      raw_comment_text_excluded: true,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
      };
    });
    const fetchMock = makeGeminiBrowserSessionFetch('browser-gemini-coreview-tool');
    const stoppedTrack = vi.fn();
    const localStream = {
      getTracks: () => [{ stop: stoppedTrack }],
    } as unknown as MediaStream;
    const fakeAudioContext = new FakeAudioContext();
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'browser-gemini-coreview-tool',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => localStream),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    expect(readGeminiConfiguredToolNames(connection.setup)).toEqual(expect.arrayContaining([
      'coreview_set_view',
      'coreview_refresh_view',
      'coreview_get_current_view',
      'coreview_add_annotation',
      'coreview_focus_anchor',
      'coreview_request_artifact_update',
      'coreview_cancel_builder_task',
      'coreview_get_builder_status',
    ]));
    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('emit_artifact');
    const fetchCallCountBeforeTool = fetchMock.mock.calls.length;

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'coreview-call-1',
            name: 'coreview_set_view',
            args: {
              page_number: 2,
              reason: 'user asked for page two',
            },
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(websocket?.sent.some((payload) => {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        return Boolean(parsed.toolResponse);
      })).toBe(true);
    });
    const toolResponsePayload = websocket?.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => payload.toolResponse) as {
        toolResponse: {
          functionResponses: Array<{ id: string; name: string; response: Record<string, unknown> }>;
        };
      };

    expect(toolResponsePayload.toolResponse.functionResponses[0]).toMatchObject({
      id: 'coreview-call-1',
      name: 'coreview_set_view',
      response: {
        ok: true,
        page_number: 2,
        refresh_attempted: true,
        refresh_result: 'success',
        raw_artifact_text_excluded: true,
        raw_frame_excluded: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallCountBeforeTool);
    await vi.waitFor(() => expect(toolDiagnostics.some((diagnostic) => (
      diagnostic.phase === 'tool_response_sent'
      && diagnostic.toolCall.name === 'coreview_set_view'
      && diagnostic.backendResponse?.raw_artifact_text_excluded === true
      && diagnostic.backendResponse?.raw_frame_excluded === true
    ))).toBe(true));
    expect(JSON.stringify(toolDiagnostics)).not.toContain('user asked for page two');

    const sentBeforeAnnotation = websocket?.sent.length ?? 0;
    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'coreview-annotation-1',
            name: 'coreview_add_annotation',
            args: {
              kind: 'comment',
              anchor_type: 'current_title',
              comment_text: 'change the font',
            },
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect((websocket?.sent.length ?? 0)).toBeGreaterThan(sentBeforeAnnotation);
      expect(websocket?.sent.slice(sentBeforeAnnotation).some((payload) => {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        return Boolean(parsed.toolResponse);
      })).toBe(true);
    });
    const annotationResponsePayload = websocket?.sent
      .slice(sentBeforeAnnotation)
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => payload.toolResponse) as {
        toolResponse: {
          functionResponses: Array<{ id: string; name: string; response: Record<string, unknown> }>;
        };
      };
    expect(annotationResponsePayload.toolResponse.functionResponses[0]).toMatchObject({
      id: 'coreview-annotation-1',
      name: 'coreview_add_annotation',
      response: {
        ok: true,
        action: 'add_annotation',
        annotation_kind: 'comment',
        annotation_anchor_type: 'current_title',
        raw_artifact_text_excluded: true,
        raw_frame_excluded: true,
      },
    });
    await vi.waitFor(() => expect(toolDiagnostics.some((diagnostic) => (
      diagnostic.phase === 'tool_response_sent'
      && diagnostic.toolCall.name === 'coreview_add_annotation'
      && diagnostic.backendResponse?.raw_comment_text_excluded === true
    ))).toBe(true));
    expect(JSON.stringify(toolDiagnostics)).not.toContain('change the font');

    await connection.close();
  });

  it('resumes an established voice socket after an unexpected provider close', async () => {
    const stages: GeminiBrowserLiveDogfoodStage[] = [];
    const sockets: FakeWebSocket[] = [];
    const continuationUrl = '/api/sophia/voice/gemini/continue';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === continuationUrl) {
        return new Response(JSON.stringify({
          session_id: 'gemini-prod-reconnect',
          websocket_url: 'wss://gemini.example/live-reconnected',
          ephemeral_token: { value: 'auth_tokens/reconnected' },
          setup: {
            model: 'models/gemini-live',
            sessionResumption: {},
          },
          stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-reconnect',
          continuation_bootstrap_url: continuationUrl,
          provider_connection_epoch: 2,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: 'user-1',
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-prod-reconnect',
        websocket_url: 'wss://gemini.example/live-initial',
        ephemeral_token: { value: 'auth_tokens/initial' },
        setup: { model: 'models/gemini-live', sessionResumption: {} },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-reconnect',
        continuation_bootstrap_url: continuationUrl,
        provider_connection_epoch: 1,
      },
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onStage: (stage) => stages.push(stage),
    });

    sockets[0]?.emitMessage({
      sessionResumptionUpdate: {
        resumable: true,
        newHandle: 'safe-handle-1',
      },
    });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    sockets[0]?.emitClose(1011, 'provider transport reset', false);

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => {
      expect(stages.filter((stage) => stage === 'streaming_audio').length).toBeGreaterThanOrEqual(2);
    });
    expect(stages).toContain('reconnecting');
    const reconnectSetup = JSON.parse(sockets[1]?.sent[0] ?? '{}') as {
      setup?: { sessionResumption?: { handle?: string } };
    };
    expect(reconnectSetup.setup?.sessionResumption?.handle).toBe('safe-handle-1');
    const continuationCall = fetchMock.mock.calls.find(([input]) => String(input) === continuationUrl);
    expect(JSON.parse(String((continuationCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      expected_epoch: 1,
      handle_present: true,
      secret_generation: 1,
    });

    await connection.close();
  });

  it('surfaces terminal connection loss instead of leaving the UI speaking forever', async () => {
    const stages: GeminiBrowserLiveDogfoodStage[] = [];
    const relayStatuses: GeminiBrowserLiveDogfoodRelayStatus[] = [];
    let websocket: FakeWebSocket | null = null;
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: 'user-1',
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-prod-no-resume',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/initial' },
        setup: { model: 'models/gemini-live' },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-no-resume',
      },
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 })) as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onStage: (stage) => stages.push(stage),
      onRelayStatus: (status) => relayStatuses.push(status),
    });

    websocket?.emitClose(1006, 'abnormal provider close', false);

    await vi.waitFor(() => expect(stages).toContain('connection_lost'));
    expect(stages).toContain('reconnecting');
    expect(relayStatuses).toContain('terminal_error');
    await connection.close();
  });

  it('exposes Coreview builder actions and suppresses generic builder tools for selected artifact updates', async () => {
    const bridgeCalls: string[] = [];
    registerCoreviewBuilderToolBridge(async (call) => {
      bridgeCalls.push(call.name);
      return {
        ok: true,
        action: call.name,
        result: 'task_started',
        taskId: 'task-coreview-update-1',
        runId: 'run-coreview-update-1',
        userFacingMessage: 'Sophia is updating this artifact.',
        updateMode: 'revise_version',
        rendererKind: 'html',
        requestedChangeSummary: 'make it darker',
        context: {
          workspaceKey: 'user:unknown|thread:thread-1',
          artifactStableIdentity: 'user:unknown|thread:thread-1|path:mnt/user-data/outputs/site.html|renderer:html',
          artifactPath: 'mnt/user-data/outputs/site.html',
          artifactTitle: 'site.html',
          rendererKind: 'html',
          capabilitySummary: {
            rendererKind: 'html',
            renderMode: 'html',
            supportsPages: false,
            supportsPageRail: false,
            currentPage: null,
            pageCount: null,
            supportsTextExtraction: true,
            supportsLayoutAnchors: true,
            supportsAnnotations: true,
            supportsZoom: true,
            supportsPan: false,
            supportsAnnotatedExport: false,
            supportsOCR: false,
            requiresOCR: false,
            supportsPptxNativeRender: false,
            supportsArtifactUpdate: true,
            supportsScopedEdit: true,
            supportsVersioning: true,
            supportsOverwrite: false,
            supportsSourceRead: true,
            supportsNativeEdit: false,
            supportsRebuildFromSource: true,
            requiresFullRebuild: false,
            requiresConversion: false,
            unsupportedUpdateReason: null,
            preferredUpdateMode: 'revise_version',
            fallbackReason: null,
            userFacingTruth: 'HTML preview, zoom, and visual annotations are available in Coreview.',
          },
          currentPage: null,
          pageCount: null,
          viewSignature: 'artifact:site|path:mnt/user-data/outputs/site.html|renderer:html|page:0|zoom:1.00|fit:custom',
          annotationCounts: {
            annotationCount: 0,
            highlightCount: 0,
            commentCount: 0,
            underlineCount: 0,
            arrowCount: 0,
            drawPathCount: 0,
          },
          selectedAnnotationIds: [],
          userUpdateRequest: 'make it darker',
          requestedChangeSummary: 'make it darker',
          updateMode: 'revise_version',
          sourceActor: 'sophia',
          sessionId: 'browser-gemini-coreview-builder-actions',
          threadId: 'thread-1',
          parentThreadId: 'thread-1',
          originalArtifactHref: '/api/threads/thread-1/artifacts/mnt/user-data/outputs/site.html',
          rawArtifactTextExcluded: true,
          rawFrameExcluded: true,
          rawCommentTextExcluded: true,
        },
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
        rawCommentTextExcluded: true,
        preservedMic: true,
        preservedReview: true,
      };
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-coreview-builder-actions',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              inputAudioTranscription: {},
              tools: [{ functionDeclarations: [
                { name: 'emit_artifact' },
                { name: 'start_builder_task' },
                { name: 'edit_builder_artifact' },
                { name: 'check_async_task' },
              ] }],
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-coreview-builder-actions',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'browser-gemini-coreview-builder-actions',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    expect(readGeminiConfiguredToolNames(connection.setup)).toEqual(expect.arrayContaining([
      'coreview_request_artifact_update',
      'coreview_cancel_builder_task',
      'coreview_get_builder_status',
    ]));
    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('emit_artifact');
    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('start_builder_task');
    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('edit_builder_artifact');
    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('check_async_task');

    await connection.sendArtifactFrame({
      artifactId: 'coreview-real-artifact-site-html',
      visualSourceKind: 'html_preview_canvas',
      data: 'AA==',
      mimeType: 'image/png',
      byteLength: 1,
      dimensions: { width: 1, height: 1 },
      rawFrameExcluded: true,
    });
    connection.sendText('make it darker');
    const fetchCallCountBeforeTool = fetchMock.mock.calls.length;

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'coreview-builder-update-1',
            name: 'coreview_request_artifact_update',
            args: { user_update_request: 'make it darker' },
          },
          {
            id: 'generic-builder-bypass-1',
            name: 'start_builder_task',
            args: { description: 'Make a fresh page instead.' },
          },
          {
            id: 'generic-edit-duplicate-1',
            name: 'edit_builder_artifact',
            args: { message: 'Also make the same selected artifact darker.' },
          },
          {
            id: 'emit-artifact-bypass-1',
            name: 'emit_artifact',
            args: emitArtifactArgs,
          },
        ],
      },
    });

    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('coreview_request_artifact_update'));
    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('artifact_review_generic_builder_tool_suppressed'));
    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('already_routed_through_coreview_request_artifact_update'));
    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('emit_artifact_blocked_for_review_update_intent'));
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallCountBeforeTool);
    expect(bridgeCalls).toEqual(['coreview_request_artifact_update']);
    const sentToolResponse = websocket?.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => JSON.stringify(payload).includes('generic-builder-bypass-1')) as {
        toolResponse?: { functionResponses?: Array<{ id?: string; name?: string; response?: Record<string, unknown> }> }
      } | undefined;
    expect(sentToolResponse?.toolResponse?.functionResponses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'coreview-builder-update-1',
        name: 'coreview_request_artifact_update',
        response: expect.objectContaining({
          ok: true,
          result: 'task_started',
          rawArtifactTextExcluded: true,
          rawFrameExcluded: true,
        }),
      }),
      expect.objectContaining({
        id: 'generic-builder-bypass-1',
        name: 'start_builder_task',
        response: expect.objectContaining({
          ok: false,
          rejection_reason: 'artifact_review_generic_builder_tool_suppressed',
        }),
      }),
      expect.objectContaining({
        id: 'generic-edit-duplicate-1',
        name: 'edit_builder_artifact',
        response: expect.objectContaining({
          ok: false,
          generic_async_tool_blocked_reason: 'already_routed_through_coreview_request_artifact_update',
        }),
      }),
      expect.objectContaining({
        id: 'emit-artifact-bypass-1',
        name: 'emit_artifact',
        response: expect.objectContaining({
          ok: false,
          rejection_reason: 'artifact_review_emit_artifact_suppressed',
          emit_artifact_blocked_for_review_update_intent: true,
        }),
      }),
    ]));
    expect(JSON.stringify(toolDiagnostics)).not.toContain('Make a fresh page instead.');

    await connection.close();
  });

  it('routes direct edit_builder_artifact during selected-artifact review through Coreview update state', async () => {
    const bridgeCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    registerCoreviewBuilderToolBridge(async (call) => {
      bridgeCalls.push({ name: call.name, args: call.args });
      return {
        ok: true,
        action: call.name,
        result: 'update_requested',
        userFacingMessage: 'Sophia is updating this artifact.',
        updateMode: 'revise_version',
        rendererKind: 'html',
        requestedChangeSummary: 'change the title card',
        status: {
          phase: 'starting',
          taskId: null,
          runId: null,
          cancellable: false,
          currentStep: 'Applying update...',
        },
        preservedMic: true,
        preservedReview: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
        rawCommentTextExcluded: true,
      };
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-direct-edit-coreview',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              inputAudioTranscription: {},
              tools: [{ functionDeclarations: [{ name: 'edit_builder_artifact' }] }],
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-direct-edit-coreview',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'browser-gemini-direct-edit-coreview',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('edit_builder_artifact');
    await connection.sendArtifactFrame({
      artifactId: 'coreview-real-artifact-site-html',
      visualSourceKind: 'html_preview_canvas',
      data: 'AA==',
      mimeType: 'image/png',
      byteLength: 1,
      dimensions: { width: 1, height: 1 },
      rawFrameExcluded: true,
    });
    const fetchCallCountBeforeTool = fetchMock.mock.calls.length;

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'direct-edit-builder-1',
            name: 'edit_builder_artifact',
            args: {
              message: 'change the title card',
              artifact_path: 'mnt/user-data/outputs/site.html',
            },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('direct-edit-builder-1'));
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallCountBeforeTool);
    expect(bridgeCalls).toEqual([
      {
        name: 'coreview_request_artifact_update',
        args: expect.objectContaining({
          user_update_request: 'change the title card',
          update_mode: 'revise_version',
          source_artifact_path: 'mnt/user-data/outputs/site.html',
          revision_of_artifact_path: 'mnt/user-data/outputs/site.html',
          routed_from_tool: 'edit_builder_artifact',
        }),
      },
    ]);
    const sentToolResponse = websocket?.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => JSON.stringify(payload).includes('direct-edit-builder-1')) as {
        toolResponse?: { functionResponses?: Array<{ id?: string; name?: string; response?: Record<string, unknown> }> }
      } | undefined;
    expect(sentToolResponse?.toolResponse?.functionResponses).toEqual([
      expect.objectContaining({
        id: 'direct-edit-builder-1',
        name: 'edit_builder_artifact',
        response: expect.objectContaining({
          ok: true,
          action: 'coreview_request_artifact_update',
          result: 'update_requested',
          editBuilderArtifactInterceptedByCoreview: true,
          editBuilderArtifactDirectCallResult: 'routed_to_coreview_update',
          coreviewUpdateStateCreatedFromDirectEditTool: true,
          raw_artifact_text_excluded: true,
          raw_frame_excluded: true,
        }),
      }),
    ]);

    await connection.close();
  });

  it('relays direct edit_builder_artifact outside selected-artifact review', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-direct-edit-normal',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              inputAudioTranscription: {},
              tools: [{ functionDeclarations: [{ name: 'edit_builder_artifact' }] }],
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-direct-edit-normal',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'browser-gemini-direct-edit-normal',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });
    const fetchCallCountBeforeTool = fetchMock.mock.calls.length;

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'direct-edit-normal-1',
            name: 'edit_builder_artifact',
            args: { message: 'revise the completed report' },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchCallCountBeforeTool));
    const relayedToolCall = fetchMock.mock.calls
      .slice(fetchCallCountBeforeTool)
      .some((call) => String((call[1] as RequestInit | undefined)?.body ?? '').includes('direct-edit-normal-1'));
    expect(relayedToolCall).toBe(true);
    expect(JSON.stringify(websocket?.sent)).not.toContain('editBuilderArtifactInterceptedByCoreview');

    await connection.close();
  });

  it('blocks generic update_async_task during selected-artifact review when public transcript is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-coreview-update-redirect',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              inputAudioTranscription: {},
              tools: [{ functionDeclarations: [
                { name: 'update_async_task' },
                { name: 'emit_artifact' },
              ] }],
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-coreview-update-redirect',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'browser-gemini-coreview-update-redirect',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('update_async_task');
    expect(readGeminiConfiguredToolNames(connection.setup)).toContain('coreview_request_artifact_update');

    await connection.sendArtifactFrame({
      artifactId: 'coreview-real-artifact-site-html',
      visualSourceKind: 'html_preview_canvas',
      data: 'AA==',
      mimeType: 'image/png',
      byteLength: 1,
      dimensions: { width: 1, height: 1 },
      rawFrameExcluded: true,
    });
    const fetchCallCountBeforeTool = fetchMock.mock.calls.length;

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'generic-update-without-public-transcript',
            name: 'update_async_task',
            args: { task_id: 'missing-task', message: 'change the title' },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('artifact_review_generic_builder_tool_suppressed'));
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallCountBeforeTool);
    const sentToolResponse = websocket?.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => JSON.stringify(payload).includes('generic-update-without-public-transcript')) as {
        toolResponse?: { functionResponses?: Array<{ id?: string; name?: string; response?: Record<string, unknown> }> }
      } | undefined;
    expect(sentToolResponse?.toolResponse?.functionResponses?.[0]).toMatchObject({
      id: 'generic-update-without-public-transcript',
      name: 'update_async_task',
      response: {
        ok: false,
        rejection_reason: 'artifact_review_generic_builder_tool_suppressed',
        recovery_guidance: expect.stringContaining('Use coreview_request_artifact_update'),
        coreview_builder_update_intent_detected: false,
        selected_artifact_update_context: true,
        generic_async_tool_responded_safely: true,
        htmlNavigationBlockedGenericToolCount: 1,
      },
    });
    expect(sentToolResponse?.toolResponse?.functionResponses?.[0]?.response?.recovery_guidance).toEqual(
      expect.stringContaining('Do not expose internal ids'),
    );
    await vi.waitFor(() => expect(toolDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'tool_response_sent',
        toolCall: expect.objectContaining({ name: 'update_async_task' }),
        rejectionReason: 'artifact_review_generic_builder_tool_suppressed',
      }),
    ])));

    await connection.close();
  });

  it('redirects placeholder check_async_task to Coreview status during selected-artifact review', async () => {
    const bridgeCalls: string[] = [];
    registerCoreviewBuilderToolBridge(async (call) => {
      bridgeCalls.push(call.name);
      return {
        ok: true,
        action: call.name,
        result: 'no_active_builder_task',
        blockedReason: 'no_active_builder_task',
        userFacingMessage: "I don't see an active artifact update right now.",
        status: {
          phase: 'idle',
          taskId: null,
          runId: null,
          cancellable: false,
          currentStep: null,
        },
        preservedMic: true,
        preservedReview: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
        rawCommentTextExcluded: true,
      };
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-coreview-check-redirect',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              inputAudioTranscription: {},
              tools: [{ functionDeclarations: [{ name: 'check_async_task' }] }],
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-coreview-check-redirect',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    const ledgerUpdates: Array<{ toolCallId: string; finalState: string }> = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'browser-gemini-coreview-check-redirect',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
      onToolCallLedgerUpdate: (entry) => ledgerUpdates.push({
        toolCallId: entry.toolCallId,
        finalState: entry.finalState,
      }),
    });

    expect(readGeminiConfiguredToolNames(connection.setup)).toContain('coreview_get_builder_status');
    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('check_async_task');

    await connection.sendArtifactFrame({
      artifactId: 'coreview-real-artifact-site-html',
      visualSourceKind: 'html_preview_canvas',
      data: 'AA==',
      mimeType: 'image/png',
      byteLength: 1,
      dimensions: { width: 1, height: 1 },
      rawFrameExcluded: true,
    });
    const fetchCallCountBeforeTool = fetchMock.mock.calls.length;

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'generic-check-placeholder',
            name: 'check_async_task',
            args: { task_id: 'builder-thread-id' },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('generic-check-placeholder'));
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallCountBeforeTool);
    expect(bridgeCalls).toEqual(['coreview_get_builder_status']);
    const sentFunctionResponses = (websocket?.sent ?? [])
      .flatMap((payload) => {
        const parsed = JSON.parse(payload) as {
          toolResponse?: { functionResponses?: Array<{ id?: string; name?: string; response?: Record<string, unknown> }> };
        };
        return parsed.toolResponse?.functionResponses ?? [];
      })
      .filter((response) => response.id === 'generic-check-placeholder');

    expect(sentFunctionResponses).toHaveLength(1);
    expect(sentFunctionResponses[0]).toMatchObject({
      id: 'generic-check-placeholder',
      name: 'check_async_task',
      response: {
        ok: true,
        action: 'coreview_get_builder_status',
        result: 'no_active_builder_task',
        blockedReason: 'no_active_builder_task',
        coreview_control_plane_tool: 'coreview_get_builder_status',
        userFacingMessage: "I don't see an active artifact update right now.",
        genericAsyncToolBlockedReason: 'use_coreview_get_builder_status',
        genericAsyncToolRespondedSafely: true,
      },
    });
    expect(JSON.stringify(sentFunctionResponses[0]?.response)).not.toContain('builder-thread-id');
    expect(JSON.stringify(sentFunctionResponses[0]?.response)).not.toMatch(/task id|tracking that specific task|listing all/i);

    await vi.waitFor(() => expect(toolDiagnostics.filter((diagnostic) => (
      diagnostic.phase === 'tool_response_sent'
      && diagnostic.toolCall.name === 'check_async_task'
    ))).toHaveLength(1));
    expect(Object.fromEntries(ledgerUpdates.map((entry) => [entry.toolCallId, entry.finalState]))).toMatchObject({
      'generic-check-placeholder': 'responded',
    });
    expect(JSON.stringify(toolDiagnostics)).not.toContain('builder-thread-id');

    await connection.close();
  });

  it('dispatches provider input transcripts as follow-up turns after Coreview tool responses', async () => {
    registerCoreviewToolBridge(async (call) => ({
      ok: true,
      action: 'set_view',
      artifact_id: 'coreview-real-artifact-report-pdf',
      artifact_path: 'outputs/report.pdf',
      artifact_title: 'report.pdf',
      renderer_kind: 'pdf',
      page_index: Number(call.args.page_number) - 1,
      page_number: Number(call.args.page_number),
      page_count: 3,
      zoom: 1,
      fit_mode: 'page',
      view_signature: 'view-signature-after',
      stale: false,
      refresh_attempted: true,
      refresh_result: 'success',
      blocked_reason: null,
      result_summary: 'Switched to page 2 of 3. Refresh succeeded.',
      command_source: 'gemini_tool',
      preserved_mic: true,
      preserved_review: true,
      view_ready_wait_ms: 25,
      view_signature_before: 'view-signature-before',
      view_signature_after: 'view-signature-after',
      exact_text_available: true,
      visual_frame_fresh: true,
      visual_fresh: true,
      review_active: true,
      annotation_overlay_captured: false,
      artifact_stable_identity: 'thread:thread-1|path:outputs/report.pdf|renderer:pdf',
      rebind_status: 'not_attempted',
      rebind_attempted: false,
      rebind_result: 'not_attempted',
      rebind_reason: null,
      raw_comment_text_excluded: true,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    }));
    const fetchMock = makeGeminiBrowserSessionFetch('browser-gemini-coreview-follow-up');
    const handoffDiagnostics: GeminiBargeInTranscriptHandoffDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'browser-gemini-coreview-follow-up',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
      onBargeInTranscriptHandoff: (diagnostic) => handoffDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'coreview-call-follow-up',
            name: 'coreview_set_view',
            args: { page_number: 2 },
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(websocket?.sent.some((payload) => Boolean((JSON.parse(payload) as Record<string, unknown>).toolResponse))).toBe(true);
    });

    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'What do you see now' } } });

    await vi.waitFor(() => expect(handoffDiagnostics).toHaveLength(1));
    expect(handoffDiagnostics[0]).toEqual(expect.objectContaining({
      text: 'What do you see now',
      captured: true,
      promoted: true,
      newTurnDispatched: true,
      newTurnDispatchBlockedReason: 'none',
      bargeInConfirmationSource: 'coreview_tool_follow_up',
      bargeInConfirmationReason: 'provider_input_transcription_after_coreview_tool',
    }));
    expect(websocket?.sent.map((message) => JSON.parse(message))).toContainEqual({
      realtimeInput: { text: 'What do you see now' },
    });

    const sentCountAfterPromotion = websocket?.sent.length ?? 0;
    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'What do you see now' } } });
    await vi.waitFor(() => expect(handoffDiagnostics).toHaveLength(2));
    expect(handoffDiagnostics[1]).toEqual(expect.objectContaining({
      captured: true,
      promoted: false,
      duplicateSuppressed: true,
      newTurnDispatched: false,
    }));
    expect(websocket?.sent).toHaveLength(sentCountAfterPromotion);

    await connection.close();
  });

  it('relays Gemini toolCall messages and sends backend toolResponse actions over the existing WebSocket', async () => {
    const toolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'artifact-call-1',
            name: 'emit_artifact',
            response: {
              ok: true,
              backend_tool_result: 'Artifact recorded.',
              result_summary: 'Artifact recorded.',
              artifact_recorded: true,
            },
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-tool-loop',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              tools: [{ functionDeclarations: [{ name: 'emit_artifact' }] }],
              inputAudioTranscription: {},
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-tool-loop',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: toolResponsePayload,
                result_summary: 'Existing Sophia emit_artifact tool executed.',
              },
            ],
            tool_diagnostics: [
              {
                id: 'artifact-call-1',
                name: 'emit_artifact',
                success: true,
                result_summary: 'Existing Sophia emit_artifact tool executed.',
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    const relayDiagnostics: GeminiBrowserLiveDogfoodRelayDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
      onRelayDiagnostic: (diagnostic) => relayDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'artifact-call-1',
            name: 'emit_artifact',
            args: emitArtifactArgs,
          },
        ],
      },
    });

    await vi.waitFor(() => expect(websocket?.sent).toContain(JSON.stringify(toolResponsePayload)));
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/sophia/voice/dogfood/gemini/relay',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    expect(toolDiagnostics.map((diagnostic) => diagnostic.phase)).toEqual([
      'tool_call_received',
      'backend_accepted_tool_call',
      'tool_response_sent',
    ]);
    expect(toolDiagnostics[0]?.toolCall).toMatchObject({
      id: 'artifact-call-1',
      name: 'emit_artifact',
      argsPreview: emitArtifactArgsPreview,
    });
    expect(toolDiagnostics[2]?.resultSummary).toBe('Artifact recorded.');
    expect(toolDiagnostics[2]?.backendResponse).toMatchObject({ artifact_recorded: true });
    expect(relayDiagnostics).toEqual([]);

    await connection.close();
  });

  it('redacts retrieve_memories diagnostics while sending the raw toolResponse back to Gemini', async () => {
    const rawMemoryText = 'Luis said his favorite childhood movie was The Lord of the Rings.';
    const rawQuery = 'favorite childhood movie lord rings';
    const memoryResponse = {
      ok: true,
      status: 'success',
      count: 1,
      memories: [
        {
          text: rawMemoryText,
          category: 'preference',
          source: 'long_term_memory',
        },
      ],
      diagnostics: {
        schema: 'realtime_retrieve_memories_diagnostics_v1',
        tool: 'retrieve_memories',
        status: 'success',
        count: 1,
        has_results: true,
        query_length: rawQuery.length,
        query_fingerprint: 'sha256:query1234567890',
        query_term_count: 5,
        raw_query_excluded: true,
        provider_status: 'available',
        provider_reason: 'sdk_client',
        result_categories: ['preference'],
        result_text_lengths: [rawMemoryText.length],
        result_fingerprints: [
          {
            rank: 1,
            text_fingerprint: 'sha256:memory123456789',
            text_length: rawMemoryText.length,
            query_terms_matched_count: 5,
            query_term_count: 5,
            exact_query_terms_present: true,
            category: 'preference',
            unsafe_preview: rawMemoryText,
          },
        ],
        result_preview_included: false,
        raw_memory_text_excluded: true,
        max_query_terms_matched_count: 5,
        any_result_exact_query_terms_present: true,
        unsafe_preview: rawMemoryText,
      },
    };
    const toolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'memory-call-1',
            name: 'retrieve_memories',
            response: memoryResponse,
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-memory-tool-loop',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              tools: [{ functionDeclarations: [{ name: 'retrieve_memories' }] }],
              inputAudioTranscription: {},
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-memory-tool-loop',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: toolResponsePayload,
                result_summary: 'retrieve_memories returned success with 1 snippet(s).',
              },
            ],
            tool_diagnostics: [
              {
                id: 'memory-call-1',
                name: 'retrieve_memories',
                success: true,
                result_summary: 'retrieve_memories returned success with 1 snippet(s).',
                response: memoryResponse,
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'memory-call-1',
            name: 'retrieve_memories',
            args: { query: rawQuery, user_id: 'model-user-id' },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(websocket?.sent).toContain(JSON.stringify(toolResponsePayload)));

    const serializedDiagnostics = JSON.stringify(toolDiagnostics);
    const backendAccepted = toolDiagnostics.find((diagnostic) => diagnostic.phase === 'backend_accepted_tool_call');
    const responseSent = toolDiagnostics.find((diagnostic) => diagnostic.phase === 'tool_response_sent');

    expect(JSON.stringify(websocket?.sent)).toContain(rawMemoryText);
    expect(serializedDiagnostics).not.toContain(rawMemoryText);
    expect(serializedDiagnostics).not.toContain(rawQuery);
    expect(serializedDiagnostics).not.toContain('model-user-id');
    expect(backendAccepted?.backendResponse).toMatchObject({
      status: 'success',
      count: 1,
      raw_memory_text_excluded: true,
      raw_query_excluded: true,
      diagnostics: {
        result_fingerprints: [
          {
            rank: 1,
            text_fingerprint: 'sha256:memory123456789',
            text_length: rawMemoryText.length,
            query_terms_matched_count: 5,
            query_term_count: 5,
            exact_query_terms_present: true,
            category: 'preference',
          },
        ],
      },
    });
    expect(responseSent?.resultSummary).toBe('retrieve_memories returned success with 1 snippet(s).');
    expect(responseSent?.backendResponse).toMatchObject({
      has_results: true,
      diagnostics: {
        query_fingerprint: 'sha256:query1234567890',
        result_preview_included: false,
      },
    });

    await connection.close();
  });

  it('fills read_artifact_text from the trusted sideband and redacts raw artifact text telemetry', async () => {
    const rawArtifactText = 'Title: Launch brief overview\nFile count: 2\nBudget delta: 17.4%';
    registerCoreviewArtifactText({
      artifactId: 'coreview-real-artifact-launch-brief',
      source: 'builder_metadata',
      text: rawArtifactText,
      sessionIds: ['browser-gemini-read-text-loop'],
      threadId: 'thread-1',
    });
    const backendUnavailableResponse = {
      ok: false,
      artifact_id: 'coreview-real-artifact-launch-brief',
      status: 'unsupported',
      safe_reason: 'Backend reader has metadata only through the app sideband.',
    };
    const toolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'read-artifact-call-1',
            name: 'read_artifact_text',
            response: backendUnavailableResponse,
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-read-text-loop',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              tools: [{ functionDeclarations: [{ name: 'read_artifact_text' }] }],
              inputAudioTranscription: {},
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-read-text-loop',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: toolResponsePayload,
                result_summary: 'read_artifact_text returned unsupported.',
              },
            ],
            tool_diagnostics: [
              {
                id: 'read-artifact-call-1',
                name: 'read_artifact_text',
                success: false,
                result_summary: 'read_artifact_text returned unsupported.',
                response: {
                  ...backendUnavailableResponse,
                  raw_artifact_text_excluded: true,
                },
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'read-artifact-call-1',
            name: 'read_artifact_text',
            args: {
              artifact_id: 'coreview-real-artifact-launch-brief',
              query: 'What exact budget delta is shown?',
            },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('Budget delta: 17.4%'));

    const serializedDiagnostics = JSON.stringify(toolDiagnostics);
    const responseSent = toolDiagnostics.find((diagnostic) => diagnostic.phase === 'tool_response_sent');

    expect(serializedDiagnostics).not.toContain(rawArtifactText);
    expect(serializedDiagnostics).not.toContain('Budget delta: 17.4%');
    expect(serializedDiagnostics).not.toContain('What exact budget delta is shown?');
    expect(responseSent?.resultSummary).toBe(`read_artifact_text returned builder_metadata text (${rawArtifactText.length} chars).`);
    expect(responseSent?.backendResponse).toEqual({
      ok: true,
      artifact_id: 'coreview-real-artifact-launch-brief',
      source: 'builder_metadata',
      char_count: rawArtifactText.length,
      page_count: null,
      truncated: false,
      status: 'success',
      safe_reason: null,
      latency_ms: expect.any(Number),
      review_tool_timed_out: false,
      review_tool_timeout_name: null,
      review_tool_timeout_result_sent: false,
      raw_artifact_text_excluded: true,
    });

    await connection.close();
  });

  it('allows read_artifact_text for an old registration when the current thread matches', async () => {
    registerCoreviewArtifactText({
      artifactId: 'coreview-real-artifact-resumed-pdf',
      source: 'pdf_text_extraction',
      text: 'North equals 42',
      sessionIds: ['old-voice-session'],
      threadId: 'thread-1',
    });
    const fetchMock = makeGeminiBrowserSessionFetch('new-voice-session');
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      sessionId: 'new-voice-session',
      threadId: 'thread-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'read-resumed-visible-pdf',
            name: 'read_artifact_text',
            args: { artifact_id: 'coreview-real-artifact-resumed-pdf' },
          },
        ],
      },
    });

    await vi.waitFor(() => {
      const responses = websocket?.sent
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .flatMap((payload) => {
          const toolResponse = payload.toolResponse as { functionResponses?: Array<{ id: string; response: Record<string, unknown> }> } | undefined;
          return toolResponse?.functionResponses ?? [];
        });
      expect(responses).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'read-resumed-visible-pdf',
          response: expect.objectContaining({
            ok: true,
            source: 'pdf_text_extraction',
            text: 'North equals 42',
          }),
        }),
      ]));
    });

    await connection.close();
  });

  it('resolves read_artifact_text pending, failed, and missing-artifact states without backend relay', async () => {
    registerCoreviewArtifactTextStatus({
      artifactId: 'coreview-real-artifact-pending-pdf',
      source: 'pdf_text_extraction',
      status: 'loading',
      sessionIds: ['browser-gemini-read-statuses'],
      threadId: 'thread-1',
    });
    registerCoreviewArtifactTextStatus({
      artifactId: 'coreview-real-artifact-failed-pdf',
      source: 'pdf_text_extraction',
      status: 'failed',
      safeReason: 'pdf_text_extraction_failed',
      sessionIds: ['browser-gemini-read-statuses'],
      threadId: 'thread-1',
    });
    const fetchMock = makeGeminiBrowserSessionFetch('browser-gemini-read-statuses');
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    const ledgerUpdates: Array<{ toolCallId: string; finalState: string }> = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
      onToolCallLedgerUpdate: (entry) => ledgerUpdates.push({
        toolCallId: entry.toolCallId,
        finalState: entry.finalState,
      }),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'read-pending',
            name: 'read_artifact_text',
            args: { artifact_id: 'coreview-real-artifact-pending-pdf', query: 'heading' },
          },
          {
            id: 'read-failed',
            name: 'read_artifact_text',
            args: { artifact_id: 'coreview-real-artifact-failed-pdf', query: 'heading' },
          },
          {
            id: 'read-missing-selected',
            name: 'read_artifact_text',
            args: { query: 'heading' },
          },
        ],
      },
    });

    await vi.waitFor(() => {
      const responses = websocket?.sent
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .flatMap((payload) => {
          const toolResponse = payload.toolResponse as { functionResponses?: Array<{ id: string; response: Record<string, unknown> }> } | undefined;
          return toolResponse?.functionResponses ?? [];
        });
      expect(responses).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'read-pending', response: expect.objectContaining({ status: 'extraction_pending' }) }),
        expect.objectContaining({ id: 'read-failed', response: expect.objectContaining({ status: 'extraction_failed' }) }),
        expect.objectContaining({ id: 'read-missing-selected', response: expect.objectContaining({ status: 'no_selected_artifact' }) }),
      ]));
    });
    const relayBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/api/sophia/voice/dogfood/gemini/relay'))
      .map((call) => String((call[1] as RequestInit | undefined)?.body ?? ''));
    expect(relayBodies.join('\n')).not.toContain('read_artifact_text');
    expect(Object.fromEntries(ledgerUpdates.map((entry) => [entry.toolCallId, entry.finalState]))).toMatchObject({
      'read-pending': 'responded',
      'read-failed': 'responded',
      'read-missing-selected': 'responded',
    });
    expect(toolDiagnostics.filter((diagnostic) => diagnostic.phase === 'tool_response_sent' && diagnostic.toolCall.name === 'read_artifact_text')).toHaveLength(3);

    await connection.close();
  });

  it('resolves read_artifact_text locally while browser blocks emit_artifact in a mixed review batch', async () => {
    registerCoreviewArtifactText({
      artifactId: 'coreview-real-artifact-launch-brief',
      source: 'pdf_text_extraction',
      text: 'Launch brief\nBudget delta: 17.4%',
      sessionIds: ['browser-gemini-mixed-review-tools'],
      threadId: 'thread-1',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-mixed-review-tools',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              inputAudioTranscription: {},
              tools: [{ functionDeclarations: [{ name: 'emit_artifact' }, { name: 'read_artifact_text' }] }],
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-mixed-review-tools',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;
    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    expect(readGeminiConfiguredToolNames(connection.setup)).not.toContain('emit_artifact');
    await connection.sendArtifactFrame({
      artifactId: 'coreview-real-artifact-launch-brief',
      visualSourceKind: 'pdf_page_canvas',
      data: 'AA==',
      mimeType: 'image/png',
      byteLength: 1,
      dimensions: { width: 1, height: 1 },
      rawFrameExcluded: true,
    });
    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'artifact-call-blocked', name: 'emit_artifact', args: emitArtifactArgs },
          {
            id: 'read-artifact-local',
            name: 'read_artifact_text',
            args: { artifact_id: 'coreview-real-artifact-launch-brief', query: 'budget delta' },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('Budget delta: 17.4%'));
    await vi.waitFor(() => expect(JSON.stringify(websocket?.sent)).toContain('artifact_review_emit_artifact_suppressed'));
    const relayCall = fetchMock.mock.calls.find((call) => (
      String(call[0]).includes('/api/sophia/voice/dogfood/gemini/relay')
      && String((call[1] as RequestInit | undefined)?.body ?? '').includes('emit_artifact')
    ));
    expect(relayCall).toBeUndefined();
    const sentToolResponse = websocket?.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => JSON.stringify(payload).includes('artifact-call-blocked')) as {
        toolResponse?: { functionResponses?: Array<{ id?: string; name?: string; response?: Record<string, unknown> }> }
      } | undefined;
    expect(sentToolResponse?.toolResponse?.functionResponses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'artifact-call-blocked',
        name: 'emit_artifact',
        response: expect.objectContaining({
          ok: false,
          rejection_reason: 'artifact_review_emit_artifact_suppressed',
          emit_artifact_blocked_for_annotation_intent: true,
        }),
      }),
      expect.objectContaining({
        id: 'read-artifact-local',
        name: 'read_artifact_text',
      }),
    ]));
    expect(toolDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'tool_execution_rejected',
        toolCall: expect.objectContaining({ name: 'emit_artifact' }),
        rejectionReason: 'artifact_review_emit_artifact_suppressed',
      }),
      expect.objectContaining({
        phase: 'tool_response_sent',
        toolCall: expect.objectContaining({ name: 'emit_artifact' }),
        success: false,
      }),
    ]));

    await connection.close();
  });

  it('sends a safe timeout result for a hung Coreview review tool and marks the call resolved', async () => {
    registerCoreviewToolBridge(() => new Promise<never>(() => undefined));
    const fetchMock = makeGeminiBrowserSessionFetch('browser-gemini-coreview-timeout');
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    const ledgerUpdates: Array<{ toolCallId: string; finalState: string }> = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      coreviewStillFrameEnabled: true,
      reviewToolTimeoutMs: 25,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
      onToolCallLedgerUpdate: (entry) => ledgerUpdates.push({
        toolCallId: entry.toolCallId,
        finalState: entry.finalState,
      }),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'coreview-timeout-call', name: 'coreview_get_current_view', args: {} },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(JSON.stringify(websocket?.sent)).toContain('review_tool_timeout_result_sent');
    });
    const responseSent = toolDiagnostics.find((diagnostic) => (
      diagnostic.phase === 'tool_response_sent'
      && diagnostic.toolCall.name === 'coreview_get_current_view'
    ));
    expect(responseSent).toMatchObject({
      reviewToolTimedOut: true,
      reviewToolTimeoutName: 'coreview_get_current_view',
      reviewToolTimeoutResultSent: true,
      backendResponse: expect.objectContaining({
        review_tool_timed_out: true,
        review_tool_timeout_result_sent: true,
        raw_frame_excluded: true,
      }),
    });
    expect(ledgerUpdates.find((entry) => entry.toolCallId === 'coreview-timeout-call' && entry.finalState === 'responded')).toBeTruthy();
    expect(Object.fromEntries(ledgerUpdates.map((entry) => [entry.toolCallId, entry.finalState]))).toMatchObject({
      'coreview-timeout-call': 'responded',
    });

    await connection.close();
  });

  it('suppresses stale toolResponse send-back when Gemini cancels the tool call first', async () => {
    const toolRelay = deferredResponse();
    const toolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'artifact-call-cancelled',
            name: 'emit_artifact',
            response: {
              ok: true,
              result_summary: 'Artifact recorded after cancellation.',
            },
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-cancelled-tool-loop',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              tools: [{ functionDeclarations: [{ name: 'emit_artifact' }] }],
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-cancelled-tool-loop',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(() => toolRelay.promise)
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'artifact-call-cancelled', name: 'emit_artifact', args: emitArtifactArgs },
        ],
      },
    });
    websocket?.emitMessage({ toolCallCancellation: { ids: ['artifact-call-cancelled'] } });
    toolRelay.resolve(new Response(
      JSON.stringify({
        accepted: true,
        client_actions: [
          {
            type: 'gemini_tool_response',
            payload: toolResponsePayload,
            result_summary: 'Existing Sophia emit_artifact tool executed.',
          },
        ],
      }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    ));

    await vi.waitFor(() => expect(toolDiagnostics.map((diagnostic) => diagnostic.phase)).toContain('tool_response_send_suppressed'));
    expect(websocket?.sent).not.toContain(JSON.stringify(toolResponsePayload));
    expect(toolDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'tool_call_cancelled' }),
      expect.objectContaining({
        phase: 'tool_response_send_suppressed',
        suppressionReason: 'cancelled_before_tool_response_send',
      }),
    ]));

    await connection.close();
  });

  it('propagates builder task id and status from backend diagnostics and toolResponse payloads', async () => {
    const toolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'builder-call-1',
            name: 'start_builder_task',
            response: {
              ok: true,
              task_id: 'builder-thread-1',
              status: 'running',
              result_summary: 'Launched builder task. task_id: builder-thread-1.',
            },
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-builder-tool-loop',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              tools: [{ functionDeclarations: [{ name: 'start_builder_task' }] }],
              inputAudioTranscription: {},
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-builder-tool-loop',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: toolResponsePayload,
                result_summary: 'Existing Sophia builder task launched: builder-thread-1.',
              },
            ],
            tool_diagnostics: [
              {
                id: 'builder-call-1',
                name: 'start_builder_task',
                success: true,
                task_id: 'builder-thread-1',
                task_status: 'running',
                result_summary: 'Existing Sophia builder task launched: builder-thread-1.',
                response: {
                  ok: true,
                  task_id: 'builder-thread-1',
                  status: 'running',
                  result_summary: 'Launched builder task. task_id: builder-thread-1.',
                },
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'builder-call-1',
            name: 'start_builder_task',
            args: { description: 'Make a one-page document.', task_type: 'document' },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(websocket?.sent).toContain(JSON.stringify(toolResponsePayload)));
    expect(toolDiagnostics[1]).toMatchObject({
      phase: 'backend_accepted_tool_call',
      taskId: 'builder-thread-1',
      taskStatus: 'running',
      backendResponse: { task_id: 'builder-thread-1', status: 'running' },
    });
    expect(toolDiagnostics[2]).toMatchObject({
      phase: 'tool_response_sent',
      taskId: 'builder-thread-1',
      taskStatus: 'running',
      resultSummary: 'Launched builder task. task_id: builder-thread-1.',
    });

    await connection.close();
  });

  it('sends update, list, and cancel lifecycle toolResponses over the active Gemini WebSocket', async () => {
    const updateToolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'update-call-1',
            name: 'update_async_task',
            response: {
              ok: true,
              task_id: 'builder-thread-1',
              status: 'running',
              result_summary: 'Updated builder task. task_id: builder-thread-1.',
            },
          },
        ],
      },
    };
    const listToolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'list-call-1',
            name: 'list_async_tasks',
            response: {
              ok: true,
              tasks: [
                { task_id: 'builder-thread-1', status: 'running', agent_name: 'sophia_builder' },
                { task_id: 'builder-thread-2', status: 'success', agent_name: 'sophia_builder' },
              ],
              task_count: 2,
              result_summary: '2 tracked builder task(s).',
            },
          },
        ],
      },
    };
    const cancelToolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'cancel-call-1',
            name: 'cancel_async_task',
            response: {
              ok: true,
              task_id: 'builder-thread-1',
              status: 'cancelled',
              result_summary: 'Cancelled builder task. task_id: builder-thread-1.',
            },
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-lifecycle-tools',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              tools: [{ functionDeclarations: [
                { name: 'update_async_task' },
                { name: 'list_async_tasks' },
                { name: 'cancel_async_task' },
              ] }],
              inputAudioTranscription: {},
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-lifecycle-tools',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: updateToolResponsePayload,
                result_summary: 'Updated builder task. task_id: builder-thread-1.',
              },
            ],
            tool_diagnostics: [
              {
                id: 'update-call-1',
                name: 'update_async_task',
                success: true,
                task_id: 'builder-thread-1',
                task_status: 'running',
                result_summary: 'Updated builder task. task_id: builder-thread-1.',
                response: updateToolResponsePayload.toolResponse.functionResponses[0].response,
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: listToolResponsePayload,
                result_summary: '2 tracked builder task(s).',
              },
            ],
            tool_diagnostics: [
              {
                id: 'list-call-1',
                name: 'list_async_tasks',
                success: true,
                result_summary: '2 tracked builder task(s).',
                response: listToolResponsePayload.toolResponse.functionResponses[0].response,
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: cancelToolResponsePayload,
                result_summary: 'Cancelled builder task. task_id: builder-thread-1.',
              },
            ],
            tool_diagnostics: [
              {
                id: 'cancel-call-1',
                name: 'cancel_async_task',
                success: true,
                task_id: 'builder-thread-1',
                task_status: 'cancelled',
                result_summary: 'Cancelled builder task. task_id: builder-thread-1.',
                response: cancelToolResponsePayload.toolResponse.functionResponses[0].response,
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'update-call-1', name: 'update_async_task', args: { task_id: 'builder-thread-1', message: 'Make it warmer.' } },
        ],
      },
    });
    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'list-call-1', name: 'list_async_tasks', args: { status_filter: 'all' } },
        ],
      },
    });
    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'cancel-call-1', name: 'cancel_async_task', args: { task_id: 'builder-thread-1' } },
        ],
      },
    });

    await vi.waitFor(() => expect(websocket?.sent).toContain(JSON.stringify(cancelToolResponsePayload)));
    expect(websocket?.sent).toContain(JSON.stringify(updateToolResponsePayload));
    expect(websocket?.sent).toContain(JSON.stringify(listToolResponsePayload));

    const sentLifecycleResponses = toolDiagnostics.filter((diagnostic) => diagnostic.phase === 'tool_response_sent');
    expect(sentLifecycleResponses.map((diagnostic) => diagnostic.toolCall.name)).toEqual([
      'update_async_task',
      'list_async_tasks',
      'cancel_async_task',
    ]);
    expect(sentLifecycleResponses[0]).toMatchObject({ taskId: 'builder-thread-1', taskStatus: 'running' });
    expect(sentLifecycleResponses[1]).toMatchObject({
      trackedTaskIds: ['builder-thread-1', 'builder-thread-2'],
      backendResponse: { task_count: 2 },
    });
    expect(sentLifecycleResponses[2]).toMatchObject({ taskId: 'builder-thread-1', taskStatus: 'cancelled' });

    await connection.close();
  });

  it('surfaces lifecycle execution rejection as a tool response instead of relay degradation', async () => {
    const toolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: 'check-call-1',
            name: 'check_async_task',
            response: {
              ok: false,
              rejected: true,
              error_type: 'unknown_task_id',
              error_message: "No tracked task exists for task_id '789654321' in this trusted Gemini dogfood session.",
              task_id: '789654321',
              status: 'rejected',
              tracked_task_ids: ['builder-thread-1'],
              recovery_guidance: 'Do not invent task ids. Call start_builder_task first or list_async_tasks.',
              result_summary: "Lifecycle tool rejected: no tracked task exists for task_id '789654321'.",
            },
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-lifecycle-rejected',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              tools: [{ functionDeclarations: [{ name: 'check_async_task' }] }],
              inputAudioTranscription: {},
            },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-lifecycle-rejected',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: toolResponsePayload,
                result_summary: "Lifecycle tool rejected: no tracked task exists for task_id '789654321'.",
              },
            ],
            tool_diagnostics: [
              {
                id: 'check-call-1',
                name: 'check_async_task',
                success: false,
                execution_rejected: true,
                task_id: '789654321',
                task_status: 'rejected',
                tracked_task_ids: ['builder-thread-1'],
                rejection_reason: 'unknown_task_id',
                recovery_guidance: 'Do not invent task ids. Call start_builder_task first or list_async_tasks.',
                error_text: "No tracked task exists for task_id '789654321' in this trusted Gemini dogfood session.",
                result_summary: "Lifecycle tool rejected: no tracked task exists for task_id '789654321'.",
                response: toolResponsePayload.toolResponse.functionResponses[0].response,
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    const relayStatuses: GeminiBrowserLiveDogfoodRelayStatus[] = [];
    const relayDiagnostics: GeminiBrowserLiveDogfoodRelayDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onRelayStatus: (status) => relayStatuses.push(status),
      onRelayDiagnostic: (diagnostic) => relayDiagnostics.push(diagnostic),
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'check-call-1', name: 'check_async_task', args: { task_id: '789654321' } },
        ],
      },
    });

    await vi.waitFor(() => expect(websocket?.sent).toContain(JSON.stringify(toolResponsePayload)));
    expect(toolDiagnostics.map((diagnostic) => diagnostic.phase)).toEqual([
      'tool_call_received',
      'tool_execution_rejected',
      'tool_response_sent',
    ]);
    expect(toolDiagnostics[0]).toMatchObject({ taskId: '789654321' });
    expect(toolDiagnostics[1]).toMatchObject({
      success: false,
      taskId: '789654321',
      taskStatus: 'rejected',
      trackedTaskIds: ['builder-thread-1'],
      rejectionReason: 'unknown_task_id',
      recoveryGuidance: 'Do not invent task ids. Call start_builder_task first or list_async_tasks.',
    });
    expect(toolDiagnostics[2]).toMatchObject({
      phase: 'tool_response_sent',
      taskId: '789654321',
      trackedTaskIds: ['builder-thread-1'],
      rejectionReason: 'unknown_task_id',
    });
    expect(relayStatuses).toContain('active');
    expect(relayStatuses).not.toContain('degraded');
    expect(relayDiagnostics).toEqual([]);

    await connection.close();
  });

  it('surfaces toolResponse send failure without marking the relay or provider transport dead', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-tool-send-fail',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-tool-send-fail',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            client_actions: [
              {
                type: 'gemini_tool_response',
                payload: {
                  toolResponse: {
                    functionResponses: [
                      {
                        id: 'artifact-call-fail',
                        name: 'emit_artifact',
                        response: {
                          ok: true,
                          backend_tool_result: 'Artifact recorded.',
                          result_summary: 'Artifact recorded.',
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const toolDiagnostics: GeminiBrowserLiveDogfoodToolLoopDiagnostic[] = [];
    const relayStatuses: GeminiBrowserLiveDogfoodRelayStatus[] = [];
    const relayDiagnostics: GeminiBrowserLiveDogfoodRelayDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url, { failToolResponseSend: true });
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolLoopDiagnostic: (diagnostic) => toolDiagnostics.push(diagnostic),
      onRelayStatus: (status) => relayStatuses.push(status),
      onRelayDiagnostic: (diagnostic) => relayDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      toolCall: {
        functionCalls: [{ id: 'artifact-call-fail', name: 'emit_artifact', args: emitArtifactArgs }],
      },
    });

    await vi.waitFor(() => expect(toolDiagnostics.map((diagnostic) => diagnostic.phase)).toContain('tool_response_send_failed'));
    expect(toolDiagnostics.at(-1)).toMatchObject({
      phase: 'tool_response_send_failed',
      success: false,
      errorText: 'toolResponse send blocked by test socket',
    });
    expect(relayStatuses).toContain('active');
    expect(relayStatuses).not.toContain('terminal_error');
    expect(relayDiagnostics).toEqual([]);
    expect(websocket?.readyState).toBe(1);

    await connection.close();
  });

  it('preserves backend detail on session and relay failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Gemini browser Live dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await expect(
      connectGeminiBrowserLiveDogfood({
        userId: 'user-1',
        fetchFn: fetchMock as typeof fetch,
        webSocketFactory: (url) => new FakeWebSocket(url),
        getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
        audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      }),
    ).rejects.toThrow(
      'Gemini browser dogfood session failed: Gemini browser Live dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true.',
    );

    const relayFetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-1',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1',
            provider_event_relay_url: '/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events',
            public_event_boundary: 'SophiaEventNormalizer',
            transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true, session_id: 'browser-gemini-1' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Gemini browser relay accepts only documented Gemini Live server messages.' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const relayErrors: unknown[] = [];
    const relayStatuses: GeminiBrowserLiveDogfoodRelayStatus[] = [];
    const relayDiagnostics: GeminiBrowserLiveDogfoodRelayDiagnostic[] = [];
    let relayWebSocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: relayFetchMock as typeof fetch,
      webSocketFactory: (url) => {
        relayWebSocket = new FakeWebSocket(url);
        return relayWebSocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onRelayError: (error) => relayErrors.push(error),
      onRelayStatus: (status) => relayStatuses.push(status),
      onRelayDiagnostic: (diagnostic) => relayDiagnostics.push(diagnostic),
    });

    expect(connection.relayUrl).toBe('/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events');
    expect(connection.publicEventBoundary).toBe('SophiaEventNormalizer');
    expect(connection.transport).toBe('gemini_browser_websocket_ephemeral_token_with_backend_relay');
    await vi.waitFor(() => expect(relayStatuses).toEqual(['active']));

    relayWebSocket?.emitMessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
    await vi.waitFor(() => {
      expect(relayStatuses).toContain('degraded');
      expect(relayErrors).toHaveLength(1);
      expect(relayDiagnostics).toHaveLength(1);
    });

    expect(relayErrors[0]).toBeInstanceOf(Error);
    expect((relayErrors[0] as Error).message).toBe(
      'Gemini browser dogfood relay failed: Gemini browser relay accepts only documented Gemini Live server messages.',
    );
    expect(relayDiagnostics[0]).toMatchObject({
      targetPath: '/api/sophia/voice/dogfood/gemini/relay',
      eventType: 'serverContent.outputTranscription',
      hasHttpResponse: true,
      statusCode: 422,
      terminal: false,
      consecutiveFailures: 1,
      websocketOpen: true,
      websocketState: 'open',
    });

    await connection.close();
  });

  it('captures browser-level relay fetch failures as degraded while the Gemini socket remains open', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-fetch-fail',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-fetch-fail',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const relayStatuses: GeminiBrowserLiveDogfoodRelayStatus[] = [];
    const relayDiagnostics: GeminiBrowserLiveDogfoodRelayDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onRelayStatus: (status) => relayStatuses.push(status),
      onRelayDiagnostic: (diagnostic) => relayDiagnostics.push(diagnostic),
    });

    websocket?.emitMessage({
      serverContent: {
        inputTranscription: { text: 'I need this relayed.' },
      },
    });

    await vi.waitFor(() => expect(relayDiagnostics).toHaveLength(1));

    expect(relayStatuses).toContain('degraded');
    expect(relayDiagnostics[0]).toMatchObject({
      targetPath: '/api/sophia/voice/dogfood/gemini/relay',
      eventType: 'serverContent.inputTranscription',
      hasHttpResponse: false,
      statusCode: null,
      errorText: 'Failed to fetch',
      fetchErrorName: 'TypeError',
      terminal: false,
      websocketOpen: true,
      websocketState: 'open',
    });

    const failedRelayInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(failedRelayInit.keepalive).toBeUndefined();

    await connection.close();
  });

  it('escalates persistent relay failures to terminal relay status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-terminal-relay',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-terminal-relay',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const relayStatuses: GeminiBrowserLiveDogfoodRelayStatus[] = [];
    const relayDiagnostics: GeminiBrowserLiveDogfoodRelayDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;

    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onRelayStatus: (status) => relayStatuses.push(status),
      onRelayDiagnostic: (diagnostic) => relayDiagnostics.push(diagnostic),
    });

    for (let index = 0; index < 3; index += 1) {
      websocket?.emitMessage({ serverContent: { inputTranscription: { text: `I need this relayed ${index}.` } } });
    }

    await vi.waitFor(() => expect(relayDiagnostics).toHaveLength(3));

    expect(relayStatuses).toContain('terminal_error');
    expect(relayDiagnostics.at(-1)).toMatchObject({
      terminal: true,
      consecutiveFailures: 3,
      websocketOpen: true,
    });

    await connection.close();
  });

  it('skips empty and semantically empty websocket frames instead of relaying them', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-1',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    let websocket: FakeWebSocket | null = null;

    const connectionPromise = connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url, { autoSetupComplete: false });
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });

    await vi.waitFor(() => {
      expect(websocket?.sent[0]).toBe(JSON.stringify({
        setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
      }));
    });

    websocket?.emitRawMessage('{}');
    websocket?.emitRawMessage('');
    websocket?.emitMessage({ serverContent: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    websocket?.emitMessage({ setupComplete: {} });
    const connection = await connectionPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/sophia/voice/dogfood/gemini/relay',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );

    await connection.close();
  });

  it('preserves setupComplete when the WebSocket delivers the JSON frame as a Blob', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-blob-setup',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-blob-setup',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const providerEvents: unknown[] = [];
    let websocket: FakeWebSocket | null = null;

    const connectionPromise = connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url, { autoSetupComplete: false });
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onProviderEvent: (event) => providerEvents.push(event),
    });

    await vi.waitFor(() => {
      expect(websocket?.sent[0]).toBe(JSON.stringify({
        setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
      }));
    });

    websocket?.emitRawMessage(new Blob([JSON.stringify({ setupComplete: {} })], { type: 'application/json' }));
    const connection = await connectionPromise;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(connection.setupComplete).toBe(true);
    expect(providerEvents).toEqual([{ setupComplete: {} }]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/sophia/voice/dogfood/gemini/relay',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );

    await connection.close();
  });

  it('does not relay websocket lifecycle errors before a real provider message exists', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-1',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    let websocket: FakeWebSocket | null = null;

    const connectionPromise = connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url, { autoSetupComplete: false });
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });

    await vi.waitFor(() => {
      expect(websocket?.sent[0]).toBe(JSON.stringify({
        setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
      }));
    });
    websocket?.emitError();

    await expect(connectionPromise).rejects.toThrow('Gemini Live WebSocket failed before setupComplete.');
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/sophia/voice/dogfood/gemini/relay'),
    ).toBe(false);
  });

  it('does not relay websocket lifecycle close events before setupComplete', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-1',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test' },
            setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
            stream_url: '/api/sophia/voice/dogfood/gemini/events?session_id=browser-gemini-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    let websocket: FakeWebSocket | null = null;

    const connectionPromise = connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url, { autoSetupComplete: false });
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });

    await vi.waitFor(() => {
      expect(websocket?.sent[0]).toBe(JSON.stringify({
        setup: { model: 'models/gemini-3.1-flash-live-preview', inputAudioTranscription: {} },
      }));
    });
    websocket?.emitClose();

    await expect(connectionPromise).rejects.toThrow('Gemini Live WebSocket closed before setupComplete.');
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/sophia/voice/dogfood/gemini/relay'),
    ).toBe(false);
  });
});
