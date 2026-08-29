Warning: truncated output (original token count: 96122)
Total output lines: 4392

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
        body: new URLSearchParams({ token, token_type_hint: hint, client_i…46122 tokens truncated…ndex) => key === assertionKeys[index])
          && timeValues.every(Number.isFinite) && timeValues.every((value, index) => index === 0 || timeValues[index - 1]! <= value)
          && operation !== undefined && resolved.length === 1 && acceptedTurns.length === 1 && acceptedTurns[0]!.seq < matchingLedgers[0]?.seq! && matchingLedgers.length === 1;
        return { exact, event, join, assertions, operation, acceptedTurns, matchingLedgers };
      });
      const exactEntries = exactJoins.filter((item) => item.exact);
      const relevantBuilderLedgers = toolLedgers.map((event) => {
        const entry = event.payload.entry as Record<string, unknown> | undefined;
        const toolEvidence = entry?.syntheticToolEvidence as Record<string, unknown> | undefined;
        const join = entry?.syntheticBuilderJoin as Record<string, unknown> | undefined;
        return { event, entry, toolEvidence, join };
      // `productEvents` is already restricted to the exact app-authored run
      // binding. Categorize every known Builder dispatch by the owning entry's
      // tool name before examining nested evidence: missing both nested receipts
      // is itself a mandatory cardinality/provenance failure, not a reason to
      // omit an observed dispatch from the candidate set.
      }).filter(({ entry }) => builderToolNames.has(String(entry?.toolName)));
      const exactBuilderLedger = ({ entry, toolEvidence }: (typeof relevantBuilderLedgers)[number]): boolean => typeof entry?.toolCallId === "string" && typeof entry.effectId === "string"
        && typeof entry.providerConnectionEpoch === "number" && builderToolNames.has(String(entry.toolName))
        && toolEvidence?.schema === "sophia_synthetic_tool_evidence_v1" && toolEvidence.test_run_id === run.testRunId && toolEvidence.scenario_id === run.scenarioId && toolEvidence.scenario_version === run.scenarioVersion
        && toolEvidence.tool_call_id === entry.toolCallId && toolEvidence.effect_id === entry.effectId && toolEvidence.provider_connection_epoch === entry.providerConnectionEpoch && toolEvidence.tool_name === entry.toolName
        && typeof toolEvidence.operation_id === "string" && typeof toolEvidence.utterance_id === "string" && Number.isSafeInteger(toolEvidence.provider_input_sequence) && Number(toolEvidence.provider_input_sequence) > 0;
      const builderGroups = new Map<string, typeof relevantBuilderLedgers>();
      for (const row of relevantBuilderLedgers) {
        const key = `${String(row.entry?.toolCallId)}\u0000${String(row.entry?.effectId)}`;
        const group = builderGroups.get(key) ?? [];
        group.push(row);
        builderGroups.set(key, group);
      }
      const exactBuilderGroups = [...builderGroups.values()].every((group) => {
        const terminal = group.filter(({ entry }) => terminalStates.has(String(entry?.finalState)));
        const last = group.reduce((latest, row) => row.event.seq > latest.event.seq ? row : latest, group[0]!);
        return group.length > 0 && group.every(exactBuilderLedger) && terminal.length === 1 && terminal[0] === last && terminal[0]!.join?.schema === "sophia_synthetic_builder_join_v1"
          && terminal[0]!.join?.test_run_id === run.testRunId && terminal[0]!.join?.scenario_id === run.scenarioId && terminal[0]!.join?.scenario_version === run.scenarioVersion;
      });
      const allTaskLedgers = [...builderGroups.values()].flatMap((group) => group.filter(({ entry }) => terminalStates.has(String(entry?.finalState))));
      const taskIds = new Set(allTaskLedgers.map((item) => item.join?.task_id));
      const toolCallIds = new Set(allTaskLedgers.map((item) => item.entry?.toolCallId));
      const effectIds = new Set(allTaskLedgers.map((item) => item.entry?.effectId));
      const baseExact = joinFaults.length === 0 && joinEvents.length === 1 && exactEntries.length === 1 && builderGroups.size > 0 && exactBuilderGroups
        && taskIds.size === 1 && toolCallIds.size === allTaskLedgers.length && effectIds.size === allTaskLedgers.length && allTaskLedgers.length === builderGroups.size;
      const exact = exactEntries[0];
      const assertions = exact?.assertions;
      let scenarioExact = false;
      if (baseExact && assertions) {
        if (run.scenarioId === "V-B01") scenarioExact = injected.length === 1 && allTaskLedgers.length === 1 && exact.join.tool_name === "start_builder_task" && exact.join.ui_projection_state === "artifact_visible_current" && exact.join.artifact_id !== null && exact.join.artifact_path_sha256 !== null
          && assertions.artifact_created === true && assertions.artifact_visible_current === true && assertions.accepted_turn_count === 1 && assertions.tool_dispatch_count === 1 && assertions.owned_task_count === 1 && assertions.stable_task_identity === true;
        if (run.scenarioId === "V-B02") scenarioExact = injected.length === 3 && allTaskLedgers.length === 1 && exact.join.tool_name === "start_builder_task" && exact.join.ui_projection_state === "artifact_visible_current"
          && assertions.accepted_turn_count === 3 && assertions.tool_dispatch_count === 1 && assertions.owned_task_count === 1 && assertions.stable_task_identity === true
          && new Set(injected.map((operation) => operation.id)).size === 3 && injected.every((operation) => productByKind("audio.input.product_turn").some((event) => (event.payload.receipt as Record<string, unknown> | undefined)?.operation_id === operation.id && (event.payload.receipt as Record<string, unknown> | undefined)?.outcome === "public_user_turn_accepted"));
        if (run.scenarioId === "V-B03") {
          const tools = new Set(allTaskLedgers.map((item) => item.entry?.toolName));
          scenarioExact = injected.length === 2 && allTaskLedgers.length === 2 && tools.has("start_builder_task") && [...tools].some((tool) => ["update_async_task", "edit_builder_artifact", "coreview_request_artifact_update"].includes(String(tool)))
            && exact.join.ui_projection_state === "artifact_visible_current" && exact.join.artifact_id !== null && exact.join.artifact_path_sha256 !== null
            && assertions.accepted_turn_count === 2 && assertions.tool_dispatch_count === 2 && assertions.owned_task_count === 1 && assertions.stable_task_identity === true && assertions.revision_updated_same_task === true && assertions.current_behavior_result === true;
        }
        if (run.scenarioId === "V-B04") {
          const tools = new Set(allTaskLedgers.map((item) => item.entry?.toolName));
          scenarioExact = injected.length === 2 && allTaskLedgers.length === 2 && tools.has("start_builder_task") && tools.has("cancel_async_task") && exact.join.tool_name === "cancel_async_task"
            && exact.join.tool_state === "terminal_settled" && exact.join.ui_projection_state === "canvas_current" && exact.join.cancel_count === 1 && exact.join.artifact_id === null && exact.join.artifact_path_sha256 === null
            && typeof exact.join.source_builder_event_id === "string" && exact.join.source_builder_event_id === `langgraph-run-terminal:${exact.join.run_id}:cancelled`
            && assertions.accepted_turn_count === 2 && assertions.tool_dispatch_count === 2 && assertions.owned_task_count === 1 && assertions.stable_task_identity === true
            && assertions.cancel_request_count === 1 && assertions.cancel_terminal_settled === true && assertions.no_post_cancel_publication === true && exact.join.no_post_cancel_publication === true;
        }
      }
      const evidence = [...joinEvents, ...joinFaults, ...toolLedgers, ...(exact?.acceptedTurns ?? [])];
      harness.push(joinEvents.length === 0
        ? unavailable(`${run.scenarioId.toLowerCase()}.exact_builder_ownership_chain`, "harness", "product_authored_synthetic_builder_join_unavailable")
        : check(`${run.scenarioId.toLowerCase()}.exact_builder_ownership_chain`, "harness", scenarioExact, evidence, "operation_input_turn_tool_effect_builder_task_run_artifact_and_post_commit_ui_join_failed"));
      product.push(run.scenarioId === "V-B02"
        ? unavailable("v-b02.owning_builder_semantics", "product", "owning_status_reply_to_builder_task_state_grounding_receipt_unavailable")
        : joinEvents.length === 0
          ? unavailable(`${run.scenarioId.toLowerCase()}.owning_builder_semantics`, "product", "product_authored_synthetic_builder_join_unavailable")
          : check(`${run.scenarioId.toLowerCase()}.owning_builder_semantics`, "product", scenarioExact, evidence, "product_builder_scenario_semantics_or_exactly_once_join_failed"));
      break;
    }
    case "V-I01": case "V-I02": {
      const barge = injected.filter((operation) => operation.type === "barge_in");
      const terminals = [...productByKind("audio.output.flushed"), ...productByKind("audio.output.dropped")];
      const causal = barge.map((operation) => {
        const target = operation.input._barge_target as Record<string, unknown> | undefined;
        const cited = productByKind("audio.output.started").find((event) => event.seq === Number(target?.after_output_event_seq));
        const citedReceipt = cited?.payload.receipt as Record<string, unknown> | undefined;
        const inputStarted = chain(operation.id).started[0];
        const targetTerminals = terminals.filter((event) => {
          const receipt = event.payload.receipt as Record<string, unknown> | undefined;
          return event.seq > (inputStarted?.seq ?? Number.MAX_SAFE_INTEGER) && receipt?.realizationId === target?.realization_id && Number(receipt?.providerConnectionEpoch) === Number(target?.provider_connection_epoch) && Number(receipt?.playbackGeneration) === Number(target?.playback_generation);
        });
        const targetAt = typeof target?.target_schedule_at === "string" ? Date.parse(target.target_schedule_at) : Number.NaN;
        const lateness = inputStarted ? inputStarted.at.getTime() - targetAt : Number.POSITIVE_INFINITY;
        const flushAt = targetTerminals[0] ? Date.parse(String((targetTerminals[0]!.payload.receipt as Record<string, unknown>).timestamp)) : Number.NaN;
        const flushLatency = inputStarted ? flushAt - inputStarted.at.getTime() : Number.POSITIVE_INFINITY;
        const exact = citedReceipt?.phase === "started" && citedReceipt.realizationId === target?.realization_id && Number(citedReceipt.providerConnectionEpoch) === Number(target?.provider_connection_epoch)
          && Number(citedReceipt.playbackGeneration) === Number(target?.playback_generation) && target?.receipt_phase === "started" && target?.intentional_overlap === true
          && inputStarted !== undefined && Number.isFinite(targetAt) && lateness >= -50 && lateness <= Number(target?.max_lateness_ms) && targetTerminals.length === 1
          && Number.isFinite(flushLatency) && flushLatency >= 0 && flushLatency <= 1_500 && chain(operation.id).exact;
        return { exact, events: [...(cited ? [cited] : []), ...(inputStarted ? [inputStarted] : []), ...targetTerminals] };
      });
      const exactBarge = causal.length === 1 && causal[0]!.exact;
      const staleRestarts = causal.flatMap((item, index) => {
        const operation = barge[index]!;
        const target = operation.input._barge_target as Record<string, unknown> | undefined;
        const terminalSeq = item.events.filter((event) => ["audio.output.flushed", "audio.output.dropped"].includes(event.kind)).at(-1)?.seq ?? Number.MAX_SAFE_INTEGER;
        return productByKind("audio.output.started").filter((event) => {
          const receipt = event.payload.receipt as Record<string, unknown> | undefined;
          return event.seq > terminalSeq && (receipt?.realizationId === target?.realization_id || (typeof target?.chunk_hash === "string" && receipt?.chunkHash === target.chunk_hash));
        });
      });
      const exactBargeNoStale = exactBarge && staleRestarts.length === 0;
      harness.push(check(`${run.scenarioId.toLowerCase()}.exact_barge_causal_chain`, "harness", exactBargeNoStale, [...causal.flatMap((item) => item.events), ...staleRestarts], "exact_cited_realization_epoch_generation_input_start_flush_latency_and_no_stale_restart_chain_unavailable"));
      if (run.scenarioId === "V-I02") {
        const operation = barge[0];
        const toolTarget = operation?.input._tool_target as Record<string, unknown> | undefined;
        const targetEvent = typeof toolTarget?.event_seq === "number" ? productEvents.find((event) => event.seq === toolTarget.event_seq && event.kind.includes("gemini-tool-call-ledger")) : undefined;
        const targetEntry = targetEvent?.payload.entry as Record<string, unknown> | undefined;
        const targetCapture = targetEvent?.payload._capture_provenance as Record<string, unknown> | undefined;
        const targetEvidence = targetEntry?.syntheticToolEvidence as Record<string, unknown> | undefined;
        const terminalStates = new Set(["responded", "cancelled-before-send", "cancelled-after-send", "suppressed", "rejected"]);
        const related = productEvents.filter((event) => {
          const entry = event.payload.entry as Record<string, unknown> | undefined;
          return event.kind.includes("gemini-tool-call-ledger") && (entry?.toolCallId === toolTarget?.tool_call_id || entry?.effectId === toolTarget?.effect_id);
        }).map((event) => ({ event, entry: event.payload.entry as Record<string, unknown> }));
        const terminals = related.filter(({ entry }) => terminalStates.has(String(entry.finalState)) && (typeof entry.toolResponseSentAt === "string" || typeof entry.cancelledAt === "string"));
        const inputStarted = operation ? chain(operation.id).started[0] : undefined;
        const expectedTargetIdentity = sha256(`${String(toolTarget?.tool_call_id)}\u0000${String(toolTarget?.effect_id)}`);
        const revalidated = operation ? byKind("fault.active_target_revalidated").filter((event) => event.source === "canonical" && event.payload.operation_id === operation.id && event.payload.target_event_seq === targetEvent?.seq && event.payload.target_kind === "tool_effect"
          && event.payload.target_identity_sha256 === expectedTargetIdentity && Number.isSafeInteger(event.payload.observed_through_seq) && Number(event.payload.observed_through_seq) >= Number(targetEvent?.seq) && event.payload.active === true) : [];
        const fenced = operation && toolTarget ? exactActiveTargetFenceEvents(events, operation.id, toolTarget, "tool_effect") : [];
        const owner = operations.find((candidate) => candidate.id === toolTarget?.owner_operation_id && (candidate.type === "speak" || candidate.type === "barge_in") && candidate.state === "succeeded");
        const exactEvidence = (entry: Record<string, unknown>): boolean => {
          const evidence = entry.syntheticToolEvidence as Record<string, unknown> | undefined;
          return entry.toolCallId === toolTarget?.tool_call_id && entry.effectId === toolTarget?.effect_id && entry.providerConnectionEpoch === toolTarget?.provider_connection_epoch
            && evidence?.schema === "sophia_synthetic_tool_evidence_v1" && evidence.test_run_id === run.testRunId && evidence.scenario_id === run.scenarioId && evidence.scenario_version === run.scenarioVersion
            && evidence.operation_id === toolTarget?.owner_operation_id && evidence.utterance_id === toolTarget?.owner_utterance_id && evidence.provider_input_sequence === toolTarget?.provider_input_sequence
            && evidence.tool_call_id === toolTarget?.tool_call_id && evidence.effect_id === toolTarget?.effect_id && evidence.provider_connection_epoch === toolTarget?.provider_connection_epoch;
        };
        const exactTool = operation !== undefined && toolTarget?.activity_state === "in_flight" && targetEvent !== undefined && targetEntry?.finalState === "unknown" && typeof targetEntry.receivedAt === "string"
          && targetEntry.toolResponseSentAt === null && targetEntry.cancelledAt === null && targetEntry.toolCallId === toolTarget.tool_call_id && targetEntry.effectId === toolTarget.effect_id
          && targetEntry.providerConnectionEpoch === toolTarget.provider_connection_epoch && targetEvidence?.schema === "sophia_synthetic_tool_evidence_v1" && targetEvidence.test_run_id === run.testRunId
          && targetEvidence.operation_id === toolTarget.owner_operation_id && targetEvidence.utterance_id === toolTarget.owner_utterance_id && targetEvidence.provider_input_sequence === toolTarget.provider_input_sequence
          && targetEvidence.tool_call_id === toolTarget.tool_call_id && targetEvidence.effect_id === toolTarget.effect_id && targetCapture?.generation === toolTarget.product_generation && targetCapture?.seq === toolTarget.product_seq
          && owner !== undefined && inputStarted !== undefined && related.every(({ entry }) => exactEvidence(entry))
          && revalidated.length === 1 && fenced.length === 1 && targetEvent.seq < revalidated[0]!.seq && revalidated[0]!.seq < fenced[0]!.seq && fenced[0]!.seq < inputStarted.seq && terminals.length === 1 && inputStarted.seq < terminals[0]!.event.seq
          && terminals[0]!.entry.toolCallId === toolTarget.tool_call_id && terminals[0]!.entry.effectId === toolTarget.effect_id
          && (terminals[0]!.entry.syntheticToolEvidence as Record<string, unknown> | undefined)?.operation_id === owner.id
          && related.filter(({ entry }) => terminalStates.has(String(entry.finalState))).length === 1 && exactTerminalLastToolLifecycle(related, inputStarted.seq);
        harness.push(check("v-i02.tool_boundary_total_order_and_at_most_once_settlement", "harness", exactTool, [...related.map((item) => item.event), ...revalidated, ...fenced], "exact_owned_in_flight_tool_effect_browser_atomic_fence_barge_order_and_single_terminal_settlement_unavailable"));
        // The exact effect ordering/cardinality is machine-verifiable above,
        // but the product contract does not yet expose an owning semantic
        // receipt joining the post-barge assistant promise to the actual tool
        // terminal outcome. Never infer that relationship from transcript
        // wording or turn proximity.
        product.push(unavailable("v-i02.retained_input_and_at_most_once_effect", "product", "owning_post_barge_promise_to_tool_outcome_receipt_unavailable"));
      } else product.push(check("v-i01.retained_input_after_flush", "product", exactBargeNoStale, [...causal.flatMap((item) => item.events), ...staleRestarts], "bound_barge_input_flush_or_no_stale_output_receipt_unavailable"));
      break;
    }
    case "V-N01": case "V-N02": {
      const rotation = operations.filter((operation) => operation.type === "force_socket_rotation" && operation.state === "succeeded");
      const epochs = productByKind("provider.connection_epoch");
      const operation = rotation[0];
      const priorEpoch = Number(operation?.input.expected_socket_epoch);
      const resultProduct = (operation?.result?.rotation_receipt as Record<string, unknown> | undefined)?.product as Record<string, unknown> | undefined;
      const restoredEpoch = Number(resultProduct?.providerConnectionEpoch);
      const restoredEvent = epochs.find((event) => event.seq === Number(resultProduct?._seq));
      const restoredReceipt = restoredEvent?.payload.receipt as Record<string, unknown> | undefined;
      const priorEvents = epochs.filter((event) => event.seq < (restoredEvent?.seq ?? -1)).filter((event) => {
        const receipt = event.payload.receipt as Record<string, unknown> | undefined;
        return Number(receipt?.providerConnectionEpoch) === priorEpoch && receipt?.continuityState === "active" && ["bootstrap", "restored"].includes(String(receipt?.phase));
      });
      const restored = rotation.length === 1 && Number.isSafeInteger(priorEpoch) && priorEvents.length >= 1 && restoredEvent !== undefined && resultProduct !== undefined
        && resultProduct.phase === "restored" && resultProduct.previousProviderConnectionEpoch === priorEpoch && Number(resultProduct.providerConnectionEpoch) > priorEpoch && resultProduct.continuityState === "active"
        && canonicalRequestHash(restoredReceipt) === canonicalRequestHash(Object.fromEntries(Object.entries(resultProduct).filter(([key]) => key !== "_seq")))
        && restoredReceipt?.phase === "restored" && restoredReceipt.previousProviderConnectionEpoch === priorEpoch && Number(restoredReceipt.providerConnectionEpoch) > priorEpoch && restoredReceipt.continuityState === "active";
      harness.push(check(`${run.scenarioId.toLowerCase()}.requested_epoch_to_restored_epoch`, "harness", restored, epochs, "exact_requested_prior_epoch_and_app_authored_restored_receipt_join_unavailable"));
      if (run.scenarioId === "V-N02") {
        const target = operation?.input._commit_target as Record<string, unknown> | undefined;
        const targetEvent = typeof target?.event_seq === "number" ? productEvents.find((event) => event.seq === target.event_seq) : undefined;
        const targetKind = target?.kind === "output_realization" ? "output_realization" : "tool_effect";
        const expectedTargetIdentity = sha256(`${String(target?.stable_id)}\u0000${String(targetKind === "output_realization" ? target?.chunk_hash : target?.effect_id)}`);
        const revalidated = operation ? byKind("fault.active_target_revalidated").filter((event) => event.source === "canonical" && event.payload.operation_id === operation.id && event.payload.target_event_seq === targetEvent?.seq
          && event.payload.target_kind === targetKind && event.payload.target_identity_sha256 === expectedTargetIdentity && Number.isSafeInteger(event.payload.observed_through_seq)
          && Number(event.payload.observed_through_seq) >= Number(targetEvent?.seq) && event.payload.active === true) : [];
        const fenced = operation && target ? exactActiveTargetFenceEvents(events, operation.id, target, targetKind) : [];
        let exactEffect = false;
        let effectEvidence: import("./domain.js").LabEvent[] = targetEvent ? [targetEvent] : [];
        if (target?.kind === "output_realization" && target?.activity_state === "in_flight" && targetEvent?.kind === "audio.output.started") {
          const matching = productEvents.filter((event) => {
            const receipt = event.payload.receipt as Record<string, unknown> | undefined;
            return receipt?.realizationId === target.stable_id || (typeof target.chunk_hash === "string" && receipt?.chunkHash === target.chunk_hash);
          });
          const targetReceipt = targetEvent.payload.receipt as Record<string, unknown> | undefined;
          const targetCapture = targetEvent.payload._capture_provenance as Record<string, unknown> | undefined;
          const terminals = matching.filter((event) => {
            const receipt = event.payload.receipt as Record<string, unknown> | undefined;
            return event.seq > (fenced[0]?.seq ?? Number.MAX_SAFE_INTEGER) && ["audio.output.completed", "audio.output.flushed", "audio.output.dropped"].includes(event.kind)
              && receipt?.realizationId === target.stable_id && receipt?.chunkHash === target.chunk_hash && Number(receipt?.providerConnectionEpoch) === priorEpoch
              && Number(receipt?.playbackGeneration) === Number(target.playback_generation);
          });
          const allTerminals = matching.filter((event) => ["audio.output.completed", "audio.output.flushed", "audio.output.dropped"].includes(event.kind));
          const competingStarts = matching.filter((event) => event.kind === "audio.output.started" && event.seq !== targetEvent.seq);
          const replayedAfterFence = matching.filter((event) => event.seq > (fenced[0]?.seq ?? Number.MAX_SAFE_INTEGER) && ["audio.output.scheduled", "audio.output.started"].includes(event.kind));
          const replayedAfterTerminal = terminals.length === 1 ? matching.filter((event) => event.seq > terminals[0]!.seq && ["audio.output.scheduled", "audio.output.started", "audio.output.completed"].includes(event.kind)) : [];
          exactEffect = targetReceipt?.realizationId === target.stable_id && targetReceipt?.chunkHash === target.chunk_hash
            && targetReceipt?.phase === "started" && Number(targetReceipt?.providerConnectionEpoch) === priorEpoch && Number(targetReceipt?.playbackGeneration) === Number(target.playback_generation)
            && targetCapture?.generation === target.product_generation && targetCapture?.seq === target.product_seq
            && terminals.length === 1 && allTerminals.length === 1 && competingStarts.length === 0 && replayedAfterFence.length === 0 && replayedAfterTerminal.length === 0 && Number.isSafeInteger(restoredEpoch) && restoredEpoch > priorEpoch;
          effectEvidence = matching;
        } else if (target?.kind === "tool_settlement" && target?.activity_state === "in_flight" && targetEvent?.kind.includes("gemini-tool-call-ledger")) {
          const matching = productEvents.filter((event) => {
            const entry = event.payload.entry as Record<string, unknown> | undefined;
            return event.kind.includes("gemini-tool-call-ledger") && (entry?.toolCallId === target.stable_id || entry?.effectId === target.effect_id);
          });
          const terminal = matching.filter((event) => {
            const entry = event.payload.entry as Record<string, unknown> | undefined;
            return event.seq > targetEvent.seq && entry?.toolCallId === target.stable_id && entry?.effectId === target.effect_id
              && ["responded", "cancelled-before-send", "cancelled-after-send", "suppressed", "rejected"].includes(String(entry?.finalState)) && (typeof entry?.toolResponseSentAt === "string" || typeof entry?.cancelledAt === "string");
          });
          const allTerminalForTool = matching.filter((event) => {
            const entry = event.payload.entry as Record<string, unknown> | undefined;
            return ["responded", "cancelled-before-send", "cancelled-after-send", "suppressed", "rejected"].includes(String(entry?.finalState));
          });
          const targetEntry = targetEvent.payload.entry as Record<string, unknown>;
          const targetEvidence = targetEntry.syntheticToolEvidence as Record<string, unknown> | undefined;
          const targetCapture = targetEvent.payload._capture_provenance as Record<string, unknown> | undefined;
          const owner = operations.find((candidate) => candidate.id === target.owner_operation_id && (candidate.type === "speak" || candidate.type === "barge_in") && candidate.state === "succeeded");
          const exactToolEvidence = (event: import("./domain.js").LabEvent): boolean => {
            const entry = event.payload.entry as Record<string, unknown> | undefined;
            const evidence = entry?.syntheticToolEvidence as Record<string, unknown> | undefined;
            return entry?.toolCallId === target.stable_id && entry?.effectId === target.effect_id && entry?.providerConnectionEpoch === target.provider_connection_epoch
              && evidence?.schema === "sophia_synthetic_tool_evidence_v1" && evidence.test_run_id === run.testRunId && evidence.scenario_id === run.scenarioId && evidence.scenario_version === run.scenarioVersion
              && evidence.operation_id === target.owner_operation_id && evidence.utterance_id === target.owner_utterance_id && evidence.provider_input_sequence === target.provider_input_sequence
              && evidence.tool_call_id === target.stable_id && evidence.effect_id === target.effect_id && evidence.provider_connection_epoch === target.provider_connection_epoch;
          };
          exactEffect = targetEntry.finalState === "unknown" && targetEntry.toolResponseSentAt === null && targetEntry.cancelledAt === null && terminal.length === 1 && allTerminalForTool.length === 1
            && terminal[0]!.seq > (fenced[0]?.seq ?? Number.MAX_SAFE_INTEGER) && Number(targetEntry.providerConnectionEpoch) === priorEpoch && targetCapture?.generation === target.product_generation && targetCapture?.seq === target.product_seq
            && targetEvidence?.operation_id === target.owner_operation_id && owner !== undefined && matching.every(exactToolEvidence)
            && exactTerminalLastToolLifecycle(matching.map((event) => ({ event, entry: event.payload.entry as Record<string, unknown> })), fenced[0]?.seq ?? Number.MAX_SAFE_INTEGER)
            && Number.isSafeInteger(restoredEpoch) && restoredEpoch > priorEpoch;
          effectEvidence = matching;
        }
        const exactContinuity = restored && exactEffect && revalidated.length === 1 && fenced.length === 1 && targetEvent !== undefined && restoredEvent !== undefined
          && targetEvent.seq < revalidated[0]!.seq && revalidated[0]!.seq < fenced[0]!.seq && fenced[0]!.seq < restoredEvent.seq;
        harness.push(check("v-n02.committed_boundary_exactly_once_effect", "harness", exactContinuity, [...epochs, ...effectEvidence, ...revalidated, ...fenced], "exact_in_flight_app_target_browser_atomic_fence_and_exactly_once_terminal_effect_unavailable"));
        product.push(check("v-n02.exactly_once_continuity_effect", "product", exactContinuity, [...epochs, ...effectEvidence, ...revalidated, ...fenced], "owning_in_flight_event_or_effect_ledger_unavailable"));
      } else {
        const outputLifecycleKinds = new Set(["audio.output.scheduled", "audio.output.started", "audio.output.completed", "audio.output.flushed", "audio.output.dropped"]);
        const outputReceipts = productEvents.filter((event) => outputLifecycleKinds.has(event.kind)).map((event) => ({ event, receipt: event.payload.receipt as Record<string, unknown> | undefined })).filter(({ receipt }) => typeof receipt?.realizationId === "string");
        const inputEffects = productByKind("audio.input.product_turn").map((event) => ({ event, receipt: event.payload.receipt as Record<string, unknown> | undefined })).filter(({ receipt }) => typeof receipt?.operation_id === "string");
        const inputEffectKeys = inputEffects.map(({ receipt }) => `${receipt?.operation_id}\u0000${receipt?.source}\u0000${receipt?.outcome}`);
        const toolLedgerRows = productEvents.filter((event) => event.kind.includes("gemini-tool-call-ledger")).map((event) => ({ event, entry: event.payload.entry as Record<string, unknown> | undefined }));
        const validToolRows = toolLedgerRows.filter((row): row is { event: import("./domain.js").LabEvent; entry: Record<string, unknown> } => typeof row.entry?.toolCallId === "string" && typeof row.entry.effectId === "string");
        const toolGroups = new Map<string, typeof validToolRows>();
        for (const row of validToolRows) {
          const key = `${String(row.entry.toolCallId)}\u0000${String(row.entry.effectId)}`;
          const group = toolGroups.get(key) ?? [];
          group.push(row);
          toolGroups.set(key, group);
        }
        const toolCallIds = [...toolGroups.values()].map((group) => String(group[0]!.entry.toolCallId));
        const toolEffectIds = [...toolGroups.values()].map((group) => String(group[0]!.entry.effectId));
        const exactToolLifecycles = toolLedgerRows.length === validToolRows.length && [...toolGroups.values()].every((group) => exactTerminalLastToolLifecycle(group));
        const postRestoreInputs = restoredEvent ? injected.filter((candidate) => {
          const inputChain = chain(candidate.id);
          const leg = inputChain.productLegs[0]?.payload.receipt as Record<string, unknown> | undefined;
          return inputChain.exact && inputChain.started.length === 1 && inputChain.started[0]!.seq > restoredEvent.seq && inputChain.productTurns.some((event) => event.seq > restoredEvent.seq)
            && Number(leg?.provider_connection_epoch) === restoredEpoch;
        }) : [];
        const acceptedInputSeq = postRestoreInputs.length === 1 ? Math.max(...chain(postRestoreInputs[0]!.id).productTurns.map((event) => event.seq)) : Number.MAX_SAFE_INTEGER;
        const noDuplicateWork = injected.length === 1 && postRestoreInputs.length === 1 && injected.every((candidate) => chain(candidate.id).exact)
          && exactOutputLifecyclesAtEpoch(productEvents, restoredEpoch, acceptedInputSeq) && new Set(inputEffectKeys).size === inputEffectKeys.length
          && exactToolLifecycles && new Set(toolCallIds).size === toolCallIds.length && new Set(toolEffectIds).size === toolEffectIds.length;
        harness.push(check("v-n01.no_duplicate_speech_or_tool_work", "harness", noDuplicateWork, [...allChainEvents, ...outputReceipts.map(({ event }) => event), ...inputEffects.map(({ event }) => event), ...toolLedgerRows.map(({ event }) => event)], "exact_input_output_and_tool_effect_continuity_evidence_unavailable"));
        product.push(unavailable("v-n01.exactly_once_continuity_effect", "product", noDuplicateWork && restored ? "product_authored_post_restore_input_to_assistant_response_lineage_unavailable" : "exact_post_restore_input_output_continuity_receipts_unavailable"));
      }
      break;
    }
    case "V-F01": {
      const finalizedEvents = byKind("session.finalized");
      const nonSilence = injected.filter((operation) => !String(operation.input.fixture_id ?? "").toLowerCase().includes("silence"));
      const exactInput = nonSilence.length === 1 && chain(nonSilence[0]!.id).exact;
      harness.push(check("f01.one_exact_non_silence_input_chain", "harness", exactInput, nonSilence.flatMap((operation) => Object.values(chain(operation.id)).flatMap((value) => Array.isArray(value) ? value : [])), "one_operation_correlated_non_silence_input_chain_required"));
      const assistantTurns = productEvents.filter((event) => event.kind.endsWith(".sophia.turn") && ((event.payload.data as Record<string, unknown> | undefined)?.phase === "agent_ended" || event.payload.phase === "agent_ended"));
      harness.push(check("f01.completed_assistant_turn", "harness", assistantTurns.length >= 1, assistantTurns, "bound_assistant_turn_completion_unavailable"));
      const strictFinalized = finalizedEvents.filter((event) => isCanonicalFinalizationReceipt(run, event));
      const nonempty = strictFinalized.some((event) => {
        const receipt = event.payload.receipt as Record<string, unknown>;
        const transcript = receipt.canonical_transcript as Record<string, unknown>;
        return Number(transcript.message_count) > 0 && Number(transcript.input_message_count) > 0 && Number(transcript.output_message_count) > 0 && Number(transcript.turn_boundary_count) > 0;
      });
      harness.push(check("f01.strict_nonempty_canonical_finalization", "harness", strictFinalized.length === 1 && nonempty, finalizedEvents, "strict_nonempty_bound_canonical_transcript_receipt_unavailable"));
      product.push(check("f01.unified_durable_finalizer", "product", strictFinalized.length === 1 && nonempty, finalizedEvents, "durable_product_finalizer_receipt_unavailable"));
      break;
    }
    case "V-D01": {
      const captureEvents = productEvents.filter((event) => {
        const provenance = event.payload._capture_provenance as Record<string, unknown> | undefined;
        return Number.isSafeInteger(provenance?.generation) && Number.isSafeInteger(provenance?.seq);
      });
      const pages = byKind("capture.product_page");
      const productCoordinates = captureEvents.map((event) => event.payload._capture_provenance as Record<string, unknown>);
      const generations = new Set(productCoordinates.map((value) => Number(value.generation)));
      const productSeqs = productCoordinates.map((value) => Number(value.seq)).sort((left, right) => left - right);
      const monotonicProduct = captureEvents.length > 500 && generations.size === 1 && productSeqs[0] === 1 && productSeqs.every((seq, index) => index === 0 || seq === productSeqs[index - 1]! + 1) && new Set(productSeqs).size === productSeqs.length;
      const pagePayloads = pages.map((event) => event.payload);
      const paged = pagePayloads.length > 1 && pagePayloads.every((page, index) => {
        const prior = index === 0 ? null : pagePayloads[index - 1]!;
        const requested = Number(page.requestedSeq);
        const returned = Number(page.returnedSeq);
        const oldest = Number(page.oldestSeq);
        const latest = Number(page.latestSeq);
        const capacity = Number(page.capacity);
        const dropped = Number(page.droppedCount);
        const priorDropped = prior === null ? 0 : Number(prior.droppedCount);
        const priorOldest = prior === null ? 1 : Number(prior.oldestSeq);
        return page.gap === false
          // droppedCount is ring eviction accounting, not evidence loss. A
          // continuously drained cursor may remain ahead of oldestSeq while
          // eviction rises. The durable union below must still be contiguous.
          && Number.isSafeInteger(dropped) && dropped >= 0 && dropped >= priorDropped
          && Number.isSafeInteger(capacity) && capacity > 0
          && Number.isSafeInteger(oldest) && oldest >= 1 && oldest <= latest + 1 && oldest >= priorOldest
          && Number.isSafeInteger(requested) && Number.isSafeInteger(returned) && returned >= requested
          && (prior === null || requested === Number(prior.returnedSeq))
          && (requested === 0 || requested >= oldest - 1);
      });
      const finalPage = pagePayloads.at(-1);
      const reconciled = finalPage !== undefined && Number(finalPage.latestSeq) === productSeqs.at(-1) && Number(finalPage.totalProduced) === captureEvents.length && Number(finalPage.returnedSeq) === Number(finalPage.latestSeq);
      harness.push(check("d01.over_500_bound_product_capture_events", "harness", monotonicProduct, captureEvents, "more_than_500_exact_bound_product_capture_envelopes_unavailable"));
      harness.push(check("d01.read_after_metadata_reconciled", "harness", paged && reconciled, pages, "capture_generation_capacity_drop_and_total_metadata_unavailable_or_inconsistent"));
      product.push(unavailable("d01.product_gate", "product", "not_applicable"));
      break;
    }
    case "V-L01": {
      const finalized = byKind("session.finalized");
      const traceEvents = productByKind("trace.fault_receipt");
      const traceReceipts = traceEvents.map((event) => ({ event, receipt: event.payload.receipt as Record<string, unknown> | undefined }));
      const exactReceipt = (receipt: Record<string, unknown> | undefined, phase: "applied" | "restored") => receipt?.schema === "sophia_voice_lab_trace_fault_v1"
        && receipt.fault === "langsmith_unavailable"
        && receipt.phase === phase
        && receipt.principal_id === run.principalId
        && receipt.test_run_id === run.testRunId
        && receipt.scenario_id === "V-L01"
        && receipt.scenario_version === run.scenarioVersion
        && receipt.environment === run.environment
        && sameDeployment(receipt.expected_deployment, run.target.expectedDeployment)
        && receipt.trace_unavailable === true
        && receipt.canonical_behavior_unchanged === true
        && canonicalIso(receipt.applied_at)
        && (phase === "applied" ? receipt.restored_at === null : canonicalIso(receipt.restored_at));
      const applied = traceReceipts.filter(({ receipt }) => exactReceipt(receipt, "applied"));
      const restored = traceReceipts.filter(({ receipt }) => exactReceipt(receipt, "restored"));
      const appliedAt = applied[0]?.receipt?.applied_at;
      const exactLifecycle = traceEvents.length === 2 && applied.length === 1 && restored.length === 1
        && restored[0]!.event.seq > applied[0]!.event.seq
        && restored[0]!.receipt!.applied_at === appliedAt
        && new Date(String(restored[0]!.receipt!.restored_at)).getTime() >= new Date(String(appliedAt)).getTime();
      const observability = productByKind("provider.connection_observability").filter((event) => event.payload.langsmithTraceStatus === "trace_unavailable"
        && event.payload.langsmithTraceUnavailableReason === "governed_synthetic_fault"
        && (event.payload.langsmithTraceId === null || event.payload.langsmithTraceId === undefined));
      harness.push(check("l01.governed_supplemental_trace_outage", "harness", exactLifecycle && observability.length >= 1, [...traceEvents, ...observability], "exact_app_authored_trace_fault_applied_restored_and_unavailable_receipts_missing"));
      harness.push(check("l01.local_evidence_chain_survives", "harness", exactChains && finalized.length === 1, [...allChainEvents, ...finalized], "local_input_or_finalization_evidence_unavailable"));
      const behavior = [...productByKind("audio.output.started"), ...productEvents.filter((event) => event.kind.endsWith(".sophia.turn"))];
      product.push(check("l01.product_behavior_continues_without_trace_adapter", "product", behavior.length > 0, behavior, "bound_product_behavior_receipt_unavailable"));
      break;
    }
    case "V-P01": {
      const platform = externalAttestations("p01_platform_plugin_task").filter((event) => {
        const proof = event.payload.evidence as Record<string, unknown> | undefined;
        const ids = Array.isArray(proof?.operation_ids) ? proof.operation_ids : [];
        const calls = Array.isArray(proof?.calls) ? proof.calls : [];
        return proof?.authority === "platform_plugin" && proof.prohibited_tool_audit_passed === true && proof.raw_javascript_used === false && proof.local_runner_used === false && proof.manual_takeover_used === false
          && proof.exact_deployment_discovered === true && proof.adaptive_followup_completed === true && Number(proof.high_level_call_count) === 10 && calls.length === 10
          && ids.every((id) => operations.some((operation) => operation.id === id));
      });
      // Ordinary operation/audit rows still cannot self-certify installation.
      // The only passing path is a privileged platform-authored attestation
      // already cross-joined by the service to exact MCP audits/operations.
      harness.push(platform.length === 0 ? unavailable("p01.fresh_registered_plugin_task", "harness", "platform_authored_plugin_asdk_app_install_and_fresh_task_provenance_not_attached") : check("p01.fresh_registered_plugin_task", "harness", platform.length === 1, platform, "platform_plugin_attestation_conflicted_or_duplicated"));
      product.push(unavailable("p01.product_gate", "product", "not_applicable"));
      break;
    }
    case "V-S01": {
      const probes = byKind("security.invalid_grant_probe");
      const variants = new Set(probes.map((event) => event.payload.variant));
      const rejected = probes.length === S01_FRONTEND_GRANT_VARIANTS.length && S01_FRONTEND_GRANT_VARIANTS.every((variant) => variants.has(variant)) && probes.every((event) => event.payload.rejected === true && event.payload.exact_response_target === true && event.payload.no_session_cookie === true && event.payload.no_redirect === true);
      harness.push(check("s01.all_invalid_grants_rejected", "harness", rejected, probes, "one_or_more_invalid_grant_receipts_unavailable_or_accepted"));
      const oauth = byKind("security.oauth_boundary_probe");
      const oauthVariants = new Set(oauth.map((event) => event.payload.variant));
      harness.push(check("s01.oauth_resource_scope_and_replay_rejected", "harness", oauth.length === S01_OAUTH_VARIANTS.length && S01_OAUTH_VARIANTS.every((variant) => oauthVariants.has(variant)) && oauth.every((event) => event.payload.rejected === true), oauth, "oauth_missing_invalid_scope_resource_or_replay_receipt_unavailable"));
      const directFault = byKind("security.direct_fault_scope_probe");
      harness.push(check("s01.base_credential_has_no_fault_scope", "harness", directFault.length === 1 && directFault[0]!.payload.rejected === true && directFault[0]!.payload.fault_credential_distinct === true, directFault, "direct_fault_scope_separation_unavailable"));
      const oauthCleanup = byKind("security.oauth_family_cleanup");
      harness.push(check("s01.oauth_probe_family_revoked", "harness", oauthCleanup.length === 1 && oauthCleanup[0]!.payload.complete === true && oauthCleanup[0]!.payload.authorization_code_cleanup_handle_used === true && oauthCleanup[0]!.payload.authorization_code_family_terminalized === true && oauthCleanup[0]!.payload.access_token_issued === true && oauthCleanup[0]!.payload.refresh_token_issued === true && oauthCleanup[0]!.payload.refresh_family_revocation_receipt === true && oauthCleanup[0]!.payload.access_revocation_receipt === true && oauthCleanup[0]!.payload.access_token_denied_after_revocation === true && oauthCleanup[0]!.payload.refresh_token_denied_after_revocation === true && oauthCleanup[0]!.payload.durable_terminal_state_verified === true && oauthCleanup[0]!.payload.raw_tokens_excluded === true, oauthCleanup, "oauth_probe_authorization_code_access_or_refresh_family_remains_live"));
      const zero = eligible.filter((event) => event.kind === "cleanup.recovery" || event.kind === "cleanup.browser_context_absent" || event.kind === "cleanup.browser_lease_absent" || event.kind === "security.pre_resource_allocation_fence");
      const fence = byKind("security.pre_resource_allocation_fence");
      const noAllocation = fence.length === 1 && fence[0]!.payload.active_run_count_unchanged === true && fence[0]!.payload.browser_context_absent === true && fence[0]!.payload.browser_lease_absent === true && fence[0]!.payload.canonical_session_absent === true && fence[0]!.payload.provider_session_absent === true && fence[0]!.payload.tts_process_invocations === 0;
      harness.push(check("s01.rejected_before_resource_allocation", "harness", noAllocation && authoritativeLiveCleanupComplete(eligible) && byKind("cleanup.browser_context_absent").length === 1 && byKind("cleanup.browser_lease_absent").some((event) => event.payload.authoritative_ledger_read === true), zero, "authoritative_zero_resource_recovery_unavailable"));
      product.push(unavailable("s01.no_ordinary_product_impact", "product", "not_applicable_pre_resource_rejection"));
      break;
    }
    case "V-S02": {
      const probes = byKind("security.pre_resource_validation_probe");
      const variants = new Set(probes.map((event) => event.payload.variant));
      const rejected = probes.length === S02_VALIDATION_VARIANTS.length && S02_VALIDATION_VARIANTS.every((variant) => variants.has(variant)) && probes.every((event) => event.payload.rejected === true && event.payload.expected_error_class === event.payload.observed_error_class && typeof event.payload.production_validator === "string");
      harness.push(check("s02.shared_validators_reject_all_cases", "harness", rejected, probes, "malformed_media_or_target_validator_receipt_missing"));
      const equivalence = byKind("security.shared_validator_equivalence");
      harness.push(check("s02.internal_validator_supplement", "harness", equivalence.length === 1 && equivalence[0]!.payload.internal_validator_supplement === true && equivalence[0]!.payload.variant_count === S02_VALIDATION_VARIANTS.length && equivalence[0]!.payload.production_boundary_assertion === "security.mcp_boundary_probe", equivalence, "internal_shared_validator_supplement_unavailable"));
      const surface = byKind("security.s02_surface_coverage");
      const surfacePayload = surface[0]?.payload;
      const fixtureStartup = surfacePayload?.fixture_startup_receipt as Record<string, unknown> | undefined;
      const exactSurface = surface.length === 1 && surface[0]!.source === "canonical"
        && hasExactKeys(surfacePayload!, ["schema", "public_authenticated_mcp_variants", "internal_startup_only_variants", "unsupported_fixture_public_mcp", "raw_audio_public_surface", "raw_audio_surface_reason", "fixture_startup_receipt"])
        && surfacePayload!.schema === "sophia_voice_lab_s02_surface_coverage_v1"
        && canonicalAsciiJson(surfacePayload!.public_authenticated_mcp_variants) === canonicalAsciiJson(S02_HTTP_VARIANTS)
        && canonicalAsciiJson(surfacePayload!.internal_startup_only_variants) === canonicalAsciiJson(["fixture_metadata_bytes", "fixture_metadata_duration", "malformed_wav", "oversized_audio"])
        && surfacePayload!.unsupported_fixture_public_mcp === true && surfacePayload!.raw_audio_public_surface === false && surfacePayload!.raw_audio_surface_reason === "no_public_raw_audio_surface"
        && fixtureStartup !== undefined && hasExactKeys(fixtureStartup, ["schema", "status", "expected_manifest_sha256", "observed_manifest_sha256", "manifest_version", "fixture_count", "immutable_files_verified", "raw_audio_public_surface"])
        && fixtureStartup.schema === "sophia_voice_lab_fixture_startup_v1" && fixtureStartup.status === "verified"
        && fixtureStartup.expected_manifest_sha256 === BUNDLED_FIXTURE_MANIFEST_SHA256
        && fixtureStartup.observed_manifest_sha256 === BUNDLED_FIXTURE_MANIFEST_SHA256
        && fixtureStartup.expected_manifest_sha256 === fixtureStartup.observed_manifest_sha256
        && fixtureStartup.manifest_version === 1
        && Number.isSafeInteger(fixtureStartup.fixture_count) && Number(fixtureStartup.fixture_count) > 0 && fixtureStartup.immutable_files_verified === true && fixtureStartup.raw_audio_public_surface === false;
      harness.push(check("s02.public_and_startup_surface_split", "harness", exactSurface, surface, "public_fixture_or_immutable_startup_audio_surface_receipt_unavailable"));
      const boundary = byKind("security.mcp_boundary_probe").sort((left, right) => left.seq - right.seq);
      const probeIds = boundary.map((event) => event.payload.probe_id_sha256);
      const requestBodies = boundary.map((event) => (event.payload.request as Record<string, unknown> | undefined)?.raw_body_sha256);
      const auditRequestIds = boundary.map((event) => ((event.payload.audit_receipts as Array<Record<string, unknown>> | undefined)?.[0])?.request_id_sha256);
      const boundaryRejected = boundary.length === S02_HTTP_VARIANTS.length
        && boundary.every((event, index) => event.payload.variant === S02_HTTP_VARIANTS[index] && isExactS02McpBoundaryProbe(event, index === 0 ? null : boundary[index - 1]!))
        && new Set(probeIds).size === S02_HTTP_VARIANTS.length
        && new Set(requestBodies).size === S02_HTTP_VARIANTS.length
        && new Set(auditRequestIds).size === S02_HTTP_VARIANTS.length;
      harness.push(check("s02.deployed_authenticated_mcp_boundary", "harness", boundaryRejected, boundary, "public_mcp_transport_parser_auth_schema_and_audit_rejections_unavailable"));
      const zero = eligible.filter((event) => event.kind.startsWith("cleanup.") || event.kind === "security.pre_resource_allocation_fence");
      const fence = byKind("security.pre_resource_allocation_fence");
      const noAllocation = fence.length === 1 && fence[0]!.payload.active_run_count_unchanged === true && fence[0]!.payload.browser_context_absent === true && fence[0]!.payload.browser_lease_absent === true && fence[0]!.payload.provider_session_absent === true && fence[0]!.payload.tts_process_invocations === 0;
      harness.push(check("s02.no_resource_or_orphan", "harness", noAllocation && authoritativeLiveCleanupComplete(eligible) && byKind("cleanup.browser_context_absent").length === 1, zero, "authoritative_zero_resource_recovery_unavailable"));
      product.push(unavailable("s02.no_user_facing_impact", "product", "not_applicable_pre_resource_rejection"));
      break;
    }
    case "V-D02": {
      const reader = byKind("durability.independent_ledger_reader");
      harness.push(check("d02.independent_ledger_reader_precondition", "harness", reader.length === 1 && reader[0]!.payload.exact_test_run === true && reader[0]!.payload.mutation_count === 0, reader, "independent_durable_reader_unavailable"));
      const api = externalAttestations("d02_api_process_restart").filter((event) => {
        const proof = event.payload.evidence as Record<string, unknown> | undefined;
        const continuity = D02BrowserContinuityProofSchema.safeParse(proof?.browser_continuity_proof);
        const operation = operations.find((candidate) => candidate.id === proof?.operation_id);
        const replay = operation && byKind(`operation.${operation.type}.idempotent_replay`).some((candidate) => candidate.payload.operation_id === operation.id && candidate.payload.exact_request_hash_replay === true && candidate.payload.no_new_operation === true);
        const command = externalAttestations("d02_restart_command").find((candidate) => {
          const commandProof = candidate.payload.evidence as Record<string, unknown> | undefined;
          return typeof commandProof?.restart_request_id === "string" && sha256(commandProof.restart_request_id) === proof?.restart_request_id_sha256
            && commandProof.operation_id === proof?.operation_id && commandProof.requested_at === proof?.restart_requested_at && candidate.seq < event.seq;
        });
        return proof?.authority === "deployment_control" && command !== undefined && operation !== undefined && replay === true && continuity.success
          && continuity.data.run_id_sha256 === sha256(run.id) && continuity.data.operation_id_sha256 === sha256(operation.id)
          && continuity.data.restart_request_id_sha256 === proof.restart_request_id_sha256 && continuity.data.after_boot_id_sha256 === proof.after_boot_id_sha256
          && continuity.data.browser_worker_id_sha256 === proof.browser_worker_id_sha256 && continuity.data.browser_lease_epoch === proof.browser_lease_epoch
          && proof.request_sha256 === operation.requestHash && proof.idempotency_key_sha256 === sha256(operation.idempotencyKey)
          && proof.before_boot_id_sha256 !== proof.after_boot_id_sha256 && proof.original_receipt_sha256 === proof.replay_receipt_sha256
          && typeof proof.provider_restart_request_sha256 === "string" && /^[a-f0-9]{64}$/.test(proof.provider_restart_request_sha256)
          && typeof proof.provider_restart_accepted_response_sha256 === "string" && /^[a-f0-9]{64}$/.test(proof.provider_restart_accepted_response_sha256)
          && typeof proof.local_controller_receipt_sha256 === "string" && /^[a-f0-9]{64}$/.test(proof.local_controller_receipt_sha256)
          && proof.browser_worker_continuity === true && proof.duplicate_injection_count === 0;
      });
      const workerLossClaims = externalAttestations("d02_browser_worker_loss");
      const workerLoss = workerLossClaims.filter((event) => {
        const proof = event.payload.evidence as Record<string, unknown> | undefined;
        const command = externalAttestations("d02_browser_worker_termination_command").find((candidate) => {
          const commandProof = candidate.payload.evidence as Record<string, unknown> | undefined;
          return typeof commandProof?.termination_request_id === "string" && sha256(commandProof.termination_request_id) === proof?.termination_request_id_sha256
            && commandProof.run_id_sha256 === proof?.run_id_sha256 && commandProof.cleanup_obligation_id_sha256 === proof.cleanup_obligation_id_sha256
            && commandProof.worker_service_id_sha256 === proof.worker_service_id_sha256 && commandProof.provider_session_id_sha256 === proof.provider_session_id_sha256
            && commandProof.provider_admission_id_sha256 === proof.provider_admission_id_sha256 && commandProof.provider_connection_epoch === proof.provider_connection_epoch
            && canonicalRequestHash(commandProof.frozen_provider_connection_epochs) === canonicalRequestHash(proof.frozen_provider_connection_epochs)
            && commandProof.browser_context_id_sha256 === proof.browser_context_id_sha256 && commandProof.browser_worker_id_sha256 === proof.lost_worker_id_sha256
            && commandProof.browser_lease_epoch === proof.lost_browser_lease_epoch && commandProof.before_worker_deploy_id_sha256 === proof.before_deploy_id_sha256
            && commandProof.before_worker_instance_set_sha256 === proof.before_instance_set_sha256
            && commandProof.before_worker_owner_instance_id_sha256 === proof.lost_worker_owner_instance_id_sha256
            && commandProof.before_worker_owner_membership_count === 1 && proof.lost_worker_owner_instance_id_sha256 === proof.lost_worker_id_sha256
            && proof.lost_worker_present_before_restart === true && proof.lost_worker_absent_after_restart === true
            && commandProof.render_action_request_sha256 === proof.render_action_request_sha256
            && commandProof.requested_at === proof.command_requested_at && candidate.seq < event.seq;
        });
        const loss = byKind("durability.browser_worker_loss_observed").find((candidate) => candidate.seq === proof?.loss_event_seq
          && candidate.payload.lost_worker_id_sha256 === proof?.lost_worker_id_sha256 && candidate.payload.replacement_worker_id_sha256 === proof.replacement_worker_id_sha256
          && candidate.payload.lost_browser_lease_epoch === proof.lost_browser_lease_epoch && candidate.payload.loss_observed_at === proof.loss_observed_at);
        const dispatch = byKind("product.d02_render_worker_dispatch_claimed").find((candidate) => candidate.source === "canonical"
          && candidate.payload.termination_request_id_sha256 === proof?.termination_request_id_sha256
          && candidate.payload.dispatch_claim_sha256 === proof?.render_dispatch_claim_sha256
          && candidate.payload.command_attestation_id_sha256 === sha256(String(command?.payload.attestation_id))
          && candidate.payload.command_content_sha256 === command?.payload.content_sha256 && candidate.payload.command_event_seq === command?.seq
          && candidate.payload.worker_service_id_sha256 === proof?.worker_service_id_sha256
          && candidate.payload.action_request_sha256 === proof?.render_action_request_sha256
          && candidate.payload.requested_at === proof?.action_requested_at
          && candidate.payload.raw_action_and_attempt_identifiers_excluded === true
          && candidate.payload.dispatch_claim_sha256 === canonicalRequestHash(Object.fromEntries(Object.entries(candidate.payload).filter(([key]) => key !== "dispatch_claim_sha256"))));
        const shutdown = byKind("durability.browser_worker_shutdown_observed").find((candidate) => candidate.source === "worker" && hasExactKeys(candidate.payload, [
          "schema", "termination_request_id_sha256", "voice_lab_run_id_sha256", "cleanup_obligation_id_sha256",
          "lost_browser_worker_id_sha256", "lost_browser_lease_epoch", "browser_context_id_sha256", "provider_session_id_sha256",
          "provider_admission_id_sha256", "provider_connection_epoch", "frozen_provider_connection_epochs", "render_action_request_sha256",
          "gateway_freeze_request_sha256", "gateway_freeze_event_seq", "command_event_seq", "render_dispatch_claim_sha256",
          "render_dispatch_claim_event_seq", "product_provider_cleanup_acknowledged", "product_provider_cleanup_settlement_sha256",
          "product_provider_close_receipt_count", "product_provider_activation_abort_receipt_count", "product_provider_cleanup_epoch_union_matches_freeze",
          "browser_context_closed", "source", "raw_run_worker_lease_context_and_product_identifiers_excluded",
          "observed_at",
        ]) && candidate.payload.schema === "sophia_voice_lab_d02_browser_worker_shutdown_observation_v1"
          && candidate.payload.termination_request_id_sha256 === proof?.termination_request_id_sha256
          && candidate.payload.voice_lab_run_id_sha256 === proof?.run_id_sha256
          && candidate.payload.cleanup_obligation_id_sha256 === proof?.cleanup_obligation_id_sha256
          && candidate.payload.lost_browser_worker_id_sha256 === proof?.lost_worker_id_sha256
          && candidate.payload.lost_browser_lease_epoch === proof?.lost_browser_lease_epoch
          && candidate.payload.browser_context_id_sha256 === proof?.browser_context_id_sha256
          && candidate.payload.provider_session_id_sha256 === proof?.provider_session_id_sha256
          && candidate.payload.provider_admission_id_sha256 === proof?.provider_admission_id_sha256
          && candidate.payload.provider_connection_epoch === proof?.provider_connection_epoch
          && canonicalRequestHash(candidate.payload.frozen_provider_connection_epochs) === canonicalRequestHash(proof?.frozen_provider_connection_epochs)
          && candidate.payload.render_action_request_sha256 === proof?.render_action_request_sha256
          && candidate.payload.command_event_seq === command?.seq && candidate.payload.render_dispatch_claim_event_seq === dispatch?.seq
          && candidate.payload.render_dispatch_claim_sha256 === proof?.render_dispatch_claim_sha256
          && candidate.payload.product_provider_cleanup_acknowledged === true
          && isSha256(candidate.payload.product_provider_cleanup_settlement_sha256)
          && Number.isSafeInteger(candidate.payload.product_provider_close_receipt_count) && Number(candidate.payload.product_provider_close_receipt_count) >= 0
          && Number.isSafeInteger(candidate.payload.product_provider_activation_abort_receipt_count) && Number(candidate.payload.product_provider_activation_abort_receipt_count) >= 0
          && Array.isArray(candidate.payload.frozen_provider_connection_epochs)
          && Number(candidate.payload.product_provider_close_receipt_count) + Number(candidate.payload.product_provider_activation_abort_receipt_count) === (candidate.payload.frozen_provider_connection_epochs as unknown[]).length
          && candidate.payload.product_provider_cleanup_epoch_union_matches_freeze === true
          && candidate.payload.browser_context_closed === true && candidate.payload.source === "worker_graceful_d02_restart"
          && candidate.payload.raw_run_worker_lease_context_and_product_identifiers_excluded === true
          && isCanonicalTimestamp(candidate.payload.observed_at) && candidate.at.toISOString() === candidate.payload.observed_at);
        const gatewayFreeze = shutdown ? byKind("product.d02_gateway_browser_worker_termination_frozen").find((candidate) => candidate.source === "canonical"
          && candidate.seq === shutdown.payload.gateway_freeze_event_seq
          && candidate.payload.schema === "sophia_voice_lab_d02_gateway_freeze_event_v1"
          && candidate.payload.termination_request_id_sha256 === proof?.termination_request_id_sha256
          && candidate.payload.freeze_request_sha256 === shutdown.payload.gateway_freeze_request_sha256
          && candidate.payload.browser_worker_id_sha256 === proof?.lost_worker_id_sha256
          && candidate.payload.browser_lease_epoch === proof?.lost_browser_lease_epoch
          && candidate.payload.browser_context_id_sha256 === proof?.browser_context_id_sha256
          && candidate.payload.render_action_request_sha256 === proof?.render_action_request_sha256
          && candidate.payload.gateway_frozen === true) : undefined;
        const exactLoss = loss?.source === "worker" && hasExactKeys(loss.payload, [
          "schema", "termination_request_id_sha256", "lost_worker_id_sha256", "replacement_worker_id_sha256",
          "lost_browser_lease_epoch", "browser_context_id_sha256", "old_worker_shutdown_event_seq", "render_dispatch_claim_sha256",
          "render_dispatch_claim_event_seq", "lease_expired_at", "loss_observed_at", "loss_source", "raw_worker_identifiers_excluded",
        ]) && loss.payload.schema === "sophia_voice_lab_d02_browser_worker_loss_cross_join_v1"
          && loss.payload.termination_request_id_sha256 === proof?.termination_request_id_sha256
          && loss.payload.browser_context_id_sha256 === proof?.browser_context_id_sha256
          && loss.payload.old_worker_shutdown_event_seq === shutdown?.seq
          && loss.payload.render_dispatch_claim_sha256 === proof?.render_dispatch_claim_sha256
          && loss.payload.render_dispatch_claim_event_seq === dispatch?.seq
          && loss.payload.lease_expired_at === null && loss.payload.loss_source === "worker_graceful_d02_restart_cross_join"
          && loss.payload.raw_worker_identifiers_excluded === true && isCanonicalTimestamp(loss.payload.loss_observed_at)
          && loss.at.toISOString() === loss.payload.loss_observed_at;
        const replacement = loss && shutdown ? byKind("durability.browser_worker_replacement_observed").find((candidate) => candidate.source === "worker" && hasExactKeys(candidate.payload, [
          "schema", "termination_request_id_sha256", "lost_browser_worker_id_sha256", "replacement_browser_worker_id_sha256",
          "lost_browser_lease_epoch", "browser_context_id_sha256", "old_worker_shutdown_event_seq", "loss_event_seq",
          "render_dispatch_claim_sha256", "source", "raw_worker_identifiers_excluded",
        ]) && candidate.payload.schema === "sophia_voice_lab_d02_browser_worker_replacement_observation_v1"
          && candidate.payload.termination_request_id_sha256 === proof?.termination_request_id_sha256
          && candidate.payload.lost_browser_worker_id_sha256 === proof?.lost_worker_id_sha256
          && candidate.payload.replacement_browser_worker_id_sha256 === proof?.replacement_worker_id_sha256
          && candidate.payload.lost_browser_lease_epoch === proof?.lost_browser_lease_epoch
          && candidate.payload.browser_context_id_sha256 === proof?.browser_context_id_sha256
          && candidate.payload.old_worker_shutdown_event_seq === shutdown.seq && candidate.payload.loss_event_seq === loss.seq
          && candidate.payload.render_dispatch_claim_sha256 === proof?.render_dispatch_claim_sha256
          && candidate.payload.source === "replacement_worker_startup_after_graceful_d02_restart"
          && candidate.payload.raw_worker_identifiers_excluded === true) : undefined;
        return proof?.authority === "deployment_control" && command !== undefined && dispatch !== undefined && gatewayFreeze !== undefined
          && shutdown !== undefined && exactLoss === true && loss !== undefined && replacement !== undefined
          && byKind("durability.browser_worker_shutdown_observed").length === 1
          && byKind("durability.browser_worker_loss_observed").length === 1
          && byKind("durability.browser_worker_replacement_observed").length === 1
          && gatewayFreeze.seq < command.seq && command.seq < dispatch.seq && dispatch.seq < shutdown.seq && shutdown.seq < loss.seq && loss.seq < replacement.seq && replacement.seq < event.seq
          && proof.run_id_sha256 === sha256(run.id) && proof.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
          && proof.lost_worker_id_sha256 !== proof.replacement_worker_id_sha256 && proof.action_kind === "render_worker_service_restart"
          && proof.restart_http_status === 200 && proof.old_worker_instances_absent === true && proof.replacement_worker_instances_observed === true
          && proof.lost_worker_owner_instance_id_sha256 === proof.lost_worker_id_sha256 && proof.lost_worker_present_before_restart === true && proof.lost_worker_absent_after_restart === true
          && proof.before_instance_set_sha256 !== proof.after_instance_set_sha256
          && typeof proof.render_action_request_sha256 === "string" && typeof proof.render_action_accepted_response_sha256 === "string" && typeof proof.render_action_settled_snapshot_sha256 === "string"
          && proof.gateway_settlement_receipt_included === false && run.state === "aborted_driver_restart" && run.terminalError?.code === "BROWSER_SESSION_LOST";
      });
      const gatewaySettlementEvents = byKind("product.d02_gateway_browser_worker_termination_settled").filter((event) => event.source === "canonical");
      const exactGatewaySettlements = gatewaySettlementEvents.filter((event) => {
        if (workerLoss.length !== 1 || !hasExactKeys(event.payload, ["schema", "termination_request_id_sha256", "settlement_request_sha256", "gateway_receipt_sha256", "gateway_receipt", "source", "raw_product_identifiers_excluded"])
          || event.payload.schema !== "sophia_voice_lab_d02_gateway_settlement_event_v1" || event.payload.source !== "gateway_ed25519_settlement_receipt"
          || event.payload.raw_product_identifiers_excluded !== true) return false;
        const proof = workerLoss[0]!.payload.evidence as Record<string, unknown> | undefined;
        const commandEvent = externalAttestations("d02_browser_worker_termination_command").find((candidate) => {
          const command = candidate.payload.evidence as Record<string, unknown> | undefined;
          return typeof command?.termination_request_id === "string" && sha256(command.termination_request_id) === proof?.termination_request_id_sha256;
        });
        const command = commandEvent?.payload.evidence as Record<string, unknown> | undefined;
        const dispatchClaim = byKind("product.d02_render_worker_dispatch_claimed").find((candidate) => candidate.source === "canonical"
          && candidate.payload.termination_request_id_sha256 === proof?.termination_request_id_sha256
          && candidate.payload.dispatch_claim_sha256 === proof?.render_dispatch_claim_sha256);
        const shutdownEvents = byKind("durability.browser_worker_shutdown_observed");
        const strictShutdown = shutdownEvents.length === 1 ? shutdownEvents[0] : undefined;
        const receiptResult = D02GatewaySettlementReceiptSchema.safeParse(event.payload.gateway_receipt);
        if (!proof || !commandEvent || !command || !dispatchClaim || !strictShutdown || !receiptResult.success || run.providerSessionId === null) return false;
        const receipt = receiptResult.data;
        const settlementRequest = {
          schema: "sophia_voice_lab_gateway_browser_worker_termination_settlement_request_v1",
          termination_request_id: command.termination_request_id,
          voice_lab_run_id_sha256: proof.run_id_sha256,
          test_run_id: run.testRunId,
          cleanup_obligation_id: run.cleanupObligationId,
          provider_session_id: run.providerSessionId,
          provider_admission_id_sha256: proof.provider_admission_id_sha256,
          provider_connection_epoch: proof.provider_connection_epoch,
          frozen_provider_connection_epochs: proof.frozen_provider_connection_epochs,
          browser_worker_id_sha256: proof.lost_worker_id_sha256,
          browser_lease_epoch: proof.lost_browser_lease_epoch,
          browser_context_id_sha256: proof.browser_context_id_sha256,
          render_action_request_sha256: proof.render_action_request_sha256,
          render_action_accepted_response_sha256: proof.render_action_accepted_response_sha256,
          render_action_settled_snapshot_sha256: proof.render_action_settled_snapshot_sha256,
          loss_event_seq: proof.loss_event_seq,
          loss_observed_at: proof.loss_observed_at,
        };
        const lossObserved = byKind("durability.browser_worker_loss_observed").find((candidate) => candidate.seq === proof.loss_event_seq);
        return event.payload.termination_request_id_sha256 === proof.termination_request_id_sha256
          && event.payload.settlement_request_sha256 === canonicalRequestHash(settlementRequest)
          && event.payload.gateway_receipt_sha256 === canonicalRequestHash(receipt)
          && commandEvent.seq < dispatchClaim.seq && dispatchClaim.seq < (lossObserved?.seq ?? 0) && (lossObserved?.seq ?? Number.MAX_SAFE_INTEGER) < event.seq && event.seq < workerLoss[0]!.seq
          && receipt.termination_request_id_sha256 === proof.termination_request_id_sha256
          && receipt.voice_lab_run_id_sha256 === sha256(run.id) && receipt.test_run_id_sha256 === sha256(run.testRunId)
          && receipt.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
          && receipt.scenario_id === run.scenarioId && receipt.scenario_version === run.scenarioVersion && receipt.environment === run.environment
          && canonicalRequestHash(receipt.expected_deployment) === canonicalRequestHash(run.target.expectedDeployment)
          && receipt.provider_session_id_sha256 === proof.provider_session_id_sha256 && receipt.provider_admission_id_sha256 === proof.provider_admission_id_sha256
          && receipt.provider_connection_epoch === proof.provider_connection_epoch
          && canonicalRequestHash(receipt.frozen_provider_connection_epochs) === canonicalRequestHash(proof.frozen_provider_connection_epochs)
          && receipt.browser_worker_id_sha256 === proof.lost_worker_id_sha256 && receipt.browser_lease_epoch === proof.lost_browser_lease_epoch
          && receipt.browser_context_id_sha256 === proof.browser_context_id_sha256
          && receipt.render_action_request_sha256 === proof.render_action_request_sha256
          && receipt.render_action_accepted_response_sha256 === proof.render_action_accepted_response_sha256
          && receipt.render_action_settled_snapshot_sha256 === proof.render_action_settled_snapshot_sha256
          && receipt.loss_event_seq === proof.loss_event_seq && receipt.loss_observed_at === proof.loss_observed_at
          && receipt.provider_settlement_sha256 === strictShutdown.payload.product_provider_cleanup_settlement_sha256
          && new Date(receipt.database_observed_at).getTime() >= new Date(String(proof.loss_observed_at)).getTime()
          && receipt.cleanup_obligation_state === "closed" && receipt.canonical_provider_state === "closed" && receipt.canonical_pending_epoch === null
          && receipt.all_frozen_provider_epochs_terminal === true && receipt.provider_admission_absent === true
          && receipt.voice_provider_session_absent === true && receipt.gateway_browser_relay_absent === true;
      });
      const productPreconditions = byKind("product.d02_api_process_restart_precondition").filter((event) => event.source === "canonical");
      const productContinuities = byKind("product.d02_api_process_restart_continuity").filter((event) => event.source === "canonical");
      const exactProductContinuities = productContinuities.filter((continuityEvent) => {
        if (api.length !== 1 || productPreconditions.length !== 1
          || !hasExactKeys(productPreconditions[0]!.payload, ["schema", "phase", "restart_request_id_sha256", "observation_request_sha256", "observation_receipt_sha256", "gateway_receipt", "source", "raw_product_identifiers_excluded"])
          || !hasExactKeys(continuityEvent.payload, ["schema", "phase", "restart_request_id_sha256", "observation_request_sha256", "observation_receipt_sha256", "prior_observation_receipt_sha256", "gateway_receipt", "source", "raw_product_identifiers_excluded"])) return false;
        const precondition = productPreconditions[0]!;
        const finalEvent = api[0]!;
        const proof = finalEvent.payload.evidence as Record<string, unknown> | undefined;
        const commandEvent = externalAttestations("d02_restart_command").find((candidate) => {
          const command = candidate.payload.evidence as Record<string, unknown> | undefined;
          return typeof command?.restart_request_id === "string" && sha256(command.restart_request_id) === proof?.restart_request_id_sha256;
        });
        const operation = operations.find((candidate) => candidate.id === proof?.operation_id);
        const replay = operation && byKind(`operation.${operation.type}.idempotent_replay`).find((candidate) => candidate.payload.operation_id === operation.id
          && candidate.payload.exact_request_hash_replay === true && candidate.payload.no_new_operation === true);
        const command = commandEvent?.payload.evidence as Record<string, unknown> | undefined;
        const beforeResult = D02GatewayContinuityObservationReceiptSchema.safeParse(precondition.payload.gateway_receipt);
        const afterResult = D02GatewayContinuityObservationReceiptSchema.safeParse(continuityEvent.payload.gateway_receipt);
        if (!proof || !commandEvent || !command || !operation || !replay || !beforeResult.success || !afterResult.success
          || run.canonicalSessionId === null || run.threadId === null || run.providerSessionId === null || run.providerEpoch === null
          || typeof command.restart_request_id !== "string" || typeof command.requested_at !== "string" || typeof command.provider_restart_request_sha256 !== "string") return false;
        const before = beforeResult.data;
        const after = afterResult.data;
        const beforeUnsigned: Record<string, unknown> = { ...before };
        delete beforeUnsigned.signature;
        const beforeCore = { ...beforeUnsigned };
        delete beforeCore.receipt_sha256;
        const afterUnsigned: Record<string, unknown> = { ...after };
        delete afterUnsigned.signature;
        const afterCore = { ...afterUnsigned };
        delete afterCore.receipt_sha256;
        const beforeRequest = {
          schema: "sophia_voice_lab_d02_product_continuity_observation_request_v1",
          restart_request_id: command.restart_request_id,
          cleanup_obligation_id: run.cleanupObligationId,
          phase: "before_api_restart",
          product_service_boot_id_sha256: proof.before_boot_id_sha256,
          render_action_request_sha256: proof.provider_restart_request_sha256,
          prior_observation_receipt_sha256: null,
          observed_at: command.requested_at,
        };
        const afterRequest = {
          ...beforeRequest,
          phase: "after_api_restart",
          product_service_boot_id_sha256: proof.after_boot_id_sha256,
          prior_observation_receipt_sha256: before.receipt_sha256,
          observed_at: proof.replay_observed_at,
        };
        const projection = before.continuity_projection;
        const exactProjection = canonicalRequestHash(projection) === canonicalRequestHash(after.continuity_projection)
          && projection.voice_lab_run_id_sha256 === sha256(run.id) && projection.test_run_id_sha256 === sha256(run.testRunId)
          && projection.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
          && projection.session_id_sha256 === sha256(run.canonicalSessionId) && projection.thread_id_sha256 === sha256(run.threadId)
          && projection.provider_session_id_sha256 === sha256(run.providerSessionId) && projection.provider_connection_epoch === run.providerEpoch
          && projection.browser_worker_id_sha256 === proof.browser_worker_id_sha256 && projection.browser_lease_epoch === proof.browser_lease_epoch
          && canonicalRequestHash(projection.expected_deployment) === canonicalRequestHash(run.target.expectedDeployment);
        return exactProjection
          && precondition.payload.schema === "sophia_voice_lab_d02_product_continuity_event_v1" && continuityEvent.payload.schema === "sophia_voice_lab_d02_product_continuity_event_v1"
          && precondition.payload.phase === "before_api_restart" && continuityEvent.payload.phase === "after_api_restart"
          && precondition.payload.restart_request_id_sha256 === proof.restart_request_id_sha256 && continuityEvent.payload.restart_request_id_sha256 === proof.restart_request_id_sha256
          && precondition.payload.observation_request_sha256 === canonicalRequestHash(beforeRequest) && continuityEvent.payload.observation_request_sha256 === canonicalRequestHash(afterRequest)
          && precondition.payload.observation_receipt_sha256 === before.receipt_sha256 && continuityEvent.payload.observation_receipt_sha256 === after.receipt_sha256
          && continuityEvent.payload.prior_observation_receipt_sha256 === before.receipt_sha256
          && precondition.payload.source === "gateway_ed25519_locked_product_continuity" && continuityEvent.payload.source === "gateway_ed25519_locked_product_continuity"
          && precondition.payload.raw_product_identifiers_excluded === true && continuityEvent.payload.raw_product_identifiers_excluded === true
          && before.receipt_sha256 === canonicalRequestHash(beforeCore) && after.receipt_sha256 === canonicalRequestHash(afterCore)
          && before.restart_request_id_sha256 === proof.restart_request_id_sha256 && after.restart_request_id_sha256 === proof.restart_request_id_sha256
          && before.request_sha256 === canonicalRequestHash(beforeRequest) && after.request_sha256 === canonicalRequestHash(afterRequest)
          && before.product_service_boot_id_sha256 === proof.before_boot_id_sha256 && after.product_service_boot_id_sha256 === proof.after_boot_id_sha256
          && before.render_action_request_sha256 === proof.provider_restart_request_sha256 && after.render_action_request_sha256 === proof.provider_restart_request_sha256
          && before.prior_observation_receipt_sha256 === null && after.prior_observation_receipt_sha256 === before.receipt_sha256
          && command.provider_restart_request_sha256 === proof.provider_restart_request_sha256
          && precondition.seq < commandEvent.seq && commandEvent.seq < replay.seq && replay.seq < continuityEvent.seq && continuityEvent.seq < finalEvent.seq;
      });
      harness.push(api.length === 0 ? unavailable("d02.mcp_api_process_restart_and_reattach", "harness", "privileged_deployment_restart_attestation_not_attached") : check("d02.mcp_api_process_restart_and_reattach", "harness", api.length === 1, api, "api_restart_attestation_conflicted_or_failed_cross_join"));
      harness.push(workerLossClaims.length === 0
        ? unavailable("d02.browser_worker_termination_action", "harness", "privileged_browser_worker_termination_attestation_not_attached")
        : check("d02.browser_worker_termination_action", "harness", workerLoss.length === 1, workerLossClaims, "browser_worker_termination_action_conflicted_or_failed_cross_join"));
      harness.push(workerLoss.length === 1
        ? gatewaySettlementEvents.length === 0
          ? unavailable("d02.browser_worker_loss_abort_recovery", "harness", "gateway_browser_worker_termination_settlement_receipt_not_attached")
          : check("d02.browser_worker_loss_abort_recovery", "harness", exactGatewaySettlements.length === 1, [...workerLoss, ...gatewaySettlementEvents], "gateway_browser_worker_termination_settlement_receipt_not_attached", "gateway_browser_worker_termination_settlement_conflicted_or_failed_cross_join")
        : workerLossClaims.length === 0
          ? unavailable("d02.browser_worker_loss_abort_recovery", "harness", "privileged_browser_worker_termination_attestation_not_attached")
          : fail("d02.browser_worker_loss_abort_recovery", "harness", workerLossClaims, "browser_worker_termination_action_conflicted_or_failed_cross_join"));
      product.push(api.length === 0 || (productPreconditions.length === 0 && productContinuities.length === 0)
        ? unavailable("d02.product_gate", "product", "exact_product_session_thread_provider_continuity_receipt_not_attached")
        : check("d02.product_gate", "product", exactProductContinuities.length === 1, [...productPreconditions, ...productContinuities, ...api], "exact_product_session_thread_provider_continuity_receipt_not_attached", "product_session_thread_provider_continuity_receipt_conflicted_or_failed_cross_join"));
      break;
    }
    case "V-F02":
      harness.push(unavailable("v-f02.governed_product_clock", "harness", "governed_product_clock_not_available"));
      product.push(unavailable("v-f02.product_gate", "product", "scenario_not_executed"));
      break;
    default:
      harness.push(unavailable("scenario.catalog_binding", "harness", "scenario_not_declared"));
      product.push(unavailable("scenario.product_gate", "product", "scenario_not_declared"));
  }
  const passed = harness.length > 0 && harness.every((assertion) => assertion.status === "pass");
  return { scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, harness, product, summary: passed ? `All ${harness.length} machine harness assertions passed.` : `Harness certification withheld: ${harness.filter((assertion) => assertion.status !== "pass").map((assertion) => `${assertion.id}=${assertion.status}`).join(", ")}.` };
}

