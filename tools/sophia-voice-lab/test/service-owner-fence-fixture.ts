import { generateKeyPairSync, sign } from "node:crypto";
import type { ServiceOwnerFenceReceipt } from "../src/service-owner-fence.js";
import { prepareGenericOwnerDispatch, consumeGenericOwnerDispatch, genericOwnerLossDispatchFromControl } from "../src/generic-owner-dispatch.js";
import { deriveRecoveryBrowserBinding, projectRecoveryControlBinding, type RecoveryControlRecord } from "../src/recovery-control.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { deriveExecutionOwnership } from "../src/execution-ownership.js";
import { renderInventoryInstanceId } from "../src/worker-identity.js";
import { testRun } from "./helpers.js";

export function serviceOwnerFenceFixture(createdAt?: Date) {
  const run = testRun(createdAt ? { createdAt } : {});
  const at = (ms: number) => new Date(run.createdAt.getTime() + ms);
  const serviceId = "srv-0123456789abcdefghij";
  // Real Render shape: srv-<20>-<replica-set>-<pod>. Its inventory projection
  // drops the replica-set segment, so the two hashes deliberately differ.
  const owner = `${serviceId}-65566bc6c7-2gj6p`;
  const control: RecoveryControlRecord = { binding: projectRecoveryControlBinding(run, `cp1:test:${"a".repeat(64)}`),
    version: 2, browserAllocationEver: true, browserAllocationBinding: deriveRecoveryBrowserBinding(run.id, owner, 1),
    liveCleanupComplete: false, remotePurgeComplete: false, contentPurgedAt: at(0), retentionPurgeDueAt: null };
  control.genericOwnerDispatch = prepareGenericOwnerDispatch(control, { runId: run.id, requestId: run.id, expectedVersion: control.version, workerServiceId: serviceId }, at(1000));
  control.version++;
  control.genericOwnerDispatch = consumeGenericOwnerDispatch(control, { runId: run.id, expectedVersion: control.version, preparedProofSha256: control.genericOwnerDispatch.proofSha256 }, at(2000));
  control.version++;
  const pair = generateKeyPairSync("ed25519");
  const authority = { issuer: "test-deployment-controller", subject: "test-deployment-operator", key_id: "test-deployment-key",
    public_key_spki_base64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const snapshot = { serviceResponseSha256: sha256("service"), deployResponseSha256: sha256("deploy"), instanceResponseSha256: sha256("instances"), deployStatus: "live" as const,
    readinessResponseSha256: sha256("closed-exact-release") };
  const unsigned: Omit<ServiceOwnerFenceReceipt, "signature"> = {
    schema: "sophia.voice-lab.service-owner-fence-receipt.v1", receiptId: run.id, authority: "deployment_control",
    issuer: authority.issuer, subject: authority.subject, authorityKeyId: authority.key_id, audience: "sophia-voice-lab-service-owner-fence",
    ...genericOwnerLossDispatchFromControl(control), allocatedWorkerId: owner, workerIdSha256: sha256(owner), browserLeaseEpoch: 1,
    expectedLabSha: "d".repeat(40), expectedLangGraphSha: "e".repeat(40), expectedRecoveryDeployment: { frontend: "1".repeat(40), backend: "2".repeat(40), voice: "3".repeat(40) },
    actionAcceptedResponseSha256: sha256("accepted"), actionHttpStatus: 200, actionAcceptedAt: at(3000).toISOString(),
    before: { ...snapshot, deployIdSha256: sha256("before-deploy"), instanceIdsSha256: [sha256("already-replacement")], instanceCreatedAt: at(500).toISOString(), observedAt: at(1500).toISOString() },
    after: { ...snapshot, deployIdSha256: sha256("after-deploy"), instanceIdsSha256: [sha256("new-replacement")], instanceCreatedAt: at(4000).toISOString(), observedAt: at(363000).toISOString() },
    providerCleanupProven: false, liveResourcesZeroProven: false, issuedAt: at(363001).toISOString(), expiresAt: at(423000).toISOString(), signatureAlgorithm: "ed25519-sha256-canonical-request-v1",
  };
  const signed = (r = unsigned) => ({ ...r, signature: sign(null, Buffer.from(canonicalRequestHash(r), "hex"), pair.privateKey).toString("base64url") });
  const input = { control, receipt: signed(), authority, expectedWorkerServiceIdSha256: sha256(serviceId), expectedLabSha: unsigned.expectedLabSha,
    expectedLangGraphSha: unsigned.expectedLangGraphSha, expectedRecoveryDeployment: unsigned.expectedRecoveryDeployment, acceptedAt: at(363002) };
  return { input, unsigned, signed, at, owner, serviceId };
}

/** v2: the ORIGINAL allocated pod is still present immediately before the
 * prospective one-shot action, and is replaced by it. */
export function serviceOwnerFenceV2Fixture(createdAt?: Date) {
  const base = serviceOwnerFenceFixture(createdAt);
  const { input, unsigned, at } = base;
  const control = input.control;
  const ownerHash = control.browserAllocationBinding!.browser_worker_id_sha256;
  const ownership = deriveExecutionOwnership(
    { id: control.binding.runId, cleanupObligationId: control.binding.cleanupObligationId },
    [
      { runId: control.binding.runId, seq: 1, kind: "harness.browser_process_acquired", source: "browser", at: at(10), dedupeKey: "a", payload: {
        schema: "sophia_voice_lab_browser_process_ownership_v1",
        voice_lab_run_id_sha256: sha256(control.binding.runId),
        cleanup_obligation_id_sha256: sha256(control.binding.cleanupObligationId),
        process_id_sha256: "a".repeat(64), browser_boot_id_sha256: "b".repeat(64), execution_epoch_sha256: "c".repeat(64),
        one_process_per_run: true, raw_process_id_excluded: true } },
      { runId: control.binding.runId, seq: 2, kind: "harness.browser_runtime_acquired", source: "canonical", at: at(20), dedupeKey: "b", payload: {
        worker_id_sha256: ownerHash, browser_lease_epoch: 1 } },
    ] as never,
  );
  control.executionOwnership = ownership;
  const unsignedV2 = {
    ...unsigned,
    schema: "sophia.voice-lab.service-owner-fence-receipt.v2" as const,
    executionOwnershipProofSha256: ownership.proofSha256,
    executionEpochSha256: ownership.executionEpochSha256,
    processIdSha256: ownership.processIdSha256,
    browserBootIdSha256: ownership.browserBootIdSha256,
    processAcquiredSeq: ownership.processAcquiredSeq,
    runtimeAcquiredSeq: ownership.runtimeAcquiredSeq,
    // Original owner OBSERVED PRESENT before, replaced after.
    // Render inventory form, NOT the full ownership hash.
    before: { ...unsigned.before, instanceIdsSha256: [sha256(renderInventoryInstanceId(base.owner)!)] },
  };
  return { ...base, ownership, unsignedV2, owner: base.owner, inputV2: { ...input, receipt: base.signed(unsignedV2 as never) } };
}

/** Sign a v2 receipt for a REAL control that has already prepared+consumed its
 * dispatch through the ledger. Only the signing authority is synthetic. */
export function signedV2FenceReceipt(input: {
  control: RecoveryControlRecord; ownership: { proofSha256: string; executionEpochSha256: string; processIdSha256: string;
    browserBootIdSha256: string; processAcquiredSeq: number; runtimeAcquiredSeq: number; browserLeaseEpoch: number };
  allocatedWorkerId: string; serviceId: string; actionRequestedAt: Date;
}) {
  const pair = generateKeyPairSync("ed25519");
  const authority = { issuer: "test-deployment-controller", subject: "test-deployment-operator", key_id: "test-deployment-key",
    public_key_spki_base64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const at = (ms: number) => new Date(input.actionRequestedAt.getTime() + ms).toISOString();
  const snapshot = { serviceResponseSha256: sha256("service"), deployResponseSha256: sha256("deploy"),
    instanceResponseSha256: sha256("instances"), deployStatus: "live" as const, readinessResponseSha256: sha256("ready") };
  const originalInventorySha256 = sha256(renderInventoryInstanceId(input.allocatedWorkerId)!);
  const expectedRecoveryDeployment = { frontend: "1".repeat(40), backend: "2".repeat(40), voice: "3".repeat(40) };
  const unsigned = {
    schema: "sophia.voice-lab.service-owner-fence-receipt.v2" as const, receiptId: input.control.genericOwnerDispatch!.requestId,
    authority: "deployment_control" as const, issuer: authority.issuer, subject: authority.subject, authorityKeyId: authority.key_id,
    audience: "sophia-voice-lab-service-owner-fence" as const,
    ...genericOwnerLossDispatchFromControl(input.control),
    allocatedWorkerId: input.allocatedWorkerId, workerIdSha256: sha256(input.allocatedWorkerId),
    browserLeaseEpoch: input.ownership.browserLeaseEpoch,
    expectedLabSha: "d".repeat(40), expectedLangGraphSha: "e".repeat(40), expectedRecoveryDeployment,
    executionOwnershipProofSha256: input.ownership.proofSha256, executionEpochSha256: input.ownership.executionEpochSha256,
    processIdSha256: input.ownership.processIdSha256, browserBootIdSha256: input.ownership.browserBootIdSha256,
    processAcquiredSeq: input.ownership.processAcquiredSeq, runtimeAcquiredSeq: input.ownership.runtimeAcquiredSeq,
    actionAcceptedResponseSha256: sha256("accepted"), actionHttpStatus: 200 as const, actionAcceptedAt: at(1_000),
    before: { ...snapshot, deployIdSha256: sha256("before-deploy"), instanceIdsSha256: [originalInventorySha256],
      instanceCreatedAt: at(-5_000), observedAt: at(-1_000) },
    after: { ...snapshot, deployIdSha256: sha256("after-deploy"), instanceIdsSha256: [sha256(`${input.serviceId}-9kd2f`)],
      instanceCreatedAt: at(2_000), observedAt: at(361_000) },
    providerCleanupProven: false as const, liveResourcesZeroProven: false as const,
    issuedAt: at(361_500), expiresAt: at(900_000),
    signatureAlgorithm: "ed25519-sha256-canonical-request-v1" as const,
  };
  return { receipt: { ...unsigned, signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), pair.privateKey).toString("base64url") },
    authority, expectedRecoveryDeployment, expectedLabSha: unsigned.expectedLabSha, expectedLangGraphSha: unsigned.expectedLangGraphSha };
}
