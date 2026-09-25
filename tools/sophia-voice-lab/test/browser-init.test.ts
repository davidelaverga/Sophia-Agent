import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { buildVoiceLabInitScript } from "../src/browser-init.js";

class FakeSource {
  buffer: unknown;
  ended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  addEventListener(_name: string, listener: () => void) { this.ended = listener; }
  start(_at: number) {}
  stop() { this.ended?.(); }
  finish() { this.ended?.(); }
}

function harness() {
  const sources: FakeSource[] = [];
  const nativeSends: unknown[] = [];
  const listeners = new Map<string, (event?: unknown) => void>();
  const productEvents: Array<{ type: string; detail: Record<string, unknown> }> = [];
  const pagePushes: Array<Record<string, unknown>> = [];
  const audio = { currentTime: 0, state: "running", resume: async () => { audio.state = "running"; }, createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [{}] } }), decodeAudioData: async () => ({ duration: 0.1 }), createBufferSource: () => { const source = new FakeSource(); sources.push(source); return source; } };
  class FakeWebSocket { static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3; readyState=1; constructor(_url: string, _protocols?: unknown) {} send(data: unknown) { if (data === "native-throw") throw new Error("native-send-failed"); nativeSends.push(data); } close() { this.readyState=3; } }
  class FakeAudioContext { constructor(_options?: unknown) { return audio; } }
  const storage = new Map<string, string>();
  const sandbox: any = {
    console, crypto: webcrypto, atob, btoa, Uint8Array, ArrayBuffer, TextEncoder, DOMException, URL, Date, Map, Set, Object, Array, Number, Math, Error,
    setTimeout, clearTimeout,
    location: { href: "https://frontend.test/session", origin: "https://frontend.test" },
    localStorage: { setItem: (key: string, value: string) => storage.set(key, value) },
    navigator: { mediaDevices: { getUserMedia: async () => null } },
    AudioContext: FakeAudioContext, WebSocket: FakeWebSocket,
    CustomEvent: class { type: string; detail: Record<string, unknown>; constructor(type: string, init: { detail: Record<string, unknown> }) { this.type = type; this.detail = init.detail; } },
    dispatchEvent: (event: { type: string; detail: Record<string, unknown> }) => { productEvents.push(event); return true; },
    addEventListener: (name: string, listener: (event?: unknown) => void) => listeners.set(name, listener),
    __sophiaVoiceLabPushV1: async (value: Record<string, unknown>) => { pagePushes.push(value); },
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.runInNewContext(buildVoiceLabInitScript({ pageOrigin: "https://frontend.test", websocketOrigins: ["wss://provider.test"], maxAudioBytes: 1024, testRunId: "00000000-0000-4000-8000-000000000001", cleanupObligationId: "00000000-0000-4000-8000-000000000002" }), sandbox);
  return { sandbox, audio, sources, listeners, productEvents, pagePushes, storage, nativeSends };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("page-owned dynamic WebAudio injection", () => {
  it("contains no DOM observer or button-click activation fallback", () => {
    const script = buildVoiceLabInitScript({ pageOrigin: "https://frontend.test", websocketOrigins: ["wss://provider.test"], maxAudioBytes: 1024, testRunId: "00000000-0000-4000-8000-000000000001", cleanupObligationId: "00000000-0000-4000-8000-000000000002" });
    expect(script).not.toContain("MutationObserver");
    expect(script).not.toContain("querySelectorAll('button')");
    expect(script).not.toContain("button.click()");
    expect(script).not.toContain("armVoiceActivation");
    expect(script).not.toContain("voiceActivationToken");
  });

  it("pushes harness and product startup receipts through the private binding lane", async () => {
    const { sandbox, listeners, pagePushes } = harness();
    await wait(0);
    expect(pagePushes).toContainEqual(expect.objectContaining({
      schema: "sophia_voice_lab_page_push_v1",
      channel: "harness",
      payload: expect.objectContaining({ kind: "harness.initialized", seq: 1 }),
    }));

    listeners.get("sophia:capture-event")?.(new sandbox.CustomEvent("sophia:capture-event", {
      detail: { generation: 1, seq: 1, name: "gemini-provider-connection-epoch" },
    }));
    await wait(0);
    expect(pagePushes).toContainEqual({
      schema: "sophia_voice_lab_page_push_v1",
      channel: "product",
      payload: { generation: 1, seq: 1, name: "gemini-provider-connection-epoch" },
    });
  });

  it("imports campaign-approved consent without calling an ordinary product mutation route", () => {
    const { storage } = harness();

    expect(storage.get("sophia_consent_accepted")).toBe("true");
    expect(storage.get("sophia.capture.enabled")).toBe("1");
    expect(storage.get("sophia-onboarded")).toBe("1");
    expect(JSON.parse(storage.get("sophia-onboarding-v2") ?? "null")).toMatchObject({
      state: { firstRun: { status: "completed" } },
      version: 2,
    });
  });

  it("permits one product observer wrapper and retains it across a repeated product effect", async () => {
    const { sandbox } = harness();
    const syntheticGetUserMedia = sandbox.navigator.mediaDevices.getUserMedia.bind(sandbox.navigator.mediaDevices);
    let observed = 0;
    sandbox.navigator.mediaDevices.getUserMedia = async (constraints: unknown) => {
      const stream = await syntheticGetUserMedia(constraints);
      observed += 1;
      return stream;
    };

    await sandbox.navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    let rejectedCandidateCalls = 0;
    expect(() => {
      sandbox.navigator.mediaDevices.getUserMedia = async () => {
        rejectedCandidateCalls += 1;
        return null;
      };
    }).not.toThrow();
    await sandbox.navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    expect(observed).toBe(2);
    expect(rejectedCandidateCalls).toBe(0);
    expect(sandbox.__sophiaVoiceLab.drain(0).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "harness.media_observer_wrapper_installed", payload: { synthetic_pipeline_sealed: true } }),
      expect.objectContaining({ kind: "harness.media_observer_wrapper_retained", payload: { synthetic_pipeline_sealed: true, candidate_function: true } }),
      expect.objectContaining({ kind: "harness.media_stream_issued", payload: expect.objectContaining({ replacement_active: true }) }),
    ]));
    expect(Object.getOwnPropertyDescriptor(sandbox.navigator.mediaDevices, "getUserMedia")?.configurable).toBe(false);
  });

  it("emits started only after the scheduled AudioContext boundary, then one natural terminal receipt", async () => {
    const { sandbox, audio, sources, productEvents } = harness();
    const bytes = Buffer.from("valid-audio-payload");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const scheduled = await sandbox.__sophiaVoiceLab.schedule({ operationId: "op-1", utteranceId: "utt-1", audioBase64: bytes.toString("base64"), sha256: digest, delayMs: 50, expectedSilence: false });
    expect(scheduled.kind).toBe("audio.input.scheduled");
    expect(sandbox.__sophiaVoiceLab.drain(0).events.map((event: any) => event.kind)).not.toContain("audio.input.started");
    await wait(20);
    expect(sandbox.__sophiaVoiceLab.drain(0).events.map((event: any) => event.kind)).not.toContain("audio.input.started");
    audio.currentTime = 0.06;
    await wait(40);
    expect(sandbox.__sophiaVoiceLab.drain(0).events.filter((event: any) => event.kind === "audio.input.started")).toHaveLength(1);
    sources[0]!.finish();
    sources[0]!.finish();
    await wait(0);
    expect(sandbox.__sophiaVoiceLab.drain(0).events.filter((event: any) => event.kind === "audio.input.completed")).toHaveLength(1);
    expect(productEvents.filter((event) => event.type === "sophia:voice-lab-input-operation").map((event) => event.detail.phase)).toEqual(["scheduled", "started", "completed"]);
    expect(productEvents[0]?.detail).toMatchObject({ schema: "sophia_voice_lab_input_operation_v1", test_run_id: "00000000-0000-4000-8000-000000000001", cleanup_obligation_id: "00000000-0000-4000-8000-000000000002", operation_id: "op-1", utterance_id: "utt-1", source_sha256: digest, expected_silence: false });
  });

  it("recomputes SHA-256 over decoded bytes and emits only rejected on mismatch", async () => {
    const { sandbox } = harness();
    const bytes = Buffer.from("tampered");
    await expect(sandbox.__sophiaVoiceLab.schedule({ operationId: "op-2", utteranceId: "utt-2", audioBase64: bytes.toString("base64"), sha256: "0".repeat(64), delayMs: 0 })).rejects.toThrow(/sha256 mismatch/);
    const terminal = sandbox.__sophiaVoiceLab.drain(0).events.filter((event: any) => event.kind.startsWith("audio.input.") && ["completed", "interrupted", "rejected"].some((suffix) => event.kind.endsWith(suffix)));
    expect(terminal.map((event: any) => event.kind)).toEqual(["audio.input.rejected"]);
  });

  it("does not emit natural completion after pagehide interruption", async () => {
    const { sandbox, audio, listeners } = harness();
    const bytes = Buffer.from("valid-audio-payload");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await sandbox.__sophiaVoiceLab.schedule({ operationId: "op-3", utteranceId: "utt-3", audioBase64: bytes.toString("base64"), sha256: digest, delayMs: 0 });
    audio.currentTime = 0.01;
    await wait(10);
    listeners.get("pagehide")?.();
    const events = sandbox.__sophiaVoiceLab.drain(0).events;
    expect(events.filter((event: any) => event.kind === "audio.input.interrupted")).toHaveLength(1);
    expect(events.filter((event: any) => event.kind === "audio.input.completed")).toHaveLength(0);
  });

  it("atomically fences an exact app-authored active output target before injection", async () => {
    const { sandbox } = harness();
    const binding = { synthetic: true, test_run_id: "00000000-0000-4000-8000-000000000001", cleanup_obligation_id: "00000000-0000-4000-8000-000000000002" };
    const captureEvents: any[] = [{ generation: 3, seq: 9, name: "gemini-output-audio-playback-started", synthetic_test: binding, payload: { receipt: { phase: "started", realizationId: "realization-atomic", chunkHash: "a".repeat(64), providerConnectionEpoch: 2, playbackGeneration: 4 } } }];
    sandbox.__sophiaCapture = { getEvents: () => [...captureEvents] };
    const bytes = Buffer.from("valid-audio-payload");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const target = { kind: "output_realization", operationId: "operation-atomic", labEventSeq: 17, productGeneration: 3, productSeq: 9, stableId: "realization-atomic", chunkHash: "a".repeat(64), providerConnectionEpoch: 2, playbackGeneration: 4 };
    await sandbox.__sophiaVoiceLab.schedule({ operationId: "operation-atomic", utteranceId: "utterance-atomic", audioBase64: bytes.toString("base64"), sha256: digest, activeTarget: target });
    const kinds = sandbox.__sophiaVoiceLab.drain(0).events.map((event: any) => event.kind);
    expect(kinds.indexOf("harness.product_active_target_fenced")).toBeLessThan(kinds.indexOf("audio.input.scheduled"));

    const second = harness();
    second.sandbox.__sophiaCapture = { getEvents: () => [...captureEvents, { generation: 3, seq: 10, name: "gemini-output-audio-playback-completed", synthetic_test: binding, payload: { receipt: { phase: "completed", realizationId: "realization-atomic", chunkHash: "a".repeat(64), providerConnectionEpoch: 2, playbackGeneration: 4 } } }] };
    await expect(second.sandbox.__sophiaVoiceLab.schedule({ operationId: "operation-atomic", utteranceId: "utterance-atomic", audioBase64: bytes.toString("base64"), sha256: digest, activeTarget: target })).rejects.toThrow(/settled before mutation/);
    expect(second.sandbox.__sophiaVoiceLab.drain(0).events.some((event: any) => event.kind === "harness.product_active_target_fenced")).toBe(false);
  });

  it("atomically fences one exact in-flight tool effect before socket close", () => {
    const { sandbox } = harness();
    const binding = { synthetic: true, test_run_id: "00000000-0000-4000-8000-000000000001", cleanup_obligation_id: "00000000-0000-4000-8000-000000000002" };
    sandbox.__sophiaCapture = { getEvents: () => [{ generation: 4, seq: 11, name: "gemini-tool-call-ledger", synthetic_test: binding, payload: { entry: { toolCallId: "tool-atomic", effectId: "effect-atomic", providerConnectionEpoch: 3, finalState: "unknown", toolResponseSentAt: null, cancelledAt: null } } }] };
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    const rotated = sandbox.__sophiaVoiceLab.rotate({ kind: "tool_effect", operationId: "rotation-atomic", labEventSeq: 21, productGeneration: 4, productSeq: 11, toolCallId: "tool-atomic", effectId: "effect-atomic", providerConnectionEpoch: 3 });
    expect(rotated.kind).toBe("harness.socket_rotation_requested");
    expect(socket.readyState).toBe(3);
    const kinds = sandbox.__sophiaVoiceLab.drain(0).events.map((event: any) => event.kind);
    expect(kinds.indexOf("harness.product_active_target_fenced")).toBeLessThan(kinds.indexOf("harness.socket_rotation_requested"));
  });
});

