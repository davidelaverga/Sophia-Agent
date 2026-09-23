import { parseExecutionOwnership } from "./execution-ownership.js";
import { bindsExecutionOwnership, isVerifiedServiceOwnerFenceV2, type VerifiedServiceOwnerFence } from "./service-owner-fence.js";
import type { RecoveryControlRecord } from "./recovery-control.js";

export const PLATFORM_EXECUTION_TERMINATION_KIND = "cleanup.platform_execution_terminated";
export const PLATFORM_EXECUTION_TERMINATION_SCHEMA = "sophia_voice_lab_execution_epoch_platform_termination_v1";

/** One canonical termination per (execution epoch, signed receipt). The durable
 * dedupe key makes an exact retry a replay instead of a second settlement. */
export function platformExecutionTerminationDedupeKey(executionEpochSha256: string, signedReceiptSha256: string): string {
  return `${PLATFORM_EXECUTION_TERMINATION_KIND}:${executionEpochSha256}:${signedReceiptSha256}`;
}

/**
 * Derive the canonical platform-termination receipt from an ALREADY VERIFIED v2
 * service-owner fence.
 *
 * This is the only production writer of the event the execution-cleanup
 * evaluator accepts in place of a browser-authored close. It is deliberately a
 * distinct receipt: it records that the platform replaced the pod that owned
 * this execution epoch, which is the strongest fact the platform can author.
 * It never fabricates or relabels cleanup.browser_context_closed, and it
 * carries provider/resource proofs as literal false so owner loss can never be
 * read as completed cleanup.
 */
export function derivePlatformExecutionTermination(
  control: RecoveryControlRecord,
  proof: VerifiedServiceOwnerFence,
): { payload: Record<string, unknown>; dedupeKey: string } {
  if (!isVerifiedServiceOwnerFenceV2(proof)) throw new Error("PLATFORM_TERMINATION_REQUIRES_V2_FENCE");
  if (!control.executionOwnership) throw new Error("PLATFORM_TERMINATION_OWNERSHIP_MISSING");
  const ownership = parseExecutionOwnership(control.executionOwnership);
  // Re-join every field against the control's own ownership. The proof was
  // verified against this control, so a divergence here is a programming fault,
  // not an untrusted input, and must fail loudly rather than be written.
  if (!bindsExecutionOwnership(ownership, proof, control)) {
    throw new Error("PLATFORM_TERMINATION_OWNERSHIP_INVALID");
  }
  return {
    dedupeKey: platformExecutionTerminationDedupeKey(ownership.executionEpochSha256, proof.signedReceiptSha256),
    payload: {
      schema: PLATFORM_EXECUTION_TERMINATION_SCHEMA,
      voice_lab_run_id_sha256: ownership.runIdSha256,
      cleanup_obligation_id_sha256: ownership.cleanupObligationIdSha256,
      process_id_sha256: ownership.processIdSha256,
      browser_boot_id_sha256: ownership.browserBootIdSha256,
      execution_epoch_sha256: ownership.executionEpochSha256,
      original_worker_id_sha256: ownership.workerIdSha256,
      browser_lease_epoch: ownership.browserLeaseEpoch,
      process_acquired_seq: ownership.processAcquiredSeq,
      runtime_acquired_seq: ownership.runtimeAcquiredSeq,
      owner_replacement_observed: true,
      browser_context_closed_fabricated: false,
      provider_cleanup_proven: false,
      live_resources_zero_proven: false,
      service_owner_fence_proof_sha256: proof.proofSha256,
      signed_receipt_sha256: proof.signedReceiptSha256,
      authority_public_key_sha256: proof.authorityPublicKeySha256,
      execution_ownership_proof_sha256: ownership.proofSha256,
    },
  };
}
