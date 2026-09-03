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
  assembleGeminiOutputTranscription,
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
  createGeminiOutputLegMonitor,
  detectGeminiSameResponseRepeatedIntent,
  isGeminiServerInterruptedEvent,
  isGeminiSetupCompleteMessage,
  isRelayableGeminiProviderEvent,
  pcm16BytesToFloat32,
  pcm16Base64FromFloat32,
  readGeminiOutputAudioChunks,
  readGeminiLangSmithTraceContext,
  readGeminiSyntheticTestContext,
  sameGeminiSyntheticTestContext,
  readGeminiVoiceLabTraceFaultReceipt,
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
  type GeminiInputAudioActivityDiagnostic,
  type GeminiProviderReceiveMetadata,
  type GeminiOutputAudioPlaybackReceipt,
  type GeminiProviderConnectionEpochReceipt,
  type GeminiRepeatedIntentGateDiagnostic,
  type GeminiStaleOutputSuppressionDiagnostic,
  type GeminiSyntheticInputFaultReceipt,
  type GeminiSyntheticInputLegReceipt,
  type GeminiSyntheticInputTurnReceipt,
  type GeminiSyntheticInteractionFaultReceipt,
  type GeminiSyntheticInteractionReceipt,
  type GeminiSyntheticTestContext,
  type GeminiOutputAudioReceivedDiagnostic,
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

