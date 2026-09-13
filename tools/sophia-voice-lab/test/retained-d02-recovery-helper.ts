import { expect } from "vitest";
import type { RecoveryControlRecord } from "../src/recovery-control.js";
import { recoveryAttemptIdentity } from "../src/recovery-attempt.js";
import { deriveRetainedD02Recovery } from "../src/retained-d02-recovery.js";
import { sha256 } from "../src/security.js";

export function combinedRecoveryFixture(control: RecoveryControlRecord, issuedAt: number) {
  const attempt = recoveryAttemptIdentity({ cleanup_obligation_id: control.binding.cleanupObligationId,
    jti: "a".repeat(32), nonce: "b".repeat(32), iat: issuedAt });
  const event = { kind: "cleanup.recovery", source: "canonical", payload: { complete: true, http_status: 200, retention_purged: true, receipt: {
    test_run_id: control.binding.testRunId, cleanup_obligation_id_sha256: sha256(control.binding.cleanupObligationId),
    recovery_id: attempt.recoveryId, attempt_id: attempt.attemptId, attempt_issued_at: issuedAt, recovered_at: new Date(issuedAt * 1000 + 1).toISOString(),
    complete: true, live_cleanup_complete: true, live_resources_zero: true, retention_purged: true, retention_purge_pending: false, retention_maintenance_complete: true,
    components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, auth_sessions: { status: "completed" },
      builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } },
    receipt: { storage: "postgres", object_path: "synthetic/combined-recovery", sha256: sha256("combined-recovery-receipt") },
  } } };
  return { event, attempt };
}

export function verifyCombinedRecoveryFixture(control: RecoveryControlRecord) {
  const issued = Math.ceil(Math.max(Date.parse(control.d02OwnerDeath!.acceptedAt), Date.parse(control.d02ProviderSettlement!.observedAt)) / 1000) + 1;
  const { event, attempt } = combinedRecoveryFixture(control, issued);
  const now = new Date((issued + 1) * 1000);
  expect(deriveRetainedD02Recovery(control, event, attempt, now)).toMatchObject({ ready: true,
    ownerDeathProofSha256: control.d02OwnerDeath!.proofSha256, providerProofSha256: control.d02ProviderSettlement!.proofSha256 });
  for (const component of ["canonical_session", "voice_provider", "auth_sessions", "builder"] as const) {
    const invalid = structuredClone(event);
    invalid.payload.receipt.components[component].status = "pending";
    expect(() => deriveRetainedD02Recovery(control, invalid, attempt, now)).toThrow();
  }
  const missingBuilder = structuredClone(event);
  missingBuilder.payload.receipt.components.builder.authoritative_zero_tasks = false;
  expect(() => deriveRetainedD02Recovery(control, missingBuilder, attempt, now)).toThrow();
  for (const key of ["d02OwnerDeath", "d02ProviderSettlement", "executionOwnership"] as const) {
    expect(() => deriveRetainedD02Recovery({ ...control, [key]: undefined }, event, attempt, now)).toThrow();
  }
  const old = combinedRecoveryFixture(control, issued - 10);
  expect(() => deriveRetainedD02Recovery(control, old.event, old.attempt, now)).toThrow("D02_RECOVERY_ATTEMPT_PREDATES_AUTHORITY");
}
