import { createHash } from "node:crypto";

import type { LabEvent, OperationRecord, RunRecord, Verdicts } from "../domain.js";
import {
  STUDIO_G7_CONTRACT_VERSION,
  STUDIO_G7_EVALUATION_SCHEMA,
  STUDIO_G7_PRODUCT_CONTRACT,
  STUDIO_G7_RECEIPT_COVERAGE,
  StudioContractViolation,
  computeRunBindingSha256,
  parseBridgeReceipt,
  parsePageReceipt,
  sourceOfKind,
  BRIDGE_RECEIPT_KINDS,
  EVIDENCE_SOURCES,
  EvidenceGrantSchema,
  type BridgeReceiptKind,
  type EvidenceGrant,
  type EvidenceSource,
  type GuardReceipt,
  type InputTurnReceipt,
  type InputWindowReceipt,
  type OutputReplyReceipt,
  type ProviderReceipt,
  type SessionClosedReceipt,
  type StudioPageReceipt,
} from "./contract.js";
import { STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA, studioExchangeEndAfterJoin } from "./lease-release.js";
import { studioG7Scenario, type StudioG7Step } from "./scenarios.js";

/**
 * Studio G7 evaluation. Harness and product verdicts are derived separately.
 *
 * Rules (all deterministic over the durable event ledger):
 * - Every product receipt is bound by grantId + runBindingSha256. A receipt
 *   for another run, grant or project is a harness failure.
 * - Missing evidence is `unavailable`, never inferred. A join the product does
 *   not expose (exchange/run -> native task) is `uncertain`, never a pass.
 *   Legacy Gemini-only evidence this product cannot emit is typed
 *   `unsupported` or `not_supported_by_product_privacy_model`, never forged.
 * - Input is reconciled by ordinal and envelope only
 *   (`pcm_reconciliation: envelope_only`). The Lab's PCM chain is never
 *   compared with the bridge's chain.
 * - Bridge and service receipts are ordered and de-duplicated by
 *   (source, seq), never by arrival time. A late receipt (read after the
 *   Lab's End) is evidence like any other. The same (source, seq) with a
 *   different body is a harness failure.
 * - WebRTC stats are corroboration only and never satisfy a receipt.
 * - No transcript and no audio is retained by either side; only counts,
 *   envelopes and PCM digests the bridge already forwards.
 */

export type StudioAssertionStatus = "pass" | "fail" | "unavailable" | "uncertain" | "unsupported" | "not_supported_by_product_privacy_model";

export interface StudioAssertion {
  id: string;
  owner: "harness" | "product";
  status: StudioAssertionStatus;
  /** Fixed reason code; never prose or content. */
  reason: string | null;
  evidence_seqs: number[];
}

/** Bridge clock vs page clock tolerance for the playback join. */
export const PLAYBACK_JOIN_CLOCK_TOLERANCE_MS = 2_000;
/** Envelope lower bound: the window must hold at least this share of the utterance duration. */
export const INPUT_WINDOW_DURATION_FLOOR = 0.8;

type Event = LabEvent;