export function deriveTaskCleanup(events: import("./domain.js").LabEvent[], run?: RunRecord): { observed_count: number; unresolved_count: number; proof: string; tasks: Array<{ task_id_hash: string; terminal: boolean; state: string | null }> } {
  const authoritativeZero = authoritativeLiveCleanupComplete(events);
  const latest = new Map<string, string | null>();
  for (const event of events) {
    if (event.source === "product" && (!run || !isExactBoundProductEvent(run, event))) continue;
    if (!(event.kind === "builder.task_state" || event.kind.endsWith(".sophia.builder_task"))) continue;
    const taskId = findString(event.payload, ["taskId", "task_id"]);
    if (!taskId) continue;
    const state = findString(event.payload, ["phase", "status", "state"]);
    latest.set(taskId, state);
  }
  const terminalStates = new Set(["completed", "complete", "cancelled", "canceled", "failed", "settled", "done", "terminal"]);
  const tasks = [...latest.entries()].map(([taskId, state]) => ({ task_id_hash: sha256(taskId), terminal: authoritativeZero || (state !== null && terminalStates.has(state.toLowerCase())), state }));
  const unresolved = tasks.filter((task) => !task.terminal).length;
  return { observed_count: tasks.length, unresolved_count: authoritativeZero ? 0 : Math.max(1, unresolved), proof: authoritativeZero ? "gateway_authoritative_post_delete_zero" : "authoritative_task_discovery_or_zero_unconfirmed", tasks };
}

