import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GenericOwnerLossReceiptSchema, verifyGenericOwnerLoss, ingestGenericOwnerLoss, parseVerifiedGenericOwnerLoss, type GenericOwnerLossReceipt } from "../src/generic-owner-loss.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { deriveRecoveryBrowserBinding, projectRecoveryControlBinding, type RecoveryControlRecord } from "../src/recovery-control.js";
import { testRun } from "./helpers.js";
import { prepareGenericOwnerDispatch, consumeGenericOwnerDispatch, genericOwnerLossDispatchFromControl } from "../src/generic-owner-dispatch.js";

function fixture() {
  const pair = generateKeyPairSync("ed25519");
  const now = Date.now();
  const at = (delta: number) => new Date(now + delta).toISOString();
  const run = testRun();
  run.createdAt = new Date(now - 10_000);
  const binding = projectRecoveryControlBinding(run, `cp1:test:${"a".repeat(64)}`);
  const allocation = deriveRecoveryBrowserBinding(run.id, "reserved-render-owner", 1);
  const control: RecoveryControlRecord = { binding, browserAllocationEver: true, browserAllocationBinding: allocation,
    version: 2, liveCleanupComplete: false, remotePurgeComplete: false, retentionPurgeDueAt: null, contentPurgedAt: new Date(now - 1000) };
  const prepared = prepareGenericOwnerDispatch(control, { runId: run.id, expectedVersion: control.version, requestId: run.id, workerServiceId: "srv-0123456789abcdefghij" }, new Date(now - 550));
  control.genericOwnerDispatch = prepared;
  control.version++;
  control.genericOwnerDispatch = consumeGenericOwnerDispatch(control, { runId: run.id, expectedVersion: control.version, preparedProofSha256: prepared.proofSha256 }, new Date(now - 500));
  control.version++;
  const dispatch = genericOwnerLossDispatchFromControl(control);
  const authority = { issuer: "test-deployment-controller", subject: "test-deployment-operator", key_id: "test-deployment-key", public_key_spki_base64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const snapshot = { serviceResponseSha256: sha256("service"), deployResponseSha256: sha256("deploy"), instanceResponseSha256: sha256("instances"),
    deployIdSha256: sha256("deploy-id"), deployStatus: "live" as const };
  const unsigned: Omit<GenericOwnerLossReceipt, "signature"> = {
    schema: "sophia.voice-lab.generic-owner-loss-receipt.v1", receiptId: run.id,
    authority: "deployment_control", issuer: authority.issuer, subject: authority.subject, authorityKeyId: authority.key_id,
    audience: "sophia-voice-lab-generic-owner-loss",
    controlBindingSha256: canonicalRequestHash(binding), allocationBindingSha256: canonicalRequestHash(allocation),
    expectedLabSha: "d".repeat(40), expectedLangGraphSha: "e".repeat(40),
    workerServiceIdSha256: dispatch.workerServiceIdSha256, workerIdSha256: allocation.browser_worker_id_sha256, browserLeaseEpoch: 1,
    dispatchClaimSha256: dispatch.dispatchClaimSha256, actionRequestSha256: dispatch.actionRequestSha256, actionAcceptedResponseSha256: sha256("response"), actionHttpStatus: 200,
    actionRequestedAt: at(-500), actionAcceptedAt: at(-400),
    before: { ...snapshot, instanceIdsSha256: [allocation.browser_worker_id_sha256], instanceCreatedAt: at(-10000), observedAt: at(-600) },
    after: { ...snapshot, instanceResponseSha256: sha256("replacement-inventory"), instanceIdsSha256: [sha256("replacement")], instanceCreatedAt: at(-300), observedAt: at(-200) },
    providerCleanupProven: false, liveResourcesZeroProven: false, issuedAt: at(-100), expiresAt: at(60_000), signatureAlgorithm: "ed25519-sha256-canonical-request-v1",
  };
  const signed = (value = unsigned) => ({ ...value, signature: sign(null, Buffer.from(canonicalRequestHash(value), "hex"), pair.privateKey).toString("base64url") });
  const input = { control, receipt: signed(), authority, expectedWorkerServiceIdSha256: unsigned.workerServiceIdSha256, expectedLabSha: unsigned.expectedLabSha, expectedLangGraphSha: unsigned.expectedLangGraphSha, acceptedAt: new Date(now) };
  return { input, unsigned, signed, at };
}

describe("generic retained owner-loss source verification", () => {
  it("replays an accepted receipt after expiry but never admits an expired first receipt", () => {
    const { input, at } = fixture();
    const ingestion = { ...input, runId: input.control.binding.runId, expectedVersion: input.control.version };
    const initial = ingestGenericOwnerLoss(input.control, ingestion, input.acceptedAt);
    const stored = { ...input.control, genericOwnerLoss: initial.proof, version: initial.version };
    const later = new Date(at(120000));
    expect(ingestGenericOwnerLoss(stored, ingestion, later)).toEqual({ ...initial, replay: true });
    expect(() => ingestGenericOwnerLoss(input.control, ingestion, later)).toThrow(/TIME/);
    expect(stored.liveCleanupComplete).toBe(false);
  });
  it("rejects retained proof mutation and cross-control rebinding", () => {
    const { input } = fixture();
    const proof = verifyGenericOwnerLoss(input);
    expect(() => parseVerifiedGenericOwnerLoss({ ...proof, acceptedAt: new Date(0).toISOString() }, input.control)).toThrow();
    const other = fixture();
    expect(() => parseVerifiedGenericOwnerLoss(proof, other.input.control)).toThrow(/BINDING/);
  });
  it("verifies reservation-only owner loss after content purge without granting provider settlement", () => {
    const { input } = fixture();
    const before = JSON.stringify(input.control);
    const proof = verifyGenericOwnerLoss(input);
    expect(proof).toMatchObject({ workerIdSha256: input.receipt.workerIdSha256, providerCleanupProven: false, liveResourcesZeroProven: false });
    expect(JSON.stringify(input.control)).toBe(before);
    expect(input.control.executionOwnership).toBeUndefined();
    expect(JSON.stringify(proof)).not.toContain(input.control.binding.runId);
  });
  it.each(["controlBindingSha256", "allocationBindingSha256", "workerServiceIdSha256", "dispatchClaimSha256", "actionRequestSha256"] as const)("rejects correctly signed %s drift", field => {
    const { input, unsigned, signed } = fixture();
    expect(() => verifyGenericOwnerLoss({ ...input, receipt: signed({ ...unsigned, [field]: sha256("foreign") }) })).toThrow();
  });
  it("rejects altered signatures and wrong authority keys", () => {
    const { input } = fixture();
    expect(() => verifyGenericOwnerLoss({ ...input, receipt: { ...input.receipt, actionRequestSha256: sha256("tamper") } })).toThrow(/SIGNATURE/);
    const other = fixture();
    expect(() => verifyGenericOwnerLoss({ ...input, authority: other.input.authority })).toThrow(/SIGNATURE/);
  });
  it("rejects unchanged, multiple, or pre-existing replacement owners", () => {
    const { input, unsigned, signed, at } = fixture();
    for (const after of [
      { ...unsigned.after, instanceIdsSha256: unsigned.before.instanceIdsSha256 },
      { ...unsigned.after, instanceIdsSha256: [...unsigned.after.instanceIdsSha256, sha256("extra")] },
      { ...unsigned.after, instanceCreatedAt: at(-1000) },
    ]) expect(() => verifyGenericOwnerLoss({ ...input, receipt: signed({ ...unsigned, after }) })).toThrow();
  });
  it("rejects premature, expired, and overlong receipts", () => {
    const { input, unsigned, signed, at } = fixture();
    expect(() => verifyGenericOwnerLoss({ ...input, acceptedAt: new Date(at(-150)) })).toThrow(/TIME/);
    expect(() => verifyGenericOwnerLoss({ ...input, acceptedAt: new Date(at(60_000)) })).toThrow(/TIME/);
    expect(() => verifyGenericOwnerLoss({ ...input, receipt: signed({ ...unsigned, expiresAt: at(1_000_000) }) })).toThrow();
  });
  it("never replaces D02 authority, invents allocation, or accepts cleanup booleans", () => {
    const { input } = fixture();
    expect(() => verifyGenericOwnerLoss({ ...input, control: { ...input.control, binding: { ...input.control.binding, scenarioId: "V-D02" } } })).toThrow(/AUTHORITY/);
    expect(() => verifyGenericOwnerLoss({ ...input, control: { ...input.control, browserAllocationBinding: undefined } })).toThrow();
    expect(GenericOwnerLossReceiptSchema.safeParse({ ...input.receipt, providerCleanupProven: true }).success).toBe(false);
    expect(GenericOwnerLossReceiptSchema.safeParse({ ...input.receipt, liveResourcesZeroProven: true }).success).toBe(false);
  });
});
