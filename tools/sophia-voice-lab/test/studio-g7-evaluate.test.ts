import { describe, expect, it } from "vitest";

import type { LabEvent, OperationRecord, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { deriveStudioG7Verdicts, evaluateStudioG7Run, studioG7CleanupProof, type StudioG7Evaluation } from "../src/studio-g7/evaluate.js";
import { studioPriorInputSettled } from "../src/worker.js";
import { canonicalJson } from "../src/studio-g7/contract.js";
import {
  API_SHA, BRIDGE_SHA, EXCHANGE_UUID, EventLog, GRANT_UUID, LAB_TRACK_ID, STUDIO_SHA,
  cleanupEvents, evidenceGrant, guardReceipt, identityEvent, inputTurn, inputWindow, labUtterance, outputReply, pageReceipt, providerReceipt, sessionClosed, speakOperation, studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";
import { randomUUID } from "node:crypto";
import type { OperationRecord as Operation } from "../src/domain.js";

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
  it("passes every receipt channel of a two-utterance episode while keeping harness and product separate", () => {
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
    expect(evaluation.retention).toEqual({ transcript: "not_retained", audio: "not_retained" });
    expect(evaluation.limitations).toEqual(expect.arrayContaining(["fake_studio_loopback_peer_has_no_packet_flow_proof", "no_transcript_retained", "no_audio_retained"]));
    // Steps not performed while the run is live are typed unavailable; the
    // exchange was never proven the run's own here, so harness withholds.
    expect(statusOf(evaluation, "step.g7.leave_return.executed")).toMatchObject({ status: "unavailable", reason: "step_not_yet_performed" });
    expect(statusOf(evaluation, "binding.exchange_ownership")).toMatchObject({ status: "unavailable" });
    expect(evaluation.verdicts.harness).toBe("unavailable");
    expect(deriveStudioG7Verdicts(evaluation, { sessionEstablished: true })).toMatchObject({ harness: "unavailable", auth: "pass", evidence: "unavailable" });
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
    item.log.bridge("guard", guardReceipt(item.run, "deadline", T0 + 20_000), "service", 0);
    const evaluation = evaluate(item);
    expect(statusOf(evaluation, "guard.not_triggered")).toMatchObject({ status: "fail", reason: "guard_deadline" });
    expect(evaluation.cleanup).toMatchObject({ required: true, guard_reason: "deadline", complete: false });
    expect(statusOf(evaluation, "cleanup.exchange_ended")).toMatchObject({ status: "fail", reason: "exchange_end_not_verified" });
    expect(statusOf(evaluation, "cleanup.principal_signed_out")).toMatchObject({ status: "fail" });
    expect(deriveStudioG7Verdicts(evaluation, { sessionEstablished: true })).toMatchObject({ harness: "fail", auth: "fail", evidence: "fail" });

    const expired = episode();
    expired.log.grant(evidenceGrant(expired.run, { endedReason: "expired" }), "ended");
    expect(statusOf(evaluate(expired), "guard.not_triggered")).toMatchObject({ status: "fail", reason: "guard_expired" });
    // 0046's sixth reason.
    const turns = episode();
    turns.log.bridge("guard", guardReceipt(turns.run, "turns", T0 + 20_000), "service", 0);
    expect(statusOf(evaluate(turns), "guard.not_triggered")).toMatchObject({ status: "fail", reason: "guard_turns" });
    // A guard receipt arriving from the bridge source is a contract violation, not evidence.
    const forged = episode();
    forged.log.bridge("guard", guardReceipt(forged.run, "deadline"), "bridge", 0);
    expect(statusOf(evaluate(forged), "contract.bridge_evidence_valid")).toMatchObject({ status: "fail" });
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
    expect(conflicted.bridge.conflicting_seqs).toEqual(["bridge:4"]);
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
    expect(studioG7CleanupProof(item.log.events)).toEqual({ exchangeEnded: true, signedOut: true, browserClosed: true, browserQuiesced: false, refreshSessionsRevoked: true, complete: true });
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

const DESIGN_TASK = "d0000000-0000-4000-8000-000000000001";
const EDIT_TASK = "d0000000-0000-4000-8000-000000000002";
const RESEARCH_TASK = "d0000000-0000-4000-8000-000000000003";
const ARTIFACT = "a0000000-0000-4000-8000-000000000001";
const VERSION_1 = "b0000000-0000-4000-8000-000000000001";
const VERSION_2 = "b0000000-0000-4000-8000-000000000002";
const NOTE = "c0000000-0000-4000-8000-000000000001";
const PAGE_SHA = sha256("<html>page</html>");
const PAGE2_SHA = sha256("<html>page v2</html>");

function op(run: RunRecord, type: Operation["type"], createdAt: number, input: Record<string, unknown>, result: Record<string, unknown> | null = {}, state: Operation["state"] = "succeeded"): Operation {
  return { ...speakOperation(run, new Date(createdAt)), id: randomUUID(), type, input, result, state };
}

function task(id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { task_id: id, kind, state: "running", phase: "running", created_at: new Date(T0 + 5_000).toISOString(), focus: false, research: null, design: null, outputs: [], ...extra };
}

function artifact(taskId: string, versionId: string, digest: string, status = "verified"): Record<string, unknown> {
  return { artifact_id: ARTIFACT, version_id: versionId, task_id: taskId, version_state: "stable", version_format: "html", is_latest: true, source_id: randomUUID(), rendition_sha256: digest, source_hash: digest, content_sha256: digest, downloaded_sha256: status === "mismatch" ? sha256("other bytes") : digest, downloaded_byte_length: 20, download_basis: "signed_object_store_url", source_hash_compared: true, hashes_agree: status === "verified", status, reason: status === "verified" ? null : "downloaded_bytes_disagree_with_declared_digest" };
}

/**
 * The exchange's calls as the product records them (A15 getExchangeCalls),
 * on a logical clock: each read has `readAt`; `?after=<readAt>` lists only
 * calls whose recording began after that read. For each voice step the
 * worker reads its baseline (all calls listed so far), the step's calls are
 * recorded, then the step's own after-read is taken as soon as it settles.
 * - `byStep`: calls whose recording begins during the step;
 * - `inFlightAtBaseline`: calls already on their way at the step's baseline
 *   (recording began before it, committed after): never in its after-read;
 * - `unansweredFirst`: the step's first after-read still lists its call
 *   unanswered (a second read has it answered), or `unansweredOnly` never;
 * - `lateAfterRead`: calls recorded after the step's own settled after-read,
 *   listed by a second after-read;
 * - `vanishing`: a second after-read no longer lists the step's command;
 * - `unavailable`: every read refused instead.
 */
interface CallsScript {
  byStep: Record<string, Array<Record<string, unknown>>>;
  inFlightAtBaseline?: Record<string, Array<Record<string, unknown>>>;
  unansweredFirst?: string[];
  unansweredOnly?: string[];
  lateAfterRead?: Record<string, Array<Record<string, unknown>>>;
  vanishing?: string[];
  unavailable?: { reason: string; http_status: number };
}

interface G7Options {
  skip?: string[]; staleCode?: string; staleStatus?: number; artifactStatus?: string; ownership?: "proven" | "mismatch" | "unavailable"; withdrawalCommitted?: boolean;
  noEnd?: boolean; calls?: CallsScript; researchTask?: Record<string, unknown>; windowEpochs?: Record<string, number>; noEndAudit?: boolean;
  /** R's inputSourceIds (default: the run's note source S). */
  researchInputs?: string[] | null;
  /** X's design state in the withdrawal's before-observation (default designing); null: no before-observation. */
  editBefore?: string | null;
  /** X's sighting in the withdrawal's after-observation (default: failed for the revoke reason, S withdrawn). */
  editAfter?: Record<string, unknown>;
  withdrawalAfterOperation?: string;
  /** The withdraw_note receipt's sourceId (default S). */
  receiptSource?: string | null;
  /** The withdrawal's entry (default the run's own note N). */
  withdrawnEntry?: string;
  /** The Stop sub-episode task in its own observe, and in Stop's observe. */
  stopTargetBefore?: Record<string, unknown>;
  stopEffect?: Record<string, unknown>;
}

const GOAL_A = "e0000000-0000-4000-8000-0000000000a1";
const GOAL_B = "e0000000-0000-4000-8000-0000000000b2";
const STOP_TASK = "d0000000-0000-4000-8000-000000000004";
const NOTE_SOURCE = "c0000000-0000-4000-8000-000000000051";

/**
 * A complete G7 episode in the order the product's lifecycle supports: the
 * run's own note N (source S) recorded first; create (research R drawing on
 * S, its design D under way); steer; leave and return; hold and resume while
 * D is live; once D published (version 2), the revision (edit X, live);
 * the stale probe (version 1, superseded); the withdrawal of N while X is
 * live (X failed for the revoke reason, S withdrawn); then the Stop
 * sub-episode: a second create (STOP_TASK on its own goal) and Stop on it.
 */
function g7Episode(options: G7Options = {}): Episode {
  const run = studioRun(config);
  const log = new EventLog(run.id);
  const skip = new Set(options.skip ?? []);
  identityEvent(log, "startup");
  log.add("studio.auth.session_established", "canonical", { principal_bound: true });
  log.add("harness.media_stream_issued", "browser", { replacement_active: true, track_id_sha256s: [sha256(LAB_TRACK_ID)] });
  log.page(pageReceipt(run, "mic_published", T0));
  log.add("studio.grant_gate.passed", "browser", { grant_id: GRANT_UUID, run_binding_sha256: evidenceGrant(run).runBindingSha256 });
  log.add("studio.exchange.speak_requested", "canonical", { grant_id: GRANT_UUID, write_ahead: true });
  log.add("studio.exchange.opened", "canonical", { exchange_id: EXCHANGE_UUID, grant_id: GRANT_UUID, opened_at_lab_ms: T0 });
  log.add("studio.exchange.ownership", "canonical", { exchange_id: EXCHANGE_UUID, status: options.ownership ?? "proven", reason: options.ownership === "mismatch" ? "evidence_bound_to_another_run" : null });
  log.grant(evidenceGrant(run));
  const operations: Operation[] = [];
  let seq = 0;
  log.bridge("provider", providerReceipt(run, seq++, "ready"));
  // The product's record on a logical clock: when each call's recording began and when it committed.
  const recorded: Array<{ call: Record<string, unknown>; began: number; committed: number }> = [];
  let clock = 0;
  const readAt = (tick: number) => new Date(T0 + 10_000_000 + tick * 1_000).toISOString();
  const callsRead = (purpose: "baseline" | "after", operationId: string, stepId: string, after: number | null, transform: (calls: Array<Record<string, unknown>>) => Array<Record<string, unknown>> = (calls) => calls) => {
    if (!options.calls) return null;
    clock += 1;
    const base = { schema: "sophia_voice_lab_studio_exchange_calls_v1", purpose, operation_id: operationId, step_id: stepId, exchange_id: EXCHANGE_UUID, after: after === null ? null : readAt(after), read_id: randomUUID() };
    const refusal = options.calls.unavailable;
    if (refusal) { log.add("studio.exchange.calls_read", "canonical", { ...base, status: "unavailable", reason: refusal.reason, http_status: refusal.http_status, read_at: null, settled: false, attempts: 0, max_seq: null, calls: [] }); return clock; }
    const listed = transform(recorded.filter((item) => item.committed <= clock && (after === null || item.began > after)).map((item) => item.call).sort((left, right) => Number(left.seq) - Number(right.seq)));
    log.add("studio.exchange.calls_read", "canonical", { ...base, status: "available", reason: null, http_status: 200, read_at: readAt(clock), settled: listed.every((call) => call.answered_at !== null), attempts: 1, max_seq: Number(listed.at(-1)?.seq ?? 0), calls: listed });
    return clock;
  };
  const record = (calls: Array<Record<string, unknown>>, began: number, committed: number) => { for (const call of calls) recorded.push({ call, began, committed }); };
  const researchInputs = options.researchInputs === undefined ? [NOTE_SOURCE] : options.researchInputs;
  const research = (extra: Record<string, unknown> = {}) => task(RESEARCH_TASK, "research", { input_source_ids: researchInputs, withdrawn_source_ids: [], ...(options.researchTask ?? {}), state: "running", phase: "result_ready", research: { html_state: "designing", design_task_id: DESIGN_TASK }, ...extra });
  const goalOf = { goal_id: (options.researchTask?.goal_id as string | undefined) ?? GOAL_A };
  const designD = (state: string, phase = "running") => task(DESIGN_TASK, "design", { ...goalOf, state: state === "published" ? "succeeded" : "running", phase: state === "published" ? "result_ready" : phase, withdrawn_source_ids: [], design: { state, mode: "create", artifact_id: ARTIFACT, published_version_id: state === "published" ? VERSION_2 : null, research_task_id: RESEARCH_TASK } });
  const editX = (extra: Record<string, unknown> = {}) => task(EDIT_TASK, "design", { ...goalOf, state: "running", phase: "running", withdrawn_source_ids: [], design: { state: "designing", mode: "edit", artifact_id: ARTIFACT, published_version_id: null, research_task_id: RESEARCH_TASK }, ...extra });
  const stopTask = (extra: Record<string, unknown>) => task(STOP_TASK, "research", { exchange_id: EXCHANGE_UUID, goal_id: GOAL_B, input_source_ids: [], withdrawn_source_ids: [], ...extra });
  const observe = (forStep: string, at: number, tasks: Array<Record<string, unknown>>, artifacts: Array<Record<string, unknown>> = []) => {
    const observeOp = op(run, "studio_action", at, { action: "observe", for_step: forStep }, { performed: false, status: "observed" });
    operations.push(observeOp);
    log.add("studio.outcome.observed", "canonical", { purpose: `g7.${forStep}`, operation_id: observeOp.id, join: { status: "uncertain" }, tasks, artifacts });
  };
  let ordinal = 0;
  const voiceStep = (step: string, after: () => void = () => undefined) => {
    if (skip.has(`g7.${step}`)) return;
    const index = ordinal++;
    const speak = op(run, "speak", T0 + 100 + index * 100, { fixture_id: "conversation_greeting_probe", _g7_step: `g7.${step}` }, { schedule_receipt: { product: {} } });
    operations.push(speak);
    const stepId = `g7.${step}`;
    const calls = options.calls;
    // Already on its way at the baseline: recording began before it, committed after it.
    if (calls) record(calls.inFlightAtBaseline?.[stepId] ?? [], clock + 0.5, clock + 1.5);
    const baseline = callsRead("baseline", speak.id, stepId, null);
    labUtterance(log, speak.id, T0 + 1_000 + index * 10_000, 1_500);
    log.bridge("input_window", inputWindow(run, seq++, index + 1, 1_500, options.windowEpochs?.[stepId] === undefined ? {} : { inputEpoch: options.windowEpochs[stepId] }));
    if (calls && baseline !== null) {
      const own = calls.byStep[stepId] ?? [];
      record(own, baseline + 0.1, baseline + 0.2);
      // As soon as the step settles: its own after-read (re-read until every call is answered).
      if (calls.unansweredFirst?.includes(stepId) || calls.unansweredOnly?.includes(stepId)) {
        callsRead("after", speak.id, stepId, baseline, (listed) => listed.map((call) => ({ ...call, answered_at: null, outcome: null, command: null })));
      }
      if (!calls.unansweredOnly?.includes(stepId)) callsRead("after", speak.id, stepId, baseline);
      const late = calls.lateAfterRead?.[stepId];
      if (late) { record(late, clock + 0.1, clock + 0.2); callsRead("after", speak.id, stepId, baseline); }
      if (calls.vanishing?.includes(stepId)) callsRead("after", speak.id, stepId, baseline, (listed) => listed.filter((call) => call.command === null));
    }
    log.bridge("input_turn", inputTurn(run, seq++, index + 1));
    if (index === 0) log.page(pageReceipt(run, "sophia_playback", T0 + 2_900, { phase: "playing" }));
    log.bridge("output_reply", outputReply(run, seq++, index + 1, T0 + 3_000 + index * 10_000));
    after();
  };
  // 1. The run's own note N, through the principal's own route: its receipt names S.
  if (!skip.has("g7.record_note")) {
    const note = op(run, "studio_action", T0 + 50, { action: "record_note" }, { performed: true, status: "committed" });
    operations.push(note);
    log.add("studio.action.record_note", "canonical", { operation_id: note.id, requested: true, status: "committed", http_status: 202, code: null, entry_id: NOTE, source_id: NOTE_SOURCE, receipt_operation: "record_note", text_sha256: sha256("note") });
  }
  // 2-3. Create (R draws on S; its design D under way), steer.
  voiceStep("create", () => observe("create", T0 + 110, [research(), designD("designing")]));
  voiceStep("steer");
  if (!skip.has("g7.leave_return")) {
    const leave = op(run, "studio_action", T0 + 200, { action: "leave_and_return" }, { performed: true, status: "returned" });
    operations.push(leave);
    log.add("studio.room.left", "browser", { basis: "ui_leave", operation_id: leave.id });
    log.page(pageReceipt(run, "mic_unpublished", T0 + 60_000));
    log.page(pageReceipt(run, "mic_published", T0 + 61_000));
    log.add("studio.room.rejoined", "browser", { lab_track_republished: true, operation_id: leave.id });
  }
  // 5-6. Hold and resume while D is live (the research reads result_ready; D is held, then running).
  voiceStep("hold", () => observe("hold", T0 + 310, [research(), designD("designing", "held")]));
  voiceStep("resume", () => observe("resume", T0 + 410, [research(), designD("designing", "running")]));
  // 7. Once D published its page (version 2): the revision, an edit X under way.
  if (!skip.has("g7.section_revision")) {
    const edit = op(run, "studio_action", T0 + 500, { action: "section_revision", instruction: "x" }, { performed: true, status: "admitted" });
    operations.push(edit);
    log.add("studio.action.html_edit", "canonical", { purpose: "section_revision", operation_id: edit.id, target_join: "canonical_chain", requested: true, status: "admitted", http_status: 202, code: null, task_id: EDIT_TASK, artifact_id: ARTIFACT, version_id: VERSION_2 });
    log.add("studio.outcome.observed", "canonical", { purpose: "g7.section_revision", operation_id: edit.id, join: { status: "uncertain" }, tasks: [editX(), designD("published"), research()], artifacts: [artifact(DESIGN_TASK, VERSION_2, PAGE_SHA, options.artifactStatus)] });
  }
  // 8. The stale probe: version 1, superseded by D's version 2.
  if (!skip.has("g7.stale_edit")) {
    const stale = op(run, "studio_action", T0 + 600, { action: "stale_edit" }, { performed: true, status: options.staleStatus === 202 ? "admitted" : "refused" });
    operations.push(stale);
    log.add("studio.action.html_edit", "canonical", { purpose: "stale_edit", operation_id: stale.id, target_join: "canonical_chain", artifact_id: ARTIFACT, requested: true, status: options.staleStatus === 202 ? "admitted" : "refused", http_status: options.staleStatus ?? 409, code: options.staleCode ?? "stale_revision", version_id: VERSION_1, superseded_by_version_id: VERSION_2 });
  }
  // 9. The withdrawal of N while X is live.
  if (!skip.has("g7.withdrawal")) {
    const withdraw = op(run, "studio_action", T0 + 700, { action: "withdrawal" }, { performed: true, status: "committed" });
    operations.push(withdraw);
    const committed = options.withdrawalCommitted ?? true;
    if (options.editBefore !== null) {
      const before = options.editBefore ?? "designing";
      log.add("studio.outcome.observed", "canonical", { purpose: "g7.withdrawal:before", operation_id: withdraw.id, join: { status: "uncertain" }, tasks: [editX(before === "designing" ? {} : { state: before === "published" ? "succeeded" : before === "failed" ? "failed" : "running", design: { state: before, mode: "edit", artifact_id: ARTIFACT, published_version_id: before === "published" ? randomUUID() : null, research_task_id: RESEARCH_TASK } }), designD("published"), research()], artifacts: [] });
    }
    log.add("studio.action.withdrawal", "canonical", { operation_id: withdraw.id, requested: true, status: committed ? "committed" : "refused", own_create_task_id: RESEARCH_TASK, design_task_id: DESIGN_TASK, own_live_task_ids: [EDIT_TASK], entry_id: options.withdrawnEntry ?? NOTE, entry_bound_exchange_id: null, own_note_entry_id: NOTE, own_note_source_id: NOTE_SOURCE, entry_source_id: NOTE_SOURCE, http_status: committed ? 202 : 409, code: committed ? null : "stale_revision", receipt_operation: committed ? "withdraw_note" : null, receipt_source_id: committed ? (options.receiptSource === undefined ? NOTE_SOURCE : options.receiptSource) : null });
    const xAfter = editX({ state: "failed", phase: "failed", reason_class: "revoked_source_withdrawn", withdrawn_source_ids: [NOTE_SOURCE], design: { state: "failed", mode: "edit", artifact_id: ARTIFACT, published_version_id: null, research_task_id: RESEARCH_TASK, reason_class: "revoked_source_withdrawn" }, ...(options.editAfter ?? {}) });
    log.add("studio.outcome.observed", "canonical", { purpose: "g7.withdrawal", operation_id: options.withdrawalAfterOperation ?? withdraw.id, join: { status: "uncertain" }, tasks: [xAfter, designD("published"), research({ withdrawn_source_ids: [NOTE_SOURCE] })], artifacts: [] });
  }
  // 10-11. The Stop sub-episode: its own create (STOP_TASK on its own goal), then Stop on it.
  voiceStep("create_stop_target", () => observe("create_stop_target", T0 + 810, [stopTask({ state: "pending", phase: "queued", ...(options.stopTargetBefore ?? {}) })]));
  voiceStep("stop", () => observe("stop", T0 + 910, [stopTask({ state: "cancelled", phase: "stopped", reason_class: "stopped", ...(options.stopEffect ?? {}) })]));
  log.add("studio.outcome.observed", "canonical", { purpose: "final", operation_id: "end", join: { status: "uncertain" }, tasks: [designD("published"), research({ withdrawn_source_ids: [NOTE_SOURCE] }), editX({ state: "failed", phase: "failed", reason_class: "revoked_source_withdrawn", withdrawn_source_ids: [NOTE_SOURCE], design: { state: "failed", mode: "edit", artifact_id: ARTIFACT, published_version_id: null, research_task_id: RESEARCH_TASK, reason_class: "revoked_source_withdrawn" } })], artifacts: [artifact(DESIGN_TASK, VERSION_2, PAGE_SHA, options.artifactStatus)] });
  log.bridge("provider", providerReceipt(run, seq++, "closed"));
  log.bridge("session_closed", sessionClosed(run, seq++, { windows: ordinal, turns: ordinal, replies: ordinal }));
  // End's post-quiescence audit of every call: after the exchange ended and session_closed, before the sign-out.
  cleanupEvents(log, () => { if (!options.noEndAudit) callsRead("baseline", "end", "final", null); });
  identityEvent(log, "final");
  if (!options.noEnd) operations.push(op(run, "end", T0 + 990, {}, {}));
  return { run, log, operations };
}

describe("Studio G7 episode: every step is an operation, outcomes are canonical or typed uncertain", () => {
  it("certifies the harness of a complete episode; without the exchange's calls no voice outcome is certified, so the product is inconclusive", () => {
    const item = g7Episode();
    const evaluation = evaluate(item);
    const failing = [...evaluation.harness].filter((assertion) => assertion.status !== "pass");
    expect(failing).toEqual([]);
    expect(evaluation.verdicts).toEqual({ harness: "pass", product: "inconclusive", provider: "pass" });
    expect(evaluation.bridge.first_seq).toBe(0);
    expect(evaluation.bridge.missing_seqs).toEqual([]);
    const steps = Object.fromEntries(evaluation.steps.map((step) => [step.step_id, `${step.executed}/${step.outcome}:${step.reason}`]));
    // No calls were read (a product without voice qualification): never attributed by timing.
    expect(steps).toEqual({
      "g7.record_note": "pass/pass:null",
      "g7.create": "pass/unavailable:no_calls_baseline",
      "g7.steer": "pass/unavailable:no_calls_baseline",
      "g7.leave_return": "pass/pass:null",
      // Without a certified create there is no own report: an edit is never the run's by its window.
      "g7.section_revision": "pass/unavailable:create_step_not_certified",
      "g7.stale_edit": "pass/unavailable:create_step_not_certified",
      "g7.hold": "pass/unavailable:no_calls_baseline",
      "g7.resume": "pass/unavailable:no_calls_baseline",
      "g7.withdrawal": "pass/pass:null",
      "g7.create_stop_target": "pass/unavailable:no_calls_baseline",
      "g7.stop": "pass/unavailable:no_calls_baseline",
    });
    expect(statusOf(evaluation, "step.g7.withdrawal.design_ended")).toMatchObject({ status: "unavailable", reason: "create_step_not_certified" });
    expect(statusOf(evaluation, "outcome.artifact_bytes_integrity")).toMatchObject({ status: "unavailable", reason: "create_step_not_certified" });
    expect(evaluation.outcome).toMatchObject({ join: "uncertain", bound_tasks: 0, missing_product_field: "ExchangeCalls", artifacts_verified: 0, artifacts_mismatched: 0, own_report: { status: "unavailable", reason: "create_step_not_certified" } });
    const verdicts = deriveStudioG7Verdicts(evaluation, { sessionEstablished: true });
    expect(verdicts).toEqual({ harness: "pass", product: "inconclusive", provider: "pass", auth: "pass", evidence: "pass" });
  });

  it("fails a step not performed before End instead of leaving the run pending", () => {
    const item = g7Episode({ skip: ["g7.stale_edit", "g7.hold"] });
    const evaluation = evaluate(item);
    expect(statusOf(evaluation, "step.g7.stale_edit.executed")).toMatchObject({ status: "fail", reason: "step_not_performed_before_end" });
    expect(statusOf(evaluation, "step.g7.hold.executed")).toMatchObject({ status: "fail", reason: "step_not_performed_before_end" });
    expect(evaluation.verdicts.harness).toBe("fail");
    const live = g7Episode({ skip: ["g7.stale_edit"], noEnd: true });
    expect(statusOf(evaluate(live), "step.g7.stale_edit.executed")).toMatchObject({ status: "unavailable", reason: "step_not_yet_performed" });
  });

  it("types a target that could not be resolved as not performed, never as executed", () => {
    const item = g7Episode({ skip: ["g7.stale_edit"] });
    const attempt = op(item.run, "studio_action", T0 + 450, { action: "stale_edit" }, { performed: false, status: "unavailable", reason: "no_superseded_version" });
    item.operations.splice(item.operations.length - 1, 0, attempt);
    expect(statusOf(evaluate(item), "step.g7.stale_edit.executed")).toMatchObject({ status: "fail", reason: "no_superseded_version" });
  });

  it("fails product outcomes the Lab's own requests prove wrong", () => {
    // The run's own report: its create step is certified from the exchange's calls.
    const own = (options: G7Options) => g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() }, ...options });
    expect(statusOf(evaluate(own({ staleStatus: 202 })), "step.g7.stale_edit.outcome")).toMatchObject({ status: "fail", reason: "stale_edit_admitted" });
    expect(statusOf(evaluate(own({ staleStatus: 409, staleCode: "invalid_state" })), "step.g7.stale_edit.outcome")).toMatchObject({ status: "fail", reason: "stale_edit_refused_as_invalid_state" });
    expect(statusOf(evaluate(own({ withdrawalCommitted: false })), "step.g7.withdrawal.outcome")).toMatchObject({ status: "fail" });
    const mismatch = evaluate(own({ artifactStatus: "mismatch" }));
    expect(statusOf(mismatch, "outcome.artifact_bytes_integrity")).toMatchObject({ status: "fail", reason: "downloaded_bytes_disagree_with_declared_digest" });
    expect(mismatch.verdicts.product).toBe("fail");
  });

  it("fails the harness when the joined exchange's evidence is bound to another run", () => {
    const evaluation = evaluate(g7Episode({ ownership: "mismatch" }));
    expect(statusOf(evaluation, "binding.exchange_ownership")).toMatchObject({ status: "fail", reason: "evidence_bound_to_another_run" });
    expect(evaluation.verdicts.harness).toBe("fail");
    expect(statusOf(evaluate(g7Episode({ ownership: "unavailable" })), "binding.exchange_ownership")).toMatchObject({ status: "unavailable" });
  });

  it("dedupes replayed receipts and operations deterministically", () => {
    const baseline = evaluate(g7Episode());
    const replayed = g7Episode();
    // The same bridge rows read again by a later refresh, and the same outcome observed twice.
    for (const event of replayed.log.events.filter((candidate) => candidate.kind === "studio.bridge_receipt").slice(0, 5)) replayed.log.add(event.kind, event.source, event.payload);
    const final = replayed.log.events.find((event) => event.kind === "studio.outcome.observed" && event.payload.purpose === "final")!;
    replayed.log.add(final.kind, final.source, final.payload);
    const evaluation = evaluate(replayed);
    expect(statusMap(evaluation)).toEqual(statusMap(baseline));
    expect(evaluation.bridge.duplicate_count).toBe(5);
  });

  it("treats a dead foreign worker's quiesced lease as cleanup, typed never as a close", () => {
    const run = studioRun(config);
    const log = new EventLog(run.id);
    log.add("harness.browser_process_acquired", "browser", {});
    log.add("studio.cleanup.exchange_ended", "canonical", { confirmed: true, status: "confirmed", basis: "no_live_exchange_in_room" });
    log.add("studio.cleanup.signed_out", "canonical", { confirmed: true, scope: "global" });
    expect(studioG7CleanupProof(log.events).complete).toBe(false);
    log.add("cleanup.browser_lease_released", "worker", { schema: "sophia_voice_lab_studio_g7_dead_owner_lease_release_v1", cas_deleted: true, dead_owner_quiesced: true });
    expect(studioG7CleanupProof(log.events)).toEqual({ exchangeEnded: true, signedOut: true, browserClosed: false, browserQuiesced: true, refreshSessionsRevoked: true, complete: true });
    expect(statusOf(evaluateStudioG7Run(run, log.events, [], { expected }), "cleanup.browser_closed")).toMatchObject({ status: "unavailable", reason: "dead_owner_quiesced_close_unobservable" });
    // An uncertain settlement is never an exchange end.
    const uncertain = new EventLog(run.id);
    uncertain.add("studio.cleanup.exchange_ended", "canonical", { confirmed: false, status: "uncertain", basis: "live_exchange_not_joined_to_run" });
    expect(studioG7CleanupProof(uncertain.events).exchangeEnded).toBe(false);
    expect(statusOf(evaluateStudioG7Run(run, uncertain.events, [], { expected }), "cleanup.exchange_ended")).toMatchObject({ status: "unavailable", reason: "exchange_uncertain_live_exchange_not_joined_to_run" });
  });
});

describe("Studio G7 cleanup proof ordering (adversarial review)", () => {
  it("counts an exchange end only when it follows the run's exchange join", () => {
    const run = studioRun(config);
    const log = new EventLog(run.id);
    log.add("studio.exchange.speak_requested", "canonical", { grant_id: GRANT_UUID, write_ahead: true });
    // A settle that ran while Speak was still opening the exchange (e.g. a watchdog during start).
    log.add("studio.cleanup.exchange_ended", "canonical", { confirmed: true, status: "confirmed", basis: "no_live_exchange_in_room", exchange_id: null, join: "retained", ownership: "not_required", verified_by: "member_snapshot" });
    log.add("studio.exchange.opened", "canonical", { exchange_id: EXCHANGE_UUID, grant_id: GRANT_UUID, opened_at_lab_ms: T0 });
    log.add("studio.cleanup.signed_out", "canonical", { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted" });
    log.add("cleanup.browser_context_closed", "browser", { close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true });
    expect(studioG7CleanupProof(log.events)).toMatchObject({ exchangeEnded: false, complete: false });
    expect(statusOf(evaluateStudioG7Run(run, log.events, [], { expected }), "cleanup.exchange_ended")?.status).toBe("unavailable");
    // An end confirmed after the join counts.
    log.add("studio.cleanup.exchange_ended", "canonical", { confirmed: true, status: "confirmed", basis: "api_end", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "proven", verified_by: "member_snapshot", speak_requested_before_observation: true });
    expect(studioG7CleanupProof(log.events)).toMatchObject({ exchangeEnded: true, complete: true });
    // A Speak intent with no join yet: only an end after the intent counts.
    const intentOnly = new EventLog(run.id);
    intentOnly.add("studio.cleanup.exchange_ended", "canonical", { confirmed: true, status: "confirmed", basis: "no_live_exchange_in_room", exchange_id: null, join: "retained", ownership: "not_required" });
    intentOnly.add("studio.exchange.speak_requested", "canonical", { grant_id: GRANT_UUID, write_ahead: true });
    expect(studioG7CleanupProof(intentOnly.events).exchangeEnded).toBe(false);
  });
});

describe("Studio G7 cleanup proof after a Speak intent (adversarial re-review)", () => {
  const ended = (extra: Record<string, unknown>) => ({ confirmed: true, status: "confirmed", verified_by: "member_snapshot", speak_requested_before_observation: true, ...extra });
  it("counts only an API-read end observed after the intent, bound to the joined exchange or after the principal left", () => {
    const run = studioRun(config);
    // A confirmation made before Speak (no API read), drained after the anchors.
    const early = new EventLog(run.id);
    early.add("studio.exchange.speak_requested", "canonical", { grant_id: GRANT_UUID, requested_at_lab_ms: T0 });
    early.add("studio.exchange.opened", "canonical", { exchange_id: EXCHANGE_UUID, grant_id: GRANT_UUID });
    early.add("studio.cleanup.exchange_ended", "canonical", { confirmed: true, status: "confirmed", basis: "no_exchange_opened_by_run", exchange_id: null, verified_by: "driver_never_requested_exchange", speak_requested_before_observation: false });
    expect(studioG7CleanupProof(early.events).exchangeEnded).toBe(false);
    // Joined: only an end of the joined exchange counts.
    early.add("studio.cleanup.exchange_ended", "canonical", ended({ basis: "no_live_exchange_in_room", exchange_id: null }));
    expect(studioG7CleanupProof(early.events).exchangeEnded).toBe(false);
    early.add("studio.cleanup.exchange_ended", "canonical", ended({ basis: "api_end", exchange_id: EXCHANGE_UUID }));
    expect(studioG7CleanupProof(early.events).exchangeEnded).toBe(true);
    // Speak requested, never joined: only "nothing live" after the open window counts.
    const unjoined = new EventLog(run.id);
    unjoined.add("studio.exchange.speak_requested", "canonical", { grant_id: GRANT_UUID, requested_at_lab_ms: T0 });
    unjoined.add("studio.cleanup.exchange_ended", "canonical", ended({ basis: "no_live_exchange_in_room", exchange_id: null }));
    unjoined.add("studio.cleanup.exchange_ended", "canonical", ended({ basis: "no_live_exchange_after_open_window", exchange_id: null, speak_requested_at_lab_ms: T0, observed_at_lab_ms: T0 + 10_000, open_window_ms: 120_000 }));
    expect(studioG7CleanupProof(unjoined.events).exchangeEnded).toBe(false);
    // Only "nothing live" observed after the principal left (browser closed, global sign-out) counts.
    unjoined.add("studio.cleanup.signed_out", "canonical", { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204 });
    unjoined.add("cleanup.browser_context_closed", "browser", { close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true });
    unjoined.add("studio.cleanup.exchange_ended", "canonical", ended({ basis: "no_live_exchange_after_principal_left", exchange_id: null, browser_closed_before_observation: true, signed_out_before_observation: true }));
    expect(studioG7CleanupProof(unjoined.events).exchangeEnded).toBe(true);
    // No Speak intent at all: the driver's own "never requested" confirmation stands.
    const never = new EventLog(run.id);
    never.add("studio.cleanup.exchange_ended", "canonical", { confirmed: true, status: "confirmed", basis: "no_exchange_opened_by_run", verified_by: "driver_never_requested_exchange" });
    expect(studioG7CleanupProof(never.events).exchangeEnded).toBe(true);
  });

  it("an unrevoked evidence-refresh session keeps cleanup incomplete until a later global sign-out", () => {
    const item = episode();
    expect(studioG7CleanupProof(item.log.events).complete).toBe(true);
    item.log.add("studio.evidence.session_revoked", "canonical", { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "local", confirmed: false, status: "unrevoked", http_status: 503 });
    expect(studioG7CleanupProof(item.log.events)).toMatchObject({ refreshSessionsRevoked: false, complete: false });
    item.log.add("studio.cleanup.signed_out", "canonical", { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204 });
    expect(studioG7CleanupProof(item.log.events)).toMatchObject({ refreshSessionsRevoked: true, complete: true });
  });
});

describe("Studio G7 cleanup proof: a no-join end needs the principal gone (third review)", () => {
  const ended = (extra: Record<string, unknown>) => ({ confirmed: true, status: "confirmed", verified_by: "member_snapshot", speak_requested_before_observation: true, exchange_id: null, ...extra });
  it("counts a no-join end only when observed after the run's browser close and global sign-out, never on a time window", () => {
    const run = studioRun(config);
    const log = new EventLog(run.id);
    log.add("studio.exchange.speak_requested", "canonical", { grant_id: GRANT_UUID, requested_at_lab_ms: T0 });
    // A time window alone (the earlier rule) proves nothing about a later open.
    log.add("studio.cleanup.exchange_ended", "canonical", ended({ basis: "no_live_exchange_after_open_window", speak_requested_at_lab_ms: T0, observed_at_lab_ms: T0 + 200_000, open_window_ms: 120_000 }));
    expect(studioG7CleanupProof(log.events).exchangeEnded).toBe(false);
    // Observed before the principal left: not counted.
    log.add("studio.cleanup.exchange_ended", "canonical", ended({ basis: "no_live_exchange_after_principal_left", browser_closed_before_observation: false, signed_out_before_observation: true }));
    expect(studioG7CleanupProof(log.events).exchangeEnded).toBe(false);
    // Claimed after the principal left, but the ledger holds no close or sign-out after Speak: not counted.
    log.add("studio.cleanup.exchange_ended", "canonical", ended({ basis: "no_live_exchange_after_principal_left", browser_closed_before_observation: true, signed_out_before_observation: true }));
    expect(studioG7CleanupProof(log.events).exchangeEnded).toBe(false);
    log.add("studio.cleanup.signed_out", "canonical", { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204 });
    log.add("cleanup.browser_context_closed", "browser", { close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true });
    expect(studioG7CleanupProof(log.events).exchangeEnded).toBe(true);
  });
});

const OTHER_EXCHANGE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GOAL = "e0000000-0000-4000-8000-0000000000a1";
const OTHER_GOAL = "e0000000-0000-4000-8000-0000000000a2";
const commandId = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** One recorded voice call (A15 ExchangeCalls entry, as the driver records it): answered, with the outcome its kind implies unless given. */
function call(seq: number, tool: string, command: { kind: string; goal?: string | null; epoch?: number | null; state?: string; id?: string } | null, taskId: string | null = null, extra: { outcome?: string | null; answered?: boolean; inputEpoch?: number } = {}): Record<string, unknown> {
  const at = new Date(T0 + seq * 1_000).toISOString();
  const outcome = extra.outcome !== undefined ? extra.outcome : command === null ? (tool === "project_status" ? "ok" : "refused") : command.kind === "native_task" ? "admitted" : "ok";
  return {
    seq, recorded_at: at, input_epoch: extra.inputEpoch ?? 1, tool, task_id: taskId, answered_at: extra.answered === false ? null : at, outcome: extra.answered === false ? null : outcome,
    command: command === null ? null : { command_id: command.id ?? commandId(seq), kind: command.kind, goal_id: command.goal === undefined ? GOAL : command.goal, authority_epoch: command.epoch === undefined ? seq : command.epoch, goal_revision: 1, state: command.state ?? "checked", created_at: at },
  };
}

/** Each voice step's own call, admitting exactly its command on the created task's goal. */
function happyCalls(): CallsScript["byStep"] {
  return {
    "g7.create": [call(1, "start_research", { kind: "native_task" }, RESEARCH_TASK)],
    // A read in the same exchange admits nothing and never counts.
    "g7.steer": [call(2, "project_status", null), call(3, "control_work", { kind: "steer" })],
    "g7.hold": [call(4, "control_work", { kind: "hold" })],
    "g7.resume": [call(5, "control_work", { kind: "resume" })],
    // The Stop sub-episode: its own create on its own goal, then Stop on that goal.
    "g7.create_stop_target": [call(6, "start_research", { kind: "native_task", goal: GOAL_B }, STOP_TASK)],
    "g7.stop": [call(7, "control_work", { kind: "stop", goal: GOAL_B })],
  };
}
const RUN_TASK = { exchange_id: EXCHANGE_UUID, goal_id: GOAL };
const stepsOf = (evaluation: StudioG7Evaluation) => Object.fromEntries(evaluation.steps.map((step) => [step.step_id, `${step.outcome}:${step.reason}`]));
const certify = (byStep: CallsScript["byStep"], options: G7Options = {}, script: Omit<CallsScript, "byStep"> = {}) => stepsOf(evaluate(g7Episode({ researchTask: RUN_TASK, ...options, calls: { byStep, ...script } })));

describe("Studio G7 voice steps are certified only from the exchange's calls (A15 getExchangeCalls)", () => {
  it("certifies each of the six voice steps from the one command its own call admitted, and every product assertion passes (positive controls)", () => {
    const evaluation = evaluate(g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() } }));
    expect(stepsOf(evaluation)).toMatchObject({ "g7.create": "pass:null", "g7.steer": "pass:null", "g7.hold": "pass:null", "g7.resume": "pass:null", "g7.create_stop_target": "pass:null", "g7.stop": "pass:null" });
    expect(evaluation.outcome).toMatchObject({ join: "exchange_calls", bound_tasks: 2, missing_product_field: null });
    expect(evaluation.outcome.voice_steps.map((step) => [step.step_id, step.command_kind, step.call_outcome, step.candidate_seqs, step.goal_id, step.task_id])).toEqual([
      ["g7.create", "native_task", "admitted", [1], GOAL, RESEARCH_TASK], ["g7.steer", "steer", "ok", [2, 3], GOAL, null], ["g7.hold", "hold", "ok", [4], GOAL, null], ["g7.resume", "resume", "ok", [5], GOAL, null],
      // The Stop sub-episode's own joins: its own create, task and goal, and its own stop on that goal.
      ["g7.create_stop_target", "native_task", "admitted", [6], GOAL_B, STOP_TASK], ["g7.stop", "stop", "ok", [7], GOAL_B, null],
    ]);
    // The baseline is the read's readAt, kept as the exact string the product sent.
    expect(evaluation.outcome.voice_steps.every((step) => typeof step.baseline_read_at === "string" && /T.*Z$/.test(step.baseline_read_at))).toBe(true);
    expect(statusOf(evaluation, "step.g7.withdrawal.design_ended")).toMatchObject({ status: "pass", reason: null });
    // Every command-bearing call the reads listed falls in a step's window.
    expect(statusOf(evaluation, "outcome.calls_attributed")).toMatchObject({ status: "pass", reason: null });
    expect(evaluation.product.filter((assertion) => assertion.status !== "pass").map((assertion) => `${assertion.id}:${assertion.status}:${assertion.reason}`)).toEqual([]);
    expect(evaluation.verdicts).toMatchObject({ harness: "pass", product: "pass" });
  });

  it("(a) never certifies a Hold whose goal was already held: the call admitted no command", () => {
    expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", null)] })["g7.hold"]).toBe("uncertain:call_admitted_no_command");
  });

  it("(b) never certifies from another exchange's task or calls", () => {
    const foreignTask = certify(happyCalls(), { researchTask: { exchange_id: OTHER_EXCHANGE_ID, goal_id: GOAL } });
    expect(foreignTask["g7.create"]).toBe("fail:created_task_bound_to_another_exchange");
    expect(foreignTask["g7.hold"]).toBe("uncertain:create_step_not_certified");
    const elsewhere = certify({ ...happyCalls(), "g7.create": [] });
    expect(elsewhere["g7.create"]).toBe("uncertain:no_call_after_baseline");
    expect(elsewhere["g7.stop"]).toBe("uncertain:create_step_not_certified");
  });

  it("(c) never certifies an unrelated action in the same exchange", () => {
    expect(certify({ ...happyCalls(), "g7.hold": [call(4, "project_status", null)] })["g7.hold"]).toBe("uncertain:call_admitted_no_command");
    expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", { kind: "steer" })] })["g7.hold"]).toBe("fail:command_kind_mismatch");
    expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", { kind: "hold", goal: OTHER_GOAL })] })["g7.hold"]).toBe("fail:command_goal_mismatch");
  });

  it("(d) never certifies a duplicate or replayed entry", () => {
    expect(certify({ ...happyCalls(), "g7.stop": [call(7, "control_work", { kind: "stop", goal: GOAL_B, id: commandId(4) })] })["g7.stop"]).toBe("uncertain:command_already_certified");
    expect(certify({ ...happyCalls(), "g7.stop": [] })["g7.stop"]).toBe("uncertain:no_call_after_baseline");
  });

  it("(e) never certifies a call already in flight at the step's baseline: listed without after, never with it", () => {
    const item = g7Episode({ researchTask: RUN_TASK, calls: { byStep: { ...happyCalls(), "g7.hold": [] }, inFlightAtBaseline: { "g7.hold": [call(4, "control_work", { kind: "hold" })] } } });
    expect(stepsOf(evaluate(item))["g7.hold"]).toBe("uncertain:no_call_after_baseline");
    // A later read without after (the next step's baseline) does list it: only after excludes it.
    const reads = item.log.events.filter((event) => event.kind === "studio.exchange.calls_read");
    const resumeBaseline = reads.find((event) => event.payload.purpose === "baseline" && event.payload.step_id === "g7.resume")!;
    expect((resumeBaseline.payload.calls as Array<Record<string, unknown>>).map((entry) => entry.seq)).toContain(4);
    expect(reads.filter((event) => event.payload.purpose === "after" && event.payload.step_id === "g7.hold").flatMap((event) => (event.payload.calls as Array<Record<string, unknown>>).map((entry) => entry.seq))).not.toContain(4);
  });

  it("(f) never certifies when two calls after the baseline carry commands", () => {
    expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", { kind: "hold" }), call(5, "control_work", { kind: "hold" })], "g7.resume": [call(6, "control_work", { kind: "resume" })], "g7.stop": [call(7, "control_work", { kind: "stop" })] })["g7.hold"]).toBe("uncertain:multiple_command_bearing_calls");
  });

  it("(g) never certifies the principal's own HTTP command, which shows in the snapshot but never as a call's command", () => {
    const steps = certify({ ...happyCalls(), "g7.create": [] }, { researchTask: { exchange_id: null, goal_id: GOAL } });
    expect(steps["g7.create"]).toBe("uncertain:no_call_after_baseline");
    expect(steps["g7.steer"]).toBe("uncertain:create_step_not_certified");
  });

  it("a call not answered yet blocks certification until a later read has it answered", () => {
    expect(certify(happyCalls(), {}, { unansweredOnly: ["g7.hold"] })["g7.hold"]).toBe("uncertain:call_unanswered");
    expect(certify(happyCalls(), {}, { unansweredFirst: ["g7.hold"] })["g7.hold"]).toBe("pass:null");
  });

  it("never certifies a command its call was answered with another outcome", () => {
    for (const [outcome, typed] of [["refused", "fail"], ["error", "fail"], ["unknown", "uncertain"], ["committed", "uncertain"]] as const) {
      expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", { kind: "hold" }, null, { outcome })] })["g7.hold"], outcome).toBe(`${typed}:call_outcome_${outcome}`);
    }
    // Create must be answered admitted; ok is not enough.
    expect(certify({ ...happyCalls(), "g7.create": [call(1, "start_research", { kind: "native_task" }, RESEARCH_TASK, { outcome: "ok" })] })["g7.create"]).toBe("uncertain:call_outcome_ok");
  });

  it("checks each control's effect; only hold, resume and stop take a rising authority epoch (a steer takes none)", () => {
    expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", { kind: "hold", state: "denied" })] })["g7.hold"]).toBe("fail:command_denied");
    for (const state of ["superseded", "outcome_unknown"]) expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", { kind: "hold", state })] })["g7.hold"], state).toBe(`uncertain:command_${state}`);
    expect(certify({ ...happyCalls(), "g7.resume": [call(5, "control_work", { kind: "resume", epoch: 4 })] })["g7.resume"]).toBe("fail:authority_epoch_not_increasing");
    // A steer's epoch (high, or none) never gates the next hold.
    const steerHigh = certify({ ...happyCalls(), "g7.steer": [call(2, "project_status", null), call(3, "control_work", { kind: "steer", epoch: 100 })] });
    expect([steerHigh["g7.steer"], steerHigh["g7.hold"]]).toEqual(["pass:null", "pass:null"]);
    expect(certify({ ...happyCalls(), "g7.steer": [call(3, "control_work", { kind: "steer", epoch: null })] })["g7.steer"]).toBe("pass:null");
    const item = g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() } });
    const hold = item.log.events.find((event) => event.kind === "studio.outcome.observed" && event.payload.purpose === "g7.hold")!;
    hold.payload = { ...hold.payload, tasks: [{ ...(hold.payload.tasks as Array<Record<string, unknown>>)[0], phase: "running" }] };
    expect(stepsOf(evaluate(item))["g7.hold"]).toBe("uncertain:goal_status_not_matching_step");
  });

  it("(P3-1) the window is the step's own: every call at the input epoch the principal held, no later call counts", () => {
    // The step's own call (epoch 8) refused; a hold command at another epoch (7) is not the step's.
    expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", { kind: "hold" }, null, { inputEpoch: 7 }), call(5, "control_work", null, null, { inputEpoch: 8 })], "g7.resume": [call(6, "control_work", { kind: "resume" }, null, { inputEpoch: 1 })], "g7.stop": [call(7, "control_work", { kind: "stop" })] }, { windowEpochs: { "g7.hold": 8 } })["g7.hold"]).toBe("uncertain:call_input_epoch_mismatch");
    // A command recorded after the step's own settled after-read (e.g. during the next actions) never counts.
    expect(certify({ ...happyCalls(), "g7.hold": [call(4, "control_work", null)], "g7.resume": [call(6, "control_work", { kind: "resume" })], "g7.stop": [call(7, "control_work", { kind: "stop" })] }, {}, { lateAfterRead: { "g7.hold": [call(5, "control_work", { kind: "hold" })] } })["g7.hold"]).toBe("uncertain:call_admitted_no_command");
    // A command-bearing call one read listed and a later read of the window no longer lists: a conflict.
    expect(certify(happyCalls(), {}, { vanishing: ["g7.hold"] })["g7.hold"]).toBe("uncertain:calls_entry_conflict");
  });

  it("types a product that does not serve the calls (404) or refuses them (422 not_found) as unavailable, never a pass", () => {
    for (const [refusal, reason] of [[{ reason: "endpoint_not_served", http_status: 404 }, "calls_baseline_endpoint_not_served"], [{ reason: "not_found_for_principal", http_status: 422 }, "calls_baseline_not_found_for_principal"]] as const) {
      const evaluation = evaluate(g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls(), unavailable: refusal } }));
      for (const step of ["g7.create", "g7.steer", "g7.hold", "g7.resume", "g7.stop"]) expect(stepsOf(evaluation)[step], `${refusal.reason} ${step}`).toBe(`unavailable:${reason}`);
      expect(evaluation.outcome).toMatchObject({ join: "uncertain", missing_product_field: "ExchangeCalls" });
    }
  });

  it("certifies nothing while the run's exchange ownership is unproven", () => {
    for (const ownership of ["unavailable", "mismatch"] as const) {
      expect(certify(happyCalls(), { ownership })["g7.create"], ownership).toBe("unavailable:run_exchange_ownership_unproven");
    }
  });
});