function authoritativeLiveCleanupComplete(events: Array<{ kind: string; payload: Record<string, unknown> }>): boolean {
  return events.some((event) => {
    if (event.kind !== "cleanup.recovery" || event.payload.complete !== true) return false;
    const receipt = event.payload.receipt as Record<string, unknown> | undefined;
    const components = receipt?.components as Record<string, unknown> | undefined;
    const builder = components?.builder as Record<string, unknown> | undefined;
    const builderReceipt = builder?.receipt && typeof builder.receipt === "object" ? builder.receipt as Record<string, unknown> : {};
    return receipt?.complete === true && receipt?.live_cleanup_complete === true && receipt?.live_resources_zero === true && builder?.status === "completed" && (builder?.cleanup_complete ?? builderReceipt.cleanup_complete) === true && (builder?.discovery_complete ?? builderReceipt.discovery_complete) === true && (builder?.authoritative_zero_tasks ?? builderReceipt.authoritative_zero_tasks) === true && Number.isInteger(builder?.discovered_task_count ?? builderReceipt.discovered_task_count) && Number(builder?.discovered_task_count ?? builderReceipt.discovered_task_count) >= 0;
  });
}

function authoritativeRetentionPurged(events: Array<{ kind: string; payload: Record<string, unknown> }>): boolean {
  return events.some((event) => {
    if (event.kind !== "cleanup.recovery" || event.payload.retention_purged !== true) return false;
    const receipt = event.payload.receipt as Record<string, unknown> | undefined;
    return receipt?.retention_purged === true && receipt?.retention_purge_pending === false && receipt?.retention_maintenance_complete === true && receipt?.live_resources_zero === true;
  });
}

