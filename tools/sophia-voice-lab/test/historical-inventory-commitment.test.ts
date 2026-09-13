import { describe, expect, it } from "vitest";
import { historicalInventoryCommitment } from "../src/historical-inventory-commitment.js";
import { BASE_MIGRATION_SHA256 } from "../src/migration-bundle.js";

const row = (id: string) => ({ lookupIdSha256: id.repeat(64), recoveryIdSha256: "c".repeat(64),
  remotePurgeStatus: "unconfirmed", purgedAt: "2026-09-03T00:00:00.000Z",
  controlExpiresAt: "2026-10-03T00:00:00.000Z", assessment: "independent_historical_reconciliation_required" });
const fixture = () => ({ sourceMigrationSha256: BASE_MIGRATION_SHA256,
  enumerationComplete: true, tombstoneEnumerationComplete: true,
  runCount: "0", browserLeaseCount: "0", tombstoneCount: "2", unconfirmedTombstoneCount: "2",
  entries: [], tombstones: [row("a"), row("b")] });

describe("complete historical inventory commitment", () => {
  it("is stable across ordering, without modifying the source", () => {
    const value = fixture();
    const reversed = { ...value, tombstones: [...value.tombstones].reverse() };
    expect(historicalInventoryCommitment(reversed)).toBe(historicalInventoryCommitment(value));
    expect(reversed.tombstones[0]!.lookupIdSha256).toBe("b".repeat(64));
  });
  it.each(["lookupIdSha256", "recoveryIdSha256", "purgedAt", "controlExpiresAt"])("binds every erased identity field: %s", field => {
    const original = fixture();
    const altered = fixture();
    Object.assign(altered.tombstones[0]!, { [field]: field.endsWith("Sha256") ? "d".repeat(64) : "2026-09-15T00:00:00.000Z" });
    expect(historicalInventoryCommitment(altered)).not.toBe(historicalInventoryCommitment(original));
  });
  it("binds purge status and lease count without asserting cleanup", () => {
    const original = fixture();
    const changed = fixture();
    changed.tombstones[0]!.remotePurgeStatus = "confirmed";
    changed.unconfirmedTombstoneCount = "1";
    expect(historicalInventoryCommitment(changed)).not.toBe(historicalInventoryCommitment(original));
    expect(historicalInventoryCommitment({ ...original, browserLeaseCount: "1" })).not.toBe(historicalInventoryCommitment(original));
  });
  it.each([
    { enumerationComplete: false }, { tombstoneEnumerationComplete: false },
    { tombstoneCount: "3" }, { runCount: "1" }, { unconfirmedTombstoneCount: "0" },
    { browserLeaseCount: "-1" }, { sourceMigrationSha256: "f".repeat(64) },
    { tombstones: [row("a"), row("a")] }, { upgradeAuthorized: true },
  ])("rejects partial, foreign or conflicting input %#", change => {
    expect(() => historicalInventoryCommitment({ ...fixture(), ...change })).toThrow();
  });
  it("binds retained run assessments and rejects duplicate run identities", () => {
    const entry = { runIdSha256: "e".repeat(64), assessment: "historical_allocation_unknown" };
    const input = { ...fixture(), runCount: "1", entries: [entry] };
    const changed = { ...input, entries: [{ ...entry, assessment: "historical_identity_invalid" }] };
    expect(historicalInventoryCommitment(input)).not.toBe(historicalInventoryCommitment(changed));
    expect(() => historicalInventoryCommitment({ ...input, runCount: "2", entries: [entry, entry] })).toThrow();
    expect(() => historicalInventoryCommitment({ ...input, entries: [{ ...entry, assessment: "historical_event_bound_exceeded" }] })).toThrow();
  });
});
