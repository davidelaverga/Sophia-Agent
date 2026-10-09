import { describe, expect, it } from "vitest";

import type { LabEvent, OperationRecord, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { deriveStudioG7Verdicts, evaluateStudioG7Run, studioG7CleanupProof, type StudioG7Evaluation } from "../src/studio-g7/evaluate.js";
import { studioPriorInputSettled } from "../src/worker.js";
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
    expect(studioG7CleanupProof(item.log.events)).toEqual({ exchangeEnded: true, signedOut: true, browserClosed: true, browserQuiesced: false, complete: true });
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

interface G7Options { skip?: string[]; staleCode?: string; staleStatus?: number; artifactStatus?: string; ownership?: "proven" | "mismatch" | "unavailable"; withdrawalCommitted?: boolean; noEnd?: boolean }

/** A complete G7 episode: five voice steps, four actions, observations, ownership, cleanup. */
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
  const voice = ["create", "steer", "hold", "resume", "stop"].filter((step) => !skip.has(`g7.${step}`));
  let seq = 0;
  log.bridge("provider", providerReceipt(run, seq++, "ready"));
  voice.forEach((step, index) => {
    const speak = op(run, "speak", T0 + 100 + index, { fixture_id: "conversation_greeting_probe", _g7_step: `g7.${step}` }, { schedule_receipt: { product: {} } });
    operations.push(speak);
    labUtterance(log, speak.id, T0 + 1_000 + index * 10_000, 1_500);
    log.bridge("input_window", inputWindow(run, seq++, index + 1, 1_500));
    log.bridge("input_turn", inputTurn(run, seq++, index + 1));
    if (index === 0) log.page(pageReceipt(run, "sophia_playback", T0 + 2_900, { phase: "playing" }));
    log.bridge("output_reply", outputReply(run, seq++, index + 1, T0 + 3_000 + index * 10_000));
    if (step !== "create" && step !== "steer") {
      const phase = step === "hold" ? "held" : step === "resume" ? "running" : "stopped";
      const observe = op(run, "studio_action", T0 + 150 + index, { action: "observe", for_step: step }, { performed: false, status: "observed" });
      operations.push(observe);
      log.add("studio.outcome.observed", "canonical", { purpose: `g7.${step}`, operation_id: observe.id, join: { status: "uncertain" }, tasks: [task(RESEARCH_TASK, "research", { phase, state: step === "stop" ? "cancelled" : "running" })], artifacts: [] });
    }
  });
  if (!skip.has("g7.leave_return")) {
    const leave = op(run, "studio_action", T0 + 200, { action: "leave_and_return" }, { performed: true, status: "returned" });
    operations.push(leave);
    log.add("studio.room.left", "browser", { basis: "ui_leave", operation_id: leave.id });
    log.page(pageReceipt(run, "mic_unpublished", T0 + 60_000));
    log.page(pageReceipt(run, "mic_published", T0 + 61_000));
    log.add("studio.room.rejoined", "browser", { lab_track_republished: true, operation_id: leave.id });
  }
  if (!skip.has("g7.section_revision")) {
    const edit = op(run, "studio_action", T0 + 300, { action: "section_revision", instruction: "x" }, { performed: true, status: "admitted" });
    operations.push(edit);
    log.add("studio.action.html_edit", "canonical", { purpose: "section_revision", operation_id: edit.id, requested: true, status: "admitted", http_status: 202, code: null, task_id: EDIT_TASK, version_id: VERSION_1 });
    log.add("studio.outcome.observed", "canonical", { purpose: "g7.section_revision", operation_id: edit.id, join: { status: "uncertain" }, tasks: [task(EDIT_TASK, "design", { state: "succeeded", design: { state: "published", mode: "edit", artifact_id: ARTIFACT, published_version_id: VERSION_2 } })], artifacts: [artifact(EDIT_TASK, VERSION_2, PAGE2_SHA, options.artifactStatus)] });
  }
  if (!skip.has("g7.stale_edit")) {
    const stale = op(run, "studio_action", T0 + 400, { action: "stale_edit" }, { performed: true, status: options.staleStatus === 202 ? "admitted" : "refused" });
    operations.push(stale);
    log.add("studio.action.html_edit", "canonical", { purpose: "stale_edit", operation_id: stale.id, requested: true, status: options.staleStatus === 202 ? "admitted" : "refused", http_status: options.staleStatus ?? 409, code: options.staleCode ?? "stale_revision", version_id: VERSION_1, superseded_by_version_id: VERSION_2 });
  }
  if (!skip.has("g7.withdrawal")) {
    const withdraw = op(run, "studio_action", T0 + 500, { action: "withdrawal" }, { performed: true, status: "committed" });
    operations.push(withdraw);
    const committed = options.withdrawalCommitted ?? true;
    log.add("studio.action.withdrawal", "canonical", { operation_id: withdraw.id, requested: true, status: committed ? "committed" : "refused", entry_id: NOTE, entry_bound_exchange_id: EXCHANGE_UUID, http_status: committed ? 202 : 409, code: committed ? null : "stale_revision", receipt_operation: committed ? "withdraw_note" : null });
    log.add("studio.outcome.observed", "canonical", { purpose: "g7.withdrawal", operation_id: withdraw.id, join: { status: "uncertain" }, tasks: [task(DESIGN_TASK, "design", { design: { state: "cancelled", mode: "create", artifact_id: ARTIFACT, published_version_id: VERSION_1 } })], artifacts: [] });
  }
  log.add("studio.outcome.observed", "canonical", { purpose: "final", operation_id: "end", join: { status: "uncertain" }, tasks: [task(DESIGN_TASK, "design", { state: "succeeded", design: { state: "published", mode: "create", artifact_id: ARTIFACT, published_version_id: VERSION_1 } }), task(RESEARCH_TASK, "research", { research: { html_state: "published", design_task_id: DESIGN_TASK } })], artifacts: [artifact(DESIGN_TASK, VERSION_1, PAGE_SHA, options.artifactStatus)] });
  log.bridge("provider", providerReceipt(run, seq++, "closed"));
  log.bridge("session_closed", sessionClosed(run, seq++, { windows: voice.length, turns: voice.length, replies: voice.length }));
  cleanupEvents(log);
  identityEvent(log, "final");
  if (!options.noEnd) operations.push(op(run, "end", T0 + 900, {}, {}));
  return { run, log, operations };
}