describe("delta 6: the withdrawal ended the run's own edit X only on the note's source S, while X was live", () => {
  const designEnded = (options: G7Options, rewrite: (item: Episode) => void = () => undefined) => {
    const item = g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() }, ...options });
    rewrite(item);
    const evaluation = evaluate(item);
    return { assertion: statusOf(evaluation, "step.g7.withdrawal.design_ended"), product: evaluation.verdicts.product };
  };

  it("passes with every join on S: R drew on S, X live before, the receipt names S, X failed for the revoke reason with S withdrawn", () => {
    expect(designEnded({})).toMatchObject({ assertion: { status: "pass", reason: null }, product: "pass" });
  });

  it("never passes an edit no longer live before the withdrawal (it published or ended first: the timing risk)", () => {
    for (const before of ["published", "failed"]) expect(designEnded({ editBefore: before }).assertion, before).toMatchObject({ status: "uncertain", reason: "own_edit_no_longer_live" });
    expect(designEnded({ editBefore: null }).assertion).toMatchObject({ status: "uncertain", reason: "no_observation_before_withdrawal" });
  });

  it("never credits the withdrawal for an end Stop caused, nor for one seen only in another observation", () => {
    const stopped = { state: "cancelled", phase: "stopped", reason_class: "stopped", withdrawn_source_ids: [], design: { state: "cancelled", mode: "edit", artifact_id: ARTIFACT, published_version_id: null, research_task_id: RESEARCH_TASK, reason_class: "stopped" } };
    expect(designEnded({ editAfter: stopped }).assertion).toMatchObject({ status: "uncertain", reason: "design_not_ended_by_withdrawal" });
    expect(designEnded({ withdrawalAfterOperation: "another-operation" }).assertion).toMatchObject({ status: "uncertain", reason: "no_observation_after_withdrawal" });
    // A Stop whose baseline precedes the withdrawal's own after-observation.
    expect(designEnded({}, (item) => {
      const after = item.log.events.find((event) => event.kind === "studio.outcome.observed" && event.payload.purpose === "g7.withdrawal")!;
      after.seq = Math.max(...item.log.events.map((event) => event.seq)) + 1;
    }).assertion).toMatchObject({ status: "uncertain", reason: "stop_before_withdrawal_effect_observed" });
  });

  it("never passes on the note's entry id alone, or on another source (root's correction 1)", () => {
    // X's withdrawn sources name the entry id N, not the source S.
    expect(designEnded({ editAfter: { withdrawn_source_ids: [NOTE] } }).assertion).toMatchObject({ status: "uncertain", reason: "note_source_not_in_edit_closure" });
    expect(designEnded({ editAfter: { withdrawn_source_ids: ["c0000000-0000-4000-8000-0000000000ff"] } }).assertion).toMatchObject({ status: "uncertain", reason: "note_source_not_in_edit_closure" });
    // R's inputs name the entry id, or another source.
    expect(designEnded({ researchInputs: [NOTE] }).assertion).toMatchObject({ status: "uncertain", reason: "own_research_did_not_draw_on_note" });
    expect(designEnded({ researchInputs: [] }).assertion).toMatchObject({ status: "uncertain", reason: "own_research_did_not_draw_on_note" });
    // The withdraw_note receipt names another source, or none.
    expect(designEnded({ receiptSource: "c0000000-0000-4000-8000-0000000000fe" }).assertion).toMatchObject({ status: "uncertain", reason: "withdrawal_receipt_source_mismatch" });
    expect(designEnded({ receiptSource: null }).assertion).toMatchObject({ status: "uncertain", reason: "withdrawal_receipt_source_mismatch" });
    // Another note than the run's own.
    expect(designEnded({ withdrawnEntry: "c0000000-0000-4000-8000-0000000000fd" }).assertion).toMatchObject({ status: "uncertain", reason: "withdrawn_note_not_own_note" });
    // Without the run's own note receipt there is no S at all.
    expect(designEnded({ skip: ["g7.record_note"] }).assertion).toMatchObject({ status: "unavailable", reason: "own_note_not_recorded" });
  });

  it("an X that is not failed for the revoke reason (failed otherwise) is never the withdrawal's end", () => {
    expect(designEnded({ editAfter: { reason_class: "other", design: { state: "failed", mode: "edit", artifact_id: ARTIFACT, published_version_id: null, research_task_id: RESEARCH_TASK, reason_class: "other" } } }).assertion).toMatchObject({ status: "uncertain", reason: "design_not_ended_by_withdrawal" });
  });
});

