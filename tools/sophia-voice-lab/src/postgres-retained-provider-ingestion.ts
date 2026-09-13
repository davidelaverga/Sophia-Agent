import type pg from "pg";
import { z } from "zod";
import type { VoiceLabConfig } from "./config.js";
import { record as recoveryControlRecord } from "./postgres-recovery-control.js";
import { verifyRetainedD02ProviderSettlement } from "./retained-d02-provider.js";
import { canonicalRequestHash, sha256 } from "./security.js";

/** Internal runtime/controller ingestion of the existing signed Gateway fact, not a
 * caller-declared cleanup grant. Does not change leases or overall settlement. */
export async function persistRetainedD02ProviderSettlement(input: {
  pool: pg.Pool; runId: string; expectedVersion: number; receipt: unknown;
  authority: VoiceLabConfig["d02GatewayReceiptAuthority"];
}) {
  z.string().uuid().parse(input.runId);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.expectedVersion);
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    await client.query("select id from sophia_voice_lab.runs where id=$1 for update", [input.runId]);
    const selected = await client.query("select * from sophia_voice_lab.recovery_controls where run_id=$1 for update", [input.runId]);
    if (!selected.rows[0]) throw new Error("PROVIDER_CONTROL_UNAVAILABLE");
    const control = recoveryControlRecord(selected.rows[0]);
    const lease = (await client.query("select worker_id,lease_epoch from sophia_voice_lab.browser_leases where run_id=$1 for update", [input.runId])).rows[0];
    if (lease && (sha256(lease.worker_id) !== control.executionOwnership?.workerIdSha256
      || Number(lease.lease_epoch) !== control.executionOwnership?.browserLeaseEpoch)) throw new Error("PROVIDER_LEASE_MISMATCH");
    const previous = control.d02ProviderSettlement;
    if (previous && previous.gatewayReceiptSha256 !== canonicalRequestHash(input.receipt)) throw new Error("PROVIDER_SETTLEMENT_IMMUTABLE");
    const now = (await client.query("select clock_timestamp() as now")).rows[0].now as Date;
    const proof = verifyRetainedD02ProviderSettlement(control, input.receipt, input.authority, now);
    if (previous) {
      if (canonicalRequestHash(previous) !== canonicalRequestHash(proof)) throw new Error("PROVIDER_SETTLEMENT_IMMUTABLE");
      await client.query("commit");
      return { replay: true, version: control.version, proof };
    }
    if (control.version !== input.expectedVersion) throw new Error("PROVIDER_CONTROL_VERSION_CONFLICT");
    const updated = await client.query("update sophia_voice_lab.recovery_controls set d02_provider_settlement=$2,version=version+1 where run_id=$1 returning version", [input.runId, proof]);
    await client.query("commit");
    return { replay: false, version: Number(updated.rows[0].version), proof };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}