describe("Studio G7 episode: every step is an operation, outcomes are canonical or typed uncertain", () => {
  it("certifies the harness of a complete episode; voice outcomes stay uncertain so the product is inconclusive", () => {
    const item = g7Episode();
    const evaluation = evaluate(item);
    const failing = [...evaluation.harness].filter((assertion) => assertion.status !== "pass");
    expect(failing).toEqual([]);
    expect(evaluation.verdicts).toEqual({ harness: "pass", product: "inconclusive", provider: "pass" });
    expect(evaluation.bridge.first_seq).toBe(0);
    expect(evaluation.bridge.missing_seqs).toEqual([]);
    const steps = Object.fromEntries(evaluation.steps.map((step) => [step.step_id, `${step.executed}/${step.outcome}:${step.reason}`]));
    expect(steps).toEqual({
      "g7.create": "pass/uncertain:published_html_bytes_verified_join_uncertain",
      "g7.steer": "pass/uncertain:steer_effect_not_exposed_by_member_api",
      "g7.leave_return": "pass/pass:null",
      "g7.section_revision": "pass/pass:null",
      "g7.stale_edit": "pass/pass:null",
      "g7.hold": "pass/uncertain:intended_phase_observed_join_uncertain",
      "g7.resume": "pass/uncertain:intended_phase_observed_join_uncertain",
      "g7.stop": "pass/uncertain:intended_phase_observed_join_uncertain",
      "g7.withdrawal": "pass/pass:null",
    });
    expect(statusOf(evaluation, "step.g7.withdrawal.design_ended")).toMatchObject({ status: "uncertain", reason: "design_end_observed_join_uncertain" });
    expect(statusOf(evaluation, "outcome.artifact_bytes_integrity")).toMatchObject({ status: "pass" });
    expect(evaluation.outcome).toMatchObject({ join: "uncertain", missing_product_field: "NativeTask.exchangeId", artifacts_verified: 2, artifacts_mismatched: 0 });
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
    expect(statusOf(evaluate(g7Episode({ staleStatus: 202 })), "step.g7.stale_edit.outcome")).toMatchObject({ status: "fail", reason: "stale_edit_admitted" });
    expect(statusOf(evaluate(g7Episode({ staleStatus: 409, staleCode: "invalid_state" })), "step.g7.stale_edit.outcome")).toMatchObject({ status: "fail", reason: "stale_edit_refused_as_invalid_state" });
    expect(statusOf(evaluate(g7Episode({ withdrawalCommitted: false })), "step.g7.withdrawal.outcome")).toMatchObject({ status: "fail" });
    const mismatch = evaluate(g7Episode({ artifactStatus: "mismatch" }));
    expect(statusOf(mismatch, "outcome.artifact_bytes_integrity")).toMatchObject({ status: "fail", reason: "downloaded_bytes_disagree_with_declared_digest" });
    expect(statusOf(mismatch, "step.g7.section_revision.outcome")).toMatchObject({ status: "fail", reason: "revised_page_bytes_mismatch" });
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
    expect(studioG7CleanupProof(log.events)).toEqual({ exchangeEnded: true, signedOut: true, browserClosed: false, browserQuiesced: true, complete: true });
    expect(statusOf(evaluateStudioG7Run(run, log.events, [], { expected }), "cleanup.browser_closed")).toMatchObject({ status: "unavailable", reason: "dead_owner_quiesced_close_unobservable" });
    // An uncertain settlement is never an exchange end.
    const uncertain = new EventLog(run.id);
    uncertain.add("studio.cleanup.exchange_ended", "canonical", { confirmed: false, status: "uncertain", basis: "live_exchange_not_joined_to_run" });
    expect(studioG7CleanupProof(uncertain.events).exchangeEnded).toBe(false);
    expect(statusOf(evaluateStudioG7Run(run, uncertain.events, [], { expected }), "cleanup.exchange_ended")).toMatchObject({ status: "unavailable", reason: "exchange_uncertain_live_exchange_not_joined_to_run" });
  });
});