function acceptedSyntheticDisconnectResponse(
  init?: RequestInit,
  extra: Record<string, unknown> = {},
): Response {
  const requestBody = typeof init?.body === 'string'
    ? JSON.parse(init.body) as Record<string, unknown>
    : {};
  if (requestBody.schema === 'sophia_gemini_browser_provider_activation_v1') {
    return new Response(JSON.stringify({
      activated: true,
      session_id: requestBody.session_id,
      provider_connection_epoch: requestBody.candidate_epoch,
      provider_activation_receipt: requestBody,
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    accepted: true,
    ...extra,
    ...(requestBody.browser_provider_close_receipt
      ? { browser_provider_close_receipt: requestBody.browser_provider_close_receipt }
      : {}),
    ...(requestBody.browser_provider_close_receipts
      ? { browser_provider_close_receipts: requestBody.browser_provider_close_receipts }
      : {}),
    ...(requestBody.browser_provider_activation_abort_receipts
      ? {
          browser_provider_activation_abort_receipts:
            requestBody.browser_provider_activation_abort_receipts,
        }
      : {}),
  }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
}

function providerCleanupFields(
  syntheticTest: GeminiSyntheticTestContext,
  sessionId: string,
  options: {
    admissionId?: string;
    jti?: string;
  } = {},
) {
  const providerDeadline = new Date(syntheticTest.provider_expires_at);
  const retentionDeadline = new Date(providerDeadline.getTime() + 86_400_000);
  const cleanupDeadline = new Date(providerDeadline.getTime() + 600_000);
  const payload = {
    v: 1,
    iss: 'sophia-voice-gateway',
    aud: 'sophia-voice-lab-provider-cleanup',
    sub: syntheticTest.principal_id,
    principal_id: syntheticTest.principal_id,
    test_run_id: syntheticTest.test_run_id,
    ...(syntheticTest.scenario_id
      ? { scenario_id: syntheticTest.scenario_id }
      : {}),
    ...(syntheticTest.scenario_version
      ? { scenario_version: syntheticTest.scenario_version }
      : {}),
    ...(syntheticTest.scenario_id === 'V-D02' ? {
      voice_lab_run_id_sha256: syntheticTest.voice_lab_run_id_sha256,
      browser_worker_id_sha256: syntheticTest.browser_worker_id_sha256,
      browser_lease_epoch: syntheticTest.browser_lease_epoch,
      browser_context_id_sha256: syntheticTest.browser_context_id_sha256,
    } : {}),
    synthetic: true,
    environment: syntheticTest.environment,
    retention_hours: syntheticTest.retention_hours,
    cleanup_obligation_id: syntheticTest.cleanup_obligation_id,
    provider_expires_at: syntheticTest.provider_expires_at,
    retention_expires_at: retentionDeadline.toISOString(),
    cleanup_expires_at: cleanupDeadline.toISOString(),
    allowed_ops: ['provider:settle'],
    expected_deployment: {
      frontend: 'a'.repeat(40),
      backend: 'b'.repeat(40),
      voice: 'c'.repeat(40),
    },
    provider_session_id: sessionId,
    cleanup_provider_admission_id:
      options.admissionId ?? '123e4567-e89b-42d3-a456-426614174001',
    iat: Math.floor(providerDeadline.getTime() / 1000) - 1_800,
    nbf: Math.floor(providerDeadline.getTime() / 1000) - 1_800,
    exp: Math.floor(cleanupDeadline.getTime() / 1000),
    jti: options.jti ?? '123e4567-e89b-42d3-a456-426614174002',
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = Buffer.alloc(32, 7).toString('base64url');
  return {
    provider_cleanup_token: `${encodedPayload}.${signature}`,
    provider_cleanup_expires_at: cleanupDeadline.toISOString(),
  };
}

function syntheticProductionBootstrap(
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  const syntheticTest: GeminiSyntheticTestContext = {
    synthetic: true,
    principal_id: 'voice-lab-user-1',
    test_run_id: 'run-provider-cleanup',
    scenario_id: 'vt00-realtime-001',
    scenario_version: 'v1',
    environment: 'production',
    retention_hours: 24,
    cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
    provider_expires_at: '2033-05-18T04:03:20.000Z',
  };
  return {
    runtime: 'gemini_live',
    voice_runtime: 'gemini_live',
    production_route: true,
    session_id: sessionId,
    websocket_url: 'wss://gemini.example/live',
    ephemeral_token: {
      value: `auth_tokens/${sessionId}`,
      expireTime: '2033-05-18T04:03:20.000Z',
    },
    setup: { model: 'models/gemini-live', sessionResumption: {} },
    stream_url: `/api/sophia/voice/gemini/events?session_id=${sessionId}`,
    disconnect_url: '/api/sophia/voice/gemini/disconnect',
    provider_activation_url: '/api/sophia/voice/gemini/activate',
    provider_connection_epoch: 1,
    synthetic_test: syntheticTest,
    ...providerCleanupFields(syntheticTest, sessionId),
    ...overrides,
  };
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

class StallingCloseFakeWebSocket extends FakeWebSocket {
  closeCalls = 0;

  override close() {
    this.closeCalls += 1;
    this.readyState = 2;
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
          ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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

  it('classifies LangSmith trace identity without silently dropping unavailable values', () => {
    expect(readGeminiLangSmithTraceContext({ langsmith_trace_id: ' trace-voice-1 ' })).toEqual({
      langsmithTraceId: 'trace-voice-1',
      langsmithTraceStatus: 'available',
      langsmithTraceUnavailableReason: null,
    });
    expect(readGeminiLangSmithTraceContext({
      langsmith_trace_id: 'trace-voice-2',
      langsmith_trace_unavailable_reason: null,
    })).toEqual({
      langsmithTraceId: 'trace-voice-2',
      langsmithTraceStatus: 'available',
      langsmithTraceUnavailableReason: null,
    });
    expect(readGeminiLangSmithTraceContext({ langsmith_trace_id: null })).toEqual({
      langsmithTraceId: null,
      langsmithTraceStatus: 'trace_unavailable',
      langsmithTraceUnavailableReason: 'not_provided',
    });
    expect(readGeminiLangSmithTraceContext({ langsmith_trace_id: '   ' })).toEqual({
      langsmithTraceId: null,
      langsmithTraceStatus: 'trace_unavailable',
      langsmithTraceUnavailableReason: 'invalid',
    });
    expect(readGeminiLangSmithTraceContext({
      langsmith_trace_id: null,
      langsmith_trace_unavailable_reason: 'synthetic_isolation_policy',
    })).toEqual({
      langsmithTraceId: null,
      langsmithTraceStatus: 'trace_unavailable',
      langsmithTraceUnavailableReason: 'synthetic_isolation_policy',
    });
    expect(() => readGeminiLangSmithTraceContext({
      langsmith_trace_id: 'trace-must-not-coexist',
      langsmith_trace_unavailable_reason: 'synthetic_isolation_policy',
    })).toThrow(/both an id and an unavailable reason/i);
  });

  it('strictly binds governed trace-fault receipts to the app-authenticated V-L01 run', () => {
    const synthetic = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-v-l01',
      scenario_id: 'V-L01',
      scenario_version: 'vt00.scenarios.v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const receipt = {
      schema: 'sophia_voice_lab_trace_fault_v1',
      fault: 'langsmith_unavailable',
      phase: 'applied',
      principal_id: synthetic.principal_id,
      test_run_id: synthetic.test_run_id,
      scenario_id: synthetic.scenario_id,
      scenario_version: synthetic.scenario_version,
      environment: synthetic.environment,
      expected_deployment: {
        frontend: 'a'.repeat(40),
        backend: 'b'.repeat(40),
        voice: 'c'.repeat(40),
      },
      trace_unavailable: true,
      canonical_behavior_unchanged: true,
      applied_at: '2026-08-23T12:00:00.000Z',
      restored_at: null,
    };
    const parsed = readGeminiVoiceLabTraceFaultReceipt(receipt, synthetic, 'trace', 'applied');
    expect(parsed).toEqual(receipt);
    expect(readGeminiLangSmithTraceContext({ langsmith_trace_id: null }, parsed)).toEqual({
      langsmithTraceId: null,
      langsmithTraceStatus: 'trace_unavailable',
      langsmithTraceUnavailableReason: 'governed_synthetic_fault',
    });
    expect(() => readGeminiVoiceLabTraceFaultReceipt(
      { ...receipt, test_run_id: 'run-other' },
      synthetic,
      'trace',
      'applied',
    )).toThrow('did not match the authenticated synthetic run');
    expect(() => readGeminiLangSmithTraceContext(
      { langsmith_trace_id: 'trace-must-not-exist' },
      parsed,
    )).toThrow('unexpectedly exposed a LangSmith trace id');
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

  it("preserves the later repeated What's/right now fragments and detects the repeated intent", () => {
    const fragments = [
      'Got it.',
      "Sounds like you're really deep in the design phase.",
      "What's",
      'the main blocker',
      'right now',
      'architecturally?',
      "You're in the thick of it, weighing the options.",
      "What's",
      'the biggest consideration',
      'right now',
      'between the separation of the control plane and the execution layer?',
    ];
    let assembled = '';
    let previousFragment: string | null = null;
    const decisions: string[] = [];

    for (const fragment of fragments) {
      const result = assembleGeminiOutputTranscription(assembled, fragment, previousFragment);
      assembled = result.text;
      previousFragment = fragment;
      decisions.push(result.decision);
    }

    expect(assembled).toBe(
      "Got it. Sounds like you're really deep in the design phase. What's the main blocker right now architecturally? You're in the thick of it, weighing the options. What's the biggest consideration right now between the separation of the control plane and the execution layer?",
    );
    expect(assembled.match(/What's/g)).toHaveLength(2);
    expect(assembled.match(/right now/g)).toHaveLength(2);
    expect(decisions.slice(7)).toContain('delta_append');
    expect(detectGeminiSameResponseRepeatedIntent(assembled)).toMatchObject({
      detected: true,
      questionCount: 2,
      matchedSignals: expect.arrayContaining([
        'same_question_opener',
        'shared_right_now_frame',
        'shared_intent_concept',
      ]),
    });
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
    const audioTrack = {
      stop: vi.fn(),
      getSettings: () => ({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1,
        latency: 0.02,
      }),
    };
    const localStream = {
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => localStream);
    const recorder = createGeminiConversationAudioRecorder(
      fakeAudioContext as unknown as AudioContext,
    );

    expect(recorder).not.toBeNull();
    expect(fakeAudioContext.createdGains[1]?.connect).toHaveBeenCalledWith(fakeAudioContext.destination);

    const diagnostics: unknown[] = [];
    const microphoneDiagnostics: unknown[] = [];
    const inputActivityDiagnostics: GeminiInputAudioActivityDiagnostic[] = [];
    const createAnalyser = vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn(),
    }) as unknown as AnalyserNode);
    Object.assign(fakeAudioContext, { createAnalyser });
    const connection = await connectGeminiBrowserLiveDogfood({
      userId: 'user-1',
      fetchFn: makeGeminiBrowserSessionFetch('browser-gemini-audio', true) as typeof fetch,
      webSocketFactory: (url) => new FakeWebSocket(url),
      getUserMedia,
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onAudioContextDiagnostics: (diagnostic) => diagnostics.push(diagnostic),
      onMicrophoneAudioSettings: (diagnostic) => microphoneDiagnostics.push(diagnostic),
      onInputAudioActivity: (diagnostic) => inputActivityDiagnostics.push(diagnostic),
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
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    expect(microphoneDiagnostics).toEqual([
      expect.objectContaining({
        requested: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        tracks: [{
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
          latency: 0.02,
        }],
      }),
    ]);
    expect(connection.microphoneAudioSettings).toEqual(microphoneDiagnostics[0]);
    expect(createAnalyser).not.toHaveBeenCalled();
    expect(fakeAudioContext.createdGains[3]?.connect).toHaveBeenCalledWith(
      fakeAudioContext.destination,
    );
    expect(inputActivityDiagnostics).toContainEqual(expect.objectContaining({
      eventType: 'microphone_settings_recorded',
      trigger: 'microphone_track_settings',
      microphoneAudioSettings: microphoneDiagnostics[0],
    }));
    expect(fakeAudioContext.createdGains[1]?.connect).toHaveBeenCalledWith(fakeAudioContext.destination);

    await connection.close();
  });

  it('never verifies the output leg from a provider chunk fingerprint alone', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const monitor = createGeminiOutputLegMonitor(
      fakeAudioContext as unknown as AudioContext,
    );
    monitor.begin({
      realizationId: 'realization-source-only',
      providerChunkFingerprint: 'deadbeef',
      providerConnectionEpoch: 1,
      playbackGeneration: 1,
      scheduledAt: '2026-08-23T12:00:00.000Z',
    }, fakeAudioContext.destination);

    const receipt = await monitor.finish(
      'realization-source-only',
      'completed',
      '2026-08-23T12:00:01.000Z',
      1,
    );

    expect(receipt).toMatchObject({
      status: 'unavailable',
      reason: 'webaudio_output_monitor_unavailable',
      providerChunkFingerprint: 'deadbeef',
      monitorDigestSha256: null,
      rawAudioExcluded: true,
    });
  });

  it('cryptographically digests non-silent samples from the final WebAudio output bus', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const analyser = {
      fftSize: 32,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((target: Float32Array) => target.fill(0.25)),
    };
    Object.assign(fakeAudioContext, {
      createAnalyser: vi.fn(() => analyser as unknown as AnalyserNode),
    });
    const monitor = createGeminiOutputLegMonitor(
      fakeAudioContext as unknown as AudioContext,
      60_000,
    );
    monitor.begin({
      realizationId: 'realization-monitored',
      providerChunkFingerprint: 'cafebabe',
      providerConnectionEpoch: 2,
      playbackGeneration: 4,
      scheduledAt: '2026-08-23T12:00:00.000Z',
    }, fakeAudioContext.destination);
    monitor.markStarted('realization-monitored', '2026-08-23T12:00:00.000Z');

    const receipt = await monitor.finish(
      'realization-monitored',
      'completed',
      '2026-08-23T12:00:01.000Z',
      1,
    );
    monitor.stop();

    expect(analyser.connect).toHaveBeenCalledWith(fakeAudioContext.destination);
    expect(receipt).toMatchObject({
      status: 'verified',
      monitorKind: 'webaudio-per-realization-final-path-analyser',
      monitorDigestAlgorithm: 'sha-256-chain-v1',
      providerChunkFingerprint: 'cafebabe',
      providerConnectionEpoch: 2,
      playbackGeneration: 4,
      rawAudioExcluded: true,
    });
    expect(receipt.monitorDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.monitorFrameCount).toBeGreaterThan(0);
    expect(receipt.monitorNonSilentFrameCount).toBeGreaterThan(0);
    expect(receipt.monitorRms).toBeGreaterThan(0);
    expect(receipt.monitorPeak).toBeGreaterThan(0);
  });

  it('does not sample or verify a queued realization before its exact playback start', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const analyser = {
      fftSize: 32,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((target: Float32Array) => target.fill(0.5)),
    };
    Object.assign(fakeAudioContext, {
      createAnalyser: vi.fn(() => analyser as unknown as AnalyserNode),
    });
    const monitor = createGeminiOutputLegMonitor(
      fakeAudioContext as unknown as AudioContext,
      60_000,
    );
    monitor.begin({
      realizationId: 'queued-later',
      providerChunkFingerprint: 'queued-fingerprint',
      providerConnectionEpoch: 3,
      playbackGeneration: 5,
      scheduledAt: '2026-08-23T12:00:02.000Z',
    }, fakeAudioContext.destination);

    const receipt = await monitor.finish(
      'queued-later',
      'flushed',
      '2026-08-23T12:00:01.000Z',
      1,
    );

    expect(analyser.getFloatTimeDomainData).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      status: 'inconclusive',
      reason: 'output_monitor_playback_not_started',
      monitorFrameCount: 0,
      monitorNonSilentFrameCount: 0,
      monitorDigestSha256: null,
    });
  });

  it('uses isolated analysers for overlapping realizations without cross-verification', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const makeAnalyser = (sample: number) => ({
      fftSize: 32,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((target: Float32Array) => target.fill(sample)),
    });
    const firstAnalyser = makeAnalyser(0.25);
    const secondAnalyser = makeAnalyser(0);
    const createAnalyser = vi
      .fn()
      .mockReturnValueOnce(firstAnalyser as unknown as AnalyserNode)
      .mockReturnValueOnce(secondAnalyser as unknown as AnalyserNode);
    Object.assign(fakeAudioContext, { createAnalyser });
    const monitor = createGeminiOutputLegMonitor(
      fakeAudioContext as unknown as AudioContext,
      60_000,
    );
    const firstNode = monitor.begin({
      realizationId: 'overlap-first',
      providerChunkFingerprint: 'first-fingerprint',
      providerConnectionEpoch: 4,
      playbackGeneration: 6,
      scheduledAt: '2026-08-23T12:00:00.000Z',
    }, fakeAudioContext.destination);
    const secondNode = monitor.begin({
      realizationId: 'overlap-second',
      providerChunkFingerprint: 'second-fingerprint',
      providerConnectionEpoch: 4,
      playbackGeneration: 6,
      scheduledAt: '2026-08-23T12:00:00.250Z',
    }, fakeAudioContext.destination);
    monitor.markStarted('overlap-first', '2026-08-23T12:00:00.000Z');
    monitor.markStarted('overlap-second', '2026-08-23T12:00:00.250Z');

    const [firstReceipt, secondReceipt] = await Promise.all([
      monitor.finish('overlap-first', 'completed', '2026-08-23T12:00:01.000Z', 1),
      monitor.finish('overlap-second', 'completed', '2026-08-23T12:00:01.250Z', 1),
    ]);

    expect(firstNode).toBe(firstAnalyser);
    expect(secondNode).toBe(secondAnalyser);
    expect(firstNode).not.toBe(secondNode);
    expect(firstReceipt.status).toBe('verified');
    expect(firstReceipt.monitorNonSilentFrameCount).toBeGreaterThan(0);
    expect(secondReceipt).toMatchObject({
      status: 'inconclusive',
      reason: 'output_monitor_no_non_silent_frames',
      monitorNonSilentFrameCount: 0,
    });
  });

  it('parses strict product synthetic provenance and rejects extra fields', () => {
    const context = readGeminiSyntheticTestContext({
      synthetic: true,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-001',
      scenario_id: 'vt00-realtime-001',
      scenario_version: 'v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    });
    expect(context?.test_run_id).toBe('run-001');
    expect(context?.retention_hours).toBe(24);
    for (const retention_hours of [0, 169, true, '24']) {
      expect(() => readGeminiSyntheticTestContext({
        ...context,
        retention_hours,
      })).toThrow('synthetic_test was malformed');
    }
    expect(() => readGeminiSyntheticTestContext({
      ...context,
      attacker_selected: true,
    })).toThrow('synthetic_test was malformed');
  });

  it('requires exact positive-epoch V-D02 browser ownership and includes it in continuation equality', () => {
    const d02 = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-d02',
      scenario_id: 'V-D02',
      scenario_version: 'vt00.scenarios.v1',
      voice_lab_run_id_sha256: 'd'.repeat(64),
      browser_worker_id_sha256: 'e'.repeat(64),
      browser_lease_epoch: 6,
      browser_context_id_sha256: 'f'.repeat(64),
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const parsed = readGeminiSyntheticTestContext(d02);
    expect(parsed).toEqual(d02);
    expect(sameGeminiSyntheticTestContext(parsed, { ...parsed })).toBe(true);
    expect(sameGeminiSyntheticTestContext(parsed, {
      ...parsed,
      browser_context_id_sha256: 'a'.repeat(64),
    })).toBe(false);
    expect(sameGeminiSyntheticTestContext(parsed, {
      ...parsed,
      browser_lease_epoch: 7,
    })).toBe(false);

    for (const malformed of [
      { ...d02, browser_context_id_sha256: undefined },
      { ...d02, browser_lease_epoch: 0 },
      { ...d02, scenario_id: 'V-A01' },
    ]) {
      expect(() => readGeminiSyntheticTestContext(malformed)).toThrow('synthetic_test was malformed');
    }
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
    expect(player.snapshot()).toEqual({
      nextPlaybackTime: 0,
      activeSourceCount: 0,
      playbackGeneration: 1,
      queuedChunkCount: 0,
      playbackAheadSeconds: 0,
    });
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
      providerConnectionEpoch: 3,
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
      providerConnectionEpoch: 3,
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

  it('emits distinct scheduled, realized, completed, flushed, and dropped playback receipts', () => {
    const fakeAudioContext = new FakeAudioContext();
    fakeAudioContext.currentTime = 5;
    fakeAudioContext.state = 'running';
    const receipts: GeminiOutputAudioPlaybackReceipt[] = [];
    const player = createGeminiOutputAudioPlaybackController(fakeAudioContext as unknown as AudioContext, {
      onPlaybackReceipt: (receipt) => receipts.push(receipt),
    });
    const chunk = Buffer.from([0x00, 0x00, 0x01, 0x00]).toString('base64');
    const event = {
      eventId: 'provider-audio-event-1',
      responseId: 'provider-response-1',
      serverContent: {
        responseId: 'provider-response-1',
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: chunk } }],
        },
      },
    };
    const metadata: GeminiProviderReceiveMetadata = {
      providerReceiveSequence: 9,
      providerConnectionEpoch: 4,
      providerReceivedAt: '2026-08-23T10:00:00.000Z',
      relayCorrelationId: 'gemini-event-9',
      providerPrimaryCategory: 'serverContent',
      providerCategories: ['serverContent', 'modelTurnAudio'],
    };

    expect(player.playEvent(event, metadata)).toBe(1);
    expect(receipts.map((receipt) => receipt.phase)).toEqual(['scheduled', 'started']);
    expect(receipts[0]).toMatchObject({
      providerConnectionEpoch: 4,
      providerReceiveSequence: 9,
      playbackGeneration: 0,
      scheduledStartTime: 5,
    });
    expect(receipts[1]?.realizationId).toBe(receipts[0]?.realizationId);

    fakeAudioContext.createdSources[0]?.onended?.();
    expect(receipts.at(-1)).toMatchObject({
      phase: 'completed',
      realizationId: receipts[0]?.realizationId,
      providerConnectionEpoch: 4,
    });

    expect(player.playEvent({ ...event, eventId: 'provider-audio-event-2' }, {
      ...metadata,
      providerReceiveSequence: 10,
      relayCorrelationId: 'gemini-event-10',
    })).toBe(1);
    player.flush('test_manual_flush');
    expect(receipts.at(-1)).toMatchObject({
      phase: 'flushed',
      playbackGeneration: 0,
      invalidatedByPlaybackGeneration: 1,
      flushReason: 'test_manual_flush',
    });

    expect(player.playBase64Chunk('')).toBe(false);
    expect(receipts.at(-1)).toMatchObject({
      phase: 'dropped',
      playbackGeneration: 1,
      dropReason: 'invalid_pcm_payload',
    });

    const suspendedContext = new FakeAudioContext();
    const suspendedReceipts: GeminiOutputAudioPlaybackReceipt[] = [];
    const suspendedPlayer = createGeminiOutputAudioPlaybackController(
      suspendedContext as unknown as AudioContext,
      { onPlaybackReceipt: (receipt) => suspendedReceipts.push(receipt) },
    );
    expect(suspendedPlayer.playEvent(event, metadata)).toBe(1);
    expect(suspendedReceipts.map((receipt) => receipt.phase)).toEqual(['scheduled']);
    suspendedPlayer.flush('suspended_test_cleanup');
  });

  it('suppresses only bounded exact transport audio replays and preserves legitimate repeated audio', () => {
    const fakeAudioContext = new FakeAudioContext();
    const diagnostics: Array<{ dropReason?: string | null; scheduled?: boolean }> = [];
    let nowMs = 1_000;
    const player = createGeminiOutputAudioPlaybackController(fakeAudioContext as unknown as AudioContext, {
      nowMs: () => nowMs,
      onChunkDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const chunk = Buffer.from([0x00, 0x00, 0x01, 0x00]).toString('base64');
    const audioEvent = (eventId: string | null) => ({
      ...(eventId ? { eventId } : {}),
      responseId: 'response-audio-1',
      serverContent: {
        responseId: 'response-audio-1',
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: chunk } }],
        },
      },
    });
    const metadata = (sequence: number, epoch: number): GeminiProviderReceiveMetadata => ({
      providerReceiveSequence: sequence,
      providerConnectionEpoch: epoch,
      providerReceivedAt: `2026-08-22T12:00:00.00${sequence}Z`,
      relayCorrelationId: `audio-${sequence}`,
      providerPrimaryCategory: 'serverContent',
      providerCategories: ['serverContent', 'modelTurnAudio'],
    });

    expect(player.playEvent(audioEvent('stable-audio-event'), metadata(1, 1))).toBe(1);
    nowMs += 10;
    expect(player.playEvent(audioEvent('stable-audio-event'), metadata(2, 1))).toBe(0);
    nowMs += 10;
    // Same bytes with a new event identity in the same uninterrupted provider
    // epoch can be legitimate speech and must still play.
    expect(player.playEvent(audioEvent('new-audio-event'), metadata(3, 1))).toBe(1);
    nowMs += 10;
    expect(player.playEvent(audioEvent(null), metadata(4, 2))).toBe(0);

    expect(diagnostics.filter((diagnostic) => diagnostic.dropReason === 'exact_transport_replay')).toHaveLength(2);
    expect(diagnostics.filter((diagnostic) => diagnostic.scheduled)).toHaveLength(2);
  });

  it('bounds playback-ahead, queues excess chunks, and flushes scheduled and queued audio', () => {
    const fakeAudioContext = new FakeAudioContext();
    fakeAudioContext.currentTime = 3;
    const diagnostics: Array<{ dropReason?: string | null }> = [];
    const player = createGeminiOutputAudioPlaybackController(fakeAudioContext as unknown as AudioContext, {
      maxPlaybackAheadSeconds: 0.75,
      maxQueuedChunks: 2,
      onChunkDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const halfSecondChunk = Buffer.alloc(24_000).toString('base64');

    expect(player.playBase64Chunk(halfSecondChunk)).toBe(true);
    expect(player.playBase64Chunk(halfSecondChunk)).toBe(true);
    expect(player.playBase64Chunk(halfSecondChunk)).toBe(true);
    expect(player.playBase64Chunk(halfSecondChunk)).toBe(false);
    expect(player.snapshot()).toMatchObject({
      activeSourceCount: 1,
      queuedChunkCount: 2,
      playbackAheadSeconds: 0.5,
    });
    expect(diagnostics.at(-1)).toMatchObject({ dropReason: 'playback_queue_full' });

    expect(player.flush()).toEqual({
      nextPlaybackTime: 0,
      activeSourceCount: 0,
      playbackGeneration: 1,
      queuedChunkCount: 0,
      playbackAheadSeconds: 0,
    });
    expect(fakeAudioContext.createdSources[0]?.stop).toHaveBeenCalledTimes(1);
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
      {
        providerReceiveSequence: 22,
        providerConnectionEpoch: 6,
        providerReceivedAt: '2026-05-20T00:00:00.000Z',
        relayCorrelationId: 'gemini-event-22',
        providerPrimaryCategory: 'serverContent',
        providerCategories: ['serverContent', 'inputTranscription', 'outputTranscription'],
      },
    );
    expect(telemetry.categoryCounts.serverContent.count).toBe(1);
    expect(telemetry.categoryCounts.toolCall.count).toBe(1);
    expect(telemetry.relayClassification).toBe('critical');
    expect(telemetry.relayClassificationCounts.critical.count).toBe(1);
    expect(telemetry.responseId).toBe('provider-response-1');
    expect(telemetry.providerConnectionEpoch).toBe(6);
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
    const outputAudioReceivedDiagnostics: unknown[] = [];
    const playbackReceipts: GeminiOutputAudioPlaybackReceipt[] = [];
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
      onOutputAudioReceived: (diagnostic) => outputAudioReceivedDiagnostics.push(diagnostic),
      onOutputAudioPlaybackReceipt: (receipt) => playbackReceipts.push(receipt),
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
      provider_connection_epoch: 1,
      provider_primary_category: 'setupComplete',
      provider_categories: ['setupComplete'],
    });
    expect(transcriptRelayBody).toMatchObject({
      session_id: 'browser-gemini-1',
      event: { serverContent: { outputTranscription: { text: 'Hi.' } } },
      provider_receive_sequence: 2,
      provider_relay_sequence: 2,
      provider_connection_epoch: 1,
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
    expect(outputAudioReceivedDiagnostics).toEqual([
      expect.objectContaining({
        providerConnectionEpoch: 1,
        providerReceiveSequence: 3,
        chunksInEvent: 1,
        playbackGeneration: 0,
      }),
    ]);
    expect(playbackReceipts.slice(0, 2)).toEqual([
      expect.objectContaining({ phase: 'scheduled', providerConnectionEpoch: 1 }),
      expect.objectContaining({ phase: 'started', providerConnectionEpoch: 1 }),
    ]);
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
      playbackStateAfter: expect.objectContaining({
        nextPlaybackTime: 0,
        activeSourceCount: 0,
        playbackGeneration: 1,
        queuedChunkCount: 0,
        playbackAheadSeconds: 0,
      }),
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

    expect(connection.flushOutputAudio()).toEqual({
      nextPlaybackTime: 0,
      activeSourceCount: 0,
      playbackGeneration: 2,
      queuedChunkCount: 0,
      playbackAheadSeconds: 0,
    });

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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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

  it('coalesces delta-like output transcription into bounded cumulative snapshots', async () => {
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
    await vi.waitFor(() => expect(coalescingDiagnostics).toHaveLength(2));

    firstPartialRelay.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const firstRelayBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    const secondRelayBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as Record<string, unknown>;
    expect(firstRelayBody).toMatchObject({
      provider_receive_sequence: 2,
      provider_relay_sequence: 2,
      event: { serverContent: { outputTranscription: { text: "You're asking" } } },
    });
    expect(secondRelayBody).toMatchObject({
      provider_receive_sequence: 5,
      provider_relay_sequence: 3,
      event: { serverContent: { outputTranscription: { text: "You're asking for a deeper understanding" } } },
    });
    expect(relayTraces.at(-1)).toMatchObject({
      throughput: {
        transcriptPartialsCoalesced: 2,
        transcriptPartialsDropped: 2,
        transcriptPartialsSent: 2,
        transcriptCoalescingDisabledReason: null,
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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

  it('keeps user transcripts, tools, cancellations, errors, and boundaries non-droppable behind a blocked transcript fragment', async () => {
    const firstPartialRelay = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-critical-events',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
    websocket?.emitMessage({ error: { code: 500, message: 'provider issue' } });
    websocket?.emitMessage({ serverContent: { turnComplete: true } });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    firstPartialRelay.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));

    const queuedBodies = fetchMock.mock.calls.slice(3, 8).map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
    expect(queuedBodies.map((body) => body.provider_relay_sequence)).toEqual([3, 4, 5, 6, 7]);
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
      event: { error: { code: 500, message: 'provider issue' } },
    });
    expect(queuedBodies[4]).toMatchObject({
      event: { serverContent: { turnComplete: true } },
    });

    await connection.close();
  });

  it('flushes the final assembled assistant transcript before the non-droppable turn boundary', async () => {
    const firstPartialRelay = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-gemini-final-boundary',
            websocket_url: 'wss://gemini.example/live',
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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

    const finalTranscriptBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as Record<string, unknown>;
    const boundaryBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as Record<string, unknown>;
    expect(finalTranscriptBody).toMatchObject({
      provider_relay_sequence: 3,
      event: {
        serverContent: {
          outputTranscription: { text: 'Partial in flight. Queued partial. Final caption.' },
        },
      },
    });
    expect(boundaryBody).toMatchObject({
      provider_relay_sequence: 4,
      event: { serverContent: { turnComplete: true } },
    });
    expect(boundaryBody).not.toMatchObject({ event: { serverContent: { outputTranscription: expect.anything() } } });

    await connection.close();
  });

  it('gates the exact same-response repeated question fixture before queued audio can mostly play', async () => {
    const fetchMock = makeGeminiBrowserSessionFetch('browser-gemini-repeated-intent');
    const fakeAudioContext = new FakeAudioContext();
    const gateDiagnostics: GeminiRepeatedIntentGateDiagnostic[] = [];
    const staleSuppressionDiagnostics: GeminiStaleOutputSuppressionDiagnostic[] = [];
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
      transcriptRelayCadenceMs: 0,
      outputAudioMaxPlaybackAheadSeconds: 0.75,
      onRepeatedIntentGate: (diagnostic) => gateDiagnostics.push(diagnostic),
      onStaleOutputSuppression: (diagnostic) => staleSuppressionDiagnostics.push(diagnostic),
    });

    const responseId = 'gemini-response-repeated-intent';
    const halfSecondAudio = Buffer.alloc(24_000).toString('base64');
    const emitAudio = () => websocket?.emitMessage({
      responseId,
      serverContent: {
        responseId,
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: halfSecondAudio } }],
        },
      },
    });
    emitAudio();
    emitAudio();
    emitAudio();
    await vi.waitFor(() => expect(fakeAudioContext.createdSources).toHaveLength(1));

    const fragments = [
      'Got it.',
      "Sounds like you're really deep in the design phase.",
      "What's",
      'the main blocker',
      'right now',
      'architecturally?',
      "You're in the thick of it, weighing the options.",
      "What's",
      'the biggest consideration',
      'right now',
      'between the separation of the control plane and the execution layer?',
    ];
    for (const text of fragments) {
      websocket?.emitMessage({
        responseId,
        serverContent: { responseId, outputTranscription: { text } },
      });
      await Promise.resolve();
      await Promise.resolve();
    }

    await vi.waitFor(() => expect(gateDiagnostics).toHaveLength(1));
    expect(gateDiagnostics[0]).toMatchObject({
      reason: 'repeated_intent_gate',
      responseId,
      questionCount: 2,
      playbackFlushed: true,
      playbackStateBefore: {
        activeSourceCount: 1,
        queuedChunkCount: 2,
        playbackGeneration: 0,
      },
      playbackStateAfter: {
        activeSourceCount: 0,
        queuedChunkCount: 0,
        playbackGeneration: 1,
      },
      rawProviderOutputTranscriptionUsed: true,
    });
    expect(staleSuppressionDiagnostics).toContainEqual(expect.objectContaining({
      outputType: 'audio',
      reason: 'repeated_intent_gate',
      responseId,
      assistantAudioDropReason: 'repeated_intent_gate',
      repeatedIntentGate: {
        questionCount: gateDiagnostics[0]?.questionCount,
        firstQuestionFingerprint: gateDiagnostics[0]?.firstQuestionFingerprint,
        secondQuestionFingerprint: gateDiagnostics[0]?.secondQuestionFingerprint,
        similarityScore: gateDiagnostics[0]?.similarityScore,
        matchedSignals: gateDiagnostics[0]?.matchedSignals,
      },
    }));
    expect(fakeAudioContext.createdSources[0]?.stop).toHaveBeenCalledTimes(1);

    emitAudio();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeAudioContext.createdSources).toHaveLength(1);

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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
        ephemeral_token: { value: 'auth_tokens/prod-test', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live', tools: [] },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-1',
        provider_event_relay_url: '/api/sophia/voice/gemini/relay',
        disconnect_url: '/api/sophia/voice/gemini/disconnect',
        public_event_boundary: 'SophiaEventNormalizer',
        transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
        provider_connection_epoch: 7,
        langsmith_trace_id: 'trace-gemini-prod-1',
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
    expect(connection.providerConnectionEpoch).toBe(7);
    expect(connection.getProviderConnectionEpoch()).toBe(7);
    expect(connection.langsmithTraceId).toBe('trace-gemini-prod-1');
    expect(connection.langsmithTraceStatus).toBe('available');
    expect(connection.langsmithTraceUnavailableReason).toBeNull();
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

  it('settles an initial credential as activation-aborted when microphone setup fails before socket creation', async () => {
    const disconnectBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sophia/voice/gemini/disconnect') {
        disconnectBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return acceptedSyntheticDisconnectResponse(init);
    });

    await expect(connectGeminiBrowserLiveFromBootstrap({
      userId: 'voice-lab-user-1',
      bootstrap: syntheticProductionBootstrap('gemini-initial-abort'),
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: () => {
        throw new Error('socket must not be constructed');
      },
      getUserMedia: vi.fn(async () => {
        throw new Error('microphone unavailable');
      }),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    })).rejects.toThrow('microphone unavailable');

    expect(disconnectBodies).toHaveLength(1);
    expect(disconnectBodies[0]?.browser_provider_close_receipts).toEqual([]);
    expect(disconnectBodies[0]?.browser_provider_activation_abort_receipts).toEqual([
      expect.objectContaining({
        schema: 'sophia_gemini_browser_provider_activation_abort_v1',
        session_id: 'gemini-initial-abort',
        previous_activated_epoch: 0,
        candidate_epoch: 1,
        websocket_created: false,
      }),
    ]);
  });

  it('settles a socket opened before a lost activation acknowledgement with an exact close receipt', async () => {
    const sockets: FakeWebSocket[] = [];
    const disconnectBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sophia/voice/gemini/activate') {
        return new Response(JSON.stringify({ unavailable: true }), { status: 503 });
      }
      if (String(input) === '/api/sophia/voice/gemini/disconnect') {
        disconnectBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return acceptedSyntheticDisconnectResponse(init);
    });

    await expect(connectGeminiBrowserLiveFromBootstrap({
      userId: 'voice-lab-user-1',
      bootstrap: syntheticProductionBootstrap('gemini-open-before-activation-loss'),
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    })).rejects.toThrow('Synthetic provider activation was not acknowledged.');

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.readyState).toBe(3);
    expect(disconnectBodies).toHaveLength(1);
    expect(disconnectBodies[0]?.browser_provider_close_receipts).toEqual([
      expect.objectContaining({
        schema: 'sophia_gemini_browser_provider_close_v1',
        session_id: 'gemini-open-before-activation-loss',
        provider_connection_epoch: 1,
        websocket_close_observed: true,
      }),
    ]);
    expect(disconnectBodies[0]?.browser_provider_activation_abort_receipts).toEqual([]);
  });

  it('closes every tracked provider socket before awaiting a stalled earlier close event', async () => {
    const sockets: FakeWebSocket[] = [];
    const continuationUrl = '/api/sophia/voice/gemini/continue-cleanup-race';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === continuationUrl) {
        return new Response(JSON.stringify(syntheticProductionBootstrap(
          'gemini-close-all-epochs',
          {
            websocket_url: 'wss://gemini.example/live-continuation',
            continuation_bootstrap_url: continuationUrl,
            provider_connection_epoch: 2,
          },
        )), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return acceptedSyntheticDisconnectResponse(init);
    });
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: 'voice-lab-user-1',
      bootstrap: syntheticProductionBootstrap('gemini-close-all-epochs', {
        continuation_bootstrap_url: continuationUrl,
      }),
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        const socket = sockets.length === 0
          ? new StallingCloseFakeWebSocket(url)
          : new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });
    sockets[0]?.emitMessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'safe-close-all-handle' },
    });
    sockets[0]?.emitMessage({ goAway: { timeLeft: '5s' } });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect((sockets[0] as StallingCloseFakeWebSocket).closeCalls).toBe(1));

    const closing = connection.close({ providerConnectionEpochs: [1, 2] });
    await vi.waitFor(() => expect(sockets[1]?.readyState).toBe(3));
    expect((sockets[0] as StallingCloseFakeWebSocket).closeCalls).toBeGreaterThanOrEqual(1);
    (sockets[0] as StallingCloseFakeWebSocket).emitClose(1000, 'observed after candidate close', true);
    const acknowledgement = await closing;

    const disconnectCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/sophia/voice/gemini/disconnect',
    );
    const disconnectBody = JSON.parse(
      String((disconnectCall?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    expect(disconnectBody.browser_provider_close_receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_connection_epoch: 1 }),
      expect.objectContaining({ provider_connection_epoch: 2 }),
    ]));
    expect(acknowledgement).toEqual({
      browser_provider_close_receipts: disconnectBody.browser_provider_close_receipts,
      browser_provider_activation_abort_receipts: disconnectBody.browser_provider_activation_abort_receipts,
    });
  });

  it('replays the exact closed receipt set after a lost disconnect acknowledgement', async () => {
    let disconnectAttempts = 0;
    const disconnectBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sophia/voice/gemini/disconnect') {
        disconnectAttempts += 1;
        disconnectBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (disconnectAttempts === 1) return new Response(JSON.stringify({ pending: true }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return acceptedSyntheticDisconnectResponse(init);
    });
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: 'voice-lab-user-1',
      bootstrap: syntheticProductionBootstrap('gemini-cleanup-ack-replay'),
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => new FakeWebSocket(url),
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });

    await expect(connection.close({ providerConnectionEpochs: [1] })).rejects.toThrow('Synthetic provider close receipt was not accepted');
    const acknowledgement = await connection.close({ providerConnectionEpochs: [1] });
    expect(disconnectBodies).toHaveLength(2);
    expect(disconnectBodies[1]).toEqual(disconnectBodies[0]);
    expect(acknowledgement).toEqual({
      browser_provider_close_receipts: disconnectBodies[1]?.browser_provider_close_receipts,
      browser_provider_activation_abort_receipts: disconnectBodies[1]?.browser_provider_activation_abort_receipts,
    });
  });

  it('rejects a 202 response whose echoed browser receipt arrays drift', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const accepted = acceptedSyntheticDisconnectResponse(init);
      const body = await accepted.json() as Record<string, unknown>;
      if (Array.isArray(body.browser_provider_close_receipts)) body.browser_provider_close_receipts = [];
      return new Response(JSON.stringify(body), { status: 202, headers: { 'Content-Type': 'application/json' } });
    });
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: 'voice-lab-user-1',
      bootstrap: syntheticProductionBootstrap('gemini-cleanup-ack-drift'),
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => new FakeWebSocket(url),
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
    });
    await expect(connection.close({ providerConnectionEpochs: [1] })).rejects.toThrow('Synthetic provider settlement acknowledgement did not match');
  });

  it('closes the spend-bearing provider socket before awaiting stalled media teardown', async () => {
    const fakeAudioContext = new FakeAudioContext();
    let releaseAudioTeardown!: () => void;
    const stalledAudioTeardown = new Promise<void>((resolve) => {
      releaseAudioTeardown = resolve;
    });
    fakeAudioContext.close = vi.fn(() => stalledAudioTeardown);
    let socket: FakeWebSocket | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      acceptedSyntheticDisconnectResponse(init)
    ));
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: 'voice-lab-user-1',
      bootstrap: syntheticProductionBootstrap('gemini-close-before-media-await'),
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
    });

    let cleanupSettled = false;
    const closing = connection
      .close({ providerConnectionEpochs: [1] })
      .finally(() => {
        cleanupSettled = true;
      });

    await vi.waitFor(() => expect(socket?.readyState).toBe(3));
    expect(fakeAudioContext.close).toHaveBeenCalledTimes(1);
    expect(cleanupSettled).toBe(false);
    releaseAudioTeardown();
    await closing;
  });

  it('captures app-bound governed trace-fault applied and restored receipts', async () => {
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-v-l01',
      scenario_id: 'V-L01',
      scenario_version: 'vt00.scenarios.v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const applied = {
      schema: 'sophia_voice_lab_trace_fault_v1' as const,
      fault: 'langsmith_unavailable' as const,
      phase: 'applied' as const,
      principal_id: syntheticTest.principal_id,
      test_run_id: syntheticTest.test_run_id,
      scenario_id: syntheticTest.scenario_id,
      scenario_version: syntheticTest.scenario_version,
      environment: syntheticTest.environment,
      expected_deployment: {
        frontend: 'a'.repeat(40),
        backend: 'b'.repeat(40),
        voice: 'c'.repeat(40),
      },
      trace_unavailable: true as const,
      canonical_behavior_unchanged: true as const,
      applied_at: '2026-08-23T12:00:00.000Z',
      restored_at: null,
    };
    const restored = {
      ...applied,
      phase: 'restored' as const,
      restored_at: '2026-08-23T12:05:00.000Z',
    };
    const receipts: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sophia/voice/gemini/disconnect') {
        return acceptedSyntheticDisconnectResponse(init, {
          ok: true,
          closed: true,
          trace_fault: restored,
        });
      }
      return acceptedSyntheticDisconnectResponse(init);
    });
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: syntheticTest.principal_id,
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-prod-v-l01',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/prod-v-l01', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live', tools: [] },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-v-l01',
        provider_event_relay_url: '/api/sophia/voice/gemini/relay',
        disconnect_url: '/api/sophia/voice/gemini/disconnect',
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        provider_connection_epoch: 1,
        langsmith_trace_id: null,
        synthetic_test: syntheticTest,
        ...providerCleanupFields(syntheticTest, 'gemini-prod-v-l01'),
        trace_fault: applied,
      },
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => new FakeWebSocket(url),
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onSyntheticTraceFaultReceipt: (receipt) => receipts.push(receipt),
    });

    expect(connection.langsmithTraceId).toBeNull();
    expect(connection.langsmithTraceUnavailableReason).toBe('governed_synthetic_fault');
    expect(connection.syntheticTraceFault).toEqual(applied);
    expect(receipts).toEqual([applied]);
    await connection.close();
    expect(receipts).toEqual([applied, restored]);
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
    const epochReceipts: GeminiProviderConnectionEpochReceipt[] = [];
    const continuationUrl = '/api/sophia/voice/gemini/continue';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === continuationUrl) {
        return new Response(JSON.stringify({
          session_id: 'gemini-prod-reconnect',
          websocket_url: 'wss://gemini.example/live-reconnected',
          ephemeral_token: { value: 'auth_tokens/reconnected', expireTime: '2033-05-18T04:03:20.000Z' },
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
        ephemeral_token: { value: 'auth_tokens/initial', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live', sessionResumption: {} },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-reconnect',
        continuation_bootstrap_url: continuationUrl,
        provider_connection_epoch: 1,
        langsmith_trace_id: 'trace-reconnect-stable',
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
      onProviderConnectionEpoch: (receipt) => epochReceipts.push(receipt),
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
    expect(connection.providerConnectionEpoch).toBe(2);
    expect(connection.getProviderConnectionEpoch()).toBe(2);
    expect(connection.langsmithTraceId).toBe('trace-reconnect-stable');
    expect(epochReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'bootstrap',
        providerConnectionEpoch: 1,
        langsmithTraceId: 'trace-reconnect-stable',
      }),
      expect.objectContaining({
        phase: 'rotated',
        previousProviderConnectionEpoch: 1,
        providerConnectionEpoch: 2,
        langsmithTraceId: 'trace-reconnect-stable',
      }),
      expect.objectContaining({
        phase: 'restored',
        providerConnectionEpoch: 2,
        continuityState: 'active',
      }),
    ]));
    const continuationCall = fetchMock.mock.calls.find(([input]) => String(input) === continuationUrl);
    expect(JSON.parse(String((continuationCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      expected_epoch: 1,
      handle_present: true,
      secret_generation: 1,
    });

    await connection.close();
  });

  it('rejects a continuation bootstrap bound to another synthetic test run', async () => {
    const stages: GeminiBrowserLiveDogfoodStage[] = [];
    const sockets: FakeWebSocket[] = [];
    const continuationUrl = '/api/sophia/voice/gemini/continue';
    const syntheticRunA: GeminiSyntheticTestContext = {
      synthetic: true,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-A',
      scenario_id: 'vt00-realtime-001',
      scenario_version: 'v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === continuationUrl) {
        const continuationSyntheticTest: GeminiSyntheticTestContext = {
          ...syntheticRunA,
          test_run_id: 'run-B',
        };
        return new Response(JSON.stringify({
          session_id: 'gemini-prod-cross-run',
          websocket_url: 'wss://gemini.example/live-reconnected',
          ephemeral_token: { value: 'auth_tokens/reconnected', expireTime: '2033-05-18T04:03:20.000Z' },
          setup: { model: 'models/gemini-live', sessionResumption: {} },
          stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-cross-run',
          continuation_bootstrap_url: continuationUrl,
          provider_connection_epoch: 2,
          synthetic_test: continuationSyntheticTest,
          ...providerCleanupFields(
            continuationSyntheticTest,
            'gemini-prod-cross-run',
            { jti: '123e4567-e89b-42d3-a456-426614174003' },
          ),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return acceptedSyntheticDisconnectResponse(init);
    });
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: 'voice-lab-user-1',
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-prod-cross-run',
        websocket_url: 'wss://gemini.example/live-initial',
        ephemeral_token: { value: 'auth_tokens/initial', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live', sessionResumption: {} },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-cross-run',
        continuation_bootstrap_url: continuationUrl,
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        provider_connection_epoch: 1,
        synthetic_test: syntheticRunA,
        ...providerCleanupFields(syntheticRunA, 'gemini-prod-cross-run'),
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
    expect(connection.syntheticTest?.test_run_id).toBe('run-A');
    sockets[0]?.emitMessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'safe-handle-run-A' },
    });
    sockets[0]?.emitClose(1011, 'provider transport reset', false);

    await vi.waitFor(() => expect(stages).toContain('connection_lost'));
    expect(sockets).toHaveLength(1);
    expect(connection.providerConnectionEpoch).toBe(1);
    await connection.close();
  });

  it('binds independently measured outgoing PCM and accepted turns to the exact injected operation', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const legReceipts: GeminiSyntheticInputLegReceipt[] = [];
    const turnReceipts: GeminiSyntheticInputTurnReceipt[] = [];
    const inputDiagnostics: GeminiInputAudioActivityDiagnostic[] = [];
    let websocket: FakeWebSocket | null = null;
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-input-evidence-A',
      scenario_id: 'vt00-input-001',
      scenario_version: 'v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: syntheticTest.principal_id,
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-input-evidence',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/input-evidence', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live', inputAudioTranscription: {} },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-input-evidence',
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        provider_connection_epoch: 3,
        synthetic_test: syntheticTest,
        ...providerCleanupFields(syntheticTest, 'gemini-input-evidence'),
      },
      fetchFn: vi.fn(async (_input, init) => acceptedSyntheticDisconnectResponse(init)) as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onInputAudioActivity: (diagnostic) => inputDiagnostics.push(diagnostic),
      onSyntheticInputLegReceipt: (receipt) => legReceipts.push(receipt),
      onSyntheticInputTurnReceipt: (receipt) => turnReceipts.push(receipt),
    });
    const sourceSha = 'a'.repeat(64);
    const signal = (phase: string, testRunId = syntheticTest.test_run_id) => ({
      schema: 'sophia_voice_lab_input_operation_v1',
      phase,
      test_run_id: testRunId,
      cleanup_obligation_id: syntheticTest.cleanup_obligation_id,
      operation_id: 'operation-input-1',
      utterance_id: 'utterance-input-1',
      source_sha256: sourceSha,
      expected_silence: false,
      settlement_window_ms: 5_000,
    });

    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', {
      detail: signal('scheduled'),
    }));
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', {
      detail: signal('started'),
    }));
    fakeAudioContext.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
      outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(4096) },
    } as unknown as AudioProcessingEvent);
    expect(inputDiagnostics.at(-1)).toMatchObject({
      eventType: 'input_audio_frame_sent',
      syntheticInputOperation: {
        test_run_id: syntheticTest.test_run_id,
        operation_id: 'operation-input-1',
        utterance_id: 'utterance-input-1',
        phase: 'started',
      },
      outgoingPcm: {
        nonzero_sample_count: expect.any(Number),
        raw_audio_excluded: true,
      },
    });
    expect(inputDiagnostics.at(-1)?.outgoingPcm?.nonzero_sample_count).toBeGreaterThan(0);

    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'hello' } } });
    await vi.waitFor(() => expect(turnReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'provider_input_transcription',
        outcome: 'provider_input_transcription_observed',
        test_run_id: syntheticTest.test_run_id,
        operation_id: 'operation-input-1',
      }),
    ])));
    connection.acknowledgeSyntheticPublicUserTurn({
      publicUtteranceId: 'public-user-turn-1',
      transcriptLength: 5,
    });
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', {
      detail: signal('completed'),
    }));
    await vi.waitFor(() => expect(legReceipts).toHaveLength(1));
    expect(legReceipts[0]).toMatchObject({
      schema: 'sophia_gemini_input_leg_v1',
      status: 'verified',
      reason: 'outgoing_pcm_non_silent_observed',
      test_run_id: syntheticTest.test_run_id,
      operation_id: 'operation-input-1',
      utterance_id: 'utterance-input-1',
      provider_connection_epoch: 3,
      nonzero_sample_count: expect.any(Number),
      pcm_digest_algorithm: 'sha-256-chain-v1',
      raw_audio_excluded: true,
    });
    expect(legReceipts[0]?.pcm_sha256_chain).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(legReceipts)).not.toContain('audioBase64');
    expect(turnReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'public_user_turn',
        outcome: 'public_user_turn_accepted',
        public_utterance_id: 'public-user-turn-1',
      }),
    ]));
    await connection.close();
  });

  it('binds one synthetic Builder tool settlement to app-authored input, effect, epoch, task, and run ids', async () => {
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-builder-join-A',
      scenario_id: 'V-B01',
      scenario_version: 'vt00.scenarios.v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const ledgerUpdates: import('../app/lib/gemini-browser-live-websocket-dogfood').GeminiBrowserLiveToolCallLedgerEntry[] = [];
    const builderInteractionFaults: GeminiSyntheticInteractionFaultReceipt[] = [];
    const relayBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      relayBodies.push(body);
      const event = body.event as { toolCall?: unknown } | undefined;
      if (!event?.toolCall) {
        return acceptedSyntheticDisconnectResponse(init);
      }
      const evidence = (body.synthetic_tool_evidence as Array<Record<string, unknown>>)[0];
      const join = {
        schema: 'sophia_synthetic_builder_join_v1',
        test_run_id: evidence.test_run_id,
        scenario_id: evidence.scenario_id,
        scenario_version: evidence.scenario_version,
        operation_id: evidence.operation_id,
        utterance_id: evidence.utterance_id,
        provider_input_sequence: evidence.provider_input_sequence,
        tool_call_id: evidence.tool_call_id,
        effect_id: evidence.effect_id,
        provider_connection_epoch: evidence.provider_connection_epoch,
        relay_correlation_id: evidence.relay_correlation_id,
        tool_name: evidence.tool_name,
        tool_state: 'backend_accepted',
        builder_operation_id: 'builder-operation-001',
        parent_thread_id: 'parent-thread-001',
        task_id: 'builder-task-001',
        thread_id: 'builder-task-001',
        run_id: 'builder-run-001',
        build_id: 'builder-operation-001',
        artifact_id: null,
        artifact_path_sha256: null,
        ui_projection_state: null,
        cancel_count: 0,
        no_post_cancel_publication: true,
        source_tool_received_at: evidence.received_at,
        source_backend_accepted_at: '2026-08-23T12:00:01.000Z',
        source_tool_response_sent_at: null,
        source_builder_event_id: null,
        source_builder_event_at: null,
        source_ui_projected_at: null,
        scenario_assertions: {
          artifact_created: false,
          artifact_visible_current: false,
          accepted_turn_count: 1,
          tool_dispatch_count: 1,
          owned_task_count: 1,
          stable_task_identity: true,
          revision_updated_same_task: false,
          current_behavior_result: false,
          cancel_request_count: 0,
          cancel_terminal_settled: false,
          no_post_cancel_publication: true,
        },
      };
      return new Response(JSON.stringify({
        accepted: true,
        client_actions: [{
          type: 'gemini_tool_response',
          payload: {
            toolResponse: {
              functionResponses: [{
                id: 'builder-call-001',
                name: 'start_builder_task',
                response: {
                  ok: true,
                  status: 'running',
                  task_id: 'builder-task-001',
                  run_id: 'builder-run-001',
                  synthetic_builder_join: join,
                },
              }],
            },
          },
        }],
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    let websocket: FakeWebSocket | null = null;
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: syntheticTest.principal_id,
      threadId: 'parent-thread-001',
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-builder-join',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/builder-join', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: {
          model: 'models/gemini-live',
          inputAudioTranscription: {},
          tools: [{ functionDeclarations: [{ name: 'start_builder_task' }] }],
        },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-builder-join',
        provider_event_relay_url: '/api/sophia/voice/gemini/relay',
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        provider_connection_epoch: 7,
        synthetic_test: syntheticTest,
        ...providerCleanupFields(syntheticTest, 'gemini-builder-join'),
      },
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onToolCallLedgerUpdate: (entry) => ledgerUpdates.push(entry),
      onSyntheticInteractionFaultReceipt: (receipt) => builderInteractionFaults.push(receipt),
    });
    const operation = (phase: string) => ({
      schema: 'sophia_voice_lab_input_operation_v1',
      phase,
      test_run_id: syntheticTest.test_run_id,
      cleanup_obligation_id: syntheticTest.cleanup_obligation_id,
      operation_id: 'operation-builder-001',
      utterance_id: 'utterance-builder-001',
      source_sha256: 'd'.repeat(64),
      expected_silence: false,
      settlement_window_ms: 5_000,
    });
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: operation('scheduled') }));
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: operation('started') }));
    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'Create an HTML brief.' } } });
    await vi.waitFor(() => expect(relayBodies.length).toBeGreaterThan(0));
    connection.acknowledgeSyntheticPublicUserTurn({
      publicUtteranceId: 'public-builder-001',
      transcriptLength: 21,
    });
    websocket?.emitMessage({
      toolCall: {
        functionCalls: [{
          id: 'builder-call-001',
          name: 'start_builder_task',
          args: { description: 'Create an HTML brief.', task_type: 'document' },
        }],
      },
    });

    await vi.waitFor(() => expect(ledgerUpdates.some((entry) => (
      entry.toolCallId === 'builder-call-001' && entry.finalState === 'responded'
    ))).toBe(true));
    const terminal = ledgerUpdates.filter((entry) => entry.toolCallId === 'builder-call-001').at(-1);
    expect(terminal).toMatchObject({
      providerConnectionEpoch: 7,
      finalState: 'responded',
      syntheticToolEvidence: {
        test_run_id: syntheticTest.test_run_id,
        operation_id: 'operation-builder-001',
        utterance_id: 'utterance-builder-001',
        provider_input_sequence: 2,
        public_utterance_id: 'public-builder-001',
        tool_call_id: 'builder-call-001',
        provider_connection_epoch: 7,
      },
      syntheticBuilderJoin: {
        test_run_id: syntheticTest.test_run_id,
        operation_id: 'operation-builder-001',
        task_id: 'builder-task-001',
        thread_id: 'builder-task-001',
        run_id: 'builder-run-001',
        tool_state: 'responded',
        source_tool_response_sent_at: expect.any(String),
      },
    });
    expect(terminal?.effectId).toMatch(/^effect:[a-f0-9-]{36}$/);
    expect(terminal?.syntheticBuilderJoin?.effect_id).toBe(terminal?.effectId);
    expect(builderInteractionFaults).toEqual([]);
    await connection.close();
  });

  it('binds one accepted synthetic input to its exact assistant response, output chunks, and playback', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const interactionReceipts: GeminiSyntheticInteractionReceipt[] = [];
    const interactionFaults: GeminiSyntheticInteractionFaultReceipt[] = [];
    const inputTurns: GeminiSyntheticInputTurnReceipt[] = [];
    const outputReceived: GeminiOutputAudioReceivedDiagnostic[] = [];
    const playbackReceipts: GeminiOutputAudioPlaybackReceipt[] = [];
    let websocket: FakeWebSocket | null = null;
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-interaction-A',
      scenario_id: 'V-A01',
      scenario_version: 'vt00.scenarios.v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: syntheticTest.principal_id,
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-interaction-lineage',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/interaction-lineage', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live', inputAudioTranscription: {} },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-interaction-lineage',
        provider_event_relay_url: '/api/sophia/voice/gemini/relay',
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        provider_connection_epoch: 9,
        synthetic_test: syntheticTest,
        ...providerCleanupFields(syntheticTest, 'gemini-interaction-lineage'),
      },
      fetchFn: vi.fn(async (_input, init) => acceptedSyntheticDisconnectResponse(init)) as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onSyntheticInputTurnReceipt: (receipt) => inputTurns.push(receipt),
      onSyntheticInteractionReceipt: (receipt) => interactionReceipts.push(receipt),
      onSyntheticInteractionFaultReceipt: (receipt) => interactionFaults.push(receipt),
      onOutputAudioReceived: (diagnostic) => outputReceived.push(diagnostic),
      onOutputAudioPlaybackReceipt: (receipt) => playbackReceipts.push(receipt),
    });
    const operation = (phase: string) => ({
      schema: 'sophia_voice_lab_input_operation_v1',
      phase,
      test_run_id: syntheticTest.test_run_id,
      cleanup_obligation_id: syntheticTest.cleanup_obligation_id,
      operation_id: 'operation-a01-001',
      utterance_id: 'utterance-a01-001',
      source_sha256: 'a'.repeat(64),
      expected_silence: false,
      settlement_window_ms: 5_000,
    });
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: operation('scheduled') }));
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: operation('started') }));
    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'Tell me the result.' } } });
    await vi.waitFor(() => expect(inputTurns.some((receipt) => (
      receipt.outcome === 'provider_input_transcription_observed'
    ))).toBe(true));
    connection.acknowledgeSyntheticPublicUserTurn({
      publicUtteranceId: 'public-a01-001',
      transcriptLength: 19,
    });

    const audioChunk = Buffer.from([0x00, 0x00, 0x01, 0x00]).toString('base64');
    websocket?.emitMessage({
      eventId: 'provider-event-a01-001',
      responseId: 'provider-response-a01-001',
      serverContent: {
        responseId: 'provider-response-a01-001',
        outputTranscription: { text: 'Here is the result.' },
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audioChunk } }],
        },
        turnComplete: true,
      },
    });

    await vi.waitFor(() => expect(interactionReceipts.some((receipt) => (
      receipt.phase === 'assistant_response_completed'
    ))).toBe(true));
    const assigned = interactionReceipts.find((receipt) => receipt.phase === 'assistant_response_assigned');
    const completed = interactionReceipts.find((receipt) => receipt.phase === 'assistant_response_completed');
    expect(assigned).toMatchObject({
      schema: 'sophia_gemini_interaction_v1',
      test_run_id: syntheticTest.test_run_id,
      scenario_id: 'V-A01',
      operation_id: 'operation-a01-001',
      utterance_id: 'utterance-a01-001',
      public_utterance_id: 'public-a01-001',
      response_id: 'provider-response-a01-001',
      assistant_turn_id: 'provider-response-a01-001',
      provider_connection_epoch: 9,
      raw_audio_excluded: true,
      raw_transcript_excluded: true,
      secrets_excluded: true,
    });
    expect(completed).toMatchObject({
      interaction_id: assigned?.interaction_id,
      response_boundary_reason: 'turn_complete',
      output_audio_received_count: 1,
      output_audio_playback_scheduled_count: 1,
      output_audio_playback_started_count: 1,
    });
    expect(outputReceived[0]?.syntheticInteraction).toMatchObject({
      interaction_id: assigned?.interaction_id,
      operation_id: 'operation-a01-001',
      response_id: 'provider-response-a01-001',
    });
    expect(playbackReceipts.find((receipt) => receipt.phase === 'scheduled')?.syntheticInteraction).toMatchObject({
      interaction_id: assigned?.interaction_id,
      assistant_turn_id: 'provider-response-a01-001',
    });
    fakeAudioContext.createdSources[0]?.onended?.();
    expect(interactionReceipts.at(-1)).toMatchObject({
      phase: 'output_settled',
      interaction_id: assigned?.interaction_id,
      output_audio_playback_completed_count: 1,
    });
    expect(interactionFaults).toEqual([]);
    await connection.close();
  });

  it('hard-fails an ambiguous synthetic assistant response without a stable response id', async () => {
    const interactionFaults: GeminiSyntheticInteractionFaultReceipt[] = [];
    const inputTurns: GeminiSyntheticInputTurnReceipt[] = [];
    let websocket: FakeWebSocket | null = null;
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-interaction-missing-response',
      scenario_id: 'V-A03',
      scenario_version: 'vt00.scenarios.v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: syntheticTest.principal_id,
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-interaction-missing-response',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/interaction-missing-response', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live', inputAudioTranscription: {} },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-interaction-missing-response',
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        provider_connection_epoch: 3,
        synthetic_test: syntheticTest,
        ...providerCleanupFields(syntheticTest, 'gemini-interaction-missing-response'),
      },
      fetchFn: vi.fn(async (_input, init) => acceptedSyntheticDisconnectResponse(init)) as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => new FakeAudioContext() as unknown as AudioContext,
      onSyntheticInputTurnReceipt: (receipt) => inputTurns.push(receipt),
      onSyntheticInteractionFaultReceipt: (receipt) => interactionFaults.push(receipt),
    });
    const operation = (phase: string) => ({
      schema: 'sophia_voice_lab_input_operation_v1',
      phase,
      test_run_id: syntheticTest.test_run_id,
      cleanup_obligation_id: syntheticTest.cleanup_obligation_id,
      operation_id: 'operation-a03-001',
      utterance_id: 'utterance-a03-001',
      source_sha256: 'b'.repeat(64),
      expected_silence: false,
      settlement_window_ms: 5_000,
    });
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: operation('scheduled') }));
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: operation('started') }));
    websocket?.emitMessage({ serverContent: { inputTranscription: { text: 'Continue.' } } });
    await vi.waitFor(() => expect(inputTurns.some((receipt) => (
      receipt.outcome === 'provider_input_transcription_observed'
    ))).toBe(true));
    connection.acknowledgeSyntheticPublicUserTurn({ publicUtteranceId: 'public-a03-001', transcriptLength: 9 });
    websocket?.emitMessage({ serverContent: { outputTranscription: { text: 'Ambiguous.' } } });

    await vi.waitFor(() => expect(interactionFaults).toEqual([
      expect.objectContaining({ code: 'interaction_response_id_missing' }),
    ]));
    expect(websocket?.readyState).toBe(3);
    await connection.close();
  });

  it.each([
    ['cross-run', 'input_operation_signal_binding_mismatch'],
    ['cross-cleanup', 'input_operation_signal_binding_mismatch'],
    ['malformed', 'input_operation_signal_malformed'],
  ] as const)('hard-fails a %s Voice Lab input signal instead of silently dropping provenance', async (kind, expectedCode) => {
    const fakeAudioContext = new FakeAudioContext();
    const faultReceipts: GeminiSyntheticInputFaultReceipt[] = [];
    let websocket: FakeWebSocket | null = null;
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-input-fault-A',
      scenario_id: 'vt00-input-fault-001',
      scenario_version: 'v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: syntheticTest.principal_id,
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: `gemini-input-fault-${kind}`,
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/input-fault', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live' },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-input-fault',
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        synthetic_test: syntheticTest,
        ...providerCleanupFields(syntheticTest, `gemini-input-fault-${kind}`),
      },
      fetchFn: vi.fn(async (_input, init) => acceptedSyntheticDisconnectResponse(init)) as typeof fetch,
      webSocketFactory: (url) => {
        websocket = new FakeWebSocket(url);
        return websocket;
      },
      getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onSyntheticInputFaultReceipt: (receipt) => faultReceipts.push(receipt),
    });
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', {
      detail: {
        schema: 'sophia_voice_lab_input_operation_v1',
        phase: 'scheduled',
        test_run_id: kind === 'cross-run' ? 'run-input-fault-B' : syntheticTest.test_run_id,
        cleanup_obligation_id: kind === 'cross-cleanup'
          ? '123e4567-e89b-42d3-a456-426614174999'
          : syntheticTest.cleanup_obligation_id,
        operation_id: 'operation-fault-1',
        utterance_id: 'utterance-fault-1',
        source_sha256: 'c'.repeat(64),
        expected_silence: false,
        settlement_window_ms: 3_000,
        ...(kind === 'malformed' ? { unknown_field: true } : {}),
      },
    }));

    expect(faultReceipts).toEqual([
      expect.objectContaining({
        schema: 'sophia_gemini_input_fault_v1',
        test_run_id: syntheticTest.test_run_id,
        code: expectedCode,
        raw_audio_excluded: true,
      }),
    ]);
    expect(websocket?.readyState).toBe(3);
    await connection.close();
  });

  it('hard-fails a next operation started inside the prior settlement window', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const faultReceipts: GeminiSyntheticInputFaultReceipt[] = [];
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-input-overlap-A',
      scenario_id: 'vt00-input-overlap-001',
      scenario_version: 'v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: syntheticTest.principal_id,
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-input-overlap',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/input-overlap', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live' },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-input-overlap',
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        synthetic_test: syntheticTest,
        ...providerCleanupFields(syntheticTest, 'gemini-input-overlap'),
      },
      fetchFn: vi.fn(async (_input, init) => acceptedSyntheticDisconnectResponse(init)) as typeof fetch,
      webSocketFactory: (url) => new FakeWebSocket(url),
      getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onSyntheticInputFaultReceipt: (receipt) => faultReceipts.push(receipt),
    });
    const signal = (phase: string, ordinal: number) => ({
      schema: 'sophia_voice_lab_input_operation_v1',
      phase,
      test_run_id: syntheticTest.test_run_id,
      cleanup_obligation_id: syntheticTest.cleanup_obligation_id,
      operation_id: `operation-overlap-${ordinal}`,
      utterance_id: `utterance-overlap-${ordinal}`,
      source_sha256: String(ordinal).repeat(64),
      expected_silence: false,
      settlement_window_ms: 5_000,
    });
    for (const phase of ['scheduled', 'started', 'completed']) {
      window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: signal(phase, 1) }));
    }
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: signal('scheduled', 2) }));
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: signal('started', 2) }));

    expect(faultReceipts).toEqual([
      expect.objectContaining({
        code: 'input_operation_overlap_forbidden',
        test_run_id: syntheticTest.test_run_id,
      }),
    ]);
    await connection.close();
  });

  it('certifies exact-window silence only after a bounded no-turn settlement', async () => {
    const fakeAudioContext = new FakeAudioContext();
    const legReceipts: GeminiSyntheticInputLegReceipt[] = [];
    const turnReceipts: GeminiSyntheticInputTurnReceipt[] = [];
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-silence-A',
      scenario_id: 'vt00-silence-001',
      scenario_version: 'v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    const connection = await connectGeminiBrowserLiveFromBootstrap({
      userId: syntheticTest.principal_id,
      bootstrap: {
        runtime: 'gemini_live',
        voice_runtime: 'gemini_live',
        production_route: true,
        session_id: 'gemini-input-silence',
        websocket_url: 'wss://gemini.example/live',
        ephemeral_token: { value: 'auth_tokens/input-silence', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live', inputAudioTranscription: {} },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-input-silence',
        provider_activation_url: '/api/sophia/voice/gemini/activate',
        synthetic_test: syntheticTest,
        ...providerCleanupFields(syntheticTest, 'gemini-input-silence'),
      },
      fetchFn: vi.fn(async (_input, init) => acceptedSyntheticDisconnectResponse(init)) as typeof fetch,
      webSocketFactory: (url) => new FakeWebSocket(url),
      getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream)),
      audioContextFactory: () => fakeAudioContext as unknown as AudioContext,
      onSyntheticInputLegReceipt: (receipt) => legReceipts.push(receipt),
      onSyntheticInputTurnReceipt: (receipt) => turnReceipts.push(receipt),
    });
    const detail = (phase: string) => ({
      schema: 'sophia_voice_lab_input_operation_v1',
      phase,
      test_run_id: syntheticTest.test_run_id,
      cleanup_obligation_id: syntheticTest.cleanup_obligation_id,
      operation_id: 'operation-silence-1',
      utterance_id: 'utterance-silence-1',
      source_sha256: 'b'.repeat(64),
      expected_silence: true,
      settlement_window_ms: 1_000,
    });
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: detail('scheduled') }));
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: detail('started') }));
    fakeAudioContext.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4096) },
      outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(4096) },
    } as unknown as AudioProcessingEvent);
    vi.useFakeTimers();
    window.dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: detail('completed') }));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    vi.useRealTimers();

    await vi.waitFor(() => expect(legReceipts).toHaveLength(1));
    expect(legReceipts[0]).toMatchObject({
      status: 'verified',
      reason: 'outgoing_pcm_silence_observed',
      expected_silence: true,
      nonzero_sample_count: 0,
    });
    expect(turnReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'settlement',
        outcome: 'no_user_turn_observed',
        operation_id: 'operation-silence-1',
      }),
    ]));
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
        ephemeral_token: { value: 'auth_tokens/initial', expireTime: '2033-05-18T04:03:20.000Z' },
        setup: { model: 'models/gemini-live' },
        stream_url: '/api/sophia/voice/gemini/events?session_id=gemini-prod-no-resume',
      },
      fetchFn: vi.fn(async (_input, init) => acceptedSyntheticDisconnectResponse(init)) as typeof fetch,
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
    const ledgerUpdates: Array<{
      toolCallId: string;
      effectId: string;
      providerConnectionEpoch: number;
      finalState: string;
    }> = [];
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
        effectId: entry.effectId,
        providerConnectionEpoch: entry.providerConnectionEpoch,
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
    const exactToolReceipts = ledgerUpdates.filter((entry) => (
      entry.toolCallId === 'generic-check-placeholder'
    ));
    expect(new Set(exactToolReceipts.map((entry) => entry.effectId)).size).toBe(1);
    expect(exactToolReceipts[0]?.effectId).toMatch(/^effect:[a-f0-9-]{36}$/);
    expect(new Set(exactToolReceipts.map((entry) => entry.providerConnectionEpoch))).toEqual(new Set([1]));
    expect(exactToolReceipts.filter((entry) => entry.finalState !== 'unknown')).toHaveLength(1);
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
            ephemeral_token: { value: 'auth_tokens/gemini-browser-test', expireTime: '2033-05-18T04:03:20.000Z' },
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
