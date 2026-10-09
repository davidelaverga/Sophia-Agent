import { randomUUID } from "node:crypto";

import type { DriverEndResult, DriverOperationResult, DriverStartResult } from "../src/browser-driver.js";
import type { LabEvent, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { canonicalJson, computeRunBindingSha256 } from "../src/studio-g7/contract.js";
import type { DurableStudioJoin } from "../src/studio-g7/studio-driver.js";
import {
  API_SHA, EXCHANGE_UUID, GRANT_UUID, LAB_TRACK_ID, STUDIO_SHA,
  evidenceGrant, inputTurn, inputWindow, outputReply, pageReceipt, providerReceipt, sessionClosed,
} from "./studio-g7-helpers.js";

type DriverEvent = Omit<LabEvent, "runId" | "seq" | "at">;

const ARTIFACT = "a0000000-0000-4000-8000-0000000000aa";
const VERSION_1 = "b0000000-0000-4000-8000-0000000000b1";
const VERSION_2 = "b0000000-0000-4000-8000-0000000000b2";
const DESIGN = "d0000000-0000-4000-8000-0000000000d1";
const EDIT = "d0000000-0000-4000-8000-0000000000d2";
const RESEARCH = "d0000000-0000-4000-8000-0000000000d3";

function key(prefix: string, payload: unknown): string { return `${prefix}:${sha256(canonicalJson(payload))}`; }

/**
 * A scripted Studio driver for worker-level tests: it emits exactly the
 * events the real StudioG7Driver authors (write-ahead join, proven ownership,
 * 0046 bridge receipts, outcome observations, action receipts, cleanup) and
 * records what the worker asked of it. No browser and no network.
 */
export class ScriptedStudioDriver {
  /** Runs whose (scripted) browser session is open on this driver. */
  readonly sessions = new Set<string>();
  seq = 0;
  ordinal = 0;
  lateSessionClosed = false;
  durable: string[] = [];
  readonly calls: string[] = [];
  adopted: DurableStudioJoin | null = null;
  recoverResult: (runId: string) => DriverEvent[] = () => [];
  /** Runs inside recover() after its read-only checks and before its global sign-out lands. */
  recoverHook: ((runId: string) => Promise<void>) | null = null;
  /** Whether End proves ownership and ends the exchange (false: the evidence route is unavailable). */
  endExchangeConfirmed = true;
  /** The Supabase `expires_in` the start's password grant answered with (seconds). */
  sessionExpiresInS = 3_600;
  /** Whether the evidence refresh's local revoke of its own session succeeds. */
  refreshRevokeConfirmed = true;
  /**
   * The exchange's calls as the product would answer them (A15
   * getExchangeCalls), per read (`after` is the earlier readAt, verbatim);
   * the default is a product without voice qualification (404).
   */
  callsAnswer: (runId: string, purpose: string, after: string | null) => { status: "available"; read_at: string; calls: Array<Record<string, unknown>> } | { status: "unavailable"; reason: string; http_status: number | null } = () => ({ status: "unavailable", reason: "endpoint_not_served", http_status: 404 });
  readonly callsReads: Array<{ purpose: string; operationId: string | null; after: string | null }> = [];
  /** The sign-out fence's holder checks, as the real driver consults them right before a global logout. */
  readonly signOutGates = new Map<string, () => Promise<boolean>>();
  /** Global logouts this driver actually sent, and those it withheld because its marker was no longer held. */
  readonly globalLogouts: string[] = [];
  readonly withheldLogouts: string[] = [];
  gateChecks = 0;
  setStudioSignOutGate(runId: string, gate: (() => Promise<boolean>) | null): void { if (gate === null) this.signOutGates.delete(runId); else this.signOutGates.set(runId, gate); }
  /** The certified create task the worker handed over, in order (before each action and before End). */
  readonly ownCreateTasks: Array<{ runId: string; taskId: string | null }> = [];
  setStudioOwnCreateTask(runId: string, taskId: string | null): void { this.ownCreateTasks.push({ runId, taskId }); }
  /** The exchange the scripted observations show the create's research task bound to (null: unbound). */
  researchExchangeId: string | null = null;
  /** Every action input the worker passed, in order. */
  readonly actionInputs: Array<Record<string, unknown>> = [];

  constructor(readonly run: RunRecord) {}

  #bridge(kind: string, receipt: Record<string, unknown>): DriverEvent {
    const json = canonicalJson(receipt);
    return { kind: "studio.bridge_receipt", source: "canonical", payload: { exchange_id: EXCHANGE_UUID, source: kind === "guard" ? "service" : "bridge", seq: receipt.seq ?? 0, kind, received_at: new Date().toISOString(), receipt_json: json, receipt_sha256: sha256(json) }, dedupeKey: `studio-bridge:${EXCHANGE_UUID}:${receipt.seq}:${sha256(json)}` };
  }

  #outcome(purpose: string, tasks: Array<Record<string, unknown>>, artifacts: Array<Record<string, unknown>> = []): DriverEvent {
    // As the real driver records it: these scripted tasks carry no exchange id, so none is bound to the run.
    const payload = { purpose, operation_id: purpose, join: { basis: "native_task_exchange_id", run_exchange_id: EXCHANGE_UUID, bound_task_ids: [], other_exchange_task_count: 0, unbound_task_count: tasks.length }, tasks: tasks.map((task) => ({ exchange_id: null, ...task })), artifacts };
    return { kind: "studio.outcome.observed", source: "canonical", payload, dedupeKey: key(`studio-outcome:${this.run.id}`, payload) };
  }

  hasSession(runId: string): boolean { return this.sessions.has(runId); }

  async readStudioCalls(run: RunRecord, purpose: "baseline" | "after", operationId: string, stepId: string | null, after: string | null = null): Promise<DriverEvent> {
    this.calls.push(`calls:${purpose}`);
    this.callsReads.push({ purpose, operationId, after });
    const answer = this.callsAnswer(run.id, purpose, after);
    const base = { schema: "sophia_voice_lab_studio_exchange_calls_v1", purpose, operation_id: operationId, step_id: stepId, exchange_id: EXCHANGE_UUID, after, read_id: randomUUID() };
    const payload = answer.status === "available"
      ? { ...base, status: "available", reason: null, http_status: 200, read_at: answer.read_at, settled: answer.calls.every((call) => call.answered_at !== null), attempts: 1, max_seq: Number(answer.calls.at(-1)?.seq ?? 0), calls: answer.calls }
      : { ...base, status: "unavailable", reason: answer.reason, http_status: answer.http_status, read_at: null, settled: false, attempts: 0, max_seq: null, calls: [] };
    return { kind: "studio.exchange.calls_read", source: "canonical", payload, dedupeKey: purpose === "baseline" ? `studio-calls-baseline:${run.id}:${operationId}` : `studio-calls-read:${run.id}:${payload.read_id}` };
  }
  async readiness() { return { ok: true, detail: "fixture", engine: "chromium", version: "fixture" }; }
  async verifyTarget(): Promise<DriverStartResult> { return { observedDeployment: { frontend: STUDIO_SHA, backend: API_SHA } as never, events: [] }; }
  async rotate(): Promise<never> { throw new Error("unsupported"); }
  async continueSession() { return []; }
  async quiesceD02Provider(): Promise<never> { throw new Error("unsupported"); }
  async drain() { return []; }
  async cancel(runId: string) { this.sessions.delete(runId); }
  async close() { return undefined; }
  async studioReadiness() { return { ok: true }; }
  adoptStudioJoin(_runId: string, join: DurableStudioJoin): void { this.adopted = join; }

  async start(run: RunRecord, _grant: unknown, _binding: unknown, _stage: unknown, acquired: (event: DriverEvent, runtime: { engine: string; version: string }) => Promise<void>, onDurable?: (events: DriverEvent[]) => Promise<void>): Promise<DriverStartResult> {
    this.calls.push("start");
    const epoch = sha256(`epoch:${run.id}`);
    const acquisition: DriverEvent = { kind: "harness.browser_process_acquired", source: "browser", payload: { schema: "sophia_voice_lab_browser_process_ownership_v1", voice_lab_run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), process_id_sha256: sha256("pid"), browser_boot_id_sha256: sha256("boot"), execution_epoch_sha256: epoch, started_at: new Date().toISOString(), one_process_per_run: true, raw_process_id_excluded: true }, dedupeKey: `browser-process:${epoch}` };
    await acquired(acquisition, { engine: "chromium", version: "fixture" });
    this.sessions.add(run.id);
    this.seq = 0;
    this.ordinal = 0;
    const binding = computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: run.scenarioId!, scenarioVersion: run.scenarioVersion! });
    const mic = canonicalJson(pageReceipt(run, "mic_published", Date.now()));
    const intent: DriverEvent = { kind: "studio.exchange.speak_requested", source: "canonical", payload: { grant_id: GRANT_UUID, run_binding_sha256: binding, write_ahead: true }, dedupeKey: `studio-speak-requested:${run.id}` };
    await onDurable?.([intent]);
    this.durable.push(intent.kind);
    const opened: DriverEvent = { kind: "studio.exchange.opened", source: "canonical", payload: { exchange_id: EXCHANGE_UUID, grant_id: GRANT_UUID, run_binding_sha256: binding, opened_at_lab_ms: Date.now(), write_ahead: true }, dedupeKey: `studio-exchange-opened:${run.id}:${EXCHANGE_UUID}` };
    await onDurable?.([opened]);
    this.durable.push(opened.kind);
    const grantJson = canonicalJson(evidenceGrant(run));
    return { observedDeployment: { frontend: STUDIO_SHA, backend: API_SHA } as never, events: [
      acquisition,
      { kind: "studio.deployment.identity", source: "canonical", payload: { phase: "startup", api: { status: "observed", commit: API_SHA }, studio: { status: "observed", commit: STUDIO_SHA } }, dedupeKey: `studio-identity:${run.id}:startup` },
      { kind: "studio.auth.session_established", source: "canonical", payload: { principal_bound: true, expires_in_s: this.sessionExpiresInS }, dedupeKey: `studio-auth:${run.id}` },
      { kind: "harness.media_stream_issued", source: "browser", payload: { replacement_active: true, track_id_sha256s: [sha256(LAB_TRACK_ID)] }, dedupeKey: `issued:${run.id}` },
      { kind: "studio.page_receipt", source: "product", payload: { event: "mic_published", receipt_json: mic, receipt_sha256: sha256(mic) }, dedupeKey: `studio-page:${run.id}:1` },
      { kind: "studio.grant_gate.passed", source: "browser", payload: { grant_id: GRANT_UUID, run_binding_sha256: binding }, dedupeKey: `gate:${run.id}` },
      intent, opened,
      { kind: "studio.exchange.ownership", source: "canonical", payload: { exchange_id: EXCHANGE_UUID, status: "proven", reason: null, grant_id: GRANT_UUID, run_binding_matches: true }, dedupeKey: `ownership:${run.id}` },
      { kind: "studio.bridge_grant", source: "canonical", payload: { exchange_id: EXCHANGE_UUID, exchange_state: "open", grant_json: grantJson, grant_sha256: sha256(grantJson) }, dedupeKey: `grant:${run.id}` },
      this.#bridge("provider", providerReceipt(run, this.seq++, "ready")),
    ] };
  }

  async schedule(run: RunRecord, operationId: string): Promise<DriverOperationResult> {
    this.calls.push(`schedule:${operationId}`);
    this.ordinal += 1;
    const at = (offset: number) => ({ _capture_provenance: { source: "voice-lab-init", observed_at: new Date(Date.now() + offset).toISOString() } });
    return { receipt: { product: { scheduled: true } }, events: [
      { kind: "audio.input.scheduled", source: "browser", payload: { operation_id: operationId, ...at(-10) }, dedupeKey: `scheduled:${operationId}` },
      { kind: "audio.input.started", source: "browser", payload: { operation_id: operationId, ...at(0) }, dedupeKey: `started:${operationId}` },
      { kind: "audio.input.completed", source: "browser", payload: { operation_id: operationId, ...at(5_000) }, dedupeKey: `completed:${operationId}` },
      this.#bridge("input_window", inputWindow(run, this.seq++, this.ordinal, 20_000)),
      this.#bridge("input_turn", inputTurn(run, this.seq++, this.ordinal)),
      ...(this.ordinal === 1 ? [{ kind: "studio.page_receipt", source: "product" as const, payload: (() => { const json = canonicalJson(pageReceipt(run, "sophia_playback", Date.now() + 100, { phase: "playing" })); return { event: "sophia_playback", receipt_json: json, receipt_sha256: sha256(json) }; })(), dedupeKey: `studio-page:${run.id}:playback` }] : []),
      this.#bridge("output_reply", outputReply(run, this.seq++, this.ordinal, Date.now() + 200)),
    ] };
  }

  async studioAction(run: RunRecord, operationId: string, input: Record<string, unknown>): Promise<DriverOperationResult> {
    this.calls.push(`action:${String(input.action)}`);
    this.actionInputs.push({ ...input });
    const task = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ task_id: id, kind, state: "running", phase: "running", created_at: new Date().toISOString(), focus: false, research: null, design: null, outputs: [], ...extra });
    if (input.action === "observe") {
      const phase = input.for_step === "hold" ? "held" : input.for_step === "stop" ? "stopped" : "running";
      return { receipt: { action: "observe", performed: false, status: "observed" }, events: [this.#outcome(`g7.${String(input.for_step)}`, [task(RESEARCH, "research", { phase, exchange_id: this.researchExchangeId })])] };
    }
    if (input.action === "leave_and_return") {
      const published = canonicalJson(pageReceipt(run, "mic_published", Date.now() + 1));
      return { receipt: { action: "leave_and_return", performed: true, status: "returned" }, events: [
        { kind: "studio.room.left", source: "browser", payload: { basis: "ui_leave", operation_id: operationId }, dedupeKey: `left:${operationId}` },
        { kind: "studio.page_receipt", source: "product", payload: { event: "mic_published", receipt_json: published, receipt_sha256: sha256(published) }, dedupeKey: `studio-page:${run.id}:return` },
        { kind: "studio.room.rejoined", source: "browser", payload: { lab_track_republished: true, operation_id: operationId }, dedupeKey: `rejoined:${operationId}` },
      ] };
    }
    if (input.action === "section_revision" || input.action === "stale_edit") {
      const revision = input.action === "section_revision";
      const payload = { purpose: input.action, operation_id: operationId, target_join: "uncertain", requested: true, status: revision ? "admitted" : "refused", http_status: revision ? 202 : 409, code: revision ? null : "stale_revision", task_id: revision ? EDIT : null, version_id: VERSION_1, instruction_sha256: typeof input.instruction === "string" ? sha256(input.instruction) : null };
      const events: DriverEvent[] = [{ kind: "studio.action.html_edit", source: "canonical", payload, dedupeKey: key(`edit:${run.id}`, payload) }];
      if (revision) events.push(this.#outcome("g7.section_revision", [task(EDIT, "design", { state: "succeeded", design: { state: "published", mode: "edit", artifact_id: ARTIFACT, published_version_id: VERSION_2 } })], [{ artifact_id: ARTIFACT, version_id: VERSION_2, task_id: EDIT, status: "verified", downloaded_sha256: sha256("v2"), hashes_agree: true }]));
      return { receipt: { action: input.action, performed: true, status: payload.status, http_status: payload.http_status, code: payload.code, task_id: payload.task_id }, events };
    }
    const payload = { operation_id: operationId, requested: true, status: "committed", entry_id: "c0000000-0000-4000-8000-0000000000c1", entry_bound_exchange_id: EXCHANGE_UUID, http_status: 202, code: null, receipt_operation: "withdraw_note" };
    return { receipt: { action: "withdrawal", performed: true, status: "committed" }, events: [
      { kind: "studio.action.withdrawal", source: "canonical", payload, dedupeKey: key(`withdrawal:${run.id}`, payload) },
      this.#outcome("g7.withdrawal", [task(DESIGN, "design", { design: { state: "cancelled", mode: "create", artifact_id: ARTIFACT, published_version_id: VERSION_1 } })]),
    ] };
  }

  async end(run: RunRecord): Promise<DriverEndResult> {
    this.calls.push("end");
    this.sessions.delete(run.id);
    const late = this.lateSessionClosed ? [] : this.closing(run);
    return { artifacts: [], events: [
      this.#outcome("final", [{ task_id: DESIGN, kind: "design", state: "succeeded", phase: "result_ready", design: { state: "published", mode: "create", artifact_id: ARTIFACT, published_version_id: VERSION_1 } }], [{ artifact_id: ARTIFACT, version_id: VERSION_1, task_id: DESIGN, status: "verified", downloaded_sha256: sha256("v1"), hashes_agree: true }]),
      this.endExchangeConfirmed
        ? { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "api_end", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "proven", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `ended:${run.id}` }
        : { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: false, status: "unavailable", basis: "ownership_unproven_not_touched", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "unavailable", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `ended-unproven:${run.id}` },
      ...late,
      { kind: "studio.deployment.identity", source: "canonical", payload: { phase: "final", api: { status: "observed", commit: API_SHA }, studio: { status: "observed", commit: STUDIO_SHA } }, dedupeKey: `studio-identity:${run.id}:final` },
      { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted" }, dedupeKey: `signed-out:${run.id}` },
      { kind: "cleanup.browser_context_closed", source: "browser", payload: { schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1", close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true, browser_process_disconnected: true }, dedupeKey: `cleanup:${run.id}:browser` },
    ] };
  }

  /** The bridge's last receipts: the provider's close and the session's. */
  closing(run: RunRecord): DriverEvent[] {
    return [
      this.#bridge("provider", providerReceipt(run, this.seq, "closed")),
      this.#bridge("session_closed", sessionClosed(run, this.seq + 1, { windows: this.ordinal, turns: this.ordinal, replies: this.ordinal })),
    ];
  }

  async refreshStudioEvidence(run: RunRecord, join: DurableStudioJoin): Promise<DriverEvent[]> {
    this.calls.push(`refresh:${join.exchangeId}`);
    // Like the real driver: only the refresh's own fresh session is revoked (scope=local).
    const revoked = this.refreshRevokeConfirmed
      ? { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "local", confirmed: true, http_status: 204, basis: "local_logout_accepted", status: "revoked", attempts: 1, purpose: "evidence_refresh" }
      : { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "local", confirmed: false, http_status: 503, basis: "rejected", status: "unrevoked", attempts: 3, purpose: "evidence_refresh" };
    return [...this.closing(run), { kind: "studio.evidence.session_revoked", source: "canonical", payload: revoked, dedupeKey: `refresh-session-revoked:${run.id}:${String(revoked.status)}` }];
  }

  /** Abort with an ownership-proven exchange: the real driver ends it, signs out and closes the browser. */
  async abort(run: RunRecord, reason: string): Promise<DriverEndResult> {
    this.calls.push(`abort:${reason}`);
    const had = this.sessions.has(run.id);
    this.sessions.delete(run.id);
    if (!had) return { events: [], artifacts: [] };
    return { artifacts: [], events: [
      { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "api_end", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "proven", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `abort-ended:${run.id}` },
      { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted" }, dedupeKey: `abort-signed-out:${run.id}` },
      { kind: "cleanup.browser_context_closed", source: "browser", payload: { schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1", close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true, browser_process_disconnected: true, reason }, dedupeKey: `cleanup:${run.id}:browser` },
    ] };
  }
  async recover(binding: { id: string }): Promise<DriverEndResult> {
    this.calls.push("recover");
    await this.recoverHook?.(binding.id);
    const events = this.recoverResult(binding.id);
    // Like the real driver: the global logout goes out only while the fence's marker is still held.
    const gate = this.signOutGates.get(binding.id);
    if (gate !== undefined) this.gateChecks += 1;
    const held = gate === undefined ? true : await gate();
    if (!held) {
      this.withheldLogouts.push(binding.id);
      return { artifacts: [], events: events.map((event) => event.kind === "studio.cleanup.signed_out" && event.payload.scope === "global"
        ? { ...event, payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "local", confirmed: true, http_status: 204, basis: "sign_out_fence_not_held", global_sign_out_withheld: true, sign_out_id: randomUUID() }, dedupeKey: `withheld:${binding.id}:${randomUUID()}` }
        : event) };
    }
    if (events.some((event) => event.kind === "studio.cleanup.signed_out" && event.payload.scope === "global")) this.globalLogouts.push(binding.id);
    return { events, artifacts: [] };
  }
}

export const SCRIPTED_IDS = { ARTIFACT, VERSION_1, VERSION_2, DESIGN, EDIT, RESEARCH };
export function newIdempotencyKey(prefix: string): string { return `${prefix}-${randomUUID()}`; }
