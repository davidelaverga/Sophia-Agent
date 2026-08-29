import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import pino, { type Logger } from "pino";

import { assertAudioByteLimit, parseWav, type AudioResolver } from "./audio.js";
import { hasExactFinalizationEnvelope, type D02BrowserContextBinding, type D02ProductCleanupAcknowledgement, type VoiceBrowserDriver } from "./browser-driver.js";
import { BUNDLED_FIXTURE_MANIFEST_SHA256, type VoiceLabConfig } from "./config.js";
import { D02GatewayContinuityObservationReceiptSchema, D02GatewaySettlementReceiptSchema } from "./d02-gateway.js";
import { TERMINAL_RUN_STATES, VoiceLabError, initialVerdicts, labError, type EvidenceRef, type LabError, type RunRecord, type RunState, type SuiteRecord, type Verdicts } from "./domain.js";
import type { ClaimedOperation, RollingAdmissionLimits, VoiceLabLedger } from "./ledger.js";
import { PostgresVoiceLabLedger } from "./postgres-ledger.js";
import { pkceS256 } from "./oauth.js";
import { CapabilityCodec, StaticBearerAuthenticator, assertNoSecret, canonicalRequestHash, redact, requireScope, sha256 } from "./security.js";
import { validateAllowedOrigin } from "./security.js";
import { D02BrowserContinuityProofSchema, assertFreshProductAdmissionProof, reserveAudioInput, toolInputSchemas, validateAudioInputLimit, type FixtureSummary } from "./service.js";
import { transitionRun } from "./state-machine.js";
import { createWorkerBootIdentity, createWorkerHeartbeatAttestation, type WorkerBootIdentity } from "./worker-heartbeat.js";

interface ActiveLease { epoch: number; }
interface D02WorkerShutdownArm {
  runId: string;
  terminationRequestIdSha256: string;
  cleanupObligationIdSha256: string;
  lostWorkerIdSha256: string;
  lostBrowserLeaseEpoch: number;
  browserContextIdSha256: string;
  providerSessionIdSha256: string;
  providerAdmissionIdSha256: string;
  providerConnectionEpoch: number;
  frozenProviderConnectionEpochs: number[];
  renderActionRequestSha256: string;
  gatewayFreezeRequestSha256: string;
  gatewayFreezeEventSeq: number;
  commandEventSeq: number;
  renderDispatchClaimSha256: string;
  renderDispatchClaimEventSeq: number;
}
const D02_PRE_DISPATCH_SHUTDOWN_WAIT_MS = 20_000;
const D02_PRE_DISPATCH_SHUTDOWN_POLL_MS = 100;
export const WORKER_HEARTBEAT_INTERVAL_MS = 2_000;
export const WORKER_HEARTBEAT_BROWSER_READINESS_TIMEOUT_MS = 5_000;
const gzipAsync = promisify(gzip);

export const S01_FRONTEND_GRANT_VARIANTS = ["missing", "expired", "wrong_audience", "wrong_operation", "wrong_principal", "wrong_run", "ordinary_user"] as const;
export const S01_OAUTH_VARIANTS = ["oauth_missing", "oauth_invalid", "oauth_insufficient_fault_scope", "oauth_resource_mismatch", "oauth_authorization_code_replay"] as const;
export const S02_VALIDATION_VARIANTS = [
  "unknown_fields", "malformed_id", "malformed_sha", "text_limit", "fixture_metadata_bytes", "fixture_metadata_duration",
  "unsupported_fixture", "unsupported_scenario", "http_origin", "unsupported_target_path", "unsupported_target_query",
  "unsupported_target_origin", "redirect_origin", "invalid_capture_policy", "malformed_wav", "oversized_audio",
] as const;
export const S02_HTTP_VARIANTS = [
  "unknown_fields", "malformed_id", "malformed_sha", "text_limit", "unsupported_fixture", "unsupported_scenario", "http_origin",
  "unsupported_target_path", "unsupported_target_query", "unsupported_target_origin", "redirect_origin",
  "invalid_capture_policy", "deep_json", "malformed_json", "oversized_json",
] as const;
export const S02_MCP_BOUNDARY_PROBE_SCHEMA = "sophia_voice_lab_s02_mcp_boundary_probe_v1" as const;
type S02HttpVariant = typeof S02_HTTP_VARIANTS[number];
type S02RequestBodyKind = "parsed_tool_call" | "bounded_deep_json" | "malformed_json" | "oversized_json";
interface S02HttpProbeExpectation {
  requestContract: {
    schema: "sophia_voice_lab_s02_mcp_request_v1";
    method: "POST";
    path: "/mcp";
    content_type: "application/json";
    body_kind: S02RequestBodyKind;
    jsonrpc_method: "tools/call" | null;
    tool_name: "start_voice_run" | "speak" | "get_capabilities" | null;
  };
  httpStatus: 200 | 400 | 413;
  errorCode: string;
  auditAction: "mcp.authenticate" | "mcp.request" | "mcp.body";
  auditOutcome: "allowed" | "denied";
  auditUsesBoundedFallback: boolean;
  auditErrorClass: string | null;
}
interface S02ResourceSnapshot {
  active_run_count: number;
  operation_count: number;
  run_event_cursor: number;
  input_mutation_event_count: number;
  browser_context_count: number;
  canonical_session_count: number;
  provider_session_count: number;
}

