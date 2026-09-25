import { describe, expect, it } from "vitest";

import { isVerifiedServiceOwnerFenceV2, parseVerifiedServiceOwnerFence, verifyServiceOwnerFence } from "../src/service-owner-fence.js";
import { serviceOwnerFenceFixture, serviceOwnerFenceV2Fixture } from "./service-owner-fence-fixture.js";
import { renderInventoryInstanceId } from "../src/worker-identity.js";
import { sha256 } from "../src/security.js";

describe("service owner fence v2", () => {
  it("admits an original-owner-present replacement and retains the exact ownership", () => {
    const { inputV2, ownership } = serviceOwnerFenceV2Fixture();
    const proof = verifyServiceOwnerFence(inputV2 as never);
    expect(proof.schema).toBe("sophia.voice-lab.verified-service-owner-fence.v2");
    expect(isVerifiedServiceOwnerFenceV2(proof)).toBe(true);
    if (!isVerifiedServiceOwnerFenceV2(proof)) throw new Error("unreachable");
    expect(proof.executionOwnershipProofSha256).toBe(ownership.proofSha256);
    expect(proof.executionEpochSha256).toBe(ownership.executionEpochSha256);
    expect(proof.processIdSha256).toBe(ownership.processIdSha256);
    expect(proof.browserBootIdSha256).toBe(ownership.browserBootIdSha256);
    expect(proof.processAcquiredSeq).toBe(ownership.processAcquiredSeq);
    expect(proof.runtimeAcquiredSeq).toBe(ownership.runtimeAcquiredSeq);
    // Owner loss is never cleanup.
    expect(proof.providerCleanupProven).toBe(false);
    expect(proof.liveResourcesZeroProven).toBe(false);
    expect(parseVerifiedServiceOwnerFence(proof, inputV2.control)).toEqual(proof);
  });

  it("keeps v1 behaviour byte-identical, including against a control that has ownership", () => {
    const v1 = serviceOwnerFenceFixture();
    expect(verifyServiceOwnerFence(v1.input as never).schema).toBe("sophia.voice-lab.verified-service-owner-fence.v1");
    const { input, ownership } = serviceOwnerFenceV2Fixture();
    void ownership;
    expect(verifyServiceOwnerFence(input as never).schema).toBe("sophia.voice-lab.verified-service-owner-fence.v1");
  });

  it("refuses v2 when the original owner was already absent before the action", () => {
    const { unsignedV2, signed, inputV2 } = serviceOwnerFenceV2Fixture();
    const absent = { ...unsignedV2, before: { ...unsignedV2.before, instanceIdsSha256: ["f".repeat(64)] } };
    expect(() => verifyServiceOwnerFence({ ...inputV2, receipt: signed(absent as never) } as never)).toThrow();
  });

  it("refuses v2 when the original owner survived the action", () => {
    const { unsignedV2, signed, inputV2, owner } = serviceOwnerFenceV2Fixture();
    const survivedHash = sha256(renderInventoryInstanceId(owner)!);
    const survived = { ...unsignedV2, after: { ...unsignedV2.after, instanceIdsSha256: [survivedHash] } };
    expect(() => verifyServiceOwnerFence({ ...inputV2, receipt: signed(survived as never) } as never)).toThrow();
  });

  /** Render's inventory omits the replica-set segment, so the full ownership
   * hash and the inventory hash are different strings for the SAME pod. The
   * real observed pair is srv-...-65566bc6c7-2gj6p vs srv-...-2gj6p. */
  it("uses the supported inventory projection, not the full identity hash", () => {
    const { unsignedV2, owner } = serviceOwnerFenceV2Fixture();
    const inventoryId = renderInventoryInstanceId(owner);
    expect(inventoryId).toBe(`${owner.slice(0, 24)}-2gj6p`);
    expect(inventoryId).not.toBe(owner);
    expect(sha256(inventoryId!)).not.toBe(unsignedV2.workerIdSha256);
    // The accepted receipt binds the projection in `before`, and the full
    // identity separately in workerIdSha256.
    expect(unsignedV2.before.instanceIdsSha256[0]).toBe(sha256(inventoryId!));
    expect(unsignedV2.workerIdSha256).toBe(sha256(owner));
  });

  it("refuses a v2 receipt whose pre-action snapshot carries the full identity hash", () => {
    const { unsignedV2, signed, inputV2 } = serviceOwnerFenceV2Fixture();
    const confused = { ...unsignedV2, before: { ...unsignedV2.before, instanceIdsSha256: [unsignedV2.workerIdSha256] } };
    expect(() => verifyServiceOwnerFence({ ...inputV2, receipt: signed(confused as never) } as never)).toThrow(/present before and replaced after/);
  });

  it("refuses a v2 receipt whose owner has no supported projection", () => {
    const { unsignedV2, signed, inputV2 } = serviceOwnerFenceV2Fixture();
    const unprojectable = { ...unsignedV2, allocatedWorkerId: `${unsignedV2.allocatedWorkerId.slice(0, 24)}-NOTAVALIDSHAPE` };
    expect(() => verifyServiceOwnerFence({ ...inputV2, receipt: signed(unprojectable as never) } as never)).toThrow();
  });

  it("refuses v2 when the control retains no execution ownership", () => {
    const { inputV2 } = serviceOwnerFenceV2Fixture();
    const control = { ...inputV2.control };
    delete (control as { executionOwnership?: unknown }).executionOwnership;
    expect(() => verifyServiceOwnerFence({ ...inputV2, control } as never)).toThrow(/OWNERSHIP_MISSING/);
  });

  const drifts = [
    ["execution epoch", { executionEpochSha256: "1".repeat(64) }],
    ["process", { processIdSha256: "1".repeat(64) }],
    ["browser boot", { browserBootIdSha256: "1".repeat(64) }],
    ["ownership digest", { executionOwnershipProofSha256: "1".repeat(64) }],
    ["acquisition ordinal", { processAcquiredSeq: 1, runtimeAcquiredSeq: 3 }],
  ] as const;

  it.each(drifts)("refuses a v2 receipt whose %s does not match retained ownership", (_label, override) => {
    const { unsignedV2, signed, inputV2 } = serviceOwnerFenceV2Fixture();
    const drifted = { ...unsignedV2, ...(override as Record<string, unknown>) };
    expect(() => verifyServiceOwnerFence({ ...inputV2, receipt: signed(drifted as never) } as never)).toThrow(/OWNERSHIP_INVALID/);
  });

  it("refuses inverted acquisition ordinals at the schema boundary", () => {
    const { unsignedV2, signed, inputV2 } = serviceOwnerFenceV2Fixture();
    const inverted = { ...unsignedV2, processAcquiredSeq: unsignedV2.runtimeAcquiredSeq, runtimeAcquiredSeq: unsignedV2.processAcquiredSeq };
    expect(() => verifyServiceOwnerFence({ ...inputV2, receipt: signed(inverted as never) } as never)).toThrow(/acquisition order invalid/);
  });

  it("refuses a v2 receipt whose signature does not cover the added bindings", () => {
    const { unsignedV2, signed, inputV2 } = serviceOwnerFenceV2Fixture();
    const tampered = { ...signed(unsignedV2 as never), executionEpochSha256: "2".repeat(64) };
    expect(() => verifyServiceOwnerFence({ ...inputV2, receipt: tampered } as never)).toThrow(/SIGNATURE_INVALID/);
  });

  it("refuses a v2 receipt presented for another service", () => {
    const { inputV2 } = serviceOwnerFenceV2Fixture();
    expect(() => verifyServiceOwnerFence({ ...inputV2, expectedWorkerServiceIdSha256: "3".repeat(64) } as never)).toThrow(/ALLOCATION_INVALID/);
  });

  it("refuses a retained v2 proof re-bound to a control without ownership", () => {
    const { inputV2 } = serviceOwnerFenceV2Fixture();
    const proof = verifyServiceOwnerFence(inputV2 as never);
    const control = { ...inputV2.control };
    delete (control as { executionOwnership?: unknown }).executionOwnership;
    expect(() => parseVerifiedServiceOwnerFence(proof, control)).toThrow(/OWNERSHIP_MISSING/);
  });

  it("refuses a retained v2 proof whose digest was edited", () => {
    const { inputV2 } = serviceOwnerFenceV2Fixture();
    const proof = verifyServiceOwnerFence(inputV2 as never);
    expect(() => parseVerifiedServiceOwnerFence({ ...proof, executionEpochSha256: "4".repeat(64) }, inputV2.control)).toThrow();
  });
});