describe("delta 6: Stop is credited only on the sub-episode's own live work, never on work already ended", () => {
  it("Stop on the main goal after the withdrawal is never a pass (its research already ended; the product admits no command)", () => {
    const main = certify({ ...happyCalls(), "g7.create_stop_target": [], "g7.stop": [call(7, "control_work", { kind: "stop" })] }, { skip: ["g7.create_stop_target"] });
    expect(main["g7.stop"]).toBe("uncertain:stop_target_already_ended");
    const refused = certify({ ...happyCalls(), "g7.create_stop_target": [], "g7.stop": [call(7, "control_work", null)] }, { skip: ["g7.create_stop_target"] });
    expect(refused["g7.stop"]).toBe("uncertain:call_admitted_no_command");
  });

  it("Stop on a sub-episode task already ended before it, or not yet cancelled for the stop, never passes", () => {
    expect(certify(happyCalls(), { stopTargetBefore: { state: "cancelled", phase: "stopped" } })["g7.stop"]).toBe("uncertain:stop_target_already_ended");
    expect(certify(happyCalls(), { stopEffect: { state: "running", phase: "stopping", reason_class: null } })["g7.stop"]).toBe("uncertain:stop_effect_not_settled");
    expect(certify(happyCalls(), { stopEffect: { withdrawn_source_ids: [NOTE_SOURCE] } })["g7.stop"]).toBe("uncertain:stop_target_ended_by_withdrawal");
  });

  it("the sub-episode keeps its own joins: a create of the main task or goal, or a stop on the main goal, never stands in", () => {
    expect(certify({ ...happyCalls(), "g7.create_stop_target": [call(6, "start_research", { kind: "native_task" }, RESEARCH_TASK)] })["g7.create_stop_target"]).toBe("uncertain:stop_target_not_distinct");
    expect(certify({ ...happyCalls(), "g7.stop": [call(7, "control_work", { kind: "stop" })] })["g7.stop"]).toBe("fail:command_goal_mismatch");
  });
});

