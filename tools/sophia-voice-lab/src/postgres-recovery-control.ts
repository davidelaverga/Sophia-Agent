import type pg from "pg";
import { ingestGenericOwnerLoss, parseVerifiedGenericOwnerLoss, type GenericOwnerLossIngestion } from "./generic-owner-loss.js";
import { deriveRetainedGenericRecovery, parseRetainedGenericRecovery } from "./retained-generic-recovery.js";
import { prepareGenericOwnerDispatch, consumeGenericOwnerDispatch, parseGenericOwnerDispatch, type PrepareGenericOwnerDispatch, type ConsumeGenericOwnerDispatch, type GenericOwnerDispatchResult } from "./generic-owner-dispatch.js";
import { RETAINED_RECOVERY_RETRY_MS, validateRecoveryAllocationBinding, executionMatchesRecoveryAllocation } from "./recovery-control.js";
import { deriveExecutionOwnership, parseExecutionOwnership } from "./execution-ownership.js";
import { parseD02RecoveryJournal } from "./d02-recovery-journal.js";
import { parseRetainedOwnerDeath } from "./retained-owner-death.js";
import { parseRetainedD02ProviderSettlement } from "./retained-d02-provider.js";
import { deriveRetainedD02Recovery, parseRetainedD02Recovery, recoveryAttemptAuditHash } from "./retained-d02-recovery.js";
import type { RecoveryAttemptIdentity } from "./recovery-attempt.js";
import { TERMINAL_RUN_STATES, VoiceLabError, labError } from "./domain.js";
import { RecoveryControlBindingSchema, recoveryCapabilityAudit, recoveryInventoryCursor, recoverySettlementProof, validateRecoveryBrowserBinding, type RecoveryControlRecord } from "./recovery-control.js";
import { canonicalRequestHash, sha256 } from "./security.js";
import { deriveExecutionEpochCleanupProof, parsePreservedExecutionCleanupProof } from "./execution-cleanup.js";

const TABLE = "sophia_voice_lab.recovery_controls";
type Row = {
  run_id: string; test_run_id: string; cleanup_obligation_id: string; binding: unknown; version: string | number;
  live_cleanup_complete: boolean; remote_purge_complete: boolean;
  retention_purge_due_at: Date | null; content_purged_at: Date | null; retention_lookup_hmac: string | null;
  last_settlement_from_version: string | number | null; last_settlement_event_sha256: string | null; last_settlement_receipt_sha256: string | null;
  browser_context_binding: unknown | null;
  browser_allocation_binding: unknown | null;
  browser_allocation_ever: boolean;
  execution_cleanup_proof: unknown | null;
  execution_ownership: unknown | null;
  d02_journal: unknown | null;
  d02_owner_death: unknown | null;
  d02_provider_settlement: unknown | null;
  d02_recovery_settlement: unknown | null;
  generic_owner_dispatch: unknown | null;
  generic_owner_loss?: unknown | null;
  generic_recovery_settlement?: unknown | null;
};

function conflict(code: string): VoiceLabError {
  return new VoiceLabError(labError(code, "Recovery control could not be updated against its exact durable ownership.", "conflict"));
}

