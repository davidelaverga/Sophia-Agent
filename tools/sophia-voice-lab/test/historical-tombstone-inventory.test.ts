import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { CallerPartitioner } from "../src/caller-partition.js";
import { BASE_MIGRATION_SHA256 } from "../src/migration-bundle.js";
import { inventoryHistoricalRecovery } from "../src/recovery-backfill-inventory.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";

const partitions = new CallerPartitioner({ activeKeyId: "test", keys: { test: "synthetic-inventory-key-000000000000000000" } });
const tombstone = (id: string, status = "unconfirmed") => ({ lookup_id_hmac: id.repeat(64), recovery_id_hmac: "c".repeat(64),
  remote_purge_status: status, purged_at: new Date("2026-09-13T00:00:00Z"), control_expires_at: new Date("2026-09-14T00:00:00Z") });

function fixture(erased: ReturnType<typeof tombstone>[]) {
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes("select schema_version")) return { rows: [{ schema_version: 3, migration_sha256: BASE_MIGRATION_SHA256 }] };
    if (sql.includes("transaction_timestamp")) return { rows: [{ runs: "0", leases: "0", tombstones: String(erased.length),
      unconfirmed_tombstones: String(erased.filter(t => t.remote_purge_status === "unconfirmed").length), observed_at: new Date("2026-09-13T01:00:00Z") }] };
    if (sql.startsWith("select * from sophia_voice_lab.runs")) return { rows: [] };
    if (sql.includes("select lookup_id_hmac")) return { rows: erased.slice(0, Number(args![0])) };
    if (["begin isolation level repeatable read read only", "set local statement_timeout = '15s'", "commit", "rollback"].includes(sql)) return { rows: [] };
    throw new Error("Unexpected inventory statement");
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as pg.Pool, query, release, connect };
}

describe("historical erased-run inventory", () => {
  it("enumerates erased identities despite zero raw runs without exporting keyed lookup IDs", async () => {
    const f = fixture([tombstone("a"), tombstone("b", "confirmed")]);
    const result = await inventoryHistoricalRecovery(f.pool, partitions);
    expect(result).toMatchObject({ runCount: "0", tombstoneCount: "2", enumerationComplete: true,
      tombstoneEnumerationComplete: true, upgradeAuthorized: false, historicalReconciliationRequired: true,
      tombstones: [
        { lookupIdSha256: sha256("a".repeat(64)), remotePurgeStatus: "unconfirmed", assessment: "independent_historical_reconciliation_required" },
        { lookupIdSha256: sha256("b".repeat(64)), remotePurgeStatus: "confirmed", assessment: "independent_historical_reconciliation_required" },
      ] });
    expect(JSON.stringify(result)).not.toContain("a".repeat(64));
    expect(JSON.stringify(result)).not.toContain("c".repeat(64));
    const { reportSha256, ...report } = result;
    expect(reportSha256).toBe(canonicalRequestHash(report));
    expect(result.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.query.mock.calls[0]![0]).toBe("begin isolation level repeatable read read only");
    expect(f.query.mock.calls.at(-1)![0]).toBe("commit");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("does not report complete enumeration when erased entries exceed their independent bound", async () => {
    const f = fixture([tombstone("a"), tombstone("b")]);
    const result = await inventoryHistoricalRecovery(f.pool, partitions, 1000, 10_000, 1);
    expect(result).toMatchObject({ runCount: "0", tombstoneCount: "2", enumerationComplete: false,
      tombstoneEnumerationComplete: false, historicalReconciliationRequired: true, upgradeAuthorized: false });
    expect(result.tombstones).toHaveLength(1);
    expect(result.inventorySha256).toBeNull();
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("order by lookup_id_hmac limit $1"), [2]);
  });

  it("reports a genuinely empty snapshot without claiming upgrade authority", async () => {
    const result = await inventoryHistoricalRecovery(fixture([]).pool, partitions);
    expect(result).toMatchObject({ enumerationComplete: true, tombstoneEnumerationComplete: true,
      tombstones: [], historicalReconciliationRequired: false, upgradeAuthorized: false });
  });

  it.each([0, -1, 1.5, 10_001, NaN])("rejects invalid tombstone bound %s before connecting", async bound => {
    const f = fixture([]);
    await expect(inventoryHistoricalRecovery(f.pool, partitions, 1000, 10_000, bound)).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each([
    { remote_purge_status: "unknown" }, { lookup_id_hmac: "malformed" },
    { control_expires_at: new Date("2026-09-12T00:00:00Z") }, { purged_at: new Date(NaN) },
  ])("rolls back malformed source data rather than emitting usable evidence %#", async mutation => {
    const f = fixture([{ ...tombstone("a"), ...mutation }]);
    await expect(inventoryHistoricalRecovery(f.pool, partitions)).rejects.toThrow();
    expect(f.query.mock.calls.at(-1)![0]).toBe("rollback");
    expect(f.release).toHaveBeenCalledOnce();
  });
});
