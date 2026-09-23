import { webcrypto } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { buildVoiceLabInitScript } from "../src/browser-init.js";

type Listener = (event: any) => void;

/** Minimal EventTarget-shaped socket: listeners fire in registration order,
 * then the `onmessage` attribute handler, exactly one delivery per frame. */
function harness() {
  const nativeSends: unknown[] = [];
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 1;
    onmessage: Listener | null = null;
    listeners = new Map<string, Listener[]>();
    stopped = false;
    constructor(_url: string, _protocols?: unknown) {}
    addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
    send(data: unknown) { nativeSends.push(data); }
    close() { this.readyState = 3; }
    deliver(event: any) {
      for (const listener of this.listeners.get("message") ?? []) listener(event);
      this.onmessage?.(event);
    }
    deliverClose() { for (const listener of this.listeners.get("close") ?? []) listener({ type: "close" }); }
  }
  const audio = { currentTime: 0, state: "running", resume: async () => {}, createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [{}] } }) };
  const sandbox: any = {
    console, crypto: webcrypto, atob, btoa, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, Blob, DOMException, URL, Date, Map, Set, Object, Array, Number, Math, Error, JSON, Promise,
    setTimeout, clearTimeout,
    location: { href: "https://frontend.test/session", origin: "https://frontend.test" },
    localStorage: { setItem: () => undefined },
    navigator: { mediaDevices: { getUserMedia: async () => null } },
    AudioContext: class { constructor() { return audio; } }, WebSocket: FakeWebSocket,
    CustomEvent: class { constructor(public type: string, public init: unknown) {} },
    dispatchEvent: () => true, addEventListener: () => undefined,
    __sophiaVoiceLabPushV1: async () => undefined,
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.runInNewContext(buildVoiceLabInitScript({ pageOrigin: "https://frontend.test", websocketOrigins: ["wss://provider.test"], maxAudioBytes: 1024, testRunId: "00000000-0000-4000-8000-000000000001", cleanupObligationId: "00000000-0000-4000-8000-000000000002" }), sandbox);
  const settle = async () => { for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const received = () => sandbox.__sophiaVoiceLab.drain(0).events.filter((event: any) => event.kind.startsWith("harness.provider_frame_received"));
  return { sandbox, nativeSends, settle, received };
}

const strip = ({ harness_socket_ordinal: _socket, ...rest }: Record<string, unknown>) => rest;

describe("content-free inbound provider census", () => {
  it("projects documented state only and exports no provider content", async () => {
    const { sandbox, settle, received } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    socket.deliver({ data: JSON.stringify({ serverContent: {
      inputTranscription: { text: "héllo TRANSCRIPT_SECRET" }, waitingForInput: true, turnComplete: false, SECRET_FIELD_NAME: { value: "x" },
      turnCompleteReason: "SECRET_REASON",
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AUDIO_SECRET" } }, { text: "TEXT_SECRET" }, { functionCall: { args: { q: "ARG_SECRET" } } }] },
    } }) });
    socket.deliver({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "HANDLE_SECRET", resumable: false }, usageMetadata: {
      promptTokenCount: 12, responseTokenCount: -1, totalTokenCount: 1.5, thoughtsTokenCount: "7", cachedContentTokenCount: Number.MAX_SAFE_INTEGER + 2, toolUsePromptTokenCount: 0 } }) });
    socket.deliver({ data: JSON.stringify({ toolCall: { functionCalls: [{ name: "SECRET_TOOL", args: { a: "TOOL_SECRET" } }] }, SECRET_TOP_FIELD: 1 }) });
    await settle();
    const events = received();
    expect(events.map((event: any) => strip(event.payload))).toEqual([
      { inbound_ordinal: 1, repeats_suppressed_before: 0, previous_repeats_suppressed: 0, frame_kind: "serverContent", unknown_top_level_field_count: 0,
        server_content: { fields: ["inputTranscription", "modelTurn", "turnComplete", "waitingForInput"], unknown_field_count: 2,
          turn_complete: "false", interrupted: "absent", generation_complete: "absent", waiting_for_input: "true",
          input_transcription_utf8_bytes: new TextEncoder().encode("héllo TRANSCRIPT_SECRET").length, interim_input_transcription_utf8_bytes: null,
          output_transcription_utf8_bytes: null, model_turn_part_count: 3, model_turn_audio_part_count: 1, model_turn_text_part_count: 1 },
        session_resumption: null, usage_tokens: null },
      { inbound_ordinal: 2, repeats_suppressed_before: 0, previous_repeats_suppressed: 0, frame_kind: "sessionResumptionUpdate+usageMetadata", unknown_top_level_field_count: 0,
        server_content: null, session_resumption: { resumable: "false", new_handle_present: true },
        usage_tokens: { promptTokenCount: 12, cachedContentTokenCount: null, responseTokenCount: null, toolUsePromptTokenCount: 0, thoughtsTokenCount: null, totalTokenCount: null } },
      { inbound_ordinal: 3, repeats_suppressed_before: 0, previous_repeats_suppressed: 0, frame_kind: "toolCall", unknown_top_level_field_count: 1,
        server_content: null, session_resumption: null, usage_tokens: null },
    ]);
    expect(JSON.stringify(sandbox.__sophiaVoiceLab.drain(0))).not.toMatch(/SECRET/);
  });

  it("types malformed, oversized and unrecognized frames as unavailable without inspecting them", async () => {
    const { sandbox, settle, received } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    const frames: unknown[] = [
      "NOT_JSON_SECRET", "[1,2]", "7", JSON.stringify({ serverContent: "SECRET_STRING" }),
      JSON.stringify({ sessionResumptionUpdate: ["SECRET"], usageMetadata: 5 }), JSON.stringify({ serverContent: { modelTurn: { parts: "SECRET" }, interrupted: "yes" } }),
      "x".repeat(1_048_577), new TextEncoder().encode(JSON.stringify({ setupComplete: {} })).buffer,
      new Blob([JSON.stringify({ goAway: { timeLeft: "SECRET" } })]), 42, JSON.stringify({}),
    ];
    for (const data of frames) socket.deliver({ data });
    await settle();
    socket.deliverClose();
    await settle();
    const events = received();
    const perFrame = events.filter((event: any) => event.kind === "harness.provider_frame_received").map((event: any) => event.payload);
    // "[1,2]" and "7" project identically, so the second is coalesced and counted.
    expect(perFrame.map((payload: any) => payload.frame_kind)).toEqual([
      "unparsed", "unrecognized", "serverContent", "sessionResumptionUpdate+usageMetadata", "serverContent",
      "oversized", "setupComplete", "goAway", "unrecognized_transport", "empty",
    ]);
    expect(perFrame[3].previous_repeats_suppressed).toBe(0);
    expect(perFrame[2]).toMatchObject({ server_content: "unavailable", previous_repeats_suppressed: 1 });
    expect(perFrame[3]).toMatchObject({ session_resumption: "unavailable", usage_tokens: "unavailable" });
    expect(perFrame[4].server_content).toMatchObject({ model_turn_part_count: "unavailable", model_turn_audio_part_count: null, interrupted: "unavailable" });
    expect(events.at(-1)).toMatchObject({ kind: "harness.provider_frame_received_summary", payload: {
      received_count: 11, emitted_count: 10, suppressed_count: 1, pending_repeat_count: 0, oversized_count: 1, unparsed_count: 1, cap_reached: false } });
    expect(JSON.stringify(sandbox.__sophiaVoiceLab.drain(0))).not.toMatch(/SECRET|xxxx/);
  });

  it("coalesces identical repeats with explicit counts and caps distinct events without losing accounting", async () => {
    const { sandbox, settle, received } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    // Spaced below the observation-queue bound (64), so every frame is inspected.
    for (let index = 0; index < 100; index += 1) {
      socket.deliver({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: `h${index}`, resumable: true } }) });
      if (index % 20 === 19) await settle();
    }
    socket.deliver({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h", resumable: false } }) });
    await settle();
    const repeats = received().map((event: any) => [event.payload.inbound_ordinal, event.payload.repeats_suppressed_before, event.payload.previous_repeats_suppressed]);
    // Emitted at 1, then every 25th identical frame; the change reports the 24 pending repeats.
    expect(repeats).toEqual([[1, 0, 0], [26, 24, 0], [51, 24, 0], [76, 24, 0], [101, 0, 24]]);
    socket.deliverClose();
    await settle();
    expect(received().at(-1).payload).toMatchObject({ received_count: 101, inspected_count: 101, emitted_count: 5, suppressed_count: 96, pending_repeat_count: 0,
      cap_reached: false, queue_dropped_count: 0, uninspected_after_cap_count: 0, in_flight_count: 0, capture_limited: false });

    const capped = harness();
    const second = new capped.sandbox.WebSocket("wss://provider.test/socket");
    for (let index = 0; index < 600; index += 1) {
      second.deliver({ data: JSON.stringify({ serverContent: { outputTranscription: { text: "a".repeat(index) } } }) });
      if (index % 50 === 49) await capped.settle();
    }
    await capped.settle();
    second.deliverClose();
    await capped.settle();
    const events = capped.received();
    expect(events.filter((event: any) => event.kind === "harness.provider_frame_received")).toHaveLength(512);
    expect(events.filter((event: any) => event.kind === "harness.provider_frame_received_capped")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ inbound_ordinal: 513, emitted_count: 512 }) })]);
    // 501..550 were queued before the cap: 12 emitted, 38 inspected and
    // suppressed. 551..600 arrive after the cap and are counted, never inspected.
    expect(events.at(-1).payload).toMatchObject({ received_count: 600, inspected_count: 550, emitted_count: 512, suppressed_count: 38, cap_reached: true,
      queue_dropped_count: 0, uninspected_after_cap_count: 50, in_flight_count: 0, capture_limited: true });
  });

  it("never alters, reorders or withholds what the product's own handlers receive", async () => {
    const { sandbox, nativeSends, settle, received } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    const seen: unknown[] = [];
    socket.addEventListener("message", (event: any) => seen.push(["listener", event.data]));
    socket.onmessage = (event: any) => seen.push(["onmessage", event.data]);
    const blob = new Blob(["{\"setupComplete\":{}}"]);
    const hostile = { get data() { throw new Error("hostile getter"); } };
    const events = [{ data: "{\"serverContent\":{}}" }, { data: blob }, hostile, { data: "NOT_JSON" }];
    for (const event of events) {
      try { socket.deliver(event); } catch { /* only the product's own read may throw */ }
    }
    socket.send("unchanged");
    await settle();
    expect(seen.filter(([path]) => path === "onmessage").length).toBe(3);
    expect(seen.filter(([path]) => path === "listener").map(([, data]) => data)).toEqual(["{\"serverContent\":{}}", blob, "NOT_JSON"]);
    expect(seen.find(([, data]) => data === blob)?.[1]).toBe(blob); // same object, unconsumed
    expect(await blob.text()).toBe("{\"setupComplete\":{}}");
    expect(nativeSends).toEqual(["unchanged"]);
    expect(received().map((event: any) => event.payload.frame_kind)).toEqual(["serverContent", "setupComplete", "uninspectable", "unparsed"]);

    const foreign = new sandbox.WebSocket("wss://other.test/socket");
    foreign.deliver({ data: "{\"setupComplete\":{}}" });
    await settle();
    expect(foreign.listeners.get("message")).toBeUndefined();
    expect(received()).toHaveLength(4);
  });

  it("enforces the 1 MiB bound in UTF-8 bytes, not UTF-16 code units", async () => {
    const { sandbox, settle, received } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    const over = JSON.stringify({ serverContent: { outputTranscription: { text: "€".repeat(349_530) } } });
    const fits = JSON.stringify({ serverContent: { outputTranscription: { text: "€".repeat(300_000) } } });
    expect(over.length).toBeLessThan(1_048_576); // fits in code units ...
    expect(new TextEncoder().encode(over).length).toBeGreaterThan(1_048_576); // ... but not in bytes
    socket.deliver({ data: over });
    socket.deliver({ data: fits });
    await settle();
    socket.deliverClose();
    await settle();
    const events = received();
    expect(events.filter((event: any) => event.kind === "harness.provider_frame_received").map((event: any) => [event.payload.frame_kind, event.payload.server_content?.output_transcription_utf8_bytes ?? null]))
      .toEqual([["oversized", null], ["serverContent", 900_000]]);
    expect(events.at(-1).payload).toMatchObject({ oversized_count: 1, received_count: 2, inspected_count: 2 });
  });

  it("bounds queued observation work behind a stalled Blob and accounts for every dropped frame", async () => {
    const { sandbox, settle, received } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    const seen: unknown[] = [];
    socket.onmessage = (event: any) => seen.push(event.data);
    let release!: (text: string) => void;
    const stalled = { size: 24, text: () => new Promise<string>((resolve) => { release = resolve; }) };
    socket.deliver({ data: stalled });
    for (let index = 0; index < 200; index += 1) socket.deliver({ data: JSON.stringify({ serverContent: { outputTranscription: { text: "b".repeat(index % 7) } } }) });
    // The product saw every frame immediately, while the census is stalled.
    expect(seen).toHaveLength(201);
    expect(seen[0]).toBe(stalled);
    await settle();
    const limited = received().filter((event: any) => event.kind === "harness.provider_frame_received_limited");
    expect(limited).toEqual([expect.objectContaining({ payload: expect.objectContaining({ inbound_ordinal: 65, reason: "observation_queue_frames", queued_frames: 64 }) })]);
    expect(received().filter((event: any) => event.kind === "harness.provider_frame_received")).toHaveLength(0); // ordered behind the Blob
    release(JSON.stringify({ setupComplete: {} }));
    await settle();
    socket.deliverClose();
    await settle();
    const events = received();
    const perFrame = events.filter((event: any) => event.kind === "harness.provider_frame_received").map((event: any) => event.payload.inbound_ordinal);
    expect(perFrame[0]).toBe(1);
    expect(perFrame).toEqual([...perFrame].sort((a: number, b: number) => a - b));
    expect(Math.max(...perFrame)).toBeLessThanOrEqual(64); // only admitted frames were inspected
    expect(events.at(-1).payload).toMatchObject({ received_count: 201, inspected_count: 64, queue_dropped_count: 137, uninspected_after_cap_count: 0,
      in_flight_count: 0, capture_limited: true });
    const summary = events.at(-1).payload;
    expect(summary.emitted_count + summary.suppressed_count + summary.queue_dropped_count + summary.uninspected_after_cap_count + summary.in_flight_count).toBe(201);
  });

  it("bounds retained observation bytes as well as frame count", async () => {
    const { sandbox, settle, received } = harness();
    const socket = new sandbox.WebSocket("wss://provider.test/socket");
    let release!: (text: string) => void;
    socket.deliver({ data: { size: 24, text: () => new Promise<string>((resolve) => { release = resolve; }) } });
    // ~1.8 MB retained estimate each (UTF-16): the fifth would exceed 8 MiB.
    for (let index = 0; index < 6; index += 1) socket.deliver({ data: JSON.stringify({ serverContent: { outputTranscription: { text: "c".repeat(900_000) } } }) });
    await settle();
    expect(received().filter((event: any) => event.kind === "harness.provider_frame_received_limited")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ inbound_ordinal: 6, reason: "observation_queue_bytes", queued_frames: 5 }) })]);
    release(JSON.stringify({ setupComplete: {} }));
    await settle();
    socket.deliverClose();
    await settle();
    expect(received().at(-1).payload).toMatchObject({ received_count: 7, inspected_count: 5, queue_dropped_count: 2, in_flight_count: 0, capture_limited: true });
  });
});
