import type pg from "pg";
import { z } from "zod";
import { record as recoveryControlRecord } from "./postgres-recovery-control.js";
import { parseRetainedOwnerDeath } from "./retained-owner-death.js";
import { canonicalRequestHash, sha256 } from "./security.js";
import type { RetainedOwnerAuthorityConfig } from "./retained-owner-verifier.js";
import { verifyRetainedD02OwnerDeath } from "./retained-owner-verifier.js";

/** Internal runtime/controller storage, not an MCP/user assertion route. Uses trusted
 * controller DB/config, validates the actual signature while holding the control
 * lock, and persists only metadata. Does NOT release leases or settle cleanup.
 * No runtime DDL; an exact attested release migration is a prerequisite. */
export async function persistRetainedD02OwnerDeath(input: {
  pool: pg.Pool; runId: string; expectedVersion: number; receipt: unknown;
  publicConfig: RetainedOwnerAuthorityConfig; expectedWorkerServiceIdSha256: string;
}) {
  z.string().uuid().parse(input.runId);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.expectedVersion);
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    // Same ordering as allocation/retention: run -> durable control -> lease.
    await client.query("select id from sophia_voice_lab.runs where id=$1 for update", [input.runId]);
    const selected = await client.query("select * from sophia_voice_lab.recovery_controls where run_id=$1 for update", [input.runId]);
    if (!selected.rows[0]) throw new Error("OWNER_CONTROL_UNAVAILABLE");
    const control = recoveryControlRecord(selected.rows[0]);
    const lease = (await client.query("select worker_id,lease_epoch from sophia_voice_lab.browser_leases where run_id=$1 for update", [input.runId])).rows[0];
    if (lease && (sha256(lease.worker_id) !== control.executionOwnership?.workerIdSha256
      || Number(lease.lease_epoch) !== control.executionOwnership?.browserLeaseEpoch)) throw new Error("OWNER_LEASE_MISMATCH");
    const previous = control.d02OwnerDeath;
    if (previous && previous.signedReceiptSha256 !== canonicalRequestHash(input.receipt)) throw new Error("OWNER_DEATH_IMMUTABLE");
    // First acceptance uses the DB clock AFTER locks. Exact durable replay is
    // reverified at its original acceptance time, even after source expiry.
    const now = (await client.query("select clock_timestamp() as now")).rows[0].now as Date;
    const proof = parseRetainedOwnerDeath(verifyRetainedD02OwnerDeath({ control,
      receipt: input.receipt, publicConfig: input.publicConfig,
      expectedWorkerServiceIdSha256: input.expectedWorkerServiceIdSha256,
      acceptedAt: previous ? new Date(previous.acceptedAt) : now }));
    if (previous) {
      if (canonicalRequestHash(previous) !== canonicalRequestHash(proof)) throw new Error("OWNER_DEATH_IMMUTABLE");
      await client.query("commit");
      return { replay: true, version: control.version, proof };
    }
    if (control.version !== input.expectedVersion) throw new Error("OWNER_CONTROL_VERSION_CONFLICT");
    const updated = await client.query("update sophia_voice_lab.recovery_controls set d02_owner_death=$2,version=version+1 where run_id=$1 returning version", [input.runId, proof]);
    await client.query("commit");
    return { replay: false, version: Number(updated.rows[0].version), proof };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}