describe("passive provider setup diagnostics", () => {
  it("observes setup before input gating without retaining private envelope contents", () => {
    const { sandbox, nativeSends } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket?key=URL_SECRET");
    const wire = JSON.stringify({ setup: {
      model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { secret: "SPEECH_SECRET" } },
      inputAudioTranscription: {}, outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
      systemInstruction: { parts: [{ text: "SYSTEM_SECRET" }] }, tools: [{ declaration: "TOOLS_SECRET" }],
      sessionResumption: { handle: "HANDLE_SECRET" }, auth: "AUTH_SECRET", arbitrary: "ARBITRARY_SECRET",
    } });
    socket.send(wire);
    expect(nativeSends).toEqual([wire]);
    const events = sandbox.__sophiaVoiceLab.drain(0).events;
    expect(events.find((event: any) => event.kind === "harness.provider_setup_sent").payload).toEqual({
      harness_socket_ordinal: 1, model: "models/gemini-2.5-flash-native-audio-preview-12-2025", response_modalities: ["AUDIO"],
      input_audio_transcription_present: true, output_audio_transcription_present: true, automatic_activity_detection_disabled: false,
    });
    expect(JSON.stringify(events)).not.toMatch(/SECRET/);
  });
  it("records a content-free census of every outbound provider frame", () => {
    const { sandbox, nativeSends } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    const frames = [
      JSON.stringify({ setup: { model: "models/x", systemInstruction: { parts: [{ text: "SYSTEM_SECRET" }] } } }),
      JSON.stringify({ realtimeInput: { audio: { data: "QUJD", mimeType: "audio/pcm;rate=16000" } } }),
      JSON.stringify({ realtimeInput: { text: "PRIVATE_TEXT_SECRET" } }),
      JSON.stringify({ realtimeInput: { video: { data: "SECRET_FRAME_BYTES", mimeType: "image/jpeg" } } }),
      JSON.stringify({ toolResponse: { functionResponses: [{ id: "call-1", response: { secret: "TOOL_SECRET" } }] } }),
      "NOT_JSON_SECRET",
    ];
    for (const frame of frames) socket.send(frame);
    expect(nativeSends).toEqual(frames);
    const census = sandbox.__sophiaVoiceLab.drain(0).events
      .filter((event: any) => event.kind === "harness.provider_frame_sent")
      .map((event: any) => ({ kind: event.payload.frame_kind, realtime: event.payload.realtime_input_kind ?? null }));
    expect(census).toEqual([
      { kind: "setup", realtime: null },
      { kind: "realtimeInput", realtime: "audio" },
      { kind: "realtimeInput", realtime: "text" },
      { kind: "realtimeInput", realtime: "video" },
      { kind: "toolResponse", realtime: null },
      { kind: "unparsed", realtime: null },
    ]);
    const drained = JSON.stringify(sandbox.__sophiaVoiceLab.drain(0));
    expect(drained).toContain("harness.provider_frame_sent");
    expect(drained).not.toMatch(/SECRET/);
  });

  it("never exports an arbitrary field name, only a count of unknown fields", () => {
    const { sandbox, nativeSends } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    // Caller-chosen property names are payload-derived content. A fixed
    // allowlist must classify, and everything else may only be counted.
    const wire = JSON.stringify({
      PRIVATE_TOP_SECRET: 1,
      anotherUndocumentedField_SECRET: 2,
      realtimeInput: { audio: { data: "QUJD", mimeType: "audio/pcm;rate=16000" }, PRIVATE_INNER_SECRET: 3 },
    });
    socket.send(wire);
    expect(nativeSends).toEqual([wire]);
    const event = sandbox.__sophiaVoiceLab.drain(0).events
      .find((entry: any) => entry.kind === "harness.provider_frame_sent");
    expect(event.payload).toMatchObject({
      harness_socket_ordinal: 1,
      frame_kind: "realtimeInput",
      realtime_input_kind: "audio",
      unknown_top_level_field_count: 2,
      unknown_realtime_input_field_count: 1,
    });
    expect(JSON.stringify(sandbox.__sophiaVoiceLab.drain(0))).not.toMatch(/SECRET/);
  });

  it("reports an unrecognized frame without naming its fields", () => {
    const { sandbox } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    socket.send(JSON.stringify({ WHOLLY_UNKNOWN_SECRET: { nested: "ALSO_SECRET" } }));
    const event = sandbox.__sophiaVoiceLab.drain(0).events
      .find((entry: any) => entry.kind === "harness.provider_frame_sent");
    expect(event.payload).toMatchObject({ frame_kind: "unrecognized", realtime_input_kind: null, unknown_top_level_field_count: 1 });
    expect(JSON.stringify(sandbox.__sophiaVoiceLab.drain(0))).not.toMatch(/SECRET/);
  });

  it("measures UTF-8 wire bytes, not UTF-16 code units", () => {
    const { sandbox } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    // "é" is 2 UTF-8 bytes; "😀" is 4 bytes but 2 UTF-16 code units.
    const wire = JSON.stringify({ realtimeInput: { text: "é😀" } });
    socket.send(wire);
    const expected = new TextEncoder().encode(wire).length;
    expect(expected).toBeGreaterThan(wire.length);
    const event = sandbox.__sophiaVoiceLab.drain(0).events
      .find((entry: any) => entry.kind === "harness.provider_frame_sent");
    expect(event.payload.byte_length).toBe(expected);
    expect(event.payload.byte_length).not.toBe(wire.length);
  });

  it("records binary frames by fixed kind and size without inspecting them", () => {
    const { sandbox, nativeSends } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    const buffer = new ArrayBuffer(11);
    const view = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const blobLike = { size: 42, type: "application/octet-stream" };
    socket.send(buffer);
    socket.send(view);
    socket.send(blobLike);
    expect(nativeSends).toEqual([buffer, view, blobLike]);
    const census = sandbox.__sophiaVoiceLab.drain(0).events
      .filter((entry: any) => entry.kind === "harness.provider_frame_sent")
      .map((entry: any) => ({ kind: entry.payload.frame_kind, bytes: entry.payload.byte_length }));
    expect(census).toEqual([
      { kind: "binary", bytes: 11 },
      { kind: "binary", bytes: 7 },
      { kind: "binary", bytes: 42 },
    ]);
  });

  it("counts native stream-end sends per allowed socket even without active injection", () => {
    const { sandbox, nativeSends } = harness();
    const first = new sandbox.WebSocket("wss://provider.test/socket");
    const second = new sandbox.WebSocket("wss://provider.test/another");
    const wire = JSON.stringify({ realtimeInput: { audioStreamEnd: true, text: "PRIVATE_TEXT" } });
    first.send(wire); first.send(wire); second.send(wire);
    expect(nativeSends).toEqual([wire, wire, wire]);
    expect(sandbox.__sophiaVoiceLab.drain(0).events.filter((event: any) => event.kind === "harness.provider_audio_stream_end_sent").map((event: any) => event.payload)).toEqual([
      { harness_socket_ordinal: 1, audio_stream_end_count: 1 }, { harness_socket_ordinal: 1, audio_stream_end_count: 2 }, { harness_socket_ordinal: 2, audio_stream_end_count: 1 },
    ]);
    expect(JSON.stringify(sandbox.__sophiaVoiceLab.drain(0))).not.toContain("PRIVATE_TEXT");
  });
  it("ignores foreign origins, non-JSON and unrecognized metadata without changing native sends", () => {
    const { sandbox, nativeSends } = harness();
    const foreign = new sandbox.WebSocket("wss://provider.test.evil/socket");
    const allowed = new sandbox.WebSocket("wss://provider.test/socket");
    foreign.send(JSON.stringify({ setup: { model: "models/gemini-secret" }, realtimeInput: { audioStreamEnd: true } }));
    allowed.send("NOT_JSON_SECRET");
    allowed.send(JSON.stringify({ setup: { model: "TOKEN_SECRET", generationConfig: { responseModalities: ["PRIVATE_SECRET"] } }, realtimeInput: { audioStreamEnd: "true" } }));
    expect(nativeSends).toHaveLength(3);
    const events = sandbox.__sophiaVoiceLab.drain(0).events;
    expect(events.filter((event: any) => event.kind === "harness.provider_setup_sent").map((event: any) => event.payload)).toEqual([
      { harness_socket_ordinal: 1, model: null, response_modalities: null, input_audio_transcription_present: false, output_audio_transcription_present: false, automatic_activity_detection_disabled: null },
    ]);
    expect(events.some((event: any) => event.kind === "harness.provider_audio_stream_end_sent")).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/SECRET/);
  });
  it("preserves native send exceptions and produces no successful-send diagnostic", () => {
    const { sandbox, nativeSends } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    expect(() => socket.send("native-throw")).toThrow("native-send-failed");
    expect(nativeSends).toEqual([]);
    expect(sandbox.__sophiaVoiceLab.drain(0).events.some((event: any) => event.kind.startsWith("harness.provider_"))).toBe(false);
  });
});