function retentionPatchFromEvents(events: Array<{ kind: string; payload: Record<string, unknown> }>): Partial<Pick<import("./ledger.js").RunPatch, "retentionPurgeDueAt" | "retentionPurgePending" | "retentionPurgeVerifiedAt">> {
  const latest = [...events].reverse().find((event) => event.kind === "cleanup.recovery" && event.payload.complete === true);
  if (!latest) return {};
  if (latest.payload.retention_purged === true) return { retentionPurgePending: false, retentionPurgeVerifiedAt: new Date() };
  const raw = latest.payload.retention_purge_due_at;
  if (latest.payload.retention_purge_pending !== true || typeof raw !== "string") return {};
  const due = new Date(raw);
  if (Number.isNaN(due.getTime()) || due.toISOString() !== raw) throw new VoiceLabError(labError("RETENTION_RECEIPT_INVALID", "Gateway retention receipt did not contain a canonical ISO purge deadline.", "evidence", false));
  return { retentionPurgeDueAt: due, retentionPurgePending: true, retentionPurgeVerifiedAt: null };
}

export function deriveFailureVerdicts(run: RunRecord, state: RunState, cleanupEvents: Array<{ kind: string; payload: Record<string, unknown> }>): Verdicts {
  const cleanupConfirmed = cleanupEvents.some(authCleanupConfirmed);
  return {
    harness: state === "product_failed" || state === "inconclusive_provider" ? (run.verdicts.harness === "pending" ? "inconclusive" : run.verdicts.harness) : "fail",
    product: state === "product_failed" ? "fail" : run.verdicts.product === "pending" ? "inconclusive" : run.verdicts.product,
    provider: state === "inconclusive_provider" ? "inconclusive" : run.verdicts.provider === "pending" ? "unavailable" : run.verdicts.provider,
    auth: state === "authorization_failed" ? "fail" : cleanupConfirmed ? "pass" : run.verdicts.auth === "pending" ? "unavailable" : run.verdicts.auth,
    evidence: "unavailable",
  };
}

