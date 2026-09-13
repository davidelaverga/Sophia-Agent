import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { expect } from "vitest";
import type { VoiceLabLedger } from "../src/ledger.js";
import { labError } from "../src/domain.js";
import { sha256, canonicalRequestHash } from "../src/security.js";
import { genericOwnerLossDispatchFromControl } from "../src/generic-owner-dispatch.js";
import { parseVerifiedGenericOwnerLoss } from "../src/generic-owner-loss.js";
import { deriveRetainedGenericRecovery, parseRetainedGenericRecovery } from "../src/retained-generic-recovery.js";
import { combinedRecoveryFixture } from "./retained-d02-recovery-helper.js";
import { recoveryAttemptAuditHash } from "../src/retained-d02-recovery.js";
import { testRun } from "./helpers.js";

export async function verifyGenericOwnerDispatch(ledger: VoiceLabLedger, runIds: string[]) {
  const worker = `owner-${randomUUID()}`;
  const service = "srv-0123456789abcdefghij";
  const create = async () => {
    const run = testRun({ state: "failed_harness", retentionPurgeDueAt: new Date(0) });
    runIds.push(run.id);
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 100, caller: 100 });
    await ledger.cancelPendingRunOperations(run.id, null, labError("TEST_FIXTURE_COMPLETE", "Ledger-only dispatch test never starts resources.", "harness"));
    const lease = await ledger.upsertBrowserLease(run.id, worker, 60);
    await ledger.releaseBrowserLease(run.id, worker, lease.leaseEpoch);
    return run;
  };
  const run = await create();
  const initial = (await ledger.getRecoveryControl(run.id))!;
  const prepare = { runId: run.id, expectedVersion: initial.version, requestId: randomUUID(), workerServiceId: service };
  await expect(ledger.prepareGenericOwnerDispatch({ ...prepare, expectedVersion: initial.version + 1 })).rejects.toThrow();
  const prepared = await ledger.prepareGenericOwnerDispatch(prepare);
  expect(await ledger.prepareGenericOwnerDispatch(prepare)).toEqual(prepared);
  await expect(ledger.prepareGenericOwnerDispatch({ ...prepare, requestId: randomUUID() })).rejects.toThrow();
  const other = await create();
  await expect(ledger.prepareGenericOwnerDispatch({ ...prepare, runId: other.id, expectedVersion: (await ledger.getRecoveryControl(other.id))!.version, requestId: randomUUID() })).rejects.toThrow();
  const consume = { runId: run.id, expectedVersion: prepared.version, preparedProofSha256: prepared.genericOwnerDispatch!.proofSha256 };
  await expect(ledger.consumeGenericOwnerDispatch({ ...consume, preparedProofSha256: sha256("wrong") })).rejects.toThrow();
  const results = await Promise.all(Array.from({ length: 8 }, () => ledger.consumeGenericOwnerDispatch(consume)));
  expect(results.filter(result => result.dispatchAllowed)).toHaveLength(1);
  const consumed = (await ledger.getRecoveryControl(run.id))!;
  expect(consumed.genericOwnerDispatch?.consumedAt).not.toBeNull();
  expect(await ledger.prepareGenericOwnerDispatch(prepare)).toEqual(consumed);
  expect((await ledger.consumeGenericOwnerDispatch(consume)).dispatchAllowed).toBe(false);
  await ledger.purgeExpiredRetention(new Date(), 100);
  expect(await ledger.getRun(run.id)).toBeNull();
  expect((await ledger.getRecoveryControl(run.id))?.genericOwnerDispatch).toEqual(consumed.genericOwnerDispatch);
  expect((await ledger.consumeGenericOwnerDispatch(consume)).dispatchAllowed).toBe(false);
  expect(JSON.stringify(consumed.genericOwnerDispatch)).not.toContain(worker);
  const retained = (await ledger.getRecoveryControl(run.id))!;
  const pair = generateKeyPairSync("ed25519");
  const authority = { issuer: "test-deployment-controller", subject: "test-deployment-operator", key_id: "test-deployment-key",
    public_key_spki_base64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const dispatch = genericOwnerLossDispatchFromControl(retained);
  const now = new Date().toISOString();
  const snapshot = { serviceResponseSha256: sha256("service"), deployResponseSha256: sha256("deploy"), instanceResponseSha256: sha256("inventory"),
    deployIdSha256: sha256("deploy-id"), deployStatus: "live" };
  const unsigned = { schema: "sophia.voice-lab.generic-owner-loss-receipt.v1", receiptId: prepare.requestId,
    authority: "deployment_control", issuer: authority.issuer, subject: authority.subject, authorityKeyId: authority.key_id,
    audience: "sophia-voice-lab-generic-owner-loss", ...dispatch,
    expectedLabSha: "d".repeat(40), expectedLangGraphSha: "e".repeat(40),
    workerIdSha256: sha256(worker), browserLeaseEpoch: retained.browserAllocationBinding!.browser_lease_epoch,
    actionAcceptedResponseSha256: sha256("accepted"), actionHttpStatus: 200, actionAcceptedAt: now,
    before: { ...snapshot, instanceIdsSha256: [sha256(worker)], instanceCreatedAt: retained.binding.createdAt, observedAt: dispatch.actionRequestedAt },
    after: { ...snapshot, instanceIdsSha256: [sha256("replacement")], instanceCreatedAt: now, observedAt: now },
    providerCleanupProven: false, liveResourcesZeroProven: false, issuedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(),
    signatureAlgorithm: "ed25519-sha256-canonical-request-v1" };
  const receipt = { ...unsigned, signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), pair.privateKey).toString("base64url") };
  const ingestion = { runId: run.id, expectedVersion: retained.version, receipt, authority,
    expectedWorkerServiceIdSha256: sha256(service), expectedLabSha: unsigned.expectedLabSha, expectedLangGraphSha: unsigned.expectedLangGraphSha };
  await expect(ledger.persistGenericOwnerLoss({ ...ingestion, expectedVersion: retained.version + 1 })).rejects.toThrow();
  await expect(ledger.persistGenericOwnerLoss({ ...ingestion, receipt: { ...receipt, actionAcceptedResponseSha256: sha256("tampered") } })).rejects.toThrow();
  expect(await ledger.getRecoveryControl(run.id)).toEqual(retained);
  const ingested = await Promise.all(Array.from({ length: 8 }, () => ledger.persistGenericOwnerLoss(ingestion)));
  expect(ingested.filter(value => !value.replay)).toHaveLength(1);
  expect(new Set(ingested.map(value => value.proof.proofSha256)).size).toBe(1);
  const settledOwner = (await ledger.getRecoveryControl(run.id))!;
  expect(settledOwner.version).toBe(retained.version + 1);
  expect(parseVerifiedGenericOwnerLoss(settledOwner.genericOwnerLoss, settledOwner)).toEqual(ingested[0]!.proof);
  expect(settledOwner.liveCleanupComplete).toBe(false);
  expect(settledOwner.executionCleanupProof).toBeUndefined();
  expect(settledOwner.genericOwnerLoss).toMatchObject({ providerCleanupProven: false, liveResourcesZeroProven: false });
  await expect(ledger.persistGenericOwnerLoss({ ...ingestion, expectedLabSha: "f".repeat(40) })).rejects.toThrow();
  expect((await ledger.persistGenericOwnerLoss(ingestion)).replay).toBe(true);
  expect(await ledger.getRun(run.id)).toBeNull();
  const issued = Math.ceil(Date.parse(settledOwner.genericOwnerLoss!.acceptedAt) / 1000) + 1;
  const recovery = combinedRecoveryFixture(settledOwner, issued);
  const recoveryNow = new Date((issued + 1) * 1000);
  for (const component of ["canonical_session", "voice_provider", "auth_sessions", "builder"] as const) {
    const pending = structuredClone(recovery.event);
    pending.payload.receipt.components[component].status = "pending";
    await expect(ledger.settleRecoveryControl(run.id, settledOwner.version, pending, recovery.attempt)).rejects.toThrow();
  }
  const missingBuilder = structuredClone(recovery.event);
  missingBuilder.payload.receipt.components.builder.authoritative_zero_tasks = false;
  await expect(ledger.settleRecoveryControl(run.id, settledOwner.version, missingBuilder, recovery.attempt)).rejects.toThrow();
  expect(() => deriveRetainedGenericRecovery({ ...settledOwner, genericOwnerLoss: undefined }, recovery.event, recovery.attempt, recoveryNow)).toThrow();
  expect(() => deriveRetainedGenericRecovery({ ...settledOwner, binding: { ...settledOwner.binding, scenarioId: "V-D02" } }, recovery.event, recovery.attempt, recoveryNow)).toThrow();
  const old = combinedRecoveryFixture(settledOwner, issued - 10);
  expect(() => deriveRetainedGenericRecovery(settledOwner, old.event, old.attempt, recoveryNow)).toThrow(/PREDATES/);
  expect(() => deriveRetainedGenericRecovery(settledOwner, recovery.event, recovery.attempt, new Date((issued + 301) * 1000))).toThrow(/NOT_CURRENT/);
  const wrongAttempt = { ...recovery.attempt, attemptId: sha256("foreign") };
  await expect(ledger.settleRecoveryControl(run.id, settledOwner.version, recovery.event, wrongAttempt)).rejects.toThrow();
  await expect(ledger.settleRecoveryControl(run.id, settledOwner.version, recovery.event, recovery.attempt)).rejects.toThrow(/authorized|AUDIT_MISSING|exact durable ownership/);
  expect(await ledger.getRecoveryControl(run.id)).toEqual(settledOwner);
  await ledger.recordRecoveryCapabilityAudit(run.id, settledOwner.version, sha256("test-recovery-jti"), recoveryAttemptAuditHash(settledOwner, recovery.attempt));
  await expect(ledger.settleRecoveryControl(run.id, settledOwner.version + 1, recovery.event, recovery.attempt)).rejects.toThrow();
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => ledger.settleRecoveryControl(run.id, settledOwner.version, recovery.event, recovery.attempt)));
  expect(new Set(outcomes.map(value => value.version))).toEqual(new Set([settledOwner.version + 1]));
  const recovered = (await ledger.getRecoveryControl(run.id))!;
  expect(recovered.liveCleanupComplete).toBe(true);
  expect(parseRetainedGenericRecovery(recovered.genericRecoverySettlement, recovered)).toMatchObject({ ready: true, ownerLossProofSha256: settledOwner.genericOwnerLoss!.proofSha256 });
  expect(recovered.genericOwnerLoss).toEqual(settledOwner.genericOwnerLoss);
  expect(recovered.executionCleanupProof).toBeUndefined();
  expect(recovered.d02RecoverySettlement).toBeUndefined();
  expect(await ledger.getRun(run.id)).toBeNull();
}
