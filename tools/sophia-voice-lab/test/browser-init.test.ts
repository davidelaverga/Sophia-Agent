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
  const listeners = new Map<string, (event?: unknown) => void>();
  const productEvents: Array<{ type: string; detail: Record<string, unknown> }> = [];
  const pagePushes: Array<Record<string, unknown>> = [];
  const audio = { currentTime: 0, state: "running", resume: async () => { audio.state = "running"; }, createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [{}] } }), decodeAudioData: async () => ({ duration: 0.1 }), createBufferSource: () => { const source = new FakeSource(); sources.push(source); return source; } };
  class FakeWebSocket { static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3; readyState=1; constructor(_url: string, _protocols?: unknown) {} close() { this.readyState=3; } }
  class FakeAudioContext { constructor(_options?: unknown) { return audio; } }
  const storage = new Map<string, string>();
  const sandbox: any = {
    console, crypto: webcrypto, atob, btoa, Uint8Array, TextEncoder, DOMException, URL, Date, Map, Set, Object, Array, Number, Math, Error,
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
  return { sandbox, audio, sources, listeners, productEvents, pagePushes, storage };
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
