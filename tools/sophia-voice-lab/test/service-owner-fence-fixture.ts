import { generateKeyPairSync, sign } from "node:crypto";
import type { ServiceOwnerFenceReceipt } from "../src/service-owner-fence.js";
import { prepareGenericOwnerDispatch, consumeGenericOwnerDispatch, genericOwnerLossDispatchFromControl } from "../src/generic-owner-dispatch.js";
import { deriveRecoveryBrowserBinding, projectRecoveryControlBinding, type RecoveryControlRecord } from "../src/recovery-control.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";

export function serviceOwnerFenceFixture(createdAt?: Date) {
  const run = testRun(createdAt ? { createdAt } : {});
  const at = (ms: number) => new Date(run.createdAt.getTime() + ms);
  const serviceId = "srv-0123456789abcdefghij";
  const owner = `${serviceId}-original-${run.id}`;
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
  return { input, unsigned, signed, at };
}