const S02_HTTP_EXPECTATIONS: Readonly<Record<S02HttpVariant, Omit<S02HttpProbeExpectation, "requestContract"> & { bodyKind: S02RequestBodyKind; toolName: S02HttpProbeExpectation["requestContract"]["tool_name"] }>> = {
  unknown_fields: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "MCP_INVALID_ARGUMENTS", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  malformed_id: { bodyKind: "parsed_tool_call", toolName: "speak", httpStatus: 200, errorCode: "MCP_INVALID_ARGUMENTS", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  malformed_sha: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "MCP_INVALID_ARGUMENTS", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  text_limit: { bodyKind: "parsed_tool_call", toolName: "speak", httpStatus: 200, errorCode: "TEXT_TOO_LARGE", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  unsupported_fixture: { bodyKind: "parsed_tool_call", toolName: "speak", httpStatus: 200, errorCode: "FIXTURE_NOT_FOUND", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  unsupported_scenario: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "MCP_INVALID_ARGUMENTS", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  http_origin: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "TARGET_NOT_ALLOWED", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  unsupported_target_path: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "TARGET_NOT_ALLOWED", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  unsupported_target_query: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "TARGET_NOT_ALLOWED", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  unsupported_target_origin: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "TARGET_NOT_ALLOWED", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  redirect_origin: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "TARGET_NOT_ALLOWED", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  invalid_capture_policy: { bodyKind: "parsed_tool_call", toolName: "start_voice_run", httpStatus: 200, errorCode: "MCP_INVALID_ARGUMENTS", auditAction: "mcp.authenticate", auditOutcome: "allowed", auditUsesBoundedFallback: false, auditErrorClass: null },
  deep_json: { bodyKind: "bounded_deep_json", toolName: "get_capabilities", httpStatus: 400, errorCode: "ARGUMENT_BOUNDS", auditAction: "mcp.request", auditOutcome: "denied", auditUsesBoundedFallback: true, auditErrorClass: "ARGUMENT_BOUNDS" },
  malformed_json: { bodyKind: "malformed_json", toolName: null, httpStatus: 400, errorCode: "MALFORMED_JSON", auditAction: "mcp.body", auditOutcome: "denied", auditUsesBoundedFallback: true, auditErrorClass: "MALFORMED_JSON" },
  oversized_json: { bodyKind: "oversized_json", toolName: "get_capabilities", httpStatus: 413, errorCode: "BODY_TOO_LARGE", auditAction: "mcp.body", auditOutcome: "denied", auditUsesBoundedFallback: true, auditErrorClass: "BODY_TOO_LARGE" },
};

export function s02HttpProbeExpectation(variant: S02HttpVariant): S02HttpProbeExpectation {
  const expectation = S02_HTTP_EXPECTATIONS[variant];
  return {
    requestContract: {
      schema: "sophia_voice_lab_s02_mcp_request_v1",
      method: "POST",
      path: "/mcp",
      content_type: "application/json",
      body_kind: expectation.bodyKind,
      jsonrpc_method: expectation.bodyKind === "malformed_json" ? null : "tools/call",
      tool_name: expectation.toolName,
    },
    httpStatus: expectation.httpStatus,
    errorCode: expectation.errorCode,
    auditAction: expectation.auditAction,
    auditOutcome: expectation.auditOutcome,
    auditUsesBoundedFallback: expectation.auditUsesBoundedFallback,
    auditErrorClass: expectation.auditErrorClass,
  };
}

export class VoiceLabWorker {
  readonly #activeLeases = new Map<string, ActiveLease>();
  readonly #frontendCapabilities: CapabilityCodec;
  readonly #workerBootIdentity: WorkerBootIdentity;
  readonly logger: Logger;
  #stopping = false;
  #workerHeartbeatSequence = 0;
  #workerHeartbeatLoopPromise: Promise<void> | null = null;
  #workerHeartbeatFirstAttemptPromise: Promise<void> | null = null;
  #resolveWorkerHeartbeatFirstAttempt: (() => void) | null = null;
  #wakeWorkerHeartbeatLoop: (() => void) | null = null;
  #loopPromise: Promise<void> | null = null;
  #currentOperationAbort: AbortController | null = null;
  #currentOperationRunId: string | null = null;
  readonly #d02ShutdownArms = new Map<string, D02WorkerShutdownArm>();
  readonly #d02ShutdownsInFlight = new Map<string, Promise<void>>();
  readonly #d02PreDispatchPauses = new Set<string>();

  constructor(
    readonly workerId: string,
    readonly ledger: VoiceLabLedger,
    readonly config: VoiceLabConfig,
    readonly audio: AudioResolver,
    readonly driver: VoiceBrowserDriver,
    readonly capabilities: CapabilityCodec,
    logger?: Logger,
    readonly scenarioFetch: typeof fetch = fetch,
    readonly targetIdentity: () => Promise<Record<string, unknown> & { ok: boolean }> = async () => config.nodeEnv === "test" && config.readinessTarget === null
      ? ({ ok: true, status: "test_target_not_configured" })
      : ({ ok: false, status: "target_probe_not_injected" }),
    workerBootIdentity: WorkerBootIdentity = createWorkerBootIdentity(workerId),
  ) {
    this.logger = logger ?? pino({ level: config.logLevel, base: { service: "sophia-voice-lab-worker", worker_id: workerId } });
    this.#frontendCapabilities = new CapabilityCodec(config.grantSecret, config.capabilityIssuer, config.capabilityTtlSeconds);
    this.#workerBootIdentity = workerBootIdentity;
  }

  run(): Promise<void> {
    if (this.#loopPromise) return this.#loopPromise;
    this.#startWorkerHeartbeatLoop();
    const firstHeartbeatAttempt = this.#workerHeartbeatFirstAttemptPromise ?? Promise.resolve();
    this.#loopPromise = firstHeartbeatAttempt.then(() => this.#runLoop()).finally(async () => {
      this.#stopping = true;
      this.#wakeWorkerHeartbeatLoop?.();
      await this.#workerHeartbeatLoopPromise;
      this.#loopPromise = null;
    });
    return this.#loopPromise;
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopping) {
      const worked = await this.runOnce().catch((error) => { this.logger.error({ error: safeError(error) }, "worker iteration failed"); return false; });
      await this.maintainSessions().catch((error) => this.logger.error({ error: safeError(error) }, "browser maintenance failed"));
      if (!worked) await delay(this.config.workerPollMs);
    }
  }

  stop(): void {
    this.#stopping = true;
    this.#wakeWorkerHeartbeatLoop?.();
  }

  async close(): Promise<void> {
    this.stop();
    await this.#workerHeartbeatLoopPromise;
    let d02QuiescenceFailure: unknown = null;
    let d02ArmValidationFailure: unknown = null;
    for (const runId of this.#activeLeases.keys()) {
      await this.#resolveD02WorkerShutdownArm(runId).then((arm) => {
        if (arm) this.#d02ShutdownArms.set(runId, arm);
      }).catch((error) => {
        this.logger.error({ run_id: runId, error: safeError(error) }, "D02 shutdown arm validation failed closed");
        d02ArmValidationFailure ??= error;
      });
    }
    // An indeterminate source chain cannot safely fall through to generic
    // cancellation: doing so could destroy the exact page whose durable D02
    // command/dispatch proof merely failed to load during shutdown.
    if (d02ArmValidationFailure !== null) throw d02ArmValidationFailure;
    // A committed local intent is already a product/browser mutation fence,
    // even though it is not yet shutdown authority. Keep the exact lease alive
    // while the Gateway freeze, signed command, and global dispatch converge.
    // A null arm must never fall through to generic page destruction here.
    const preDispatchRuns = [...this.#activeLeases.keys()].filter((runId) =>
      this.#d02PreDispatchPauses.has(runId) && !this.#d02ShutdownArms.has(runId));
    await Promise.all(preDispatchRuns.map(async (runId) => {
      try {
        const arm = await this.#awaitD02PreDispatchShutdownArm(runId, D02_PRE_DISPATCH_SHUTDOWN_WAIT_MS);
        this.#d02ShutdownArms.set(runId, arm);
      } catch (error) {
        this.logger.error({ run_id: runId, error: safeError(error) }, "D02 pre-dispatch shutdown arm did not converge");
        d02ArmValidationFailure ??= error;
      }
    }));
    if (d02ArmValidationFailure !== null) throw d02ArmValidationFailure;
    const currentD02Arm = this.#currentOperationRunId === null ? undefined : this.#d02ShutdownArms.get(this.#currentOperationRunId);
    this.#currentOperationAbort?.abort(new VoiceLabError(currentD02Arm
      ? labError("BROWSER_SESSION_LOST", "The source-validated D02 worker restart quiesced the in-flight browser operation.", "harness", false, { termination_request_id_sha256: currentD02Arm.terminationRequestIdSha256, source: "worker_graceful_d02_restart" })
      : labError("WORKER_GRACEFUL_SHUTDOWN", "Worker shutdown cancelled the in-flight operation before cleanup.", "harness", true)));
    const loopDrain = this.#loopPromise ? withTimeout(this.#loopPromise, 25_000) : null;
    // Source-armed D02 cleanup starts as soon as SIGTERM is observed. Waiting
    // for a stalled maintenance iteration first would add the 25s drain budget
    // to the 20s quiescence budget and could exceed the platform grace window.
    // The in-flight map makes the operation converge with runOnce's abort path.
    const armedCleanups = [...this.#d02ShutdownArms.entries()]
      .filter(([runId]) => this.#activeLeases.has(runId))
      .map(async ([runId, arm]) => {
        await withTimeout(this.#quiesceD02Worker(runId, arm), 20_000).catch((error) => {
          this.logger.error({ run_id: runId, error: safeError(error) }, "graceful D02 run cleanup failed");
          d02QuiescenceFailure ??= error;
        });
      });
    if (armedCleanups.length > 0) await Promise.all(armedCleanups);
    if (d02QuiescenceFailure !== null) throw d02QuiescenceFailure;
    if (loopDrain) await loopDrain.catch((error) => {
      this.logger.error({ error: safeError(error) }, "worker loop did not drain cleanly");
      if (armedCleanups.length > 0) d02QuiescenceFailure ??= error;
    });
    // A source-specific close is only successful if the old loop stopped as
    // well; otherwise the signal handler must leave a non-zero, fail-closed
    // process path instead of reporting a graceful deployment exit.
    if (d02QuiescenceFailure !== null) throw d02QuiescenceFailure;
    for (const runId of [...this.#activeLeases.keys()]) {
      const arm = this.#d02ShutdownArms.get(runId) ?? await this.#resolveD02WorkerShutdownArm(runId).catch((error) => {
        this.logger.error({ run_id: runId, error: safeError(error) }, "D02 shutdown arm validation failed closed");
        d02ArmValidationFailure ??= error;
        return null;
      });
      if (d02ArmValidationFailure !== null) break;
      const cleanup = arm
        ? this.#quiesceD02Worker(runId, arm)
        : this.#terminalizeFailure(runId, labError("WORKER_GRACEFUL_SHUTDOWN", "Worker shutdown cleaned up the live synthetic run.", "harness", true), "cancelled");
      await withTimeout(cleanup, 20_000).catch((error) => {
        this.logger.error({ run_id: runId, error: safeError(error) }, "graceful run cleanup failed");
        if (arm && d02QuiescenceFailure === null) d02QuiescenceFailure = error;
      });
    }
    // A D02 provider acknowledgement failure must not fall through to the
    // driver's generic context sweep.  That would destroy the only page able
    // to finish the canonical close/abort receipt POST while still claiming
    // the source-specific shutdown failed closed.
    if (d02ArmValidationFailure !== null) throw d02ArmValidationFailure;
    if (d02QuiescenceFailure !== null) throw d02QuiescenceFailure;
    await this.driver.close();
  }

  async runOnce(): Promise<boolean> {
    const claimed = await this.ledger.claimNextOperation(this.workerId, this.config.operationLeaseSeconds);
    if (!claimed) return false;
    await this.ledger.markOperationExecuting(claimed.operation.id, this.workerId, claimed.operation.leaseEpoch);
    const controller = new AbortController();
    this.#currentOperationAbort = controller;
    this.#currentOperationRunId = claimed.run.id;
    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      void this.ledger.heartbeatOperation(claimed.operation.id, this.workerId, claimed.operation.leaseEpoch, this.config.operationLeaseSeconds)
        .then(async (owned) => {
          if (!owned) { controller.abort(new VoiceLabError(labError("LEASE_LOST", "Operation lease was lost before the next irreversible action.", "conflict", true))); return; }
          const browserLease = this.#activeLeases.get(claimed.run.id);
          if (!browserLease) return;
          const browserOwned = await this.ledger.heartbeatBrowserLease(claimed.run.id, this.workerId, browserLease.epoch, this.config.browserLeaseSeconds);
          if (!browserOwned) controller.abort(new VoiceLabError(labError("BROWSER_LEASE_LOST", "Browser lease was lost while the operation was in flight.", "conflict", true)));
        })
        .catch(() => controller.abort(new VoiceLabError(labError("LEASE_HEARTBEAT_FAILED", "Operation lease could not be renewed safely.", "harness", true))))
        .finally(() => { heartbeatInFlight = false; });
    }, leaseHeartbeatIntervalMs(this.config.operationLeaseSeconds, this.config.browserLeaseSeconds));
    heartbeat.unref();
    const deadlineSeconds = claimed.operation.type === "start" ? this.config.startOperationSeconds : claimed.operation.type === "end" ? this.config.endOperationSeconds : claimed.operation.type === "force_socket_rotation" ? this.config.faultOperationSeconds : this.config.maxOperationSeconds;
    const deadline = setTimeout(() => controller.abort(new VoiceLabError(labError("OPERATION_TIMEOUT", "Operation exceeded its bounded execution deadline and was cancelled.", "harness", true, { operation_type: claimed.operation.type, deadline_seconds: deadlineSeconds }))), deadlineSeconds * 1_000);
    deadline.unref();
    let operationSettled = false;
    try {
      const execution = this.#execute(claimed, controller.signal);
      const cancellation = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => {
        if (this.#d02ShutdownArms.has(claimed.run.id)) {
          reject(controller.signal.reason);
          return;
        }
        void this.driver.cancel(claimed.run.id, errorDetail(controller.signal.reason).code).finally(() => reject(controller.signal.reason));
      }, { once: true }));
      let result: Record<string, unknown>;
      try { result = await Promise.race([execution, cancellation]); }
      catch (error) {
        if (controller.signal.aborted) {
          if (this.#d02ShutdownArms.has(claimed.run.id)) void execution.catch(() => undefined);
          else {
            await this.driver.cancel(claimed.run.id, errorDetail(controller.signal.reason).code).catch(() => undefined);
            let interruptedExecutionError: unknown = null;
            await execution.catch((executionError) => { interruptedExecutionError = executionError; });
            throw augmentOperationTimeoutWithInterruptedDriverError(controller.signal.reason, interruptedExecutionError);
          }
          throw controller.signal.reason;
        }
        throw error;
      }
      const finalizePreResource = result._finalize_pre_resource === true;
      const finalizeEnd = result._finalize_end === true;
      if (finalizePreResource) delete result._finalize_pre_resource;
      if (finalizeEnd) delete result._finalize_end;
      assertNoSecret(result);
      await this.ledger.finishOperation(claimed.operation.id, this.workerId, claimed.operation.leaseEpoch, "succeeded", result, null);
      operationSettled = true;
      await this.ledger.appendEvent(claimed.run.id, "operation.succeeded", "worker", { operation_id: claimed.operation.id, operation_type: claimed.operation.type }, `operation:${claimed.operation.id}:succeeded`);
      if (finalizePreResource) await this.#finalizePreResourceScenario(claimed.run.id);
      if (finalizeEnd) await this.#finalizeEndRun(claimed.run.id);
    } catch (error) {
      const detail = errorDetail(error);
      if (!operationSettled) {
        await this.ledger.finishOperation(claimed.operation.id, this.workerId, claimed.operation.leaseEpoch, detail.code === "OPERATION_TIMEOUT" ? "timed_out" : "failed", null, detail).catch(() => undefined);
        await this.ledger.appendEvent(claimed.run.id, "operation.failed", "worker", { operation_id: claimed.operation.id, operation_type: claimed.operation.type, error: detail }, `operation:${claimed.operation.id}:failed`).catch(() => undefined);
      } else {
        await this.ledger.appendEvent(claimed.run.id, "evidence.finalization_failed", "worker", { operation_id: claimed.operation.id, error: detail }, `evidence:${claimed.operation.id}:finalization-failed`).catch(() => undefined);
      }
      const d02Arm = this.#d02ShutdownArms.get(claimed.run.id);
      if (d02Arm) await this.#quiesceD02Worker(claimed.run.id, d02Arm).catch((terminalError) => this.logger.error({ error: safeError(terminalError), run_id: claimed.run.id }, "D02 run quiescence failed"));
      else await this.#terminalizeFailure(claimed.run.id, detail).catch((terminalError) => this.logger.error({ error: safeError(terminalError), run_id: claimed.run.id }, "run terminalization failed"));
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      if (this.#currentOperationAbort === controller) {
        this.#currentOperationAbort = null;
        this.#currentOperationRunId = null;
      }
    }
    return true;
  }

  async maintainSessions(): Promise<void> {
    const maintenanceNow = new Date();
    for (const pending of await this.ledger.listRunsCertificationDue(maintenanceNow, 20)) {
      const error = labError("EXTERNAL_EVIDENCE_DEADLINE_EXPIRED", "The bounded external-evidence window expired before every mandatory supported assertion became machine-verifiable.", "harness", false, { deadline_at: pending.expiresAt.toISOString() });
      const verdicts: Verdicts = { ...pending.verdicts, harness: "fail", evidence: "fail" };
      let failed = await transitionRun(this.ledger, pending, "failed_harness", { verdicts, terminalError: error });
      const terminal = await this.ledger.appendEvent(failed.id, "run.failed_harness", "worker", { terminal_state: "failed_harness", terminal_reason: error.code, certification_deadline_at: pending.expiresAt.toISOString(), execution_cleanup_complete: failed.cleanupComplete }, `run:${failed.id}:failed_harness`);
      failed = await this.#freshRun(failed.id);
      await this.#saveFailureEvidence(failed, error, []);
      this.logger.warn({ run_id: failed.id, terminal_event_seq: terminal.seq }, "external evidence deadline expired");
    }
    // Retention is a second, restart-safe lifecycle. A live run can finish and
    // export once execution resources are authoritatively zero, while the
    // exact binding remains durable until the Gateway later proves deletion of
    // retained product evidence. Only then may the lab delete its own copies.
    for (const retained of await this.ledger.listRunsRetentionDue(maintenanceNow, 20)) {
      try {
        const recovery = await this.#recoverRun(retained);
        await this.#persistEvents(retained.id, recovery.events);
        const page = await this.#allEvents(retained.id);
        if (authoritativeRetentionPurged(page.events)) {
          const fresh = await this.#freshRun(retained.id);
          await this.ledger.updateRun(fresh.id, fresh.version, { retentionPurgePending: false, retentionPurgeVerifiedAt: new Date() });
        }
      } catch (error) {
        // Remote deletion truth remains "unconfirmed", but a Gateway outage
        // can never extend the signed lifetime of local transcripts/screenshots.
        // purgeExpiredRetention below deletes local content unconditionally and
        // retains only the keyed content-free tombstone.
        this.logger.error({ run_id: retained.id, error: safeError(error) }, "remote retention purge could not be confirmed before local hard deadline");
      }
    }
    await this.ledger.purgeExpiredRetention(maintenanceNow, 20);
    for (const pending of await this.ledger.listRunsPendingEvidence(10)) {
      if (pending.terminalError !== null || !["completed", "product_failed", "inconclusive_provider", "failed_harness", "authorization_failed"].includes(pending.state)) await this.#saveFailureEvidence(pending, pending.terminalError ?? labError("TERMINAL_CERTIFICATION_REVISION", "Terminal execution evidence was revised without mutating the execution decision.", "evidence"), []);
      else if (pending.scenarioId === "V-S01" || pending.scenarioId === "V-S02") await this.#finalizePreResourceScenario(pending.id);
      else await this.#finalizeEndRun(pending.id);
    }
    for (const expired of await this.ledger.listExpiredRuns(new Date(), 20)) {
      await this.#terminalizeFailure(expired.id, labError("RUN_EXPIRED", "Run exceeded its bounded TTL and was cleaned up.", "harness"), "expired");
    }
    for (const pending of await this.ledger.listRunsNeedingRecovery(10)) {
      const replacement = await this.#observeD02GracefulWorkerReplacement(pending);
      if (replacement === "awaiting_replacement") continue;
      await this.#terminalizeFailure(pending.id, pending.terminalError ?? labError("RECOVERY_PENDING", "Terminal run still requires durable zero-orphan recovery.", "harness", true), pending.state);
    }
    if (this.#killSwitchEngaged()) {
      // Accepted suites are durable scheduling intent. Engaging the kill switch
      // must quiesce that intent as well as live runs; otherwise maintenance
      // would keep allocating children that immediately fail authorization.
      for (const suite of await this.ledger.listRunnableSuites(100)) {
        await this.ledger.updateSuite(suite.id, "cancelled", suite.runIds, suite.nextScenarioIndex);
      }
    } else {
      await this.#advanceSuites();
    }
    await this.#finalizeTerminalSuites();
    for (const [runId, lease] of this.#activeLeases) {
      const current = await this.ledger.getRun(runId);
      const d02Arm = await this.#resolveD02WorkerShutdownArm(runId);
      if (d02Arm) {
        this.#d02ShutdownArms.set(runId, d02Arm);
        await this.#quiesceD02Worker(runId, d02Arm);
        continue;
      }
      if (this.#d02PreDispatchPauses.has(runId)) {
        // Gateway is already frozen, but global Render dispatch authority has
        // not committed. Preserve ownership without touching the frozen app;
        // the next maintenance pass either observes the unique dispatch claim
        // and quiesces or remains paused.
        const owned = await this.ledger.heartbeatBrowserLease(runId, this.workerId, lease.epoch, this.config.browserLeaseSeconds);
        if (!owned) {
          this.#activeLeases.delete(runId);
          const lostLease = await this.ledger.getBrowserLease(runId);
          await this.#markDriverRestart(runId, lostLease?.workerId === this.workerId && lostLease.leaseEpoch === lease.epoch ? lostLease : undefined);
        }
        continue;
      }
      if (this.#killSwitchEngaged() && current && !TERMINAL_RUN_STATES.has(current.state)) {
        await this.#terminalizeFailure(runId, labError("KILL_SWITCH_ENGAGED", "Kill switch actively terminated and recovered the live synthetic run.", "authorization", false), "cancelled");
        continue;
      }
      if (current && current.expiresAt <= new Date() && !TERMINAL_RUN_STATES.has(current.state)) {
        await this.#terminalizeFailure(runId, labError("RUN_EXPIRED", "Run exceeded its bounded TTL and was cleaned up.", "harness"), "expired");
        continue;
      }
      const owned = await this.ledger.heartbeatBrowserLease(runId, this.workerId, lease.epoch, this.config.browserLeaseSeconds);
      if (!owned || !this.driver.hasSession(runId)) {
        this.#activeLeases.delete(runId);
        // Preserve the exact owned lease even when the in-process browser
        // registry disappears before the database lease expires. Without this
        // receipt a live browser crash would be indistinguishable from an
        // unowned policy assertion during late D02 certification.
        const lostLease = await this.ledger.getBrowserLease(runId);
        await this.#markDriverRestart(runId, lostLease?.workerId === this.workerId && lostLease.leaseEpoch === lease.epoch ? lostLease : undefined);
        continue;
      }
      try {
        if (!this.#killSwitchEngaged() && current) {
          const continueGrant = await this.#mintAndVerify(current, "sophia-voice-lab-frontend", ["session:continue", "session:create", "session:read", "session:finalize"], "session:continue");
          await this.#persistEvents(runId, await this.driver.continueSession(current, continueGrant.token));
        }
        await this.#persistEvents(runId, await this.driver.drain(runId));
      }
      catch (error) {
        const armedAfterFailure = await this.#resolveD02WorkerShutdownArm(runId);
        if (armedAfterFailure) {
          this.#d02ShutdownArms.set(runId, armedAfterFailure);
          await this.#quiesceD02Worker(runId, armedAfterFailure);
        } else {
          this.#activeLeases.delete(runId);
          await this.#terminalizeFailure(runId, errorDetail(error));
        }
      }
    }
    for (const lostLease of await this.ledger.reapExpiredBrowserLeases()) await this.#markDriverRestart(lostLease.runId, lostLease);
  }

  async #advanceSuites(): Promise<void> {
    for (const suite of await this.ledger.listRunnableSuites(10)) {
      const children = (await Promise.all(suite.runIds.map((runId) => this.ledger.getRun(runId)))).filter((run): run is RunRecord => run !== null);
      if (children.some((run) => !TERMINAL_RUN_STATES.has(run.state) || !run.cleanupComplete)) continue;
      if (suite.nextScenarioIndex >= suite.definition.scenarios.length) {
        const state = suiteCertificationState(children);
        if (state === "pending") continue;
        const evidenceReady = await this.#saveSuiteEvidence(suite, children, state);
        if (evidenceReady) await this.ledger.updateSuite(suite.id, state, suite.runIds, suite.nextScenarioIndex);
        continue;
      }
      if (await this.ledger.countActiveRuns() >= 1) return;
      const index = suite.nextScenarioIndex;
      const scenario = suite.definition.scenarios[index]!;
      if (scenario.support === "typed_unsupported") {
        await this.ledger.updateSuite(suite.id, "running", suite.runIds, index + 1);
        return;
      }
      await this.#fenceSuiteAdmission(suite);
      const now = new Date();
      const runId = randomUUID();
      const operationId = randomUUID();
      const idempotencyKey = `suite:${suite.id}:${index}`;
      const operationInput = { environment: suite.definition.environment, target: suite.definition.target, scenario_id: scenario.id, scenario_version: scenario.version, capture_policy: suite.definition.capturePolicy, idempotency_key: idempotencyKey, suite_run_id: suite.id, suite_scenario_index: index };
      const run: RunRecord = {
        id: runId, callerId: suite.callerId, principalId: this.config.principalId, testRunId: randomUUID(), cleanupObligationId: randomUUID(), environment: suite.definition.environment,
        scenarioId: scenario.id, scenarioVersion: scenario.version, state: "reserved", version: 1, target: suite.definition.target,
        observedDeployment: {}, capturePolicy: suite.definition.capturePolicy, verdicts: initialVerdicts(), canonicalSessionId: null, threadId: null,
        providerSessionId: null, traceId: null, providerEpoch: null, turnId: null, latestCursor: 0,
        expiresAt: new Date(now.getTime() + this.config.maxRunSeconds * 1_000), createdAt: now, updatedAt: now, cleanupComplete: false,
        retentionPurgeDueAt: null, retentionPurgePending: false, retentionPurgeVerifiedAt: null, evidencePurgedAt: null, terminalError: null,
      };
      try {
        const created = await this.ledger.createRunWithOperation(run, { id: operationId, runId, callerId: suite.callerId, type: "start", idempotencyKey, requestHash: canonicalRequestHash(operationInput), input: operationInput }, { global: 1, caller: 1 });
        const runIds = [...new Set([...suite.runIds, created.run.id])];
        await this.ledger.updateSuite(suite.id, "running", runIds, index + 1);
        if (!created.replay) await this.ledger.appendEvent(created.run.id, "run.accepted", "worker", { operation_id: created.operation.id, suite_run_id: suite.id, suite_scenario_index: index }, `operation:${created.operation.id}:accepted`);
      } catch (error) {
        if (error instanceof VoiceLabError && error.detail.code === "CONCURRENCY_LIMIT") return;
        throw error;
      }
      // A single dedicated principal means exactly one suite child at a time.
      return;
    }
  }

  async #finalizeTerminalSuites(): Promise<void> {
    for (const suite of await this.ledger.listSuitesPendingEvidence(20)) {
      if (suite.state !== "completed" && suite.state !== "failed" && suite.state !== "cancelled") continue;
      const children = (await Promise.all(suite.runIds.map((runId) => this.ledger.getRun(runId)))).filter((run): run is RunRecord => run !== null);
      if (children.length !== suite.runIds.length || children.some((run) => !TERMINAL_RUN_STATES.has(run.state) || !run.cleanupComplete)) continue;
      await this.#saveSuiteEvidence(suite, children, suite.state);
    }
  }

  async #saveSuiteEvidence(suite: SuiteRecord, children: RunRecord[], terminalState: Extract<SuiteRecord["state"], "completed" | "failed" | "cancelled">): Promise<boolean> {
    const childRows: Array<Record<string, unknown>> = [];
    const childRefs: EvidenceRef[] = [];
    for (const scenario of suite.definition.scenarios) {
      if (scenario.support === "typed_unsupported") {
        childRows.push({ scenario_id: scenario.id, scenario_version: scenario.version, status: "typed_unsupported", certification_outcome: "typed_unsupported", certification_reason: scenario.unavailableReason, unavailable_reason: scenario.unavailableReason, run_id: null, evidence: { status: "unavailable", reason: scenario.unavailableReason } });
        continue;
      }
      const run = children.find((candidate) => candidate.scenarioId === scenario.id && candidate.scenarioVersion === scenario.version);
      if (!run) return false;
      const evidence = await this.ledger.getEvidence(run.id);
      if (!evidence && run.evidencePurgedAt === null) return false;
      if (evidence) childRefs.push(...evidence.artifactRefs.filter((reference) => reference.kind === "manifest"));
      const certification = runCertificationProjection(run.verdicts);
      childRows.push({
        scenario_id: scenario.id,
        scenario_version: scenario.version,
        status: run.state,
        run_id: run.id,
        test_run_id: run.testRunId,
        verdicts: run.verdicts,
        certification_outcome: certification.outcome,
        certification_reason: certification.reason,
        cleanup_complete: run.cleanupComplete,
        retention_purge_pending: run.retentionPurgePending,
        evidence: evidence ? { status: "available", manifest_id: evidence.manifestId, manifest_sha256: evidence.manifestSha256, schema_version: evidence.schemaVersion, references: evidence.artifactRefs } : { status: "unavailable", reason: "retention_purged", purged_at: run.evidencePurgedAt?.toISOString() ?? null },
      });
    }
    const manifestId = deterministicUuid(suite.id, `suite-terminal:${terminalState}:${suite.requestHash}`);
    const stableCreatedAt = children.map((run) => run.updatedAt).sort((left, right) => right.getTime() - left.getTime())[0] ?? suite.createdAt;
    const verdictCounts = childRows.reduce<Record<string, number>>((counts, row) => {
      const verdicts = row.verdicts as Verdicts | undefined;
      if (row.status === "typed_unsupported") counts.typed_unsupported = (counts.typed_unsupported ?? 0) + 1;
      else if (verdicts) {
        for (const dimension of ["harness", "product", "provider", "auth", "evidence"] as const) {
          const key = `${dimension}_${verdicts[dimension]}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      } else counts.harness_nonterminal_verdict = (counts.harness_nonterminal_verdict ?? 0) + 1;
      return counts;
    }, {});
    const aggregateCertification = suiteCertificationProjection(children);
    const manifest = {
      contract_version: "sophia.voice-lab.suite-evidence.v1",
      schema_version: "sophia.voice-lab.suite-evidence.v1",
      manifest_id: manifestId,
      suite_run_id: suite.id,
      terminal_state: terminalState,
      scheduling: "agent_guided_sequential",
      scenario_catalog_version: suite.definition.scenarios[0]?.version ?? null,
      environment: suite.definition.environment,
      deployment_identity: { expected: suite.definition.target.expectedDeployment },
      deployment_dependencies: { expected: suite.definition.target.expectedDependencies },
      scenario_count: suite.definition.scenarios.length,
      supported_child_count: children.length,
      typed_unsupported_count: suite.definition.scenarios.filter((scenario) => scenario.support === "typed_unsupported").length,
      verdict_counts: verdictCounts,
      certification_outcome_counts: aggregateCertification.outcome_counts,
      aggregate_certification: aggregateCertification,
      cleanup: { all_supported_children_terminal: children.every((run) => TERMINAL_RUN_STATES.has(run.state)), all_live_execution_resources_zero: children.every((run) => run.cleanupComplete), retention_pending_run_ids: children.filter((run) => run.retentionPurgePending).map((run) => run.id) },
      children: childRows,
      failures_retained: childRows.filter((row) => row.status !== "completed" && row.status !== "typed_unsupported").map((row) => ({ scenario_id: row.scenario_id, run_id: row.run_id, status: row.status, verdicts: row.verdicts })),
      product_nonpass_certifications: childRows.filter((row) => row.status !== "typed_unsupported" && row.certification_outcome !== "harness_evidence_certified_product_pass").map((row) => ({ scenario_id: row.scenario_id, run_id: row.run_id, certification_outcome: row.certification_outcome, certification_reason: row.certification_reason })),
      created_at: stableCreatedAt.toISOString(),
      human_summary: `Suite ${terminalState}; ${aggregateCertification.harness_evidence_certified_count}/${children.length} supported children have harness+evidence certification. Product outcomes: ${aggregateCertification.product_counts.pass} pass, ${aggregateCertification.product_counts.unavailable} unavailable, ${aggregateCertification.product_counts.fail} fail, ${aggregateCertification.product_counts.inconclusive} inconclusive, ${aggregateCertification.product_counts.pending} pending. Aggregate label: ${aggregateCertification.outcome_label}. ${suite.definition.scenarios.length - children.length} typed unsupported scenario entries are separate.`,
    };
    assertNoSecret(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    if (bytes.byteLength > 2_000_000) throw new VoiceLabError(labError("SUITE_EVIDENCE_TOO_LARGE", "Aggregate suite evidence exceeded the durable Postgres cap.", "evidence"));
    const digest = sha256(bytes);
    const aggregateRef: EvidenceRef = { kind: "suite_manifest", resource_id: `voice-lab://suite-evidence/${manifestId}`, sha256: digest, content_type: "application/json", byte_length: bytes.byteLength };
    await this.ledger.saveSuiteEvidence({ suiteId: suite.id, manifestId, manifestSha256: digest, schemaVersion: "sophia.voice-lab.suite-evidence.v1", bytes, artifactRefs: [aggregateRef, ...childRefs], createdAt: stableCreatedAt });
    return true;
  }

  async #heartbeatWorker(): Promise<void> {
    // Chromium launch/context/WebAudio probing is intentionally deeper than a
    // process-liveness check and Playwright does not bound every internal wait.
    // Keep the durable worker pulse alive, but fail its allocation readiness
    // closed, if that deeper probe hangs or rejects.
    const browser = await boundedBrowserReadiness(this.driver, WORKER_HEARTBEAT_BROWSER_READINESS_TIMEOUT_MS);
    const tts = this.audio.readiness();
    const fixturesReady = this.audio.summaries().length > 0;
    const observedAt = new Date();
    const heartbeatSequence = ++this.#workerHeartbeatSequence;
    const effectiveKillSwitchEngaged = this.#killSwitchEngaged();
    await this.ledger.heartbeatWorker({
      workerId: this.workerId,
      serviceVersion: this.config.serviceVersion,
      browserReady: browser.ok && tts.ok && fixturesReady,
      observedAt,
      attestation: createWorkerHeartbeatAttestation(this.config, this.#workerBootIdentity, effectiveKillSwitchEngaged, heartbeatSequence),
      detail: { browser: browser.detail, browser_engine: browser.engine ?? null, browser_version: browser.version ?? null, fixtures_ready: fixturesReady, fixture_count: this.audio.summaries().length, tts_ready: tts.ok, tts: tts.detail },
    });
  }

  #startWorkerHeartbeatLoop(): void {
    if (this.#workerHeartbeatLoopPromise !== null) return;
    this.#workerHeartbeatFirstAttemptPromise = new Promise((resolve) => { this.#resolveWorkerHeartbeatFirstAttempt = resolve; });
    this.#workerHeartbeatLoopPromise = this.#runWorkerHeartbeatLoop().finally(() => {
      this.#resolveWorkerHeartbeatFirstAttempt?.();
      this.#resolveWorkerHeartbeatFirstAttempt = null;
      this.#workerHeartbeatFirstAttemptPromise = null;
      this.#wakeWorkerHeartbeatLoop = null;
      this.#workerHeartbeatLoopPromise = null;
    });
  }

  async #runWorkerHeartbeatLoop(): Promise<void> {
    while (!this.#stopping) {
      await this.#heartbeatWorker().catch((error) => this.logger.error({ error: safeError(error) }, "worker heartbeat failed"));
      this.#resolveWorkerHeartbeatFirstAttempt?.();
      this.#resolveWorkerHeartbeatFirstAttempt = null;
      if (this.#stopping) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.#wakeWorkerHeartbeatLoop === finish) this.#wakeWorkerHeartbeatLoop = null;
          resolve();
        };
        const timer = setTimeout(finish, WORKER_HEARTBEAT_INTERVAL_MS);
        this.#wakeWorkerHeartbeatLoop = finish;
        if (this.#stopping) finish();
      });
    }
  }

  async #execute(claimed: ClaimedOperation, signal: AbortSignal): Promise<Record<string, unknown>> {
    const { operation } = claimed;
    let run = await this.#freshRun(claimed.run.id);
    if (operation.type !== "end" && this.#killSwitchEngaged()) throw new VoiceLabError(labError("KILL_SWITCH_ENGAGED", `${operation.type} was rejected by the worker kill switch.`, "authorization", true));
    if (operation.type !== "start" && !this.driver.hasSession(run.id) && !(operation.type === "end" && ["ending", "finalizing", "exporting"].includes(run.state))) throw new VoiceLabError(labError("BROWSER_SESSION_LOST", "The browser worker restarted; live media state cannot be reconstructed honestly.", "harness"));
    if (operation.type === "start") {
      if (run.state !== "reserved") throw new VoiceLabError(labError("BROWSER_SESSION_LOST", "A replayed start operation cannot recreate an already-started browser honestly.", "harness"));
      run = await transitionRun(this.ledger, run, "validating_target");
      if (run.scenarioId === "V-S01" || run.scenarioId === "V-S02") return this.#executePreResourceScenario(run, operation.id);
      if (this.config.readinessTarget !== null || this.config.nodeEnv !== "test") assertFreshProductAdmissionProof(this.config, run.target, await this.targetIdentity());
      // Admission at the MCP boundary prevents an accepted request from
      // allocating work beyond the rolling campaign budget. Replaying the
      // exact durable reservation here is the final provider-allocation fence:
      // a restart, suite scheduler, or older API process cannot bypass the
      // same transactionally enforced counter before a browser/provider exists.
      await this.#fenceProviderAdmission(run, operation);
      run = await transitionRun(this.ledger, run, "browser_queued");
      const browserLease = await this.ledger.upsertBrowserLease(run.id, this.workerId, this.config.browserLeaseSeconds);
      this.#activeLeases.set(run.id, { epoch: browserLease.leaseEpoch });
      run = await transitionRun(this.ledger, run, "browser_leased");
      run = await transitionRun(this.ledger, run, "authenticating");
      const startOps = ["auth:session", "session:create", "session:read", "voice:start", "session:finalize", ...(run.scenarioId === "V-L01" ? ["trace:fault"] : [])];
      const browserContextBinding = await this.#resolveD02BrowserContextBinding(run);
      const grant = await this.#mintAndVerify(run, "sophia-voice-lab-frontend", startOps, "auth:session", browserContextBinding);
      await this.#fenceMutation(claimed, signal);
      const started = await this.driver.start(run, grant.token, browserContextBinding);
      if (!sameD02BrowserContextBinding(started.browserContextBinding, browserContextBinding)) throw new VoiceLabError(labError("BROWSER_CONTEXT_BINDING_MISMATCH", "The browser driver did not attest the exact V-D02 run, worker, lease, and context allocation.", "harness", false));
      if (browserContextBinding) {
        await this.ledger.appendEvent(run.id, "harness.browser_context_bound", "canonical", {
          schema: "sophia_voice_lab_browser_context_binding_v1",
          test_run_id_sha256: sha256(run.testRunId),
          cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
          ...browserContextBinding,
          context_allocation: "deterministic_run_worker_lease_v1",
          driver_attested: true,
          raw_run_worker_and_context_identifiers_excluded: true,
        }, `browser-context-binding:${run.id}:${browserContextBinding.browser_lease_epoch}`);
      }
      run = await transitionRun(this.ledger, run, "opening_app", { observedDeployment: started.observedDeployment, verdicts: { ...run.verdicts, auth: "pass" } });
      await this.#persistEvents(run.id, started.events);
      const browserRuntime = await this.driver.readiness();
      if (!browserRuntime.ok || typeof browserRuntime.engine !== "string" || browserRuntime.engine.length === 0 || typeof browserRuntime.version !== "string" || browserRuntime.version.length === 0) throw new VoiceLabError(labError("BROWSER_RUNTIME_PROVENANCE_UNAVAILABLE", "The acquired browser runtime did not expose an exact engine/version identity.", "harness", false));
      await this.ledger.appendEvent(run.id, "harness.browser_runtime_acquired", "canonical", {
        worker_id_sha256: sha256(this.workerId),
        browser_lease_epoch: browserLease.leaseEpoch,
        ...(browserContextBinding ? { browser_context_id_sha256: browserContextBinding.browser_context_id_sha256 } : {}),
        operation_id: operation.id,
        engine: browserRuntime.engine,
        version: browserRuntime.version,
        service_version: this.config.serviceVersion,
        acquired_at: new Date().toISOString(),
        raw_worker_identifier_excluded: true,
      }, `browser-runtime:${run.id}:${browserLease.leaseEpoch}`);
      run = await this.#freshRun(run.id);
      run = await transitionRun(this.ledger, run, "ready", { verdicts: { ...run.verdicts, harness: "pass", auth: "pass" } });
      await this.ledger.appendEvent(run.id, "run.ready", "worker", { operation_id: operation.id }, `run:${run.id}:ready`);
      if (run.scenarioId === "V-D02") {
        await this.#certifyFreshApiReattach(run);
      }
      return { run_state: run.state, capability_jti_hash: sha256(grant.claims.jti) };
    }
    if (operation.type === "speak" || operation.type === "barge_in") {
      const allowedOp = operation.type === "speak" ? "voice:synthetic_input" : "voice:barge_in";
      await this.#mintAndVerify(run, "sophia-voice-runtime", [allowedOp], allowedOp);
      await this.#awaitPriorInputSettlement(run, operation.id, signal);
      const bargeTarget = operation.input._barge_target as Record<string, unknown> | undefined;
      if (operation.type === "barge_in") assertBargeWindow(bargeTarget);
      const text = typeof operation.input.text === "string" ? operation.input.text : undefined;
      const fixtureId = typeof operation.input.fixture_id === "string" ? operation.input.fixture_id : undefined;
      const audio = await this.audio.resolve({ ...(text === undefined ? {} : { text }), ...(fixtureId === undefined ? {} : { fixture_id: fixtureId }) }, signal);
      if (audio.durationMs > this.config.maxAudioDurationMs) throw new VoiceLabError(labError("AUDIO_DURATION_LIMIT", "Resolved audio exceeds the per-utterance duration limit.", "validation"));
      assertResolvedAudioWithinAdmission(operation.input._admission, audio.durationMs, audio.bytes.byteLength);
      const priorOperations = await this.ledger.listOperations(run.id);
      const priorUsage = priorOperations.filter((candidate) => candidate.id !== operation.id && candidate.state === "succeeded" && (candidate.type === "speak" || candidate.type === "barge_in")).reduce((usage, candidate) => {
        const wav = candidate.result?.wav as Record<string, unknown> | undefined;
        return { durationMs: usage.durationMs + Number(wav?.duration_ms ?? 0), bytes: usage.bytes + Number(wav?.byte_length ?? 0) };
      }, { durationMs: 0, bytes: 0 });
      if (priorUsage.durationMs + audio.durationMs > this.config.maxInjectedDurationMs) throw new VoiceLabError(labError("INJECTED_DURATION_LIMIT", "Run cumulative injected duration budget would be exceeded.", "conflict"));
      if (priorUsage.bytes + audio.bytes.byteLength > this.config.maxInjectedBytes) throw new VoiceLabError(labError("INJECTED_BYTES_LIMIT", "Run cumulative injected byte budget would be exceeded.", "conflict"));
      // The page bridge memoizes by operation ID; this deterministic ID makes
      // a reclaimed/retried operation return the identical scheduling receipt.
      const utteranceId = deterministicUuid(operation.id, "utterance");
      const timing = typeof operation.input.timing_policy === "object" && operation.input.timing_policy !== null ? operation.input.timing_policy as Record<string, unknown> : {};
      const targetAt = typeof bargeTarget?.target_schedule_at === "string" ? new Date(bargeTarget.target_schedule_at).getTime() : Number.NaN;
      if (operation.type === "barge_in") assertBargeWindow(bargeTarget);
      const delayMs = operation.type === "barge_in" ? (Number.isNaN(targetAt) ? Number(operation.input.delay_ms ?? 0) : Math.max(0, targetAt - Date.now())) : Number(timing.delay_ms ?? 0);
      await this.ledger.appendEvent(run.id, "utterance.resolved", "worker", { utterance_id: utteranceId, operation_id: operation.id, idempotency_key_hash: sha256(operation.idempotencyKey), test_run_id: run.testRunId, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, source: audio.source, fixture: audio.fixture ?? null, source_text_hash: audio.sourceTextHash ?? null, synthesis: audio.synthesis ?? null, barge_target: bargeTarget ?? null, scheduled_delay_ms: delayMs, wav: { sha256: audio.sha256, sample_rate: audio.sampleRate, channels: audio.channels, duration_ms: audio.durationMs, byte_length: audio.bytes.byteLength } }, `utterance:${utteranceId}:resolved`);
      if (operation.type === "barge_in" && operation.input._tool_target) await this.#revalidateActiveTarget(run, operation.id, operation.input._tool_target as Record<string, unknown>);
      await this.#fenceMutation(claimed, signal);
      const scheduled = await this.driver.schedule(run, operation.id, utteranceId, audio, delayMs, operation.type === "barge_in" ? operation.input._tool_target as Record<string, unknown> | undefined : undefined);
      await this.#persistEvents(run.id, scheduled.events);
      run = await this.#freshRun(run.id);
      if (run.state === "ready") run = await transitionRun(this.ledger, run, "active");
      return { run_state: run.state, utterance_id: utteranceId, source: audio.source, source_text_hash: audio.sourceTextHash ?? null, synthesis: audio.synthesis ?? null, wav: { sha256: audio.sha256, sample_rate: audio.sampleRate, channels: audio.channels, duration_ms: audio.durationMs, byte_length: audio.bytes.byteLength }, schedule_receipt: scheduled.receipt };
    }
    if (operation.type === "force_socket_rotation") {
      await this.#mintAndVerify(run, "sophia-voice-runtime", ["voice:fault:socket_rotation"], "voice:fault:socket_rotation");
      if (operation.input._commit_target) await this.#revalidateActiveTarget(run, operation.id, operation.input._commit_target as Record<string, unknown>);
      await this.#fenceMutation(claimed, signal);
      const rotated = await this.driver.rotate(run, Number(operation.input.expected_socket_epoch), operation.id, operation.input._commit_target as Record<string, unknown> | undefined);
      await this.#persistEvents(run.id, rotated.events);
      return { run_state: run.state, rotation_receipt: rotated.receipt };
    }
    // A reclaimed end may resume only from durable canonical receipts. The
    // browser itself is intentionally non-resumable; after its context has
    // closed, recovery/final evidence may continue from the ledger without
    // repeating UI or provider side effects.
    if (!this.driver.hasSession(run.id)) {
      const prior = await this.#allEvents(run.id);
      const finalized = prior.events.some((event) => isCanonicalFinalizationReceipt(run, event));
      if (!finalized) throw new VoiceLabError(labError("BROWSER_SESSION_LOST", "The browser disappeared before a bound canonical finalization receipt was durable; end cannot be replayed safely.", "harness", false));
      const recovered = await this.#recoverRun(run);
      await this.#persistEvents(run.id, recovered.events);
      run = await this.#freshRun(run.id);
      if (run.state === "ending") run = await transitionRun(this.ledger, run, "finalizing");
      if (run.state === "finalizing") run = await transitionRun(this.ledger, run, "exporting");
      if (run.state !== "exporting") throw new VoiceLabError(labError("END_RESUME_STATE_INVALID", `Durable end recovery cannot resume from ${run.state}.`, "conflict", false));
      const browserLeaseReleased = await this.#releaseBrowserLeaseProof(run.id);
      if (!browserLeaseReleased) throw new VoiceLabError(labError("BROWSER_LEASE_RELEASE_UNCONFIRMED", "Durable end recovery could not prove the browser lease absent.", "harness", true));
      return { run_state: run.state, evidence_state: "pending_post_settlement", resumed_from_durable_finalization: true, _finalize_end: true };
    }

    await this.#mintAndVerify(run, "sophia-voice-runtime", ["voice:end"], "voice:end");
    const finalizeGrant = await this.#mintAndVerify(run, "sophia-voice-lab-frontend", ["session:finalize"], "session:finalize");
    const cleanupGrant = await this.#mintAndVerify(run, "sophia-voice-lab-frontend", ["session:cleanup"], "session:cleanup");
    if (run.state !== "ending") run = await transitionRun(this.ledger, run, "ending");
    await this.#fenceMutation(claimed, signal);
    const ended = await this.driver.end(run, finalizeGrant.token, cleanupGrant.token);
    await this.#persistEvents(run.id, ended.events);
    run = await this.#freshRun(run.id);
    const recoveredAfterEnd = await this.#recoverRun(run);
    await this.#persistEvents(run.id, recoveredAfterEnd.events);
    run = await this.#freshRun(run.id);
    run = await transitionRun(this.ledger, run, "finalizing");
    for (const artifact of ended.artifacts) {
      if (artifact.bytes.byteLength > 2_000_000) {
        await this.ledger.appendEvent(run.id, "evidence.artifact_dropped", "worker", { kind: artifact.kind, reason: "size_limit", byte_length: artifact.bytes.byteLength });
        continue;
      }
      const digest = sha256(artifact.bytes);
      await this.ledger.saveArtifact({ ...artifact, runId: run.id, sha256: digest, createdAt: new Date() });
    }
    run = await transitionRun(this.ledger, run, "exporting");
    const browserLeaseReleased = await this.#releaseBrowserLeaseProof(run.id);
    if (!browserLeaseReleased) throw new VoiceLabError(labError("BROWSER_LEASE_RELEASE_UNCONFIRMED", "End could not prove the browser lease absent before evidence settlement.", "harness", true));
    return { run_state: run.state, evidence_state: "pending_post_settlement", _finalize_end: true };
  }

  async #fenceProviderAdmission(run: RunRecord, operation: ClaimedOperation["operation"]): Promise<void> {
    const suiteRunId = typeof operation.input.suite_run_id === "string" ? operation.input.suite_run_id : null;
    if (suiteRunId) {
      const suite = await this.ledger.getSuite(suiteRunId);
      if (!suite || suite.callerId !== run.callerId || !suite.runIds.includes(run.id)) throw new VoiceLabError(labError("SUITE_ADMISSION_BINDING_INVALID", "Suite child could not prove its durable rolling-admission ownership before provider allocation.", "harness", false));
      await this.#fenceSuiteAdmission(suite);
      return;
    }
    await this.ledger.reserveRollingAdmission({
      reservationKey: sha256(`run\u0000${run.callerId}\u0000${operation.idempotencyKey}`),
      requestHash: operation.requestHash,
      callerId: run.callerId,
      environment: run.environment,
      kind: "run",
      runStarts: 1,
      providerSeconds: this.config.maxRunSeconds,
      suites: 0,
      suiteChildren: 0,
      audioDurationMs: 0,
      audioBytes: 0,
      observedAt: run.createdAt,
    }, this.#rollingAdmissionLimits());
  }

  async #fenceSuiteAdmission(suite: SuiteRecord): Promise<void> {
    const supportedChildren = suite.definition.scenarios.filter((scenario) => scenario.support === "supported").length;
    const providerChildren = suite.definition.scenarios.filter((scenario) => scenario.support === "supported" && scenario.id !== "V-S01" && scenario.id !== "V-S02").length;
    await this.ledger.reserveRollingAdmission({
      reservationKey: sha256(`suite\u0000${suite.callerId}\u0000${suite.idempotencyKey}`),
      requestHash: suite.requestHash,
      callerId: suite.callerId,
      environment: suite.definition.environment,
      kind: "suite",
      runStarts: supportedChildren,
      providerSeconds: providerChildren * this.config.maxRunSeconds,
      suites: 1,
      suiteChildren: supportedChildren,
      audioDurationMs: 0,
      audioBytes: 0,
      observedAt: suite.createdAt,
    }, this.#rollingAdmissionLimits());
  }

  #rollingAdmissionLimits(): RollingAdmissionLimits {
    return {
      windowSeconds: this.config.admissionWindowSeconds,
      global: { runStarts: this.config.maxRollingRunStarts, providerSeconds: this.config.maxRollingProviderSeconds, suites: this.config.maxRollingSuites, suiteChildren: this.config.maxRollingSuiteChildren, audioDurationMs: this.config.maxRollingInjectedDurationMs, audioBytes: this.config.maxRollingInjectedBytes },
      caller: { runStarts: this.config.maxRollingRunStartsPerCaller, providerSeconds: this.config.maxRollingProviderSecondsPerCaller, suites: this.config.maxRollingSuitesPerCaller, suiteChildren: this.config.maxRollingSuiteChildrenPerCaller, audioDurationMs: this.config.maxRollingInjectedDurationMsPerCaller, audioBytes: this.config.maxRollingInjectedBytesPerCaller },
    };
  }

  /**
   * Publish final evidence only after the end operation itself is durable.
   * This method is deliberately idempotent: maintenance can re-enter it after
   * a worker crash at any boundary, and every returned resource keeps immutable
   * bytes behind its original URI/hash.
   */
  async #finalizeEndRun(runId: string): Promise<void> {
    let run = await this.#freshRun(runId);
    if (run.state !== "exporting" && !(TERMINAL_RUN_STATES.has(run.state) && run.terminalError === null && run.cleanupComplete)) {
      throw new VoiceLabError(labError("EVIDENCE_FINALIZATION_STATE_INVALID", `Final evidence cannot be published from ${run.state}.`, "conflict", true));
    }

    let operations = await this.ledger.listOperations(run.id);
    const nonterminal = operations.filter((operation) => ["accepted", "queued", "leased", "executing"].includes(operation.state));
    if (nonterminal.length > 0) throw new VoiceLabError(labError("EVIDENCE_OPERATION_PENDING", "Final evidence is waiting for every run operation to settle.", "evidence", true, { operation_ids: nonterminal.map((operation) => operation.id) }));
    const endOperations = operations.filter((operation) => operation.type === "end" && operation.state === "succeeded");
    if (endOperations.length === 0) throw new VoiceLabError(labError("END_SETTLEMENT_MISSING", "Final evidence requires a durably succeeded end operation.", "evidence", true));
    // Repair only the evidence projection after a crash between the canonical
    // operation row update and event append; the operation row is authoritative.
    for (const operation of operations.filter((candidate) => candidate.state === "succeeded")) {
      await this.ledger.appendEvent(run.id, "operation.succeeded", "worker", { operation_id: operation.id, operation_type: operation.type }, `operation:${operation.id}:succeeded`);
    }

    let eventPage = await this.#allEvents(run.id);
    const browserContextClosed = eventPage.events.some((event) => event.kind === "cleanup.browser_context_closed" && event.payload.close_resolved === true && event.payload.browser_registry_absent === true) && !this.driver.hasSession(run.id);
    const browserLeaseReleased = await this.#releaseBrowserLeaseProof(run.id);
    eventPage = await this.#allEvents(run.id);
    const taskCleanup = deriveTaskCleanup(eventPage.events, run);
    const providerDisconnected = eventPage.events.some((event) => isExactBoundProductEvent(run, event) && event.kind === "provider.stage" && ["closed", "ended"].includes(String(event.payload.stage))) || recoveryComponentComplete(eventPage.events, "voice_provider");
    const authSessionRevoked = eventPage.events.some(authCleanupConfirmed) || recoveryComponentComplete(eventPage.events, "auth_sessions");
    const canonicalFinalized = eventPage.events.some((event) => isCanonicalFinalizationReceipt(run, event));
    const liveCleanupComplete = authoritativeLiveCleanupComplete(eventPage.events);
    const cleanupComplete = canonicalFinalized && browserContextClosed && browserLeaseReleased && providerDisconnected && authSessionRevoked && taskCleanup.unresolved_count === 0 && liveCleanupComplete;
    if (!cleanupComplete) {
      throw new VoiceLabError(labError("ZERO_ORPHAN_CLEANUP_UNCONFIRMED", "Run cannot produce final evidence until canonical finalization plus browser, provider, auth, and owned-task cleanup are proven.", "harness", true, {
        canonical_finalization: canonicalFinalized,
        browser_context_closed: browserContextClosed,
        browser_lease_released: browserLeaseReleased,
        provider_disconnect: providerDisconnected,
        auth_session_revoked: authSessionRevoked,
        unresolved_tasks: taskCleanup.unresolved_count,
        live_cleanup_complete: liveCleanupComplete,
      }));
    }

    const authAudit = await this.ledger.listAuthAudit(run.id);
    const derivedVerdicts = deriveCompletedVerdicts(run, eventPage.events, operations, authAudit);
    const machineAssertions = evaluateScenarioAssertions(run, eventPage.events, operations, authAudit);
    const decision = certificationTerminalDecision(derivedVerdicts);
    const terminalState = decision.state;
    const terminalReason = decision.reason;

    if (run.state === "exporting") {
      const retention = retentionPatchFromEvents(eventPage.events);
      run = await this.ledger.updateRun(run.id, run.version, { verdicts: derivedVerdicts, cleanupComplete: true, ...retention });
      run = await transitionRun(this.ledger, run, terminalState, { verdicts: derivedVerdicts, cleanupComplete: true, ...retention });
    } else if (run.state === "pending_external_evidence" && terminalState !== "pending_external_evidence") {
      run = await transitionRun(this.ledger, run, terminalState, { verdicts: derivedVerdicts });
    } else if (run.state !== terminalState) {
      throw new VoiceLabError(labError("TERMINAL_DECISION_CONFLICT", "A recovered evidence finalizer derived a different terminal state from the already durable decision.", "evidence", false, { durable_state: run.state, derived_state: terminalState }));
    } else if (canonicalRequestHash(run.verdicts) !== canonicalRequestHash(derivedVerdicts)) {
      // Execution terminal state is immutable, while certification is an
      // append-only projection. A late owning attestation may therefore update
      // only verdicts and the current manifest pointer.
      run = await this.ledger.updateRun(run.id, run.version, { verdicts: derivedVerdicts });
    }
    const terminalEvent = await this.ledger.appendEvent(run.id, `run.${terminalState}`, "worker", {
      terminal_state: terminalState,
      terminal_reason: terminalReason,
      cleanup_complete: true,
      end_operation_ids: endOperations.map((operation) => operation.id).sort(),
    }, `run:${run.id}:${terminalState}`);

    await this.#publishRunEvidence({
      runId: run.id,
      terminalState,
      terminalReason,
      verdicts: derivedVerdicts,
      terminalError: terminalState === "completed" || terminalState === "pending_external_evidence" ? null : labError("SCENARIO_VERDICT_TERMINAL", "One or more machine assertions produced a non-passing terminal verdict.", terminalState === "product_failed" ? "product" : terminalState === "inconclusive_provider" ? "provider" : terminalState === "authorization_failed" ? "authorization" : "harness", false, { terminal_state: terminalState }),
      createdAt: terminalEvent.at,
      purpose: "completed-flow",
      intentionallyUnallocated: false,
      artifacts: [],
    });
  }

  async #executePreResourceScenario(run: RunRecord, operationId: string): Promise<Record<string, unknown>> {
    const activeRunsBefore = await this.ledger.countActiveRuns();
    const verified = await this.driver.verifyTarget(run);
    run = await this.ledger.updateRun(run.id, run.version, { observedDeployment: verified.observedDeployment });
    await this.#persistEvents(run.id, verified.events);
    if (run.scenarioId === "V-S01") {
      const grantUrl = new URL(this.config.authGrantPath, validateAllowedOrigin(run.target.frontendUrl, this.config.allowedOrigins).origin).toString();
      const common = { sub: run.principalId, principal_id: run.principalId, test_run_id: run.testRunId, cleanup_obligation_id: run.cleanupObligationId, scenario_id: "V-S01", ...(run.scenarioVersion === null ? {} : { scenario_version: run.scenarioVersion }), synthetic: true as const, environment: run.environment, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString(), allowed_ops: ["auth:session"], expected_deployment: run.target.expectedDeployment };
      const expired = this.#frontendCapabilities.mint({ ...common, aud: "sophia-voice-lab-frontend" }, new Date(Date.now() - (this.config.capabilityTtlSeconds + 30) * 1_000));
      const wrongAudience = this.#frontendCapabilities.mint({ ...common, aud: "sophia-voice-gateway" });
      const wrongOperation = this.#frontendCapabilities.mint({ ...common, aud: "sophia-voice-lab-frontend", allowed_ops: ["auth:readiness"] });
      const wrongPrincipal = this.#frontendCapabilities.mint({ ...common, aud: "sophia-voice-lab-frontend", principal_id: "wrong-principal-probe" });
      const wrongRun = this.#frontendCapabilities.mint({ ...common, aud: "sophia-voice-lab-frontend", test_run_id: randomUUID() });
      const ordinary = this.#frontendCapabilities.mint({ ...common, aud: "sophia-voice-lab-frontend", sub: "ordinary-user-probe", principal_id: "ordinary-user-probe" });
      const variants: Array<{ id: typeof S01_FRONTEND_GRANT_VARIANTS[number]; token?: string }> = [
        { id: "missing" }, { id: "expired", token: expired.token }, { id: "wrong_audience", token: wrongAudience.token },
        { id: "wrong_operation", token: wrongOperation.token }, { id: "wrong_principal", token: wrongPrincipal.token },
        { id: "wrong_run", token: wrongRun.token }, { id: "ordinary_user", token: ordinary.token },
      ];
      for (const variant of variants) {
        const response = await this.scenarioFetch(grantUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json", ...(variant.token === undefined ? {} : { "X-Sophia-Voice-Lab-Capability": variant.token }) } });
        const rejected = [400, 401, 403].includes(response.status) && response.url === grantUrl && !response.headers.has("set-cookie") && !response.headers.has("location");
        await response.body?.cancel().catch(() => undefined);
        await this.ledger.appendEvent(run.id, "security.invalid_grant_probe", "canonical", { variant: variant.id, rejected, http_status: response.status, exact_response_target: response.url === grantUrl, no_session_cookie: !response.headers.has("set-cookie"), no_redirect: !response.headers.has("location") }, `security:${run.id}:${variant.id}`);
        if (!rejected) throw new VoiceLabError(labError("INVALID_GRANT_PROBE_ACCEPTED", "A governed invalid frontend grant was not rejected before session allocation.", "authorization", false, { variant: variant.id, status: response.status }));
      }
      await this.#runOAuthSecurityProbes(run);
    } else {
      const inputTarget = {
        frontend_url: run.target.frontendUrl,
        gateway_url: run.target.gatewayUrl,
        voice_url: run.target.voiceUrl,
        langgraph_url: run.target.langgraphUrl,
        expected_deployment: run.target.expectedDeployment,
        expected_dependencies: run.target.expectedDependencies,
      };
      const fixture = (patch: Partial<FixtureSummary>): FixtureSummary => ({
        id: "governed-probe", fixtureVersion: "1.0.0", family: "security-probe", fixtureClass: "short_command",
        sha256: "0".repeat(64), sampleRate: 16_000, channels: 1, durationMs: 1_000,
        sourceText: { status: "unavailable", reason: "content_free_validation_probe" },
        synthesis: { engine: "fixture", engine_version: "1", voice: "synthetic", rate: "fixed" },
        provenance: { kind: "governed_security_probe", suite: "V-S02", manifestVersion: 1 },
        assertionPolicy: { expect_transcript: false, semantic_threshold: "not_applicable" }, ...patch,
      });
      const start = { environment: run.environment, target: inputTarget, scenario_id: "V-S02", scenario_version: run.scenarioVersion ?? undefined, idempotency_key: "security-probe-start" };
      const cases: Array<{ id: typeof S02_VALIDATION_VARIANTS[number]; expected: string; validator: string; execute: () => void | Promise<void> }> = [
        { id: "unknown_fields", expected: "ZodError", validator: "toolInputSchemas.start_voice_run", execute: () => { toolInputSchemas.start_voice_run.parse({ ...start, unexpected: true }); } },
        { id: "malformed_id", expected: "ZodError", validator: "toolInputSchemas.speak", execute: () => { toolInputSchemas.speak.parse({ run_id: "not-a-uuid", text: "safe", idempotency_key: "security-probe-speak" }); } },
        { id: "malformed_sha", expected: "ZodError", validator: "toolInputSchemas.start_voice_run", execute: () => { toolInputSchemas.start_voice_run.parse({ ...start, target: { ...inputTarget, expected_deployment: { ...inputTarget.expected_deployment, frontend: "bad-sha" } } }); } },
        { id: "text_limit", expected: "TEXT_TOO_LARGE", validator: "validateAudioInputLimit", execute: () => { validateAudioInputLimit({ text: "x".repeat(this.config.maxTextCharacters + 1) }, this.config.maxTextCharacters); } },
        { id: "fixture_metadata_bytes", expected: "AUDIO_TOO_LARGE", validator: "reserveAudioInput", execute: async () => { await reserveAudioInput({ fixture_id: "governed-probe" }, [fixture({ sampleRate: this.config.maxAudioBytes, durationMs: 1_000, channels: 2 })], this.config); } },
        { id: "fixture_metadata_duration", expected: "AUDIO_DURATION_LIMIT", validator: "reserveAudioInput", execute: async () => { await reserveAudioInput({ fixture_id: "governed-probe" }, [fixture({ durationMs: this.config.maxAudioDurationMs + 1 })], this.config); } },
        { id: "unsupported_fixture", expected: "FIXTURE_NOT_FOUND", validator: "reserveAudioInput", execute: async () => { await reserveAudioInput({ fixture_id: "unknown-fixture" }, [], this.config); } },
        { id: "unsupported_scenario", expected: "ZodError", validator: "toolInputSchemas.start_voice_run", execute: () => { toolInputSchemas.start_voice_run.parse({ ...start, scenario_id: "V-UNKNOWN" }); } },
        { id: "http_origin", expected: "TARGET_NOT_ALLOWED", validator: "validateAllowedOrigin", execute: () => { validateAllowedOrigin("http://unsupported.invalid", this.config.allowedOrigins); } },
        { id: "unsupported_target_path", expected: "TARGET_NOT_ALLOWED", validator: "validateAllowedOrigin", execute: () => { validateAllowedOrigin(`${new URL(run.target.frontendUrl).origin}/redirect`, this.config.allowedOrigins); } },
        { id: "unsupported_target_query", expected: "TARGET_NOT_ALLOWED", validator: "validateAllowedOrigin", execute: () => { validateAllowedOrigin(`${new URL(run.target.frontendUrl).origin}/?redirect=https://unsupported.invalid`, this.config.allowedOrigins); } },
        { id: "unsupported_target_origin", expected: "TARGET_NOT_ALLOWED", validator: "validateAllowedOrigin", execute: () => { validateAllowedOrigin("https://unsupported.invalid", this.config.allowedOrigins); } },
        { id: "redirect_origin", expected: "TARGET_NOT_ALLOWED", validator: "validateAllowedOrigin", execute: () => { validateAllowedOrigin("https://allowed.invalid@redirect.invalid/", this.config.allowedOrigins); } },
        { id: "invalid_capture_policy", expected: "ZodError", validator: "toolInputSchemas.start_voice_run", execute: () => { toolInputSchemas.start_voice_run.parse({ ...start, capture_policy: { raw_audio: false, screenshot: true, video: false, retention_hours: 0 } }); } },
        { id: "malformed_wav", expected: "AUDIO_FORMAT_UNSUPPORTED", validator: "parseWav", execute: () => { parseWav(Buffer.from("not-a-wave")); } },
        { id: "oversized_audio", expected: "AUDIO_TOO_LARGE", validator: "assertAudioByteLimit", execute: () => { assertAudioByteLimit(this.config.maxAudioBytes + 1, this.config.maxAudioBytes); } },
      ];
      for (const probe of cases) {
        let code: string | null = null;
        try { await probe.execute(); }
        catch (error) { code = error instanceof VoiceLabError ? error.detail.code : error instanceof Error ? error.name : "Error"; }
        const rejected = code === probe.expected;
        await this.ledger.appendEvent(run.id, "security.pre_resource_validation_probe", "worker", { variant: probe.id, rejected, expected_error_class: probe.expected, observed_error_class: code, production_validator: probe.validator }, `security:${run.id}:${probe.id}`);
        if (!rejected) throw new VoiceLabError(labError("PRE_RESOURCE_VALIDATION_PROBE_FAILED", "A governed malformed media or target case did not use the production fail-closed validator.", "harness", false, { variant: probe.id, expected: probe.expected, observed: code }));
      }
      await this.ledger.appendEvent(run.id, "security.shared_validator_equivalence", "worker", { internal_validator_supplement: true, variant_count: cases.length, production_boundary_assertion: "security.mcp_boundary_probe" }, `security:${run.id}:shared-validator-equivalence`);
      await this.ledger.appendEvent(run.id, "security.s02_surface_coverage", "canonical", {
        schema: "sophia_voice_lab_s02_surface_coverage_v1",
        public_authenticated_mcp_variants: [...S02_HTTP_VARIANTS],
        internal_startup_only_variants: ["fixture_metadata_bytes", "fixture_metadata_duration", "malformed_wav", "oversized_audio"],
        unsupported_fixture_public_mcp: true,
        raw_audio_public_surface: false,
        raw_audio_surface_reason: "no_public_raw_audio_surface",
        fixture_startup_receipt: this.audio.fixtureReadiness(),
      }, `security:${run.id}:surface-coverage`);
      await this.#runMcpValidationProbes(run, inputTarget);
    }
    const activeRunsAfter = await this.ledger.countActiveRuns();
    const allocationRun = await this.#freshRun(run.id);
    const allocationFence = {
      active_runs_before: activeRunsBefore,
      active_runs_after: activeRunsAfter,
      active_run_count_unchanged: activeRunsAfter === activeRunsBefore,
      browser_context_absent: !this.driver.hasSession(run.id),
      browser_lease_absent: (await this.ledger.getBrowserLease(run.id)) === null,
      canonical_session_absent: allocationRun.canonicalSessionId === null,
      provider_session_absent: allocationRun.providerSessionId === null,
      tts_process_invocations: 0,
    };
    await this.ledger.appendEvent(run.id, "security.pre_resource_allocation_fence", "worker", allocationFence, `security:${run.id}:allocation-fence`);
    if (!Object.entries(allocationFence).every(([key, value]) => key.endsWith("_before") || key.endsWith("_after") ? true : value === true || value === 0)) throw new VoiceLabError(labError("PRE_RESOURCE_ALLOCATION_OCCURRED", "The governed security recipe observed a resource or quota mutation before rejection.", "harness", false));
    await this.ledger.appendEvent(run.id, "cleanup.browser_context_absent", "worker", { pre_resource_recipe: true, browser_never_allocated: true }, `cleanup:${run.id}:browser-context-absent`);
    await this.ledger.appendEvent(run.id, "cleanup.browser_lease_absent", "worker", { pre_resource_recipe: true, authoritative_ledger_read: (await this.ledger.getBrowserLease(run.id)) === null }, `cleanup:${run.id}:browser-lease-absent`);
    const recovery = await this.#recoverRun(run);
    await this.#persistEvents(run.id, recovery.events);
    run = await this.#freshRun(run.id);
    run = await transitionRun(this.ledger, run, "exporting");
    return { run_state: run.state, certification_recipe: run.scenarioId, pre_resource_only: true, operation_id: operationId, _finalize_pre_resource: true };
  }

  async #runMcpValidationProbes(run: RunRecord, inputTarget: Record<string, unknown>): Promise<void> {
    const resource = this.config.oauth?.resource;
    if (!resource) throw new VoiceLabError(labError("MCP_BOUNDARY_CERTIFICATION_UNAVAILABLE", "V-S02 requires the configured public registered-app MCP resource.", "harness", false));
    const endpoint = new URL(resource);
    if (endpoint.pathname !== "/mcp" || endpoint.search || endpoint.hash) throw new VoiceLabError(labError("MCP_BOUNDARY_CERTIFICATION_UNAVAILABLE", "V-S02 public resource was not the exact /mcp endpoint.", "harness", false));
    const call = (id: string, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: `v-s02-${id}-${randomUUID()}`, method: "tools/call", params: { name, arguments: args } });
    const start = { environment: run.environment, target: inputTarget, scenario_id: "V-S02", scenario_version: run.scenarioVersion ?? undefined, idempotency_key: "s02-http-start" };
    const standard: Array<{ id: Exclude<typeof S02_HTTP_VARIANTS[number], "deep_json" | "malformed_json" | "oversized_json">; body: Record<string, unknown> }> = [
      { id: "unknown_fields", body: call("unknown", "start_voice_run", { ...start, unexpected: true }) },
      { id: "malformed_id", body: call("id", "speak", { run_id: "not-a-uuid", text: "safe", idempotency_key: "s02-http-id" }) },
      { id: "malformed_sha", body: call("sha", "start_voice_run", { ...start, target: { ...inputTarget, expected_deployment: { ...(inputTarget.expected_deployment as Record<string, unknown>), frontend: "bad-sha" } } }) },
      { id: "text_limit", body: call("text", "speak", { run_id: run.id, text: "x".repeat(this.config.maxTextCharacters + 1), idempotency_key: "s02-http-text" }) },
      { id: "unsupported_fixture", body: call("fixture", "speak", { run_id: run.id, fixture_id: "s02-governed-unknown-fixture", idempotency_key: "s02-http-fixture" }) },
      { id: "unsupported_scenario", body: call("scenario", "start_voice_run", { ...start, scenario_id: "V-UNKNOWN" }) },
      { id: "http_origin", body: call("http", "start_voice_run", { ...start, target: { ...inputTarget, frontend_url: "http://unsupported.invalid" } }) },
      { id: "unsupported_target_path", body: call("path", "start_voice_run", { ...start, target: { ...inputTarget, frontend_url: `${new URL(run.target.frontendUrl).origin}/redirect` } }) },
      { id: "unsupported_target_query", body: call("query", "start_voice_run", { ...start, target: { ...inputTarget, frontend_url: `${new URL(run.target.frontendUrl).origin}/?redirect=https://unsupported.invalid` } }) },
      { id: "unsupported_target_origin", body: call("origin", "start_voice_run", { ...start, target: { ...inputTarget, frontend_url: "https://unsupported.invalid" } }) },
      { id: "redirect_origin", body: call("redirect", "start_voice_run", { ...start, target: { ...inputTarget, frontend_url: "https://allowed.invalid@redirect.invalid/" } }) },
      { id: "invalid_capture_policy", body: call("capture", "start_voice_run", { ...start, capture_policy: { raw_audio: false, screenshot: true, video: false, retention_hours: 0 } }) },
    ];
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 70; index += 1) { const next: Record<string, unknown> = {}; cursor.nested = next; cursor = next; }
    const transport: Array<{ id: "deep_json" | "malformed_json" | "oversized_json"; raw: string; expectedStatus: number }> = [
      { id: "deep_json", raw: JSON.stringify({ jsonrpc: "2.0", id: `v-s02-deep-${randomUUID()}`, method: "tools/call", params: { name: "get_capabilities", arguments: deep } }), expectedStatus: 400 },
      { id: "malformed_json", raw: `{"jsonrpc":"2.0","id":"v-s02-malformed-${randomUUID()}",`, expectedStatus: 400 },
      { id: "oversized_json", raw: JSON.stringify({ jsonrpc: "2.0", id: `v-s02-oversized-${randomUUID()}`, method: "tools/call", params: { name: "get_capabilities", arguments: { padding: "x".repeat(150_000) } } }), expectedStatus: 413 },
    ];
    let previousBoundary: import("./domain.js").LabEvent | null = null;
    for (const probe of [...standard.map((item) => ({ id: item.id, raw: JSON.stringify(item.body), body: item.body, expectedStatus: null as number | null })), ...transport.map((item) => ({ ...item, body: null }))]) {
      const resourceBefore = await this.#s02ResourceSnapshot(run.id);
      const requestStartedAt = new Date();
      const auditQueryStart = new Date(requestStartedAt.getTime() - 2_000);
      const probeId = randomUUID();
      const probeIdHash = sha256(probeId);
      const boundedFallback = sha256("bounded-unparsed-request");
      let bodyHash = boundedFallback;
      let argumentHash: string | null = null;
      if (probe.body) {
        bodyHash = canonicalRequestHash(probe.body);
        const params = probe.body.params as Record<string, unknown>;
        argumentHash = canonicalRequestHash(params.arguments ?? null);
      }
      const response = await this.scenarioFetch(endpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(7_500), headers: { authorization: `Bearer ${this.config.bearerToken}`, accept: "application/json, text/event-stream", "content-type": "application/json", "x-sophia-voice-lab-probe-id": probeId }, body: probe.raw });
      const responseBody = await response.text();
      const responseObservedAt = new Date();
      const hashes = [...new Set([bodyHash, boundedFallback, ...(argumentHash ? [argumentHash] : [])])];
      const audits = await this.ledger.listAuthAuditByArgumentHashes(this.config.bearerSubject, hashes, auditQueryStart);
      const exactProbeAudits = audits.filter((audit) => audit.detail.probe_id_sha256 === probeIdHash);
      const resourceAfter = await this.#s02ResourceSnapshot(run.id);
      const expectation = s02HttpProbeExpectation(probe.id);
      const responseUrl = new URL(response.url);
      const boundary = await this.ledger.appendEvent(run.id, "security.mcp_boundary_probe", "canonical", {
        schema: S02_MCP_BOUNDARY_PROBE_SCHEMA,
        variant: probe.id,
        probe_id_sha256: probeIdHash,
        request: {
          contract: expectation.requestContract,
          contract_sha256: canonicalRequestHash(expectation.requestContract),
          endpoint_origin_sha256: sha256(endpoint.origin),
          raw_body_sha256: sha256(probe.raw),
          canonical_body_sha256: bodyHash,
          byte_length: Buffer.byteLength(probe.raw),
          started_at: requestStartedAt.toISOString(),
        },
        response: {
          http_status: response.status,
          error_code: classifyS02McpError(responseBody),
          body_sha256: sha256(responseBody),
          byte_length: Buffer.byteLength(responseBody),
          content_type: (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase(),
          final_origin_sha256: sha256(responseUrl.origin),
          final_path: responseUrl.pathname,
          location: response.headers.get("location"),
          observed_at: responseObservedAt.toISOString(),
        },
        audit_receipts: exactProbeAudits.map((audit) => ({
          action: audit.action,
          outcome: audit.outcome,
          argument_sha256: audit.argumentHash,
          caller_partition_id: audit.callerId,
          probe_id_sha256: audit.detail.probe_id_sha256 ?? null,
          request_id_sha256: audit.detail.request_id_hash ?? null,
          error_class: audit.detail.error_class ?? null,
          observed_at: audit.observedAt.toISOString(),
        })),
        resource_delta: { before: resourceBefore, after: resourceAfter },
      }, `security:${run.id}:mcp-boundary:${probe.id}`);
      if (!isExactS02McpBoundaryProbe(boundary, previousBoundary)) throw new VoiceLabError(labError("MCP_BOUNDARY_PROBE_FAILED", "The deployed authenticated MCP boundary did not produce an exact typed, audited, zero-mutation rejection.", "harness", false, { variant: probe.id, http_status: response.status, audit_receipt_count: exactProbeAudits.length }));
      previousBoundary = boundary;
    }
  }

  async #s02ResourceSnapshot(runId: string): Promise<S02ResourceSnapshot> {
    const [activeRunCount, run, operations, events] = await Promise.all([
      this.ledger.countActiveRuns(),
      this.#freshRun(runId),
      this.ledger.listOperations(runId),
      this.#allEvents(runId),
    ]);
    const inputMutations = events.events.filter((event) => event.kind === "utterance.resolved" || event.kind === "harness.input_frame_forwarded" || event.kind.startsWith("audio.input.") || event.kind.startsWith("product.input.")).length;
    return {
      active_run_count: activeRunCount,
      operation_count: operations.length,
      run_event_cursor: events.latest,
      input_mutation_event_count: inputMutations,
      browser_context_count: this.driver.hasSession(runId) ? 1 : 0,
      canonical_session_count: run.canonicalSessionId === null ? 0 : 1,
      provider_session_count: run.providerSessionId === null ? 0 : 1,
    };
  }

  async #runOAuthSecurityProbes(run: RunRecord): Promise<void> {
    const oauth = this.config.oauth;
    if (!oauth) throw new VoiceLabError(labError("OAUTH_CERTIFICATION_UNAVAILABLE", "V-S01 requires the configured registered-app OAuth boundary.", "authorization", false));
    const resource = new URL(oauth.resource);
    const issuer = new URL(oauth.issuer).origin;
    if (resource.pathname !== "/mcp" || resource.search || resource.hash) throw new VoiceLabError(labError("OAUTH_RESOURCE_INVALID", "The registered OAuth resource is not the exact MCP endpoint.", "authorization", false));
    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "voice-lab-v-s01", version: "1" } } });
    const unauthorizedCases: Array<{ id: "oauth_missing" | "oauth_invalid"; authorization?: string }> = [
      { id: "oauth_missing" },
      { id: "oauth_invalid", authorization: "Bearer governed-invalid-oauth-probe" },
    ];
    for (const probe of unauthorizedCases) {
      const response = await this.scenarioFetch(resource, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...(probe.authorization ? { authorization: probe.authorization } : {}) },
        body: initialize,
      });
      const challenge = response.headers.get("www-authenticate") ?? "";
      const rejected = response.status === 401 && response.url === resource.toString() && challenge.includes("resource_metadata=") && challenge.includes("error_description=") && !response.headers.has("location");
      await response.body?.cancel().catch(() => undefined);
      await this.#recordOAuthProbe(run, probe.id, rejected, response.status, { exact_resource: response.url === resource.toString(), linking_challenge: challenge.includes("resource_metadata=") && challenge.includes("error_description=") });
    }

    const resourceMismatchParams = this.#authorizationParams(oauth, "voice_lab:read voice_lab:run", "https://resource-mismatch.invalid/mcp");
    const mismatchUrl = new URL("/authorize", issuer);
    mismatchUrl.search = resourceMismatchParams.toString();
    const mismatch = await this.scenarioFetch(mismatchUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000), headers: { accept: "text/html,application/json" } });
    const mismatchLocation = mismatch.headers.get("location");
    const mismatchRedirect = mismatchLocation ? new URL(mismatchLocation) : null;
    const mismatchTargetBound = mismatchRedirect !== null && `${mismatchRedirect.origin}${mismatchRedirect.pathname}` === oauth.clientRedirectUri;
    const mismatchRejected = mismatch.status === 303 && mismatchTargetBound && mismatchRedirect.searchParams.has("error") && mismatchRedirect.searchParams.get("iss") === issuer;
    await mismatch.body?.cancel().catch(() => undefined);
    await this.#recordOAuthProbe(run, "oauth_resource_mismatch", mismatchRejected, mismatch.status, { exact_registered_redirect: mismatchTargetBound });

    const verifier = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const authorizeParams = this.#authorizationParams(oauth, "voice_lab:read voice_lab:run", oauth.resource, verifier);
    const authorizeUrl = new URL("/authorize", issuer);
    authorizeUrl.search = authorizeParams.toString();
    const page = await this.scenarioFetch(authorizeUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000), headers: { accept: "text/html" } });
    if (page.status !== 200 || new URL(page.url).origin !== issuer || new URL(page.url).pathname !== "/authorize") throw new VoiceLabError(labError("OAUTH_PROBE_FAILED", "The governed OAuth authorization page was unavailable.", "authorization", false));
    const html = (await page.text()).slice(0, 64_000);
    const hidden = (name: string): string => {
      const value = new RegExp(`name="${name}" value="([A-Za-z0-9._~-]{8,2048})"`).exec(html)?.[1];
      if (!value) throw new VoiceLabError(labError("OAUTH_PROBE_FAILED", "The governed OAuth consent form contract was incomplete.", "authorization", false, { field: name }));
      return value;
    };
    const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new VoiceLabError(labError("OAUTH_PROBE_FAILED", "The governed OAuth consent CSRF cookie was unavailable.", "authorization", false));
    const decision = await this.scenarioFetch(new URL("/authorize", issuer), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
      headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ request_id: hidden("request_id"), csrf_token: hidden("csrf_token"), consent_secret: oauth.consentSecret, decision: "approve" }).toString(),
    });
    const decisionLocation = decision.headers.get("location");
    await decision.body?.cancel().catch(() => undefined);
    const callback = decisionLocation ? new URL(decisionLocation) : null;
    const code = callback?.searchParams.get("code");
    if (decision.status !== 303 || callback === null || `${callback.origin}${callback.pathname}` !== oauth.clientRedirectUri || callback.searchParams.get("iss") !== issuer || !code) throw new VoiceLabError(labError("OAUTH_PROBE_FAILED", "The governed OAuth authorization-code redirect was not exactly bound.", "authorization", false));
    const tokenRequest = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: oauth.clientRedirectUri, client_id: oauth.clientMetadataUrl, code_verifier: verifier, resource: oauth.resource });
    let accessToken: string | null = null;
    let refreshToken: string | null = null;
    let probeFailure: unknown = null;
    try {
      // The raw authorization code is also a one-shot durable cleanup handle.
      // It is known before the response-loss boundary and is revoked below on
      // every outcome, including a committed pair followed by a lost or
      // unparsable HTTP response.
      const exchange = await this.scenarioFetch(new URL("/token", issuer), { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: tokenRequest.toString() });
      const tokenPayload = exchange.status === 200 ? await exchange.json() as Record<string, unknown> : {};
      accessToken = typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : null;
      refreshToken = typeof tokenPayload.refresh_token === "string" ? tokenPayload.refresh_token : null;
      if (!accessToken || !refreshToken || tokenPayload.resource !== oauth.resource || tokenPayload.scope !== "voice_lab:read voice_lab:run") throw new VoiceLabError(labError("OAUTH_PROBE_FAILED", "The governed OAuth token family was not exactly resource/scope bound.", "authorization", false));
      const faultCall = await this.scenarioFetch(resource, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "force_socket_rotation", arguments: { run_id: run.id, expected_socket_epoch: 0, idempotency_key: "s01-insufficient-fault" } } }),
      });
      const faultBody = (await faultCall.text()).slice(0, 64_000);
      const faultRejected = faultCall.status === 200 && /SCOPE_REQUIRED|insufficient_scope/.test(faultBody) && !faultCall.headers.has("location");
      await this.#recordOAuthProbe(run, "oauth_insufficient_fault_scope", faultRejected, faultCall.status, { exact_resource: faultCall.url === resource.toString(), challenge_present: /mcp\/www_authenticate|insufficient_scope/.test(faultBody) });

      const replay = await this.scenarioFetch(new URL("/token", issuer), { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: tokenRequest.toString() });
      const replayBody = (await replay.text()).slice(0, 1_024);
      await this.#recordOAuthProbe(run, "oauth_authorization_code_replay", replay.status === 400 && /"error"\s*:\s*"invalid_grant"/.test(replayBody), replay.status, { no_redirect: !replay.headers.has("location") });
    } catch (error) {
      probeFailure = error;
    }
    let cleanupFailure: unknown = null;
    try { await this.#revokeOAuthProbeFamily(run, oauth, code, accessToken, refreshToken); }
    catch (error) { cleanupFailure = error; }
    if (probeFailure) throw probeFailure;
    if (cleanupFailure) throw cleanupFailure;

    const direct = new StaticBearerAuthenticator(this.config.bearerToken, this.config.bearerSubject, this.config.faultBearerToken);
    const baseCaller = await direct.authenticate(`Bearer ${this.config.bearerToken}`);
    let baseFaultRejected = false;
    try { requireScope(baseCaller, "voice_lab:fault"); } catch (error) { baseFaultRejected = error instanceof VoiceLabError && error.detail.code === "SCOPE_REQUIRED"; }
    await this.ledger.appendEvent(run.id, "security.direct_fault_scope_probe", "worker", { rejected: baseFaultRejected, base_scope_set: [...baseCaller.scopes].sort(), fault_credential_distinct: this.config.faultBearerToken !== null && this.config.faultBearerToken !== this.config.bearerToken }, `security:${run.id}:direct-fault-scope`);
    if (!baseFaultRejected) throw new VoiceLabError(labError("FAULT_SCOPE_PROBE_FAILED", "The base direct-client credential unexpectedly carried fault authority.", "authorization", false));
  }

  async #revokeOAuthProbeFamily(run: RunRecord, oauth: NonNullable<VoiceLabConfig["oauth"]>, authorizationCode: string, accessToken: string | null, refreshToken: string | null): Promise<void> {
    const issuer = new URL(oauth.issuer).origin;
    const revoke = async (token: string, hint: "refresh_token" | "access_token") => {
      const response = await this.scenarioFetch(new URL("/revoke", issuer), {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: oauth.clientMetadataUrl }).toString(),
      });
      const exact = response.status === 200 && response.url === `${issuer}/revoke` && !response.headers.has("location");
      await response.body?.cancel().catch(() => undefined);
      return exact;
    };
    // Revoking the refresh token terminalizes its durable family. Revoking the
    // access token again is an idempotent fence if an adapter ever returns a
    // non-family refresh receipt.
    const codeResponse = await this.scenarioFetch(new URL("/revoke", issuer), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: authorizationCode, token_type_hint: "authorization_code", client_id: oauth.clientMetadataUrl }).toString(),
    }).catch(() => null);
    const codeTerminalized = codeResponse !== null && codeResponse.status === 200 && codeResponse.url === `${issuer}/revoke`
      && codeResponse.headers.get("x-sophia-oauth-revocation-receipt") === "authorization_code" && !codeResponse.headers.has("location");
    await codeResponse?.body?.cancel().catch(() => undefined);
    const refreshRevoked = refreshToken === null || await revoke(refreshToken, "refresh_token").catch(() => false);
    const accessRevoked = accessToken === null || await revoke(accessToken, "access_token").catch(() => false);
    const accessCheck = accessToken === null ? null : await this.scenarioFetch(new URL(oauth.resource), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `s01-revoked-${randomUUID()}`, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "voice-lab-v-s01-revocation", version: "1" } } }),
    });
    const accessDenied = accessCheck === null || accessCheck.status === 401 && accessCheck.url === oauth.resource && !accessCheck.headers.has("location");
    await accessCheck?.body?.cancel().catch(() => undefined);
    const refreshCheck = refreshToken === null ? null : await this.scenarioFetch(new URL("/token", issuer), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: oauth.clientMetadataUrl, resource: oauth.resource }).toString(),
    });
    const refreshBody = refreshCheck === null ? "" : (await refreshCheck.text()).slice(0, 1_024);
    const refreshDenied = refreshCheck === null || refreshCheck.status === 400 && /"error"\s*:\s*"invalid_grant"/.test(refreshBody) && !refreshCheck.headers.has("location");
    const complete = codeTerminalized && refreshRevoked && accessRevoked && accessDenied && refreshDenied;
    await this.ledger.appendEvent(run.id, "security.oauth_family_cleanup", "canonical", {
      complete,
      authorization_code_cleanup_handle_used: true,
      authorization_code_family_terminalized: codeTerminalized,
      access_token_issued: accessToken !== null,
      refresh_token_issued: refreshToken !== null,
      refresh_family_revocation_receipt: refreshRevoked,
      access_revocation_receipt: accessRevoked,
      access_token_denied_after_revocation: accessDenied,
      refresh_token_denied_after_revocation: refreshDenied,
      durable_terminal_state_verified: accessDenied && refreshDenied,
      raw_tokens_excluded: true,
    }, `security:${run.id}:oauth-family-cleanup`);
    if (!complete) throw new VoiceLabError(labError("OAUTH_FAMILY_CLEANUP_FAILED", "The governed OAuth probe family did not reach a durable revoked state.", "authorization", true));
  }

  #authorizationParams(oauth: NonNullable<VoiceLabConfig["oauth"]>, scopes: string, resource: string, verifier?: string): URLSearchParams {
    const effectiveVerifier = verifier ?? `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    return new URLSearchParams({ response_type: "code", response_mode: "query", client_id: oauth.clientMetadataUrl, redirect_uri: oauth.clientRedirectUri, scope: scopes, state: `s01-${randomUUID()}`, code_challenge: pkceS256(effectiveVerifier), code_challenge_method: "S256", resource });
  }

  async #recordOAuthProbe(run: RunRecord, variant: typeof S01_OAUTH_VARIANTS[number], rejected: boolean, httpStatus: number, detail: Record<string, unknown>): Promise<void> {
    await this.ledger.appendEvent(run.id, "security.oauth_boundary_probe", "canonical", { variant, rejected, http_status: httpStatus, ...detail }, `security:${run.id}:${variant}`);
    if (!rejected) throw new VoiceLabError(labError("OAUTH_SECURITY_PROBE_FAILED", "A governed OAuth rejection was not proven at the production resource boundary.", "authorization", false, { variant, http_status: httpStatus }));
  }

  async #finalizePreResourceScenario(runId: string): Promise<void> {
    let run = await this.#freshRun(runId);
    const events = await this.#allEvents(run.id);
    const operations = await this.ledger.listOperations(run.id);
    const assertions = evaluateScenarioAssertions(run, events.events, operations);
    if (!assertions.harness.every((assertion) => assertion.status === "pass") || !authoritativeLiveCleanupComplete(events.events)) throw new VoiceLabError(labError("PRE_RESOURCE_CERTIFICATION_INCOMPLETE", "Pre-resource certification cannot pass without every governed rejection and authoritative zero-orphan recovery.", "harness", true, { scenario_id: run.scenarioId }));
    const verdicts: Verdicts = { harness: "pass", product: "unavailable", provider: "unavailable", auth: run.scenarioId === "V-S01" ? "pass" : "unavailable", evidence: "pass" };
    run = await this.#freshRun(run.id);
    run = await transitionRun(this.ledger, run, "completed", { verdicts, cleanupComplete: true, ...retentionPatchFromEvents(events.events) });
    const terminalEvent = await this.ledger.appendEvent(run.id, "run.completed", "worker", { terminal_state: "completed", terminal_reason: "pre_resource_security_recipe_passed", cleanup_complete: true, intentionally_unallocated: true }, `run:${run.id}:completed`);
    await this.#publishRunEvidence({
      runId: run.id,
      terminalState: "completed",
      terminalReason: "pre_resource_security_recipe_passed",
      verdicts,
      terminalError: null,
      createdAt: terminalEvent.at,
      purpose: "pre-resource",
      intentionallyUnallocated: true,
      artifacts: [],
    });
  }

  async #certifyFreshApiReattach(run: RunRecord): Promise<void> {
    if (!this.config.databaseUrl) {
      await this.ledger.appendEvent(run.id, "durability.api_reattach_unavailable", "worker", { reason: "production_postgres_required" }, `durability:${run.id}:api-reattach-unavailable`);
      return;
    }
    const independent = new PostgresVoiceLabLedger(this.config.databaseUrl, 1, this.config.recoveryInternalSecret, this.config.callerPartitionKeys);
    try {
      await independent.initialize();
      const reattached = await independent.getRun(run.id);
      const exact = reattached?.testRunId === run.testRunId && reattached?.latestCursor === (await this.ledger.getRun(run.id))?.latestCursor;
      await this.ledger.appendEvent(run.id, "durability.independent_ledger_reader", "worker", { exact_test_run: exact, fresh_postgres_pool: true, browser_interaction_count: 0, mutation_count: 0, reattached_state: reattached?.state ?? null, reattached_version: reattached?.version ?? null, explicit_non_claim: "does_not_prove_mcp_api_process_restart" }, `durability:${run.id}:independent-ledger-reader`);
      if (!exact) throw new VoiceLabError(labError("API_REATTACH_FAILED", "A fresh durable API adapter could not reattach the exact test run.", "harness", true));
    } finally { await independent.close(); }
  }

  async #fenceMutation(claimed: ClaimedOperation, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const operationOwned = await this.ledger.heartbeatOperation(claimed.operation.id, this.workerId, claimed.operation.leaseEpoch, this.config.operationLeaseSeconds);
    if (!operationOwned) throw new VoiceLabError(labError("LEASE_LOST", "Operation lease was lost before page mutation.", "conflict", true));
    const lease = this.#activeLeases.get(claimed.run.id);
    if (!lease) throw new VoiceLabError(labError("BROWSER_LEASE_LOST", "Browser lease is not owned before page mutation.", "conflict", true));
    const browserOwned = await this.ledger.heartbeatBrowserLease(claimed.run.id, this.workerId, lease.epoch, this.config.browserLeaseSeconds);
    if (!browserOwned) throw new VoiceLabError(labError("BROWSER_LEASE_LOST", "Browser lease was lost before page mutation.", "conflict", true));
    throwIfCancelled(signal);
  }

  async #awaitPriorInputSettlement(run: RunRecord, operationId: string, signal: AbortSignal): Promise<void> {
    const prior = (await this.ledger.listOperations(run.id))
      .filter((operation) => operation.id !== operationId && operation.state === "succeeded" && (operation.type === "speak" || operation.type === "barge_in"))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
    if (!prior) return;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      const events = await this.#allEvents(run.id);
      const settled = events.events.some((event) => isExactBoundProductEvent(run, event) && event.kind === "audio.input.product_turn" && (event.payload.receipt as Record<string, unknown> | undefined)?.operation_id === prior.id && (event.payload.receipt as Record<string, unknown> | undefined)?.source === "settlement");
      if (settled) return;
      await this.#persistEvents(run.id, await this.driver.drain(run.id));
      await delay(100);
    }
    throw new VoiceLabError(labError("INPUT_OPERATION_SETTLEMENT_PENDING", "The prior exact input operation did not reach its app-authored turn settlement before another injection could start.", "harness", true, { prior_operation_id: prior.id }));
  }

  async #revalidateActiveTarget(run: RunRecord, operationId: string, target: Record<string, unknown>): Promise<void> {
    await this.#persistEvents(run.id, await this.driver.drain(run.id));
    const page = await this.#allEvents(run.id);
    const targetSeq = Number(target.event_seq);
    const cited = page.events.find((event) => event.seq === targetSeq && isExactBoundProductEvent(run, event));
    let active = false;
    let kind: "output_realization" | "tool_effect";
    if (target.kind === "output_realization") {
      kind = "output_realization";
      const receipt = cited?.payload.receipt as Record<string, unknown> | undefined;
      const identityEvents = page.events.filter((event) => {
        if (!isExactBoundProductEvent(run, event)) return false;
        const later = event.payload.receipt as Record<string, unknown> | undefined;
        return later?.realizationId === target.stable_id || (typeof target.chunk_hash === "string" && later?.chunkHash === target.chunk_hash);
      });
      const terminal = identityEvents.some((event) => ["audio.output.completed", "audio.output.flushed", "audio.output.dropped"].includes(event.kind));
      const competingStart = identityEvents.some((event) => event.seq !== targetSeq && event.kind === "audio.output.started");
      active = cited?.kind === "audio.output.started" && receipt?.phase === "started" && receipt.realizationId === target.stable_id && receipt.chunkHash === target.chunk_hash
        && receipt.providerConnectionEpoch === target.provider_connection_epoch && receipt.playbackGeneration === target.playback_generation && !terminal && !competingStart;
    } else {
      kind = "tool_effect";
      const entry = cited?.payload.entry as Record<string, unknown> | undefined;
      const toolCallId = target.tool_call_id ?? target.stable_id;
      const terminal = page.events.some((event) => {
        if (!isExactBoundProductEvent(run, event) || event.seq <= targetSeq || !event.kind.includes("gemini-tool-call-ledger")) return false;
        const later = event.payload.entry as Record<string, unknown> | undefined;
        return later !== undefined && later.toolCallId === toolCallId && later.effectId === target.effect_id && ["responded", "cancelled-before-send", "cancelled-after-send", "suppressed", "rejected"].includes(String(later.finalState));
      });
      active = cited?.kind.includes("gemini-tool-call-ledger") === true && entry !== undefined && entry.toolCallId === toolCallId && entry.effectId === target.effect_id && entry.finalState === "unknown"
        && entry.toolResponseSentAt === null && entry.cancelledAt === null && entry.providerConnectionEpoch === target.provider_connection_epoch && !terminal;
    }
    if (!active) throw new VoiceLabError(labError("ACTIVE_TARGET_REVALIDATION_FAILED", "The exact app-authored work target was no longer in flight immediately before governed page mutation.", "conflict", true, { target_event_seq: targetSeq, target_kind: kind }));
    await this.ledger.appendEvent(run.id, "fault.active_target_revalidated", "canonical", { operation_id: operationId, target_event_seq: targetSeq, target_kind: kind, target_identity_sha256: sha256(`${String(target.stable_id ?? target.tool_call_id)}\u0000${String(target.effect_id ?? target.chunk_hash)}`), observed_through_seq: page.latest, active: true }, `active-target:${operationId}:${targetSeq}`);
  }

  async #mintAndVerify(run: RunRecord, audience: "sophia-voice-lab-frontend" | "sophia-voice-runtime" | "sophia-voice-lab-recovery", allowedOps: string[], operation: string, resolvedD02Binding?: D02BrowserContextBinding, expectedDeployment = run.target.expectedDeployment) {
    const codec = audience === "sophia-voice-lab-frontend" ? this.#frontendCapabilities : this.capabilities;
    const provisionalRetentionCeiling = run.createdAt.getTime() + run.capturePolicy.retentionHours * 3_600_000;
    if (run.expiresAt.getTime() > provisionalRetentionCeiling) throw new VoiceLabError(labError("CAPABILITY_BINDING_INVALID", "The immutable provider deadline exceeded the run's provisional retention ceiling.", "internal", false));
    const providerExpiresAt = run.expiresAt.toISOString();
    const d02Binding = resolvedD02Binding ?? await this.#resolveD02BrowserContextBinding(run);
    const minted = codec.mint({ aud: audience, sub: run.principalId, principal_id: run.principalId, test_run_id: run.testRunId, cleanup_obligation_id: run.cleanupObligationId, ...(run.scenarioId === null ? {} : { scenario_id: run.scenarioId }), ...(run.scenarioVersion === null ? {} : { scenario_version: run.scenarioVersion }), ...(d02Binding ?? {}), synthetic: true, environment: run.environment, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: providerExpiresAt, allowed_ops: allowedOps, expected_deployment: expectedDeployment });
    codec.verify(minted.token, { audience, operation, principalId: run.principalId, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, environment: run.environment, retentionHours: run.capturePolicy.retentionHours, providerExpiresAt, expectedDeployment, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion, ...(d02Binding ? { voiceLabRunIdSha256: d02Binding.voice_lab_run_id_sha256, browserWorkerIdSha256: d02Binding.browser_worker_id_sha256, browserLeaseEpoch: d02Binding.browser_lease_epoch, browserContextIdSha256: d02Binding.browser_context_id_sha256 } : {}) });
    const runtimeRebound = canonicalRequestHash(expectedDeployment) !== canonicalRequestHash(run.target.expectedDeployment);
    const auditBinding = { audience, operation, test_run_id: run.testRunId, environment: run.environment, provider_expires_at: providerExpiresAt, expected_deployment: expectedDeployment, recovery_runtime_rebound: runtimeRebound, ...(d02Binding ?? {}) };
    await this.ledger.recordAuthAudit({ runId: run.id, callerId: run.callerId, action: `capability:${operation}`, capabilityJtiHash: sha256(minted.claims.jti), argumentHash: canonicalRequestHash(auditBinding), outcome: "allowed", detail: { audience, operation, provider_expires_at: providerExpiresAt, recovery_runtime_rebound: runtimeRebound, original_expected_deployment_sha256: runtimeRebound ? canonicalRequestHash(run.target.expectedDeployment) : null, ...(d02Binding ?? {}) }, observedAt: new Date() });
    return minted;
  }

  async #resolveD02BrowserContextBinding(run: RunRecord): Promise<D02BrowserContextBinding | undefined> {
    if (run.scenarioId !== "V-D02") return undefined;
    const active = this.#activeLeases.get(run.id);
    const activeBinding = active ? deriveD02BrowserContextBinding(run, this.workerId, active.epoch) : undefined;
    const durable = await this.ledger.findLatestEvent(run.id, ["harness.browser_context_bound"]);
    if (!durable) {
      if (activeBinding) return activeBinding;
      throw new VoiceLabError(labError("BROWSER_CONTEXT_BINDING_UNAVAILABLE", "The exact V-D02 browser ownership binding was not durably available.", "harness", false));
    }
    const payload = durable.payload;
    const durableBinding: D02BrowserContextBinding = {
      voice_lab_run_id_sha256: String(payload.voice_lab_run_id_sha256 ?? ""),
      browser_worker_id_sha256: String(payload.browser_worker_id_sha256 ?? ""),
      browser_lease_epoch: Number(payload.browser_lease_epoch),
      browser_context_id_sha256: String(payload.browser_context_id_sha256 ?? ""),
    };
    if (!isExactD02BrowserContextBinding(run, durableBinding)
      || payload.schema !== "sophia_voice_lab_browser_context_binding_v1"
      || payload.driver_attested !== true
      || payload.test_run_id_sha256 !== sha256(run.testRunId)
      || payload.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)
      || (activeBinding !== undefined && !sameD02BrowserContextBinding(durableBinding, activeBinding))) {
      throw new VoiceLabError(labError("BROWSER_CONTEXT_BINDING_MISMATCH", "The durable V-D02 browser ownership binding conflicted with the reserved run or current lease.", "harness", false));
    }
    return durableBinding;
  }

  async #persistEvents(runId: string, events: Array<Omit<import("./domain.js").LabEvent, "runId" | "seq" | "at">>): Promise<void> {
    const boundRun = await this.#freshRun(runId);
    for (const event of events) {
      const provenance = event.payload._capture_provenance as Record<string, unknown> | undefined;
      const rawObservedAt = provenance?.recorded_at ?? provenance?.observed_at;
      const parsed = typeof rawObservedAt === "string" ? new Date(rawObservedAt) : new Date();
      const appBinding = strictProductRunBinding(event.source, event.payload, boundRun);
      const governedPayload = event.payload;
      await this.ledger.appendEvent(runId, event.kind, event.source, redact({ ...governedPayload, _runner_binding: { run_id: runId, test_run_id_sha256: sha256(boundRun.testRunId) }, ...(appBinding === null ? {} : { _product_run_binding: appBinding }) }), event.dedupeKey ?? undefined, Number.isNaN(parsed.getTime()) ? new Date() : parsed);
      if (event.source === "product" && event.kind === "audio.input.product_fault" && appBinding !== null) {
        const receipt = event.payload.receipt as Record<string, unknown> | undefined;
        throw new VoiceLabError(labError("PRODUCT_INPUT_EVIDENCE_FAULT", "The product rejected or could not unambiguously correlate the governed synthetic input operation.", "harness", false, { fault_code: typeof receipt?.code === "string" ? receipt.code : "unknown" }));
      }
    }
    let run = await this.#freshRun(runId);
    let canonicalSessionId = run.canonicalSessionId;
    let threadId = run.threadId;
    let providerSessionId = run.providerSessionId;
    let traceId = run.traceId;
    let providerEpoch = run.providerEpoch;
    let turnId = run.turnId;
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      // Owning product joins are usable only when the original capture envelope
      // carried the exact app-authored authenticated synthetic binding.
      if (event.source === "product" && strictProductRunBinding(event.source, payload, boundRun) === null) continue;
      if (event.kind === "session.credentials_received") {
        canonicalSessionId = stableJoin("canonical_session_id", canonicalSessionId, exactString(payload.sessionId));
        providerSessionId = stableJoin("provider_session_id", providerSessionId, exactString(payload.voiceAgentSessionId));
        traceId = stableJoin("trace_id", traceId, exactString(payload.langsmithTraceId));
        providerEpoch = monotonicEpoch(providerEpoch, exactFiniteNumber(payload.providerConnectionEpoch));
      } else if (event.kind === "provider.connection_epoch") {
        const receipt = payload.receipt && typeof payload.receipt === "object" ? payload.receipt as Record<string, unknown> : {};
        canonicalSessionId = stableJoin("canonical_session_id", canonicalSessionId, exactString(payload.sessionId));
        providerSessionId = stableJoin("provider_session_id", providerSessionId, exactString(payload.voiceAgentSessionId));
        traceId = stableJoin("trace_id", traceId, exactString(receipt.langsmithTraceId));
        providerEpoch = monotonicEpoch(providerEpoch, exactFiniteNumber(receipt.providerConnectionEpoch));
      } else if (event.kind === "capture.snapshot") {
        const snapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot as Record<string, unknown> : {};
        const session = snapshot.session && typeof snapshot.session === "object" ? snapshot.session as Record<string, unknown> : {};
        canonicalSessionId = stableJoin("canonical_session_id", canonicalSessionId, exactString(session.sessionId));
        threadId = stableJoin("thread_id", threadId, exactString(session.threadId));
      } else if (event.source === "canonical" && event.kind === "session.finalized") {
        const receipt = payload.receipt && typeof payload.receipt === "object" ? payload.receipt as Record<string, unknown> : {};
        const transcript = receipt.canonical_transcript && typeof receipt.canonical_transcript === "object" ? receipt.canonical_transcript as Record<string, unknown> : {};
        canonicalSessionId = stableJoin("canonical_session_id", canonicalSessionId, exactString(transcript.session_id));
        threadId = stableJoin("thread_id", threadId, exactString(transcript.thread_id));
      } else if (event.kind.endsWith(".sophia.turn")) {
        const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
        turnId = exactString(data.turnId) ?? turnId;
      }
    }
    if (canonicalSessionId !== run.canonicalSessionId || threadId !== run.threadId || providerSessionId !== run.providerSessionId || traceId !== run.traceId || providerEpoch !== run.providerEpoch || turnId !== run.turnId) {
      run = await this.ledger.updateRun(run.id, run.version, { canonicalSessionId, threadId, providerSessionId, traceId, providerEpoch, turnId });
    }
  }

  async #terminalizeFailure(runId: string, error: LabError, forcedState?: RunState): Promise<void> {
    let run = await this.#freshRun(runId);
    const cancelled = await this.ledger.cancelPendingRunOperations(run.id, null, labError("RUN_TERMINATED", "Operation was cancelled because its owning run became terminal.", "harness", false, { terminal_reason: error.code }));
    for (const operation of cancelled) await this.ledger.appendEvent(run.id, "operation.cancelled", "worker", { operation_id: operation.id, operation_type: operation.type, reason_code: operation.error?.code ?? "RUN_TERMINATED" }, `operation:${operation.id}:cancelled`);
    if (TERMINAL_RUN_STATES.has(run.state)) {
      if (run.state !== "completed") {
        const recovered = await this.#recoverRun(run);
        await this.#persistEvents(run.id, recovered.events);
      }
      run = await this.#freshRun(run.id);
      const recoveryPage = await this.#allEvents(run.id);
      const browserLeaseReleased = await this.#releaseBrowserLeaseProof(run.id);
      const liveCleanupComplete = authoritativeLiveCleanupComplete(recoveryPage.events) && !this.driver.hasSession(run.id) && browserLeaseReleased;
      if (liveCleanupComplete && !run.cleanupComplete) run = await this.ledger.updateRun(run.id, run.version, { cleanupComplete: true, ...retentionPatchFromEvents(recoveryPage.events) });
      // Rebuild the deterministic failure manifest after every recovery
      // attempt so a pending receipt can become a durable complete receipt.
      await this.#saveFailureEvidence(run, run.terminalError ?? error, []);
      return;
    }
    let ended: Awaited<ReturnType<VoiceBrowserDriver["abort"]>> = { events: [], artifacts: [] };
    if (this.driver.hasSession(run.id)) {
      const finalizeGrant = await this.#mintAndVerify(run, "sophia-voice-lab-frontend", ["session:finalize"], "session:finalize");
      const cleanupGrant = await this.#mintAndVerify(run, "sophia-voice-lab-frontend", ["session:cleanup"], "session:cleanup");
      ended = await this.driver.abort(run, error.code, finalizeGrant.token, cleanupGrant.token);
      await this.#persistEvents(run.id, ended.events);
      run = await this.#freshRun(run.id);
    }
    const recovered = await this.#recoverRun(run);
    ended = { events: [...ended.events, ...recovered.events], artifacts: [...ended.artifacts, ...recovered.artifacts] };
    await this.#persistEvents(run.id, recovered.events);
    run = await this.#freshRun(run.id);
    const state: RunState = forcedState ?? (error.code === "CAPTURE_CURSOR_GAP" || error.code === "CAPTURE_DRAIN_UNSUPPORTED" || error.code === "PRODUCT_INPUT_EVIDENCE_FAULT" ? "invalid_test" : error.code === "DEPLOYMENT_MISMATCH" ? "deployment_mismatch" : error.category === "authorization" ? "authorization_failed" : error.category === "product" ? "product_failed" : error.category === "provider" ? "inconclusive_provider" : "failed_harness");
    const verdicts = deriveFailureVerdicts(run, state, ended.events);
    const browserLeaseReleased = await this.#releaseBrowserLeaseProof(run.id);
    const liveCleanupComplete = authoritativeLiveCleanupComplete(ended.events) && !this.driver.hasSession(run.id) && browserLeaseReleased;
    run = await this.ledger.updateRun(run.id, run.version, { state, verdicts, terminalError: error, cleanupComplete: liveCleanupComplete, ...retentionPatchFromEvents(ended.events) });
    await this.ledger.appendEvent(run.id, `run.${state}`, "worker", { error }, `run:${run.id}:${state}`);
    await this.#saveFailureEvidence(run, error, ended.artifacts);
  }

  async #recoverRun(run: RunRecord): Promise<Awaited<ReturnType<VoiceBrowserDriver["recover"]>>> {
    const combined: Awaited<ReturnType<VoiceBrowserDriver["recover"]>> = { events: [], artifacts: [] };
    const browserLease = await this.ledger.getBrowserLease(run.id);
    const allocationFree = run.canonicalSessionId === null && run.threadId === null && run.providerSessionId === null && run.traceId === null && run.providerEpoch === null && run.turnId === null && browserLease === null && !this.driver.hasSession(run.id);
    const recoveryExpectedDeployment = allocationFree && this.config.readinessTarget !== null
      ? this.config.readinessTarget.expectedDeployment
      : run.target.expectedDeployment;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recoveryGrant = await this.#mintAndVerify(run, "sophia-voice-lab-recovery", ["session:recover"], "session:recover", undefined, recoveryExpectedDeployment);
      const result = await this.driver.recover(run, recoveryGrant.token);
      combined.events.push(...result.events);
      combined.artifacts.push(...result.artifacts);
      if (result.events.some((event) => event.kind === "cleanup.recovery" && event.payload.complete === true)) break;
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
    return combined;
  }

  async #saveFailureEvidence(run: RunRecord, error: LabError, artifacts: Array<{ id: string; kind: string; contentType: string; bytes: Buffer }>): Promise<void> {
    const events = await this.#allEvents(run.id);
    const operations = await this.ledger.listOperations(run.id);
    const authAudit = await this.ledger.listAuthAudit(run.id);
    const assertions = evaluateScenarioAssertions(run, events.events, operations, authAudit);
    const assertionHarness: Verdicts["harness"] = assertions.harness.length > 0 && assertions.harness.every((assertion) => assertion.status === "pass")
      ? "pass"
      : assertions.harness.some((assertion) => assertion.status === "fail") ? "fail" : "unavailable";
    const terminalEvent = [...events.events].reverse().find((event) => event.kind === `run.${run.state}`);
    const verdicts: Verdicts = {
      ...run.verdicts,
      harness: run.scenarioId === "V-D02" ? assertionHarness : run.verdicts.harness,
      evidence: error.code === "EXTERNAL_EVIDENCE_DEADLINE_EXPIRED" ? "fail" : run.cleanupComplete ? (assertionHarness === "pass" ? "pass" : "unavailable") : "fail",
    };
    const existingEvidence = await this.ledger.getEvidence(run.id);
    if (existingEvidence && existingEvidence.revisionSeq >= events.latest) {
      // A retry with no new durable event cannot rewrite the deterministic
      // manifest at the same cursor. The prior manifest already contains the
      // same derived verdict; only the cached run projection may lag because
      // it is updated after the append-only evidence transaction.
      const fresh = await this.#freshRun(run.id);
      if (canonicalRequestHash(fresh.verdicts) !== canonicalRequestHash(verdicts)) await this.ledger.updateRun(fresh.id, fresh.version, { verdicts });
      return;
    }
    await this.#publishRunEvidence({
      runId: run.id,
      terminalState: run.state,
      terminalReason: error.code,
      verdicts,
      terminalError: error,
      createdAt: terminalEvent?.at ?? events.events.at(-1)?.at ?? run.updatedAt,
      purpose: "failure",
      intentionallyUnallocated: run.scenarioId === "V-S01" || run.scenarioId === "V-S02",
      artifacts,
    });
    const fresh = await this.#freshRun(run.id);
    await this.ledger.updateRun(fresh.id, fresh.version, { verdicts });
  }

  /**
   * One §12-shaped, append-only evidence builder for every terminal outcome.
   * Success, observed product/provider defects, invalid tests, authorization
   * failures, driver restarts and pre-resource security recipes differ only in
   * their truthful availability/failure fields; they never get a smaller
   * bespoke bundle. Returned canonical artifact rows always define the public
   * URI/hash, so content dedupe cannot create a dangling proposed reference.
   */
  async #publishRunEvidence(input: {
    runId: string;
    terminalState: RunState;
    terminalReason: string;
    verdicts: Verdicts;
    terminalError: LabError | null;
    createdAt: Date;
    purpose: string;
    intentionallyUnallocated: boolean;
    artifacts: Array<{ id: string; kind: string; contentType: string; bytes: Buffer }>;
  }): Promise<void> {
    const run = await this.#freshRun(input.runId);
    const evidenceExpiresAt = (run.retentionPurgeDueAt ?? new Date(input.createdAt.getTime() + run.capturePolicy.retentionHours * 3_600_000)).toISOString();
    let [publicationOperations, publicationAuthAudit, publicationArtifacts] = await Promise.all([
      this.ledger.listOperations(run.id),
      this.ledger.listAuthAudit(run.id),
      this.ledger.listArtifacts(run.id),
    ]);
    const unpublishedArtifactBytes = publicationArtifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0);
    if (unpublishedArtifactBytes >= 6_000_000 && await this.ledger.getEvidence(run.id) === null) {
      const deleted = await this.ledger.deleteUnpublishedArtifacts(run.id);
      await this.ledger.appendEvent(run.id, "evidence.orphan_artifacts_pruned", "worker", {
        deleted_artifact_count: deleted,
        deleted_byte_count: unpublishedArtifactBytes,
        canonical_run_and_operation_ledgers_preserved: true,
        published_manifest_absent: true,
      }, `evidence:${run.id}:orphan-artifacts-pruned`);
      publicationArtifacts = [];
    }
    const publicationRevisionHash = evidenceProjectionHash({
      purpose: input.purpose,
      terminal_state: input.terminalState,
      terminal_reason: input.terminalReason,
      terminal_error: input.terminalError,
      verdicts: input.verdicts,
      created_at: input.createdAt.toISOString(),
      run_projection: {
        observed_deployment: run.observedDeployment,
        cleanup_complete: run.cleanupComplete,
        retention_purge_due_at: run.retentionPurgeDueAt?.toISOString() ?? null,
        retention_purge_pending: run.retentionPurgePending,
        retention_purge_verified_at: run.retentionPurgeVerifiedAt?.toISOString() ?? null,
      },
      operations: publicationOperations.map((operation) => ({
        id: operation.id,
        type: operation.type,
        state: operation.state,
        attempt_count: operation.attemptCount,
        request_hash: operation.requestHash,
        result_sha256: operation.result === null ? null : evidenceProjectionHash(operation.result),
        error_sha256: operation.error === null ? null : evidenceProjectionHash(operation.error),
        updated_at: operation.updatedAt.toISOString(),
      })),
      authorization_audit: publicationAuthAudit.map((audit) => ({
        id: audit.id,
        action: audit.action,
        capability_jti_hash: audit.capabilityJtiHash,
        argument_hash: audit.argumentHash,
        outcome: audit.outcome,
        detail_sha256: evidenceProjectionHash(audit.detail),
        observed_at: audit.observedAt.toISOString(),
      })),
      durable_artifacts: publicationArtifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        content_type: artifact.contentType,
        sha256: artifact.sha256,
      })),
      incoming_artifacts: input.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        content_type: artifact.contentType,
        sha256: sha256(artifact.bytes),
      })),
    });
    await this.ledger.appendEvent(
      run.id,
      "evidence.publication_revision",
      "worker",
      { publication_revision_sha256: publicationRevisionHash, purpose: input.purpose },
      `evidence:${run.id}:publication:${input.purpose}:${publicationRevisionHash}`,
    );
    for (const artifact of input.artifacts) {
      if (artifact.bytes.byteLength > 2_000_000) {
        await this.ledger.appendEvent(run.id, "evidence.artifact_dropped", "worker", { kind: artifact.kind, reason: "size_limit", byte_length: artifact.bytes.byteLength }, `evidence:${run.id}:${sha256(artifact.id)}:dropped`);
        continue;
      }
      await this.ledger.saveArtifact({ ...artifact, runId: run.id, sha256: sha256(artifact.bytes), createdAt: input.createdAt });
    }
    const eventPage = await this.#allEvents(run.id);
    const operations = await this.ledger.listOperations(run.id);
    const authAudit = await this.ledger.listAuthAudit(run.id);
    const refs: EvidenceRef[] = [];
    const originalArtifacts = (await this.ledger.listArtifacts(run.id)).filter((artifact) => artifact.kind !== "manifest_attachment" && artifact.kind !== "capture_json");
    for (const artifact of originalArtifacts) refs.push({ kind: artifact.kind, resource_id: `voice-lab://artifact/${artifact.id}`, sha256: artifact.sha256, content_type: artifact.contentType, byte_length: artifact.bytes.byteLength, expires_at: evidenceExpiresAt });
    const eventEvidence = await this.#persistEventChunks(run, eventPage.events, evidenceExpiresAt, `${input.purpose}-${input.terminalState}-${eventPage.latest}`);
    refs.push(...eventEvidence.refs);

    const manifestId = deterministicUuid(run.id, `${input.purpose}:${input.terminalState}:${eventPage.latest}`);
    const projectionOverflowId = deterministicUuid(run.id, `${input.purpose}:${input.terminalState}:${eventPage.latest}:projection-overflow`);
    const projectionOverflow: EvidenceProjectionOverflowRecord[] = [];
    const projectEvidence = (path: string, value: unknown): unknown => projectEvidenceValue(path, value, projectionOverflowId, projectionOverflow);
    const projectedTerminalError = input.terminalError === null ? null : projectEvidence("terminal_error", input.terminalError);
    const acquiredBrowser = eventPage.events.find((event) => event.kind === "harness.browser_runtime_acquired" && event.source === "canonical");
    const productEvents = eventPage.events.filter((event) => isExactBoundProductEvent(run, event));
    const taskCleanup = deriveTaskCleanup(eventPage.events, run);
    const browserContextClosed = !this.driver.hasSession(run.id) && eventPage.events.some((event) =>
      event.kind === "cleanup.browser_context_absent" && event.payload.browser_never_allocated === true
      || event.kind === "cleanup.browser_context_closed" && event.payload.close_resolved === true && event.payload.browser_registry_absent === true);
    const browserLeaseReleased = eventPage.events.some((event) =>
      event.kind === "cleanup.browser_lease_released" && event.payload.cas_deleted === true
      || event.kind === "cleanup.browser_lease_absent" && event.payload.authoritative_ledger_read === true);
    const providerDisconnected = productEvents.some((event) => event.kind === "provider.stage" && ["closed", "ended"].includes(String(event.payload.stage))) || recoveryComponentComplete(eventPage.events, "voice_provider");
    const authSessionRevoked = eventPage.events.some(authCleanupConfirmed) || recoveryComponentComplete(eventPage.events, "auth_sessions");
    const liveCleanupComplete = authoritativeLiveCleanupComplete(eventPage.events);
    const assertions = evaluateScenarioAssertions(run, eventPage.events, operations, authAudit);
    const platformAttestation = eventPage.events.find((event) => event.source === "canonical" && event.kind === "external.attestation.p01_platform_plugin_task" && event.payload.binding_validated === true && typeof event.payload.content_sha256 === "string");
    const platformProof = platformAttestation?.payload.evidence as Record<string, unknown> | undefined;
    const platformInstallProjection = platformAttestation && platformProof ? {
      status: "available",
      source: "platform_plugin_ed25519_attestation",
      attestation_id_sha256: sha256(String(platformAttestation.payload.attestation_id)),
      content_sha256: platformAttestation.payload.content_sha256,
      registered_app_id: platformProof.registered_app_id,
      plugin_version: platformProof.plugin_version,
      plugin_package_sha256: platformProof.plugin_package_sha256,
      install_receipt_sha256: platformProof.install_receipt_sha256,
      platform_task_id_sha256: platformProof.platform_task_id_sha256,
      platform_thread_id_sha256: platformProof.platform_thread_id_sha256,
      installed_at: platformProof.installed_at,
      fresh_task_started_at: platformProof.fresh_task_started_at,
      fresh_task_completed_at: platformProof.fresh_task_completed_at,
      high_level_call_count: platformProof.high_level_call_count,
    } : { status: "unavailable", reason: "platform_authored_install_and_fresh_task_attestation_not_attached" };
    const failureOwner = input.terminalError === null ? null : input.terminalState === "product_failed" ? "product" : input.terminalState === "inconclusive_provider" ? "provider" : input.terminalState === "authorization_failed" ? "auth" : input.terminalError.category === "evidence" ? "evidence" : "harness";
    const intentionallyUnavailable = input.intentionallyUnallocated ? { status: "intentionally_unallocated_pre_resource", reason: "scenario_rejects_before_browser_provider_session_allocation" } : null;
    const manifest = {
      contract_version: "sophia.voice-lab.evidence.v1",
      schema_version: "sophia.voice-lab.evidence.v1",
      scenario_version: run.scenarioVersion,
      manifest_id: manifestId,
      versions: {
        harness: this.config.harnessVersion,
        plugin: this.config.pluginVersion,
        mcp: this.config.mcpVersion,
        service_commit: this.config.serviceVersion,
        evidence_schema: "sophia.voice-lab.evidence.v1",
        scenario_catalog: run.scenarioVersion,
        registered_app: {
          technical_id: this.config.registeredAppId ?? { status: "unavailable", reason: "registered_app_technical_id_pending_configuration" },
          plugin_package_sha256: this.config.pluginPackageSha256,
          platform_install_attestation: platformInstallProjection,
        },
      },
      repository_commits: { base: this.config.repositoryBaseSha, candidate: this.config.repositoryCandidateSha, rollback: this.config.repositoryRollbackSha },
      run_id: run.id,
      test_run_id: run.testRunId,
      test_principal: { principal_id_sha256: sha256(run.principalId), raw_identifier_excluded: true },
      cleanup_obligation: { cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), raw_identifier_excluded: true },
      environment: run.environment,
      scenario: { id: run.scenarioId, version: run.scenarioVersion, resource_allocation: input.intentionallyUnallocated ? "intentionally_none" : "ordinary_deployed_path" },
      run_lifecycle: { started_at: run.createdAt.toISOString(), ended_at: input.createdAt.toISOString(), terminal_state: input.terminalState, terminal_reason: input.terminalReason },
      certification: {
        status: input.verdicts.harness === "pass" && input.verdicts.evidence === "pass" ? "certified" : input.verdicts.harness === "unavailable" || input.verdicts.evidence === "unavailable" ? "pending_external_evidence" : "not_certified",
        revision_seq: eventPage.latest,
        execution_terminal_state_immutable: true,
        current_manifest_pointer_advances_append_only: true,
      },
      terminal_state: input.terminalState,
      terminal_reason: input.terminalReason,
      terminal_error: projectedTerminalError,
      deployment_identity: {
        expected: run.target.expectedDeployment,
        observed: run.observedDeployment,
        observations: eventPage.events.filter((event) => event.kind === "deployment.verified" || event.kind === "deployment.reverified").map((event) => ({
          phase: event.kind,
          observed_at: event.at.toISOString(),
          components: { frontend: event.payload.frontend, backend: event.payload.backend, voice: event.payload.voice },
        })),
      },
      deployment_dependencies: {
        expected: run.target.expectedDependencies,
        observations: eventPage.events.filter((event) => event.kind === "deployment.verified" || event.kind === "deployment.reverified").map((event) => ({
          phase: event.kind,
          observed_at: event.at.toISOString(),
          components: { langgraph: event.payload.langgraph },
        })),
      },
      browser: acquiredBrowser ? {
        engine: acquiredBrowser.payload.engine,
        version: acquiredBrowser.payload.version,
        readiness: "proven_at_run_acquisition",
        worker_id_sha256: acquiredBrowser.payload.worker_id_sha256,
        browser_lease_epoch: acquiredBrowser.payload.browser_lease_epoch,
        browser_context_id_sha256: acquiredBrowser.payload.browser_context_id_sha256 ?? null,
        operation_id: acquiredBrowser.payload.operation_id,
        acquired_at: acquiredBrowser.payload.acquired_at,
        service_version: acquiredBrowser.payload.service_version,
        allocation: { status: "durably_acquired" },
      } : { engine: null, version: null, readiness: "unavailable", worker_id_sha256: null, browser_lease_epoch: null, browser_context_id_sha256: null, operation_id: null, acquired_at: null, service_version: null, allocation: intentionallyUnavailable ?? { status: "runtime_acquisition_receipt_missing" } },
      verdicts: input.verdicts,
      joins: input.intentionallyUnallocated ? { status: "intentionally_unallocated_pre_resource", canonical_session: intentionallyUnavailable, thread: intentionallyUnavailable, gemini_runtime_session: intentionallyUnavailable, provider_connection_epoch: intentionallyUnavailable, turn: intentionallyUnavailable, langsmith: intentionallyUnavailable } : manifestJoins(run),
      message_revisions: projectEvidence("message_revisions", input.intentionallyUnallocated ? { status: "intentionally_unallocated_pre_resource", reason: intentionallyUnavailable!.reason, rows: [] } : projectMessageRevisions(run, eventPage.events)),
      utterances: projectEvidence("utterances", projectUtterances(run, eventPage.events, operations)),
      transcripts_and_turns: projectEvidence("transcripts_and_turns", input.intentionallyUnallocated ? { status: "intentionally_unallocated_pre_resource", reason: intentionallyUnavailable!.reason, count: 0, event_refs: [] } : projectEvents(productEvents, (event) => event.kind.includes("transcript") || event.kind.endsWith(".sophia.user_transcript") || event.kind.endsWith(".sophia.assistant_transcript") || event.kind.endsWith(".sophia.turn"))),
      media_receipts: projectEvidence("media_receipts", {
        input_frames: projectEvents(eventPage.events, (event) => event.kind === "harness.input_frame_forwarded"),
        input_product_legs: projectEvents(productEvents, (event) => event.kind === "audio.input.product_leg"),
        input_product_turns: projectEvents(productEvents, (event) => event.kind === "audio.input.product_turn"),
        output_chunks: projectEvents(productEvents, (event) => event.kind === "audio.output.received" || event.kind === "audio.output.leg_receipt"),
        playback_flush_interruption: projectEvents(productEvents, (event) => event.kind.startsWith("audio.output.") && event.kind !== "audio.output.received" && event.kind !== "audio.output.leg_receipt"),
      }),
      tool_receipts: projectEvidence("tool_receipts", projectEvents(productEvents, (event) => event.kind === "tool.call" || event.kind.includes("tool-call") || event.kind.includes("tool_result"))),
      builder_receipts: projectEvidence("builder_receipts", projectEvents(productEvents, (event) => event.kind.includes("builder") || event.kind.includes("task_state") || event.kind.includes("control"))),
      durable_projections: projectEvidence("durable_projections", { session_finalization: projectEvents(eventPage.events, (event) => event.kind === "session.finalized"), task_cleanup: taskCleanup }),
      ui_assertions: projectEvidence("ui_assertions", projectEvents(productEvents, (event) => event.kind === "ui.projection" || event.kind.includes("artifact"))),
      artifact_references: refs,
      screenshots: refs.filter((ref) => ref.kind.includes("screenshot")),
      video: { status: "unavailable", reason: "video_capture_disabled_or_not_implemented" },
      raw_audio: { status: "not_captured", reason: "privacy_default" },
      metrics: deriveEvidenceMetrics(eventPage.events, operations),
      cleanup_audit: {
        browser_context_closed: browserContextClosed,
        browser_lease_released: browserLeaseReleased,
        provider_disconnect: input.intentionallyUnallocated ? intentionallyUnavailable : providerDisconnected,
        auth_session_revoked: input.intentionallyUnallocated ? intentionallyUnavailable : authSessionRevoked,
        synthetic_tasks: taskCleanup,
        live_execution_resources_zero: liveCleanupComplete,
        cleanup_complete: run.cleanupComplete && liveCleanupComplete && browserContextClosed && browserLeaseReleased,
        recovery_receipts: projectEvidence("cleanup_audit/recovery_receipts", eventPage.events.filter((event) => event.kind === "cleanup.recovery").map((event) => ({ observed_at: event.at.toISOString(), ...event.payload }))),
        retention_purge_due_at: run.retentionPurgeDueAt?.toISOString() ?? null,
        retention_purge_pending: run.retentionPurgePending,
        retention_purged: run.retentionPurgeVerifiedAt !== null,
      },
      failure: input.terminalError === null ? { owner: null, classification: null, detail: null } : { owner: failureOwner, classification: input.terminalError.code, detail: projectedTerminalError },
      operations: projectEvidence("operations", operations.map((item) => ({ operation_id: item.id, type: item.type, state: item.state, attempt_count: item.attemptCount, idempotency_key_hash: sha256(item.idempotencyKey), request_hash: item.requestHash, result: projectEvidence(`operations/${item.id}/result`, item.result), error: projectEvidence(`operations/${item.id}/error`, item.error), created_at: item.createdAt.toISOString(), updated_at: item.updatedAt.toISOString() }))),
      authorization_audit: projectEvidence("authorization_audit", authAudit.map((item) => ({ action: item.action, capability_jti_hash: item.capabilityJtiHash ?? null, argument_hash: item.argumentHash, outcome: item.outcome, detail: projectEvidence(`authorization_audit/${item.id}/detail`, item.detail), observed_at: item.observedAt.toISOString() }))),
      external_attestations: eventPage.events.filter((event) => event.source === "canonical" && event.kind.startsWith("external.attestation.") && event.kind !== "external.attestation_nonce_claimed").map((event) => ({ kind: event.kind.slice("external.attestation.".length), event_seq: event.seq, content_sha256: event.payload.content_sha256, authority: (event.payload.evidence as Record<string, unknown> | undefined)?.authority ?? null, issuer: event.payload.issuer, authority_key_id: event.payload.authority_key_id, jti_sha256: sha256(String(event.payload.jti)), request_argument_sha256: event.payload.request_argument_sha256 })),
      event_stream: eventEvidence.index,
      assertions: projectEvidence("assertions", assertions),
      human_summary: assertions.summary,
    };
    if (projectionOverflow.length > 0) {
      const overflowPayload = { schema_version: "sophia.voice-lab.evidence-projection-overflow.v1", run_id: run.id, records: projectionOverflow };
      assertNoSecret(overflowPayload);
      const overflowBytes = await gzipAsync(Buffer.from(JSON.stringify(overflowPayload), "utf8"), { level: 9 });
      if (overflowBytes.byteLength > 2_000_000) throw new VoiceLabError(labError("EVIDENCE_PROJECTION_OVERFLOW_TOO_LARGE", "Compressed evidence projection overflow exceeded its durable row cap.", "evidence"));
      const savedOverflow = await this.ledger.saveArtifact({ id: projectionOverflowId, runId: run.id, kind: "capture_json", contentType: "application/gzip", sha256: sha256(overflowBytes), bytes: overflowBytes, createdAt: input.createdAt });
      refs.push({ kind: "evidence_projection_overflow", resource_id: `voice-lab://artifact/${savedOverflow.id}`, sha256: savedOverflow.sha256, content_type: savedOverflow.contentType, byte_length: savedOverflow.bytes.byteLength, expires_at: evidenceExpiresAt });
    }
    assertNoSecret(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    if (bytes.byteLength > 2_000_000) throw new VoiceLabError(labError("EVIDENCE_MANIFEST_TOO_LARGE", "Terminal evidence manifest exceeded its durable Postgres cap.", "evidence"));
    const savedManifest = await this.ledger.saveArtifact({ id: manifestId, runId: run.id, kind: "manifest_attachment", contentType: "application/json", sha256: sha256(bytes), bytes, createdAt: input.createdAt });
    const manifestRef: EvidenceRef = { kind: "manifest", resource_id: `voice-lab://evidence/${savedManifest.id}`, sha256: savedManifest.sha256, content_type: savedManifest.contentType, byte_length: savedManifest.bytes.byteLength, expires_at: evidenceExpiresAt };
    await this.ledger.saveEvidence({ runId: run.id, manifestId: savedManifest.id, manifestSha256: savedManifest.sha256, schemaVersion: "sophia.voice-lab.evidence.v1", revisionSeq: eventPage.latest, artifactRefs: [manifestRef, ...refs], createdAt: input.createdAt });
  }

  async #allEvents(runId: string): Promise<Awaited<ReturnType<VoiceLabLedger["listEvents"]>>> {
    const events: import("./domain.js").LabEvent[] = [];
    let cursor = 0;
    let latest = 0;
    do {
      const page = await this.ledger.listEvents(runId, cursor, 500);
      latest = page.latest;
      for (const event of page.events) {
        const expected = cursor + 1;
        if (event.seq !== expected) throw new VoiceLabError(labError("EVIDENCE_EVENT_GAP", "Durable event ledger contains a sequence gap; evidence cannot be certified.", "evidence", false, { expected_seq: expected, observed_seq: event.seq }));
        events.push(event);
        cursor = event.seq;
      }
      if (page.events.length === 0 && cursor < latest) throw new VoiceLabError(labError("EVIDENCE_EVENT_TRUNCATION", "Durable event scan stopped before the advertised latest cursor.", "evidence", false, { cursor, latest }));
    } while (cursor < latest);
    return { events, after: 0, latest };
  }

  async #persistEventChunks(run: RunRecord, events: import("./domain.js").LabEvent[], expiresAt: string, purpose: string) {
    const refs: Array<{ kind: string; resource_id: string; sha256: string; content_type: string; byte_length: number; expires_at: string }> = [];
    const chunks: Array<{ first_seq: number; last_seq: number; count: number; sha256: string; resource_id: string }> = [];
    let chain = "0".repeat(64);
    for (let offset = 0; offset < events.length; offset += 250) {
      const slice = events.slice(offset, offset + 250).map((event) => ({ seq: event.seq, kind: event.kind, source: event.source, observed_at: event.at.toISOString(), payload: event.payload }));
      assertNoSecret(slice);
      for (const event of slice) chain = sha256(`${chain}:${sha256(JSON.stringify(event))}`);
      const compressed = await gzipAsync(Buffer.from(JSON.stringify({ schema_version: "sophia.voice-lab.events.v1", run_id: run.id, events: slice }), "utf8"), { level: 9 });
      if (compressed.byteLength > 2_000_000) throw new VoiceLabError(labError("EVIDENCE_EVENT_CHUNK_TOO_LARGE", "Compressed event evidence chunk exceeded its durable row cap.", "evidence"));
      const digest = sha256(compressed);
      const id = deterministicUuid(run.id, `${purpose}-events-${offset / 250}`);
      const saved = await this.ledger.saveArtifact({ id, runId: run.id, kind: "capture_json", contentType: "application/gzip", sha256: digest, bytes: compressed, createdAt: new Date() });
      const resourceId = `voice-lab://artifact/${saved.id}`;
      refs.push({ kind: "event_chunk", resource_id: resourceId, sha256: saved.sha256, content_type: saved.contentType, byte_length: saved.bytes.byteLength, expires_at: expiresAt });
      chunks.push({ first_seq: slice[0]!.seq, last_seq: slice.at(-1)!.seq, count: slice.length, sha256: saved.sha256, resource_id: resourceId });
    }
    return { refs, index: { schema_version: "sophia.voice-lab.events.v1", first_seq: events[0]?.seq ?? null, last_seq: events.at(-1)?.seq ?? null, count: events.length, final_hash_chain: chain, chunks } };
  }

  async #resolveD02WorkerShutdownArm(runId: string, requireOwnedContext = true): Promise<D02WorkerShutdownArm | null> {
    this.#d02PreDispatchPauses.delete(runId);
    const active = this.#activeLeases.get(runId);
    if (!active) return null;
    const [run, currentLease, eventPage] = await Promise.all([
      this.ledger.getRun(runId),
      this.ledger.getBrowserLease(runId),
      this.#allEvents(runId),
    ]);
    if (!run || run.scenarioId !== "V-D02" || TERMINAL_RUN_STATES.has(run.state) || run.providerSessionId === null || run.providerEpoch === null
      || !currentLease || currentLease.workerId !== this.workerId || currentLease.leaseEpoch !== active.epoch
      || (requireOwnedContext && (currentLease.expiresAt <= new Date() || !this.driver.hasSession(runId)))) return null;

    const workerHash = sha256(this.workerId);
    const runHash = sha256(run.id);
    const cleanupHash = sha256(run.cleanupObligationId);
    const providerSessionHash = sha256(run.providerSessionId);
    const expectedContext = deriveD02BrowserContextBinding(run, this.workerId, active.epoch);
    const bindingEvents = eventPage.events.filter((event) => event.kind === "harness.browser_context_bound" && event.source === "canonical");
    const runtimeEvents = eventPage.events.filter((event) => event.kind === "harness.browser_runtime_acquired" && event.source === "canonical");
    const bindingEvent = bindingEvents[0];
    const runtimeEvent = runtimeEvents[0];
    const exactCurrentBinding = bindingEvents.length === 1 && bindingEvent !== undefined && hasExactKeys(bindingEvent.payload, [
      "schema", "test_run_id_sha256", "cleanup_obligation_id_sha256", "voice_lab_run_id_sha256", "browser_worker_id_sha256",
      "browser_lease_epoch", "browser_context_id_sha256", "context_allocation", "driver_attested", "raw_run_worker_and_context_identifiers_excluded",
    ]) && bindingEvent.payload.schema === "sophia_voice_lab_browser_context_binding_v1"
      && bindingEvent.payload.test_run_id_sha256 === sha256(run.testRunId) && bindingEvent.payload.cleanup_obligation_id_sha256 === cleanupHash
      && bindingEvent.payload.voice_lab_run_id_sha256 === runHash && bindingEvent.payload.browser_worker_id_sha256 === workerHash
      && bindingEvent.payload.browser_lease_epoch === active.epoch && bindingEvent.payload.browser_context_id_sha256 === expectedContext.browser_context_id_sha256
      && bindingEvent.payload.context_allocation === "deterministic_run_worker_lease_v1" && bindingEvent.payload.driver_attested === true
      && bindingEvent.payload.raw_run_worker_and_context_identifiers_excluded === true;
    const exactCurrentRuntime = runtimeEvents.length === 1 && runtimeEvent !== undefined && hasExactKeys(runtimeEvent.payload, [
      "worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256", "operation_id", "engine", "version", "service_version",
      "acquired_at", "raw_worker_identifier_excluded",
    ]) && runtimeEvent.payload.worker_id_sha256 === workerHash && runtimeEvent.payload.browser_lease_epoch === active.epoch
      && runtimeEvent.payload.browser_context_id_sha256 === expectedContext.browser_context_id_sha256
      && typeof runtimeEvent.payload.operation_id === "string" && typeof runtimeEvent.payload.engine === "string" && runtimeEvent.payload.engine.length > 0
      && typeof runtimeEvent.payload.version === "string" && runtimeEvent.payload.version.length > 0
      && runtimeEvent.payload.service_version === this.config.serviceVersion && isCanonicalTimestamp(runtimeEvent.payload.acquired_at)
      && runtimeEvent.payload.raw_worker_identifier_excluded === true && bindingEvent !== undefined && bindingEvent.seq < runtimeEvent.seq;
    const currentIntents = eventPage.events.filter((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending" && event.source === "canonical"
      && event.payload.voice_lab_run_id_sha256 === runHash && event.payload.browser_worker_id_sha256 === workerHash && event.payload.browser_lease_epoch === active.epoch);
    if (currentIntents.length > 1) throw d02WorkerShutdownConflict("The current browser lease has multiple D02 local freeze intents.");
    const intentEvent = currentIntents[0];
    const intent = intentEvent?.payload;
    const intentEpochs = Array.isArray(intent?.frozen_provider_connection_epochs) ? intent.frozen_provider_connection_epochs : [];
    const exactIntent = intentEvent !== undefined && intent !== undefined && hasExactKeys(intent, [
      "schema", "termination_request_id_sha256", "command_evidence_sha256", "voice_lab_run_id_sha256", "cleanup_obligation_id_sha256",
      "provider_session_id_sha256", "provider_admission_id_sha256", "provider_connection_epoch", "frozen_provider_connection_epochs",
      "browser_worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256", "render_action_request_sha256", "requested_at",
      "raw_run_operation_provider_and_browser_identifiers_excluded",
    ]) && intent.schema === "sophia_voice_lab_d02_local_browser_worker_freeze_intent_v1"
      && isSha256(intent.termination_request_id_sha256) && isSha256(intent.command_evidence_sha256)
      && intent.voice_lab_run_id_sha256 === runHash && intent.cleanup_obligation_id_sha256 === cleanupHash
      && intent.provider_session_id_sha256 === providerSessionHash && isSha256(intent.provider_admission_id_sha256)
      && intent.provider_connection_epoch === run.providerEpoch && intentEpochs.length > 0
      && intentEpochs.every((epoch, index) => Number.isSafeInteger(epoch) && Number(epoch) > 0 && (index === 0 || Number(intentEpochs[index - 1]) < Number(epoch)))
      && intentEpochs.includes(run.providerEpoch) && intent.browser_worker_id_sha256 === workerHash && intent.browser_lease_epoch === active.epoch
      && intent.browser_context_id_sha256 === expectedContext.browser_context_id_sha256 && isSha256(intent.render_action_request_sha256)
      && isCanonicalTimestamp(intent.requested_at) && intentEvent.at.toISOString() === intent.requested_at
      && intent.raw_run_operation_provider_and_browser_identifiers_excluded === true
      && exactCurrentBinding && exactCurrentRuntime && runtimeEvent !== undefined && runtimeEvent.seq < intentEvent.seq
      && new Date(String(runtimeEvent.payload.acquired_at)) <= intentEvent.at;
    if (intentEvent && !exactIntent) throw d02WorkerShutdownConflict("The current browser lease has a malformed or cross-bound D02 local freeze intent.");
    if (exactIntent) this.#d02PreDispatchPauses.add(runId);
    const commands = eventPage.events.filter((event) => {
      if (event.kind !== "external.attestation.d02_browser_worker_termination_command" || event.source !== "canonical" || event.payload.binding_validated !== true) return false;
      const evidence = event.payload.evidence as Record<string, unknown> | undefined;
      return evidence?.run_id_sha256 === runHash && evidence.browser_worker_id_sha256 === workerHash && evidence.browser_lease_epoch === active.epoch;
    });
    const currentFreezes = eventPage.events.filter((event) => event.kind === "product.d02_gateway_browser_worker_termination_frozen" && event.source === "canonical"
      && event.payload.voice_lab_run_id_sha256 === runHash && event.payload.browser_worker_id_sha256 === workerHash && event.payload.browser_lease_epoch === active.epoch);
    if (commands.length === 0) {
      // The local intent is committed before the cross-store Gateway call.
      // It pauses provider/browser mutation immediately, but cannot authorize
      // shutdown until the Gateway freeze, command, and dispatch all exist.
      if (exactIntent) return null;
      if (currentFreezes.length > 0) throw d02WorkerShutdownConflict("The current browser lease has a Gateway freeze without its local intent and canonical source command.");
      return null;
    }
    if (!exactIntent || !intentEvent || !intent) throw d02WorkerShutdownConflict("The canonical D02 termination command did not have one exact prior local freeze intent.");
    if (commands.length !== 1) throw d02WorkerShutdownConflict("The current browser lease has multiple canonical D02 termination commands.");
    const commandEvent = commands[0]!;
    const command = exactSourceValidatedD02WorkerCommand(commandEvent, run, this.config);
    if (!command) throw d02WorkerShutdownConflict("The canonical D02 termination command lost its source-validation or immutable content binding.");
    const terminationRequestIdSha256 = sha256(String(command.termination_request_id));
    const freezes = currentFreezes.filter((event) => event.payload.termination_request_id_sha256 === terminationRequestIdSha256);
    if (freezes.length !== 1) throw d02WorkerShutdownConflict("The canonical D02 termination command did not have one exact Gateway freeze.");
    const freezeEvent = freezes[0]!;
    const freeze = freezeEvent.payload;
    const frozenEpochs = Array.isArray(command.frozen_provider_connection_epochs) ? command.frozen_provider_connection_epochs : [];
    const requestedAt = typeof command.requested_at === "string" ? new Date(command.requested_at) : null;
    const exactFreeze = hasExactKeys(freeze, [
      "schema", "termination_request_id_sha256", "freeze_request_sha256", "voice_lab_run_id_sha256", "cleanup_obligation_id_sha256",
      "provider_session_id_sha256", "provider_admission_id_sha256", "provider_connection_epoch", "frozen_provider_connection_epochs",
      "browser_worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256", "render_action_request_sha256", "gateway_frozen",
      "raw_product_identifiers_excluded",
    ]) && freeze.schema === "sophia_voice_lab_d02_gateway_freeze_event_v1"
      && freeze.termination_request_id_sha256 === terminationRequestIdSha256 && isSha256(freeze.freeze_request_sha256)
      && freeze.voice_lab_run_id_sha256 === runHash && freeze.cleanup_obligation_id_sha256 === cleanupHash
      && freeze.provider_session_id_sha256 === providerSessionHash && freeze.provider_admission_id_sha256 === command.provider_admission_id_sha256
      && freeze.provider_connection_epoch === run.providerEpoch && canonicalRequestHash(freeze.frozen_provider_connection_epochs) === canonicalRequestHash(frozenEpochs)
      && freeze.browser_worker_id_sha256 === workerHash && freeze.browser_lease_epoch === active.epoch
      && freeze.browser_context_id_sha256 === expectedContext.browser_context_id_sha256
      && freeze.render_action_request_sha256 === command.render_action_request_sha256
      && freeze.gateway_frozen === true && freeze.raw_product_identifiers_excluded === true;
    const exactBinding = exactCurrentBinding && bindingEvent !== undefined && bindingEvent.seq < intentEvent.seq;
    const exactRuntime = exactCurrentRuntime && runtimeEvent !== undefined && runtimeEvent.seq < intentEvent.seq;
    const exactCommand = command.run_id_sha256 === runHash && command.cleanup_obligation_id_sha256 === cleanupHash
      && command.provider_session_id_sha256 === providerSessionHash && command.provider_connection_epoch === run.providerEpoch
      && Array.isArray(frozenEpochs) && frozenEpochs.length > 0 && frozenEpochs.every((epoch, index) => Number.isSafeInteger(epoch) && Number(epoch) > 0 && (index === 0 || Number(frozenEpochs[index - 1]) < Number(epoch)))
      && frozenEpochs.includes(run.providerEpoch) && command.browser_worker_id_sha256 === workerHash && command.browser_lease_epoch === active.epoch
      && command.browser_context_id_sha256 === expectedContext.browser_context_id_sha256
      && command.before_worker_owner_instance_id_sha256 === workerHash && command.before_worker_owner_membership_count === 1
      && command.target_service === "sophia-voice-lab-worker" && command.termination_mode === "render_service_restart_one_shot"
      && command.worker_mutation_authorized === true && command.product_mutation_authorized === false && command.one_shot === true;
    const exactIntentCommand = intent.termination_request_id_sha256 === terminationRequestIdSha256
      && intent.command_evidence_sha256 === canonicalRequestHash(command)
      && intent.provider_admission_id_sha256 === command.provider_admission_id_sha256
      && canonicalRequestHash(intent.frozen_provider_connection_epochs) === canonicalRequestHash(frozenEpochs)
      && intent.render_action_request_sha256 === command.render_action_request_sha256 && intent.requested_at === command.requested_at;
    const exactOrder = intentEvent.seq < freezeEvent.seq && freezeEvent.seq < commandEvent.seq && requestedAt !== null && Number.isFinite(requestedAt.getTime())
      && requestedAt.toISOString() === command.requested_at && requestedAt <= freezeEvent.at;
    if (!exactFreeze || !exactBinding || !exactRuntime || !exactIntentCommand || !exactCommand || !exactOrder) {
      throw d02WorkerShutdownConflict("The D02 termination command, Gateway freeze, browser owner, lease, context, provider epochs, or durable ordering drifted.");
    }
    const dispatchClaims = eventPage.events.filter((event) => event.kind === "product.d02_render_worker_dispatch_claimed" && event.source === "canonical"
      && event.payload.termination_request_id_sha256 === terminationRequestIdSha256);
    if (dispatchClaims.length === 0) {
      this.#d02PreDispatchPauses.add(runId);
      return null;
    }
    if (dispatchClaims.length !== 1) throw d02WorkerShutdownConflict("The D02 termination command has multiple durable Render dispatch claims.");
    const dispatchEvent = dispatchClaims[0]!;
    const dispatch = dispatchEvent.payload;
    const dispatchCore = { ...dispatch };
    delete dispatchCore.dispatch_claim_sha256;
    const exactDispatch = hasExactKeys(dispatch, [
      "schema", "termination_request_id_sha256", "command_attestation_id_sha256", "command_content_sha256", "command_event_seq",
      "worker_service_id_sha256", "action_request_sha256", "dispatch_attempt_id_sha256", "requested_at",
      "raw_action_and_attempt_identifiers_excluded", "dispatch_claim_sha256",
    ]) && dispatch.schema === "sophia_voice_lab_d02_render_worker_dispatch_claim_v1"
      && dispatch.termination_request_id_sha256 === terminationRequestIdSha256
      && dispatch.command_attestation_id_sha256 === sha256(String(commandEvent.payload.attestation_id))
      && dispatch.command_content_sha256 === commandEvent.payload.content_sha256
      && dispatch.command_event_seq === commandEvent.seq
      && dispatch.worker_service_id_sha256 === command.worker_service_id_sha256
      && dispatch.action_request_sha256 === command.render_action_request_sha256
      && isSha256(dispatch.dispatch_attempt_id_sha256) && isCanonicalTimestamp(dispatch.requested_at)
      && dispatch.raw_action_and_attempt_identifiers_excluded === true
      && isSha256(dispatch.dispatch_claim_sha256) && dispatch.dispatch_claim_sha256 === canonicalRequestHash(dispatchCore)
      && commandEvent.seq < dispatchEvent.seq && dispatchEvent.at.toISOString() === dispatch.requested_at
      && commandEvent.at <= dispatchEvent.at;
    if (!exactDispatch) throw d02WorkerShutdownConflict("The durable Render dispatch claim did not bind the exact canonical command, worker service, and one-shot action.");
    return {
      runId,
      terminationRequestIdSha256,
      cleanupObligationIdSha256: cleanupHash,
      lostWorkerIdSha256: workerHash,
      lostBrowserLeaseEpoch: active.epoch,
      browserContextIdSha256: expectedContext.browser_context_id_sha256,
      providerSessionIdSha256: providerSessionHash,
      providerAdmissionIdSha256: String(command.provider_admission_id_sha256),
      providerConnectionEpoch: run.providerEpoch,
      frozenProviderConnectionEpochs: frozenEpochs.map(Number),
      renderActionRequestSha256: String(command.render_action_request_sha256),
      gatewayFreezeRequestSha256: String(freeze.freeze_request_sha256),
      gatewayFreezeEventSeq: freezeEvent.seq,
      commandEventSeq: commandEvent.seq,
      renderDispatchClaimSha256: String(dispatch.dispatch_claim_sha256),
      renderDispatchClaimEventSeq: dispatchEvent.seq,
    };
  }

  async #awaitD02PreDispatchShutdownArm(runId: string, timeoutMs: number): Promise<D02WorkerShutdownArm> {
    const initialLease = this.#activeLeases.get(runId);
    if (!initialLease || !this.#d02PreDispatchPauses.has(runId)) {
      throw d02WorkerShutdownConflict("The D02 pre-dispatch shutdown wait lost its exact local freeze intent or browser lease.");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const activeLease = this.#activeLeases.get(runId);
      if (!activeLease || activeLease.epoch !== initialLease.epoch) {
        throw d02WorkerShutdownConflict("The D02 pre-dispatch shutdown wait lost its exact browser lease epoch.");
      }
      const heartbeatBudgetMs = deadline - Date.now();
      if (heartbeatBudgetMs <= 0) break;
      const owned = await withTimeout(this.ledger.heartbeatBrowserLease(
        runId,
        this.workerId,
        initialLease.epoch,
        this.config.browserLeaseSeconds,
      ), heartbeatBudgetMs);
      if (!owned) {
        throw d02WorkerShutdownConflict("The D02 pre-dispatch shutdown wait could not CAS-renew its exact browser lease.");
      }
      const resolutionBudgetMs = deadline - Date.now();
      if (resolutionBudgetMs <= 0) break;
      const arm = await withTimeout(this.#resolveD02WorkerShutdownArm(runId), resolutionBudgetMs);
      if (arm) return arm;
      if (!this.#d02PreDispatchPauses.has(runId)) {
        throw d02WorkerShutdownConflict("The D02 pre-dispatch shutdown wait lost its immutable local freeze-intent binding.");
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) await delay(Math.min(D02_PRE_DISPATCH_SHUTDOWN_POLL_MS, remainingMs));
    }
    throw d02WorkerShutdownConflict("The D02 pre-dispatch shutdown source chain did not converge before the bounded grace deadline.");
  }

  #quiesceD02Worker(runId: string, arm: D02WorkerShutdownArm): Promise<void> {
    const existing = this.#d02ShutdownsInFlight.get(runId);
    if (existing) return existing;
    const pending = this.#performD02WorkerQuiescence(runId, arm).finally(() => this.#d02ShutdownsInFlight.delete(runId));
    this.#d02ShutdownsInFlight.set(runId, pending);
    return pending;
  }

  async #performD02WorkerQuiescence(runId: string, armed: D02WorkerShutdownArm): Promise<void> {
    const current = await this.#resolveD02WorkerShutdownArm(runId, true);
    if (!current || canonicalRequestHash(current) !== canonicalRequestHash(armed)) throw d02WorkerShutdownConflict("The D02 worker shutdown arm changed before browser quiescence.");
    this.#d02ShutdownArms.set(runId, current);
    const error = labError("BROWSER_SESSION_LOST", "The source-validated D02 worker restart closed the owned browser context; live media state cannot be reconstructed.", "harness", false, {
      termination_request_id_sha256: current.terminationRequestIdSha256,
      source: "worker_graceful_d02_restart",
    });
    const cancelled = await this.ledger.cancelPendingRunOperations(runId, null, labError("RUN_TERMINATED", "Operation was cancelled because its D02 browser worker became terminal.", "harness", false, { terminal_reason: error.code }));
    for (const operation of cancelled) await this.ledger.appendEvent(runId, "operation.cancelled", "worker", { operation_id: operation.id, operation_type: operation.type, reason_code: operation.error?.code ?? "RUN_TERMINATED" }, `operation:${operation.id}:cancelled`);

    const ownedRun = await this.#freshRun(runId);
    const productCleanup = await this.driver.quiesceD02Provider(ownedRun, {
      browserContextBinding: {
        voice_lab_run_id_sha256: sha256(ownedRun.id),
        browser_worker_id_sha256: current.lostWorkerIdSha256,
        browser_lease_epoch: current.lostBrowserLeaseEpoch,
        browser_context_id_sha256: current.browserContextIdSha256,
      },
      providerSessionIdSha256: current.providerSessionIdSha256,
      frozenProviderConnectionEpochs: [...current.frozenProviderConnectionEpochs],
    });
    assertExactD02ProductCleanupAcknowledgement(current, productCleanup);
    // Context destruction is ordered strictly after the product-owned Gemini
    // connection has persisted and received the canonical 202 receipt echo.
    await this.driver.cancel(runId, error.code);
    if (this.driver.hasSession(runId)) throw d02WorkerShutdownConflict("The owned browser context remained live after synchronous D02 cancellation.");
    const observedAt = await this.#appendD02WorkerShutdownObservation(current, productCleanup);
    let run = await this.#freshRun(runId);
    if (TERMINAL_RUN_STATES.has(run.state)) {
      if (run.state !== "aborted_driver_restart" || run.terminalError?.code !== "BROWSER_SESSION_LOST") throw d02WorkerShutdownConflict("A different terminal outcome won the D02 shutdown transition.");
    } else {
      const verdicts = deriveFailureVerdicts(run, "aborted_driver_restart", []);
      run = await transitionRun(this.ledger, run, "aborted_driver_restart", { terminalError: error, verdicts, cleanupComplete: false });
      await this.ledger.appendEvent(run.id, "run.aborted_driver_restart", "worker", { error, shutdown_observed_at: observedAt.toISOString() }, `run:${run.id}:aborted_driver_restart`);
    }
    const released = await this.ledger.releaseBrowserLease(runId, this.workerId, current.lostBrowserLeaseEpoch);
    if (!released) throw d02WorkerShutdownConflict("The D02 worker could not CAS-release the exact browser lease after closing its context.");
    await this.ledger.appendEvent(runId, "cleanup.browser_lease_released", "worker", { worker_id_hash: current.lostWorkerIdSha256, lease_epoch: current.lostBrowserLeaseEpoch, cas_deleted: true }, `cleanup:${runId}:browser-lease`);
    this.#activeLeases.delete(runId);
    this.#d02PreDispatchPauses.delete(runId);
    const terminal = await this.#freshRun(runId);
    const recovered = await this.#recoverRun(terminal);
    await this.#persistEvents(runId, recovered.events);
    // Keep the run recovery-pending until a distinct replacement worker has
    // durably observed this old-worker fact. Otherwise the old process could
    // mark cleanup complete before Render has actually replaced it, leaving no
    // durable row discoverable by replacement startup.
    await this.#saveFailureEvidence(await this.#freshRun(runId), error, recovered.artifacts);
  }

  async #observeD02GracefulWorkerReplacement(run: RunRecord): Promise<"not_d02" | "awaiting_replacement" | "observed"> {
    if (run.scenarioId !== "V-D02" || run.state !== "aborted_driver_restart" || run.terminalError?.code !== "BROWSER_SESSION_LOST") return "not_d02";
    const [eventPage, currentLease] = await Promise.all([this.#allEvents(run.id), this.ledger.getBrowserLease(run.id)]);
    const shutdowns = eventPage.events.filter((event) => event.kind === "durability.browser_worker_shutdown_observed");
    if (shutdowns.length === 0) return "not_d02";
    if (shutdowns.length !== 1 || currentLease !== null || this.driver.hasSession(run.id)) throw d02WorkerShutdownConflict("A graceful D02 terminal run lost its unique shutdown observation or absent-lease boundary.");
    const shutdown = shutdowns[0]!;
    const proof = shutdown.payload;
    const proofKeys = [
      "schema", "termination_request_id_sha256", "voice_lab_run_id_sha256", "cleanup_obligation_id_sha256",
      "lost_browser_worker_id_sha256", "lost_browser_lease_epoch", "browser_context_id_sha256", "provider_session_id_sha256",
      "provider_admission_id_sha256", "provider_connection_epoch", "frozen_provider_connection_epochs", "render_action_request_sha256",
      "gateway_freeze_request_sha256", "gateway_freeze_event_seq", "command_event_seq", "render_dispatch_claim_sha256",
      "render_dispatch_claim_event_seq", "product_provider_cleanup_acknowledged", "product_provider_cleanup_settlement_sha256",
      "product_provider_close_receipt_count", "product_provider_activation_abort_receipt_count", "product_provider_cleanup_epoch_union_matches_freeze",
      "browser_context_closed", "source", "raw_run_worker_lease_context_and_product_identifiers_excluded",
      "observed_at",
    ] as const;
    const command = eventPage.events.find((event) => event.seq === proof.command_event_seq);
    const freeze = eventPage.events.find((event) => event.seq === proof.gateway_freeze_event_seq);
    const dispatch = eventPage.events.find((event) => event.seq === proof.render_dispatch_claim_event_seq);
    const commandEvidence = command ? exactSourceValidatedD02WorkerCommand(command, run, this.config) : null;
    const dispatchCore = dispatch ? { ...dispatch.payload } : null;
    if (dispatchCore) delete dispatchCore.dispatch_claim_sha256;
    const exactProof = shutdown.source === "worker" && hasExactKeys(proof, proofKeys)
      && proof.schema === "sophia_voice_lab_d02_browser_worker_shutdown_observation_v1"
      && proof.voice_lab_run_id_sha256 === sha256(run.id) && proof.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
      && isSha256(proof.termination_request_id_sha256) && isSha256(proof.lost_browser_worker_id_sha256)
      && Number.isSafeInteger(proof.lost_browser_lease_epoch) && Number(proof.lost_browser_lease_epoch) > 0
      && isSha256(proof.browser_context_id_sha256) && isSha256(proof.provider_session_id_sha256) && isSha256(proof.provider_admission_id_sha256)
      && Number.isSafeInteger(proof.provider_connection_epoch) && Number(proof.provider_connection_epoch) > 0
      && Array.isArray(proof.frozen_provider_connection_epochs) && proof.frozen_provider_connection_epochs.length > 0
      && isSha256(proof.render_action_request_sha256) && isSha256(proof.gateway_freeze_request_sha256)
      && isSha256(proof.render_dispatch_claim_sha256) && proof.product_provider_cleanup_acknowledged === true
      && isSha256(proof.product_provider_cleanup_settlement_sha256)
      && Number.isSafeInteger(proof.product_provider_close_receipt_count) && Number(proof.product_provider_close_receipt_count) >= 0
      && Number.isSafeInteger(proof.product_provider_activation_abort_receipt_count) && Number(proof.product_provider_activation_abort_receipt_count) >= 0
      && Number(proof.product_provider_close_receipt_count) + Number(proof.product_provider_activation_abort_receipt_count) === proof.frozen_provider_connection_epochs.length
      && proof.product_provider_cleanup_epoch_union_matches_freeze === true && proof.browser_context_closed === true
      && proof.source === "worker_graceful_d02_restart" && proof.raw_run_worker_lease_context_and_product_identifiers_excluded === true
      && isCanonicalTimestamp(proof.observed_at) && shutdown.at.toISOString() === proof.observed_at;
    const exactCommand = command?.kind === "external.attestation.d02_browser_worker_termination_command" && command.source === "canonical" && commandEvidence !== null
      && sha256(String(commandEvidence.termination_request_id)) === proof.termination_request_id_sha256
      && commandEvidence.cleanup_obligation_id_sha256 === proof.cleanup_obligation_id_sha256
      && commandEvidence.browser_worker_id_sha256 === proof.lost_browser_worker_id_sha256
      && commandEvidence.browser_lease_epoch === proof.lost_browser_lease_epoch
      && commandEvidence.browser_context_id_sha256 === proof.browser_context_id_sha256
      && commandEvidence.provider_session_id_sha256 === proof.provider_session_id_sha256
      && commandEvidence.provider_admission_id_sha256 === proof.provider_admission_id_sha256
      && commandEvidence.provider_connection_epoch === proof.provider_connection_epoch
      && canonicalRequestHash(commandEvidence.frozen_provider_connection_epochs) === canonicalRequestHash(proof.frozen_provider_connection_epochs)
      && commandEvidence.render_action_request_sha256 === proof.render_action_request_sha256;
    const exactFreeze = freeze?.kind === "product.d02_gateway_browser_worker_termination_frozen" && freeze.source === "canonical"
      && freeze.payload.termination_request_id_sha256 === proof.termination_request_id_sha256
      && freeze.payload.freeze_request_sha256 === proof.gateway_freeze_request_sha256
      && freeze.payload.browser_worker_id_sha256 === proof.lost_browser_worker_id_sha256
      && freeze.payload.browser_lease_epoch === proof.lost_browser_lease_epoch
      && freeze.payload.browser_context_id_sha256 === proof.browser_context_id_sha256
      && freeze.payload.render_action_request_sha256 === proof.render_action_request_sha256;
    const exactDispatch = dispatch?.kind === "product.d02_render_worker_dispatch_claimed" && dispatch.source === "canonical" && dispatchCore !== null
      && dispatch.payload.termination_request_id_sha256 === proof.termination_request_id_sha256
      && dispatch.payload.command_event_seq === command?.seq && dispatch.payload.command_content_sha256 === command?.payload.content_sha256
      && dispatch.payload.action_request_sha256 === proof.render_action_request_sha256
      && dispatch.payload.dispatch_claim_sha256 === proof.render_dispatch_claim_sha256
      && dispatch.payload.dispatch_claim_sha256 === canonicalRequestHash(dispatchCore);
    if (!exactProof || !exactCommand || !exactFreeze || !exactDispatch || !freeze || !command || !dispatch
      || !(freeze.seq < command.seq && command.seq < dispatch.seq && dispatch.seq < shutdown.seq)) {
      throw d02WorkerShutdownConflict("Replacement startup could not cross-join the old shutdown to the exact freeze, command, and Render dispatch claim.");
    }
    const replacementWorkerIdSha256 = sha256(this.workerId);
    if (replacementWorkerIdSha256 === proof.lost_browser_worker_id_sha256) return "awaiting_replacement";
    const observedAt = new Date();
    const lossPayload = {
      schema: "sophia_voice_lab_d02_browser_worker_loss_cross_join_v1",
      termination_request_id_sha256: proof.termination_request_id_sha256,
      lost_worker_id_sha256: proof.lost_browser_worker_id_sha256,
      replacement_worker_id_sha256: replacementWorkerIdSha256,
      lost_browser_lease_epoch: proof.lost_browser_lease_epoch,
      browser_context_id_sha256: proof.browser_context_id_sha256,
      old_worker_shutdown_event_seq: shutdown.seq,
      render_dispatch_claim_sha256: proof.render_dispatch_claim_sha256,
      render_dispatch_claim_event_seq: dispatch.seq,
      lease_expired_at: null,
      loss_observed_at: observedAt.toISOString(),
      loss_source: "worker_graceful_d02_restart_cross_join",
      raw_worker_identifiers_excluded: true,
    };
    let loss: import("./domain.js").LabEvent;
    try {
      loss = await this.ledger.appendEvent(run.id, "durability.browser_worker_loss_observed", "worker", lossPayload, `browser-worker-loss:${run.id}:${String(proof.lost_browser_lease_epoch)}`, observedAt);
    } catch (error) {
      const winner = await this.ledger.findLatestEvent(run.id, ["durability.browser_worker_loss_observed"]);
      if (!winner || winner.payload.termination_request_id_sha256 !== proof.termination_request_id_sha256
        || winner.payload.lost_worker_id_sha256 !== proof.lost_browser_worker_id_sha256
        || winner.payload.lost_browser_lease_epoch !== proof.lost_browser_lease_epoch
        || winner.payload.old_worker_shutdown_event_seq !== shutdown.seq
        || winner.payload.render_dispatch_claim_sha256 !== proof.render_dispatch_claim_sha256
        || winner.payload.replacement_worker_id_sha256 === proof.lost_browser_worker_id_sha256) throw error;
      loss = winner;
    }
    await this.ledger.appendEvent(run.id, "durability.browser_worker_replacement_observed", "worker", {
      schema: "sophia_voice_lab_d02_browser_worker_replacement_observation_v1",
      termination_request_id_sha256: proof.termination_request_id_sha256,
      lost_browser_worker_id_sha256: proof.lost_browser_worker_id_sha256,
      replacement_browser_worker_id_sha256: loss.payload.replacement_worker_id_sha256,
      lost_browser_lease_epoch: proof.lost_browser_lease_epoch,
      browser_context_id_sha256: proof.browser_context_id_sha256,
      old_worker_shutdown_event_seq: shutdown.seq,
      loss_event_seq: loss.seq,
      render_dispatch_claim_sha256: proof.render_dispatch_claim_sha256,
      source: "replacement_worker_startup_after_graceful_d02_restart",
      raw_worker_identifiers_excluded: true,
    }, `d02-worker-replacement:${String(proof.termination_request_id_sha256)}`, loss.at);
    return "observed";
  }

  async #appendD02WorkerShutdownObservation(arm: D02WorkerShutdownArm, productCleanup: D02ProductCleanupAcknowledgement): Promise<Date> {
    const events = (await this.#allEvents(arm.runId)).events.filter((event) => event.kind === "durability.browser_worker_shutdown_observed");
    const fixed = {
      schema: "sophia_voice_lab_d02_browser_worker_shutdown_observation_v1",
      termination_request_id_sha256: arm.terminationRequestIdSha256,
      voice_lab_run_id_sha256: sha256(arm.runId),
      cleanup_obligation_id_sha256: arm.cleanupObligationIdSha256,
      lost_browser_worker_id_sha256: arm.lostWorkerIdSha256,
      lost_browser_lease_epoch: arm.lostBrowserLeaseEpoch,
      browser_context_id_sha256: arm.browserContextIdSha256,
      provider_session_id_sha256: arm.providerSessionIdSha256,
      provider_admission_id_sha256: arm.providerAdmissionIdSha256,
      provider_connection_epoch: arm.providerConnectionEpoch,
      frozen_provider_connection_epochs: arm.frozenProviderConnectionEpochs,
      render_action_request_sha256: arm.renderActionRequestSha256,
      gateway_freeze_request_sha256: arm.gatewayFreezeRequestSha256,
      gateway_freeze_event_seq: arm.gatewayFreezeEventSeq,
      command_event_seq: arm.commandEventSeq,
      render_dispatch_claim_sha256: arm.renderDispatchClaimSha256,
      render_dispatch_claim_event_seq: arm.renderDispatchClaimEventSeq,
      product_provider_cleanup_acknowledged: true,
      product_provider_cleanup_settlement_sha256: productCleanup.settlement_acknowledgement_sha256,
      product_provider_close_receipt_count: productCleanup.browser_provider_close_receipt_count,
      product_provider_activation_abort_receipt_count: productCleanup.browser_provider_activation_abort_receipt_count,
      product_provider_cleanup_epoch_union_matches_freeze: true,
      browser_context_closed: true,
      source: "worker_graceful_d02_restart",
      raw_run_worker_lease_context_and_product_identifiers_excluded: true,
    } as const;
    if (events.length > 1) throw d02WorkerShutdownConflict("Multiple D02 worker shutdown observations exist for one governed run.");
    if (events.length === 1) {
      const existing = events[0]!;
      const observedAt = typeof existing.payload.observed_at === "string" ? new Date(existing.payload.observed_at) : null;
      const existingFixed = { ...existing.payload };
      delete existingFixed.observed_at;
      if (existing.source !== "worker" || existing.seq <= arm.renderDispatchClaimEventSeq || canonicalRequestHash(existingFixed) !== canonicalRequestHash(fixed) || !observedAt || Number.isNaN(observedAt.getTime()) || observedAt.toISOString() !== existing.payload.observed_at) {
        throw d02WorkerShutdownConflict("The replayed D02 worker shutdown observation drifted from its exact source binding.");
      }
      return observedAt;
    }
    const observedAt = new Date();
    const appended = await this.ledger.appendEvent(arm.runId, "durability.browser_worker_shutdown_observed", "worker", { ...fixed, observed_at: observedAt.toISOString() }, `d02-worker-shutdown:${arm.terminationRequestIdSha256}`, observedAt);
    if (appended.seq <= arm.renderDispatchClaimEventSeq) throw d02WorkerShutdownConflict("The D02 worker shutdown observation did not follow the durable Render dispatch claim.");
    return observedAt;
  }

  async #markDriverRestart(runId: string, lostLease?: import("./ledger.js").BrowserLease): Promise<void> {
    const run = await this.ledger.getRun(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return;
    if (lostLease) await this.ledger.appendEvent(run.id, "durability.browser_worker_loss_observed", "canonical", {
      lost_worker_id_sha256: sha256(lostLease.workerId),
      replacement_worker_id_sha256: sha256(this.workerId),
      lost_browser_lease_epoch: lostLease.leaseEpoch,
      lease_expired_at: lostLease.expiresAt.toISOString(),
      loss_observed_at: new Date().toISOString(),
      raw_worker_identifiers_excluded: true,
    }, `browser-worker-loss:${run.id}:${lostLease.leaseEpoch}`);
    const error = labError("BROWSER_SESSION_LOST", "Browser worker lease expired; live media state cannot be reconstructed honestly.", "harness");
    await this.#terminalizeFailure(run.id, error, "aborted_driver_restart");
  }

  async #releaseBrowserLeaseProof(runId: string): Promise<boolean> {
    const active = this.#activeLeases.get(runId);
    let current = await this.ledger.getBrowserLease(runId);
    const epoch = active?.epoch ?? (current?.workerId === this.workerId ? current.leaseEpoch : null);
    if (epoch !== null) {
      const released = await this.ledger.releaseBrowserLease(runId, this.workerId, epoch);
      if (released) await this.ledger.appendEvent(runId, "cleanup.browser_lease_released", "worker", { worker_id_hash: sha256(this.workerId), lease_epoch: epoch, cas_deleted: true }, `cleanup:${runId}:browser-lease`);
    }
    this.#activeLeases.delete(runId);
    current = await this.ledger.getBrowserLease(runId);
    if (current === null) {
      const prior = await this.ledger.findLatestEvent(runId, ["cleanup.browser_lease_released", "cleanup.browser_lease_absent"]);
      if (!prior) await this.ledger.appendEvent(runId, "cleanup.browser_lease_absent", "worker", { authoritative_ledger_read: true }, `cleanup:${runId}:browser-lease-absent`);
      return true;
    }
    const ownerHash = sha256(current.workerId);
    await this.ledger.appendEvent(runId, "cleanup.browser_lease_unconfirmed", "worker", { worker_id_hash: ownerHash, lease_epoch: current.leaseEpoch, expires_at: current.expiresAt.toISOString() }, `cleanup:${runId}:browser-lease-unconfirmed:${ownerHash}:${current.leaseEpoch}:${current.expiresAt.getTime()}`);
    return false;
  }

  async #freshRun(runId: string): Promise<RunRecord> {
    const run = await this.ledger.getRun(runId);
    if (!run) throw new VoiceLabError(labError("RUN_NOT_FOUND", "Run was not found.", "validation"));
    return run;
  }

  #killSwitchEngaged(): boolean {
    const live = process.env.SOPHIA_VOICE_LAB_KILL_SWITCH?.trim().toLowerCase();
    return this.config.killSwitch || live === "true" || live === "1";
  }
}

