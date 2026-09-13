import type { RecoveryControlRecord } from "./recovery-control.js";
import { RecoveryControlBindingSchema, validateRecoveryBrowserBinding } from "./recovery-control.js";
import { parseExecutionOwnership } from "./execution-ownership.js";
import { parseD02RecoveryJournal } from "./d02-recovery-journal.js";
import { canonicalRequestHash, sha256 } from "./security.js";
import { D02WorkerTerminationControllerReceiptSchema, verifyD02WorkerTerminationSignature, type WorkerReceiptAuthority } from "./d02-worker-receipt.js";
export type RetainedOwnerAuthorityConfig = { deployment_control: WorkerReceiptAuthority };

/** Independent controller verifier, not an ingestion route or settlement grant.
 * Callers must load control and configured service authority from trusted storage.
 * It accepts the existing D02 receipt, never an unsigned instance-absence claim.
 * Generic crashes and missing acquisition evidence remain unsupported. */
export function verifyRetainedD02OwnerDeath(input: {
  control: RecoveryControlRecord;
  receipt: unknown;
  publicConfig: RetainedOwnerAuthorityConfig;
  expectedWorkerServiceIdSha256: string;
  acceptedAt: Date;
}) {
  if (Buffer.byteLength(JSON.stringify(input.receipt) ?? "") > 32768) throw new Error("OWNER_RECEIPT_SIZE_INVALID");
  const receipt = D02WorkerTerminationControllerReceiptSchema.parse(input.receipt);
  verifyD02WorkerTerminationSignature(receipt, input.publicConfig.deployment_control);
  const binding = RecoveryControlBindingSchema.parse(input.control.binding);
  if (binding.scenarioId !== "V-D02" || input.control.browserAllocationEver !== true || !input.control.browserContextBinding || !input.control.executionOwnership) throw new Error("OWNER_ACQUISITION_UNPROVEN");
  const browser = validateRecoveryBrowserBinding(binding, input.control.browserContextBinding);
  const ownership = parseExecutionOwnership(input.control.executionOwnership);
  if (!input.control.d02Journal) throw new Error("OWNER_DISPATCH_UNPROVEN");
  const journal = parseD02RecoveryJournal(input.control.d02Journal);
  if (journal.runIdSha256 !== sha256(binding.runId)
    || journal.cleanupObligationIdSha256 !== sha256(binding.cleanupObligationId)
    || journal.terminationRequestIdSha256 !== sha256(receipt.termination_request_id)
    || journal.workerServiceIdSha256 !== receipt.binding.worker_service_id_sha256
    || journal.workerIdSha256 !== receipt.binding.browser_worker_id_sha256
    || journal.browserLeaseEpoch !== receipt.binding.browser_lease_epoch
    || journal.browserContextIdSha256 !== receipt.binding.browser_context_id_sha256
    || journal.providerSessionIdSha256 !== receipt.binding.provider_session_id_sha256
    || journal.providerAdmissionIdSha256 !== receipt.binding.provider_admission_id_sha256
    || journal.providerConnectionEpoch !== receipt.binding.provider_connection_epoch
    || canonicalRequestHash(journal.frozenProviderConnectionEpochs) !== canonicalRequestHash(receipt.binding.frozen_provider_connection_epochs)
    || journal.dispatchClaimSha256 !== receipt.render.dispatch_claim_sha256
    || journal.dispatchClaimEventSeq !== receipt.render.dispatch_claim_event_seq
    || journal.dispatchAttemptIdSha256 !== receipt.render.dispatch_attempt_id_sha256
    || journal.actionRequestSha256 !== receipt.render.action_request_sha256) throw new Error("OWNER_DISPATCH_BINDING_MISMATCH");
  if (!/^[a-f0-9]{64}$/.test(input.expectedWorkerServiceIdSha256)
    || receipt.binding.worker_service_id_sha256 !== input.expectedWorkerServiceIdSha256
    || receipt.run_id !== binding.runId || receipt.test_run_id_sha256 !== sha256(binding.testRunId)
    || receipt.cleanup_obligation_id_sha256 !== sha256(binding.cleanupObligationId)
    || receipt.environment !== binding.environment
    || canonicalRequestHash(receipt.expected_deployment) !== canonicalRequestHash(binding.expectedDeployment)
    || receipt.binding.browser_worker_id_sha256 !== browser.browser_worker_id_sha256
    || receipt.binding.browser_lease_epoch !== browser.browser_lease_epoch
    || receipt.binding.browser_context_id_sha256 !== browser.browser_context_id_sha256
    || ownership.runIdSha256 !== sha256(binding.runId)
    || ownership.cleanupObligationIdSha256 !== sha256(binding.cleanupObligationId)
    || ownership.workerIdSha256 !== browser.browser_worker_id_sha256
    || ownership.browserLeaseEpoch !== browser.browser_lease_epoch
    || receipt.render.replacement_worker_owner_instance_id_sha256 === ownership.workerIdSha256) throw new Error("OWNER_RECEIPT_BINDING_MISMATCH");
  const accepted = input.acceptedAt.getTime();
  if (!Number.isFinite(accepted) || Date.parse(receipt.issued_at) > accepted
    || Date.parse(receipt.expires_at) <= accepted
    || Date.parse(receipt.render.action_requested_at) < Date.parse(binding.createdAt)) throw new Error("OWNER_RECEIPT_TIME_INVALID");
  const proof = {
    schema: "sophia.voice-lab.verified-d02-owner-death.v1" as const,
    controlBindingSha256: canonicalRequestHash(binding),
    ownershipProofSha256: ownership.proofSha256,
    dispatchJournalProofSha256: journal.proofSha256,
    signedReceiptSha256: canonicalRequestHash(receipt),
    authorityKeyId: receipt.authority_key_id,
    authorityPublicKeySha256: sha256(Buffer.from(input.publicConfig.deployment_control.public_key_spki_base64, "base64")),
    executionEpochSha256: ownership.executionEpochSha256,
    workerIdSha256: ownership.workerIdSha256,
    browserLeaseEpoch: ownership.browserLeaseEpoch,
    terminationRequestIdSha256: sha256(receipt.termination_request_id),
    actionAcceptedResponseSha256: receipt.render.action_accepted_response_sha256,
    actionSettledSnapshotSha256: receipt.render.action_settled_snapshot_sha256,
    lossEventSeq: receipt.voice_lab.worker_loss_observation.loss_event_seq,
    lossObservedAt: receipt.voice_lab.worker_loss_observation.loss_observed_at,
    settledAt: receipt.render.action_settled_at,
    acceptedAt: input.acceptedAt.toISOString(),
    providerCleanupProven: false as const,
    liveResourcesZeroProven: false as const,
  };
  return { ...proof, proofSha256: canonicalRequestHash(proof) };
}