function authCleanupConfirmed(event: { kind: string; payload: Record<string, unknown> }): boolean {
  if (event.kind !== "auth.session_cleanup") return false;
  if (event.payload.session_revoked === true && event.payload.cookies_cleared === true) return true;
  const receipt = event.payload.receipt as Record<string, unknown> | undefined;
  return event.payload.confirmed === true && receipt?.session_revoked === true && receipt?.cookies_cleared === true;
}

function exactString(value: unknown): string | null { return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null; }
export function isExactBoundProductEvent(run: RunRecord, event: Pick<import("./domain.js").LabEvent, "source" | "payload">): boolean {
  if (event.source !== "product") return false;
  const binding = event.payload._product_run_binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const record = binding as Record<string, unknown>;
  return record.app_authenticated === true
    && record.synthetic === true
    && record.test_run_id_sha256 === sha256(run.testRunId)
    && record.principal_id_sha256 === sha256(run.principalId)
    && record.environment === run.environment
    && record.scenario_id === run.scenarioId
    && record.scenario_version === run.scenarioVersion
    && record.retention_hours === run.capturePolicy.retentionHours
    && record.provider_expires_at === run.expiresAt.toISOString()
    && record.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId);
}
function strictProductRunBinding(source: string, payload: Record<string, unknown>, expected: RunRecord): Record<string, unknown> | null {
  if (source !== "product") return null;
  const binding = payload._app_synthetic_binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const record = binding as Record<string, unknown>;
  const matches = record.app_authenticated === true
    && record.synthetic === true
    && record.test_run_id_sha256 === sha256(expected.testRunId)
    && record.principal_id_sha256 === sha256(expected.principalId)
    && record.environment === expected.environment
    && record.scenario_id === expected.scenarioId
    && record.scenario_version === expected.scenarioVersion
    && record.retention_hours === expected.capturePolicy.retentionHours
    && record.provider_expires_at === expected.expiresAt.toISOString()
    && record.cleanup_obligation_id_sha256 === sha256(expected.cleanupObligationId);
  if (!matches) throw new VoiceLabError(labError("PRODUCT_RUN_BINDING_MISMATCH", "Product capture provenance did not match the exact authenticated synthetic run.", "harness", false));
  return {
    app_authenticated: true,
    synthetic: true,
    test_run_id_sha256: record.test_run_id_sha256,
    principal_id_sha256: record.principal_id_sha256,
    environment: record.environment,
    scenario_id: record.scenario_id,
    scenario_version: record.scenario_version,
    retention_hours: record.retention_hours,
    provider_expires_at: record.provider_expires_at,
    cleanup_obligation_id_sha256: record.cleanup_obligation_id_sha256,
  };
}
function exactFiniteNumber(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function stableJoin(name: string, current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current;
  if (current !== null && current !== candidate) throw new VoiceLabError(labError("JOIN_CORRELATION_CONFLICT", `Conflicting ${name} values were observed from strict owning receipts.`, "harness", false, { join: name, prior_hash: sha256(current), candidate_hash: sha256(candidate) }));
  return candidate;
}
function monotonicEpoch(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  if (current !== null && candidate < current) throw new VoiceLabError(labError("PROVIDER_EPOCH_REGRESSION", "Provider epoch regressed across strict product receipts.", "harness", false, { prior: current, candidate }));
  return candidate;
}

function assertBargeWindow(target: Record<string, unknown> | undefined): void {
  const targetAt = typeof target?.target_schedule_at === "string" ? new Date(target.target_schedule_at).getTime() : Number.NaN;
  const maxLateness = Number(target?.max_lateness_ms);
  const lateness = Date.now() - targetAt;
  if (!Number.isFinite(targetAt) || !Number.isFinite(maxLateness) || maxLateness < 0 || lateness > maxLateness) throw new VoiceLabError(labError("BARGE_WINDOW_MISSED", "Barge-in execution could no longer meet the declared playback-relative timing window before page mutation.", "conflict", true, { lateness_ms: Number.isFinite(lateness) ? Math.max(0, lateness) : null, max_lateness_ms: Number.isFinite(maxLateness) ? maxLateness : null }));
}

export function leaseHeartbeatIntervalMs(operationLeaseSeconds: number, browserLeaseSeconds: number): number {
  return Math.max(1_000, Math.floor(Math.min(operationLeaseSeconds, browserLeaseSeconds) * 1_000 / 3));
}

function findString(value: unknown, keys: readonly string[], depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key) && typeof child === "string" && child.length > 0) return child;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findString(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function findFiniteNumber(value: unknown, keys: readonly string[], depth = 0): number | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key) && typeof child === "number" && Number.isFinite(child) && child >= 0) return child;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findFiniteNumber(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function deterministicUuid(runId: string, purpose: string): string {
  const source = sha256(`${purpose}:${runId}`).slice(0, 32).split("");
  source[12] = "5";
  source[16] = (["8", "9", "a", "b"] as const)[Number.parseInt(source[16]!, 16) % 4]!;
  const hex = source.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Hash immutable, already-persisted evidence without reusing the public request
 * hash's one-megabyte admission bound. The projection can legitimately contain
 * a browser diagnostic larger than that bound. Feed canonical JSON directly to
 * the digest so advancing an evidence revision remains deterministic without
 * allocating another full serialized copy of the retained evidence.
 */
function evidenceProjectionHash(input: unknown): string {
  const digest = createHash("sha256");
  const seen = new WeakSet<object>();
  const write = (value: unknown): void => {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      digest.update(JSON.stringify(value));
      return;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new VoiceLabError(labError("EVIDENCE_PROJECTION_INVALID", "Evidence revision projection contains a cycle.", "internal", false));
      seen.add(value);
      digest.update("[");
      value.forEach((child, index) => {
        if (index > 0) digest.update(",");
        write(child);
      });
      digest.update("]");
      seen.delete(value);
      return;
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) throw new VoiceLabError(labError("EVIDENCE_PROJECTION_INVALID", "Evidence revision projection contains a cycle.", "internal", false));
      seen.add(value);
      digest.update("{");
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined && typeof child !== "function" && typeof child !== "symbol")
        .sort(([left], [right]) => left.localeCompare(right));
      entries.forEach(([key, child], index) => {
        if (index > 0) digest.update(",");
        digest.update(JSON.stringify(key));
        digest.update(":");
        write(child);
      });
      digest.update("}");
      seen.delete(value);
      return;
    }
    digest.update("null");
  };
  write(input);
  return digest.digest("hex");
}

