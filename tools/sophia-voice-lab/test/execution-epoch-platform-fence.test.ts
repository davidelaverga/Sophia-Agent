import { describe, expect, it } from "vitest";

import { deriveExecutionEpochCleanupProof, parsePreservedExecutionCleanupProof } from "../src/execution-cleanup.js";
import { testRun } from "./helpers.js";
import { BOOT, EPOCH, PROCESS, WORKER, auth, closed, ownership, platformTerminated, provider, recovery } from "./execution-cleanup-fixture.js";

/** Owner loss after an uncommanded restart: the browser can never author a
 * close, so a verified platform fence stands in its place. It never fabricates
 * cleanup.browser_context_closed and never implies provider/resource cleanup. */
describe("platform fence execution cleanup", () => {
  const base = (run = testRun()) => [...ownership(run), platformTerminated(run, 5), recovery(run, 6)];

  it("settles the acquired epoch from a verified platform termination", () => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, base(run));
    expect(proof.ready).toBe(true);
    expect(proof.reason).toBe("authoritative_platform_fence_after_owner_loss");
    expect(proof.executionEpochSha256).toBe(EPOCH);
    expect(proof.workerIdSha256).toBe(WORKER);
    expect(proof.eventSeqs.processClosed).toBeNull();
    expect(proof.eventSeqs.platformTerminated).toBe(5);
    expect(parsePreservedExecutionCleanupProof(proof)).toEqual(proof);
  });

  it("still prefers a genuine browser close when one exists", () => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), provider(run, 3), auth(run, 4), closed(run, 5)]);
    expect(proof.reason).toBe("direct_cleanup_before_process_death");
    expect(proof.eventSeqs.platformTerminated).toBeNull();
    expect(proof.eventSeqs.processClosed).toBe(5);
  });

  it("never satisfies the pre-death direct path", () => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), provider(run, 3), auth(run, 4), platformTerminated(run, 5), recovery(run, 6)]);
    expect(proof.ready).toBe(true);
    expect(proof.reason).toBe("authoritative_platform_fence_after_owner_loss");
  });

  it("requires downstream cleanup AFTER the termination", () => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), recovery(run, 3), platformTerminated(run, 5)]);
    expect(proof.ready).toBe(false);
    expect(proof.reason).toBe("provider_or_auth_cleanup_unconfirmed");
  });

  const rejects = [
    ["a different execution epoch", { execution_epoch_sha256: "b".repeat(64) }],
    ["a different process", { process_id_sha256: "c".repeat(64) }],
    ["a different browser boot", { browser_boot_id_sha256: "d".repeat(64) }],
    ["a different original owner", { original_worker_id_sha256: "e".repeat(64) }],
    ["a different lease epoch", { browser_lease_epoch: 8 }],
    ["mismatched acquisition ordinals", { process_acquired_seq: 2 }],
    ["an unobserved replacement", { owner_replacement_observed: false }],
    ["a fabricated browser close", { browser_context_closed_fabricated: true }],
    ["a provider-cleanup claim", { provider_cleanup_proven: true }],
    ["a resource-zero claim", { live_resources_zero_proven: true }],
    ["a missing fence proof digest", { service_owner_fence_proof_sha256: "not-a-digest" }],
    ["a missing ownership digest", { execution_ownership_proof_sha256: null }],
    ["a missing authority digest", { authority_public_key_sha256: undefined }],
  ] as const;

  it.each(rejects)("rejects %s", (_label, override) => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), platformTerminated(run, 5, override as Record<string, unknown>), recovery(run, 6)]);
    expect(proof.ready).toBe(false);
    expect(proof.reason).toBe("process_death_proof_invalid");
  });

  it("rejects a termination authored by the browser rather than canonically", () => {
    const run = testRun();
    const forged = platformTerminated(run, 5);
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), { ...forged, source: "browser" as const }, recovery(run, 6)]);
    expect(proof.ready).toBe(false);
    expect(proof.reason).toBe("process_death_proof_invalid");
  });

  it("rejects a termination that precedes runtime acquisition", () => {
    const run = testRun();
    const early = { ...platformTerminated(run, 5), seq: 2 };
    const events = [...ownership(run)];
    events[1] = { ...events[1]!, seq: 3 };
    const proof = deriveExecutionEpochCleanupProof(run, [...events, early, recovery(run, 6)]);
    expect(proof.ready).toBe(false);
  });

  it("rejects two competing terminations", () => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), platformTerminated(run, 5), platformTerminated(run, 6), recovery(run, 7)]);
    expect(proof.ready).toBe(false);
    expect(proof.reason).toBe("process_death_proof_invalid");
  });

  it("refuses a preserved proof that names neither close nor termination", () => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, base(run));
    expect(() => parsePreservedExecutionCleanupProof({ ...proof, eventSeqs: { ...proof.eventSeqs, platformTerminated: null } })).toThrow();
  });

  it("keeps historical two-reason proofs parseable", () => {
    const run = testRun();
    const legacy = deriveExecutionEpochCleanupProof(run, [...ownership(run), provider(run, 3), auth(run, 4), closed(run, 5)]);
    const { platformTerminated: _omitted, ...seqs } = legacy.eventSeqs;
    expect(parsePreservedExecutionCleanupProof({ ...legacy, eventSeqs: seqs }).reason).toBe("direct_cleanup_before_process_death");
  });
});

