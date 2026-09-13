import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { inventoryHistoricalQuarantine } from "../src/historical-quarantine-inventory.js";
import { VOICE_LAB_SCHEMA_VERSION, VOICE_LAB_MIGRATION_SHA256 } from "../src/schema-attestation.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";

const row = (id: string, status = "unconfirmed") => ({ lookup_id_hmac: id.repeat(64), recovery_id_hmac: "c".repeat(64),
  inventory_sha256: "d".repeat(64), remote_purge_status: status,
  source_purged_at: new Date("2020-01-01Z"), source_control_expires_at: new Date("2020-01-02Z"), quarantined_at: new Date("2026-09-13Z") });
function fixture(rows: ReturnType<typeof row>[], options: { count?: string; version?: number; checksum?: string } = {}) {
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes("select schema_version")) return { rows: [{ schema_version: options.version ?? VOICE_LAB_SCHEMA_VERSION, migration_sha256: options.checksum ?? VOICE_LAB_MIGRATION_SHA256 }] };
    if (sql.includes("count(*)")) return { rows: [{ count: options.count ?? String(rows.length), observed_at: new Date("2026-09-14Z") }] };
    if (sql.includes("select lookup_id_hmac")) return { rows: rows.slice(0, Number(args![0])) };
    if (["begin isolation level repeatable read read only", "set local statement_timeout = '15s'", "commit", "rollback"].includes(sql)) return { rows: [] };
    throw new Error("Unexpected inventory query");
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as pg.Pool, connect, query, release };
}
describe("durable quarantine diagnostic inventory", () => {
  it("reports expired-source obligations without exposing keyed locators or declaring confirmed purges settled", async () => {
    const f = fixture([row("a"), row("b", "confirmed")]);
    const result = await inventoryHistoricalQuarantine(f.pool);
    expect(result).toMatchObject({ quarantineCount: "2", enumerationComplete: true, historicalReconciliationRequired: true,
      cleanupProven: false, admissionAuthorized: false, upgradeAuthorized: false });
    expect(result.entries[0]).toMatchObject({ lookupIdSha256: sha256("a".repeat(64)), sourceInventorySha256: "d".repeat(64) });
    expect(result.entries[1]).toMatchObject({ remotePurgeStatus: "confirmed", assessment: "independent_historical_reconciliation_required" });
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${"a".repeat(64)}|${"c".repeat(64)}`));
    const { reportSha256, ...report } = result;
    expect(reportSha256).toBe(canonicalRequestHash(report));
    expect(f.query.mock.calls[0]![0]).toBe("begin isolation level repeatable read read only");
    expect(f.query.mock.calls.some(([sql]) => sql.includes("retention_tombstones"))).toBe(false);
    expect(f.query.mock.calls.at(-1)![0]).toBe("commit");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("marks bounded output incomplete", async () => {
    const result = await inventoryHistoricalQuarantine(fixture([row("a"), row("b")]).pool, 1);
    expect(result).toMatchObject({ quarantineCount: "2", enumerationComplete: false, admissionAuthorized: false });
    expect(result.entries).toHaveLength(1);
  });
  it("does not authorize admission or certify cleanup even for empty quarantine", async () => {
    expect(await inventoryHistoricalQuarantine(fixture([]).pool)).toMatchObject({ quarantineCount: "0", entries: [],
      enumerationComplete: true, historicalReconciliationRequired: false, admissionAuthorized: false, cleanupProven: false });
  });
  it.each([0, -1, 1.5, NaN, 10001])("rejects invalid bound %s before connecting", async bound => {
    const f = fixture([]);
    await expect(inventoryHistoricalQuarantine(f.pool, bound)).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([{ version: 3 }, { checksum: "a".repeat(64) }, { count: "2" }, { count: "-1" }])("rejects metadata/count drift %#", async options => {
    const f = fixture([row("a")], options);
    await expect(inventoryHistoricalQuarantine(f.pool)).rejects.toThrow();
    expect(f.query.mock.calls.at(-1)![0]).toBe("rollback");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([{ lookup_id_hmac: "invalid" }, { remote_purge_status: "unknown" }, { source_control_expires_at: new Date("2019-01-01Z") },
    { quarantined_at: new Date(NaN) }, { inventory_sha256: "invalid" }])("rejects malformed retained rows %#", async mutation => {
    const f = fixture([{ ...row("a"), ...mutation }]);
    await expect(inventoryHistoricalQuarantine(f.pool)).rejects.toThrow();
    expect(f.query.mock.calls.at(-1)![0]).toBe("rollback");
  });
  it("rejects duplicate identities", async () => {
    await expect(inventoryHistoricalQuarantine(fixture([row("a"), row("a")]).pool)).rejects.toThrow("QUARANTINE_INVENTORY_INCONSISTENT");
  });
});