interface BoundPageReceipt { event: Event; receipt: StudioPageReceipt }
interface BoundBridgeReceipt<T> { event: Event; source: EvidenceSource; seq: number; kind: BridgeReceiptKind; receipt: T }

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function observedAtMs(event: Event): number | null {
  const provenance = event.payload._capture_provenance;
  const raw = provenance && typeof provenance === "object" && !Array.isArray(provenance) ? (provenance as Record<string, unknown>).observed_at : null;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface StudioStepResult {
  step_id: string;
  intent: StudioG7Step["intent"];
  executed: StudioAssertionStatus;
  outcome: StudioAssertionStatus;
  reason: string | null;
  operation_id: string | null;
  outcome_join: StudioG7Step["outcome_join"];
}

export interface StudioG7Evaluation {
  schema: typeof STUDIO_G7_EVALUATION_SCHEMA;
  contract_version: typeof STUDIO_G7_CONTRACT_VERSION;
  product_contract: typeof STUDIO_G7_PRODUCT_CONTRACT;
  scenario_id: string | null;
  scenario_version: string | null;
  run_binding_sha256: string;
  grant_id: string | null;
  pcm_reconciliation: "envelope_only";
  pcm_chain_comparison: "unsupported";
  retention: { transcript: "not_retained"; audio: "not_retained" };
  limitations: string[];
  verdicts: { harness: Verdicts["harness"]; product: Verdicts["product"]; provider: Verdicts["provider"] };
  harness: StudioAssertion[];
  product: StudioAssertion[];
  steps: StudioStepResult[];
  utterances: Array<Record<string, unknown>>;
  bridge: { receipt_count: number; distinct_seq_count: number; duplicate_count: number; conflicting_seqs: string[]; missing_seqs: number[]; first_seq: number | null; max_seq: number | null; read_after_lab_end_count: number; after_session_closed_kinds: string[]; exchange_state: string | null };
  cleanup: { required: true; guard_reason: string | null; exchange_ended: boolean; exchange_status: string | null; ownership: string | null; signed_out: boolean; browser_closed: boolean; browser_lease_released: boolean; complete: boolean };
  deployed_identities: Record<string, { expected: string | null; observed: string[]; status: "verified" | "mismatch" | "unavailable" }>;
  outcome: { observations: number; join: "uncertain"; missing_product_field: "NativeTask.exchangeId"; artifacts_verified: number; artifacts_mismatched: number; artifacts_unavailable: number };
  corroboration: { webrtc_sender_stats: { status: "corroboration_only"; samples: number; issued_track_rows: number; max_packets_sent: number | null } };
  coverage: typeof STUDIO_G7_RECEIPT_COVERAGE;
  summary: string;
}

export interface StudioEvaluationOptions {
  expected: { studio: string; api: string; bridge: string };
}

/** Explicit limitations every Studio G7 evaluation carries. */
export const STUDIO_G7_LIMITATIONS = Object.freeze([
  "no_transcript_retained",
  "no_audio_retained",
  "pcm_reconciliation_envelope_only",
  "fake_studio_loopback_peer_has_no_packet_flow_proof",
  "native_task_join_uncertain_no_exchange_binding",
  "orphan_browser_room_presence_not_observable_via_member_api",
]);

/** Phases and states that show each voice step's intended effect (positive observation only). */
const STEP_EFFECTS: Record<string, { phases?: string[]; states?: string[] }> = {
  "g7.hold": { phases: ["holding", "held"] },
  "g7.resume": { phases: ["queued", "dispatched", "running", "result_ready"], states: ["running", "pending"] },
  "g7.stop": { phases: ["stopping", "stopped"], states: ["cancelled"] },
};

export function evaluateStudioG7Run(run: RunRecord, events: Event[], operations: OperationRecord[], options: StudioEvaluationOptions): StudioG7Evaluation {
  const harness: StudioAssertion[] = [];
  const product: StudioAssertion[] = [];
  const add = (target: StudioAssertion[], id: string, owner: StudioAssertion["owner"], status: StudioAssertionStatus, reason: string | null, evidence: Event[] = []) => {
    target.push({ id, owner, status, reason, evidence_seqs: [...new Set(evidence.map((event) => event.seq))].sort((a, b) => a - b) });
  };
  const H = (id: string, status: StudioAssertionStatus, reason: string | null, evidence: Event[] = []) => add(harness, id, "harness", status, reason, evidence);
  const P = (id: string, status: StudioAssertionStatus, reason: string | null, evidence: Event[] = []) => add(product, id, "product", status, reason, evidence);

  const expectedBinding = run.scenarioId && run.scenarioVersion
    ? computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion })
    : "";
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const ofKind = (kind: string, source?: Event["source"]) => ordered.filter((event) => event.kind === kind && (source === undefined || event.source === source));
  const ended = operations.some((operation) => operation.type === "end" && operation.state === "succeeded");

  // ---------------------------------------------------------------- binding
  const grantIds = new Set<string>();
  const bindingMismatches: Event[] = [];
  const pageReceipts: BoundPageReceipt[] = [];
  const pageViolations: Event[] = [...ofKind("studio.page_receipt_rejected")];
  for (const event of ofKind("studio.page_receipt", "product")) {
    const raw = stringField(event.payload, "receipt_json");
    let receipt: StudioPageReceipt;
    try { receipt = parsePageReceipt(raw === null ? null : JSON.parse(raw)); }
    catch { pageViolations.push(event); continue; }
    if (event.payload.receipt_sha256 !== undefined && sha256(raw!) !== event.payload.receipt_sha256) { pageViolations.push(event); continue; }
    if (receipt.runBindingSha256 !== expectedBinding) { bindingMismatches.push(event); continue; }
    grantIds.add(receipt.grantId.toLowerCase());
    pageReceipts.push({ event, receipt });
  }

  const bridgeViolations: Event[] = [...ofKind("studio.bridge_evidence_rejected")];
  const grants: Array<{ event: Event; grant: EvidenceGrant; exchangeState: string | null }> = [];
  for (const event of ofKind("studio.bridge_grant", "canonical")) {
    const raw = stringField(event.payload, "grant_json");
    const parsed = EvidenceGrantSchema.safeParse(raw === null ? null : safeJson(raw));
    if (!parsed.success) { bridgeViolations.push(event); continue; }
    if (parsed.data.runBindingSha256 !== expectedBinding) { bindingMismatches.push(event); continue; }
    grantIds.add(parsed.data.grantId.toLowerCase());
    grants.push({ event, grant: parsed.data, exchangeState: typeof event.payload.exchange_state === "string" ? event.payload.exchange_state : null });
  }

  const bridgeRaw: Array<BoundBridgeReceipt<Record<string, unknown>> & { sha: string }> = [];
  for (const event of ofKind("studio.bridge_receipt", "canonical")) {
    const raw = stringField(event.payload, "receipt_json");
    const kind = event.payload.kind;
    const seq = event.payload.seq;
    const source = event.payload.source ?? (typeof kind === "string" && (BRIDGE_RECEIPT_KINDS as readonly string[]).includes(kind) ? sourceOfKind(kind as BridgeReceiptKind) : null);
    if (raw === null || typeof kind !== "string" || !(BRIDGE_RECEIPT_KINDS as readonly string[]).includes(kind) || !Number.isSafeInteger(seq)
      || typeof source !== "string" || !(EVIDENCE_SOURCES as readonly string[]).includes(source)
      || (event.payload.receipt_sha256 !== undefined && sha256(raw) !== event.payload.receipt_sha256)) { bridgeViolations.push(event); continue; }
    let receipt;
    try { receipt = parseBridgeReceipt(kind as BridgeReceiptKind, Number(seq), safeJson(raw), source as EvidenceSource); }
    catch (error) { if (error instanceof StudioContractViolation) { bridgeViolations.push(event); continue; } throw error; }
    if (receipt.runBindingSha256 !== expectedBinding) { bindingMismatches.push(event); continue; }
    grantIds.add(receipt.grantId.toLowerCase());
    bridgeRaw.push({ event, source: source as EvidenceSource, seq: Number(seq), kind: kind as BridgeReceiptKind, receipt: receipt as unknown as Record<string, unknown>, sha: sha256(raw) });
  }
  const grantId = grantIds.size === 1 ? [...grantIds][0]! : null;
  if (bindingMismatches.length > 0) H("binding.run_binding", "fail", "receipt_run_binding_mismatch", bindingMismatches);
  else if (grantIds.size > 1) H("binding.run_binding", "fail", "multiple_grant_ids_observed", [...pageReceipts.map((item) => item.event), ...bridgeRaw.map((item) => item.event)]);
  else if (grantIds.size === 0) H("binding.run_binding", "unavailable", "no_bound_product_receipt", []);
  else H("binding.run_binding", "pass", null, [...pageReceipts.map((item) => item.event), ...bridgeRaw.map((item) => item.event)]);
  P("contract.page_receipts_valid", pageViolations.length > 0 ? "fail" : pageReceipts.length > 0 ? "pass" : "unavailable", pageViolations.length > 0 ? "page_receipt_contract_violation" : pageReceipts.length > 0 ? null : "no_page_receipt", pageViolations);
  P("contract.bridge_evidence_valid", bridgeViolations.length > 0 ? "fail" : bridgeRaw.length > 0 ? "pass" : "unavailable", bridgeViolations.length > 0 ? "bridge_evidence_contract_violation" : bridgeRaw.length > 0 ? null : "no_bridge_receipt", bridgeViolations);

  // ---------------------------------------------- exchange ownership (cleanup)
  const ownershipEvents = ofKind("studio.exchange.ownership", "canonical");
  const ownershipMismatch = ownershipEvents.filter((event) => event.payload.status === "mismatch");
  const ownershipProven = ownershipEvents.filter((event) => event.payload.status === "proven");
  const exchangeJoin = ofKind("studio.exchange.opened", "canonical").at(-1) ?? null;
  if (ownershipMismatch.length > 0) H("binding.exchange_ownership", "fail", String(ownershipMismatch[0]!.payload.reason ?? "exchange_bound_to_another_run"), ownershipMismatch);
  else if (exchangeJoin === null) H("binding.exchange_ownership", "unavailable", "no_exchange_joined_to_run");
  else if (ownershipProven.length > 0) H("binding.exchange_ownership", "pass", null, [exchangeJoin, ...ownershipProven]);
  else H("binding.exchange_ownership", "unavailable", typeof ownershipEvents.at(-1)?.payload.reason === "string" ? String(ownershipEvents.at(-1)!.payload.reason) : "ownership_not_proven", [exchangeJoin, ...ownershipEvents]);

  // ------------------------------------------- bridge (source, seq) discipline
  const bySeq = new Map<string, Array<typeof bridgeRaw[number]>>();
  for (const item of bridgeRaw) bySeq.set(`${item.source}:${item.seq}`, [...(bySeq.get(`${item.source}:${item.seq}`) ?? []), item]);
  const conflictingSeqs: string[] = [];
  const bridge: Array<typeof bridgeRaw[number]> = [];
  let duplicateCount = 0;
  for (const key of [...bySeq.keys()].sort()) {
    const group = bySeq.get(key)!;
    const bodies = new Set(group.map((item) => `${item.kind}:${item.sha}`));
    if (bodies.size > 1) { conflictingSeqs.push(key); continue; }
    duplicateCount += group.length - 1;
    bridge.push(group.sort((left, right) => left.event.seq - right.event.seq)[0]!);
  }
  bridge.sort((left, right) => left.source === right.source ? left.seq - right.seq : left.source < right.source ? -1 : 1);
  const bridgeSeqs = [...bridge.filter((item) => item.source === "bridge").map((item) => item.seq), ...conflictingSeqs.filter((key) => key.startsWith("bridge:")).map((key) => Number(key.slice(7)))];
  const maxSeq = bridgeSeqs.length > 0 ? Math.max(...bridgeSeqs) : null;
  // The contract does not pin the bridge's first seq: 0 when observed, else 1.
  const firstSeq = bridgeSeqs.length === 0 ? null : bridgeSeqs.includes(0) ? 0 : 1;
  const presentSeqs = new Set(bridgeSeqs);
  const missingSeqs: number[] = [];
  if (maxSeq !== null && firstSeq !== null) for (let seq = firstSeq; seq <= maxSeq && missingSeqs.length < 1_000; seq += 1) if (!presentSeqs.has(seq)) missingSeqs.push(seq);
  if (conflictingSeqs.length > 0) H("bridge.seq_integrity", "fail", "bridge_seq_conflict", bridgeRaw.filter((item) => conflictingSeqs.includes(`${item.source}:${item.seq}`)).map((item) => item.event));
  else H("bridge.seq_integrity", bridge.length === 0 ? "unavailable" : "pass", bridge.length === 0 ? "no_bridge_receipt" : null, bridge.map((item) => item.event));

  // Only an end confirmed after the run's exchange join proves anything about that exchange.
  const labEndEvent = studioExchangeEndAfterJoin(ordered);
  const readAfterLabEnd = labEndEvent ? bridge.filter((item) => item.event.seq > labEndEvent.seq).length : 0;
  const of = <T,>(kind: BridgeReceiptKind) => bridge.filter((item) => item.kind === kind) as unknown as Array<BoundBridgeReceipt<T>>;
  const windowsAll = of<InputWindowReceipt>("input_window");
  const turnsAll = of<InputTurnReceipt>("input_turn");
  const providers = of<ProviderReceipt>("provider");
  const repliesAll = of<OutputReplyReceipt>("output_reply");
  const closes = of<SessionClosedReceipt>("session_closed");
  const guards = of<GuardReceipt>("guard");
  const sessionClosed = closes.at(-1) ?? null;
  const afterClosedKinds = sessionClosed ? [...new Set(bridge.filter((item) => item.source === "bridge" && item.seq > sessionClosed.seq && item.kind !== "provider").map((item) => item.kind))] : [];
  const latestGrant = grants.at(-1) ?? null;

  // Windows/replies are keyed by their own ordinals; a repeated ordinal with
  // a different body is a contract conflict.
  const uniqueBy = <T,>(items: Array<BoundBridgeReceipt<T>>, key: (receipt: T) => number, id: string) => {
    const map = new Map<number, BoundBridgeReceipt<T>>();
    const conflicts: Event[] = [];
    for (const item of items) {
      const k = key(item.receipt);
      if (map.has(k)) conflicts.push(item.event, map.get(k)!.event);
      else map.set(k, item);
    }
    if (conflicts.length > 0) P(id, "fail", "bridge_ordinal_conflict", conflicts);
    return [...map.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  };
  const windows = uniqueBy(windowsAll, (receipt) => receipt.windowSeq, "bridge.window_ordinals_unique");
  const replies = uniqueBy(repliesAll, (receipt) => receipt.replyOrdinal, "bridge.reply_ordinals_unique");
  const receiptsDropped = missingSeqs.length > 0 || (sessionClosed !== null && (sessionClosed.receipt.windows > windows.length || sessionClosed.receipt.turns > turnsAll.length || sessionClosed.receipt.replies > replies.length));

  // ------------------------------------------------------------- utterances
  const inputs = operations
    .filter((operation) => (operation.type === "speak" || operation.type === "barge_in") && operation.state === "succeeded")
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  const issued = ofKind("harness.media_stream_issued", "browser").filter((event) => event.payload.replacement_active === true);
  const issuedHashes = new Set(issued.flatMap((event) => Array.isArray(event.payload.track_id_sha256s) ? (event.payload.track_id_sha256s as unknown[]).filter((value): value is string => typeof value === "string") : []));
  const micEvents = pageReceipts.filter((item) => item.receipt.event === "mic_published" || item.receipt.event === "mic_unpublished")
    .sort((left, right) => left.receipt.atMs - right.receipt.atMs || left.event.seq - right.event.seq);
  const publishedForeign = micEvents.filter((item) => item.receipt.event === "mic_published" && !issuedHashes.has(sha256(item.receipt.trackId)));
  const publishedLab = micEvents.filter((item) => item.receipt.event === "mic_published" && issuedHashes.has(sha256(item.receipt.trackId)));
  if (publishedForeign.length > 0) H("input.published_track_is_lab_issued", "fail", "published_track_not_lab_issued", publishedForeign.map((item) => item.event));
  else if (publishedLab.length === 0) H("input.published_track_is_lab_issued", "unavailable", issued.length === 0 ? "lab_issuance_receipt_missing" : "mic_published_receipt_missing", issued);
  else H("input.published_track_is_lab_issued", "pass", null, [...publishedLab.map((item) => item.event), ...issued]);

  const nonSilence: Array<{ operation: OperationRecord; durationMs: number | null; startedAt: number | null }> = [];
  const utterances: Array<Record<string, unknown>> = [];
  inputs.forEach((operation, index) => {
    const byOp = (kind: string) => ordered.filter((event) => event.kind === kind && event.payload.operation_id === operation.id);
    const resolved = byOp("utterance.resolved");
    const scheduled = byOp("audio.input.scheduled");
    const started = byOp("audio.input.started");
    const completed = byOp("audio.input.completed");
    const interrupted = [...byOp("audio.input.interrupted"), ...byOp("audio.input.rejected")];
    const id = `input.${index + 1}`;
    const r1Evidence = [...resolved, ...scheduled];
    if (r1Evidence.length === 0) H(`${id}.r1_scheduling_chain`, "unavailable", "lab_scheduling_receipts_missing");
    else H(`${id}.r1_scheduling_chain`, resolved.length === 1 && scheduled.length === 1 && operation.result?.schedule_receipt !== undefined ? "pass" : "fail", resolved.length === 1 && scheduled.length === 1 ? null : "lab_scheduling_chain_not_exact", r1Evidence);
    const r3Evidence = [...started, ...completed, ...interrupted];
    if (r3Evidence.length === 0) H(`${id}.r3_playout_chain`, "unavailable", "lab_playout_receipts_missing");
    else H(`${id}.r3_playout_chain`, started.length === 1 && completed.length === 1 && interrupted.length === 0 ? "pass" : "fail", interrupted.length > 0 ? "lab_input_interrupted_or_rejected" : started.length === 1 && completed.length === 1 ? null : "lab_playout_chain_not_exact", r3Evidence);
    // R2: the mic the Studio published at utterance start is the Lab-issued track.
    const startAt = started[0] ? observedAtMs(started[0]) : null;
    const endAt = completed[0] ? observedAtMs(completed[0]) : null;
    let r2: StudioAssertionStatus = "unavailable";
    let r2Reason: string | null = "mic_state_unobservable_at_utterance";
    const r2Evidence: Event[] = [];
    if (startAt !== null && micEvents.length > 0) {
      const prior = micEvents.filter((item) => item.receipt.atMs <= startAt);
      const current = prior.at(-1);
      if (current?.receipt.event === "mic_published") {
        r2Evidence.push(current.event);
        const unpublishedDuring = endAt === null ? [] : micEvents.filter((item) => item.receipt.event === "mic_unpublished" && item.receipt.trackSid === current.receipt.trackSid && item.receipt.atMs > startAt && item.receipt.atMs <= endAt);
        if (!issuedHashes.has(sha256(current.receipt.trackId))) { r2 = "fail"; r2Reason = "published_track_not_lab_issued"; }
        else if (unpublishedDuring.length > 0) { r2 = "fail"; r2Reason = "mic_unpublished_during_utterance"; r2Evidence.push(...unpublishedDuring.map((item) => item.event)); }
        else { r2 = "pass"; r2Reason = null; }
      } else if (current?.receipt.event === "mic_unpublished") {
        r2 = "fail"; r2Reason = "mic_unpublished_at_utterance_start"; r2Evidence.push(current.event);
      }
    }
    H(`${id}.r2_published_track_identity`, r2, r2Reason, r2Evidence);
    const wav = resolved[0]?.payload.wav as Record<string, unknown> | undefined;
    const durationMs = typeof wav?.duration_ms === "number" ? wav.duration_ms : null;
    const silence = String(operation.input.fixture_id ?? "").toLowerCase().includes("silence");
    if (!silence) nonSilence.push({ operation, durationMs, startedAt: startAt });
    else H(`${id}.silence_ordinal_join`, "unavailable", "silence_not_joinable_by_window_ordinal_on_this_transport");
    utterances.push({ ordinal: index + 1, operation_id: operation.id, g7_step: typeof operation.input._g7_step === "string" ? operation.input._g7_step : null, silence, duration_ms: durationMs, r2 });
  });

  // ------------------------------------------- input windows (envelope only)
  if (nonSilence.length === 0) {
    H("input.window_join", "unavailable", "no_non_silence_utterance");
  } else if (windows.length === 0) {
    H("input.window_join", "unavailable", "no_input_window_receipt");
  } else if (receiptsDropped || sessionClosed === null) {
    H("input.window_join", "unavailable", sessionClosed === null ? "session_closed_receipt_missing" : "bridge_receipts_dropped", windows.map((item) => item.event));
  } else if (windows.length !== nonSilence.length) {
    H("input.window_join", "fail", "input_window_count_mismatch", windows.map((item) => item.event));
  } else {
    H("input.window_join", "pass", null, windows.map((item) => item.event));
  }
  const joinable = !receiptsDropped && sessionClosed !== null && windows.length === nonSilence.length;
  nonSilence.forEach((entry, index) => {
    const id = `input.${index + 1}`;
    const window = windows[index];
    const utterance = utterances.find((candidate) => candidate.operation_id === entry.operation.id)!;
    if (!joinable || !window) {
      P(`${id}.window_envelope`, "unavailable", "ordinal_join_unavailable");
      P(`${id}.turn_accepted`, "unavailable", "ordinal_join_unavailable");
      utterance.bridge_window = null;
      return;
    }
    const w = window.receipt;
    const minSamples = entry.durationMs === null ? null : Math.floor(entry.durationMs * 16 * INPUT_WINDOW_DURATION_FLOOR);
    const audible = w.nonzeroSampleCount > 0 && w.audibleChunkCount > 0 && w.rms > 0 && w.peak > 0;
    const longEnough = minSamples !== null && w.sampleCount >= minSamples && w.endedAtMs >= w.startedAtMs && (w.endedAtMs - w.startedAtMs) >= Math.floor(entry.durationMs! * INPUT_WINDOW_DURATION_FLOOR);
    const envelopeStatus: StudioAssertionStatus = minSamples === null ? "unavailable" : audible && longEnough ? "pass" : "fail";
    P(`${id}.window_envelope`, envelopeStatus, minSamples === null ? "utterance_duration_unavailable" : !audible ? "window_not_audible" : !longEnough ? "window_shorter_than_utterance_envelope" : null, [window.event]);
    const turns = turnsAll.filter((item) => item.receipt.windowSeq === w.windowSeq);
    const turn = turns.at(-1);
    if (!turn) P(`${id}.turn_accepted`, "fail", "no_input_turn_for_window", [window.event]);
    else {
      const t = turn.receipt;
      const accepted = t.inputTranscriptionObserved && t.finished && t.attributedToHolder && t.outcome === "answered";
      P(`${id}.turn_accepted`, accepted ? "pass" : "fail", accepted ? null : !t.attributedToHolder ? "turn_not_attributed_to_holder" : !t.inputTranscriptionObserved ? "input_transcription_not_observed" : `turn_outcome_${t.outcome}`, [window.event, turn.event]);
    }
    utterance.bridge_window = {
      window_seq: w.windowSeq, input_epoch: w.inputEpoch, connection: w.connection, end_reason: w.endReason,
      chunk_count: w.chunkCount, sample_count: w.sampleCount, nonzero_sample_count: w.nonzeroSampleCount, audible_chunk_count: w.audibleChunkCount,
      dropped_samples: w.droppedSamples, rms: w.rms, peak: w.peak, pcm_digest_algorithm: w.pcmDigestAlgorithm,
      // Recorded for provenance only. It is never compared with the Lab's chain.
      bridge_pcm_sha256_chain: w.pcmSha256Chain, pcm_chain_comparison: "unsupported",
      transcript_chars: turn?.receipt.transcriptChars ?? null, turn_outcome: turn?.receipt.outcome ?? null,
    };
  });

  // --------------------------------------------------------------- provider
  const ready = providers.filter((item) => item.receipt.phase === "ready");
  const unavailableProvider = providers.filter((item) => item.receipt.phase === "unavailable");
  const bridgeCommits = [...new Set(providers.map((item) => item.receipt.bridgeCommit).filter((value): value is string => value !== null))];
  const providerVerdict: Verdicts["provider"] = unavailableProvider.length > 0 ? "fail"
    : ready.length > 0 && sessionClosed?.receipt.providerClosed === true ? "pass"
      : providers.length === 0 && sessionClosed === null ? "unavailable" : "inconclusive";
  P("provider.lifecycle", providers.length === 0 ? "unavailable" : unavailableProvider.length > 0 ? "fail" : ready.length > 0 ? "pass" : "fail", providers.length === 0 ? "no_provider_receipt" : unavailableProvider.length > 0 ? "provider_unavailable" : ready.length > 0 ? null : "provider_never_ready", providers.map((item) => item.event));

  // ---------------------------------------------------------------- output
  const audibleReplies = replies.filter((item) => item.receipt.terminal === "played" && item.receipt.nonSilentFramesPlayed > 0 && item.receipt.framesPlayed > 0 && item.receipt.firstPlayedAtMs !== null);
  if (replies.length === 0) P("output.audible_reply", sessionClosed !== null && !receiptsDropped && sessionClosed.receipt.replies === 0 && turnsAll.some((item) => item.receipt.modelResponded) ? "fail" : "unavailable", sessionClosed !== null && !receiptsDropped && sessionClosed.receipt.replies === 0 ? "model_responded_without_reply" : "no_output_reply_receipt");
  else P("output.audible_reply", audibleReplies.length > 0 ? "pass" : "fail", audibleReplies.length > 0 ? null : "no_reply_played_audibly", replies.map((item) => item.event));
  const playback = pageReceipts.filter((item) => item.receipt.event === "sophia_playback").sort((left, right) => left.receipt.atMs - right.receipt.atMs || left.event.seq - right.event.seq);
  if (audibleReplies.length === 0) P("output.page_playback_join", "unavailable", "no_audible_reply_to_join");
  else if (playback.length === 0) P("output.page_playback_join", "unavailable", "no_sophia_playback_page_receipt");
  else {
    // Skew-symmetric join across the bridge and page clocks: the Sophia
    // element must have started playing no later than the reply (+tolerance),
    // and must not have stopped definitely before the reply began
    // (-tolerance). A stop after the reply is not evidence against it.
    const isPlaying = (phase: string) => phase === "play" || phase === "playing";
    const isStopped = (phase: string) => phase === "pause" || phase === "ended" || phase === "emptied";
    const unjoined = audibleReplies.filter((reply) => {
      const at = reply.receipt.firstPlayedAtMs!;
      const lastPlaying = playback.filter((item) => item.receipt.event === "sophia_playback" && isPlaying(item.receipt.phase) && item.receipt.atMs <= at + PLAYBACK_JOIN_CLOCK_TOLERANCE_MS).at(-1);
      if (!lastPlaying) return true;
      return playback.some((item) => item.receipt.event === "sophia_playback" && isStopped(item.receipt.phase) && item.receipt.atMs > lastPlaying.receipt.atMs && item.receipt.atMs < at - PLAYBACK_JOIN_CLOCK_TOLERANCE_MS);
    });
    P("output.page_playback_join", unjoined.length === 0 ? "pass" : "fail", unjoined.length === 0 ? null : "sophia_element_not_playing_at_reply", [...audibleReplies.map((item) => item.event), ...playback.map((item) => item.event)]);
  }

  // ---------------------------------------------------- session and guard
  if (sessionClosed === null) H("session.closed_receipt", "unavailable", "session_closed_receipt_missing");
  else H("session.closed_receipt", receiptsDropped ? "unavailable" : "pass", receiptsDropped ? "bridge_receipts_dropped" : null, [sessionClosed.event]);
  const guard = guards.at(-1) ?? null;
  const grantEnded = grants.map((item) => item.grant.endedReason).find((reason) => reason !== null) ?? null;
  const guardReason = guard?.receipt.reason ?? grantEnded ?? (sessionClosed?.receipt.reason === "guard" ? "unknown_guard" : null);
  if (guard || sessionClosed?.receipt.reason === "guard" || grantEnded) {
    // The server-side guard ended the exchange: the run exceeded its grant.
    // Cleanup is still mandatory and is evaluated below.
    H("guard.not_triggered", "fail", `guard_${guardReason ?? "unknown"}`, [...(guard ? [guard.event] : []), ...(sessionClosed ? [sessionClosed.event] : [])]);
  } else if (sessionClosed !== null) {
    H("guard.not_triggered", "pass", null, [sessionClosed.event]);
  } else {
    H("guard.not_triggered", "unavailable", "session_outcome_unobserved");
  }

  // ------------------------------------------------------------------ cleanup
  const cleanup = studioG7CleanupProof(ordered);
  const endedEvents = ofKind("studio.cleanup.exchange_ended", "canonical");
  const latestEnded = endedEvents.at(-1) ?? null;
  const signedOutEvents = ofKind("studio.cleanup.signed_out", "canonical").filter((event) => event.payload.confirmed === true);
  const browserClosed = ofKind("cleanup.browser_context_closed", "browser").filter((event) => event.payload.close_resolved === true && event.payload.browser_registry_absent === true && event.payload.browser_process_close_resolved === true);
  const leaseReleased = ordered.filter((event) => (event.kind === "cleanup.browser_lease_released" && event.payload.cas_deleted === true) || (event.kind === "cleanup.browser_lease_absent" && event.payload.authoritative_ledger_read === true));
  const cleanupComplete = cleanup.complete && leaseReleased.length > 0;
  H("cleanup.exchange_ended", cleanup.exchangeEnded ? "pass" : latestEnded ? "unavailable" : "fail", cleanup.exchangeEnded ? null : latestEnded?.payload.confirmed === true ? "exchange_end_not_attributable_to_run_exchange" : latestEnded ? `exchange_${String(latestEnded.payload.status ?? "unconfirmed")}_${String(latestEnded.payload.basis ?? "unknown")}` : "exchange_end_not_verified", labEndEvent ? [labEndEvent] : endedEvents);
  H("cleanup.principal_signed_out", signedOutEvents.length > 0 ? "pass" : "fail", signedOutEvents.length > 0 ? null : "global_sign_out_unconfirmed", signedOutEvents);
  // The evidence refresh revokes only its own session; one it could not revoke stays live until a later global sign-out.
  H("cleanup.refresh_session_revoked", cleanup.refreshSessionsRevoked ? "pass" : "fail", cleanup.refreshSessionsRevoked ? null : "evidence_refresh_session_unrevoked", ofKind("studio.evidence.session_revoked", "canonical"));
  H("cleanup.browser_closed", cleanup.browserClosed ? "pass" : cleanup.browserQuiesced ? "unavailable" : "fail", cleanup.browserClosed ? null : cleanup.browserQuiesced ? "dead_owner_quiesced_close_unobservable" : "browser_close_unproven", browserClosed);
  H("cleanup.browser_lease_released", leaseReleased.length > 0 ? "pass" : "fail", leaseReleased.length > 0 ? null : "browser_lease_release_unproven", leaseReleased);

  // ------------------------------------------------------ deployed identities
  const identityEvents = ofKind("studio.deployment.identity", "canonical");
  const identity = (component: "api" | "studio") => {
    const observations = identityEvents.map((event) => event.payload[component] as Record<string, unknown> | undefined).filter((value): value is Record<string, unknown> => !!value);
    const observed = [...new Set(observations.filter((value) => value.status === "observed" && typeof value.commit === "string").map((value) => String(value.commit)))];
    const status: "verified" | "mismatch" | "unavailable" = observed.some((commit) => commit !== options.expected[component]) ? "mismatch" : observed.length > 0 && observations.every((value) => value.status === "observed") ? "verified" : "unavailable";
    return { expected: options.expected[component], observed, status };
  };
  const identities = {
    api: identity("api"),
    studio: identity("studio"),
    bridge: { expected: options.expected.bridge, observed: bridgeCommits, status: (bridgeCommits.some((commit) => commit !== options.expected.bridge) ? "mismatch" : bridgeCommits.length > 0 && providers.every((item) => item.receipt.bridgeCommit !== null) ? "verified" : "unavailable") as "verified" | "mismatch" | "unavailable" },
  };
  for (const [component, value] of Object.entries(identities)) {
    H(`identity.${component}`, value.status === "verified" ? "pass" : value.status === "mismatch" ? "fail" : "unavailable", value.status === "verified" ? null : value.status === "mismatch" ? `${component}_commit_mismatch` : `${component}_identity_unavailable`, component === "bridge" ? providers.map((item) => item.event) : identityEvents);
  }

  // ---------------------------------------------------------- outcome reads
  const observations = ofKind("studio.outcome.observed", "canonical");
  const artifactFacts = observations.flatMap((event) => (Array.isArray(event.payload.artifacts) ? event.payload.artifacts as unknown[] : []).map((value) => ({ event, artifact: record(value) ?? {} })));
  const latestArtifact = new Map<string, { event: Event; artifact: Record<string, unknown> }>();
  for (const item of artifactFacts) latestArtifact.set(String(item.artifact.version_id), item);
  const artifactStates = [...latestArtifact.values()];
  const mismatched = artifactStates.filter((item) => item.artifact.status === "mismatch");
  const verifiedArtifacts = artifactStates.filter((item) => item.artifact.status === "verified");
  if (mismatched.length > 0) P("outcome.artifact_bytes_integrity", "fail", "downloaded_bytes_disagree_with_declared_digest", mismatched.map((item) => item.event));
  else if (verifiedArtifacts.length > 0) P("outcome.artifact_bytes_integrity", "pass", null, verifiedArtifacts.map((item) => item.event));
  else P("outcome.artifact_bytes_integrity", "unavailable", artifactStates.length > 0 ? String(artifactStates[0]!.artifact.reason ?? "artifact_bytes_unavailable") : "no_published_artifact_observed", observations);

  // ------------------------------------------------------------ scenario steps
  const scenario = studioG7Scenario(run.scenarioId);
  const steps: StudioStepResult[] = [];
  const tasksOf = (event: Event) => (Array.isArray(event.payload.tasks) ? event.payload.tasks as unknown[] : []).map((value) => record(value) ?? {});
  if (!scenario) {
    H("scenario.catalog_binding", "unavailable", "scenario_not_in_studio_g7_catalog");
  } else {
    const actionOps = operations.filter((operation) => operation.type === "studio_action");
    const succeededFor = (step: StudioG7Step) => (step.executor === "speak"
      ? inputs.filter((operation) => operation.input._g7_step === step.id)
      : actionOps.filter((operation) => operation.state === "succeeded" && operation.input.action === step.label))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    for (const step of scenario.steps) {
      const performed = succeededFor(step).filter((operation) => step.executor === "speak" || operation.result?.performed === true);
      const attempted = succeededFor(step);
      const operation = performed.at(-1) ?? attempted.at(-1) ?? null;
      const result: StudioStepResult = { step_id: step.id, intent: step.intent, executed: "unavailable", outcome: "unavailable", reason: null, operation_id: operation?.id ?? null, outcome_join: step.outcome_join };
      if (performed.length === 0) {
        const typedReason = typeof attempted.at(-1)?.result?.reason === "string" ? String(attempted.at(-1)!.result!.reason) : null;
        result.executed = ended ? "fail" : "unavailable";
        result.reason = typedReason ?? (ended ? "step_not_performed_before_end" : "step_not_yet_performed");
        result.outcome = "unavailable";
        steps.push(result);
        continue;
      }
      result.executed = "pass";
      if (step.executor === "speak") {
        const stepObservations = observations.filter((event) => event.payload.purpose === step.id);
        const final = observations.filter((event) => event.payload.purpose === "final").at(-1) ?? null;
        const observation = stepObservations.at(-1) ?? (step.id === "g7.create" || step.id === "g7.steer" ? final : null);
        if (!observation) { result.outcome = "unavailable"; result.reason = "no_outcome_observation_for_step"; steps.push(result); continue; }
        const tasks = tasksOf(observation);
        if (step.id === "g7.create") {
          const designs = tasks.filter((task) => record(task.design)?.published_version_id);
          const published = designs.some((task) => artifactStates.some((item) => item.artifact.task_id === task.task_id && item.artifact.status === "verified"));
          result.outcome = published ? "uncertain" : designs.length > 0 || tasks.length > 0 ? "uncertain" : "unavailable";
          result.reason = published ? "published_html_bytes_verified_join_uncertain" : tasks.length > 0 ? "candidate_task_observed_without_verified_page" : "no_candidate_task_observed";
        } else if (step.id === "g7.steer") {
          result.outcome = tasks.length > 0 ? "uncertain" : "unavailable";
          result.reason = tasks.length > 0 ? "steer_effect_not_exposed_by_member_api" : "no_candidate_task_observed";
        } else {
          const effect = STEP_EFFECTS[step.id]!;
          const matched = tasks.some((task) => (effect.phases ?? []).includes(String(task.phase)) || (effect.states ?? []).includes(String(task.state)));
          result.outcome = tasks.length === 0 ? "unavailable" : "uncertain";
          result.reason = tasks.length === 0 ? "no_candidate_task_observed" : matched ? "intended_phase_observed_join_uncertain" : "intended_phase_not_observed_join_uncertain";
        }
        steps.push(result);
        continue;
      }
      if (step.label === "leave_and_return") {
        const left = ofKind("studio.room.left", "browser").filter((event) => event.payload.operation_id === operation!.id);
        const rejoined = ofKind("studio.room.rejoined", "browser").filter((event) => event.payload.operation_id === operation!.id);
        const republished = left.length > 0 && publishedLab.some((item) => item.event.seq > left[0]!.seq);
        result.outcome = rejoined.length > 0 && republished ? "pass" : "fail";
        result.reason = rejoined.length > 0 && republished ? null : "lab_track_not_republished_after_return";
        steps.push(result);
        continue;
      }
      if (step.label === "section_revision" || step.label === "stale_edit") {
        const edit = ofKind("studio.action.html_edit", "canonical").filter((event) => event.payload.operation_id === operation!.id && event.payload.requested === true).at(-1);
        if (!edit) { result.outcome = "unavailable"; result.reason = "edit_receipt_missing"; steps.push(result); continue; }
        if (step.label === "stale_edit") {
          const refusedStale = edit.payload.http_status === 409 && edit.payload.code === "stale_revision";
          result.outcome = refusedStale ? "pass" : "fail";
          result.reason = refusedStale ? null : edit.payload.status === "admitted" ? "stale_edit_admitted" : `stale_edit_refused_as_${String(edit.payload.code ?? edit.payload.http_status ?? "unknown")}`;
          steps.push(result);
          continue;
        }
        if (edit.payload.status !== "admitted" || typeof edit.payload.task_id !== "string") {
          result.outcome = "fail"; result.reason = `section_revision_refused_${String(edit.payload.code ?? edit.payload.http_status ?? "unknown")}`; steps.push(result); continue;
        }
        const taskId = edit.payload.task_id;
        const latest = [...observations].reverse().map((event) => tasksOf(event).find((task) => task.task_id === taskId)).find((task) => task !== undefined);
        const design = record(latest?.design);
        const artifact = artifactStates.find((item) => item.artifact.task_id === taskId);
        if (!design) { result.outcome = "unavailable"; result.reason = "edit_task_not_observed"; }
        else if (design.state === "published" && design.mode === "edit") {
          result.outcome = artifact?.artifact.status === "verified" ? "pass" : artifact?.artifact.status === "mismatch" ? "fail" : "unavailable";
          result.reason = artifact?.artifact.status === "verified" ? null : artifact?.artifact.status === "mismatch" ? "revised_page_bytes_mismatch" : "revised_page_bytes_unavailable";
        } else if (design.state === "failed" || design.state === "cancelled" || design.state === "superseded") {
          result.outcome = "fail"; result.reason = `section_revision_${String(design.state)}`;
        } else { result.outcome = "unavailable"; result.reason = "section_revision_not_settled"; }
        steps.push(result);
        continue;
      }
      // withdrawal
      const withdrawal = ofKind("studio.action.withdrawal", "canonical").filter((event) => event.payload.operation_id === operation!.id && event.payload.requested === true).at(-1);
      if (!withdrawal) { result.outcome = "unavailable"; result.reason = "withdrawal_receipt_missing"; steps.push(result); continue; }
      const committed = withdrawal.payload.status === "committed" && withdrawal.payload.receipt_operation === "withdraw_note";
      result.outcome = committed ? "pass" : "fail";
      result.reason = committed ? null : `withdrawal_refused_${String(withdrawal.payload.code ?? withdrawal.payload.http_status ?? "unknown")}`;
      steps.push(result);
      const after = observations.filter((event) => event.seq > withdrawal.seq);
      const designEnded = after.some((event) => tasksOf(event).some((task) => ["cancelled", "failed", "superseded"].includes(String(record(task.design)?.state))));
      P("step.g7.withdrawal.design_ended", after.length === 0 ? "unavailable" : "uncertain", after.length === 0 ? "no_observation_after_withdrawal" : designEnded ? "design_end_observed_join_uncertain" : "design_end_not_observed_join_uncertain", after);
    }
    for (const step of steps) {
      H(`step.${step.step_id}.executed`, step.executed, step.executed === "pass" ? null : step.reason);
      P(`step.${step.step_id}.outcome`, step.outcome, step.reason);
    }
  }

  // -------------------------------------------------- legacy-only evidence
  for (const kind of ["harness.input_frame_forwarded", "audio.input.product_leg", "session.finalized"]) {
    if (ordered.some((event) => event.kind === kind)) H(`legacy.${kind}`, "fail", "legacy_gemini_browser_evidence_on_studio_target", ordered.filter((event) => event.kind === kind));
  }

  // ------------------------------------------------------------ corroboration
  const stats = ofKind("studio.webrtc.sender_stats", "browser");
  let issuedRows = 0;
  let maxPackets: number | null = null;
  for (const event of stats) {
    const rows = Array.isArray(event.payload.rows) ? event.payload.rows as Array<Record<string, unknown>> : [];
    for (const row of rows) {
      if (typeof row.track_id_sha256 === "string" && issuedHashes.has(row.track_id_sha256)) {
        issuedRows += 1;
        if (typeof row.packets_sent === "number") maxPackets = Math.max(maxPackets ?? 0, row.packets_sent);
      }
    }
  }

  const harnessVerdict = harnessVerdictOf(harness);
  const productVerdict = productVerdictOf(product);
  const withheld = harness.filter((assertion) => assertion.status !== "pass").map((assertion) => `${assertion.id}=${assertion.status}`);
  const latestOwnership = ownershipEvents.at(-1)?.payload.status;
  return {
    schema: STUDIO_G7_EVALUATION_SCHEMA,
    contract_version: STUDIO_G7_CONTRACT_VERSION,
    product_contract: STUDIO_G7_PRODUCT_CONTRACT,
    scenario_id: run.scenarioId,
    scenario_version: run.scenarioVersion,
    run_binding_sha256: expectedBinding,
    grant_id: grantId,
    pcm_reconciliation: "envelope_only",
    pcm_chain_comparison: "unsupported",
    retention: { transcript: "not_retained", audio: "not_retained" },
    limitations: [...STUDIO_G7_LIMITATIONS],
    verdicts: { harness: harnessVerdict, product: productVerdict, provider: providerVerdict },
    harness,
    product,
    steps,
    utterances,
    bridge: { receipt_count: bridgeRaw.length, distinct_seq_count: bridge.length, duplicate_count: duplicateCount, conflicting_seqs: conflictingSeqs, missing_seqs: missingSeqs, first_seq: firstSeq, max_seq: maxSeq, read_after_lab_end_count: readAfterLabEnd, after_session_closed_kinds: afterClosedKinds, exchange_state: latestGrant?.exchangeState ?? null },
    cleanup: { required: true, guard_reason: guardReason, exchange_ended: cleanup.exchangeEnded, exchange_status: typeof latestEnded?.payload.status === "string" ? latestEnded.payload.status : null, ownership: typeof latestOwnership === "string" ? latestOwnership : null, signed_out: cleanup.signedOut, browser_closed: cleanup.browserClosed, browser_lease_released: leaseReleased.length > 0, complete: cleanupComplete },
    deployed_identities: identities,
    outcome: { observations: observations.length, join: "uncertain", missing_product_field: "NativeTask.exchangeId", artifacts_verified: verifiedArtifacts.length, artifacts_mismatched: mismatched.length, artifacts_unavailable: artifactStates.filter((item) => item.artifact.status === "unavailable").length },
    corroboration: { webrtc_sender_stats: { status: "corroboration_only", samples: stats.length, issued_track_rows: issuedRows, max_packets_sent: maxPackets } },
    coverage: STUDIO_G7_RECEIPT_COVERAGE,
    summary: withheld.length === 0 ? `harness_pass_${harness.length}` : `harness_withheld:${withheld.slice(0, 32).join(",")}`,
  };
}