describe("Studio G7 orphan browser room presence (A15 live presence)", () => {
  const quiesced = (presence: Record<string, unknown>) => {
    const run = studioRun(config);
    const log = new EventLog(run.id);
    log.add("harness.browser_process_acquired", "browser", {});
    log.add("studio.cleanup.exchange_ended", "canonical", { confirmed: true, status: "confirmed", basis: "no_live_exchange_in_room" });
    log.add("studio.cleanup.signed_out", "canonical", { confirmed: true, scope: "global" });
    log.add("cleanup.browser_lease_released", "worker", { schema: "sophia_voice_lab_studio_g7_dead_owner_lease_release_v1", cas_deleted: true, dead_owner_quiesced: true, ...presence });
    return evaluateStudioG7Run(run, log.events, [], { expected });
  };

  it("counts a fresh report without the principal as gone; a stale or missing one, or an absent route, proves nothing", () => {
    const absent = quiesced({ room_presence: "absent", room_presence_reason: null });
    expect(statusOf(absent, "cleanup.orphan_room_presence")).toMatchObject({ status: "pass", reason: null });
    expect(absent.cleanup.room_presence).toBe("absent");
    // The browser process's close itself stays unobservable.
    expect(statusOf(absent, "cleanup.browser_closed")).toMatchObject({ status: "unavailable", reason: "dead_owner_quiesced_close_unobservable" });
    for (const reason of ["report_stale", "not_observed", "endpoint_not_served", "not_found_for_principal"]) {
      const unobservable = quiesced({ room_presence: "unobservable", room_presence_reason: reason });
      expect(statusOf(unobservable, "cleanup.orphan_room_presence"), reason).toMatchObject({ status: "unavailable", reason: `room_presence_unobservable_${reason}` });
    }
  });
});

