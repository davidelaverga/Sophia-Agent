import { expect, it } from "vitest";
import { ServiceOwnerFenceReceiptSchema, verifyServiceOwnerFence, serviceFenceSourceLabSha, type ServiceOwnerFenceReceipt } from "../src/service-owner-fence.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { ingestGenericOwnerLoss, parseVerifiedGenericOwnerLoss } from "../src/generic-owner-loss.js";
import { serviceOwnerFenceFixture } from "./service-owner-fence-fixture.js";

const fixture = serviceOwnerFenceFixture;

it("requires an exact configured immutable receipt for cross-verifier source-version compatibility", () => {
  const f = fixture(), current = 'a'.repeat(40), digest = canonicalRequestHash(f.input.receipt);
  expect(serviceFenceSourceLabSha(f.input.receipt, current)).toBe(current);
  expect(serviceFenceSourceLabSha(f.input.receipt, current, 'b'.repeat(64))).toBe(current);
  expect(serviceFenceSourceLabSha(f.input.receipt, current, digest)).toBe(f.unsigned.expectedLabSha);
  expect(verifyServiceOwnerFence({ ...f.input, expectedLabSha: serviceFenceSourceLabSha(f.input.receipt, current, digest) })).toBeDefined();
  const tampered = { ...f.input.receipt, signature: 'a'.repeat(86) };
  expect(() => verifyServiceOwnerFence({ ...f.input, receipt: tampered, expectedLabSha: serviceFenceSourceLabSha(tampered, current, canonicalRequestHash(tampered)) })).toThrow();
  expect(() => verifyServiceOwnerFence({ ...f.input, expectedLabSha: serviceFenceSourceLabSha(f.input.receipt, current, digest), acceptedAt: new Date(f.unsigned.expiresAt) })).toThrow();
});

it("verifies a distinct recorded service restart without rewriting or settling the old allocation", () => {
  const f = fixture(); const original = JSON.stringify(f.input.control);
  const proof = verifyServiceOwnerFence(f.input);
  expect(proof).toMatchObject({ workerIdSha256: f.unsigned.workerIdSha256, providerCleanupProven: false, liveResourcesZeroProven: false });
  expect(JSON.stringify(proof)).not.toContain(f.unsigned.allocatedWorkerId);
  expect(JSON.stringify(f.input.control)).toBe(original);
});
it.each(["controlBindingSha256", "allocationBindingSha256", "workerServiceIdSha256", "dispatchClaimSha256", "actionRequestSha256", "workerIdSha256"] as const)("rejects correctly signed %s drift", field => {
  const f = fixture();
  expect(() => verifyServiceOwnerFence({ ...f.input, receipt: f.signed({ ...f.unsigned, [field]: sha256("foreign") }) })).toThrow();
});
it("accepts a real restart replacement within the same deployment", () => {
  const f = fixture(); const r = structuredClone(f.unsigned);
  r.after.deployIdSha256 = r.before.deployIdSha256;
  expect(verifyServiceOwnerFence({ ...f.input, receipt: f.signed(r) }).liveResourcesZeroProven).toBe(false);
  r.after.instanceIdsSha256 = r.before.instanceIdsSha256;
  expect(() => verifyServiceOwnerFence({ ...f.input, receipt: f.signed(r) })).toThrow();
});
it.each(["original-before", "original-after", "unchanged-owner", "overlap", "stale-before", "old-after", "multiple", "failed-action"])("rejects %s source claims", kind => {
  const f = fixture(); const r = structuredClone(f.unsigned);
  if (kind === "original-before") r.before.instanceIdsSha256 = [r.workerIdSha256];
  if (kind === "original-after") r.after.instanceIdsSha256 = [r.workerIdSha256];
  if (kind === "unchanged-owner") r.after.instanceIdsSha256 = r.before.instanceIdsSha256;
  if (kind === "overlap") r.after.observedAt = f.at(362999).toISOString();
  if (kind === "stale-before") r.before.observedAt = f.at(-14000).toISOString();
  if (kind === "old-after") r.after.instanceCreatedAt = f.at(1000).toISOString();
  if (kind === "multiple") r.after.instanceIdsSha256.push(sha256("extra"));
  if (kind === "failed-action") Object.assign(r, { actionHttpStatus: 503 });
  expect(() => verifyServiceOwnerFence({ ...f.input, receipt: f.signed(r) })).toThrow();
});
it("rejects signature, service association, release, expiry and D02 substitution", () => {
  const f = fixture();
  expect(() => verifyServiceOwnerFence({ ...f.input, receipt: { ...f.input.receipt, actionAcceptedResponseSha256: sha256("tampered") } })).toThrow(/SIGNATURE/);
  const raw = { ...f.unsigned, allocatedWorkerId: "srv-abcdefghij0123456789-original-pod" };
  expect(() => verifyServiceOwnerFence({ ...f.input, receipt: f.signed(raw) })).toThrow(/ALLOCATION/);
  expect(() => verifyServiceOwnerFence({ ...f.input, expectedRecoveryDeployment: { ...f.unsigned.expectedRecoveryDeployment, voice: "f".repeat(40) } })).toThrow(/RELEASE/);
  expect(() => verifyServiceOwnerFence({ ...f.input, acceptedAt: new Date(f.unsigned.expiresAt) })).toThrow(/TIME/);
  expect(() => verifyServiceOwnerFence({ ...f.input, control: { ...f.input.control, binding: { ...f.input.control.binding, scenarioId: "V-D02" } } })).toThrow(/SCOPE/);
  expect(() => ServiceOwnerFenceReceiptSchema.parse({ ...f.input.receipt, providerCleanupProven: true })).toThrow();
});

