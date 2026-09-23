import { expect, it } from "vitest";
import { deriveExecutionEpochCleanupProof, parsePreservedExecutionCleanupProof, sameExecutionCleanupProof } from "../src/execution-cleanup.js";
import { canonicalRequestHash } from "../src/security.js";
import { testRun } from "./helpers.js";
import { completeExecutionCleanupFixture } from "./execution-cleanup-fixture.js";

/** The exact shape a 7d4-era (pre platform-fence) worker preserved: no
 * eventSeqs.platformTerminated key at all. */
function legacyV5(proof: ReturnType<typeof deriveExecutionEpochCleanupProof>) {
  const { platformTerminated: _absent, ...eventSeqs } = proof.eventSeqs;
  return parsePreservedExecutionCleanupProof({ ...proof, eventSeqs });
}

it("treats a legacy key-less close-path proof as the same immutable proof, with the same stable digest", () => {
  const run = testRun();
  const derived = deriveExecutionEpochCleanupProof(run, completeExecutionCleanupFixture(run, "legacy-owner", 1));
  expect(derived.ready).toBe(true);
  expect(derived.eventSeqs).toHaveProperty("platformTerminated", null);
  const legacy = legacyV5(derived);
  expect(legacy.eventSeqs).not.toHaveProperty("platformTerminated");
  expect(legacy.proofSha256).toBe(derived.proofSha256);
  // The reported conflict: the whole-object hash differs although nothing changed.
  expect(canonicalRequestHash(legacy)).not.toBe(canonicalRequestHash(derived));
  expect(sameExecutionCleanupProof(legacy, derived)).toBe(true);
  expect(sameExecutionCleanupProof(derived, derived)).toBe(true);
});

it("keeps every other binding exact, including a non-null fence ordinal", () => {
  const run = testRun();
  const derived = deriveExecutionEpochCleanupProof(run, completeExecutionCleanupFixture(run, "legacy-owner", 1));
  const legacy = legacyV5(derived);
  expect(sameExecutionCleanupProof(legacy, { ...derived, eventSeqs: { ...derived.eventSeqs, platformTerminated: 9 } })).toBe(false);
  expect(sameExecutionCleanupProof(legacy, { ...derived, proofSha256: "f".repeat(64) })).toBe(false);
  expect(sameExecutionCleanupProof(legacy, { ...derived, browserLeaseEpoch: derived.browserLeaseEpoch + 1 })).toBe(false);
  expect(sameExecutionCleanupProof(legacy, { ...derived, eventSeqs: { ...derived.eventSeqs, recovery: 99 } })).toBe(false);
  expect(sameExecutionCleanupProof(legacy, { ...derived, reason: "authoritative_recovery_after_process_death" })).toBe(false);
});
