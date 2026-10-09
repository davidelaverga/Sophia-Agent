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
  session = false;
  seq = 0;
  ordinal = 0;
  lateSessionClosed = false;
  durable: string[] = [];
  readonly calls: string[] = [];
  adopted: DurableStudioJoin | null = null;
  recoverResult: (runId: string) => DriverEvent[] = () => [];
  /** The Supabase `expires_in` the start's password grant answered with (seconds). */
  sessionExpiresInS = 3_600;

  constructor(readonly run: RunRecord) {}

  #bridge(kind: string, receipt: Record<string, unknown>): DriverEvent {
    const json = canonicalJson(receipt);
    return { kind: "studio.bridge_receipt", source: "canonical", payload: { exchange_id: EXCHANGE_UUID, source: kind === "guard" ? "service" : "bridge", seq: receipt.seq ?? 0, kind, received_at: new Date().toISOString(), receipt_json: json, receipt_sha256: sha256(json) }, dedupeKey: `studio-bridge:${EXCHANGE_UUID}:${receipt.seq}:${sha256(json)}` };
  }

  #outcome(purpose: string, tasks: Array<Record<string, unknown>>, artifacts: Array<Record<string, unknown>> = []): DriverEvent {
    const payload = { purpose, operation_id: purpose, join: { basis: "actor_and_time_window", status: "uncertain", missing_product_field: "NativeTask.exchangeId" }, tasks, artifacts };
    return { kind: "studio.outcome.observed", source: "canonical", payload, dedupeKey: key(`studio-outcome:${this.run.id}`, payload) };
  }

  hasSession(): boolean { return this.session; }
  async readiness() { return { ok: true, detail: "fixture", engine: "chromium", version: "fixture" }; }
  async verifyTarget(): Promise<DriverStartResult> { return { observedDeployment: { frontend: STUDIO_SHA, backend: API_SHA } as never, events: [] }; }
  async rotate(): Promise<never> { throw new Error("unsupported"); }
  async continueSession() { return []; }
  async quiesceD02Provider(): Promise<never> { throw new Error("unsupported"); }
  async drain() { return []; }
  async cancel() { this.session = false; }
  async close() { return undefined; }
  async studioReadiness() { return { ok: true }; }
  adoptStudioJoin(_runId: string, join: DurableStudioJoin): void { this.adopted = join; }

  async start(run: RunRecord, _grant: unknown, _binding: unknown, _stage: unknown, acquired: (event: DriverEvent, runtime: { engine: string; version: string }) => Promise<void>, onDurable?: (events: DriverEvent[]) => Promise<void>): Promise<DriverStartResult> {
    this.calls.push("start");
    const epoch = sha256(`epoch:${run.id}`);
    const acquisition: DriverEvent = { kind: "harness.browser_process_acquired", source: "browser", payload: { schema: "sophia_voice_lab_browser_process_ownership_v1", voice_lab_run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), process_id_sha256: sha256("pid"), browser_boot_id_sha256: sha256("boot"), execution_epoch_sha256: epoch, started_at: new Date().toISOString(), one_process_per_run: true, raw_process_id_excluded: true }, dedupeKey: `browser-process:${epoch}` };
    await acquired(acquisition, { engine: "chromium", version: "fixture" });
    this.session = true;
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
    const task = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ task_id: id, kind, state: "running", phase: "running", created_at: new Date().toISOString(), focus: false, research: null, design: null, outputs: [], ...extra });
    if (input.action === "observe") {
      const phase = input.for_step === "hold" ? "held" : input.for_step === "stop" ? "stopped" : "running";
      return { receipt: { action: "observe", performed: false, status: "observed" }, events: [this.#outcome(`g7.${String(input.for_step)}`, [task(RESEARCH, "research", { phase })])] };
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
    this.session = false;
    const late = this.lateSessionClosed ? [] : this.closing(run);
    return { artifacts: [], events: [
      this.#outcome("final", [{ task_id: DESIGN, kind: "design", state: "succeeded", phase: "result_ready", design: { state: "published", mode: "create", artifact_id: ARTIFACT, published_version_id: VERSION_1 } }], [{ artifact_id: ARTIFACT, version_id: VERSION_1, task_id: DESIGN, status: "verified", downloaded_sha256: sha256("v1"), hashes_agree: true }]),
      { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "ui_end", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "proven", verified_by: "member_snapshot" }, dedupeKey: `ended:${run.id}` },
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
    return [...this.closing(run), { kind: "studio.evidence.session_revoked", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "local", confirmed: true, http_status: 204, basis: "local_logout_accepted", purpose: "evidence_refresh" }, dedupeKey: `refresh-session-revoked:${run.id}` }];
  }

  /** Abort with an ownership-proven exchange: the real driver ends it, signs out and closes the browser. */
  async abort(run: RunRecord, reason: string): Promise<DriverEndResult> {
    this.calls.push(`abort:${reason}`);
    const had = this.session;
    this.session = false;
    if (!had) return { events: [], artifacts: [] };
    return { artifacts: [], events: [
      { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "api_end", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "proven", verified_by: "member_snapshot" }, dedupeKey: `abort-ended:${run.id}` },
      { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted" }, dedupeKey: `abort-signed-out:${run.id}` },
      { kind: "cleanup.browser_context_closed", source: "browser", payload: { schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1", close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true, browser_process_disconnected: true, reason }, dedupeKey: `cleanup:${run.id}:browser` },
    ] };
  }
  async recover(binding: { id: string }): Promise<DriverEndResult> { this.calls.push("recover"); return { events: this.recoverResult(binding.id), artifacts: [] }; }
}

export const SCRIPTED_IDS = { ARTIFACT, VERSION_1, VERSION_2, DESIGN, EDIT, RESEARCH };
export function newIdempotencyKey(prefix: string): string { return `${prefix}-${randomUUID()}`; }