it("cannot replace a missing or unconsumed durable restart with inventory absence", () => {
  const f = fixture();
  const missing = structuredClone(f.input.control);
  delete missing.genericOwnerDispatch;
  expect(() => verifyServiceOwnerFence({ ...f.input, control: missing })).toThrow();
  const unconsumed = structuredClone(f.input.control);
  const { proofSha256: _proof, ...core } = unconsumed.genericOwnerDispatch!;
  core.consumedAt = null;
  unconsumed.genericOwnerDispatch = { ...core, proofSha256: canonicalRequestHash(core) };
  expect(() => verifyServiceOwnerFence({ ...f.input, control: unconsumed })).toThrow(/NOT_CONSUMED/);
});

it("admits once under CAS and replays immutable source bytes even after settlement and expiry", () => {
  const f = fixture();
  const input = { ...f.input, runId: f.input.control.binding.runId, expectedVersion: f.input.control.version };
  const first = ingestGenericOwnerLoss(f.input.control, input, f.input.acceptedAt);
  expect(first.replay).toBe(false);
  expect(first.version).toBe(f.input.control.version + 1);
  const stored = { ...f.input.control, version: first.version, genericOwnerLoss: first.proof, liveCleanupComplete: true };
  const later = f.at(1000000);
  expect(ingestGenericOwnerLoss(stored, input, later)).toEqual({ ...first, replay: true });
  expect(parseVerifiedGenericOwnerLoss(stored.genericOwnerLoss, stored)).toEqual(first.proof);
  expect(() => ingestGenericOwnerLoss(f.input.control, input, later)).toThrow(/TIME/);
  expect(() => ingestGenericOwnerLoss({ ...f.input.control, liveCleanupComplete: true }, input, f.input.acceptedAt)).toThrow(/ALREADY_SETTLED/);
  expect(() => ingestGenericOwnerLoss(f.input.control, { ...input, expectedVersion: input.expectedVersion + 1 }, f.input.acceptedAt)).toThrow(/VERSION_CONFLICT/);
  expect(() => ingestGenericOwnerLoss(stored, { ...input, receipt: f.signed({ ...f.unsigned, actionAcceptedResponseSha256: sha256("changed") }) }, later)).toThrow(/IMMUTABLE/);
});

it("rejects retained hash mutation, cross-allocation reuse and missing recovery pins", () => {
  const f = fixture(); const proof = verifyServiceOwnerFence(f.input);
  expect(() => parseVerifiedGenericOwnerLoss({ ...proof, acceptedAt: f.at(100).toISOString() }, f.input.control)).toThrow(/PROOF_INVALID/);
  const other = fixture();
  expect(() => parseVerifiedGenericOwnerLoss(proof, other.input.control)).toThrow(/BINDING/);
  const { expectedRecoveryDeployment: _pins, ...input } = f.input;
  expect(() => ingestGenericOwnerLoss(f.input.control, { ...input, runId: f.input.control.binding.runId, expectedVersion: f.input.control.version }, f.input.acceptedAt)).toThrow(/RELEASE_REQUIRED/);
});