describe("delta 4: only the run's own report, on its canonical chain, is evidence (foreign bytes, edits and acceptances never count)", () => {
  const FOREIGN_RESEARCH = "d0000000-0000-4000-8000-0000000000fe";
  const FOREIGN_DESIGN = "d0000000-0000-4000-8000-0000000000ff";
  const FOREIGN_EDIT = "d0000000-0000-4000-8000-0000000000fd";
  const FOREIGN_ARTIFACT = "a0000000-0000-4000-8000-0000000000ff";
  const FOREIGN_VERSION = "b0000000-0000-4000-8000-0000000000ff";
  const FOREIGN_VERSION_2 = "b0000000-0000-4000-8000-0000000000fe";
  const foreignTasks = () => [
    task(FOREIGN_RESEARCH, "research", { exchange_id: OTHER_EXCHANGE_ID, research: { html_state: "published", design_task_id: FOREIGN_DESIGN } }),
    task(FOREIGN_DESIGN, "design", { state: "succeeded", design: { state: "published", mode: "create", artifact_id: FOREIGN_ARTIFACT, published_version_id: FOREIGN_VERSION, research_task_id: FOREIGN_RESEARCH } }),
  ];
  const foreignArtifact = (status: string, taskId = FOREIGN_DESIGN, versionId = FOREIGN_VERSION) => ({ ...artifact(taskId, versionId, PAGE_SHA, status), artifact_id: FOREIGN_ARTIFACT });
  /** A certified episode (its create step certified from the calls), with every observation rewritten. */
  const certified = (rewrite: (payload: Record<string, unknown>) => Record<string, unknown>, options: G7Options = {}) => {
    const item = g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() }, ...options });
    for (const event of item.log.events.filter((candidate) => candidate.kind === "studio.outcome.observed")) event.payload = rewrite(event.payload);
    return item;
  };
  const ownArtifactsAs = (status: string) => (payload: Record<string, unknown>) => ({ ...payload, artifacts: (payload.artifacts as Array<Record<string, unknown>>).map((entry) => ({ ...entry, status, ...(status === "verified" ? {} : { reason: "content_unavailable", hashes_agree: undefined }) })) });
  const withForeign = (status: string) => (payload: Record<string, unknown>) => ({ ...payload, tasks: [...(payload.tasks as unknown[]), ...foreignTasks()], artifacts: [...(payload.artifacts as unknown[]), foreignArtifact(status)] });
  const integrity = (item: Episode) => statusOf(evaluate(item), "outcome.artifact_bytes_integrity");

  it("review P2-3 (E1): a foreign design's verified bytes never pass the run's integrity; its mismatch never fails it", () => {
    const ownUnavailable = certified((payload) => withForeign("verified")(ownArtifactsAs("unavailable")(payload)));
    expect(integrity(ownUnavailable)).toMatchObject({ status: "unavailable", reason: "content_unavailable" });
    expect(evaluate(ownUnavailable).outcome).toMatchObject({ artifacts_verified: 0, own_report: { status: "resolved", create_task_id: RESEARCH_TASK, design_task_id: DESIGN_TASK, artifact_id: ARTIFACT } });
    const ownVerified = certified((payload) => withForeign("mismatch")(ownArtifactsAs("verified")(payload)));
    expect(integrity(ownVerified)).toMatchObject({ status: "pass" });
    // The run's own version: D's published page (the edit X never publishes: the note is withdrawn while it is live).
    expect(evaluate(ownVerified).outcome).toMatchObject({ artifacts_verified: 1, artifacts_mismatched: 0 });
    // Positive control: the run's own mismatch fails it.
    expect(integrity(certified(withForeign("verified"), { artifactStatus: "mismatch" }))).toMatchObject({ status: "fail" });
  });

  it("root's scenario: the own research is pending (no design) and the only published design is another exchange's — nothing of it is the run's", () => {
    const pendingOwn = (payload: Record<string, unknown>) => withForeign("verified")({
      ...payload,
      tasks: (payload.tasks as Array<Record<string, unknown>>).filter((entry) => entry.task_id !== DESIGN_TASK && entry.task_id !== EDIT_TASK).map((entry) => entry.task_id === RESEARCH_TASK ? { ...entry, research: { html_state: "none", design_task_id: null } } : entry),
      artifacts: [],
    });
    const item = certified(pendingOwn);
    // The Lab's (hypothetical) edit and refusal on the foreign artifact.
    for (const event of item.log.events.filter((candidate) => candidate.kind === "studio.action.html_edit")) event.payload = { ...event.payload, artifact_id: FOREIGN_ARTIFACT };
    const evaluation = evaluate(item);
    expect(statusOf(evaluation, "outcome.artifact_bytes_integrity")).toMatchObject({ status: "unavailable", reason: "own_design_pending" });
    expect(stepsOf(evaluation)).toMatchObject({ "g7.create": "pass:null", "g7.section_revision": "unavailable:own_design_pending", "g7.stale_edit": "unavailable:own_design_pending" });
    expect(evaluation.outcome).toMatchObject({ artifacts_verified: 0, own_report: { status: "unavailable", reason: "own_design_pending" } });
  });

  it("a foreign edit (admitted 202 on another artifact, its task published and verified) and a foreign stale refusal never pass the run's steps", () => {
    const item = certified((payload) => payload.purpose === "g7.section_revision"
      ? { ...payload, tasks: [task(FOREIGN_EDIT, "design", { state: "succeeded", design: { state: "published", mode: "edit", artifact_id: FOREIGN_ARTIFACT, published_version_id: FOREIGN_VERSION_2, research_task_id: FOREIGN_RESEARCH } })], artifacts: [foreignArtifact("verified", FOREIGN_EDIT, FOREIGN_VERSION_2)] }
      : withForeign("verified")(payload));
    for (const event of item.log.events.filter((candidate) => candidate.kind === "studio.action.html_edit")) {
      event.payload = { ...event.payload, artifact_id: FOREIGN_ARTIFACT, ...(event.payload.purpose === "section_revision" ? { task_id: FOREIGN_EDIT } : {}) };
    }
    const evaluation = evaluate(item);
    expect(stepsOf(evaluation)).toMatchObject({ "g7.section_revision": "uncertain:edit_target_not_canonical", "g7.stale_edit": "uncertain:edit_target_not_canonical" });
    // The foreign edit's bytes are never the run's: only the own design's version counts.
    expect(evaluation.outcome).toMatchObject({ artifacts_verified: 1 });
    // Positive control: the same episode on the own artifact passes both.
    expect(stepsOf(evaluate(certified(withForeign("verified"))))).toMatchObject({ "g7.section_revision": "pass:null", "g7.stale_edit": "pass:null" });
  });

  it("an own edit task that names another research, or a design that names another research back, is not on the chain", () => {
    const foreignEditTask = certified((payload) => payload.purpose === "g7.section_revision"
      ? { ...payload, tasks: (payload.tasks as Array<Record<string, unknown>>).map((entry) => entry.task_id === EDIT_TASK ? { ...entry, design: { ...(entry.design as Record<string, unknown>), research_task_id: FOREIGN_RESEARCH } } : entry) }
      : payload);
    expect(stepsOf(evaluate(foreignEditTask))).toMatchObject({ "g7.section_revision": "uncertain:edit_task_not_on_own_chain" });
    const misLinked = certified((payload) => ({ ...payload, tasks: (payload.tasks as Array<Record<string, unknown>>).map((entry) => entry.task_id === DESIGN_TASK ? { ...entry, design: { ...(entry.design as Record<string, unknown>), research_task_id: FOREIGN_RESEARCH } } : entry) }));
    const evaluation = evaluate(misLinked);
    expect(statusOf(evaluation, "outcome.artifact_bytes_integrity")).toMatchObject({ status: "uncertain", reason: "target_not_canonical" });
    expect(stepsOf(evaluation)).toMatchObject({ "g7.section_revision": "uncertain:target_not_canonical", "g7.stale_edit": "uncertain:target_not_canonical" });
  });
});