export function record(row: Row): RecoveryControlRecord {
  if (typeof row.browser_allocation_ever !== "boolean") throw conflict("RECOVERY_ALLOCATION_HISTORY_INVALID");
  const binding = RecoveryControlBindingSchema.parse(row.binding);
  const genericOwnerDispatch = row.generic_owner_dispatch == null ? undefined : parseGenericOwnerDispatch(row.generic_owner_dispatch);
  if (genericOwnerDispatch && (binding.scenarioId === "V-D02"
    || genericOwnerDispatch.controlBindingSha256 !== canonicalRequestHash(binding)
    || genericOwnerDispatch.allocationBindingSha256 !== canonicalRequestHash(validateRecoveryAllocationBinding(binding, row.browser_allocation_binding))
    || genericOwnerDispatch.preparedFromVersion >= Number(row.version))) throw conflict("GENERIC_DISPATCH_BINDING_MISMATCH");
  const d02Journal = row.d02_journal == null ? undefined : parseD02RecoveryJournal(row.d02_journal);
  const d02OwnerDeath = row.d02_owner_death == null ? undefined : parseRetainedOwnerDeath(row.d02_owner_death);
  const d02ProviderSettlement = row.d02_provider_settlement == null ? undefined : parseRetainedD02ProviderSettlement(row.d02_provider_settlement);
  const d02RecoverySettlement = row.d02_recovery_settlement == null ? undefined : parseRetainedD02Recovery(row.d02_recovery_settlement);
  if (d02RecoverySettlement && (!d02OwnerDeath || !d02ProviderSettlement
    || d02RecoverySettlement.controlBindingSha256 !== canonicalRequestHash(binding)
    || d02RecoverySettlement.ownerDeathProofSha256 !== d02OwnerDeath.proofSha256
    || d02RecoverySettlement.providerProofSha256 !== d02ProviderSettlement.proofSha256
    || d02RecoverySettlement.executionOwnershipProofSha256 !== d02OwnerDeath.ownershipProofSha256)) throw conflict("D02_RECOVERY_PROOF_CONFLICT");
  if (d02ProviderSettlement && (!d02OwnerDeath || d02ProviderSettlement.ownerDeathProofSha256 !== d02OwnerDeath.proofSha256)) throw conflict("D02_PROVIDER_OWNER_CONFLICT");
  if (d02OwnerDeath && (!d02Journal || row.execution_ownership == null
    || d02OwnerDeath.controlBindingSha256 !== canonicalRequestHash(binding)
    || d02OwnerDeath.dispatchJournalProofSha256 !== d02Journal.proofSha256
    || d02OwnerDeath.ownershipProofSha256 !== parseExecutionOwnership(row.execution_ownership).proofSha256)) throw conflict("OWNER_DEATH_BINDING_CONFLICT");
  if (d02Journal && (binding.scenarioId !== "V-D02" || d02Journal.runIdSha256 !== sha256(binding.runId) || d02Journal.cleanupObligationIdSha256 !== sha256(binding.cleanupObligationId))) throw conflict("D02_JOURNAL_CONFLICT");
  if (row.execution_ownership != null) {
    const ownership = parseExecutionOwnership(row.execution_ownership);
    if (ownership.runIdSha256 !== sha256(binding.runId) || ownership.cleanupObligationIdSha256 !== sha256(binding.cleanupObligationId)) throw conflict("RECOVERY_OWNERSHIP_CONFLICT");
  }
  if (row.run_id !== binding.runId || row.test_run_id !== binding.testRunId || row.cleanup_obligation_id !== binding.cleanupObligationId) throw conflict("RECOVERY_BINDING_CONFLICT");
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) throw conflict("RECOVERY_VERSION_INVALID");
  const from = row.last_settlement_from_version === null ? null : Number(row.last_settlement_from_version);
  if (from !== null && (!Number.isSafeInteger(from) || from < 1 || from >= version || !/^[a-f0-9]{64}$/.test(row.last_settlement_event_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(row.last_settlement_receipt_sha256 ?? ""))) throw conflict("RECOVERY_SETTLEMENT_INVALID");
  if (from === null && (row.last_settlement_event_sha256 !== null || row.last_settlement_receipt_sha256 !== null)) throw conflict("RECOVERY_SETTLEMENT_INVALID");
  const result: RecoveryControlRecord = {
    binding, version, browserAllocationEver: row.browser_allocation_ever, liveCleanupComplete: row.live_cleanup_complete, remotePurgeComplete: row.remote_purge_complete,
    ...(d02Journal ? { d02Journal } : {}),
    ...(genericOwnerDispatch ? { genericOwnerDispatch } : {}),
    ...(d02OwnerDeath ? { d02OwnerDeath } : {}),
    ...(d02ProviderSettlement ? { d02ProviderSettlement } : {}),
    ...(d02RecoverySettlement ? { d02RecoverySettlement } : {}),
    ...(row.execution_ownership == null ? {} : { executionOwnership: parseExecutionOwnership(row.execution_ownership) }),
    ...(row.execution_cleanup_proof == null ? {} : { executionCleanupProof: parsePreservedExecutionCleanupProof(row.execution_cleanup_proof) }),
    ...(row.browser_allocation_binding == null ? {} : { browserAllocationBinding: validateRecoveryAllocationBinding(binding, row.browser_allocation_binding) }),
    ...(row.browser_context_binding == null ? {} : { browserContextBinding: validateRecoveryBrowserBinding(binding, row.browser_context_binding) }),
    retentionPurgeDueAt: row.retention_purge_due_at, contentPurgedAt: row.content_purged_at,
    ...(row.retention_lookup_hmac === null ? {} : { retentionLookupHmac: row.retention_lookup_hmac }),
    ...(from === null ? {} : { lastSettlement: { fromVersion: from, eventSha256: row.last_settlement_event_sha256!, receiptSha256: row.last_settlement_receipt_sha256! } }),
  };
  if (row.generic_owner_loss != null) result.genericOwnerLoss = parseVerifiedGenericOwnerLoss(row.generic_owner_loss, result);
  if (row.generic_recovery_settlement != null) result.genericRecoverySettlement = parseRetainedGenericRecovery(row.generic_recovery_settlement, result);
  return result;
}