function errorDetail(error: unknown): LabError {
  if (error instanceof VoiceLabError) return error.detail;
  return labError("UNEXPECTED_WORKER_ERROR", "Voice Lab worker encountered an unexpected internal error.", "internal", false, { cause: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
}

/** Preserve only a fixed internal route stage when the global operation
 * deadline closes Playwright before its own typed error can settle. */
export function augmentOperationTimeoutWithInterruptedDriverError(reason: unknown, interrupted: unknown): unknown {
  if (!(reason instanceof VoiceLabError) || reason.detail.code !== "OPERATION_TIMEOUT"
    || !(interrupted instanceof VoiceLabError) || interrupted.detail.code !== "ORDINARY_UI_ROUTE_FAILED") return reason;
  const rawStage = interrupted.detail.details?.stage;
  const stage = typeof rawStage === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(rawStage) ? rawStage : "unavailable";
  return new VoiceLabError(labError(
    reason.detail.code,
    reason.detail.message,
    reason.detail.category,
    reason.detail.retryable,
    {
      ...(reason.detail.details ?? {}),
      interrupted_driver_error: {
        code: interrupted.detail.code,
        stage,
      },
    },
  ));
}
function d02WorkerShutdownConflict(message: string): VoiceLabError {
  return new VoiceLabError(labError("D02_WORKER_SHUTDOWN_ARM_INVALID", message, "evidence", false));
}
function assertExactD02ProductCleanupAcknowledgement(arm: D02WorkerShutdownArm, acknowledgement: D02ProductCleanupAcknowledgement): void {
  const keys = [
    "schema", "voice_lab_run_id_sha256", "browser_worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256",
    "provider_session_id_sha256", "frozen_provider_connection_epochs", "browser_provider_close_receipt_count",
    "browser_provider_activation_abort_receipt_count", "settlement_acknowledgement_sha256", "raw_provider_and_receipt_identifiers_excluded",
  ] as const;
  const closeCount = Number(acknowledgement.browser_provider_close_receipt_count);
  const abortCount = Number(acknowledgement.browser_provider_activation_abort_receipt_count);
  if (!hasExactKeys(acknowledgement as unknown as Record<string, unknown>, keys)
    || acknowledgement.schema !== "sophia_voice_lab_d02_product_provider_cleanup_acknowledgement_v1"
    || acknowledgement.voice_lab_run_id_sha256 !== sha256(arm.runId)
    || acknowledgement.browser_worker_id_sha256 !== arm.lostWorkerIdSha256
    || acknowledgement.browser_lease_epoch !== arm.lostBrowserLeaseEpoch
    || acknowledgement.browser_context_id_sha256 !== arm.browserContextIdSha256
    || acknowledgement.provider_session_id_sha256 !== arm.providerSessionIdSha256
    || canonicalRequestHash(acknowledgement.frozen_provider_connection_epochs) !== canonicalRequestHash(arm.frozenProviderConnectionEpochs)
    || !Number.isSafeInteger(closeCount) || closeCount < 0 || !Number.isSafeInteger(abortCount) || abortCount < 0
    || closeCount + abortCount !== arm.frozenProviderConnectionEpochs.length
    || !isSha256(acknowledgement.settlement_acknowledgement_sha256)
    || acknowledgement.raw_provider_and_receipt_identifiers_excluded !== true) {
    throw d02WorkerShutdownConflict("The product provider-cleanup acknowledgement drifted from the exact frozen browser owner and epoch union.");
  }
}
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isCanonicalUuidV4(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value); }
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function exactSourceValidatedD02WorkerCommand(event: import("./domain.js").LabEvent, run: RunRecord, config: VoiceLabConfig): Record<string, unknown> | null {
  const payload = event.payload;
  const evidence = payload.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const command = evidence as Record<string, unknown>;
  const commandKeys = [
    "kind", "authority", "termination_request_id", "run_id_sha256", "cleanup_obligation_id_sha256", "worker_service_id_sha256",
    "provider_session_id_sha256", "provider_admission_id_sha256", "provider_connection_epoch", "frozen_provider_connection_epochs",
    "browser_worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256", "before_worker_deploy_id_sha256",
    "before_worker_instance_set_sha256", "before_worker_owner_instance_id_sha256", "before_worker_owner_membership_count",
    "render_action_request_sha256", "requested_at", "target_service", "termination_mode", "worker_mutation_authorized",
    "product_mutation_authorized", "one_shot",
  ] as const;
  const shaKeys = [
    "run_id_sha256", "cleanup_obligation_id_sha256", "worker_service_id_sha256", "provider_session_id_sha256",
    "provider_admission_id_sha256", "browser_worker_id_sha256", "browser_context_id_sha256", "before_worker_deploy_id_sha256",
    "before_worker_instance_set_sha256", "before_worker_owner_instance_id_sha256", "render_action_request_sha256",
  ] as const;
  const authority = config.attestationAuthorities.deployment_control;
  const payloadCore = { ...payload };
  delete payloadCore.content_sha256;
  return hasExactKeys(command, commandKeys)
    && command.kind === "d02_browser_worker_termination_command" && command.authority === "deployment_control"
    && isCanonicalUuidV4(command.termination_request_id) && isCanonicalTimestamp(command.requested_at)
    && shaKeys.every((key) => isSha256(command[key]))
    && Number.isSafeInteger(command.provider_connection_epoch) && Number(command.provider_connection_epoch) > 0
    && Number.isSafeInteger(command.browser_lease_epoch) && Number(command.browser_lease_epoch) > 0
    && payload.binding_validated === true && payload.raw_identifiers_excluded === true
    && payload.run_id === run.id && payload.test_run_id_sha256 === sha256(run.testRunId)
    && payload.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
    && payload.scenario_id === run.scenarioId && payload.scenario_version === run.scenarioVersion && payload.environment === run.environment
    && canonicalRequestHash(payload.expected_deployment) === canonicalRequestHash(run.target.expectedDeployment)
    && payload.issuer === authority.issuer && payload.authority_key_id === authority.keyId
    && payload.authority_subject_sha256 === sha256(authority.subject)
    && isCanonicalUuidV4(payload.attestation_id) && payload.jti === payload.attestation_id
    && isSha256(payload.nonce_sha256) && isSha256(payload.signature_material_sha256)
    && isSha256(payload.request_argument_sha256) && isSha256(payload.request_id_sha256)
    && typeof payload.signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(payload.signature)
    && isCanonicalTimestamp(payload.issued_at) && isCanonicalTimestamp(payload.expires_at)
    && event.at.toISOString() === payload.issued_at
    && isSha256(payload.content_sha256) && payload.content_sha256 === canonicalRequestHash(payloadCore)
    ? command : null;
}
function throwIfCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new VoiceLabError(labError("OPERATION_CANCELLED", "Operation was cancelled before page mutation.", "harness", true));
}
function safeError(error: unknown): Record<string, unknown> { return redact(error instanceof VoiceLabError ? { ...error.detail } : { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) }); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function boundedBrowserReadiness(driver: VoiceBrowserDriver, timeoutMs: number): ReturnType<VoiceBrowserDriver["readiness"]> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: Awaited<ReturnType<VoiceBrowserDriver["readiness"]>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle({ ok: false, detail: "chromium-readiness-timeout" }), timeoutMs);
    Promise.resolve().then(() => driver.readiness()).then(
      settle,
      (error) => settle({ ok: false, detail: `chromium-readiness-unavailable:${error instanceof Error ? error.name : "Error"}` }),
    );
  });
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new VoiceLabError(labError("OPERATION_TIMEOUT", "Operation exceeded its bounded execution time.", "harness", true))), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function isCanonicalFinalizationReceipt(run: RunRecord, event: import("./domain.js").LabEvent): boolean {
  if (event.source !== "canonical" || event.kind !== "session.finalized") return false;
  const receipt = event.payload.receipt as Record<string, unknown> | undefined;
  const evidence = receipt?.evidence_receipt as Record<string, unknown> | undefined;
  const transcript = receipt?.canonical_transcript as Record<string, unknown> | undefined;
  return hasExactFinalizationEnvelope(run, receipt)
    && isStrictCanonicalTranscript(run, transcript)
    && typeof evidence?.storage === "string"
    && evidence.storage.length > 0
    && (run.environment !== "production" || evidence.storage !== "local_ephemeral")
    && typeof evidence.object_path === "string"
    && evidence.object_path.length > 0
    && evidence.object_path.length <= 512
    && typeof evidence.sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(evidence.sha256);
}