interface EvidenceProjectionOverflowRecord {
  path: string;
  content_sha256: string;
  byte_length: number;
  value: unknown;
}

function projectEvidenceValue(path: string, value: unknown, overflowId: string, overflow: EvidenceProjectionOverflowRecord[]): unknown {
  if (value === null) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength <= 64_000) return value;
  const contentSha256 = evidenceProjectionHash(value);
  overflow.push({ path, content_sha256: contentSha256, byte_length: byteLength, value });
  return {
    status: "available_in_projection_overflow",
    resource_id: `voice-lab://artifact/${overflowId}`,
    path,
    content_sha256: contentSha256,
    byte_length: byteLength,
  };
}

export function deriveD02BrowserContextBinding(run: RunRecord, workerId: string, leaseEpoch: number): D02BrowserContextBinding {
  if (run.scenarioId !== "V-D02" || typeof workerId !== "string" || workerId.length === 0 || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
    throw new VoiceLabError(labError("BROWSER_CONTEXT_BINDING_MISMATCH", "A deterministic browser context binding requires one exact V-D02 run, worker, and positive lease epoch.", "harness", false));
  }
  const workerHash = sha256(workerId);
  const allocationId = deterministicUuid(run.id, `browser-context-allocation:${workerHash}:${leaseEpoch}`);
  return {
    voice_lab_run_id_sha256: sha256(run.id),
    browser_worker_id_sha256: workerHash,
    browser_lease_epoch: leaseEpoch,
    browser_context_id_sha256: sha256(allocationId),
  };
}

function isExactD02BrowserContextBinding(run: RunRecord, binding: D02BrowserContextBinding): boolean {
  return run.scenarioId === "V-D02"
    && /^[a-f0-9]{64}$/.test(binding.voice_lab_run_id_sha256)
    && binding.voice_lab_run_id_sha256 === sha256(run.id)
    && /^[a-f0-9]{64}$/.test(binding.browser_worker_id_sha256)
    && Number.isSafeInteger(binding.browser_lease_epoch)
    && binding.browser_lease_epoch > 0
    && /^[a-f0-9]{64}$/.test(binding.browser_context_id_sha256);
}

function sameD02BrowserContextBinding(left: D02BrowserContextBinding | undefined, right: D02BrowserContextBinding | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.voice_lab_run_id_sha256 === right.voice_lab_run_id_sha256
    && left.browser_worker_id_sha256 === right.browser_worker_id_sha256
    && left.browser_lease_epoch === right.browser_lease_epoch
    && left.browser_context_id_sha256 === right.browser_context_id_sha256;
}
