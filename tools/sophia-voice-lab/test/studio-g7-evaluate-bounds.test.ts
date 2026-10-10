import { describe, expect, it } from "vitest";

import type { OperationRecord, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { INPUT_WINDOW_DURATION_FLOOR, PLAYBACK_JOIN_CLOCK_TOLERANCE_MS, evaluateStudioG7Run, type StudioG7Evaluation } from "../src/studio-g7/evaluate.js";
import {
  API_SHA, BRIDGE_SHA, EventLog, LAB_TRACK_ID, STUDIO_SHA, evidenceGrant, inputTurn, inputWindow, labUtterance, outputReply, pageReceipt, providerReceipt,
  sessionClosed, speakOperation, studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";

/**
 * The run evaluation at each of its numeric edges, on both sides: the input
 * window's envelope floors, the playback join's clock tolerance, the mic
 * state at an utterance's start and end, the audible-reply frame counts,
 * the missing-seq cap and the summary cap. The evaluator's suite reaches
 * them only away from their edges; these pin every edge, so a refactor of
 * the evaluation provably kept them.
 */
const config = studioTestConfig();
const expected = { studio: STUDIO_SHA, api: API_SHA, bridge: BRIDGE_SHA };
const T0 = 1_791_500_000_000;
const START = T0 + 1_000;
const REPLY_AT = T0 + 60_000;

interface Options {
  durationMs?: number;
  window?: Record<string, unknown>;
  mic?: Array<{ event: "mic_published" | "mic_unpublished"; atMs: number }>;
  reply?: Record<string, unknown> | null;
  playback?: Array<{ phase: string; atMs: number }>;
  /** Seq of one extra provider receipt (a gap before it is missing). */
  lateProviderSeq?: number;
}

function episode(options: Options = {}): { run: RunRecord; log: EventLog; operations: OperationRecord[] } {
  const run = studioRun(config);
  const log = new EventLog(run.id);
  const operation = speakOperation(run, new Date(T0));
  const durationMs = options.durationMs ?? 1_500;
  labUtterance(log, operation.id, START, durationMs);
  log.add("harness.media_stream_issued", "browser", { replacement_active: true, track_id_sha256s: [sha256(LAB_TRACK_ID)] });
  for (const mic of options.mic ?? [{ event: "mic_published", atMs: START - 100 }]) log.page(pageReceipt(run, mic.event, mic.atMs));
  log.grant(evidenceGrant(run));
  log.bridge("provider", providerReceipt(run, 0, "ready"));
  log.bridge("input_window", inputWindow(run, 1, 1, durationMs, options.window ?? {}));
  log.bridge("input_turn", inputTurn(run, 2, 1));
  let seq = 3;
  const replies = options.reply === null ? 0 : 1;
  if (options.reply !== null) log.bridge("output_reply", outputReply(run, seq++, 1, REPLY_AT, options.reply ?? {}));
  for (const playback of options.playback ?? []) log.page(pageReceipt(run, "sophia_playback", playback.atMs, { phase: playback.phase }));
  log.bridge("session_closed", sessionClosed(run, seq++, { windows: 1, turns: 1, replies }));
  if (options.lateProviderSeq !== undefined) log.bridge("provider", providerReceipt(run, options.lateProviderSeq, "usage"));
  return { run, log, operations: [operation] };
}

const evaluate = (item: ReturnType<typeof episode>): StudioG7Evaluation => evaluateStudioG7Run(item.run, item.log.events, item.operations, { expected });
const product = (evaluation: StudioG7Evaluation, id: string) => evaluation.product.find((assertion) => assertion.id === id);
const harness = (evaluation: StudioG7Evaluation, id: string) => evaluation.harness.find((assertion) => assertion.id === id);

describe("Studio G7 evaluation bounds (each edge, both sides)", () => {
  it("the window holds at least the utterance's samples times the floor", () => {
    const durationMs = 1_500;
    const minSamples = Math.floor(durationMs * 16 * INPUT_WINDOW_DURATION_FLOOR);
    for (const delta of [-1, 0, 1]) {
      const status = product(evaluate(episode({ durationMs, window: { sampleCount: minSamples + delta } })), "input.1.window_envelope");
      expect(status, String(delta)).toMatchObject(delta < 0 ? { status: "fail", reason: "window_shorter_than_utterance_envelope" } : { status: "pass", reason: null });
    }
  });

  it("the window lasts at least the utterance's duration times the floor", () => {
    const durationMs = 1_500;
    const floor = Math.floor(durationMs * INPUT_WINDOW_DURATION_FLOOR);
    for (const delta of [-1, 0, 1]) {
      const status = product(evaluate(episode({ durationMs, window: { startedAtMs: 10_000, endedAtMs: 10_000 + floor + delta } })), "input.1.window_envelope");
      expect(status, String(delta)).toMatchObject(delta < 0 ? { status: "fail", reason: "window_shorter_than_utterance_envelope" } : { status: "pass", reason: null });
    }
  });

  it("a window may end exactly when it starts (a 1 ms utterance's floor is 0), never before", () => {
    for (const delta of [-1, 0, 1]) {
      const status = product(evaluate(episode({ durationMs: 1, window: { startedAtMs: 10_000, endedAtMs: 10_000 + delta } })), "input.1.window_envelope");
      expect(status, String(delta)).toMatchObject(delta < 0 ? { status: "fail", reason: "window_shorter_than_utterance_envelope" } : { status: "pass", reason: null });
    }
  });

  it("the Sophia element joins a reply when it started playing up to the tolerance after it", () => {
    for (const delta of [-1, 0, 1]) {
      const status = product(evaluate(episode({ playback: [{ phase: "playing", atMs: REPLY_AT + PLAYBACK_JOIN_CLOCK_TOLERANCE_MS + delta }] })), "output.page_playback_join");
      expect(status, String(delta)).toMatchObject(delta > 0 ? { status: "fail", reason: "sophia_element_not_playing_at_reply" } : { status: "pass", reason: null });
    }
  });

  it("a stop counts against the join only definitely before the reply began (beyond the tolerance)", () => {
    for (const delta of [-1, 0, 1]) {
      const status = product(evaluate(episode({ playback: [{ phase: "playing", atMs: REPLY_AT - 10_000 }, { phase: "pause", atMs: REPLY_AT - PLAYBACK_JOIN_CLOCK_TOLERANCE_MS + delta }] })), "output.page_playback_join");
      expect(status, String(delta)).toMatchObject(delta < 0 ? { status: "fail", reason: "sophia_element_not_playing_at_reply" } : { status: "pass", reason: null });
    }
  });

  it("only a stop strictly after the last play counts against the join", () => {
    const playing = REPLY_AT - 10_000;
    for (const delta of [-1, 0, 1]) {
      const status = product(evaluate(episode({ playback: [{ phase: "playing", atMs: playing }, { phase: "pause", atMs: playing + delta }] })), "output.page_playback_join");
      expect(status, String(delta)).toMatchObject(delta > 0 ? { status: "fail", reason: "sophia_element_not_playing_at_reply" } : { status: "pass", reason: null });
    }
  });

  it("the mic state at an utterance's start is its latest mic receipt at or before that instant", () => {
    // Unpublished and republished in the same millisecond as the start: the latest receipt (published) is the state.
    const same = harness(evaluate(episode({ mic: [{ event: "mic_published", atMs: START - 100 }, { event: "mic_unpublished", atMs: START }, { event: "mic_published", atMs: START }] })), "input.1.r2_published_track_identity");
    expect(same).toMatchObject({ status: "pass", reason: null });
    const before = harness(evaluate(episode({ mic: [{ event: "mic_published", atMs: START - 100 }, { event: "mic_unpublished", atMs: START - 1 }] })), "input.1.r2_published_track_identity");
    expect(before).toMatchObject({ status: "fail", reason: "mic_unpublished_at_utterance_start" });
    const after = harness(evaluate(episode({ mic: [{ event: "mic_published", atMs: START - 100 }, { event: "mic_unpublished", atMs: START + 1 }] })), "input.1.r2_published_track_identity");
    expect(after).toMatchObject({ status: "fail", reason: "mic_unpublished_during_utterance" });
  });

  it("an unpublish counts during the utterance up to and including its end", () => {
    const end = START + 1_500;
    for (const delta of [-1, 0, 1]) {
      const status = harness(evaluate(episode({ mic: [{ event: "mic_published", atMs: START - 100 }, { event: "mic_unpublished", atMs: end + delta }] })), "input.1.r2_published_track_identity");
      expect(status, String(delta)).toMatchObject(delta > 0 ? { status: "pass", reason: null } : { status: "fail", reason: "mic_unpublished_during_utterance" });
    }
  });

  it("a reply is audible only with at least one frame and one non-silent frame played", () => {
    expect(product(evaluate(episode({ reply: { nonSilentFramesPlayed: 0 } })), "output.audible_reply")).toMatchObject({ status: "fail", reason: "no_reply_played_audibly" });
    expect(product(evaluate(episode({ reply: { nonSilentFramesPlayed: 1 } })), "output.audible_reply")).toMatchObject({ status: "pass", reason: null });
    expect(product(evaluate(episode({ reply: { framesPlayed: 0, nonSilentFramesPlayed: 0 } })), "output.audible_reply")).toMatchObject({ status: "fail", reason: "no_reply_played_audibly" });
    expect(product(evaluate(episode({ reply: { framesPlayed: 1, nonSilentFramesPlayed: 1 } })), "output.audible_reply")).toMatchObject({ status: "pass", reason: null });
  });

  it("missing bridge seqs are listed up to 1 000, never more", () => {
    // Seqs 0..4 are present; a receipt at seq 5 + n leaves n missing.
    for (const missing of [999, 1_000, 1_001]) {
      const evaluation = evaluate(episode({ lateProviderSeq: 5 + missing }));
      expect(evaluation.bridge.missing_seqs, String(missing)).toHaveLength(Math.min(missing, 1_000));
      expect(evaluation.bridge.missing_seqs[0], String(missing)).toBe(5);
    }
  });

  it("the summary names the first 32 withheld harness assertions, never more", () => {
    const run = studioRun(config);
    for (const inputs of [1, 12]) {
      const operations = Array.from({ length: inputs }, (_, index) => speakOperation(run, new Date(T0 + index)));
      const evaluation = evaluateStudioG7Run(run, [], operations, { expected });
      const withheld = evaluation.harness.filter((assertion) => assertion.status !== "pass").map((assertion) => `${assertion.id}=${assertion.status}`);
      const listed = evaluation.summary.replace(/^harness_withheld:/, "").split(",");
      expect(listed, String(inputs)).toEqual(withheld.slice(0, 32));
      if (inputs === 12) expect(withheld.length).toBeGreaterThan(32);
      else expect(withheld.length).toBeLessThan(32);
    }
  });
});

