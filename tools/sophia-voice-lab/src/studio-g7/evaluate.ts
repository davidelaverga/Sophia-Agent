import { createHash } from "node:crypto";

import type { LabEvent, OperationRecord, RunRecord, Verdicts } from "../domain.js";
import {
  STUDIO_G7_CONTRACT_VERSION,
  STUDIO_LIVE_DESIGN_STATES,
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
import { STUDIO_CALLS_END_STEP, STUDIO_CALLS_READ_KIND, STUDIO_VOICE_STEP_COMMAND_KIND, certifyStudioVoiceSteps, studioStepOwnCalls, type StudioStepCertification } from "./calls-certification.js";
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

/** The run's joined exchange (its write-ahead join), lowercased; null without one. */
function runExchangeIdOf(join: Event | null): string | null {
  return typeof join?.payload.exchange_id === "string" ? join.payload.exchange_id.toLowerCase() : null;
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
  cleanup: { required: true; guard_reason: string | null; exchange_ended: boolean; exchange_status: string | null; ownership: string | null; signed_out: boolean; browser_closed: boolean; browser_lease_released: boolean; room_presence: string | null; complete: boolean };
  deployed_identities: Record<string, { expected: string | null; observed: string[]; status: "verified" | "mismatch" | "unavailable" }>;
  outcome: { observations: number; join: "exchange_calls" | "uncertain"; bound_tasks: number; own_report: { status: "resolved" | "unavailable" | "uncertain"; reason: string | null; create_task_id: string | null; design_task_id: string | null; artifact_id: string | null }; missing_product_field: "ExchangeCalls" | null; voice_steps: StudioStepCertification[]; unattributed_call_seqs: number[]; artifacts_verified: number; artifacts_mismatched: number; artifacts_unavailable: number };
  corroboration: { webrtc_sender_stats: { status: "corroboration_only"; samples: number; issued_track_rows: number; max_packets_sent: number | null } };
  coverage: typeof STUDIO_G7_RECEIPT_COVERAGE;
  summary: string;
}

export interface StudioEvaluationOptions {
  expected: { studio: string; api: string; bridge: string };
  /**
   * A mid-run evaluation: the worker's hand-over of the certified create
   * before an action or End, while the latest input window's own input_turn
   * may still be in flight. Never set for a run's own (final) evaluation,
   * whether or not its session_closed arrived.
   */
  midRun?: boolean;
}

/** Explicit limitations every Studio G7 evaluation carries. */
export const STUDIO_G7_LIMITATIONS = Object.freeze([
  "no_transcript_retained",
  "no_audio_retained",
  "pcm_reconciliation_envelope_only",
  "fake_studio_loopback_peer_has_no_packet_flow_proof",
  "voice_steps_certified_only_from_exchange_calls_requires_voice_qualification",
  "steer_effect_beyond_admitted_command_not_exposed",
  "goal_status_is_the_created_task_phase",
  "orphan_browser_room_presence_only_from_fresh_bridge_report",
  "orphan_browser_process_close_unobservable",
]);


type BridgeItem = BoundBridgeReceipt<Record<string, unknown>> & { sha: string };
type GrantItem = { event: Event; grant: EvidenceGrant; exchangeState: string | null };
type NonSilenceInput = { operation: OperationRecord; durationMs: number | null; startedAt: number | null };
type Verdict = [StudioAssertionStatus, string | null];
type OwnReport = { status: "resolved"; designTaskId: string; artifactId: string } | { status: "unavailable" | "uncertain"; reason: string };
type ArtifactState = { event: Event; artifact: Record<string, unknown> };

/** One evaluation: the run, its ledger in seq order, and the assertions as they are made (their order is part of the result). */
interface EvalContext {
  run: RunRecord;
  operations: OperationRecord[];
  options: StudioEvaluationOptions;
  ordered: Event[];
  expectedBinding: string;
  ended: boolean;
  harness: StudioAssertion[];
  product: StudioAssertion[];
}

function pushAssertion(target: StudioAssertion[], id: string, owner: StudioAssertion["owner"], status: StudioAssertionStatus, reason: string | null, evidence: Event[]): void {
  target.push({ id, owner, status, reason, evidence_seqs: [...new Set(evidence.map((event) => event.seq))].sort((a, b) => a - b) });
}

/** A harness assertion. */
function H(ctx: EvalContext, id: string, status: StudioAssertionStatus, reason: string | null, evidence: Event[] = []): void {
  pushAssertion(ctx.harness, id, "harness", status, reason, evidence);
}

/** A product assertion. */
function P(ctx: EvalContext, id: string, status: StudioAssertionStatus, reason: string | null, evidence: Event[] = []): void {
  pushAssertion(ctx.product, id, "product", status, reason, evidence);
}

function ofKind(ctx: EvalContext, kind: string, source?: Event["source"]): Event[] {
  return ctx.ordered.filter((event) => event.kind === kind && (source === undefined || event.source === source));
}

function tasksOf(event: Event): Array<Record<string, unknown>> {
  return (Array.isArray(event.payload.tasks) ? event.payload.tasks as unknown[] : []).map((value) => record(value) ?? {});
}

// ---------------------------------------------------------------- binding

interface BindingFacts {
  grantIds: Set<string>;
  bindingMismatches: Event[];
  pageReceipts: BoundPageReceipt[];
  pageViolations: Event[];
  grants: GrantItem[];
  bridgeViolations: Event[];
  bridgeRaw: BridgeItem[];
}

function bindPageReceipts(ctx: EvalContext, facts: BindingFacts): void {
  for (const event of ofKind(ctx, "studio.page_receipt", "product")) {
    const raw = stringField(event.payload, "receipt_json");
    let receipt: StudioPageReceipt;
    try { receipt = parsePageReceipt(raw === null ? null : JSON.parse(raw)); }
    catch { facts.pageViolations.push(event); continue; }
    if (event.payload.receipt_sha256 !== undefined && sha256(raw!) !== event.payload.receipt_sha256) { facts.pageViolations.push(event); continue; }
    if (receipt.runBindingSha256 !== ctx.expectedBinding) { facts.bindingMismatches.push(event); continue; }
    facts.grantIds.add(receipt.grantId.toLowerCase());
    facts.pageReceipts.push({ event, receipt });
  }
}

function bindGrants(ctx: EvalContext, facts: BindingFacts): void {
  for (const event of ofKind(ctx, "studio.bridge_grant", "canonical")) {
    const raw = stringField(event.payload, "grant_json");
    const parsed = EvidenceGrantSchema.safeParse(raw === null ? null : safeJson(raw));
    if (!parsed.success) { facts.bridgeViolations.push(event); continue; }
    if (parsed.data.runBindingSha256 !== ctx.expectedBinding) { facts.bindingMismatches.push(event); continue; }
    facts.grantIds.add(parsed.data.grantId.toLowerCase());
    facts.grants.push({ event, grant: parsed.data, exchangeState: typeof event.payload.exchange_state === "string" ? event.payload.exchange_state : null });
  }
}

/** A bridge receipt event's envelope (raw body, kind, seq, source), or null when it is malformed. */
function bridgeEnvelope(event: Event): { raw: string; kind: BridgeReceiptKind; seq: number; source: EvidenceSource } | null {
  const raw = stringField(event.payload, "receipt_json");
  const kind = event.payload.kind;
  const seq = event.payload.seq;
  const source = event.payload.source ?? (typeof kind === "string" && (BRIDGE_RECEIPT_KINDS as readonly string[]).includes(kind) ? sourceOfKind(kind as BridgeReceiptKind) : null);
  if (raw === null || typeof kind !== "string" || !(BRIDGE_RECEIPT_KINDS as readonly string[]).includes(kind) || !Number.isSafeInteger(seq)
    || typeof source !== "string" || !(EVIDENCE_SOURCES as readonly string[]).includes(source)
    || (event.payload.receipt_sha256 !== undefined && sha256(raw) !== event.payload.receipt_sha256)) return null;
  return { raw, kind: kind as BridgeReceiptKind, seq: Number(seq), source: source as EvidenceSource };
}

function bindBridgeReceipts(ctx: EvalContext, facts: BindingFacts): void {
  for (const event of ofKind(ctx, "studio.bridge_receipt", "canonical")) {
    const envelope = bridgeEnvelope(event);
    if (envelope === null) { facts.bridgeViolations.push(event); continue; }
    let receipt;
    try { receipt = parseBridgeReceipt(envelope.kind, envelope.seq, safeJson(envelope.raw), envelope.source); }
    catch (error) { if (error instanceof StudioContractViolation) { facts.bridgeViolations.push(event); continue; } throw error; }
    if (receipt.runBindingSha256 !== ctx.expectedBinding) { facts.bindingMismatches.push(event); continue; }
    facts.grantIds.add(receipt.grantId.toLowerCase());
    facts.bridgeRaw.push({ event, source: envelope.source, seq: envelope.seq, kind: envelope.kind, receipt: receipt as unknown as Record<string, unknown>, sha: sha256(envelope.raw) });
  }
}

/** Every product receipt bound to the run (page receipts, grants, bridge receipts), and the binding and contract assertions. */
function assertBinding(ctx: EvalContext): BindingFacts & { grantId: string | null } {
  const facts: BindingFacts = { grantIds: new Set<string>(), bindingMismatches: [], pageReceipts: [], pageViolations: [...ofKind(ctx, "studio.page_receipt_rejected")], grants: [], bridgeViolations: [...ofKind(ctx, "studio.bridge_evidence_rejected")], bridgeRaw: [] };
  bindPageReceipts(ctx, facts);
  bindGrants(ctx, facts);
  bindBridgeReceipts(ctx, facts);
  const { grantIds, bindingMismatches, pageReceipts, pageViolations, bridgeViolations, bridgeRaw } = facts;
  const grantId = grantIds.size === 1 ? [...grantIds][0]! : null;
  if (bindingMismatches.length > 0) H(ctx, "binding.run_binding", "fail", "receipt_run_binding_mismatch", bindingMismatches);
  else if (grantIds.size > 1) H(ctx, "binding.run_binding", "fail", "multiple_grant_ids_observed", [...pageReceipts.map((item) => item.event), ...bridgeRaw.map((item) => item.event)]);
  else if (grantIds.size === 0) H(ctx, "binding.run_binding", "unavailable", "no_bound_product_receipt", []);
  else H(ctx, "binding.run_binding", "pass", null, [...pageReceipts.map((item) => item.event), ...bridgeRaw.map((item) => item.event)]);
  P(ctx, "contract.page_receipts_valid", pageViolations.length > 0 ? "fail" : pageReceipts.length > 0 ? "pass" : "unavailable", pageViolations.length > 0 ? "page_receipt_contract_violation" : pageReceipts.length > 0 ? null : "no_page_receipt", pageViolations);
  P(ctx, "contract.bridge_evidence_valid", bridgeViolations.length > 0 ? "fail" : bridgeRaw.length > 0 ? "pass" : "unavailable", bridgeViolations.length > 0 ? "bridge_evidence_contract_violation" : bridgeRaw.length > 0 ? null : "no_bridge_receipt", bridgeViolations);
  return { ...facts, grantId };
}

// ---------------------------------------------- exchange ownership (cleanup)

interface OwnershipFacts { ownershipEvents: Event[]; ownershipMismatch: Event[]; ownershipProven: Event[]; exchangeJoin: Event | null }

function assertOwnership(ctx: EvalContext): OwnershipFacts {
  const ownershipEvents = ofKind(ctx, "studio.exchange.ownership", "canonical");
  const ownershipMismatch = ownershipEvents.filter((event) => event.payload.status === "mismatch");
  const ownershipProven = ownershipEvents.filter((event) => event.payload.status === "proven");
  const exchangeJoin = ofKind(ctx, "studio.exchange.opened", "canonical").at(-1) ?? null;
  if (ownershipMismatch.length > 0) H(ctx, "binding.exchange_ownership", "fail", String(ownershipMismatch[0]!.payload.reason ?? "exchange_bound_to_another_run"), ownershipMismatch);
  else if (exchangeJoin === null) H(ctx, "binding.exchange_ownership", "unavailable", "no_exchange_joined_to_run");
  else if (ownershipProven.length > 0) H(ctx, "binding.exchange_ownership", "pass", null, [exchangeJoin, ...ownershipProven]);
  else H(ctx, "binding.exchange_ownership", "unavailable", typeof ownershipEvents.at(-1)?.payload.reason === "string" ? String(ownershipEvents.at(-1)!.payload.reason) : "ownership_not_proven", [exchangeJoin, ...ownershipEvents]);
  return { ownershipEvents, ownershipMismatch, ownershipProven, exchangeJoin };
}

// ------------------------------------------- bridge (source, seq) discipline

interface BridgeFacts { bridge: BridgeItem[]; conflictingSeqs: string[]; duplicateCount: number; firstSeq: number | null; maxSeq: number | null; missingSeqs: number[] }

/** The bridge's seqs from its first (0 when observed, else 1) to its highest, that no receipt holds (at most 1 000). */
function missingBridgeSeqs(bridgeSeqs: number[], firstSeq: number | null, maxSeq: number | null): number[] {
  const presentSeqs = new Set(bridgeSeqs);
  const missingSeqs: number[] = [];
  if (maxSeq !== null && firstSeq !== null) for (let seq = firstSeq; seq <= maxSeq && missingSeqs.length < 1_000; seq += 1) if (!presentSeqs.has(seq)) missingSeqs.push(seq);
  return missingSeqs;
}

function assertBridgeDiscipline(ctx: EvalContext, bridgeRaw: BridgeItem[]): BridgeFacts {
  const bySeq = new Map<string, BridgeItem[]>();
  for (const item of bridgeRaw) bySeq.set(`${item.source}:${item.seq}`, [...(bySeq.get(`${item.source}:${item.seq}`) ?? []), item]);
  const conflictingSeqs: string[] = [];
  const bridge: BridgeItem[] = [];
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
  const missingSeqs = missingBridgeSeqs(bridgeSeqs, firstSeq, maxSeq);
  if (conflictingSeqs.length > 0) H(ctx, "bridge.seq_integrity", "fail", "bridge_seq_conflict", bridgeRaw.filter((item) => conflictingSeqs.includes(`${item.source}:${item.seq}`)).map((item) => item.event));
  else H(ctx, "bridge.seq_integrity", bridge.length === 0 ? "unavailable" : "pass", bridge.length === 0 ? "no_bridge_receipt" : null, bridge.map((item) => item.event));
  return { bridge, conflictingSeqs, duplicateCount, firstSeq, maxSeq, missingSeqs };
}

function bridgeOfKind<T>(bridge: BridgeItem[], kind: BridgeReceiptKind): Array<BoundBridgeReceipt<T>> {
  return bridge.filter((item) => item.kind === kind) as unknown as Array<BoundBridgeReceipt<T>>;
}

/** The kinds of bridge receipt seen after session_closed (provider receipts aside). */
function kindsAfterSessionClosed(bridge: BridgeItem[], sessionClosed: BoundBridgeReceipt<SessionClosedReceipt> | null): string[] {
  return sessionClosed ? [...new Set(bridge.filter((item) => item.source === "bridge" && item.seq > sessionClosed.seq && item.kind !== "provider").map((item) => item.kind))] : [];
}

/**
 * Windows/replies are keyed by their own ordinals; a repeated ordinal with
 * a different body is a contract conflict.
 */
function uniqueByOrdinal<T>(ctx: EvalContext, items: Array<BoundBridgeReceipt<T>>, key: (receipt: T) => number, id: string): Array<BoundBridgeReceipt<T>> {
  const map = new Map<number, BoundBridgeReceipt<T>>();
  const conflicts: Event[] = [];
  for (const item of items) {
    const k = key(item.receipt);
    if (map.has(k)) conflicts.push(item.event, map.get(k)!.event);
    else map.set(k, item);
  }
  if (conflicts.length > 0) P(ctx, id, "fail", "bridge_ordinal_conflict", conflicts);
  return [...map.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
}

function bridgeReceiptsDropped(missingSeqs: number[], sessionClosed: BoundBridgeReceipt<SessionClosedReceipt> | null, counts: { windows: number; turns: number; replies: number }): boolean {
  return missingSeqs.length > 0 || (sessionClosed !== null && (sessionClosed.receipt.windows > counts.windows || sessionClosed.receipt.turns > counts.turns || sessionClosed.receipt.replies > counts.replies));
}

// ------------------------------------------------------------- utterances

interface InputFacts { inputs: OperationRecord[]; issuedHashes: Set<string>; micEvents: BoundPageReceipt[]; publishedLab: BoundPageReceipt[]; nonSilence: NonSilenceInput[]; utterances: Array<Record<string, unknown>> }

/** R2: the mic the Studio published at utterance start is the Lab-issued track (and stayed published through it). */
function utteranceR2(startAt: number | null, endAt: number | null, micEvents: BoundPageReceipt[], issuedHashes: Set<string>): [StudioAssertionStatus, string | null, Event[]] {
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
  return [r2, r2Reason, r2Evidence];
}

/** One input's R1 (scheduling), R3 (playout) and R2 (published track) chains; a non-silence input joins the window ordinals. */
function assertUtterance(ctx: EvalContext, operation: OperationRecord, index: number, facts: InputFacts): void {
  const byOp = (kind: string) => ctx.ordered.filter((event) => event.kind === kind && event.payload.operation_id === operation.id);
  const resolved = byOp("utterance.resolved");
  const scheduled = byOp("audio.input.scheduled");
  const started = byOp("audio.input.started");
  const completed = byOp("audio.input.completed");
  const interrupted = [...byOp("audio.input.interrupted"), ...byOp("audio.input.rejected")];
  const id = `input.${index + 1}`;
  const r1Evidence = [...resolved, ...scheduled];
  if (r1Evidence.length === 0) H(ctx, `${id}.r1_scheduling_chain`, "unavailable", "lab_scheduling_receipts_missing");
  else H(ctx, `${id}.r1_scheduling_chain`, resolved.length === 1 && scheduled.length === 1 && operation.result?.schedule_receipt !== undefined ? "pass" : "fail", resolved.length === 1 && scheduled.length === 1 ? null : "lab_scheduling_chain_not_exact", r1Evidence);
  const r3Evidence = [...started, ...completed, ...interrupted];
  if (r3Evidence.length === 0) H(ctx, `${id}.r3_playout_chain`, "unavailable", "lab_playout_receipts_missing");
  else H(ctx, `${id}.r3_playout_chain`, started.length === 1 && completed.length === 1 && interrupted.length === 0 ? "pass" : "fail", interrupted.length > 0 ? "lab_input_interrupted_or_rejected" : started.length === 1 && completed.length === 1 ? null : "lab_playout_chain_not_exact", r3Evidence);
  const startAt = started[0] ? observedAtMs(started[0]) : null;
  const endAt = completed[0] ? observedAtMs(completed[0]) : null;
  const [r2, r2Reason, r2Evidence] = utteranceR2(startAt, endAt, facts.micEvents, facts.issuedHashes);
  H(ctx, `${id}.r2_published_track_identity`, r2, r2Reason, r2Evidence);
  const wav = resolved[0]?.payload.wav as Record<string, unknown> | undefined;
  const durationMs = typeof wav?.duration_ms === "number" ? wav.duration_ms : null;
  const silence = String(operation.input.fixture_id ?? "").toLowerCase().includes("silence");
  if (!silence) facts.nonSilence.push({ operation, durationMs, startedAt: startAt });
  else H(ctx, `${id}.silence_ordinal_join`, "unavailable", "silence_not_joinable_by_window_ordinal_on_this_transport");
  facts.utterances.push({ ordinal: index + 1, operation_id: operation.id, g7_step: typeof operation.input._g7_step === "string" ? operation.input._g7_step : null, silence, duration_ms: durationMs, r2 });
}

function assertInputs(ctx: EvalContext, pageReceipts: BoundPageReceipt[]): InputFacts {
  const inputs = ctx.operations
    .filter((operation) => (operation.type === "speak" || operation.type === "barge_in") && operation.state === "succeeded")
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  const issued = ofKind(ctx, "harness.media_stream_issued", "browser").filter((event) => event.payload.replacement_active === true);
  const issuedHashes = new Set(issued.flatMap((event) => Array.isArray(event.payload.track_id_sha256s) ? (event.payload.track_id_sha256s as unknown[]).filter((value): value is string => typeof value === "string") : []));
  const micEvents = pageReceipts.filter((item) => item.receipt.event === "mic_published" || item.receipt.event === "mic_unpublished")
    .sort((left, right) => left.receipt.atMs - right.receipt.atMs || left.event.seq - right.event.seq);
  const publishedForeign = micEvents.filter((item) => item.receipt.event === "mic_published" && !issuedHashes.has(sha256(item.receipt.trackId)));
  const publishedLab = micEvents.filter((item) => item.receipt.event === "mic_published" && issuedHashes.has(sha256(item.receipt.trackId)));
  if (publishedForeign.length > 0) H(ctx, "input.published_track_is_lab_issued", "fail", "published_track_not_lab_issued", publishedForeign.map((item) => item.event));
  else if (publishedLab.length === 0) H(ctx, "input.published_track_is_lab_issued", "unavailable", issued.length === 0 ? "lab_issuance_receipt_missing" : "mic_published_receipt_missing", issued);
  else H(ctx, "input.published_track_is_lab_issued", "pass", null, [...publishedLab.map((item) => item.event), ...issued]);
  const facts: InputFacts = { inputs, issuedHashes, micEvents, publishedLab, nonSilence: [], utterances: [] };
  inputs.forEach((operation, index) => assertUtterance(ctx, operation, index, facts));
  return facts;
}

// ------------------------------------------- input windows (envelope only)

interface WindowJoin { joinable: boolean; joinConsistent: boolean; epochJoinable: boolean }
interface WindowFacts { windows: Array<BoundBridgeReceipt<InputWindowReceipt>>; turnsAll: Array<BoundBridgeReceipt<InputTurnReceipt>>; bridge: BridgeItem[]; sessionClosed: BoundBridgeReceipt<SessionClosedReceipt> | null; receiptsDropped: boolean; exchangeJoin: Event | null }

function assertWindowJoin(ctx: EvalContext, nonSilence: NonSilenceInput[], facts: WindowFacts): void {
  const { windows, receiptsDropped, sessionClosed } = facts;
  if (nonSilence.length === 0) {
    H(ctx, "input.window_join", "unavailable", "no_non_silence_utterance");
  } else if (windows.length === 0) {
    H(ctx, "input.window_join", "unavailable", "no_input_window_receipt");
  } else if (receiptsDropped || sessionClosed === null) {
    H(ctx, "input.window_join", "unavailable", sessionClosed === null ? "session_closed_receipt_missing" : "bridge_receipts_dropped", windows.map((item) => item.event));
  } else if (windows.length !== nonSilence.length) {
    H(ctx, "input.window_join", "fail", "input_window_count_mismatch", windows.map((item) => item.event));
  } else {
    H(ctx, "input.window_join", "pass", null, windows.map((item) => item.event));
  }
}

/**
 * Mid-run only (the worker's hand-over, before session_closed): the one
 * window whose own input_turn may still be in flight, the highest windowSeq
 * seen, without its turn, with no later input receipt.
 */
function turnInFlight(options: StudioEvaluationOptions, windowSeq: number, facts: WindowFacts): boolean {
  const latestWindow = facts.windows.at(-1) ?? null;
  return options.midRun === true && facts.sessionClosed === null && latestWindow !== null && latestWindow.receipt.windowSeq === windowSeq
    && !facts.turnsAll.some((item) => item.receipt.windowSeq === windowSeq)
    && !facts.bridge.some((item) => item.source === "bridge" && (item.kind === "input_window" || item.kind === "input_turn") && item.seq > latestWindow.seq);
}

/** A window's turn shows no more tool calls than its step's own calls read lists, and at least one when that read holds a command. */
function toolCallsWithinStep(ctx: EvalContext, entry: NonSilenceInput, index: number, ownCalls: Map<string, { calls: number; commandBearing: boolean } | null>, facts: WindowFacts): boolean {
  const own = ownCalls.get(entry.operation.id) ?? null;
  if (own === null) return true;
  if (turnInFlight(ctx.options, index + 1, facts)) return true;
  const shown = facts.turnsAll.filter((item) => item.receipt.windowSeq === index + 1).reduce((sum, item) => sum + item.receipt.toolCallCount, 0);
  return shown <= own.calls && (!own.commandBearing || shown >= 1);
}

/**
 * The ordinal join's cross-checks (labrev6 P3-1): a count-preserving pair
 * (one extra window before a step, one missing after it) keeps the windows
 * exactly 1..k, so counts alone cannot see the shift. Each joined window
 * must also be one the provider's own turn completed (a pause, a handoff,
 * a barge-in, a cut or a close splits or cuts an utterance), and its turn
 * must have shown no more tool calls than the step's own calls read lists,
 * and at least one when that read holds a command-bearing call. A normal
 * run satisfies both: each step waits for the previous reply to end, so
 * its window ends turn_complete; every call the provider shows while the
 * window is open reaches the API and is recorded after the step's baseline
 * (so listed in its own read), and the step's command comes from the
 * generation answering it while its window is open. Exact equality is not
 * required: a tool continuation generated after the turn completed is not
 * in the window's count, so a normal run can show fewer calls than its read
 * lists.
 * NOT tolerated (a known false negative, labrev7 Nit-2): a call refused
 * before it is recorded (by the bridge, or by the API as not_declared) is
 * counted in the turn but never listed, so its window shows more calls
 * than its read. The Lab cannot tell that from a shifted window (both show
 * more than the step's own calls), and a shift displaces every step from an
 * unknown point on, so the whole join is refused, never only that step's.
 * The bridge and API tool surfaces agree in a normal G7 flow.
 * Residual (labrev7 Nit-1, pinned by tests): a count-preserving shift stays
 * unseen whenever every displaced window shows a count within its new
 * step's bounds: from 1 to that step's own listed calls (0 to them for a
 * step with no command), e.g. a fragment turn showing exactly one call
 * landing on a single-call step, or one call on a step with two.
 * Mid-run only (the worker's hand-over, before session_closed), the one
 * window whose own input_turn may still be in flight is not checked: the
 * highest windowSeq seen, without its turn, with no later input receipt
 * (the bridge sends each turn right after its window, in seq order). An
 * earlier window without its turn lost it (a later input receipt came), so
 * it is checked like any other; a run's own evaluation never skips, even
 * without session_closed (labrev7 Nit-3, labrev8 Nit 1).
 */
function windowJoinChecks(ctx: EvalContext, nonSilence: NonSilenceInput[], facts: WindowFacts): WindowJoin {
  const { windows, sessionClosed, receiptsDropped } = facts;
  const joinable = !receiptsDropped && sessionClosed !== null && windows.length === nonSilence.length;
  const windowSeqsSeen = windows.map((item) => item.receipt.windowSeq).sort((left, right) => left - right);
  const ownCalls = studioStepOwnCalls(ctx.ordered, nonSilence.map((entry) => ({ operationId: entry.operation.id })), runExchangeIdOf(facts.exchangeJoin));
  const windowsTurnComplete = windows.every((item) => item.receipt.endReason === "turn_complete");
  const toolCallsConsistent = nonSilence.every((entry, index) => toolCallsWithinStep(ctx, entry, index, ownCalls, facts));
  const joinConsistent = windowsTurnComplete && toolCallsConsistent;
  const epochJoinable = windowSeqsSeen.length === nonSilence.length && windowSeqsSeen.every((seq, index) => seq === index + 1) && (sessionClosed === null || joinable) && joinConsistent;
  return { joinable, joinConsistent, epochJoinable };
}

function windowEnvelope(durationMs: number | null, w: InputWindowReceipt): { status: StudioAssertionStatus; reason: string | null } {
  const minSamples = durationMs === null ? null : Math.floor(durationMs * 16 * INPUT_WINDOW_DURATION_FLOOR);
  const audible = w.nonzeroSampleCount > 0 && w.audibleChunkCount > 0 && w.rms > 0 && w.peak > 0;
  const longEnough = minSamples !== null && w.sampleCount >= minSamples && w.endedAtMs >= w.startedAtMs && (w.endedAtMs - w.startedAtMs) >= Math.floor(durationMs! * INPUT_WINDOW_DURATION_FLOOR);
  const status: StudioAssertionStatus = minSamples === null ? "unavailable" : audible && longEnough ? "pass" : "fail";
  return { status, reason: minSamples === null ? "utterance_duration_unavailable" : !audible ? "window_not_audible" : !longEnough ? "window_shorter_than_utterance_envelope" : null };
}

function assertTurnAccepted(ctx: EvalContext, id: string, window: BoundBridgeReceipt<InputWindowReceipt>, turn: BoundBridgeReceipt<InputTurnReceipt> | undefined): void {
  if (!turn) { P(ctx, `${id}.turn_accepted`, "fail", "no_input_turn_for_window", [window.event]); return; }
  const t = turn.receipt;
  const accepted = t.inputTranscriptionObserved && t.finished && t.attributedToHolder && t.outcome === "answered";
  P(ctx, `${id}.turn_accepted`, accepted ? "pass" : "fail", accepted ? null : !t.attributedToHolder ? "turn_not_attributed_to_holder" : !t.inputTranscriptionObserved ? "input_transcription_not_observed" : `turn_outcome_${t.outcome}`, [window.event, turn.event]);
}

function assertUtteranceWindow(ctx: EvalContext, entry: NonSilenceInput, index: number, utterances: Array<Record<string, unknown>>, facts: WindowFacts, join: WindowJoin): void {
  const id = `input.${index + 1}`;
  const window = facts.windows[index];
  const utterance = utterances.find((candidate) => candidate.operation_id === entry.operation.id)!;
  if (!join.joinable || !window || !join.joinConsistent) {
    const reason = join.joinable && window ? "ordinal_join_inconsistent" : "ordinal_join_unavailable";
    P(ctx, `${id}.window_envelope`, "unavailable", reason);
    P(ctx, `${id}.turn_accepted`, "unavailable", reason);
    utterance.bridge_window = null;
    return;
  }
  const w = window.receipt;
  const envelope = windowEnvelope(entry.durationMs, w);
  P(ctx, `${id}.window_envelope`, envelope.status, envelope.reason, [window.event]);
  const turns = facts.turnsAll.filter((item) => item.receipt.windowSeq === w.windowSeq);
  const turn = turns.at(-1);
  assertTurnAccepted(ctx, id, window, turn);
  utterance.bridge_window = {
    window_seq: w.windowSeq, input_epoch: w.inputEpoch, connection: w.connection, end_reason: w.endReason,
    chunk_count: w.chunkCount, sample_count: w.sampleCount, nonzero_sample_count: w.nonzeroSampleCount, audible_chunk_count: w.audibleChunkCount,
    dropped_samples: w.droppedSamples, rms: w.rms, peak: w.peak, pcm_digest_algorithm: w.pcmDigestAlgorithm,
    // Recorded for provenance only. It is never compared with the Lab's chain.
    bridge_pcm_sha256_chain: w.pcmSha256Chain, pcm_chain_comparison: "unsupported",
    transcript_chars: turn?.receipt.transcriptChars ?? null, turn_outcome: turn?.receipt.outcome ?? null,
  };
}

// --------------------------------------------------------------- provider

function assertProvider(ctx: EvalContext, providers: Array<BoundBridgeReceipt<ProviderReceipt>>, sessionClosed: BoundBridgeReceipt<SessionClosedReceipt> | null): { providerVerdict: Verdicts["provider"]; bridgeCommits: string[] } {
  const ready = providers.filter((item) => item.receipt.phase === "ready");
  const unavailableProvider = providers.filter((item) => item.receipt.phase === "unavailable");
  const bridgeCommits = [...new Set(providers.map((item) => item.receipt.bridgeCommit).filter((value): value is string => value !== null))];
  const providerVerdict: Verdicts["provider"] = unavailableProvider.length > 0 ? "fail"
    : ready.length > 0 && sessionClosed?.receipt.providerClosed === true ? "pass"
      : providers.length === 0 && sessionClosed === null ? "unavailable" : "inconclusive";
  P(ctx, "provider.lifecycle", providers.length === 0 ? "unavailable" : unavailableProvider.length > 0 ? "fail" : ready.length > 0 ? "pass" : "fail", providers.length === 0 ? "no_provider_receipt" : unavailableProvider.length > 0 ? "provider_unavailable" : ready.length > 0 ? null : "provider_never_ready", providers.map((item) => item.event));
  return { providerVerdict, bridgeCommits };
}

// ---------------------------------------------------------------- output

function isAudibleReply(item: BoundBridgeReceipt<OutputReplyReceipt>): boolean {
  return item.receipt.terminal === "played" && item.receipt.nonSilentFramesPlayed > 0 && item.receipt.framesPlayed > 0 && item.receipt.firstPlayedAtMs !== null;
}

function isPlayingPhase(phase: string): boolean { return phase === "play" || phase === "playing"; }
function isStoppedPhase(phase: string): boolean { return phase === "pause" || phase === "ended" || phase === "emptied"; }

/**
 * Skew-symmetric join across the bridge and page clocks: the Sophia
 * element must have started playing no later than the reply (+tolerance),
 * and must not have stopped definitely before the reply began
 * (-tolerance). A stop after the reply is not evidence against it.
 */
function replyNotJoined(reply: BoundBridgeReceipt<OutputReplyReceipt>, playback: BoundPageReceipt[]): boolean {
  const at = reply.receipt.firstPlayedAtMs!;
  const lastPlaying = playback.filter((item) => item.receipt.event === "sophia_playback" && isPlayingPhase(item.receipt.phase) && item.receipt.atMs <= at + PLAYBACK_JOIN_CLOCK_TOLERANCE_MS).at(-1);
  if (!lastPlaying) return true;
  return playback.some((item) => item.receipt.event === "sophia_playback" && isStoppedPhase(item.receipt.phase) && item.receipt.atMs > lastPlaying.receipt.atMs && item.receipt.atMs < at - PLAYBACK_JOIN_CLOCK_TOLERANCE_MS);
}

function assertOutput(ctx: EvalContext, replies: Array<BoundBridgeReceipt<OutputReplyReceipt>>, turnsAll: Array<BoundBridgeReceipt<InputTurnReceipt>>, sessionClosed: BoundBridgeReceipt<SessionClosedReceipt> | null, receiptsDropped: boolean, pageReceipts: BoundPageReceipt[]): void {
  const audibleReplies = replies.filter(isAudibleReply);
  const closedWithoutReply = sessionClosed !== null && !receiptsDropped && sessionClosed.receipt.replies === 0;
  if (replies.length === 0) P(ctx, "output.audible_reply", closedWithoutReply && turnsAll.some((item) => item.receipt.modelResponded) ? "fail" : "unavailable", closedWithoutReply ? "model_responded_without_reply" : "no_output_reply_receipt");
  else P(ctx, "output.audible_reply", audibleReplies.length > 0 ? "pass" : "fail", audibleReplies.length > 0 ? null : "no_reply_played_audibly", replies.map((item) => item.event));
  const playback = pageReceipts.filter((item) => item.receipt.event === "sophia_playback").sort((left, right) => left.receipt.atMs - right.receipt.atMs || left.event.seq - right.event.seq);
  if (audibleReplies.length === 0) P(ctx, "output.page_playback_join", "unavailable", "no_audible_reply_to_join");
  else if (playback.length === 0) P(ctx, "output.page_playback_join", "unavailable", "no_sophia_playback_page_receipt");
  else {
    const unjoined = audibleReplies.filter((reply) => replyNotJoined(reply, playback));
    P(ctx, "output.page_playback_join", unjoined.length === 0 ? "pass" : "fail", unjoined.length === 0 ? null : "sophia_element_not_playing_at_reply", [...audibleReplies.map((item) => item.event), ...playback.map((item) => item.event)]);
  }
}

// ---------------------------------------------------- session and guard

function assertSessionAndGuard(ctx: EvalContext, sessionClosed: BoundBridgeReceipt<SessionClosedReceipt> | null, receiptsDropped: boolean, guards: Array<BoundBridgeReceipt<GuardReceipt>>, grants: GrantItem[]): string | null {
  if (sessionClosed === null) H(ctx, "session.closed_receipt", "unavailable", "session_closed_receipt_missing");
  else H(ctx, "session.closed_receipt", receiptsDropped ? "unavailable" : "pass", receiptsDropped ? "bridge_receipts_dropped" : null, [sessionClosed.event]);
  const guard = guards.at(-1) ?? null;
  const grantEnded = grants.map((item) => item.grant.endedReason).find((reason) => reason !== null) ?? null;
  const guardReason = guard?.receipt.reason ?? grantEnded ?? (sessionClosed?.receipt.reason === "guard" ? "unknown_guard" : null);
  if (guard || sessionClosed?.receipt.reason === "guard" || grantEnded) {
    // The server-side guard ended the exchange: the run exceeded its grant.
    // Cleanup is still mandatory and is evaluated below.
    H(ctx, "guard.not_triggered", "fail", `guard_${guardReason ?? "unknown"}`, [...(guard ? [guard.event] : []), ...(sessionClosed ? [sessionClosed.event] : [])]);
  } else if (sessionClosed !== null) {
    H(ctx, "guard.not_triggered", "pass", null, [sessionClosed.event]);
  } else {
    H(ctx, "guard.not_triggered", "unavailable", "session_outcome_unobserved");
  }
  return guardReason;
}

// ------------------------------------------------------------------ cleanup

function isLeaseReleaseProof(event: Event): boolean {
  return (event.kind === "cleanup.browser_lease_released" && event.payload.cas_deleted === true) || (event.kind === "cleanup.browser_lease_absent" && event.payload.authoritative_ledger_read === true);
}

function isFullBrowserClose(event: Event): boolean {
  return event.payload.close_resolved === true && event.payload.browser_registry_absent === true && event.payload.browser_process_close_resolved === true;
}

/** A dead owner's lease released as quiesced (whatever its compare-and-delete recorded). */
function isQuiescedReleaseRecord(event: Event): boolean {
  return event.kind === "cleanup.browser_lease_released" && event.payload.schema === STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA && event.payload.dead_owner_quiesced === true;
}

/**
 * A dead owner's orphan browser: its room presence, from the verification's
 * live-presence read (A15). Only a fresh report is evidence.
 */
function assertOrphanPresence(ctx: EvalContext): string | null {
  const quiescedRelease = ctx.ordered.filter(isQuiescedReleaseRecord).at(-1) ?? null;
  const roomPresence = quiescedRelease && typeof quiescedRelease.payload.room_presence === "string" ? quiescedRelease.payload.room_presence : null;
  if (quiescedRelease?.payload.presence_veto_capped === true) {
    // Released at the stuck-present cap: the last fresh reports placed the principal in the room.
    H(ctx, "cleanup.orphan_room_presence", "fail", "presence_veto_capped_principal_reported_present", [quiescedRelease]);
  } else if (quiescedRelease?.payload.presence_veto_expired === true) {
    // Released past the bounded veto: the last fresh report placed the principal in the room.
    H(ctx, "cleanup.orphan_room_presence", "uncertain", "presence_veto_expired_last_report_present", [quiescedRelease]);
  } else if (quiescedRelease) {
    H(ctx, "cleanup.orphan_room_presence", roomPresence === "absent" ? "pass" : roomPresence === "present" ? "fail" : "unavailable",
      roomPresence === "absent" ? null : roomPresence === "present" ? "principal_present_in_room" : `room_presence_unobservable_${String(quiescedRelease.payload.room_presence_reason ?? "unknown")}`, [quiescedRelease]);
  }
  return roomPresence;
}

interface CleanupFacts { cleanup: ReturnType<typeof studioG7CleanupProof>; latestEnded: Event | null; leaseReleased: Event[]; cleanupComplete: boolean; roomPresence: string | null }

function assertCleanup(ctx: EvalContext, labEndEvent: Event | null): CleanupFacts {
  const cleanup = studioG7CleanupProof(ctx.ordered);
  const endedEvents = ofKind(ctx, "studio.cleanup.exchange_ended", "canonical");
  const latestEnded = endedEvents.at(-1) ?? null;
  // Only a confirmed global sign-out signs the principal out (a withheld or local-only one never does).
  const signedOutEvents = ofKind(ctx, "studio.cleanup.signed_out", "canonical").filter((event) => event.payload.confirmed === true && event.payload.scope === "global");
  const browserClosed = ofKind(ctx, "cleanup.browser_context_closed", "browser").filter(isFullBrowserClose);
  const leaseReleased = ctx.ordered.filter(isLeaseReleaseProof);
  const cleanupComplete = cleanup.complete && leaseReleased.length > 0;
  H(ctx, "cleanup.exchange_ended", cleanup.exchangeEnded ? "pass" : latestEnded ? "unavailable" : "fail", cleanup.exchangeEnded ? null : latestEnded?.payload.confirmed === true ? "exchange_end_not_attributable_to_run_exchange" : latestEnded ? `exchange_${String(latestEnded.payload.status ?? "unconfirmed")}_${String(latestEnded.payload.basis ?? "unknown")}` : "exchange_end_not_verified", labEndEvent ? [labEndEvent] : endedEvents);
  H(ctx, "cleanup.principal_signed_out", signedOutEvents.length > 0 ? "pass" : "fail", signedOutEvents.length > 0 ? null : "global_sign_out_unconfirmed", signedOutEvents);
  // The evidence refresh revokes only its own session; one it could not revoke stays live until a later global sign-out.
  H(ctx, "cleanup.refresh_session_revoked", cleanup.refreshSessionsRevoked ? "pass" : "fail", cleanup.refreshSessionsRevoked ? null : "evidence_refresh_session_unrevoked", ofKind(ctx, "studio.evidence.session_revoked", "canonical"));
  H(ctx, "cleanup.browser_closed", cleanup.browserClosed ? "pass" : cleanup.browserQuiesced ? "unavailable" : "fail", cleanup.browserClosed ? null : cleanup.browserQuiesced ? "dead_owner_quiesced_close_unobservable" : "browser_close_unproven", browserClosed);
  H(ctx, "cleanup.browser_lease_released", leaseReleased.length > 0 ? "pass" : "fail", leaseReleased.length > 0 ? null : "browser_lease_release_unproven", leaseReleased);
  const roomPresence = assertOrphanPresence(ctx);
  return { cleanup, latestEnded, leaseReleased, cleanupComplete, roomPresence };
}

// ------------------------------------------------------ deployed identities

type IdentityStatus = "verified" | "mismatch" | "unavailable";

function componentIdentity(identityEvents: Event[], component: "api" | "studio", expected: string): { expected: string; observed: string[]; status: IdentityStatus } {
  const observations = identityEvents.map((event) => event.payload[component] as Record<string, unknown> | undefined).filter((value): value is Record<string, unknown> => !!value);
  const observed = [...new Set(observations.filter((value) => value.status === "observed" && typeof value.commit === "string").map((value) => String(value.commit)))];
  const status: IdentityStatus = observed.some((commit) => commit !== expected) ? "mismatch" : observed.length > 0 && observations.every((value) => value.status === "observed") ? "verified" : "unavailable";
  return { expected, observed, status };
}

function assertIdentities(ctx: EvalContext, bridgeCommits: string[], providers: Array<BoundBridgeReceipt<ProviderReceipt>>): StudioG7Evaluation["deployed_identities"] {
  const identityEvents = ofKind(ctx, "studio.deployment.identity", "canonical");
  const expected = ctx.options.expected;
  const identities = {
    api: componentIdentity(identityEvents, "api", expected.api),
    studio: componentIdentity(identityEvents, "studio", expected.studio),
    bridge: { expected: expected.bridge, observed: bridgeCommits, status: (bridgeCommits.some((commit) => commit !== expected.bridge) ? "mismatch" : bridgeCommits.length > 0 && providers.every((item) => item.receipt.bridgeCommit !== null) ? "verified" : "unavailable") as IdentityStatus },
  };
  for (const [component, value] of Object.entries(identities)) {
    H(ctx, `identity.${component}`, value.status === "verified" ? "pass" : value.status === "mismatch" ? "fail" : "unavailable", value.status === "verified" ? null : value.status === "mismatch" ? `${component}_commit_mismatch` : `${component}_identity_unavailable`, component === "bridge" ? providers.map((item) => item.event) : identityEvents);
  }
  return identities;
}

// ---------------------------------------------------------- outcome reads

function isRunExchangeEndBefore(event: Event, runExchangeId: string | null, seq: number): boolean {
  return event.kind === "studio.cleanup.exchange_ended" && event.source === "canonical" && event.payload.confirmed === true
    && (typeof event.payload.exchange_id !== "string" || event.payload.exchange_id.toLowerCase() === runExchangeId) && event.seq < seq;
}

function isGlobalSignOutBefore(event: Event, seq: number): boolean {
  return event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.payload.confirmed === true && event.payload.scope === "global" && event.seq < seq;
}

/**
 * Only a post-quiescence audit proves no call is left unexamined: End's
 * read of every call, available and settled, taken after the run's
 * exchange was confirmed ended and the bridge's session_closed, and before
 * the global sign-out (no voice call can be recorded after quiescence).
 */
function endCallsAuditVerdict(ctx: EvalContext, audit: Event | null, runExchangeId: string | null, sessionClosed: BoundBridgeReceipt<SessionClosedReceipt> | null, unattributedSeqs: number[]): Verdict {
  if (audit === null) return ["uncertain", "end_calls_audit_unproven"];
  const auditAnswered = audit.payload.status === "available" && typeof audit.payload.exchange_id === "string" && audit.payload.exchange_id.toLowerCase() === runExchangeId;
  if (!auditAnswered) return ["uncertain", "end_calls_read_unavailable"];
  const endedBefore = ctx.ordered.some((event) => isRunExchangeEndBefore(event, runExchangeId, audit.seq));
  const closedBefore = sessionClosed !== null && sessionClosed.event.seq < audit.seq;
  const signedOutBefore = ctx.ordered.some((event) => isGlobalSignOutBefore(event, audit.seq));
  if (audit.payload.settled !== true || !endedBefore || !closedBefore || signedOutBefore) return ["uncertain", "end_calls_audit_unproven"];
  if (unattributedSeqs.length > 0) return ["uncertain", "unattributed_call"];
  return ["pass", null];
}

/**
 * Every command-bearing call the exchange's reads listed must fall in some
 * step's window; one made between a step's window and the next baseline (or
 * before End) was never examined, so the run's outcome is not all accounted for.
 */
function assertCallsAttributed(ctx: EvalContext, certification: ReturnType<typeof certifyStudioVoiceSteps>, runExchangeId: string | null, sessionClosed: BoundBridgeReceipt<SessionClosedReceipt> | null): void {
  if (!certification.answered) return;
  const callReads = ctx.ordered.filter((event) => event.kind === STUDIO_CALLS_READ_KIND && event.source === "canonical");
  const audit = callReads.filter((event) => event.payload.purpose === "baseline" && event.payload.step_id === STUDIO_CALLS_END_STEP).at(-1) ?? null;
  const [status, reason] = endCallsAuditVerdict(ctx, audit, runExchangeId, sessionClosed, certification.unattributed_seqs);
  P(ctx, "outcome.calls_attributed", status, reason, audit === null ? callReads : [audit]);
}

/**
 * A voice step is certified only from the exchange's calls
 * (calls-certification.ts): the one command its own voice call admitted
 * after the step's durable baseline, of its kind and on its goal, with its
 * effect seen. Never by a task's timing, actor or exchange id alone.
 */
function certifyRunVoiceSteps(ctx: EvalContext, inputs: OperationRecord[], nonSilence: NonSilenceInput[], windows: Array<BoundBridgeReceipt<InputWindowReceipt>>, epochJoinable: boolean, runExchangeId: string | null, ownership: OwnershipFacts): ReturnType<typeof certifyStudioVoiceSteps> {
  const voiceOperations = inputs.filter((operation) => typeof operation.input._g7_step === "string" && STUDIO_VOICE_STEP_COMMAND_KIND[operation.input._g7_step] !== undefined);
  return certifyStudioVoiceSteps({
    events: ctx.ordered,
    steps: voiceOperations.map((operation) => ({ operationId: operation.id, stepId: String(operation.input._g7_step) })),
    runExchangeId,
    ownershipProven: ownership.ownershipProven.length > 0 && ownership.ownershipMismatch.length === 0,
    // The input epoch each step's voice was heard at: the bridge's input
    // window receipt of the same ordinal. Joined only when the windows seen
    // are exactly 1..k, k the non-silence inputs so far (mid-run too, before
    // session_closed), and after session_closed only when the run is
    // joinable (nothing dropped, counts equal), and only while the join's
    // cross-checks hold (every window turn_complete; each window's tool calls
    // within its step's own calls). An extra window (a split utterance, a
    // silence the bridge opened one for, a rejoin chunk) or a missing one
    // would shift every later step: then every epoch is unknown.
    stepInputEpochs: new Map(nonSilence.map((entry, index) => [entry.operation.id, epochJoinable ? windows.find((item) => item.receipt.windowSeq === index + 1)!.receipt.inputEpoch : null])),
  });
}

/** The design its own research's page went to, naming that research back, and that design's one artifact. */
function resolveOwnDesign(created: string, designTaskId: string, allTasks: Array<Record<string, unknown>>, runExchangeId: string | null): OwnReport {
  const designs = allTasks.filter((task) => task.task_id === designTaskId).map((task) => ({ task, design: record(task.design) })).filter((item) => item.design !== null);
  if (designs.length === 0) return { status: "unavailable", reason: "own_design_not_observed" };
  if (designs.some((item) => item.design!.research_task_id !== created)) return { status: "uncertain", reason: "target_not_canonical" };
  if (designs.some((item) => typeof item.task.exchange_id === "string" && item.task.exchange_id.toLowerCase() !== runExchangeId)) return { status: "uncertain", reason: "target_not_canonical" };
  const artifactIds = new Set(designs.map((item) => item.design!.artifact_id).filter((value): value is string => typeof value === "string"));
  if (artifactIds.size === 0) return { status: "unavailable", reason: "own_design_pending" };
  if (artifactIds.size > 1) return { status: "uncertain", reason: "own_artifact_ambiguous" };
  return { status: "resolved", designTaskId, artifactId: [...artifactIds][0]! };
}

/**
 * The run's own report, resolved only through the product's own links
 * (studio-driver.ts #resolveOwnReport does the same before any mutation):
 * the certified create's research task (bound to the run's exchange), the
 * one design task its page went to (research.design_task_id), which names
 * that research task back, and that design's artifact. Its own versions are
 * that design's published version and those of the Lab's own edit tasks on
 * the same artifact and research. Bytes, edits and refusals of any other
 * artifact are never the run's, whatever the time window or the principal.
 */
function resolveOwnReport(createdTaskId: string | null, allTasks: Array<Record<string, unknown>>, runExchangeId: string | null): OwnReport {
  if (createdTaskId === null) return { status: "unavailable", reason: "create_step_not_certified" };
  const research = allTasks.filter((task) => task.task_id === createdTaskId);
  if (research.length === 0) return { status: "unavailable", reason: "own_research_not_observed" };
  if (research.some((task) => typeof task.exchange_id !== "string" || task.exchange_id.toLowerCase() !== runExchangeId)) return { status: "uncertain", reason: "own_research_not_bound_to_run_exchange" };
  const designIds = new Set(research.map((task) => record(task.research)?.design_task_id).filter((value): value is string => typeof value === "string"));
  if (designIds.size === 0) return { status: "unavailable", reason: "own_design_pending" };
  if (designIds.size > 1) return { status: "uncertain", reason: "own_design_ambiguous" };
  return resolveOwnDesign(createdTaskId, [...designIds][0]!, allTasks, runExchangeId);
}

/** The Lab's own admitted edits of the run's own artifact (their tasks name the same research and artifact). */
function ownEditTaskIds(ctx: EvalContext, ownChain: { designTaskId: string; artifactId: string } | null, createdTaskId: string | null, allTasks: Array<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  if (ownChain === null) return ids;
  for (const event of ofKind(ctx, "studio.action.html_edit", "canonical")) {
    if (event.payload.requested !== true || event.payload.status !== "admitted" || event.payload.artifact_id !== ownChain.artifactId || typeof event.payload.task_id !== "string") continue;
    const seen = allTasks.filter((task) => task.task_id === event.payload.task_id).map((task) => record(task.design));
    if (seen.length > 0 && seen.every((design) => design !== null && design.research_task_id === createdTaskId && design.artifact_id === ownChain.artifactId)) ids.add(event.payload.task_id);
  }
  return ids;
}

/** The latest state of each of the run's own versions; another artifact's bytes are never the run's. */
function ownArtifactStates(observations: Event[], ownChain: { designTaskId: string; artifactId: string } | null, editTaskIds: Set<string>): ArtifactState[] {
  const isOwnVersion = (artifact: Record<string, unknown>) => ownChain !== null && artifact.artifact_id === ownChain.artifactId && typeof artifact.task_id === "string" && (artifact.task_id === ownChain.designTaskId || editTaskIds.has(artifact.task_id));
  const artifactFacts = observations.flatMap((event) => (Array.isArray(event.payload.artifacts) ? event.payload.artifacts as unknown[] : []).map((value) => ({ event, artifact: record(value) ?? {} })));
  const latestArtifact = new Map<string, ArtifactState>();
  for (const item of artifactFacts) if (isOwnVersion(item.artifact)) latestArtifact.set(String(item.artifact.version_id), item);
  return [...latestArtifact.values()];
}

function assertArtifactBytes(ctx: EvalContext, artifactStates: ArtifactState[], ownReport: OwnReport, observations: Event[]): void {
  const mismatched = artifactStates.filter((item) => item.artifact.status === "mismatch");
  const verifiedArtifacts = artifactStates.filter((item) => item.artifact.status === "verified");
  if (mismatched.length > 0) P(ctx, "outcome.artifact_bytes_integrity", "fail", "downloaded_bytes_disagree_with_declared_digest", mismatched.map((item) => item.event));
  else if (verifiedArtifacts.length > 0) P(ctx, "outcome.artifact_bytes_integrity", "pass", null, verifiedArtifacts.map((item) => item.event));
  else if (ownReport.status !== "resolved") P(ctx, "outcome.artifact_bytes_integrity", ownReport.status, ownReport.reason, observations);
  else P(ctx, "outcome.artifact_bytes_integrity", "unavailable", artifactStates.length > 0 ? String(artifactStates[0]!.artifact.reason ?? "artifact_bytes_unavailable") : "no_own_published_artifact_observed", observations);
}

// ------------------------------------------------------------ scenario steps

/** What the scenario steps are judged on. */
interface StepFacts {
  ctx: EvalContext;
  inputs: OperationRecord[];
  publishedLab: BoundPageReceipt[];
  certifiedSteps: Map<string, StudioStepCertification>;
  createdTaskId: string | null;
  ownReport: OwnReport;
  observations: Event[];
  artifactStates: ArtifactState[];
}

function succeededFor(facts: StepFacts, step: StudioG7Step): OperationRecord[] {
  return (step.executor === "speak"
    ? facts.inputs.filter((operation) => operation.input._g7_step === step.id)
    : facts.ctx.operations.filter((operation) => operation.type === "studio_action" && operation.state === "succeeded" && operation.input.action === step.label))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

function leaveAndReturnOutcome(facts: StepFacts, operation: OperationRecord, result: StudioStepResult): StudioStepResult {
  const left = ofKind(facts.ctx, "studio.room.left", "browser").filter((event) => event.payload.operation_id === operation.id);
  const rejoined = ofKind(facts.ctx, "studio.room.rejoined", "browser").filter((event) => event.payload.operation_id === operation.id);
  const republished = left.length > 0 && facts.publishedLab.some((item) => item.event.seq > left[0]!.seq);
  result.outcome = rejoined.length > 0 && republished ? "pass" : "fail";
  result.reason = rejoined.length > 0 && republished ? null : "lab_track_not_republished_after_return";
  return result;
}

/**
 * The revision's effect, in its own observation: the Lab's own edit task X
 * under way on the run's own design (mode edit, the run's research, the
 * run's artifact). The episode withdraws the note while X is live, so X is
 * not waited for; a published X must show its bytes.
 */
function sectionRevisionOutcome(facts: StepFacts, operation: OperationRecord, taskId: string, artifactId: string, result: StudioStepResult): StudioStepResult {
  const ownObservation = facts.observations.filter((event) => event.payload.purpose === "g7.section_revision" && event.payload.operation_id === operation.id).at(-1) ?? null;
  const seen = ownObservation === null ? null : tasksOf(ownObservation).find((task) => task.task_id === taskId) ?? null;
  const design = record(seen?.design);
  const artifact = facts.artifactStates.find((item) => item.artifact.task_id === taskId);
  if (!design) { result.outcome = "unavailable"; result.reason = "edit_task_not_observed"; }
  else if (design.mode !== "edit" || design.research_task_id !== facts.createdTaskId || design.artifact_id !== artifactId) { result.outcome = "uncertain"; result.reason = "edit_task_not_on_own_chain"; }
  else if (STUDIO_LIVE_DESIGN_STATES.has(String(design.state)) && !["failed", "cancelled", "succeeded"].includes(String(seen!.state))) { result.outcome = "pass"; result.reason = null; }
  else if (design.state === "published") {
    result.outcome = artifact?.artifact.status === "verified" ? "pass" : artifact?.artifact.status === "mismatch" ? "fail" : "unavailable";
    result.reason = artifact?.artifact.status === "verified" ? null : artifact?.artifact.status === "mismatch" ? "revised_page_bytes_mismatch" : "revised_page_bytes_unavailable";
  } else if (design.state === "failed" || design.state === "cancelled" || design.state === "superseded") {
    result.outcome = "fail"; result.reason = `section_revision_${String(design.state)}`;
  } else { result.outcome = "unavailable"; result.reason = "section_revision_not_settled"; }
  return result;
}

/** A section revision or a stale edit: only an edit (or refusal) of the run's own artifact, on its own chain, is the run's. */
function htmlEditOutcome(facts: StepFacts, step: StudioG7Step, operation: OperationRecord, result: StudioStepResult): StudioStepResult {
  const edit = ofKind(facts.ctx, "studio.action.html_edit", "canonical").filter((event) => event.payload.operation_id === operation.id && event.payload.requested === true).at(-1);
  const ownReport = facts.ownReport;
  if (!edit) { result.outcome = "unavailable"; result.reason = "edit_receipt_missing"; return result; }
  if (ownReport.status !== "resolved") { result.outcome = ownReport.status; result.reason = ownReport.reason; return result; }
  if (edit.payload.artifact_id !== ownReport.artifactId) { result.outcome = "uncertain"; result.reason = "edit_target_not_canonical"; return result; }
  if (step.label === "stale_edit") {
    const refusedStale = edit.payload.http_status === 409 && edit.payload.code === "stale_revision";
    result.outcome = refusedStale ? "pass" : "fail";
    result.reason = refusedStale ? null : edit.payload.status === "admitted" ? "stale_edit_admitted" : `stale_edit_refused_as_${String(edit.payload.code ?? edit.payload.http_status ?? "unknown")}`;
    return result;
  }
  if (edit.payload.status !== "admitted" || typeof edit.payload.task_id !== "string") {
    result.outcome = "fail"; result.reason = `section_revision_refused_${String(edit.payload.code ?? edit.payload.http_status ?? "unknown")}`; return result;
  }
  return sectionRevisionOutcome(facts, operation, edit.payload.task_id, ownReport.artifactId, result);
}

/** The run's own note: its own request's receipt names the entry and the note's source. */
function recordNoteOutcome(facts: StepFacts, operation: OperationRecord, result: StudioStepResult): StudioStepResult {
  const note = ofKind(facts.ctx, "studio.action.record_note", "canonical").filter((event) => event.payload.operation_id === operation.id && event.payload.requested === true).at(-1);
  if (!note) { result.outcome = "unavailable"; result.reason = "record_note_receipt_missing"; return result; }
  const recorded = note.payload.status === "committed" && typeof note.payload.entry_id === "string" && typeof note.payload.source_id === "string";
  result.outcome = recorded ? "pass" : "fail";
  result.reason = recorded ? null : `record_note_refused_${String(note.payload.code ?? note.payload.http_status ?? "unknown")}`;
  return result;
}

function designOf(task: Record<string, unknown> | null): Record<string, unknown> | null {
  return record(task?.design);
}

/** Whether `value` is a list holding `id`. */
function listsId(value: unknown, id: string | null): boolean {
  return id !== null && Array.isArray(value) && (value as unknown[]).includes(id);
}

function isLiveBefore(task: Record<string, unknown> | null): boolean {
  return STUDIO_LIVE_DESIGN_STATES.has(String(designOf(task)?.state)) && !["succeeded", "failed", "cancelled"].includes(String(task?.state));
}

/** Failed for the product's revoke reason. */
function isRevokedByWithdrawal(task: Record<string, unknown> | null): boolean {
  return (designOf(task)?.state === "failed" || task?.state === "failed")
    && (designOf(task)?.reason_class === "revoked_source_withdrawn" || task?.reason_class === "revoked_source_withdrawn");
}

/** An edit of the run's own research on the run's own artifact (the chain R -> D -> artifact the edit receipt was resolved on). */
function isOnOwnChain(task: Record<string, unknown> | null, createdTaskId: string | null, artifactId: string): boolean {
  return designOf(task)?.mode === "edit" && designOf(task)?.research_task_id === createdTaskId && designOf(task)?.artifact_id === artifactId;
}

function isOwnCommittedNote(event: Event): boolean {
  return event.payload.status === "committed" && typeof event.payload.entry_id === "string" && typeof event.payload.source_id === "string";
}

function isAdmittedOwnRevision(event: Event, artifactId: string): boolean {
  return event.payload.purpose === "section_revision" && event.payload.requested === true && event.payload.status === "admitted"
    && event.payload.artifact_id === artifactId && typeof event.payload.task_id === "string";
}

function isStopBaseline(event: Event): boolean {
  return event.kind === STUDIO_CALLS_READ_KIND && event.source === "canonical" && event.payload.purpose === "baseline" && event.payload.step_id === "g7.stop";
}

/** The joins `design_ended` rests on, each on a field the product serves. */
interface DesignEndedFacts {
  withdrawal: Event;
  before: Event | null;
  afterOwn: Event | null;
  noteEvent: Event | null;
  noteEntry: string | null;
  noteSource: string | null;
  editTask: string | null;
  stopBaseline: Event | null;
  xBefore: Record<string, unknown> | null;
  xAfter: Record<string, unknown> | null;
  evidence: Event[];
}

function designEndedFacts(facts: StepFacts, operation: OperationRecord, withdrawal: Event): DesignEndedFacts {
  const own = (purpose: string) => facts.observations.filter((event) => event.payload.purpose === purpose && event.payload.operation_id === operation.id).at(-1) ?? null;
  const before = own("g7.withdrawal:before");
  const afterOwn = own("g7.withdrawal");
  const sightingIn = (event: Event | null, taskId: string) => event === null ? null : tasksOf(event).find((task) => task.task_id === taskId) ?? null;
  const noteEvent = ofKind(facts.ctx, "studio.action.record_note", "canonical").filter(isOwnCommittedNote).at(-1) ?? null;
  const ownReport = facts.ownReport;
  const editTask = ownReport.status !== "resolved" ? null
    : ofKind(facts.ctx, "studio.action.html_edit", "canonical").filter((event) => isAdmittedOwnRevision(event, ownReport.artifactId)).map((event) => String(event.payload.task_id)).at(-1) ?? null;
  return {
    withdrawal, before, afterOwn, noteEvent,
    noteEntry: noteEvent === null ? null : String(noteEvent.payload.entry_id),
    noteSource: noteEvent === null ? null : String(noteEvent.payload.source_id),
    editTask,
    stopBaseline: facts.ctx.ordered.find(isStopBaseline) ?? null,
    xBefore: editTask === null ? null : sightingIn(before, editTask),
    xAfter: editTask === null ? null : sightingIn(afterOwn, editTask),
    evidence: [noteEvent, before, withdrawal, afterOwn].filter((event): event is Event => event !== null),
  };
}

/** The joins on the run's own records: the create certified, the withdrawal committed for the run's own note (its source S) and the own edit X admitted. */
function designEndedOwnRecords(facts: StepFacts, d: DesignEndedFacts, committed: boolean): [StudioAssertionStatus, string | null, Event[]] | null {
  if (facts.createdTaskId === null) return ["unavailable", "create_step_not_certified", []];
  if (!committed) return ["unavailable", "withdrawal_not_committed", [d.withdrawal]];
  if (facts.ownReport.status !== "resolved") return [facts.ownReport.status, facts.ownReport.reason, [d.withdrawal]];
  if (d.noteEvent === null) return ["unavailable", "own_note_not_recorded", [d.withdrawal]];
  if (d.withdrawal.payload.entry_id !== d.noteEntry) return ["uncertain", "withdrawn_note_not_own_note", d.evidence];
  if (d.withdrawal.payload.receipt_source_id !== d.noteSource) return ["uncertain", "withdrawal_receipt_source_mismatch", d.evidence];
  if (d.editTask === null) return ["unavailable", "own_edit_not_admitted", d.evidence];
  return null;
}

/** X before the withdrawal, in the withdrawal's own before-observation: the run's own edit, live, not yet listing S as withdrawn; and an after-observation not preceded by Stop. */
function designEndedObservations(facts: StepFacts, d: DesignEndedFacts, artifactId: string): [StudioAssertionStatus, string | null] | null {
  if (d.before === null || d.before.seq > d.withdrawal.seq) return ["uncertain", "no_observation_before_withdrawal"];
  if (d.xBefore !== null && !isOnOwnChain(d.xBefore, facts.createdTaskId, artifactId)) return ["uncertain", "own_edit_not_on_own_chain"];
  if (!isLiveBefore(d.xBefore)) return ["uncertain", "own_edit_no_longer_live"];
  if (listsId(d.xBefore!.withdrawn_source_ids, d.noteSource)) return ["uncertain", "note_source_withdrawn_before"];
  if (d.afterOwn === null || d.afterOwn.seq < d.withdrawal.seq) return ["uncertain", "no_observation_after_withdrawal"];
  if (d.stopBaseline !== null && d.stopBaseline.seq < d.afterOwn.seq) return ["uncertain", "stop_before_withdrawal_effect_observed"];
  return null;
}

/**
 * X after: failed for the product's revoke reason, with S in its
 * withdrawnSourceIds, and S the only source newly withdrawn from X's
 * closure between its two reads: another source withdrawn in the same
 * window (a concurrent foreign withdrawal, or an eligibility change) could
 * be the revocation's cause, and the product's reason does not say which.
 */
function designEndedEffect(d: DesignEndedFacts): Verdict {
  if (!Array.isArray(d.xAfter?.withdrawn_source_ids) || !Array.isArray(d.xBefore?.withdrawn_source_ids)) return ["unavailable", "withdrawn_sources_not_served"];
  if (!isRevokedByWithdrawal(d.xAfter)) return ["uncertain", "design_not_ended_by_withdrawal"];
  if (!listsId(d.xAfter!.withdrawn_source_ids, d.noteSource)) return ["uncertain", "note_source_not_in_edit_closure"];
  if ((d.xAfter!.withdrawn_source_ids as unknown[]).some((source) => source !== d.noteSource && !listsId(d.xBefore!.withdrawn_source_ids, String(source)))) return ["uncertain", "concurrent_foreign_withdrawal"];
  return ["pass", null];
}

/**
 * The withdrawal ended the run's own edit X only with all of (every join
 * on the note's SOURCE S from the run's own record_note receipt, never its
 * entry id), each a field the product serves:
 * - the withdrawal committed, for the run's own note, and its withdraw_note
 *   receipt names S;
 * - X is canonically the run's own: the task the Lab's own admitted edit
 *   receipt names, on the run's own artifact, and in the withdrawal's own
 *   before-observation an edit of the run's own research (its design's
 *   researchTaskId is R) on that artifact;
 * - X was live there, and did not yet list S as withdrawn;
 * - in the withdrawal's own after-observation X failed for the product's
 *   revoke reason, with S in its withdrawnSourceIds: the product computes
 *   those from X's attempt's consumed closure, so this is also the proof
 *   that X drew on S (NativeTask.inputSourceIds lists only discussion
 *   contributions, never a note's source: the product's native_task_view,
 *   0022, so it is never read for this join);
 * - nothing else ended it first (no Stop before that observation), and no
 *   other source was newly withdrawn from X's closure between the two.
 */
function assertDesignEnded(facts: StepFacts, operation: OperationRecord, withdrawal: Event, committed: boolean): void {
  const id = "step.g7.withdrawal.design_ended";
  const d = designEndedFacts(facts, operation, withdrawal);
  const records = designEndedOwnRecords(facts, d, committed);
  if (records !== null) { P(facts.ctx, id, records[0], records[1], records[2]); return; }
  const artifactId = (facts.ownReport as { artifactId: string }).artifactId;
  const [status, reason] = designEndedObservations(facts, d, artifactId) ?? designEndedEffect(d);
  P(facts.ctx, id, status, reason, d.evidence);
}

function withdrawalOutcome(facts: StepFacts, operation: OperationRecord, result: StudioStepResult): StudioStepResult {
  const withdrawal = ofKind(facts.ctx, "studio.action.withdrawal", "canonical").filter((event) => event.payload.operation_id === operation.id && event.payload.requested === true).at(-1);
  if (!withdrawal) { result.outcome = "unavailable"; result.reason = "withdrawal_receipt_missing"; return result; }
  const committed = withdrawal.payload.status === "committed" && withdrawal.payload.receipt_operation === "withdraw_note";
  result.outcome = committed ? "pass" : "fail";
  result.reason = committed ? null : `withdrawal_refused_${String(withdrawal.payload.code ?? withdrawal.payload.http_status ?? "unknown")}`;
  assertDesignEnded(facts, operation, withdrawal, committed);
  return result;
}

/** A performed step's outcome, by what performed it. */
function performedStepOutcome(facts: StepFacts, step: StudioG7Step, operation: OperationRecord, result: StudioStepResult): StudioStepResult {
  if (step.executor === "speak") {
    const certified = facts.certifiedSteps.get(operation.id);
    result.outcome = certified ? certified.outcome : "unavailable";
    result.reason = certified ? certified.reason : "no_calls_certification";
    return result;
  }
  if (step.label === "leave_and_return") return leaveAndReturnOutcome(facts, operation, result);
  if (step.label === "section_revision" || step.label === "stale_edit") return htmlEditOutcome(facts, step, operation, result);
  if (step.label === "record_note") return recordNoteOutcome(facts, operation, result);
  return withdrawalOutcome(facts, operation, result);
}

function scenarioStepResult(facts: StepFacts, step: StudioG7Step): StudioStepResult {
  const attempted = succeededFor(facts, step);
  const performed = attempted.filter((operation) => step.executor === "speak" || operation.result?.performed === true);
  const operation = performed.at(-1) ?? attempted.at(-1) ?? null;
  const result: StudioStepResult = { step_id: step.id, intent: step.intent, executed: "unavailable", outcome: "unavailable", reason: null, operation_id: operation?.id ?? null, outcome_join: step.outcome_join };
  if (performed.length === 0) {
    const typedReason = typeof attempted.at(-1)?.result?.reason === "string" ? String(attempted.at(-1)!.result!.reason) : null;
    result.executed = facts.ctx.ended ? "fail" : "unavailable";
    result.reason = typedReason ?? (facts.ctx.ended ? "step_not_performed_before_end" : "step_not_yet_performed");
    result.outcome = "unavailable";
    return result;
  }
  result.executed = "pass";
  return performedStepOutcome(facts, step, operation!, result);
}

function assertScenarioSteps(facts: StepFacts): StudioStepResult[] {
  const scenario = studioG7Scenario(facts.ctx.run.scenarioId);
  const steps: StudioStepResult[] = [];
  if (!scenario) {
    H(facts.ctx, "scenario.catalog_binding", "unavailable", "scenario_not_in_studio_g7_catalog");
    return steps;
  }
  for (const step of scenario.steps) steps.push(scenarioStepResult(facts, step));
  for (const step of steps) {
    H(facts.ctx, `step.${step.step_id}.executed`, step.executed, step.executed === "pass" ? null : step.reason);
    P(facts.ctx, `step.${step.step_id}.outcome`, step.outcome, step.reason);
  }
  return steps;
}

// -------------------------------------------------- legacy-only evidence

function assertNoLegacyEvidence(ctx: EvalContext): void {
  for (const kind of ["harness.input_frame_forwarded", "audio.input.product_leg", "session.finalized"]) {
    if (ctx.ordered.some((event) => event.kind === kind)) H(ctx, `legacy.${kind}`, "fail", "legacy_gemini_browser_evidence_on_studio_target", ctx.ordered.filter((event) => event.kind === kind));
  }
}

// ------------------------------------------------------------ corroboration

function senderStatsCorroboration(ctx: EvalContext, issuedHashes: Set<string>): { samples: number; issuedRows: number; maxPackets: number | null } {
  const stats = ofKind(ctx, "studio.webrtc.sender_stats", "browser");
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
  return { samples: stats.length, issuedRows, maxPackets };
}

export function evaluateStudioG7Run(run: RunRecord, events: Event[], operations: OperationRecord[], options: StudioEvaluationOptions): StudioG7Evaluation {
  const ctx: EvalContext = {
    run, operations, options, harness: [], product: [],
    expectedBinding: run.scenarioId && run.scenarioVersion
      ? computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion })
      : "",
    ordered: [...events].sort((left, right) => left.seq - right.seq),
    ended: operations.some((operation) => operation.type === "end" && operation.state === "succeeded"),
  };
  const binding = assertBinding(ctx);
  const ownership = assertOwnership(ctx);
  const { bridge, conflictingSeqs, duplicateCount, firstSeq, maxSeq, missingSeqs } = assertBridgeDiscipline(ctx, binding.bridgeRaw);
  // Only an end confirmed after the run's exchange join proves anything about that exchange.
  const labEndEvent = studioExchangeEndAfterJoin(ctx.ordered);
  const readAfterLabEnd = labEndEvent ? bridge.filter((item) => item.event.seq > labEndEvent.seq).length : 0;
  const turnsAll = bridgeOfKind<InputTurnReceipt>(bridge, "input_turn");
  const providers = bridgeOfKind<ProviderReceipt>(bridge, "provider");
  const sessionClosed = bridgeOfKind<SessionClosedReceipt>(bridge, "session_closed").at(-1) ?? null;
  const latestGrant = binding.grants.at(-1) ?? null;
  const windows = uniqueByOrdinal(ctx, bridgeOfKind<InputWindowReceipt>(bridge, "input_window"), (receipt) => receipt.windowSeq, "bridge.window_ordinals_unique");
  const replies = uniqueByOrdinal(ctx, bridgeOfKind<OutputReplyReceipt>(bridge, "output_reply"), (receipt) => receipt.replyOrdinal, "bridge.reply_ordinals_unique");
  const receiptsDropped = bridgeReceiptsDropped(missingSeqs, sessionClosed, { windows: windows.length, turns: turnsAll.length, replies: replies.length });

  const inputFacts = assertInputs(ctx, binding.pageReceipts);
  const windowFacts: WindowFacts = { windows, turnsAll, bridge, sessionClosed, receiptsDropped, exchangeJoin: ownership.exchangeJoin };
  assertWindowJoin(ctx, inputFacts.nonSilence, windowFacts);
  const join = windowJoinChecks(ctx, inputFacts.nonSilence, windowFacts);
  inputFacts.nonSilence.forEach((entry, index) => assertUtteranceWindow(ctx, entry, index, inputFacts.utterances, windowFacts, join));
  const { providerVerdict, bridgeCommits } = assertProvider(ctx, providers, sessionClosed);
  assertOutput(ctx, replies, turnsAll, sessionClosed, receiptsDropped, binding.pageReceipts);
  const guardReason = assertSessionAndGuard(ctx, sessionClosed, receiptsDropped, bridgeOfKind<GuardReceipt>(bridge, "guard"), binding.grants);
  const cleanupFacts = assertCleanup(ctx, labEndEvent);
  const identities = assertIdentities(ctx, bridgeCommits, providers);

  const observations = ofKind(ctx, "studio.outcome.observed", "canonical");
  const runExchangeId = runExchangeIdOf(ownership.exchangeJoin);
  const certification = certifyRunVoiceSteps(ctx, inputFacts.inputs, inputFacts.nonSilence, windows, join.epochJoinable, runExchangeId, ownership);
  assertCallsAttributed(ctx, certification, runExchangeId, sessionClosed);
  const allTasks = observations.flatMap(tasksOf);
  const ownReport = resolveOwnReport(certification.createdTaskId, allTasks, runExchangeId);
  const ownChain = ownReport.status === "resolved" ? ownReport : null;
  const boundIds = new Set<string>([...(certification.createdTaskId === null ? [] : [certification.createdTaskId]), ...(ownChain === null ? [] : [ownChain.designTaskId])]);
  const artifactStates = ownArtifactStates(observations, ownChain, ownEditTaskIds(ctx, ownChain, certification.createdTaskId, allTasks));
  assertArtifactBytes(ctx, artifactStates, ownReport, observations);
  const steps = assertScenarioSteps({ ctx, inputs: inputFacts.inputs, publishedLab: inputFacts.publishedLab, certifiedSteps: new Map(certification.steps.map((item) => [item.operation_id, item])), createdTaskId: certification.createdTaskId, ownReport, observations, artifactStates });
  assertNoLegacyEvidence(ctx);
  const stats = senderStatsCorroboration(ctx, inputFacts.issuedHashes);

  const { harness, product } = ctx;
  const harnessVerdict = harnessVerdictOf(harness);
  const productVerdict = productVerdictOf(product);
  const withheld = harness.filter((assertion) => assertion.status !== "pass").map((assertion) => `${assertion.id}=${assertion.status}`);
  const latestOwnership = ownership.ownershipEvents.at(-1)?.payload.status;
  const { cleanup, latestEnded, leaseReleased, cleanupComplete, roomPresence } = cleanupFacts;
  return {
    schema: STUDIO_G7_EVALUATION_SCHEMA,
    contract_version: STUDIO_G7_CONTRACT_VERSION,
    product_contract: STUDIO_G7_PRODUCT_CONTRACT,
    scenario_id: run.scenarioId,
    scenario_version: run.scenarioVersion,
    run_binding_sha256: ctx.expectedBinding,
    grant_id: binding.grantId,
    pcm_reconciliation: "envelope_only",
    pcm_chain_comparison: "unsupported",
    retention: { transcript: "not_retained", audio: "not_retained" },
    limitations: [...STUDIO_G7_LIMITATIONS],
    verdicts: { harness: harnessVerdict, product: productVerdict, provider: providerVerdict },
    harness,
    product,
    steps,
    utterances: inputFacts.utterances,
    bridge: { receipt_count: binding.bridgeRaw.length, distinct_seq_count: bridge.length, duplicate_count: duplicateCount, conflicting_seqs: conflictingSeqs, missing_seqs: missingSeqs, first_seq: firstSeq, max_seq: maxSeq, read_after_lab_end_count: readAfterLabEnd, after_session_closed_kinds: kindsAfterSessionClosed(bridge, sessionClosed), exchange_state: latestGrant?.exchangeState ?? null },
    cleanup: { required: true, guard_reason: guardReason, exchange_ended: cleanup.exchangeEnded, exchange_status: typeof latestEnded?.payload.status === "string" ? latestEnded.payload.status : null, ownership: typeof latestOwnership === "string" ? latestOwnership : null, signed_out: cleanup.signedOut, browser_closed: cleanup.browserClosed, browser_lease_released: leaseReleased.length > 0, room_presence: roomPresence, complete: cleanupComplete },
    deployed_identities: identities,
    outcome: outcomeSummary(certification, ownReport, observations.length, boundIds.size, artifactStates),
    corroboration: { webrtc_sender_stats: { status: "corroboration_only", samples: stats.samples, issued_track_rows: stats.issuedRows, max_packets_sent: stats.maxPackets } },
    coverage: STUDIO_G7_RECEIPT_COVERAGE,
    summary: withheld.length === 0 ? `harness_pass_${harness.length}` : `harness_withheld:${withheld.slice(0, 32).join(",")}`,
  };
}

function outcomeSummary(certification: ReturnType<typeof certifyStudioVoiceSteps>, ownReport: OwnReport, observationCount: number, boundTasks: number, artifactStates: ArtifactState[]): StudioG7Evaluation["outcome"] {
  return { observations: observationCount, join: certification.steps.some((item) => item.outcome === "pass") ? "exchange_calls" : "uncertain", bound_tasks: boundTasks, own_report: ownReport.status === "resolved" ? { status: "resolved", reason: null, create_task_id: certification.createdTaskId, design_task_id: ownReport.designTaskId, artifact_id: ownReport.artifactId } : { status: ownReport.status, reason: ownReport.reason, create_task_id: certification.createdTaskId, design_task_id: null, artifact_id: null }, missing_product_field: certification.answered ? null : "ExchangeCalls", voice_steps: certification.steps, unattributed_call_seqs: certification.unattributed_seqs, artifacts_verified: artifactStates.filter((item) => item.artifact.status === "verified").length, artifacts_mismatched: artifactStates.filter((item) => item.artifact.status === "mismatch").length, artifacts_unavailable: artifactStates.filter((item) => item.artifact.status === "unavailable").length };
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
  if (studioAllocationFree(events)) return { exchangeEnded: true, signedOut: true, browserClosed: true, browserQuiesced: false, refreshSessionsRevoked: true, complete: true };
  // A confirmed end counts only after the run's exchange join (or Speak
  // intent): an earlier settle cannot speak for an exchange opened later.
  const exchangeEnded = studioExchangeEndAfterJoin(events) !== null;
  const signedOut = events.some(isConfirmedGlobalSignOut);
  const browserClosed = events.some(isProvenBrowserClose) || events.some(isBrowserNeverAllocated);
  // A dead foreign worker's browser cannot be proven closed; its lease is
  // released only once that browser can no longer act on the product
  // (lease-release.ts). Typed `quiesced`, never `closed`.
  const browserQuiesced = events.some(isQuiescedLeaseRelease);
  // An evidence-refresh session whose local revoke failed stays valid on the
  // server until a later confirmed global sign-out revokes it.
  const refreshSessionsRevoked = events
    .filter((event) => event.kind === "studio.evidence.session_revoked" && event.source === "canonical" && event.payload.confirmed !== true)
    .every((unrevoked) => events.some((event) => isConfirmedGlobalSignOut(event) && event.seq > unrevoked.seq));
  return { exchangeEnded, signedOut, browserClosed, browserQuiesced, refreshSessionsRevoked, complete: exchangeEnded && signedOut && (browserClosed || browserQuiesced) && refreshSessionsRevoked };
}

/** The worker's authoritative ledger read that no browser was ever allocated, and nothing a browser would leave. */
function studioAllocationFree(events: Event[]): boolean {
  return events.some((event) => isBrowserNeverAllocated(event) && event.payload.authoritative_ledger_read === true)
    && !events.some((event) => event.kind === "harness.browser_process_acquired" || event.kind === "studio.auth.session_established" || event.kind === "studio.exchange.opened" || event.kind === "studio.exchange.speak_requested");
}

/** Only a confirmed global sign-out signs the principal out. */
function isConfirmedGlobalSignOut(event: Event): boolean {
  return event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.payload.confirmed === true && event.payload.scope === "global";
}

function isProvenBrowserClose(event: Event): boolean {
  return event.kind === "cleanup.browser_context_closed" && event.source === "browser" && event.payload.close_resolved === true && event.payload.browser_registry_absent === true;
}

function isBrowserNeverAllocated(event: Event): boolean {
  return event.kind === "cleanup.browser_context_absent" && event.payload.browser_never_allocated === true;
}

function isQuiescedLeaseRelease(event: Event): boolean {
  return event.kind === "cleanup.browser_lease_released" && event.payload.schema === STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA && event.payload.dead_owner_quiesced === true && event.payload.cas_deleted === true;
}

/**
 * Whether, after the run's Speak intent, its browser is durably closed (or a
 * dead owner's lease was released as quiesced) and a global sign-out of the
 * principal was confirmed.
 */
export function studioPrincipalLeft(events: Event[]): { browserClosed: boolean; globalSignOutConfirmed: boolean } {
  const intentSeq = events.filter((event) => event.kind === "studio.exchange.speak_requested" && event.source === "canonical").reduce((latest, event) => Math.max(latest, event.seq), 0);
  const browserClosed = events.some((event) => event.seq > intentSeq && ((event.kind === "cleanup.browser_context_closed" && event.source === "browser" && event.payload.close_resolved === true && event.payload.browser_registry_absent === true)
    || (event.kind === "cleanup.browser_lease_released" && event.payload.schema === STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA && event.payload.dead_owner_quiesced === true)));
  const globalSignOutConfirmed = events.some((event) => event.seq > intentSeq && event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.payload.confirmed === true && event.payload.scope === "global");
  return { browserClosed, globalSignOutConfirmed };
}

/**
 * The durable exchange join of a run, from its write-ahead events, for a
 * restarted worker. Null when the run never durably requested Speak.
 */
export function studioDurableJoin(events: Event[], runBindingSha256: string): { exchangeId: string | null; grantId: string | null; runBindingSha256: string; speakRequested: boolean; exchangeOpenedAtMs: number | null; speakRequestedAtMs: number | null; browserClosed: boolean; globalSignOutConfirmed: boolean } | null {
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
    // Whether the principal has durably left the room since Speak: its
    // browser close and a confirmed global sign-out, both after the intent.
    ...studioPrincipalLeft(events),
  };
}