/** Staged C4 adapter. No runtime DDL. Its caller must first attest the release
 * migration and integrate transactional admission/allocation writes. */
export class PostgresRecoveryControls {
  constructor(private readonly pool: pg.Pool) {}

  async persistGenericOwnerLoss(input: GenericOwnerLossIngestion) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for update`, [input.runId]);
      if (!selected.rows[0]) throw conflict("GENERIC_OWNER_CONTROL_MISSING");
      const control = record(selected.rows[0]);
      const result = ingestGenericOwnerLoss(control, input, new Date());
      if (!result.replay) {
        const updated = await client.query<Row>(`update ${TABLE} set generic_owner_loss=$2,version=version+1 where run_id=$1 returning *`, [input.runId, result.proof]);
        record(updated.rows[0]!);
      }
      await client.query("commit");
      return result;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async prepareGenericOwnerDispatch(input: PrepareGenericOwnerDispatch): Promise<RecoveryControlRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for update`, [input.runId]);
      if (!selected.rows[0]) throw conflict("GENERIC_DISPATCH_CONTROL_MISSING");
      const current = record(selected.rows[0]);
      const journal = prepareGenericOwnerDispatch(current, input, new Date());
      if (current.genericOwnerDispatch) { await client.query("commit"); return current; }
      const updated = await client.query<Row>(`update ${TABLE} set generic_owner_dispatch=$2,version=version+1 where run_id=$1 returning *`, [input.runId, journal]);
      await client.query("commit");
      return record(updated.rows[0]!);
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async consumeGenericOwnerDispatch(input: ConsumeGenericOwnerDispatch): Promise<GenericOwnerDispatchResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for update`, [input.runId]);
      if (!selected.rows[0]) throw conflict("GENERIC_DISPATCH_CONTROL_MISSING");
      const current = record(selected.rows[0]);
      const journal = consumeGenericOwnerDispatch(current, input, new Date());
      if (current.genericOwnerDispatch?.consumedAt !== null) { await client.query("commit"); return { dispatchAllowed: false, control: current }; }
      const updated = await client.query<Row>(`update ${TABLE} set generic_owner_dispatch=$2,version=version+1 where run_id=$1 returning *`, [input.runId, journal]);
      await client.query("commit");
      return { dispatchAllowed: true, control: record(updated.rows[0]!) };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async recordCapabilityAudit(runId: string, expectedVersion: number, jtiHash: string, argumentHash: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for share`, [runId]);
      if (!result.rows[0]) throw conflict("RECOVERY_VERSION_CONFLICT");
      const control = record(result.rows[0]);
      if (control.contentPurgedAt === null || control.version !== expectedVersion) throw conflict("RECOVERY_VERSION_CONFLICT");
      const audit = recoveryCapabilityAudit(control, jtiHash, argumentHash);
      await client.query("insert into sophia_voice_lab.auth_audit (run_id,caller_id,caller_partition_id,action,capability_jti_hash,argument_hash,outcome,detail,observed_at) values (null,null,$1,$2,$3,$4,$5,$6,$7)", [control.binding.callerPartitionId,audit.action,audit.capabilityJtiHash,audit.argumentHash,audit.outcome,audit.detail,audit.observedAt]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async preserveExecutionOwnership(runId: string): Promise<RecoveryControlRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const runs = await client.query("select id,cleanup_obligation_id from sophia_voice_lab.runs where id=$1 for update", [runId]);
      const controls = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for update`, [runId]);
      if (!runs.rows[0] || !controls.rows[0]) throw conflict("RECOVERY_OWNERSHIP_UNAVAILABLE");
      const current = record(controls.rows[0]);
      if (!current.browserAllocationEver || current.contentPurgedAt !== null) throw conflict("RECOVERY_OWNERSHIP_UNAVAILABLE");
      const leases = await client.query("select worker_id,lease_epoch,expires_at>clock_timestamp() as live from sophia_voice_lab.browser_leases where run_id=$1 for update", [runId]);
      const events = await client.query("select * from sophia_voice_lab.run_events where run_id=$1 order by seq", [runId]);
      const ownership = deriveExecutionOwnership({ id: runId, cleanupObligationId: runs.rows[0].cleanup_obligation_id }, events.rows.map(row => ({ runId, seq: Number(row.seq), kind: row.kind, source: row.source, payload: row.payload, at: row.observed_at, dedupeKey: row.dedupe_key })));
      if (!executionMatchesRecoveryAllocation(current, ownership)) throw conflict("RECOVERY_LEASE_MISMATCH");
      const lease = leases.rows[0];
      if (!lease?.live || sha256(lease.worker_id) !== ownership.workerIdSha256 || Number(lease.lease_epoch) !== ownership.browserLeaseEpoch) throw conflict("RECOVERY_LEASE_MISMATCH");
      if (current.executionOwnership) {
        if (canonicalRequestHash(current.executionOwnership) !== canonicalRequestHash(ownership)) throw conflict("RECOVERY_OWNERSHIP_CONFLICT");
        await client.query("commit");
        return current;
      }
      const updated = await client.query<Row>(`update ${TABLE} set execution_ownership=$2,version=version+1 where run_id=$1 returning *`, [runId, ownership]);
      await client.query("commit");
      return record(updated.rows[0]!);
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async preserveExecutionCleanup(runId: string): Promise<RecoveryControlRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const runs = await client.query("select id,test_run_id,cleanup_obligation_id from sophia_voice_lab.runs where id=$1 for update", [runId]);
      const selected = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for update`, [runId]);
      if (!runs.rows[0] || !selected.rows[0]) throw conflict("RECOVERY_EXECUTION_PROOF_UNAVAILABLE");
      const current = record(selected.rows[0]);
      if (!current.browserAllocationEver || current.contentPurgedAt !== null) throw conflict("RECOVERY_EXECUTION_PROOF_UNAVAILABLE");
      const events = await client.query("select * from sophia_voice_lab.run_events where run_id=$1 order by seq", [runId]);
      const run = runs.rows[0];
      const proof = deriveExecutionEpochCleanupProof({ id: run.id, testRunId: run.test_run_id, cleanupObligationId: run.cleanup_obligation_id }, events.rows.map(row => ({ runId, seq: Number(row.seq), kind: row.kind, source: row.source, payload: row.payload, at: row.observed_at, dedupeKey: row.dedupe_key })));
      const leases = await client.query("select worker_id,lease_epoch from sophia_voice_lab.browser_leases where run_id=$1 for update", [runId]);
      const lease = leases.rows[0];
      if (!proof.ready || !executionMatchesRecoveryAllocation(current, proof) || (lease && (proof.workerIdSha256 !== sha256(lease.worker_id) || proof.browserLeaseEpoch !== Number(lease.lease_epoch)))) throw conflict("RECOVERY_EXECUTION_PROOF_UNCONFIRMED");
      if (current.executionCleanupProof) {
        if (canonicalRequestHash(current.executionCleanupProof) !== canonicalRequestHash(proof)) throw conflict("RECOVERY_EXECUTION_PROOF_CONFLICT");
        await client.query("commit");
        return current;
      }
      const updated = await client.query<Row>(`update ${TABLE} set execution_cleanup_proof=$2,version=version+1 where run_id=$1 returning *`, [runId, parsePreservedExecutionCleanupProof(proof)]);
      await client.query("commit");
      return record(updated.rows[0]!);
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async releaseRecoveredBrowserLease(runId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const runs = await client.query("select id,test_run_id,cleanup_obligation_id,state,scenario_id from sophia_voice_lab.runs where id=$1 for update", [runId]);
      const selected = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for update`, [runId]);
      const leases = await client.query("select worker_id,lease_epoch,expires_at<=clock_timestamp() as expired from sophia_voice_lab.browser_leases where run_id=$1 for update", [runId]);
      const run = runs.rows[0], lease = leases.rows[0];
      if (!run || !selected.rows[0] || !lease || lease.expired !== true || run.scenario_id === "V-D02"
        || !TERMINAL_RUN_STATES.has(run.state)) {
        await client.query("rollback"); return false;
      }
      const current = record(selected.rows[0]);
      const events = await client.query("select * from sophia_voice_lab.run_events where run_id=$1 order by seq", [runId]);
      const proof = deriveExecutionEpochCleanupProof({ id: run.id, testRunId: run.test_run_id, cleanupObligationId: run.cleanup_obligation_id }, events.rows.map(row => ({ runId, seq: Number(row.seq), kind: row.kind, source: row.source, payload: row.payload, at: row.observed_at, dedupeKey: row.dedupe_key })));
      if (current.contentPurgedAt !== null || !proof.ready || !current.executionCleanupProof
        || canonicalRequestHash(current.executionCleanupProof) !== canonicalRequestHash(proof)
        || !executionMatchesRecoveryAllocation(current, proof)
        || proof.workerIdSha256 !== sha256(lease.worker_id) || proof.browserLeaseEpoch !== Number(lease.lease_epoch)) {
        await client.query("rollback"); return false;
      }
      // Release the exact dead execution, never acquire or impersonate its owner.
      const deleted = await client.query("delete from sophia_voice_lab.browser_leases where run_id=$1 and worker_id=$2 and lease_epoch=$3 and expires_at<=clock_timestamp()", [runId, lease.worker_id, lease.lease_epoch]);
      await client.query("commit"); return deleted.rowCount === 1;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async bindBrowserContext(runId: string, workerId: string, leaseEpoch: number, driverBinding: unknown): Promise<RecoveryControlRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Same run -> control -> lease order as allocation and retention purge.
      const run = await client.query("select id from sophia_voice_lab.runs where id=$1 for update", [runId]);
      const selected = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for update`, [runId]);
      if (!run.rows.length || !selected.rows[0]) throw conflict("RECOVERY_BINDING_UNAVAILABLE");
      const current = record(selected.rows[0]);
      if (current.contentPurgedAt !== null) throw conflict("RECOVERY_BINDING_UNAVAILABLE");
      const binding = validateRecoveryBrowserBinding(current.binding, driverBinding);
      if (!current.browserAllocationBinding || canonicalRequestHash(current.browserAllocationBinding) !== canonicalRequestHash(binding)) throw conflict("RECOVERY_BINDING_CONFLICT");
      const leases = await client.query<{ worker_id: string; lease_epoch: string; expires_at: Date }>("select worker_id,lease_epoch,expires_at from sophia_voice_lab.browser_leases where run_id=$1 for update", [runId]);
      const lease = leases.rows[0];
      if (!lease || lease.worker_id !== workerId || Number(lease.lease_epoch) !== leaseEpoch || lease.expires_at <= new Date()
        || binding.browser_worker_id_sha256 !== sha256(workerId) || binding.browser_lease_epoch !== leaseEpoch) throw conflict("RECOVERY_LEASE_MISMATCH");
      if (current.browserContextBinding) {
        if (canonicalRequestHash(current.browserContextBinding) !== canonicalRequestHash(binding)) throw conflict("RECOVERY_BINDING_CONFLICT");
        await client.query("commit");
        return current;
      }
      const updated = await client.query<Row>(`update ${TABLE} set browser_context_binding=$2,version=version+1 where run_id=$1 returning *`, [runId, binding]);
      await client.query("commit");
      return record(updated.rows[0]!);
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async get(runId: string): Promise<RecoveryControlRecord | null> {
    const result = await this.pool.query<Row>(`select * from ${TABLE} where run_id=$1`, [runId]);
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async list(limit: number, afterRunId?: string): Promise<RecoveryControlRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw conflict("RECOVERY_LIMIT_INVALID");
    const cursor = recoveryInventoryCursor(afterRunId);
    const result = await this.pool.query<Row>(`select c.* from ${TABLE} c
      where (not c.live_cleanup_complete or not c.remote_purge_complete
         or exists (select 1 from sophia_voice_lab.browser_leases b where b.run_id=c.run_id))
        and ($2::uuid is null or c.run_id > $2::uuid)
      order by c.run_id limit $1`, [limit, cursor]);
    return result.rows.map(record);
  }

  async schedule(limit: number): Promise<RecoveryControlRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw conflict("RECOVERY_LIMIT_INVALID");
    // Persist selection before external dispatch. This is round-robin progress,
    // not an exclusive execution lease, authorization audit or cleanup proof.
    const result = await this.pool.query<Row>(`with selected as (
      select c.run_id from ${TABLE} c where c.content_purged_at is not null
        and (c.recovery_scheduled_at is null or c.recovery_scheduled_at <= clock_timestamp() - ($2::double precision * interval '1 millisecond'))
        and (not c.live_cleanup_complete or not c.remote_purge_complete
          or exists (select 1 from sophia_voice_lab.browser_leases b where b.run_id=c.run_id))
      order by c.recovery_scheduled_at nulls first,c.run_id
      limit $1 for update of c skip locked
    ) update ${TABLE} c set recovery_scheduled_at=clock_timestamp()
      from selected s where c.run_id=s.run_id returning c.*`, [limit, RETAINED_RECOVERY_RETRY_MS]);
    return result.rows.map(record);
  }

  async settle(runId: string, expectedVersion: number, canonicalEvent: unknown, attempt?: RecoveryAttemptIdentity): Promise<RecoveryControlRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<Row>(`select * from ${TABLE} where run_id=$1 for update`, [runId]);
      if (!selected.rows[0]) throw conflict("RECOVERY_CONTROL_NOT_FOUND");
      const current = record(selected.rows[0]);
      if (current.contentPurgedAt === null) throw conflict("RECOVERY_CONTENT_NOT_PURGED");
      const proof = recoverySettlementProof(current.binding, canonicalEvent);
      const leases = await client.query("select worker_id,lease_epoch from sophia_voice_lab.browser_leases where run_id=$1 for update", [runId]);
      let externalProof;
      if (current.browserAllocationEver && !current.executionCleanupProof?.ready && !current.d02RecoverySettlement && attempt && current.d02OwnerDeath && current.d02ProviderSettlement) {
        const now = (await client.query("select clock_timestamp() as now")).rows[0].now as Date;
        externalProof = deriveRetainedD02Recovery(current, canonicalEvent, attempt, now);
        const audit = await client.query("select 1 from sophia_voice_lab.auth_audit where caller_partition_id=$1 and action='capability:session:recover' and outcome='allowed' and argument_hash=$2 limit 1", [current.binding.callerPartitionId, recoveryAttemptAuditHash(current, attempt)]);
        if (!audit.rows.length) throw conflict("RECOVERY_ATTEMPT_AUDIT_MISSING");
        const lease = leases.rows[0];
        if (lease && (sha256(lease.worker_id) !== externalProof.workerIdSha256 || Number(lease.lease_epoch) !== externalProof.browserLeaseEpoch)) throw conflict("RECOVERY_LEASE_MISMATCH");
      }
      let genericProof;
      if (current.genericOwnerLoss && !current.genericRecoverySettlement && attempt) {
        const now = (await client.query("select clock_timestamp() as now")).rows[0].now as Date;
        genericProof = deriveRetainedGenericRecovery(current, canonicalEvent, attempt, now);
        const audit = await client.query("select 1 from sophia_voice_lab.auth_audit where caller_partition_id=$1 and action='capability:session:recover' and outcome='allowed' and argument_hash=$2 limit 1", [current.binding.callerPartitionId, recoveryAttemptAuditHash(current, attempt)]);
        if (!audit.rows.length) throw conflict("RECOVERY_ATTEMPT_AUDIT_MISSING");
        const lease = leases.rows[0];
        if (lease && (sha256(lease.worker_id) !== genericProof.workerIdSha256 || Number(lease.lease_epoch) !== genericProof.browserLeaseEpoch)) throw conflict("RECOVERY_LEASE_MISMATCH");
      }
      if (leases.rows.length && !externalProof && !genericProof) throw conflict("RECOVERY_BROWSER_UNSETTLED");
      if (current.browserAllocationEver !== false && !current.executionCleanupProof?.ready && !current.d02RecoverySettlement && !current.genericRecoverySettlement && !externalProof && !genericProof) throw conflict("RECOVERY_EXECUTION_UNCONFIRMED");
      if (current.lastSettlement?.fromVersion === expectedVersion && current.lastSettlement.eventSha256 === proof.eventSha256) {
        await client.query("commit");
        return current;
      }
      if (current.version !== expectedVersion) throw conflict("RECOVERY_VERSION_CONFLICT");
      const ownerProof = externalProof ?? genericProof;
      if (ownerProof && leases.rows.length) await client.query("delete from sophia_voice_lab.browser_leases where run_id=$1 and worker_id=$2 and lease_epoch=$3", [runId, leases.rows[0].worker_id, ownerProof.browserLeaseEpoch]);
      const updated = await client.query<Row>(`update ${TABLE}
        set version=version+1,live_cleanup_complete=true,remote_purge_complete=remote_purge_complete or $3,
            last_settlement_from_version=$2,last_settlement_event_sha256=$4,last_settlement_receipt_sha256=$5,
            d02_recovery_settlement=coalesce(d02_recovery_settlement,$6),
            generic_recovery_settlement=coalesce(generic_recovery_settlement,$7)
        where run_id=$1 and version=$2 returning *`, [runId, expectedVersion, proof.remotePurgeComplete, proof.eventSha256, proof.receiptSha256, externalProof ?? null, genericProof ?? null]);
      if (!updated.rows[0]) throw conflict("RECOVERY_VERSION_CONFLICT");
      const settled = record(updated.rows[0]);
      if (settled.remotePurgeComplete && settled.retentionLookupHmac) {
        await client.query("update sophia_voice_lab.retention_tombstones set remote_purge_status='confirmed' where lookup_id_hmac=$1", [settled.retentionLookupHmac]);
      }
      await client.query("commit");
      return settled;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
  }
}
