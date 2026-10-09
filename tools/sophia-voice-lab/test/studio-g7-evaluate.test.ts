import { describe, expect, it } from "vitest";

import type { LabEvent, OperationRecord, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { deriveStudioG7Verdicts, evaluateStudioG7Run, studioG7CleanupProof, type StudioG7Evaluation } from "../src/studio-g7/evaluate.js";
import { studioPriorInputSettled } from "../src/worker.js";
import {
  API_SHA, BRIDGE_SHA, EventLog, LAB_TRACK_ID, STUDIO_SHA,
  cleanupEvents, evidenceGrant, identityEvent, inputTurn, inputWindow, labUtterance, outputReply, pageReceipt, providerReceipt, sessionClosed, speakOperation, studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";

const config = studioTestConfig();
const expected = { studio: STUDIO_SHA, api: API_SHA, bridge: BRIDGE_SHA };
const T0 = Date.parse("2026-10-09T10:00:00.000Z");

interface Episode { run: RunRecord; log: EventLog; operations: OperationRecord[] }

/** A complete two-utterance episode with every receipt the contract defines. */
function episode(options: { windowChain?: (windowSeq: number) => string; lateBridge?: boolean; skipCleanup?: boolean } = {}): Episode {
  const run = studioRun(config);
  const log = new EventLog(run.id);
  identityEvent(log, "startup");
  log.add("studio.auth.session_established", "canonical", { principal_bound: true });
  log.add("harness.media_stream_issued", "browser", { replacement_active: true, track_id_sha256s: [sha256(LAB_TRACK_ID)] });
  log.page(pageReceipt(run, "mic_published", T0));
  log.grant(evidenceGrant(run));
  const operations = [speakOperation(run, new Date(T0 + 1)), speakOperation(run, new Date(T0 + 2))];
  labUtterance(log, operations[0]!.id, T0 + 1_000, 1_500);
  log.page(pageReceipt(run, "sophia_playback", T0 + 2_900, { phase: "playing" }));
  labUtterance(log, operations[1]!.id, T0 + 10_000, 2_000);
  const window = (seq: number, windowSeq: number, durationMs: number) => inputWindow(run, seq, windowSeq, durationMs, options.windowChain ? { pcmSha256Chain: options.windowChain(windowSeq) } : {});
  const early: Array<[string, Record<string, unknown>]> = [
    ["provider", providerReceipt(run, 1, "setup")],
    ["provider", providerReceipt(run, 2, "ready")],
    ["input_window", window(3, 1, 1_500)],
    ["input_turn", inputTurn(run, 4, 1)],
    ["output_reply", outputReply(run, 5, 1, T0 + 3_000)],
    ["input_window", window(6, 2, 2_000)],
    ["input_turn", inputTurn(run, 7, 2)],
  ];
  const late: Array<[string, Record<string, unknown>]> = [
    ["output_reply", outputReply(run, 8, 2, T0 + 12_500)],
    ["provider", providerReceipt(run, 9, "closed")],
    ["session_closed", sessionClosed(run, 10, { windows: 2, turns: 2, replies: 2 })],
  ];
  for (const [kind, receipt] of early) log.bridge(kind, receipt);
  if (!options.lateBridge) for (const [kind, receipt] of late) log.bridge(kind, receipt);
  if (!options.skipCleanup) cleanupEvents(log);
  // Race: receipts written before End but read only after the Lab's end
  // verification are still evidence, ordered by seq.
  if (options.lateBridge) for (const [kind, receipt] of late) log.bridge(kind, receipt);
  identityEvent(log, "final");
  return { run, log, operations };
}

const evaluate = (item: Episode, events: LabEvent[] = item.log.events): StudioG7Evaluation => evaluateStudioG7Run(item.run, events, item.operations, { expected });
const statusOf = (evaluation: StudioG7Evaluation, id: string) => [...evaluation.harness, ...evaluation.product].find((assertion) => assertion.id === id);
const statusMap = (evaluation: StudioG7Evaluation) => Object.fromEntries([...evaluation.harness, ...evaluation.product].map((assertion) => [assertion.id, `${assertion.status}:${assertion.reason}`]));

describe("Studio G7 evaluation", () => {
  it("passes every receipt channel of a complete episode while keeping harness and product separate", () => {
    const item = episode();
    const evaluation = evaluate(item);
    for (const id of [
      "binding.run_binding", "bridge.seq_integrity", "input.published_track_is_lab_issued",
      "input.1.r1_scheduling_chain", "input.1.r2_published_track_identity", "input.1.r3_playout_chain",
      "input.2.r1_scheduling_chain", "input.2.r2_published_track_identity", "input.2.r3_playout_chain",
      "input.window_join", "session.closed_receipt", "guard.not_triggered",
      "cleanup.exchange_ended", "cleanup.principal_signed_out", "cleanup.browser_closed", "cleanup.browser_lease_released",
      "identity.api", "identity.studio", "identity.bridge",
      "contract.page_receipts_valid", "contract.bridge_evidence_valid", "input.1.window_envelope", "input.1.turn_accepted",
      "input.2.window_envelope", "input.2.turn_accepted", "provider.lifecycle", "output.audible_reply", "output.page_playback_join",
    ]) expect(statusOf(evaluation, id), id).toMatchObject({ status: "pass" });
    expect(evaluation.grant_id).toBe(evidenceGrant(item.run).grantId);
    expect(evaluation.pcm_reconciliation).toBe("envelope_only");
    expect(evaluation.pcm_chain_comparison).toBe("unsupported");
    // Non-voice and non-exposed steps stay typed unavailable, so the harness
    // cannot certify the whole G7 episode from this adapter alone.
    expect(statusOf(evaluation, "step.g7.leave_return.executed")).toMatchObject({ status: "unavailable", reason: "driver_action_not_exposed_as_mcp_operation" });
    expect(statusOf(evaluation, "step.g7.stale_edit.executed")).toMatchObject({ status: "unavailable", reason: "requires_separate_non_voice_controller" });
    expect(statusOf(evaluation, "step.g7.create.executed")).toMatchObject({ status: "pass" });
    expect(statusOf(evaluation, "step.g7.hold.executed")).toMatchObject({ status: "unavailable", reason: "utterance_not_performed" });
    expect(statusOf(evaluation, "step.g7.create.outcome")).toMatchObject({ status: "unavailable", reason: "member_api_work_join_not_implemented_in_adapter" });
    expect(evaluation.verdicts).toEqual({ harness: "unavailable", product: "inconclusive", provider: "pass" });
    expect(deriveStudioG7Verdicts(evaluation, { sessionEstablished: true })).toEqual({ harness: "unavailable", product: "inconclusive", provider: "pass", auth: "pass", evidence: "unavailable" });
    expect(deriveStudioG7Verdicts({ ...evaluation, verdicts: { ...evaluation.verdicts, harness: "pass" } }, { sessionEstablished: true }).evidence).toBe("pass");
    expect(evaluation.corroboration.webrtc_sender_stats.status).toBe("corroboration_only");
  });

  it("fails the harness when any receipt is bound to another run or grant", () => {
    const item = episode();
    item.log.page(pageReceipt(item.run, "mic_published", T0 + 5, {}, "f".repeat(64)));
    expect(statusOf(evaluate(item), "binding.run_binding")).toMatchObject({ status: "fail", reason: "receipt_run_binding_mismatch" });
    expect(evaluate(item).verdicts.harness).toBe("fail");

    const other = episode();
    other.log.page(pageReceipt(other.run, "sophia_playback", T0 + 6, { phase: "pause" }, undefined, "11111111-2222-4333-8444-555555555555"));
    expect(statusOf(evaluate(other), "binding.run_binding")).toMatchObject({ status: "fail", reason: "multiple_grant_ids_observed" });

    const grant = episode();
    grant.log.grant(evidenceGrant(grant.run, { runBindingSha256: "e".repeat(64), grantId: "22222222-3333-4444-8555-666666666666" }));
    expect(statusOf(evaluate(grant), "binding.run_binding")).toMatchObject({ status: "fail" });
  });

  it("types a guard-ended exchange and still requires proven cleanup", () => {
    const item = episode({ skipCleanup: true });
    item.log.bridge("guard", { grantId: evidenceGrant(item.run).grantId, runBindingSha256: evidenceGrant(item.run).runBindingSha256, seq: 11, atMs: T0 + 20_000, reason: "deadline" });
    const evaluation = evaluate(item);
    expect(statusOf(evaluation, "guard.not_triggered")).toMatchObject({ status: "fail", reason: "guard_deadline" });
    expect(evaluation.cleanup).toMatchObject({ required: true, guard_reason: "deadline", complete: false });
    expect(statusOf(evaluation, "cleanup.exchange_ended")).toMatchObject({ status: "fail" });
    expect(statusOf(evaluation, "cleanup.principal_signed_out")).toMatchObject({ status: "fail" });
    expect(deriveStudioG7Verdicts(evaluation, { sessionEstablished: true })).toMatchObject({ harness: "fail", auth: "fail", evidence: "fail" });

    const expired = episode();
    expired.log.grant(evidenceGrant(expired.run, { endedReason: "expired" }));
    expect(statusOf(evaluate(expired), "guard.not_triggered")).toMatchObject({ status: "fail", reason: "guard_expired" });
  });

  it("types missing receipts unavailable and never passes them", () => {
    const run = studioRun(config);
    const log = new EventLog(run.id);
    const operations = [speakOperation(run, new Date(T0))];
    labUtterance(log, operations[0]!.id, T0 + 1_000, 1_500);
    const evaluation = evaluateStudioG7Run(run, log.events, operations, { expected });
    for (const id of ["binding.run_binding", "input.published_track_is_lab_issued", "input.1.r2_published_track_identity", "input.window_join", "session.closed_receipt", "identity.api", "identity.studio", "identity.bridge"]) {
      expect(statusOf(evaluation, id), id).toMatchObject({ status: "unavailable" });
    }
    for (const id of ["contract.page_receipts_valid", "contract.bridge_evidence_valid", "input.1.window_envelope", "input.1.turn_accepted", "provider.lifecycle", "output.audible_reply", "output.page_playback_join"]) {
      expect(statusOf(evaluation, id), id).toMatchObject({ status: "unavailable" });
    }
    expect(evaluation.product.every((assertion) => assertion.status !== "pass")).toBe(true);
    expect(evaluation.verdicts.product).toBe("unavailable");
    expect(evaluation.verdicts.harness).not.toBe("pass");
  });

  it("reconciles input by ordinal and envelope only, never by PCM chain equality", () => {
    // A chain equal to what a Lab-side computation over these bytes would
    // give must change nothing: equality is never attempted.
    const labChain = sha256("lab-computed-chain");
    const equal = evaluate(episode({ windowChain: () => labChain }));
    const different = evaluate(episode({ windowChain: (windowSeq) => sha256(`unrelated-${windowSeq}`) }));
    expect(statusMap(equal)).toEqual(statusMap(different));
    expect(equal.utterances[0]).toMatchObject({ bridge_window: { pcm_chain_comparison: "unsupported", bridge_pcm_sha256_chain: labChain } });

    const short = episode();
    const shortened = short.log.events.map((event) => {
      if (event.kind !== "studio.bridge_receipt" || event.payload.kind !== "input_window" || event.payload.seq !== 3) return event;
      const receipt = inputWindow(short.run, 3, 1, 1_500, { sampleCount: 1_000, endedAtMs: 10_100 });
      const json = JSON.stringify(Object.fromEntries(Object.entries(receipt).sort(([a], [b]) => (a < b ? -1 : 1))));
      return { ...event, payload: { ...event.payload, receipt_json: json, receipt_sha256: sha256(json) } };
    });
    expect(statusOf(evaluate(short, shortened), "input.1.window_envelope")).toMatchObject({ status: "fail", reason: "window_shorter_than_utterance_envelope" });
  });

  it("fails the ordinal join when window and utterance counts disagree, and types dropped receipts unavailable", () => {
    const item = episode();
    item.operations.push(speakOperation(item.run, new Date(T0 + 3)));
    labUtterance(item.log, item.operations[2]!.id, T0 + 20_000, 1_000);
    expect(statusOf(evaluate(item), "input.window_join")).toMatchObject({ status: "fail", reason: "input_window_count_mismatch" });
    expect(statusOf(evaluate(item), "input.3.window_envelope")).toMatchObject({ status: "unavailable" });

    const dropped = episode();
    const withDrop = dropped.log.events.map((event) => {
      if (event.kind !== "studio.bridge_receipt" || event.payload.kind !== "session_closed") return event;
      const receipt = sessionClosed(dropped.run, 10, { windows: 3, turns: 2, replies: 2 });
      const json = JSON.stringify(Object.fromEntries(Object.entries(receipt).sort(([a], [b]) => (a < b ? -1 : 1))));
      return { ...event, payload: { ...event.payload, receipt_json: json, receipt_sha256: sha256(json) } };
    });
    expect(statusOf(evaluate(dropped, withDrop), "input.window_join")).toMatchObject({ status: "unavailable", reason: "bridge_receipts_dropped" });
    const gap = episode();
    const withoutSeq4 = gap.log.events.filter((event) => !(event.kind === "studio.bridge_receipt" && event.payload.seq === 4));
    const gapped = evaluate(gap, withoutSeq4);
    expect(gapped.bridge.missing_seqs).toEqual([4]);
    expect(statusOf(gapped, "input.window_join")).toMatchObject({ status: "unavailable" });
  });

  it("orders bridge receipts by seq deterministically: duplicates, shuffles and late reads give the same verdict", () => {
    const baseline = evaluate(episode());
    const shuffledItem = episode();
    const bridge = shuffledItem.log.events.filter((event) => event.kind === "studio.bridge_receipt");
    const others = shuffledItem.log.events.filter((event) => event.kind !== "studio.bridge_receipt");
    const shuffled = [...others, ...[...bridge].reverse(), ...bridge.slice(0, 3).map((event, index) => ({ ...event, seq: 10_000 + index }))]
      .map((event, index) => ({ ...event, seq: index + 1 }));
    const reordered = evaluate(shuffledItem, shuffled);
    expect(statusMap(reordered)).toEqual(statusMap(baseline));
    expect(reordered.bridge.duplicate_count).toBe(3);

    const late = evaluate(episode({ lateBridge: true }));
    expect(statusMap(late)).toEqual(statusMap(baseline));
    expect(late.bridge.read_after_lab_end_count).toBe(3);
    expect(baseline.bridge.read_after_lab_end_count).toBe(0);

    const conflict = episode();
    conflict.log.bridge("input_turn", inputTurn(conflict.run, 4, 1, { outcome: "interrupted" }));
    const conflicted = evaluate(conflict);
    expect(statusOf(conflicted, "bridge.seq_integrity")).toMatchObject({ status: "fail", reason: "bridge_seq_conflict" });
    expect(conflicted.bridge.conflicting_seqs).toEqual([4]);
    expect(conflicted.verdicts.harness).toBe("fail");
  });

  it("fails a physical-microphone fallback and an unpublished mic during speech", () => {
    const foreign = episode();
    foreign.log.page(pageReceipt(foreign.run, "mic_published", T0 + 500, { trackId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }));
    expect(statusOf(evaluate(foreign), "input.published_track_is_lab_issued")).toMatchObject({ status: "fail", reason: "published_track_not_lab_issued" });
    expect(statusOf(evaluate(foreign), "input.1.r2_published_track_identity")).toMatchObject({ status: "fail" });

    const unpublished = episode();
    unpublished.log.page(pageReceipt(unpublished.run, "mic_unpublished", T0 + 1_200));
    expect(statusOf(evaluate(unpublished), "input.1.r2_published_track_identity")).toMatchObject({ status: "fail", reason: "mic_unpublished_during_utterance" });
    expect(statusOf(evaluate(unpublished), "input.2.r2_published_track_identity")).toMatchObject({ status: "fail", reason: "mic_unpublished_at_utterance_start" });
  });

  it("rejects tampered or free-text receipts and never forges Gemini-only evidence", () => {
    const tampered = episode();
    const events = tampered.log.events.map((event) => event.kind === "studio.bridge_receipt" && event.payload.seq === 4
      ? { ...event, payload: { ...event.payload, receipt_json: String(event.payload.receipt_json).replace('"outcome":"answered"', '"outcome":"answered","transcript":"build me a landing page"') } }
      : event);
    expect(statusOf(evaluate(tampered, events), "contract.bridge_evidence_valid")).toMatchObject({ status: "fail", reason: "bridge_evidence_contract_violation" });

    const rejected = episode();
    rejected.log.add("studio.page_receipt_rejected", "browser", { reason: "page_receipt_schema_invalid", path: "trackId" });
    expect(statusOf(evaluate(rejected), "contract.page_receipts_valid")).toMatchObject({ status: "fail" });

    const legacy = episode();
    legacy.log.add("harness.input_frame_forwarded", "browser", { operation_id: legacy.operations[0]!.id, frame_seq: 1 });
    expect(statusOf(evaluate(legacy), "legacy.harness.input_frame_forwarded")).toMatchObject({ status: "fail", reason: "legacy_gemini_browser_evidence_on_studio_target" });
  });

  it("types deployed identities: mismatch fails, missing is unavailable", () => {
    const mismatch = episode();
    identityEvent(mismatch.log, "final", { status: "observed", commit: "9".repeat(40) });
    expect(statusOf(evaluate(mismatch), "identity.api")).toMatchObject({ status: "fail", reason: "api_commit_mismatch" });

    const missing = episode();
    identityEvent(missing.log, "final", { status: "observed", commit: API_SHA }, { status: "unavailable", reason: "identity_not_published" });
    expect(statusOf(evaluate(missing), "identity.studio")).toMatchObject({ status: "unavailable" });

    const nullBridge = episode();
    nullBridge.log.bridge("provider", providerReceipt(nullBridge.run, 11, "usage", { bridgeCommit: null }));
    expect(statusOf(evaluate(nullBridge), "identity.bridge")).toMatchObject({ status: "unavailable" });

    const wrongBridge = episode();
    wrongBridge.log.bridge("provider", providerReceipt(wrongBridge.run, 11, "usage", { bridgeCommit: "8".repeat(40) }));
    expect(statusOf(evaluate(wrongBridge), "identity.bridge")).toMatchObject({ status: "fail", reason: "bridge_commit_mismatch" });
  });

  it("joins playback to the page's Sophia element and corroborates WebRTC stats without using them", () => {
    // A pause after the reply started is not evidence against it.
    const pausedLater = episode();
    pausedLater.log.page(pageReceipt(pausedLater.run, "sophia_playback", T0 + 3_500, { phase: "pause" }));
    pausedLater.log.page(pageReceipt(pausedLater.run, "sophia_playback", T0 + 11_000, { phase: "playing" }));
    expect(statusOf(evaluate(pausedLater), "output.page_playback_join")).toMatchObject({ status: "pass" });
    // A pause definitely before a later reply (beyond clock tolerance) is.
    const paused = episode();
    paused.log.page(pageReceipt(paused.run, "sophia_playback", T0 + 3_500, { phase: "pause" }));
    expect(statusOf(evaluate(paused), "output.page_playback_join")).toMatchObject({ status: "fail", reason: "sophia_element_not_playing_at_reply" });
    // No playing phase at all before the reply is unjoined.
    const never = episode();
    const withoutPlaying = never.log.events.filter((event) => !(event.kind === "studio.page_receipt" && event.payload.event === "sophia_playback"));
    expect(statusOf(evaluate(never, withoutPlaying), "output.page_playback_join")).toMatchObject({ status: "unavailable", reason: "no_sophia_playback_page_receipt" });

    const stats = episode();
    stats.log.add("studio.webrtc.sender_stats", "browser", { corroboration_only: true, rows: [{ track_id_sha256: sha256(LAB_TRACK_ID), packets_sent: 120 }] });
    const evaluation = evaluate(stats);
    expect(evaluation.corroboration.webrtc_sender_stats).toEqual({ status: "corroboration_only", samples: 1, issued_track_rows: 1, max_packets_sent: 120 });
    expect(statusMap(evaluation)).toEqual(statusMap(evaluate(episode())));

    // Stats alone never satisfy the published-track receipt.
    const run = studioRun(config);
    const log = new EventLog(run.id);
    log.add("harness.media_stream_issued", "browser", { replacement_active: true, track_id_sha256s: [sha256(LAB_TRACK_ID)] });
    log.add("studio.webrtc.sender_stats", "browser", { corroboration_only: true, rows: [{ track_id_sha256: sha256(LAB_TRACK_ID), packets_sent: 500 }] });
    expect(statusOf(evaluateStudioG7Run(run, log.events, [], { expected }), "input.published_track_is_lab_issued")).toMatchObject({ status: "unavailable" });
  });

  it("derives the cleanup proof and the studio input-settlement gate", () => {
    const item = episode();
    expect(studioG7CleanupProof(item.log.events)).toEqual({ exchangeEnded: true, signedOut: true, browserClosed: true, complete: true });
    expect(studioG7CleanupProof(episode({ skipCleanup: true }).log.events).complete).toBe(false);
    const run = studioRun(config);
    const log = new EventLog(run.id);
    const prior = speakOperation(run, new Date(T0));
    expect(studioPriorInputSettled(log.events, [prior], prior.id)).toBe(false);
    labUtterance(log, prior.id, T0 + 1_000, 1_000);
    expect(studioPriorInputSettled(log.events, [prior], prior.id)).toBe(false);
    log.bridge("input_window", inputWindow(run, 1, 1, 1_000));
    expect(studioPriorInputSettled(log.events, [prior], prior.id)).toBe(true);
  });
});