function isStrictCanonicalTranscript(run: RunRecord, transcript: Record<string, unknown> | undefined): boolean {
  if (!transcript || transcript.schema !== "sophia_voice_lab_canonical_transcript_v1" || transcript.source !== "sophia_session_messages" || transcript.synthetic !== true) return false;
  if (transcript.principal_id !== run.principalId || transcript.test_run_id !== run.testRunId || transcript.scenario_id !== run.scenarioId || transcript.scenario_version !== run.scenarioVersion || transcript.environment !== run.environment) return false;
  if (!sameDeployment(transcript.expected_deployment, run.target.expectedDeployment) || transcript.raw_audio_excluded !== true || transcript.digest_algorithm !== "sha-256" || transcript.canonicalization !== "utf8-json-sort-keys-compact-ascii-v1") return false;
  if (typeof transcript.session_id !== "string" || transcript.session_id.length === 0 || typeof transcript.thread_id !== "string" || transcript.thread_id.length === 0) return false;
  if (run.canonicalSessionId !== null && transcript.session_id !== run.canonicalSessionId) return false;
  if (run.threadId !== null && transcript.thread_id !== run.threadId) return false;
  const messages = Array.isArray(transcript.messages) ? transcript.messages : null;
  const boundaries = Array.isArray(transcript.turn_boundaries) ? transcript.turn_boundaries : null;
  if (!messages || !boundaries || !Number.isSafeInteger(transcript.message_revision) || Number(transcript.message_revision) < 0) return false;
  const normalizedMessages: Record<string, unknown>[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const row = message as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    const expectedKeys = ["approximate", "content", "created_at", "final", "message_id", "provider_event_id", "redaction_level", "role", "sequence", "source", "turn_id"].sort();
    if (keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) return false;
    if (typeof row.message_id !== "string" || row.message_id.length === 0 || row.sequence !== index + 1 || (row.role !== "user" && row.role !== "assistant") || typeof row.content !== "string" || !canonicalIso(row.created_at) || typeof row.source !== "string" || row.source.length === 0 || typeof row.final !== "boolean" || typeof row.approximate !== "boolean" || (row.turn_id !== null && typeof row.turn_id !== "string") || (row.provider_event_id !== null && typeof row.provider_event_id !== "string") || typeof row.redaction_level !== "string") return false;
    normalizedMessages.push(row);
  }
  const inputCount = normalizedMessages.filter((message) => message.role === "user").length;
  const outputCount = normalizedMessages.filter((message) => message.role === "assistant").length;
  if (transcript.message_count !== normalizedMessages.length || transcript.input_message_count !== inputCount || transcript.output_message_count !== outputCount || transcript.turn_boundary_count !== boundaries.length) return false;
  if (transcript.provider_expires_at !== run.expiresAt.toISOString() || !canonicalIso(transcript.retention_expires_at) || transcript.retention_hours !== run.capturePolicy.retentionHours || transcript.retention_anchor !== "finalized_at" || typeof transcript.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(transcript.sha256)) return false;
  if (sha256(canonicalAsciiJson(normalizedMessages)) !== transcript.sha256) return false;
  const recomputedBoundaries = canonicalTurnBoundaries(normalizedMessages);
  return canonicalAsciiJson(boundaries) === canonicalAsciiJson(recomputedBoundaries);
}

function canonicalTurnBoundaries(messages: Record<string, unknown>[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const sequence = Number(message.sequence);
    const turnId = message.turn_id;
    const prior = result.at(-1);
    const boundary = prior && prior.turn_id === turnId && prior.last_sequence === sequence - 1
      ? prior
      : (() => { const created = { turn_id: turnId, first_sequence: sequence, last_sequence: sequence, input_message_count: 0, output_message_count: 0 }; result.push(created); return created; })();
    boundary.last_sequence = sequence;
    const countKey = message.role === "user" ? "input_message_count" : "output_message_count";
    boundary[countKey] = Number(boundary[countKey]) + 1;
  }
  return result;
