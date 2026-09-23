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
    for (let index = 0; index < 100; index += 1) socket.deliver({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: `h${index}`, resumable: true } }) });
    socket.deliver({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h", resumable: false } }) });
    await settle();
    const repeats = received().map((event: any) => [event.payload.inbound_ordinal, event.payload.repeats_suppressed_before, event.payload.previous_repeats_suppressed]);
    // Emitted at 1, then every 25th identical frame; the change reports the 24 pending repeats.
    expect(repeats).toEqual([[1, 0, 0], [26, 24, 0], [51, 24, 0], [76, 24, 0], [101, 0, 24]]);
    socket.deliverClose();
    await settle();
    expect(received().at(-1).payload).toMatchObject({ received_count: 101, emitted_count: 5, suppressed_count: 96, pending_repeat_count: 0, cap_reached: false });

    const capped = harness();
    const second = new capped.sandbox.WebSocket("wss://provider.test/socket");
    for (let index = 0; index < 600; index += 1) second.deliver({ data: JSON.stringify({ serverContent: { outputTranscription: { text: "a".repeat(index) } } }) });
    await capped.settle();
    second.deliverClose();
    await capped.settle();
    const events = capped.received();
    expect(events.filter((event: any) => event.kind === "harness.provider_frame_received")).toHaveLength(512);
    expect(events.filter((event: any) => event.kind === "harness.provider_frame_received_capped")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ inbound_ordinal: 513, emitted_count: 512 }) })]);
    expect(events.at(-1).payload).toMatchObject({ received_count: 600, emitted_count: 512, suppressed_count: 88, cap_reached: true });
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
});
