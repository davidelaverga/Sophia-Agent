import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_MIGRATION_SHA256 } from "../src/migration-bundle.js";
import { joinHistoricalObligations } from "../src/historical-obligation-join.js";
import { retentionHmac } from "../src/retention-identity.js";
import { sha256 } from "../src/security.js";

const key = "synthetic-retention-authority-000000000000000";
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const fixture = () => ({ sourceMigrationSha256: BASE_MIGRATION_SHA256,
  enumerationComplete: true, tombstoneEnumerationComplete: true,
  runCount: "0", browserLeaseCount: "0", tombstoneCount: "1", unconfirmedTombstoneCount: "1", entries: [],
  tombstones: [{ lookupIdSha256: "a".repeat(64), recoveryIdSha256: sha256(retentionHmac(key, "recovery", id)),
    remotePurgeStatus: "unconfirmed", purgedAt: "2026-09-03T00:00:00.000Z", controlExpiresAt: "2026-10-03T00:00:00.000Z",
    assessment: "independent_historical_reconciliation_required" }] });

describe("historical obligation keyed join", () => {
  it("preserves existing retention v1 bytes for both domains", () => {
    for (const domain of ["lookup", "recovery"] as const) {
      expect(retentionHmac(key, domain, id)).toBe(createHmac("sha256", key).update(`sophia-voice-lab-retention-v1\n${domain}\n${id}`).digest("hex"));
    }
    expect(retentionHmac(key, "lookup", id)).not.toBe(retentionHmac(key, "recovery", id));
  });
  it("joins only the exact candidate without granting cleanup or exposing identifiers", () => {
    const result = joinHistoricalObligations(fixture(), [id, other], key);
    expect(result).toMatchObject({ sourceAuthenticated: false, ownershipProven: false, cleanupProven: false, upgradeAuthorized: false, unmatchedTombstones: [] });
    expect(result.entries).toContainEqual(expect.objectContaining({ cleanupObligationIdSha256: sha256(id), status: "keyed_identity_match" }));
    expect(result.entries).toContainEqual({ cleanupObligationIdSha256: sha256(other), status: "not_matched" });
    for (const secret of [key, id, other, retentionHmac(key, "recovery", id)]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(joinHistoricalObligations(fixture(), [other, id], key)).toEqual(result);
  });
  it("does not treat a wrong key or missing candidate as absence of resources", () => {
    for (const result of [joinHistoricalObligations(fixture(), [id], "wrong-key"), joinHistoricalObligations(fixture(), [], key)]) {
      expect(result.unmatchedTombstones).toEqual(["a".repeat(64)]);
      expect(result.cleanupProven).toBe(false);
      expect(result.upgradeAuthorized).toBe(false);
    }
  });
  it("refuses ambiguous recovery identity, duplicate candidates and partial inventories", () => {
    const f = fixture();
    expect(() => joinHistoricalObligations({ ...f, tombstoneCount: "2", unconfirmedTombstoneCount: "2",
      tombstones: [f.tombstones[0], { ...f.tombstones[0], lookupIdSha256: "b".repeat(64) }] }, [id], key)).toThrow("HISTORICAL_JOIN_AMBIGUOUS");
    expect(() => joinHistoricalObligations(f, [id, id], key)).toThrow("HISTORICAL_JOIN_INPUT_INVALID");
    expect(() => joinHistoricalObligations({ ...f, enumerationComplete: false }, [id], key)).toThrow();
  });
});