describe("delta 5 (review P2-2): only a confirmed global sign-out passes cleanup.principal_signed_out and the cleanup proof", () => {
  it("a confirmed local or withheld sign-out never signs the principal out", () => {
    const withSignOut = (payload: Record<string, unknown>) => {
      const item = g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() } });
      for (const event of item.log.events.filter((candidate) => candidate.kind === "studio.cleanup.signed_out")) event.payload = { ...event.payload, ...payload };
      const evaluation = evaluate(item);
      return { assertion: statusOf(evaluation, "cleanup.principal_signed_out"), proof: studioG7CleanupProof(item.log.events) };
    };
    const local = withSignOut({ scope: "local", confirmed: true, global_sign_out_withheld: true, basis: "sign_out_fence_not_held" });
    expect(local.assertion).toMatchObject({ status: "fail", reason: "global_sign_out_unconfirmed" });
    expect(local.proof).toMatchObject({ signedOut: false, complete: false });
    // Positive control: the episode's own confirmed global sign-out.
    const global = withSignOut({});
    expect(global.assertion).toMatchObject({ status: "pass" });
    expect(global.proof).toMatchObject({ signedOut: true });
  });
});

describe("delta 5 (review P3-2, P3-3): a command's later state, and calls no step's window holds", () => {
  const EX = "c0000000-0000-4000-8000-000000000001";
  const CGOAL = "e0000000-0000-4000-8000-0000000000a1";
  const TASK = "d0000000-0000-4000-8000-0000000000d1";
  const cmd = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const at = (n: number) => `2026-10-09T12:00:${String(n).padStart(2, "0")}.000001Z`;
  const rec = (seq: number, kind: string | null, state = "admitted") => ({ seq, recorded_at: at(seq), input_epoch: 1, tool: kind === "native_task" ? "start_research" : "control_work", task_id: kind === "native_task" ? TASK : null, answered_at: at(seq), outcome: kind === "native_task" ? "admitted" : kind === null ? "refused" : "ok",
    command: kind === null ? null : { command_id: cmd(seq), kind, goal_id: CGOAL, authority_epoch: seq, goal_revision: 1, state } });
  const read = (seq: number, purpose: "baseline" | "after", op: string, step: string, readAt: string, after: string | null, calls: unknown[]) => ({ seq, kind: "studio.exchange.calls_read", source: "canonical" as const, payload: { purpose, operation_id: op, step_id: step, exchange_id: EX, after, status: "available", read_at: readAt, settled: true, calls } });
  const obs = (seq: number, purpose: string, phase = "running") => ({ seq, kind: "studio.outcome.observed", source: "canonical" as const, payload: { purpose, tasks: [{ task_id: TASK, exchange_id: EX, goal_id: CGOAL, phase }] } });
  const steps = [{ operationId: "op-create", stepId: "g7.create" }, { operationId: "op-steer", stepId: "g7.steer" }, { operationId: "op-hold", stepId: "g7.hold" }];
  const epochs = new Map(steps.map((step) => [step.operationId, 1]));

  it("C1: a command a later read shows denied fails, and one of unknown outcome is uncertain", async () => {
    const { certifyStudioVoiceSteps } = await import("../src/studio-g7/calls-certification.js");
    const run = (later: string) => certifyStudioVoiceSteps({ runExchangeId: EX, ownershipProven: true, stepInputEpochs: epochs, steps, events: [
      read(1, "baseline", "op-create", "g7.create", at(10), null, []),
      read(2, "after", "op-create", "g7.create", at(20), at(10), [rec(11, "native_task")]),
      obs(3, "g7.create"),
      read(4, "baseline", "op-steer", "g7.steer", at(30), null, [rec(11, "native_task", "checked")]),
      read(5, "after", "op-steer", "g7.steer", at(40), at(30), [rec(31, "steer", "admitted")]),
      read(6, "baseline", "op-hold", "g7.hold", at(50), null, [rec(11, "native_task", "checked"), rec(31, "steer", later)]),
      read(7, "after", "op-hold", "g7.hold", at(60), at(50), [rec(51, "hold", "checked")]),
      obs(8, "g7.hold", "held"),
    ] }).steps.find((step) => step.step_id === "g7.steer");
    expect(run("denied")).toMatchObject({ outcome: "fail", reason: "command_denied_later" });
    expect(run("outcome_unknown")).toMatchObject({ outcome: "uncertain", reason: "command_outcome_unknown_later" });
    // Positive control: a command that progressed normally still passes.
    expect(run("checked")).toMatchObject({ outcome: "pass", reason: null });
  });

  it("C2: a command-bearing call made between a step's window and the next baseline is unattributed, and the run is uncertain", async () => {
    const { certifyStudioVoiceSteps } = await import("../src/studio-g7/calls-certification.js");
    const certification = (extra: boolean) => certifyStudioVoiceSteps({ runExchangeId: EX, ownershipProven: true, stepInputEpochs: epochs, steps, events: [
      read(1, "baseline", "op-create", "g7.create", at(10), null, []),
      read(2, "after", "op-create", "g7.create", at(20), at(10), [rec(11, "native_task")]),
      obs(3, "g7.create"),
      read(4, "baseline", "op-steer", "g7.steer", at(30), null, [rec(11, "native_task", "checked")]),
      read(5, "after", "op-steer", "g7.steer", at(40), at(30), [rec(31, "steer", "checked")]),
      read(6, "baseline", "op-hold", "g7.hold", at(50), null, [rec(11, "native_task", "checked"), rec(31, "steer", "checked"), ...(extra ? [rec(41, "stop", "checked")] : [])]),
      read(7, "after", "op-hold", "g7.hold", at(60), at(50), [rec(51, "hold", "checked")]),
      obs(8, "g7.hold", "held"),
    ] });
    expect(certification(true).unattributed_seqs).toEqual([41]);
    expect(certification(false).unattributed_seqs).toEqual([]);
    // In the evaluation: a call recorded after the steer's own window read, listed only by later reads.
    const evaluation = evaluate(g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls(), lateAfterRead: { "g7.steer": [call(41, "control_work", { kind: "stop" })] } } }));
    expect(statusOf(evaluation, "outcome.calls_attributed")).toMatchObject({ status: "uncertain", reason: "unattributed_call" });
    expect(evaluation.outcome.unattributed_call_seqs).toEqual([41]);
    expect(evaluation.verdicts.product).not.toBe("pass");
    // Positive control: every call in some step's window.
    expect(statusOf(evaluate(g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() } })), "outcome.calls_attributed")).toMatchObject({ status: "pass" });
  });
});