/** The platform-fence ordinal must never enter the hashed core of a path that
 * could already have produced a preserved proof. */
describe("preserved proof digest compatibility", () => {
  it("hashes a browser-close settlement exactly as the two-reason evaluator did", async () => {
    const { canonicalRequestHash, sha256 } = await import("../src/security.js");
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), provider(run, 3), auth(run, 4), closed(run, 5)]);
    const legacyCore = {
      run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      process_id_sha256: PROCESS, browser_boot_id_sha256: BOOT, execution_epoch_sha256: EPOCH,
      worker_id_sha256: WORKER, browser_lease_epoch: 7, cleanup_path: "direct",
      event_seqs: { processAcquired: 1, runtimeAcquired: 2, providerCleanup: 3, authCleanup: 4, processClosed: 5, recovery: null },
    };
    expect(proof.proofSha256).toBe(canonicalRequestHash(legacyCore));
  });

  it("hashes a recovery settlement exactly as the two-reason evaluator did", async () => {
    const { canonicalRequestHash, sha256 } = await import("../src/security.js");
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), closed(run, 3), recovery(run, 4)]);
    const legacyCore = {
      run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      process_id_sha256: PROCESS, browser_boot_id_sha256: BOOT, execution_epoch_sha256: EPOCH,
      worker_id_sha256: WORKER, browser_lease_epoch: 7, cleanup_path: "recovery",
      event_seqs: { processAcquired: 1, runtimeAcquired: 2, providerCleanup: null, authCleanup: null, processClosed: 3, recovery: 4 },
    };
    expect(proof.proofSha256).toBe(canonicalRequestHash(legacyCore));
  });

  it("includes the ordinal only on the fence path", async () => {
    const run = testRun();
    const fence = deriveExecutionEpochCleanupProof(run, [...ownership(run), platformTerminated(run, 5), recovery(run, 6)]);
    const close = deriveExecutionEpochCleanupProof(run, [...ownership(run), closed(run, 3), recovery(run, 4)]);
    expect(fence.eventSeqs.platformTerminated).toBe(5);
    expect(close.eventSeqs.platformTerminated).toBeNull();
    expect(fence.proofSha256).not.toBe(close.proofSha256);
  });
});

// C018: later legitimate recoveries must not regress a settled epoch, the
// preserved digest must not move, and intermediate failures keep typed provenance.
describe("repeated recovery and failure provenance", () => {
  const base = (run = testRun()) => [...ownership(run), platformTerminated(run, 5), recovery(run, 6)];
  it("stays ready with the earliest post-termination recovery when a later one arrives", () => {
    const run = testRun();
    const single = deriveExecutionEpochCleanupProof(run, base(run));
    const repeated = deriveExecutionEpochCleanupProof(run, [...base(run), recovery(run, 9)]);
    expect(repeated.ready).toBe(true);
    expect(repeated.reason).toBe("authoritative_platform_fence_after_owner_loss");
    expect(repeated.eventSeqs.recovery).toBe(6);
    // The preserved proof is compared by digest at lease release and in manifests.
    expect(repeated.proofSha256).toBe(single.proofSha256);
  });

  it("selects the earliest recovery by sequence, not by array order", () => {
    const run = testRun();
    const ordered = deriveExecutionEpochCleanupProof(run, [...ownership(run), platformTerminated(run, 5), recovery(run, 6), recovery(run, 9)]);
    const reversed = deriveExecutionEpochCleanupProof(run, [...ownership(run), platformTerminated(run, 5), recovery(run, 9), recovery(run, 6)]);
    expect(reversed).toEqual(ordered);
    expect(reversed.eventSeqs.recovery).toBe(6);
  });

  it("keeps the browser-close recovery digest when a later recovery arrives", () => {
    const run = testRun();
    const single = deriveExecutionEpochCleanupProof(run, [...ownership(run), closed(run, 5), recovery(run, 6)]);
    const repeated = deriveExecutionEpochCleanupProof(run, [...ownership(run), closed(run, 5), recovery(run, 6), recovery(run, 9)]);
    expect(single.reason).toBe("authoritative_recovery_after_process_death");
    expect(repeated).toEqual(single);
  });

  it("records the platform termination, never a process close, while downstream cleanup is pending", () => {
    const run = testRun();
    const pending = deriveExecutionEpochCleanupProof(run, [...ownership(run), platformTerminated(run, 5)]);
    expect(pending.ready).toBe(false);
    expect(pending.reason).toBe("provider_or_auth_cleanup_unconfirmed");
    expect(pending.eventSeqs.platformTerminated).toBe(5);
    expect(pending.eventSeqs.processClosed).toBeNull();
  });

  it("still records a genuine browser close while downstream cleanup is pending", () => {
    const run = testRun();
    const pending = deriveExecutionEpochCleanupProof(run, [...ownership(run), closed(run, 5)]);
    expect(pending.reason).toBe("provider_or_auth_cleanup_unconfirmed");
    expect(pending.eventSeqs.processClosed).toBe(5);
    expect(pending.eventSeqs.platformTerminated).toBeNull();
  });
});
