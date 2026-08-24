import { randomUUID } from "node:crypto";

import type { VoiceLabConfig } from "./config.js";
import type { WorkerHeartbeat } from "./ledger.js";
import { canonicalRequestHash, sha256 } from "./security.js";

export const WORKER_HEARTBEAT_ATTESTATION_SCHEMA = "sophia_voice_lab_worker_heartbeat_v1" as const;
export const WORKER_HEARTBEAT_SERVICE = "sophia-voice-lab-worker" as const;

export interface WorkerBootIdentity {
  bootIdSha256: string;
  instanceIdSha256: string;
  bootedAt: Date;
}

export interface WorkerHeartbeatAttestation {
  schema: typeof WORKER_HEARTBEAT_ATTESTATION_SCHEMA;
  service: typeof WORKER_HEARTBEAT_SERVICE;
  service_version: string;
  repository_candidate_sha: string;
  deployment_identity_sha256: string;
  worker_boot_id_sha256: string;
  worker_instance_id_sha256: string;
  booted_at: string;
  heartbeat_sequence: number;
  effective_kill_switch_engaged: boolean;
}

const ATTESTATION_KEYS = [
  "booted_at",
  "deployment_identity_sha256",
  "effective_kill_switch_engaged",
  "heartbeat_sequence",
  "repository_candidate_sha",
  "schema",
  "service",
  "service_version",
  "worker_boot_id_sha256",
  "worker_instance_id_sha256",
] as const;
const SHA256 = /^[a-f0-9]{64}$/;

/** Hash every shared release/configuration identity needed to distinguish an
 * env-only redeploy at the same Git SHA. The desired worker gate is included
 * explicitly so an old process cannot satisfy the opposite gate state. */
export function workerDeploymentIdentitySha256(config: VoiceLabConfig, effectiveKillSwitchEngaged: boolean): string {
  return canonicalRequestHash({
    schema: "sophia_voice_lab_worker_deployment_identity_v1",
    service: WORKER_HEARTBEAT_SERVICE,
    service_version: config.serviceVersion,
    repository_candidate_sha: config.repositoryCandidateSha,
    environment: config.environment,
    effective_kill_switch_engaged: effectiveKillSwitchEngaged,
    harness_version: config.harnessVersion,
    mcp_version: config.mcpVersion,
    plugin_version: config.pluginVersion,
    plugin_package_sha256: config.pluginPackageSha256,
    registered_app_id: config.registeredAppId,
    fixture_manifest_sha256: config.fixtureManifestSha256,
    expected_product_deployment: config.readinessTarget?.expectedDeployment ?? null,
    expected_dependencies: config.readinessTarget?.expectedDependencies ?? null,
  });
}

export function createWorkerBootIdentity(workerId: string, bootToken = randomUUID(), bootedAt = new Date()): WorkerBootIdentity {
  return {
    bootIdSha256: sha256(bootToken),
    instanceIdSha256: sha256(workerId),
    bootedAt: new Date(bootedAt),
  };
}

export function createWorkerHeartbeatAttestation(
  config: VoiceLabConfig,
  identity: WorkerBootIdentity,
  effectiveKillSwitchEngaged: boolean,
  heartbeatSequence: number,
): WorkerHeartbeatAttestation {
  return {
    schema: WORKER_HEARTBEAT_ATTESTATION_SCHEMA,
    service: WORKER_HEARTBEAT_SERVICE,
    service_version: config.serviceVersion,
    repository_candidate_sha: config.repositoryCandidateSha,
    deployment_identity_sha256: workerDeploymentIdentitySha256(config, effectiveKillSwitchEngaged),
    worker_boot_id_sha256: identity.bootIdSha256,
    worker_instance_id_sha256: identity.instanceIdSha256,
    booted_at: identity.bootedAt.toISOString(),
    heartbeat_sequence: heartbeatSequence,
    effective_kill_switch_engaged: effectiveKillSwitchEngaged,
  };
}

export type WorkerHeartbeatValidation =
  | { ok: true; attestation: WorkerHeartbeatAttestation }
  | { ok: false; reason: string };

/** Validate the JSONB attestation as hostile durable input. In particular, a
 * same-SHA row must bind the current release configuration, raw row owner,
 * unique process boot, and a heartbeat observed after this web process boot. */
export function validateWorkerHeartbeat(
  heartbeat: WorkerHeartbeat,
  config: VoiceLabConfig,
  webBootedAt: Date,
): WorkerHeartbeatValidation {
  const value = heartbeat.attestation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "heartbeat_attestation_missing" };
  const record = value as unknown as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...ATTESTATION_KEYS].sort().join(",")) return { ok: false, reason: "heartbeat_attestation_shape_invalid" };
  if (record.schema !== WORKER_HEARTBEAT_ATTESTATION_SCHEMA || record.service !== WORKER_HEARTBEAT_SERVICE) return { ok: false, reason: "heartbeat_attestation_schema_invalid" };
  if (record.service_version !== config.serviceVersion || heartbeat.serviceVersion !== config.serviceVersion || record.repository_candidate_sha !== config.repositoryCandidateSha) return { ok: false, reason: "heartbeat_deployment_version_mismatch" };
  if (typeof record.effective_kill_switch_engaged !== "boolean") return { ok: false, reason: "heartbeat_kill_switch_invalid" };
  if (record.deployment_identity_sha256 !== workerDeploymentIdentitySha256(config, record.effective_kill_switch_engaged)) return { ok: false, reason: "heartbeat_deployment_identity_mismatch" };
  if (typeof record.worker_boot_id_sha256 !== "string" || !SHA256.test(record.worker_boot_id_sha256)
    || record.worker_instance_id_sha256 !== sha256(heartbeat.workerId)) return { ok: false, reason: "heartbeat_boot_identity_invalid" };
  if (!Number.isSafeInteger(record.heartbeat_sequence) || Number(record.heartbeat_sequence) < 1) return { ok: false, reason: "heartbeat_sequence_invalid" };
  if (typeof record.booted_at !== "string") return { ok: false, reason: "heartbeat_boot_time_invalid" };
  const bootedAt = new Date(record.booted_at);
  if (!Number.isFinite(bootedAt.getTime()) || bootedAt.toISOString() !== record.booted_at || bootedAt > heartbeat.observedAt) return { ok: false, reason: "heartbeat_boot_time_invalid" };
  if (heartbeat.observedAt <= webBootedAt) return { ok: false, reason: "heartbeat_not_observed_after_web_boot" };
  return { ok: true, attestation: record as unknown as WorkerHeartbeatAttestation };
}