describe("delta 5 nits: the withdrawal's design end needs a committed withdrawal and a settled Stop", () => {
  const designEnded = (options: G7Options) => statusOf(evaluate(g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() }, ...options })), "step.g7.withdrawal.design_ended");

  it("a refused withdrawal never ends the design", () => {
    expect(designEnded({ withdrawalCommitted: false })).toMatchObject({ status: "unavailable", reason: "withdrawal_not_committed" });
  });

});

describe("delta 4 review (labrev4 P2): the input-epoch join holds only on an exact window prefix", () => {
  /**
   * hold, resume and stop are heard at input epoch 2 (after leave and return);
   * every call carries epoch 1. With `extraWindow`, one extra bridge window
   * (windowSeq 3, epoch 1: e.g. the steer utterance split by a pause, or a
   * silence the bridge opened a window for) precedes hold's own window.
   */
  const build = (extraWindow: boolean, closed = true) => {
    const item = g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() }, windowEpochs: { "g7.hold": 2, "g7.resume": 2, "g7.stop": 2 } });
    let closedSeq = -1;
    for (const event of item.log.events) {
      if (event.kind !== "studio.bridge_receipt") continue;
      const kind = event.payload.kind;
      if (kind !== "input_window" && kind !== "input_turn" && kind !== "session_closed") continue;
      const receipt = JSON.parse(String(event.payload.receipt_json)) as Record<string, number>;
      if (kind === "session_closed") closedSeq = receipt.seq!;
      if (!extraWindow) continue;
      if (kind === "session_closed") { receipt.seq = closedSeq + 1; receipt.windows = receipt.windows! + 1; event.payload = { ...event.payload, seq: closedSeq + 1 }; }
      else if (receipt.windowSeq! >= 3) { receipt.windowSeq = receipt.windowSeq! + 1; if (kind === "input_turn") receipt.turnOrdinal = receipt.windowSeq; }
      const json = canonicalJson(receipt);
      event.payload = { ...event.payload, receipt_json: json, receipt_sha256: sha256(json) };
    }
    if (extraWindow) item.log.bridge("input_window", inputWindow(item.run, closedSeq, 3, 1_500, { inputEpoch: 1 }));
    // Mid-run: no session_closed yet.
    if (!closed) item.log.events.splice(0, item.log.events.length, ...item.log.events.filter((event) => !(event.kind === "studio.bridge_receipt" && event.payload.kind === "session_closed")));
    return item;
  };

  it("labrev4 E-epoch: an extra window leaves every step's epoch unknown instead of shifting the join", () => {
    // Control: hold's own window is epoch 2, its call epoch 1.
    expect(stepsOf(evaluate(build(false)))["g7.hold"]).toBe("uncertain:call_input_epoch_mismatch");
    // One extra window: never a pass, never a shifted join.
    const shifted = stepsOf(evaluate(build(true)));
    for (const step of ["g7.create", "g7.steer", "g7.hold", "g7.resume", "g7.stop"]) expect(shifted[step], step).toBe("uncertain:step_input_epoch_unknown");
    // Mid-run (before session_closed): the same rule; an exact prefix still joins.
    expect(stepsOf(evaluate(build(true, false)))["g7.create"]).toBe("uncertain:step_input_epoch_unknown");
    expect(stepsOf(evaluate(build(false, false)))["g7.create"]).toBe("pass:null");
    // After session_closed the run must also be joinable: a window the bridge reports but the Lab never received leaves every epoch unknown.
    const dropped = g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() } });
    for (const event of dropped.log.events.filter((candidate) => candidate.kind === "studio.bridge_receipt" && candidate.payload.kind === "session_closed")) {
      const receipt = JSON.parse(String(event.payload.receipt_json)) as Record<string, number>;
      receipt.windows = receipt.windows! + 1;
      const json = canonicalJson(receipt);
      event.payload = { ...event.payload, receipt_json: json, receipt_sha256: sha256(json) };
    }
    expect(stepsOf(evaluate(dropped))["g7.create"]).toBe("uncertain:step_input_epoch_unknown");
    // Positive control: every window present, each step at its own epoch.
    expect(stepsOf(evaluate(g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() } })))).toMatchObject({ "g7.create": "pass:null", "g7.hold": "pass:null", "g7.stop": "pass:null" });
  });
});

