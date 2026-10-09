import { z } from "zod";

import type { VoiceLabConfig } from "./config.js";
import { VoiceLabError, labError } from "./domain.js";
import type { VoiceLabLedger } from "./ledger.js";
import { derivePlatformExecutionTermination, PLATFORM_EXECUTION_TERMINATION_KIND } from "./platform-execution-termination.js";
import { canonicalRequestHash, requireScope, sha256, type AuthenticatedCaller } from "./security.js";
import { AnyServiceOwnerFenceReceiptSchema, isVerifiedServiceOwnerFenceV2, serviceFenceSourceLabSha } from "./service-owner-fence.js";

/**
 * Generic owner recovery's deployment-control journal (the service's
 * genericOwnerDispatch tool): inspect, prepare and consume a dispatch, and
 * ingest an owner-loss receipt or a service owner fence. Deployment-control
 * journal access only; never performs a provider action.
 */
export async function genericOwnerDispatchControl(ledger: VoiceLabLedger, config: VoiceLabConfig, caller: AuthenticatedCaller, raw: unknown) {
  requireScope(caller, "voice_lab:attest");
  requireScope(caller, "voice_lab:attest:deployment_control");
  if (caller.authorizationKind !== "attestation" || caller.subject !== config.attestationAuthorities.deployment_control.subject)
    throw new VoiceLabError(labError("ATTESTATION_AUTHORITY_MISMATCH", "Generic owner recovery requires deployment-control transport authority.", "authorization"));
  if (!config.killSwitch || !config.genericRecoveryWorkerServiceId)
    throw new VoiceLabError(labError("GENERIC_RECOVERY_CLOSED_WINDOW_REQUIRED", "Generic recovery requires closed admission and a configured exact worker service.", "conflict"));
  const runId = z.string().uuid();
  const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  const input = z.discriminatedUnion("action", [
    z.object({ action: z.literal("inspect"), runId }).strict(),
    z.object({ action: z.literal("prepare"), runId, expectedVersion: version, requestId: z.string().uuid() }).strict(),
    z.object({ action: z.literal("consume"), runId, expectedVersion: version, preparedProofSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ action: z.literal("ingest_owner_loss"), runId, expectedVersion: version, receipt: z.unknown() }).strict(),
    z.object({ action: z.literal("ingest_service_fence"), runId, expectedVersion: version, receipt: AnyServiceOwnerFenceReceiptSchema }).strict(),
  ]).parse(raw);
  const control = await ledger.getRecoveryControl(input.runId);
  if (!control || control.binding.scenarioId === "V-D02" || control.binding.principalId !== config.principalId
    || control.binding.environment !== config.environment) throw new VoiceLabError(labError("GENERIC_RECOVERY_SCOPE_INVALID", "Generic recovery control is outside the configured principal/environment.", "authorization"));
  if (control.genericOwnerDispatch && control.genericOwnerDispatch.workerServiceIdSha256 !== sha256(config.genericRecoveryWorkerServiceId))
    throw new VoiceLabError(labError("GENERIC_RECOVERY_SERVICE_MISMATCH", "Stored recovery service differs from current configuration.", "conflict"));
  if (input.action === "inspect") return { dispatchAllowed: false, control, workerServiceId: config.genericRecoveryWorkerServiceId };
  if (input.action === "ingest_owner_loss" || input.action === "ingest_service_fence") {
    const target = config.readinessTarget;
    if (!target || (input.action === "ingest_owner_loss" && canonicalRequestHash(target.expectedDeployment) !== canonicalRequestHash(control.binding.expectedDeployment)))
      throw new VoiceLabError(labError("GENERIC_RECOVERY_RELEASE_MISMATCH", "Generic receipt ingestion requires the configured exact product release.", "conflict"));
    const authority = config.attestationAuthorities.deployment_control;
    await ledger.persistGenericOwnerLoss({ runId: input.runId, expectedVersion: input.expectedVersion, receipt: input.receipt,
      authority: { issuer: authority.issuer, subject: authority.subject, key_id: authority.keyId, public_key_spki_base64: authority.publicKeySpkiBase64 },
      expectedWorkerServiceIdSha256: sha256(config.genericRecoveryWorkerServiceId),
      ...(input.action === "ingest_service_fence" ? { expectedRecoveryDeployment: target.expectedDeployment } : {}),
      expectedLabSha: input.action === "ingest_service_fence"
        ? serviceFenceSourceLabSha(input.receipt, config.serviceVersion, config.genericRecoveryReceiptSha256)
        : config.serviceVersion, expectedLangGraphSha: target.expectedDependencies.langgraph });
    const persisted = await ledger.getRecoveryControl(input.runId);
    if (!persisted?.genericOwnerLoss) throw new Error("GENERIC_OWNER_PERSISTENCE_UNCONFIRMED");
    // A verified v2 service fence is the only source permitted to author the
    // canonical platform-termination receipt. It is appended under a durable
    // dedupe key, so an exact retry replays one receipt rather than settling
    // the epoch twice, and it never stands in for provider/resource cleanup.
    const settled = persisted.genericOwnerLoss;
    if (input.action === "ingest_service_fence" && settled.schema === "sophia.voice-lab.verified-service-owner-fence.v2" && isVerifiedServiceOwnerFenceV2(settled)) {
      const termination = derivePlatformExecutionTermination(persisted, settled);
      await ledger.appendEvent(input.runId, PLATFORM_EXECUTION_TERMINATION_KIND, "canonical", termination.payload, termination.dedupeKey);
    }
    return { dispatchAllowed: false, control: persisted, workerServiceId: config.genericRecoveryWorkerServiceId };
  }
  if (input.action === "prepare") return { dispatchAllowed: false, control: await ledger.prepareGenericOwnerDispatch({ runId: input.runId, expectedVersion: input.expectedVersion, requestId: input.requestId, workerServiceId: config.genericRecoveryWorkerServiceId }), workerServiceId: config.genericRecoveryWorkerServiceId };
  return { ...await ledger.consumeGenericOwnerDispatch(input), workerServiceId: config.genericRecoveryWorkerServiceId };
}