/** Harness: any fail fails; anything not proven (unavailable or uncertain) withholds. */
function harnessVerdictOf(assertions: StudioAssertion[]): Verdicts["harness"] {
  const counted = assertions.filter((assertion) => assertion.status === "pass" || assertion.status === "fail" || assertion.status === "unavailable" || assertion.status === "uncertain");
  if (counted.some((assertion) => assertion.status === "fail")) return "fail";
  if (counted.length === 0) return "unavailable";
  return counted.every((assertion) => assertion.status === "pass") ? "pass" : "unavailable";
}

/** Product: any fail fails; all-unavailable is unavailable; any uncertain or unavailable is inconclusive. */
function productVerdictOf(assertions: StudioAssertion[]): Verdicts["product"] {
  const counted = assertions.filter((assertion) => assertion.status === "pass" || assertion.status === "fail" || assertion.status === "unavailable" || assertion.status === "uncertain");
  if (counted.some((assertion) => assertion.status === "fail")) return "fail";
  if (counted.length === 0 || counted.every((assertion) => assertion.status === "unavailable")) return "unavailable";
  return counted.every((assertion) => assertion.status === "pass") ? "pass" : "inconclusive";
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * Map the evaluation onto the Lab's five verdicts. Harness and product stay
 * independent; evidence passes only with a passing harness and complete,
 * proven cleanup.
 */
export function deriveStudioG7Verdicts(evaluation: StudioG7Evaluation, auth: { sessionEstablished: boolean }): Verdicts {
  const harness = evaluation.verdicts.harness;
  return {
    harness,
    product: evaluation.verdicts.product,
    provider: evaluation.verdicts.provider,
    auth: !auth.sessionEstablished ? "fail" : evaluation.cleanup.signed_out ? "pass" : "fail",
    evidence: harness === "pass" && evaluation.cleanup.complete ? "pass" : harness === "unavailable" ? "unavailable" : "fail",
  };
}

/**
 * The Studio cleanup proof used by the worker's zero-orphan gate.
 *
 * - Exchange: some confirmed `studio.cleanup.exchange_ended` (an exchange
 *   that has ended never reopens). It is confirmed only by the member
 *   snapshot showing the run's joined exchange (or, with no join, any
 *   exchange) not live, or after an ownership-proven End. An `uncertain` or
 *   `unavailable` settlement is never confirmation.
 * - Sign-out: a confirmed global sign-out.
 * - Browser: a proven close, or a proof that none was ever allocated.
 */
export function studioG7CleanupProof(events: Event[]): { exchangeEnded: boolean; signedOut: boolean; browserClosed: boolean; browserQuiesced: boolean; refreshSessionsRevoked: boolean; complete: boolean } {
  // A run that never acquired a browser (e.g. deployment mismatch before
  // launch) never authenticated and never opened an exchange: the worker's
  // authoritative ledger read is the whole proof.
  const allocationFree = events.some((event) => event.kind === "cleanup.browser_context_absent" && event.payload.browser_never_allocated === true && event.payload.authoritative_ledger_read === true)
    && !events.some((event) => event.kind === "harness.browser_process_acquired" || event.kind === "studio.auth.session_established" || event.kind === "studio.exchange.opened" || event.kind === "studio.exchange.speak_requested");
  if (allocationFree) return { exchangeEnded: true, signedOut: true, browserClosed: true, browserQuiesced: false, refreshSessionsRevoked: true, complete: true };
  // A confirmed end counts only after the run's exchange join (or Speak
  // intent): an earlier settle cannot speak for an exchange opened later.
  const exchangeEnded = studioExchangeEndAfterJoin(events) !== null;
  const signedOut = events.some((event) => event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.payload.confirmed === true);
  const browserClosed = events.some((event) => event.kind === "cleanup.browser_context_closed" && event.source === "browser" && event.payload.close_resolved === true && event.payload.browser_registry_absent === true)
    || events.some((event) => event.kind === "cleanup.browser_context_absent" && event.payload.browser_never_allocated === true);
  // A dead foreign worker's browser cannot be proven closed; its lease is
  // released only once that browser can no longer act on the product
  // (lease-release.ts). Typed `quiesced`, never `closed`.
  const browserQuiesced = events.some((event) => event.kind === "cleanup.browser_lease_released" && event.payload.schema === STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA && event.payload.dead_owner_quiesced === true && event.payload.cas_deleted === true);
  // An evidence-refresh session whose local revoke failed stays valid on the
  // server until a later confirmed global sign-out revokes it.
  const refreshSessionsRevoked = events
    .filter((event) => event.kind === "studio.evidence.session_revoked" && event.source === "canonical" && event.payload.confirmed !== true)
    .every((unrevoked) => events.some((event) => event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.payload.confirmed === true && event.payload.scope === "global" && event.seq > unrevoked.seq));
  return { exchangeEnded, signedOut, browserClosed, browserQuiesced, refreshSessionsRevoked, complete: exchangeEnded && signedOut && (browserClosed || browserQuiesced) && refreshSessionsRevoked };
}

/**
 * The durable exchange join of a run, from its write-ahead events, for a
 * restarted worker. Null when the run never durably requested Speak.
 */
export function studioDurableJoin(events: Event[], runBindingSha256: string): { exchangeId: string | null; grantId: string | null; runBindingSha256: string; speakRequested: boolean; exchangeOpenedAtMs: number | null; speakRequestedAtMs: number | null } | null {
  const opened = [...events].reverse().find((event) => event.kind === "studio.exchange.opened" && event.source === "canonical" && typeof event.payload.exchange_id === "string") ?? null;
  const intent = [...events].reverse().find((event) => event.kind === "studio.exchange.speak_requested" && event.source === "canonical") ?? null;
  const gate = [...events].reverse().find((event) => event.kind === "studio.grant_gate.passed" && typeof event.payload.grant_id === "string") ?? null;
  if (!opened && !intent) return null;
  const grantId = typeof opened?.payload.grant_id === "string" ? opened.payload.grant_id : typeof intent?.payload.grant_id === "string" ? intent.payload.grant_id : typeof gate?.payload.grant_id === "string" ? gate.payload.grant_id : null;
  return {
    exchangeId: opened ? String(opened.payload.exchange_id) : null,
    grantId,
    runBindingSha256,
    speakRequested: true,
    exchangeOpenedAtMs: typeof opened?.payload.opened_at_lab_ms === "number" ? opened.payload.opened_at_lab_ms : opened ? opened.at.getTime() : null,
    speakRequestedAtMs: typeof intent?.payload.requested_at_lab_ms === "number" ? intent.payload.requested_at_lab_ms : intent ? intent.at.getTime() : null,
  };
}