describe("delta 5 review (labrev5 C3/C4): only End's post-quiescence, settled audit lets calls_attributed pass", () => {
  const attributed = (item: Episode) => statusOf(evaluate(item), "outcome.calls_attributed");
  const happy = () => g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() } });
  const swapSeq = (item: Episode, left: (event: LabEvent) => boolean, right: (event: LabEvent) => boolean) => {
    const a = item.log.events.find(left)!, b = item.log.events.find(right)!;
    [a.seq, b.seq] = [b.seq, a.seq];
  };
  const isAudit = (event: LabEvent) => event.kind === "studio.exchange.calls_read" && event.payload.step_id === "final";

  it("no End audit, an audit before the exchange ended, after the sign-out, or unsettled is unproven; a refused one unavailable", () => {
    expect(attributed(g7Episode({ researchTask: RUN_TASK, calls: { byStep: happyCalls() }, noEndAudit: true }))).toMatchObject({ status: "uncertain", reason: "end_calls_audit_unproven" });
    const early = happy();
    swapSeq(early, isAudit, (event) => event.kind === "studio.cleanup.exchange_ended");
    expect(attributed(early)).toMatchObject({ status: "uncertain", reason: "end_calls_audit_unproven" });
    const beforeClosed = happy();
    swapSeq(beforeClosed, isAudit, (event) => event.kind === "studio.bridge_receipt" && event.payload.kind === "session_closed");
    expect(attributed(beforeClosed)).toMatchObject({ status: "uncertain", reason: "end_calls_audit_unproven" });
    const late = happy();
    swapSeq(late, isAudit, (event) => event.kind === "studio.cleanup.signed_out");
    expect(attributed(late)).toMatchObject({ status: "uncertain", reason: "end_calls_audit_unproven" });
    const unsettled = happy();
    unsettled.log.events.find(isAudit)!.payload.settled = false;
    expect(attributed(unsettled)).toMatchObject({ status: "uncertain", reason: "end_calls_audit_unproven" });
    const refused = happy();
    Object.assign(refused.log.events.find(isAudit)!.payload, { status: "unavailable", reason: "http_503", read_at: null, calls: [] });
    expect(attributed(refused)).toMatchObject({ status: "uncertain", reason: "end_calls_read_unavailable" });
    // Positive control.
    expect(attributed(happy())).toMatchObject({ status: "pass", reason: null });
  });
});
