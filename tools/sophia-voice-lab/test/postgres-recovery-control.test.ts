import { readFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PostgresRecoveryControls } from "../src/postgres-recovery-control.js";
import { projectRecoveryControlBinding } from "../src/recovery-control.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";

const url = process.env.SOPHIA_VOICE_LAB_CONTROL_TEST_DATABASE_URL ?? "";
const suite = url ? describe : describe.skip;
let pool: pg.Pool;
let controls: PostgresRecoveryControls;
suite("staged C4 PostgreSQL control settlement", () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!/^\/voice_lab_test_c4_control_[a-z0-9_]+$/.test(parsed.pathname) || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") throw new Error("Dedicated control-test database/reset approval required");
    pool = new pg.Pool({ connectionString: url, max: 4 });
    const identity = await pool.query("select current_database() as name");
    expect(identity.rows[0].name).toBe(parsed.pathname.slice(1));
    await pool.query("drop schema if exists sophia_voice_lab cascade");
    await pool.query(await readFile(new URL("../../../backend/migrations/2026_08_23_sophia_voice_lab.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../migrations/004_recovery_controls.sql", import.meta.url), "utf8"));
    controls = new PostgresRecoveryControls(pool);
  });
  afterAll(async () => {
    if (pool) { await pool.query("drop schema if exists sophia_voice_lab cascade"); await pool.end(); }
  });

  async function fixture() {
    const run = testRun();
    const binding = projectRecoveryControlBinding(run, `cp1:pg:${"a".repeat(64)}`);
    await pool.query(`insert into sophia_voice_lab.recovery_controls
      (run_id,test_run_id,cleanup_obligation_id,binding,version,live_cleanup_complete,remote_purge_complete,content_purged_at)
      values ($1,$2,$3,$4,1,false,false,now())`, [run.id, run.testRunId, run.cleanupObligationId, binding]);
    const event = { kind: "cleanup.recovery", source: "canonical", payload: {
      complete: true, http_status: 200, retention_purged: true,
      receipt: { test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), complete: true, live_cleanup_complete: true, live_resources_zero: true,
        retention_purged: true, retention_purge_pending: false, retention_maintenance_complete: true,
        components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, auth_sessions: { status: "completed" }, builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } },
        receipt: { storage: "postgres", object_path: "synthetic/receipt", sha256: "a".repeat(64) }, extra_content: "DO_NOT_PERSIST",
      },
    } };
    return { run, event };
  }

  it("pages unresolved controls across settlement without offset skips or duplicates", async () => {
    const fixtures = await Promise.all(Array.from({ length: 25 }, () => fixture()));
    const expected = fixtures.map(item => item.run.id).sort();
    const first = await controls.list(4);
    const cursor = first.at(-1)!.binding.runId;
    // Removing a row before the cursor would shift OFFSET pagination and skip
    // an obligation. Keyset pagination must still discover the complete tail.
    const completed = fixtures.find(item => item.run.id === first[0]!.binding.runId)!;
    await controls.settle(completed.run.id, 1, completed.event);
    const seen = first.map(item => item.binding.runId);
    let after = cursor;
    for (let count = 0; count < 10; count++) {
      const page = await controls.list(4, after);
      if (!page.length) break;
      seen.push(...page.map(item => item.binding.runId));
      after = page.at(-1)!.binding.runId;
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(25);
    expect(await controls.list(4, after.toUpperCase())).toEqual([]);
    await expect(controls.list(4, "not-a-uuid")).rejects.toThrow();
    for (const item of fixtures) await controls.settle(item.run.id, 1, item.event);
    expect(await controls.list(4)).toEqual([]);
  });

  it("commits a content-free retained authorization audit visible after reconnect", async () => {
    const { run } = await fixture();
    const jtiHash = sha256(`audit:${run.id}`);
    const argumentHash = sha256(`arguments:${run.id}`);
    await controls.recordCapabilityAudit(run.id, 1, jtiHash, argumentHash);
    const independent = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const result = await independent.query("select * from sophia_voice_lab.auth_audit where capability_jti_hash=$1", [jtiHash]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ run_id: null, caller_id: null,
        caller_partition_id: `cp1:pg:${"a".repeat(64)}`, action: "capability:session:recover",
        argument_hash: argumentHash, outcome: "allowed", detail: {
          schema: "sophia.voice-lab.retained-recovery-audit.v1",
          run_id_sha256: sha256(run.id), test_run_id_sha256: sha256(run.testRunId),
          cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), control_version: 1,
        } });
      const serialized = JSON.stringify(result.rows[0]);
      for (const value of [run.id, run.testRunId, run.cleanupObligationId]) expect(serialized).not.toContain(value);
      expect((await controls.get(run.id))?.version).toBe(1);
    } finally { await independent.end(); }
  });

  it("rolls back stale, pre-purge and malformed retained authorization audits", async () => {
    const { run } = await fixture();
    const jtiHash = sha256(`rejected:${run.id}`);
    const argumentHash = sha256("rejected-arguments");
    await expect(controls.recordCapabilityAudit(run.id, 2, jtiHash, argumentHash)).rejects.toMatchObject({ detail: { code: "RECOVERY_VERSION_CONFLICT" } });
    await expect(controls.recordCapabilityAudit(run.id, 1, jtiHash, "raw-secret-not-a-digest")).rejects.toThrow();
    await pool.query("update sophia_voice_lab.recovery_controls set content_purged_at=null where run_id=$1", [run.id]);
    await expect(controls.recordCapabilityAudit(run.id, 1, jtiHash, argumentHash)).rejects.toMatchObject({ detail: { code: "RECOVERY_VERSION_CONFLICT" } });
    expect((await pool.query("select count(*)::int as count from sophia_voice_lab.auth_audit where capability_jti_hash=$1", [jtiHash])).rows[0].count).toBe(0);
    expect((await controls.get(run.id))?.version).toBe(1);
  });

  it("refuses an allocated historical run without preserved process cleanup even when its lease is absent", async () => {
    const { run, event } = await fixture();
    await pool.query("update sophia_voice_lab.recovery_controls set browser_allocation_ever=true where run_id=$1", [run.id]);
    await expect(controls.settle(run.id, 1, event)).rejects.toMatchObject({ detail: { code: "RECOVERY_EXECUTION_UNCONFIRMED" } });
    expect(await controls.get(run.id)).toMatchObject({ version: 1, browserAllocationEver: true, liveCleanupComplete: false, remotePurgeComplete: false });
  });

  it("serializes concurrent identical settlement and permits exact replay after reconnect", async () => {
    const { run, event } = await fixture();
    const [a, b] = await Promise.all([controls.settle(run.id, 1, event), controls.settle(run.id, 1, event)]);
    expect(a).toEqual(b);
    expect(a.version).toBe(2);
    const independent = new pg.Pool({ connectionString: url, max: 1 });
    try { expect(await new PostgresRecoveryControls(independent).settle(run.id, 1, event)).toEqual(a); }
    finally { await independent.end(); }
    expect(JSON.stringify(a)).not.toContain("DO_NOT_PERSIST");
  });

  it("rolls back foreign proof and rejects competing stale settlement", async () => {
    const { run, event } = await fixture();
    const foreign = structuredClone(event);
    foreign.payload.receipt.cleanup_obligation_id_sha256 = "b".repeat(64);
    await expect(controls.settle(run.id, 1, foreign)).rejects.toThrow();
    expect((await controls.get(run.id))?.version).toBe(1);
    const other = structuredClone(event);
    other.payload.receipt.receipt.sha256 = "c".repeat(64);
    const results = await Promise.allSettled([controls.settle(run.id, 1, event), controls.settle(run.id, 1, other)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await controls.get(run.id))?.version).toBe(2);
  });

  it("rejects null/missing identity and partial settlement at the database constraint", async () => {
    const { run } = await fixture();
    await expect(pool.query("update sophia_voice_lab.recovery_controls set binding=binding-'runId' where run_id=$1", [run.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("update sophia_voice_lab.recovery_controls set version=2,last_settlement_from_version=1 where run_id=$1", [run.id])).rejects.toMatchObject({ code: "23514" });
    expect((await controls.get(run.id))?.version).toBe(1);
  });
});
