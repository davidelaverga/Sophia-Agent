import pg from "pg";
import { createHmac } from "node:crypto";

import {
  VoiceLabError,
  labError,
  type EvidenceRecord,
  type DurableArtifact,
  type LabError,
  type LabEvent,
  type OperationRecord,
  type OperationState,
  type RunRecord,
  type SuiteRecord,
  type SuiteEvidenceRecord,
} from "./domain.js";
import type { AuthAuditRecord, BrowserLease, ClaimedOperation, EventClaimGuard, EventPage, LedgerHealth, NewOperation, OperationAdmission, PrincipalProvisionCapabilityRotation, PrincipalProvisionClaim, PrincipalProvisionControlRecord, PrincipalProvisionPreparation, PrincipalProvisionReadiness, RetentionTombstone, RollingAdmissionFence, RollingAdmissionLimits, RollingAdmissionReservation, RollingAdmissionResult, RunPatch, VoiceLabLedger, WorkerHeartbeat } from "./ledger.js";
import { canonicalRequestHash, sha256 } from "./security.js";
import { parseExactPrincipalProvisionReceipt } from './principal-provision-receipt.js';
import { attestVoiceLabSchema } from "./schema-attestation.js";
import { CallerPartitioner, type CallerPartitionKeyRing } from "./caller-partition.js";

const { Pool } = pg;
const SCHEMA = "sophia_voice_lab";

export class PostgresVoiceLabLedger implements VoiceLabLedger {
  readonly pool: pg.Pool;
  readonly #retentionKey: string | null;
  readonly #callerPartitions: CallerPartitioner;
  #healthCache: { expiresAt: number; value: LedgerHealth } | null = null;

  constructor(databaseUrl: string, max = 10, retentionKey: string | null = null, callerPartitionKeys: CallerPartitionKeyRing | null = null) {
    this.pool = new Pool({ connectionString: databaseUrl, max, application_name: "sophia-voice-lab" });
    this.#retentionKey = retentionKey;
    const keys = callerPartitionKeys ?? (process.env.NODE_ENV === "test" ? { activeKeyId: "test-v1", keys: { "test-v1": "caller-partition-postgres-test-secret-000001" } } : null);
    if (!keys) throw new VoiceLabError(labError("CALLER_PARTITION_KEY_MISSING", "A caller-partition HMAC key ring is required by the durable ledger.", "internal"));
    this.#callerPartitions = new CallerPartitioner(keys);
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const attestation = await attestVoiceLabSchema(client, true);
      if (!attestation.ok) throw new VoiceLabError(labError("SCHEMA_ATTESTATION_FAILED", `Sophia Voice Lab schema/role postflight failed: ${attestation.detail}.`, "internal"));
      await this.#assertCallerPartitionKeyCoverage(client);
    } finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async health(): Promise<LedgerHealth> {
    if (this.#healthCache && this.#healthCache.expiresAt > Date.now()) return this.#healthCache.value;
    const attestation = await attestVoiceLabSchema(this.pool);
    let value: LedgerHealth = { ok: attestation.ok, detail: attestation.ok ? "postgres-schema-attested" : attestation.detail };
    if (attestation.ok) {
      try { await this.#assertCallerPartitionKeyCoverage(this.pool); }
      catch { value = { ok: false, detail: "caller-partition-key-ring-mismatch" }; }
    }
    this.#healthCache = { expiresAt: Date.now() + 5_000, value };
    return value;
  }

  async #assertCallerPartitionKeyCoverage(database: Pick<pg.Pool | pg.PoolClient, "query">): Promise<void> {
    const result = await database.query<{ caller_partition_id: string }>(
      `select distinct caller_partition_id from (
         select caller_partition_id from ${SCHEMA}.admission_reservations where observed_at >= now()-interval '8 days'
         union all
         select caller_partition_id from ${SCHEMA}.auth_audit where run_id is null and observed_at >= now()-interval '7 days'
         union all
         select caller_partition_id from ${SCHEMA}.principal_provisions
       ) live_partitions order by caller_partition_id`,
    );
    this.#callerPartitions.assertLivePartitionIds(result.rows.map((row) => row.caller_partition_id));
  }

  async countActiveRuns(callerId?: string): Promise<number> {
    const terminal = ["pending_external_evidence", "completed", "product_failed", "invalid_test", "inconclusive_provider", "failed_harness", "authorization_failed", "deployment_mismatch", "aborted_driver_restart", "expired", "cancelled"];
    const result = callerId === undefined
      ? await this.pool.query<{ count: string }>(`select count(*)::text as count from ${SCHEMA}.runs where cleanup_complete=false or not (state = any($1::text[]))`, [terminal])
      : await this.pool.query<{ count: string }>(`select count(*)::text as count from ${SCHEMA}.runs where caller_id=$1 and (cleanup_complete=false or not (state = any($2::text[])))`, [callerId, terminal]);
    return Number(result.rows[0]?.count ?? 0);
  }
  async listExpiredRuns(now: Date, limit: number): Promise<RunRecord[]> {
    const terminal = ["pending_external_evidence", "completed", "product_failed", "invalid_test", "inconclusive_provider", "failed_harness", "authorization_failed", "deployment_mismatch", "aborted_driver_restart", "expired", "cancelled"];
    const result = await this.pool.query(`select * from ${SCHEMA}.runs where expires_at <= $1 and not (state = any($2::text[])) order by expires_at asc limit $3`, [now, terminal, limit]);
    return result.rows.map(mapRun);
  }
  async listRunsNeedingRecovery(limit: number): Promise<RunRecord[]> {
    const terminal = ["pending_external_evidence", "completed", "product_failed", "invalid_test", "inconclusive_provider", "failed_harness", "authorization_failed", "deployment_mismatch", "aborted_driver_restart", "expired", "cancelled"];
    const result = await this.pool.query(`select * from ${SCHEMA}.runs where cleanup_complete=false and state=any($1::text[]) order by updated_at asc limit $2`, [terminal, limit]);
    return result.rows.map(mapRun);
  }
  async listRunsPendingEvidence(limit: number): Promise<RunRecord[]> {
    const terminal = ["pending_external_evidence", "completed", "product_failed", "invalid_test", "inconclusive_provider", "failed_harness", "authorization_failed", "deployment_mismatch", "aborted_driver_restart", "expired", "cancelled"];
    const result = await this.pool.query(
      `select r.*
         from ${SCHEMA}.runs r
         left join ${SCHEMA}.evidence_manifests e on e.run_id=r.id
        where (
          r.state='exporting'
          and not exists (select 1 from ${SCHEMA}.operations o where o.run_id=r.id and o.state in ('accepted','queued','leased','executing'))
        ) or (
          r.state=any($1::text[]) and r.cleanup_complete=true
          and (e.run_id is null or e.revision_seq < r.latest_cursor)
        )
        order by r.updated_at asc limit $2`,
      [terminal, limit],
    );
    return result.rows.map(mapRun);
  }
  async listRunsCertificationDue(now: Date, limit: number): Promise<RunRecord[]> {
    const result = await this.pool.query(`select * from ${SCHEMA}.runs where state='pending_external_evidence' and expires_at <= $1 order by expires_at asc limit $2`, [now, limit]);
    return result.rows.map(mapRun);
  }
  async listRunsRetentionDue(now: Date, limit: number): Promise<RunRecord[]> {
    const terminal = ["pending_external_evidence", "completed", "product_failed", "invalid_test", "inconclusive_provider", "failed_harness", "authorization_failed", "deployment_mismatch", "aborted_driver_restart", "expired", "cancelled"];
    const result = await this.pool.query(
      `select * from ${SCHEMA}.runs
        where state=any($1::text[]) and cleanup_complete=true and retention_purge_pending=true
          and retention_purge_due_at is not null and retention_purge_due_at <= $2 and evidence_purged_at is null
        order by retention_purge_due_at asc limit $3`,
      [terminal, now, limit],
    );
    return result.rows.map(mapRun);
  }

  async reserveRollingAdmission(reservation: RollingAdmissionReservation, limits: RollingAdmissionLimits): Promise<RollingAdmissionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await reserveRollingAdmissionTx(client, reservation, limits, this.#callerPartitions);
      await client.query("commit");
      return result;
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }

  async createRunWithOperation(run: RunRecord, operation: NewOperation, limits: { global: number; caller: number }, rolling?: RollingAdmissionFence): Promise<{ run: RunRecord; operation: OperationRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const rollingAdmission = rolling ? await reserveRollingAdmissionTx(client, rolling.reservation, rolling.limits, this.#callerPartitions) : undefined;
      // Starts are serialized before the replay check so concurrent callers
      // cannot both miss the same idempotency key or race the quota count.
      await client.query("select pg_advisory_xact_lock(hashtext('sophia_voice_lab_run_quota'))");
      const existing = await client.query(`select * from ${SCHEMA}.operations where caller_id=$1 and type='start' and idempotency_key=$2`, [operation.callerId, operation.idempotencyKey]);
      if (existing.rows[0]) {
        const prior = mapOperation(existing.rows[0]);
        assertSameRequest(prior, operation.requestHash);
        const priorRun = await client.query(`select * from ${SCHEMA}.runs where id=$1`, [prior.runId]);
        await client.query("commit");
        return { run: mapRun(priorRun.rows[0]), operation: prior, replay: true, ...(rollingAdmission ? { rollingAdmission } : {}) };
      }
      if (rollingAdmission?.replay) throw conflict("IDEMPOTENCY_RETENTION_EXPIRED", "The idempotent start receipt was retention-purged and cannot be replayed or reallocated.");
      const terminal = ["pending_external_evidence", "completed", "product_failed", "invalid_test", "inconclusive_provider", "failed_harness", "authorization_failed", "deployment_mismatch", "aborted_driver_restart", "expired", "cancelled"];
      const quota = await client.query<{ global_count: string; caller_count: string }>(
        `select count(*)::text as global_count, count(*) filter (where caller_id=$1)::text as caller_count from ${SCHEMA}.runs where cleanup_complete=false or not (state = any($2::text[]))`,
        [operation.callerId, terminal],
      );
      if (Number(quota.rows[0]?.global_count ?? 0) >= limits.global || Number(quota.rows[0]?.caller_count ?? 0) >= limits.caller) throw conflict("CONCURRENCY_LIMIT", "Voice Lab concurrency limit is reached.");
      await client.query(
        `insert into ${SCHEMA}.runs (id,caller_id,principal_id,test_run_id,cleanup_obligation_id,environment,scenario_id,scenario_version,state,version,target,observed_deployment,capture_policy,verdicts,canonical_session_id,thread_id,provider_session_id,trace_id,provider_epoch,turn_id,latest_cursor,expires_at,created_at,updated_at,cleanup_complete,retention_purge_due_at,retention_purge_pending,retention_purge_verified_at,evidence_purged_at,terminal_error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
        runValues(run),
      );
      const inserted = await client.query(
        `insert into ${SCHEMA}.operations (id,run_id,caller_id,type,state,idempotency_key,request_hash,input)
         values ($1,$2,$3,$4,'queued',$5,$6,$7) returning *`,
        [operation.id, operation.runId, operation.callerId, operation.type, operation.idempotencyKey, operation.requestHash, operation.input],
      );
      await client.query("commit");
      return { run, operation: mapOperation(inserted.rows[0]), replay: false, ...(rollingAdmission ? { rollingAdmission } : {}) };
    } catch (error) {
      await client.query("rollback");
      throw translatePgError(error);
    } finally { client.release(); }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.runs where id=$1`, [runId]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async getRetentionTombstone(runId: string, callerId: string): Promise<RetentionTombstone | null> {
    if (!this.#retentionKey) return null;
    const result = await this.pool.query<{ remote_purge_status: "confirmed" | "unconfirmed"; purged_at: Date }>(`select remote_purge_status,purged_at from ${SCHEMA}.retention_tombstones where lookup_id_hmac=$1 and control_expires_at>now()`, [retentionHmac(this.#retentionKey, "lookup", `${runId}\u0000${callerId}`)]);
    return result.rows[0] ? { purgedAt: new Date(result.rows[0].purged_at), remotePurgeStatus: result.rows[0].remote_purge_status } : null;
  }

  async updateRun(runId: string, expectedVersion: number, patch: RunPatch): Promise<RunRecord> {
    const current = await this.getRun(runId);
    if (!current) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    const next: RunRecord = { ...current, ...patch, version: current.version + 1, updatedAt: new Date() };
    const result = await this.pool.query(
      `update ${SCHEMA}.runs set state=$3,version=version+1,observed_deployment=$4,verdicts=$5,canonical_session_id=$6,thread_id=$7,provider_session_id=$8,trace_id=$9,provider_epoch=$10,turn_id=$11,terminal_error=$12,cleanup_complete=$13,retention_purge_due_at=$14,retention_purge_pending=$15,retention_purge_verified_at=$16,updated_at=now()
       where id=$1 and version=$2 returning *`,
      [runId, expectedVersion, next.state, next.observedDeployment, next.verdicts, next.canonicalSessionId, next.threadId, next.providerSessionId, next.traceId, next.providerEpoch, next.turnId, next.terminalError, next.cleanupComplete, next.retentionPurgeDueAt, next.retentionPurgePending, next.retentionPurgeVerifiedAt],
    );
    if (!result.rows[0]) throw conflict("RUN_VERSION_CONFLICT", "Run changed concurrently.");
    return mapRun(result.rows[0]);
  }

  async createOperation(operation: NewOperation, admission?: OperationAdmission, rolling?: RollingAdmissionFence): Promise<{ operation: OperationRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const rollingAdmission = rolling ? await reserveRollingAdmissionTx(client, rolling.reservation, rolling.limits, this.#callerPartitions) : undefined;
      // The run row is the durable per-session admission/idempotency fence for
      // every operation, including non-audio operations.
      const lockedRun = await client.query(`select id from ${SCHEMA}.runs where id=$1 for update`, [operation.runId]);
      if (!lockedRun.rows[0]) throw notFound("RUN_NOT_FOUND", "Run was not found.");
      const existing = await client.query(`select * from ${SCHEMA}.operations where caller_id=$1 and run_id=$2 and type=$3 and idempotency_key=$4`, [operation.callerId, operation.runId, operation.type, operation.idempotencyKey]);
      if (existing.rows[0]) {
        const prior = mapOperation(existing.rows[0]);
        if (prior.runId !== operation.runId) throw conflict("IDEMPOTENCY_SCOPE_VIOLATION", "Idempotent operation belongs to a different run.");
        assertSameRequest(prior, operation.requestHash);
        await client.query("commit");
        return { operation: prior, replay: true, ...(rollingAdmission ? { rollingAdmission } : {}) };
      }
      const d02Fence = await client.query(
        `select 1 from ${SCHEMA}.run_events
          where run_id=$1 and source='canonical'
            and kind in ('product.d02_browser_worker_termination_freeze_pending','product.d02_gateway_browser_worker_termination_frozen','product.d02_render_worker_dispatch_claimed')
          limit 1`,
        [operation.runId],
      );
      if (d02Fence.rows[0]) throw conflict("D02_RUN_FROZEN", "The D02 browser-worker termination freeze forbids every new run operation.");
      if (admission && (operation.type === "speak" || operation.type === "barge_in")) {
        const usage = await client.query<{ utterances: string; duration_ms: string; injected_bytes: string; latest_at: Date | null }>(
          `select count(*)::text as utterances,
                  coalesce(sum(coalesce((input #>> '{_admission,duration_ms}')::bigint,0)),0)::text as duration_ms,
                  coalesce(sum(coalesce((input #>> '{_admission,bytes}')::bigint,0)),0)::text as injected_bytes,
                  max(created_at) as latest_at
             from ${SCHEMA}.operations
            where run_id=$1 and type in ('speak','barge_in') and state not in ('failed','timed_out','cancelled')`,
          [operation.runId],
        );
        const row = usage.rows[0]!;
        const reservation = operation.input._admission as Record<string, unknown> | undefined;
        if (Number(row.utterances) >= admission.maxUtterances) throw conflict("UTTERANCE_LIMIT", "Run utterance count limit is reached.");
        if (row.latest_at && Date.now() - new Date(row.latest_at).getTime() < admission.minIntervalMs) throw conflict("UTTERANCE_RATE_LIMIT", "Run utterance minimum interval has not elapsed.");
        if (Number(row.duration_ms) + Number(reservation?.duration_ms ?? 0) > admission.maxTotalDurationMs) throw conflict("INJECTED_DURATION_LIMIT", "Run cumulative injected duration budget would be exceeded.");
        if (Number(row.injected_bytes) + Number(reservation?.bytes ?? 0) > admission.maxTotalBytes) throw conflict("INJECTED_BYTES_LIMIT", "Run cumulative injected byte budget would be exceeded.");
      }
      const result = await client.query(
        `insert into ${SCHEMA}.operations (id,run_id,caller_id,type,state,idempotency_key,request_hash,input)
         values ($1,$2,$3,$4,'queued',$5,$6,$7) returning *`,
        [operation.id, operation.runId, operation.callerId, operation.type, operation.idempotencyKey, operation.requestHash, operation.input],
      );
      await client.query("commit");
      return { operation: mapOperation(result.rows[0]), replay: false, ...(rollingAdmission ? { rollingAdmission } : {}) };
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }

  async getOperation(operationId: string): Promise<OperationRecord | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.operations where id=$1`, [operationId]);
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }
  async listOperations(runId: string): Promise<OperationRecord[]> {
    const result = await this.pool.query(`select * from ${SCHEMA}.operations where run_id=$1 order by created_at asc`, [runId]);
    return result.rows.map(mapOperation);
  }

  async claimNextOperation(workerId: string, leaseSeconds: number): Promise<ClaimedOperation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `with candidate as (
           select o.id from ${SCHEMA}.operations o
           left join ${SCHEMA}.browser_leases b on b.run_id=o.run_id
           where (o.state in ('accepted','queued') or (o.state in ('leased','executing') and o.lease_expires_at < now()))
             and not exists (
               select 1 from ${SCHEMA}.run_events fence
                where fence.run_id=o.run_id and fence.source='canonical'
                  and fence.kind in ('product.d02_browser_worker_termination_freeze_pending','product.d02_gateway_browser_worker_termination_frozen','product.d02_render_worker_dispatch_claimed')
             )
             and (o.type='start' or (b.worker_id=$1 and b.expires_at > now()) or (o.type='end' and exists (select 1 from ${SCHEMA}.runs r where r.id=o.run_id and r.state in ('ending','finalizing','exporting'))))
           order by o.created_at asc for update of o skip locked limit 1
         )
         update ${SCHEMA}.operations o set state='leased',lease_owner=$1,lease_epoch=o.lease_epoch+1,
           lease_expires_at=now()+make_interval(secs=>$2),attempt_count=o.attempt_count+1,updated_at=now()
         from candidate where o.id=candidate.id returning o.*`,
        [workerId, leaseSeconds],
      );
      if (!result.rows[0]) { await client.query("commit"); return null; }
      const operation = mapOperation(result.rows[0]);
      const runResult = await client.query(`select * from ${SCHEMA}.runs where id=$1`, [operation.runId]);
      await client.query("commit");
      return { operation, run: mapRun(runResult.rows[0]) };
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }

  async markOperationExecuting(operationId: string, workerId: string, leaseEpoch: number): Promise<OperationRecord> {
    return this.#updateOwnedOperation(
      `update ${SCHEMA}.operations o set state='executing',updated_at=now()
        where id=$1 and lease_owner=$2 and lease_epoch=$3 and state='leased'
          and not exists (
            select 1 from ${SCHEMA}.run_events fence
             where fence.run_id=o.run_id and fence.source='canonical'
               and fence.kind in ('product.d02_browser_worker_termination_freeze_pending','product.d02_gateway_browser_worker_termination_frozen','product.d02_render_worker_dispatch_claimed')
          ) returning o.*`,
      [operationId, workerId, leaseEpoch],
    );
  }

  async heartbeatOperation(operationId: string, workerId: string, leaseEpoch: number, leaseSeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `update ${SCHEMA}.operations set lease_expires_at=now()+make_interval(secs=>$4),updated_at=now() where id=$1 and lease_owner=$2 and lease_epoch=$3 and state in ('leased','executing')`,
      [operationId, workerId, leaseEpoch, leaseSeconds],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async finishOperation(operationId: string, workerId: string, leaseEpoch: number, state: Extract<OperationState, "succeeded" | "failed" | "timed_out" | "cancelled">, result: Record<string, unknown> | null, error: LabError | null): Promise<OperationRecord> {
    return this.#updateOwnedOperation(
      `update ${SCHEMA}.operations set state=$4,result=$5,error=$6,lease_owner=null,lease_expires_at=null,updated_at=now() where id=$1 and lease_owner=$2 and lease_epoch=$3 and state in ('leased','executing') returning *`,
      [operationId, workerId, leaseEpoch, state, result, error],
    );
  }

  async cancelPendingRunOperations(runId: string, exceptOperationId: string | null, error: LabError): Promise<OperationRecord[]> {
    const result = await this.pool.query(
      `update ${SCHEMA}.operations
          set state='cancelled',result=null,error=$3,lease_owner=null,lease_expires_at=null,updated_at=now()
        where run_id=$1 and ($2::uuid is null or id<>$2::uuid) and state in ('queued','leased','executing')
        returning *`,
      [runId, exceptOperationId, error],
    );
    return result.rows.map(mapOperation);
  }

  async #updateOwnedOperation(sql: string, values: unknown[]): Promise<OperationRecord> {
    const result = await this.pool.query(sql, values);
    if (!result.rows[0]) throw conflict("LEASE_LOST", "Operation lease is no longer owned by this worker.");
    return mapOperation(result.rows[0]);
  }

  async claimEvent(runId: string, kind: string, source: LabEvent["source"], payload: Record<string, unknown>, dedupeKey: string, observedAt = new Date(), guard?: EventClaimGuard): Promise<{ event: LabEvent; replay: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query(`select * from ${SCHEMA}.runs where id=$1 for update`, [runId]);
      if (!locked.rows[0]) throw notFound("RUN_NOT_FOUND", "Run was not found.");
      const existing = await client.query(`select * from ${SCHEMA}.run_events where run_id=$1 and dedupe_key=$2`, [runId, dedupeKey]);
      if (existing.rows[0]) {
        const prior = mapEvent(existing.rows[0]);
        if (prior.kind !== kind || prior.source !== source || canonicalRequestHash(prior.payload) !== canonicalRequestHash(payload)) throw conflict("DEDUPE_CONFLICT", "Event dedupe key was reused with different canonical evidence.");
        await client.query("commit");
        return { event: prior, replay: true };
      }
      if (guard) {
        const [eventRows, operationRows, leaseRows, clock] = await Promise.all([
          client.query(`select * from ${SCHEMA}.run_events where run_id=$1 order by seq asc`, [runId]),
          client.query(`select * from ${SCHEMA}.operations where run_id=$1 order by created_at asc`, [runId]),
          client.query(`select * from ${SCHEMA}.browser_leases where run_id=$1 for update`, [runId]),
          client.query<{ database_now: Date }>("select clock_timestamp() as database_now"),
        ]);
        guard({
          run: mapRun(locked.rows[0]),
          events: eventRows.rows.map(mapEvent),
          operations: operationRows.rows.map(mapOperation),
          browserLease: leaseRows.rows[0] ? mapLease(leaseRows.rows[0]) : null,
          databaseNow: new Date(clock.rows[0]!.database_now),
        });
      }
      const seq = Number(locked.rows[0].latest_cursor) + 1;
      const inserted = await client.query(
        `insert into ${SCHEMA}.run_events (run_id,seq,kind,source,payload,dedupe_key,observed_at) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [runId, seq, kind, source, payload, dedupeKey ?? null, observedAt],
      );
      await client.query(`update ${SCHEMA}.runs set latest_cursor=$2,updated_at=now() where id=$1`, [runId, seq]);
      await client.query("commit");
      return { event: mapEvent(inserted.rows[0]), replay: false };
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }

  async appendEvent(runId: string, kind: string, source: LabEvent["source"], payload: Record<string, unknown>, dedupeKey?: string, observedAt = new Date()): Promise<LabEvent> {
    if (dedupeKey) return (await this.claimEvent(runId, kind, source, payload, dedupeKey, observedAt)).event;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query<{ latest_cursor: number }>(`select latest_cursor from ${SCHEMA}.runs where id=$1 for update`, [runId]);
      if (!locked.rows[0]) throw notFound("RUN_NOT_FOUND", "Run was not found.");
      const seq = Number(locked.rows[0].latest_cursor) + 1;
      const inserted = await client.query(
        `insert into ${SCHEMA}.run_events (run_id,seq,kind,source,payload,dedupe_key,observed_at) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [runId, seq, kind, source, payload, null, observedAt],
      );
      await client.query(`update ${SCHEMA}.runs set latest_cursor=$2,updated_at=now() where id=$1`, [runId, seq]);
      await client.query("commit");
      return mapEvent(inserted.rows[0]);
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }

  async listEvents(runId: string, after: number, limit: number): Promise<EventPage> {
    const run = await this.getRun(runId);
    if (!run) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    const result = await this.pool.query(`select * from ${SCHEMA}.run_events where run_id=$1 and seq>$2 order by seq asc limit $3`, [runId, after, limit]);
    return { events: result.rows.map(mapEvent), after, latest: run.latestCursor };
  }
  async findLatestEvent(runId: string, kinds: string[]): Promise<LabEvent | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.run_events where run_id=$1 and kind=any($2::text[]) order by seq desc limit 1`, [runId, kinds]);
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async createSuite(suite: SuiteRecord, rolling?: RollingAdmissionFence): Promise<{ suite: SuiteRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const rollingAdmission = rolling ? await reserveRollingAdmissionTx(client, rolling.reservation, rolling.limits, this.#callerPartitions) : undefined;
      const result = await client.query(
        `insert into ${SCHEMA}.suite_runs (id,caller_id,idempotency_key,request_hash,state,scenario_ids,run_ids,definition,next_scenario_index,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (caller_id,idempotency_key) do nothing returning *`,
        [suite.id, suite.callerId, suite.idempotencyKey, suite.requestHash, suite.state, suite.scenarioIds, suite.runIds, suite.definition, suite.nextScenarioIndex, suite.createdAt, suite.updatedAt],
      );
      if (result.rows[0]) {
        if (rollingAdmission?.replay) throw conflict("IDEMPOTENCY_RETENTION_EXPIRED", "The idempotent suite receipt was retention-purged and cannot be replayed or reallocated.");
        await client.query("commit");
        return { suite: mapSuite(result.rows[0]), replay: false, ...(rollingAdmission ? { rollingAdmission } : {}) };
      }
      const existing = await client.query(`select * from ${SCHEMA}.suite_runs where caller_id=$1 and idempotency_key=$2`, [suite.callerId, suite.idempotencyKey]);
      const prior = mapSuite(existing.rows[0]);
      if (prior.requestHash !== suite.requestHash) throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different arguments.");
      await client.query("commit");
      return { suite: prior, replay: true, ...(rollingAdmission ? { rollingAdmission } : {}) };
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }

  async getSuite(suiteId: string): Promise<SuiteRecord | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.suite_runs where id=$1`, [suiteId]);
    return result.rows[0] ? mapSuite(result.rows[0]) : null;
  }

  async listRunnableSuites(limit: number): Promise<SuiteRecord[]> {
    const result = await this.pool.query(`select * from ${SCHEMA}.suite_runs where state in ('accepted','running') order by created_at asc limit $1`, [limit]);
    return result.rows.map(mapSuite);
  }

  async listSuitesPendingEvidence(limit: number): Promise<SuiteRecord[]> {
    const result = await this.pool.query(`select s.* from ${SCHEMA}.suite_runs s left join ${SCHEMA}.suite_evidence_manifests e on e.suite_id=s.id where s.state in ('completed','failed','cancelled') and e.suite_id is null order by s.updated_at asc limit $1`, [limit]);
    return result.rows.map(mapSuite);
  }

  async updateSuite(suiteId: string, state: SuiteRecord["state"], runIds?: string[], nextScenarioIndex?: number): Promise<SuiteRecord> {
    const result = await this.pool.query(`update ${SCHEMA}.suite_runs set state=$2,run_ids=coalesce($3,run_ids),next_scenario_index=coalesce($4,next_scenario_index),updated_at=now() where id=$1 returning *`, [suiteId, state, runIds ?? null, nextScenarioIndex ?? null]);
    if (!result.rows[0]) throw notFound("SUITE_NOT_FOUND", "Suite run was not found.");
    return mapSuite(result.rows[0]);
  }

  async saveSuiteEvidence(evidence: SuiteEvidenceRecord): Promise<SuiteEvidenceRecord> {
    if (sha256(evidence.bytes) !== evidence.manifestSha256) throw conflict("SUITE_EVIDENCE_DIGEST_MISMATCH", "Suite evidence bytes do not match the declared SHA-256 digest.");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const suite = await client.query(`select id from ${SCHEMA}.suite_runs where id=$1 for update`, [evidence.suiteId]);
      if (!suite.rows[0]) throw notFound("SUITE_NOT_FOUND", "Suite run was not found.");
      const prior = await client.query(`select * from ${SCHEMA}.suite_evidence_manifests where suite_id=$1 or manifest_id=$2 limit 1`, [evidence.suiteId, evidence.manifestId]);
      if (prior.rows[0]) {
        const existing = mapSuiteEvidence(prior.rows[0]);
        if (existing.suiteId !== evidence.suiteId || existing.manifestId !== evidence.manifestId || existing.manifestSha256 !== evidence.manifestSha256 || existing.schemaVersion !== evidence.schemaVersion || canonicalRequestHash(existing.artifactRefs) !== canonicalRequestHash(evidence.artifactRefs) || !existing.bytes.equals(evidence.bytes)) throw conflict("SUITE_EVIDENCE_CONFLICT", "Terminal suite evidence is immutable and was replayed with different content.");
        await client.query("commit");
        return existing;
      }
      const inserted = await client.query(`insert into ${SCHEMA}.suite_evidence_manifests (suite_id,manifest_id,manifest_sha256,schema_version,bytes,artifact_refs,created_at) values ($1,$2,$3,$4,$5,$6,$7) returning *`, [evidence.suiteId, evidence.manifestId, evidence.manifestSha256, evidence.schemaVersion, evidence.bytes, evidence.artifactRefs, evidence.createdAt]);
      await client.query("commit");
      return mapSuiteEvidence(inserted.rows[0]);
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }
  async getSuiteEvidence(suiteId: string): Promise<SuiteEvidenceRecord | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.suite_evidence_manifests where suite_id=$1`, [suiteId]);
    return result.rows[0] ? mapSuiteEvidence(result.rows[0]) : null;
  }
  async getSuiteEvidenceByManifestId(manifestId: string): Promise<SuiteEvidenceRecord | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.suite_evidence_manifests where manifest_id=$1`, [manifestId]);
    return result.rows[0] ? mapSuiteEvidence(result.rows[0]) : null;
  }

  async saveEvidence(evidence: EvidenceRecord): Promise<EvidenceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const run = await client.query(`select id from ${SCHEMA}.runs where id=$1 for update`, [evidence.runId]);
      if (!run.rows[0]) throw notFound("RUN_NOT_FOUND", "Run was not found.");
      const insertedRevision = await client.query(
        `insert into ${SCHEMA}.evidence_manifest_revisions (manifest_id,run_id,revision_seq,manifest_sha256,schema_version,artifact_refs,created_at)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict (manifest_id) do nothing returning *`,
        [evidence.manifestId, evidence.runId, evidence.revisionSeq, evidence.manifestSha256, evidence.schemaVersion, evidence.artifactRefs, evidence.createdAt],
      );
      if (!insertedRevision.rows[0]) {
        const priorRevision = await client.query(`select * from ${SCHEMA}.evidence_manifest_revisions where manifest_id=$1`, [evidence.manifestId]);
        const prior = mapEvidence(priorRevision.rows[0]);
        if (canonicalRequestHash(prior) !== canonicalRequestHash(evidence)) throw conflict("EVIDENCE_REVISION_CONFLICT", "Evidence manifest revision is immutable and was replayed with different metadata.");
      }
      const currentResult = await client.query(`select * from ${SCHEMA}.evidence_manifests where run_id=$1 for update`, [evidence.runId]);
      const current = currentResult.rows[0] ? mapEvidence(currentResult.rows[0]) : null;
      if (current && current.revisionSeq > evidence.revisionSeq) { await client.query("commit"); return current; }
      if (current && current.revisionSeq === evidence.revisionSeq && current.manifestId !== evidence.manifestId) throw conflict("EVIDENCE_REVISION_CONFLICT", "Evidence revision sequence was reused by a different manifest.");
      const result = await client.query(
        `insert into ${SCHEMA}.evidence_manifests (run_id,manifest_id,manifest_sha256,schema_version,revision_seq,artifact_refs,created_at)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (run_id) do update set manifest_id=excluded.manifest_id,manifest_sha256=excluded.manifest_sha256,schema_version=excluded.schema_version,revision_seq=excluded.revision_seq,artifact_refs=excluded.artifact_refs,created_at=excluded.created_at returning *`,
        [evidence.runId, evidence.manifestId, evidence.manifestSha256, evidence.schemaVersion, evidence.revisionSeq, evidence.artifactRefs, evidence.createdAt],
      );
      await client.query("commit");
      return mapEvidence(result.rows[0]);
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }

  async getEvidence(runId: string): Promise<EvidenceRecord | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.evidence_manifests where run_id=$1`, [runId]);
    return result.rows[0] ? mapEvidence(result.rows[0]) : null;
  }

  async saveArtifact(artifact: DurableArtifact): Promise<DurableArtifact> {
    if (sha256(artifact.bytes) !== artifact.sha256) throw conflict("ARTIFACT_DIGEST_MISMATCH", "Artifact bytes do not match the declared SHA-256 digest.");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query(`select id from ${SCHEMA}.runs where id=$1 for update`, [artifact.runId]);
      if (!locked.rows[0]) throw notFound("RUN_NOT_FOUND", "Run was not found.");
      const prior = await client.query(`select * from ${SCHEMA}.artifacts where id=$1 or (run_id=$2 and sha256=$3) order by (id=$1) desc limit 1`, [artifact.id, artifact.runId, artifact.sha256]);
      if (prior.rows[0]) {
        const existing = mapArtifact(prior.rows[0]);
        if (existing.runId !== artifact.runId || existing.kind !== artifact.kind || existing.contentType !== artifact.contentType || existing.sha256 !== artifact.sha256 || !existing.bytes.equals(artifact.bytes)) {
          throw conflict("ARTIFACT_ID_CONFLICT", "Artifact ID or content hash is already bound to incompatible evidence.");
        }
        await client.query("commit");
        // Content-addressed replay may return the already persisted canonical
        // row even when a crash retry proposed a different deterministic ID.
        return existing;
      }
      const result = await client.query(
        `insert into ${SCHEMA}.artifacts (id,run_id,kind,content_type,sha256,bytes,created_at) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [artifact.id, artifact.runId, artifact.kind, artifact.contentType, artifact.sha256, artifact.bytes, artifact.createdAt],
      );
      await client.query("commit");
      return mapArtifact(result.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw translatePgError(error);
    } finally { client.release(); }
  }

  async getArtifact(artifactId: string): Promise<DurableArtifact | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.artifacts where id=$1`, [artifactId]);
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  }
  async listArtifacts(runId: string): Promise<DurableArtifact[]> {
    const result = await this.pool.query(`select * from ${SCHEMA}.artifacts where run_id=$1 order by created_at asc,id asc`, [runId]);
    return result.rows.map(mapArtifact);
  }

  async upsertBrowserLease(runId: string, workerId: string, leaseSeconds: number): Promise<BrowserLease> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const prior = await client.query(`select * from ${SCHEMA}.browser_leases where run_id=$1 for update`, [runId]);
      if (prior.rows[0] && prior.rows[0].worker_id !== workerId && new Date(prior.rows[0].expires_at) > new Date()) throw conflict("BROWSER_ALREADY_LEASED", "Browser is owned by another live worker.");
      const result = await client.query(
        `insert into ${SCHEMA}.browser_leases (run_id,worker_id,lease_epoch,expires_at,updated_at) values ($1,$2,1,now()+make_interval(secs=>$3),now())
         on conflict (run_id) do update set worker_id=excluded.worker_id,lease_epoch=${SCHEMA}.browser_leases.lease_epoch+1,expires_at=excluded.expires_at,updated_at=now() returning *`,
        [runId, workerId, leaseSeconds],
      );
      await client.query("commit");
      return mapLease(result.rows[0]);
    } catch (error) { await client.query("rollback"); throw translatePgError(error); }
    finally { client.release(); }
  }

  async getBrowserLease(runId: string): Promise<BrowserLease | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.browser_leases where run_id=$1`, [runId]);
    return result.rows[0] ? mapLease(result.rows[0]) : null;
  }

  async heartbeatBrowserLease(runId: string, workerId: string, leaseEpoch: number, leaseSeconds: number): Promise<boolean> {
    const result = await this.pool.query(`update ${SCHEMA}.browser_leases set expires_at=now()+make_interval(secs=>$4),updated_at=now() where run_id=$1 and worker_id=$2 and lease_epoch=$3`, [runId, workerId, leaseEpoch, leaseSeconds]);
    return (result.rowCount ?? 0) === 1;
  }

  async releaseBrowserLease(runId: string, workerId: string, leaseEpoch: number): Promise<boolean> {
    const result = await this.pool.query(`delete from ${SCHEMA}.browser_leases where run_id=$1 and worker_id=$2 and lease_epoch=$3`, [runId, workerId, leaseEpoch]);
    return (result.rowCount ?? 0) === 1;
  }

  async reapExpiredBrowserLeases(now = new Date()): Promise<BrowserLease[]> {
    const result = await this.pool.query(`delete from ${SCHEMA}.browser_leases where expires_at <= $1 returning *`, [now]);
    return result.rows.map(mapLease);
  }

  async heartbeatWorker(heartbeat: WorkerHeartbeat): Promise<void> {
    const durableDetail = { ...heartbeat.detail, heartbeat_attestation: heartbeat.attestation };
    await this.pool.query(`insert into ${SCHEMA}.worker_heartbeats (worker_id,service_version,browser_ready,detail,observed_at) values ($1,$2,$3,$4,$5) on conflict (worker_id) do update set service_version=excluded.service_version,browser_ready=excluded.browser_ready,detail=excluded.detail,observed_at=excluded.observed_at`, [heartbeat.workerId, heartbeat.serviceVersion, heartbeat.browserReady, durableDetail, heartbeat.observedAt]);
  }

  async listLiveWorkers(since: Date): Promise<WorkerHeartbeat[]> {
    const result = await this.pool.query(`select * from ${SCHEMA}.worker_heartbeats where observed_at >= $1 order by observed_at desc`, [since]);
    return result.rows.map((row) => {
      const durableDetail = row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? row.detail as Record<string, unknown> : {};
      const { heartbeat_attestation: attestation = null, ...detail } = durableDetail;
      return { workerId: row.worker_id, serviceVersion: row.service_version, browserReady: row.browser_ready, attestation: attestation as WorkerHeartbeat["attestation"], detail, observedAt: new Date(row.observed_at) };
    });
  }

  async recordAuthAudit(record: AuthAuditRecord): Promise<void> {
    const callerId = record.runId === null ? null : record.callerId;
    const callerPartitionId = this.#callerPartitions.activeCallerId(record.callerId);
    await this.pool.query(`insert into ${SCHEMA}.auth_audit (run_id,caller_id,caller_partition_id,action,capability_jti_hash,argument_hash,outcome,detail,observed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [record.runId, callerId, callerPartitionId, record.action, record.capabilityJtiHash ?? null, record.argumentHash, record.outcome, record.detail, record.observedAt]);
  }

  async claimPrincipalProvision(preparation: PrincipalProvisionPreparation, leaseOwner: string, leaseSeconds: number, _now: Date): Promise<PrincipalProvisionClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Provisioning is a one-time operator action. A global transaction lock
      // makes request-key and principal-key uniqueness one atomic decision.
      await client.query("select pg_advisory_xact_lock(hashtext('sophia_voice_lab_principal_provision'))");
      const selected = await client.query(
        `select *,date_trunc('milliseconds',clock_timestamp()) as database_now
           from ${SCHEMA}.principal_provisions
          order by (request_hash=$1) desc
          for update`,
        [preparation.requestHash],
      );
      const exact = selected.rows.find((row) => row.request_hash === preparation.requestHash);
      const singleton = selected.rows[0];
      if (!exact && singleton) {
        await client.query("commit");
        return { disposition: "conflict", record: mapPrincipalProvision(singleton) };
      }
      if (!exact) {
        const reservation = await client.query<{ auth_audit_id: string; audit_observed_at: Date }>(
          `select nextval(pg_get_serial_sequence('${SCHEMA}.auth_audit','id'))::text as auth_audit_id,
                  date_trunc('milliseconds',clock_timestamp()) as audit_observed_at`,
        );
        const reserved = reservation.rows[0]!;
        const inserted = await client.query(
          `insert into ${SCHEMA}.principal_provisions
             (request_hash,idempotency_key_hash,principal_hash,caller_partition_id,issued_at,test_run_id,cleanup_obligation_id,
              capability_jti,capability_nonce,capability_hash,provider_expires_at,environment,expected_deployment,mcp_build,
              operator_subject_hash,auth_audit_id,audit_observed_at,state,lease_owner,lease_expires_at,attempt_count)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'prepared',$18,
                   clock_timestamp()+make_interval(secs=>$19),1)
           returning *`,
          [
            preparation.requestHash,
            preparation.idempotencyKeyHash,
            preparation.principalHash,
            this.#callerPartitions.activeCallerId(preparation.callerId),
            preparation.issuedAt,
            preparation.testRunId,
            preparation.cleanupObligationId,
            preparation.capabilityJti,
            preparation.capabilityNonce,
            preparation.capabilityHash,
            preparation.providerExpiresAt,
            preparation.environment,
            preparation.expectedDeployment,
            preparation.mcpBuild,
            preparation.operatorSubjectHash,
            reserved.auth_audit_id,
            reserved.audit_observed_at,
            leaseOwner,
            leaseSeconds,
          ],
        );
        await client.query("commit");
        return { disposition: "claimed", record: mapPrincipalProvision(inserted.rows[0]) };
      }
      const record = mapPrincipalProvision(exact);
      if (record.principalHash !== preparation.principalHash) {
        await client.query("commit");
        return { disposition: "conflict", record };
      }
      if (record.state === "completed") {
        await client.query("commit");
        return { disposition: "completed", record };
      }
      const databaseNow = new Date(exact.database_now);
      if (record.leaseOwner !== null && record.leaseExpiresAt !== null && record.leaseExpiresAt > databaseNow) {
        await client.query("commit");
        return { disposition: "pending", record };
      }
      const claimed = await client.query(
        `update ${SCHEMA}.principal_provisions
            set lease_owner=$2,lease_expires_at=clock_timestamp()+make_interval(secs=>$3),
                attempt_count=attempt_count+1,updated_at=clock_timestamp()
          where request_hash=$1 and state='prepared'
          returning *`,
        [preparation.requestHash, leaseOwner, leaseSeconds],
      );
      await client.query("commit");
      return { disposition: "claimed", record: mapPrincipalProvision(claimed.rows[0]) };
    } catch (caught) {
      await client.query("rollback").catch(() => undefined);
      throw translatePgError(caught);
    } finally {
      client.release();
    }
  }

  async rotatePrincipalProvisionCapability(requestHash: string, leaseOwner: string, rotation: PrincipalProvisionCapabilityRotation, _now: Date): Promise<PrincipalProvisionControlRecord> {
    const updated = await this.pool.query(
      `update ${SCHEMA}.principal_provisions
          set issued_at=$3,capability_jti=$4,capability_nonce=$5,capability_hash=$6,
              provider_expires_at=$7,updated_at=clock_timestamp()
        where request_hash=$1 and state='prepared' and lease_owner=$2
        returning *`,
      [requestHash, leaseOwner, rotation.issuedAt, rotation.capabilityJti, rotation.capabilityNonce, rotation.capabilityHash, rotation.providerExpiresAt],
    );
    if (!updated.rows[0]) throw new VoiceLabError(labError("PRINCIPAL_PROVISION_LEASE_LOST", "Principal provision rotation no longer owns the durable lease.", "internal"));
    return mapPrincipalProvision(updated.rows[0]);
  }

  async finalizePrincipalProvision(requestHash: string, leaseOwner: string, receipt: Record<string, unknown>, audit: AuthAuditRecord, _now: Date): Promise<PrincipalProvisionControlRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query(`select * from ${SCHEMA}.principal_provisions where request_hash=$1 for update`, [requestHash]);
      const row = selected.rows[0];
      if (!row) throw new VoiceLabError(labError("PRINCIPAL_PROVISION_PREPARE_MISSING", "Principal provision prepare record is missing.", "internal"));
      const record = mapPrincipalProvision(row);
      if (!parseExactPrincipalProvisionReceipt(record, receipt)) {
        throw new VoiceLabError(labError('PRINCIPAL_PROVISION_RECEIPT_INVALID', 'Principal provision receipt does not match its durable prepare record.', 'internal'));
      }
      if (record.state === "completed") {
        if (canonicalRequestHash(record.receipt) !== canonicalRequestHash(receipt)) {
          throw new VoiceLabError(labError("PRINCIPAL_PROVISION_FINALIZE_CONFLICT", "Principal provision receipt conflicts with its durable chain.", "internal"));
        }
        const durableAudit = await client.query(
          `select 1 from ${SCHEMA}.auth_audit
            where id=$1 and run_id is null and action='principal.provision' and argument_hash=$2
              and outcome='allowed' and detail=$3::jsonb and observed_at=$4
              and caller_partition_id=$5 and capability_jti_hash=$6`,
          [record.authAuditId, requestHash, receipt, record.auditObservedAt, record.callerPartitionId, receipt.capability_jti_sha256],
        );
        if (!durableAudit.rows[0]) throw new VoiceLabError(labError("PRINCIPAL_PROVISION_AUDIT_MISSING", "The completed provision receipt has no exact durable audit row.", "internal"));
        await client.query("commit");
        return record;
      }
      const callerPartitionIds = this.#callerPartitions.callerIds(audit.callerId);
      if (
        record.leaseOwner !== leaseOwner
        || audit.runId !== null
        || audit.argumentHash !== requestHash
        || audit.action !== "principal.provision"
        || audit.outcome !== "allowed"
        || String(audit.id) !== record.authAuditId
        || audit.observedAt.toISOString() !== record.auditObservedAt.toISOString()
        || sha256(audit.callerId) !== record.operatorSubjectHash
        || !callerPartitionIds.includes(record.callerPartitionId)
        || audit.capabilityJtiHash !== receipt.capability_jti_sha256
        || canonicalRequestHash(audit.detail) !== canonicalRequestHash(receipt)
      ) throw new VoiceLabError(labError("PRINCIPAL_PROVISION_LEASE_LOST", "Principal provision finalize no longer owns the durable lease.", "internal"));

      const updated = await client.query(
        `update ${SCHEMA}.principal_provisions
            set state='completed',receipt=$3,lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp()
          where request_hash=$1 and state='prepared' and lease_owner=$2
          returning *`,
        [requestHash, leaseOwner, receipt],
      );
      if (!updated.rows[0]) throw new VoiceLabError(labError("PRINCIPAL_PROVISION_LEASE_LOST", "Principal provision finalize no longer owns the durable lease.", "internal"));
      await client.query(
        `insert into ${SCHEMA}.auth_audit
           (id,run_id,caller_id,caller_partition_id,action,capability_jti_hash,argument_hash,outcome,detail,observed_at)
         overriding system value
         values ($1,null,null,$2,$3,$4,$5,$6,$7,$8)`,
        [record.authAuditId, record.callerPartitionId, audit.action, audit.capabilityJtiHash ?? null, audit.argumentHash, audit.outcome, receipt, record.auditObservedAt],
      );
      await client.query("commit");
      return mapPrincipalProvision(updated.rows[0]);
    } catch (caught) {
      await client.query("rollback").catch(() => undefined);
      throw translatePgError(caught);
    } finally {
      client.release();
    }
  }

  async releasePrincipalProvision(requestHash: string, leaseOwner: string, _now: Date): Promise<boolean> {
    const released = await this.pool.query(
      `update ${SCHEMA}.principal_provisions
          set lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp()
        where request_hash=$1 and state='prepared' and lease_owner=$2`,
      [requestHash, leaseOwner],
    );
    return (released.rowCount ?? 0) === 1;
  }

  async getPrincipalProvisionReadiness(_now: Date): Promise<PrincipalProvisionReadiness> {
    const result = await this.pool.query(
      `select provision.*,
              audit.id::text as joined_audit_id,audit.run_id as joined_run_id,audit.action as joined_action,
              audit.argument_hash as joined_argument_hash,audit.outcome as joined_outcome,
              audit.detail as joined_detail,audit.observed_at as joined_observed_at,
              audit.caller_partition_id as joined_caller_partition_id,audit.capability_jti_hash as joined_capability_jti_hash
         from ${SCHEMA}.principal_provisions provision
         left join ${SCHEMA}.auth_audit audit on audit.id=provision.auth_audit_id`,
    );
    if (result.rows.length === 0) return { status: "absent" };
    if (result.rows.length !== 1) return { status: "invalid" };
    const row = result.rows[0];
    const record = mapPrincipalProvision(row);
    if (record.state === "prepared") return { status: record.receipt === null ? "prepared" : "invalid" };
    const valid = parseExactPrincipalProvisionReceipt(record, record.receipt) !== null
      && record.leaseOwner === null
      && record.leaseExpiresAt === null
      && row.joined_audit_id === record.authAuditId
      && row.joined_run_id === null
      && row.joined_action === "principal.provision"
      && row.joined_caller_partition_id === record.callerPartitionId
      && row.joined_capability_jti_hash === (record.receipt as Record<string, unknown>).capability_jti_sha256
      && row.joined_argument_hash === record.requestHash
      && row.joined_outcome === "allowed"
      && new Date(row.joined_observed_at).toISOString() === record.auditObservedAt.toISOString()
      && canonicalRequestHash(row.joined_detail) === canonicalRequestHash(record.receipt);
    return { status: valid ? "completed" : "invalid" };
  }

  async listAuthAudit(runId: string): Promise<AuthAuditRecord[]> {
    const result = await this.pool.query(`select * from ${SCHEMA}.auth_audit where run_id=$1 order by observed_at asc`, [runId]);
    return result.rows.map(mapAuthAudit);
  }

  async listAuthAuditByArgumentHashes(callerId: string, argumentHashes: string[], since: Date): Promise<AuthAuditRecord[]> {
    if (argumentHashes.length === 0 || argumentHashes.length > 100 || argumentHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) return [];
    const partitions = this.#callerPartitions.callerIds(callerId);
    const result = await this.pool.query(`select * from ${SCHEMA}.auth_audit where (caller_id=$1 or caller_partition_id=any($2::text[])) and argument_hash=any($3::text[]) and observed_at >= $4 order by observed_at asc`, [callerId, partitions, argumentHashes, since]);
    return result.rows.map(mapAuthAudit);
  }

  async listAuthAuditForCaller(callerId: string, since: Date, until: Date): Promise<AuthAuditRecord[]> {
    const partitions = this.#callerPartitions.callerIds(callerId);
    const result = await this.pool.query(`select * from ${SCHEMA}.auth_audit where (caller_id=$1 or caller_partition_id=any($2::text[])) and observed_at >= $3 and observed_at <= $4 order by observed_at asc,id asc`, [callerId, partitions, since, until]);
    return result.rows.map(mapAuthAudit);
  }

  async purgeExpiredRetention(now: Date, limit: number): Promise<string[]> {
    if (!this.#retentionKey) throw new VoiceLabError(labError("RETENTION_TOMBSTONE_KEY_MISSING", "A keyed retention tombstone secret is required before local evidence can be purged safely.", "internal"));
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<{ id: string; caller_id: string; cleanup_obligation_id: string; retention_purge_verified_at: Date | null; retention_purge_pending: boolean }>(
        `select id,caller_id,cleanup_obligation_id,retention_purge_verified_at,retention_purge_pending from ${SCHEMA}.runs
          where evidence_purged_at is null
            and coalesce(retention_purge_due_at,updated_at+make_interval(hours=>greatest(1,least(168,coalesce((capture_policy->>'retentionHours')::integer,24))))) <= $1
            and state in ('pending_external_evidence','completed','product_failed','invalid_test','inconclusive_provider','failed_harness','authorization_failed','deployment_mismatch','aborted_driver_restart','expired','cancelled')
          order by updated_at asc for update skip locked limit $2`, [now, limit],
      );
      const ids = selected.rows.map((row) => row.id);
      for (const row of selected.rows) {
        const remoteStatus = row.retention_purge_verified_at !== null && row.retention_purge_pending === false ? "confirmed" : "unconfirmed";
        await client.query(
          `insert into ${SCHEMA}.retention_tombstones (lookup_id_hmac,recovery_id_hmac,remote_purge_status,purged_at,control_expires_at)
           values ($1,$2,$3,$4,$4+interval '30 days')
           on conflict (lookup_id_hmac) do update set remote_purge_status=excluded.remote_purge_status,purged_at=excluded.purged_at,control_expires_at=excluded.control_expires_at`,
          [retentionHmac(this.#retentionKey, "lookup", `${row.id}\u0000${row.caller_id}`), retentionHmac(this.#retentionKey, "recovery", row.cleanup_obligation_id), remoteStatus, now],
        );
        await client.query(`delete from ${SCHEMA}.auth_audit where run_id=$1`, [row.id]);
        await client.query(`update ${SCHEMA}.suite_runs set run_ids=run_ids-$1,updated_at=$2 where run_ids ? $1`, [row.id, now]);
        await client.query(`delete from ${SCHEMA}.runs where id=$1`, [row.id]);
      }
      await client.query(`delete from ${SCHEMA}.worker_heartbeats where observed_at < $1 - interval '1 hour'`, [now]);
      await client.query(`delete from ${SCHEMA}.suite_runs where state in ('completed','failed','cancelled') and jsonb_array_length(run_ids)=0 and updated_at <= $1`, [now]);
      await client.query(
        `delete from ${SCHEMA}.auth_audit audit
          where audit.run_id is null and audit.observed_at < $1 - interval '7 days'
            and not exists (select 1 from ${SCHEMA}.principal_provisions provision where provision.auth_audit_id=audit.id)`,
        [now],
      );
      await client.query(`delete from ${SCHEMA}.admission_reservations where observed_at < $1 - interval '8 days'`, [now]);
      await client.query(`delete from ${SCHEMA}.retention_tombstones where control_expires_at <= $1`, [now]);
      await client.query("commit");
      return ids;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
}

function retentionHmac(key: string, domain: string, value: string): string { return createHmac("sha256", key).update(`sophia-voice-lab-retention-v1\n${domain}\n${value}`).digest("hex"); }

function runValues(run: RunRecord): unknown[] {
  return [run.id,run.callerId,run.principalId,run.testRunId,run.cleanupObligationId,run.environment,run.scenarioId,run.scenarioVersion,run.state,run.version,run.target,run.observedDeployment,run.capturePolicy,run.verdicts,run.canonicalSessionId,run.threadId,run.providerSessionId,run.traceId,run.providerEpoch,run.turnId,run.latestCursor,run.expiresAt,run.createdAt,run.updatedAt,run.cleanupComplete,run.retentionPurgeDueAt,run.retentionPurgePending,run.retentionPurgeVerifiedAt,run.evidencePurgedAt,run.terminalError];
}
function mapRun(row: any): RunRecord { return { id:row.id,callerId:row.caller_id,principalId:row.principal_id,testRunId:row.test_run_id,cleanupObligationId:row.cleanup_obligation_id,environment:row.environment,scenarioId:row.scenario_id,scenarioVersion:row.scenario_version,state:row.state,version:Number(row.version),target:row.target,observedDeployment:row.observed_deployment ?? {},capturePolicy:row.capture_policy,verdicts:row.verdicts,canonicalSessionId:row.canonical_session_id,threadId:row.thread_id,providerSessionId:row.provider_session_id,traceId:row.trace_id,providerEpoch:row.provider_epoch === null || row.provider_epoch === undefined ? null : Number(row.provider_epoch),turnId:row.turn_id ?? null,latestCursor:Number(row.latest_cursor),expiresAt:new Date(row.expires_at),createdAt:new Date(row.created_at),updatedAt:new Date(row.updated_at),cleanupComplete:row.cleanup_complete === true,retentionPurgeDueAt:row.retention_purge_due_at ? new Date(row.retention_purge_due_at) : null,retentionPurgePending:row.retention_purge_pending === true,retentionPurgeVerifiedAt:row.retention_purge_verified_at ? new Date(row.retention_purge_verified_at) : null,evidencePurgedAt:row.evidence_purged_at ? new Date(row.evidence_purged_at) : null,terminalError:row.terminal_error }; }
function mapOperation(row: any): OperationRecord { return { id:row.id,runId:row.run_id,callerId:row.caller_id,type:row.type,state:row.state,idempotencyKey:row.idempotency_key,requestHash:row.request_hash,input:row.input ?? {},result:row.result,error:row.error,leaseOwner:row.lease_owner,leaseEpoch:Number(row.lease_epoch),leaseExpiresAt:row.lease_expires_at ? new Date(row.lease_expires_at) : null,attemptCount:Number(row.attempt_count),createdAt:new Date(row.created_at),updatedAt:new Date(row.updated_at) }; }
function mapEvent(row: any): LabEvent { return { runId:row.run_id,seq:Number(row.seq),kind:row.kind,source:row.source,at:new Date(row.observed_at),payload:row.payload ?? {},dedupeKey:row.dedupe_key }; }
function mapSuite(row: any): SuiteRecord { return { id:row.id,callerId:row.caller_id,idempotencyKey:row.idempotency_key,requestHash:row.request_hash,state:row.state,scenarioIds:row.scenario_ids ?? [],runIds:row.run_ids ?? [],definition:row.definition,nextScenarioIndex:Number(row.next_scenario_index ?? 0),createdAt:new Date(row.created_at),updatedAt:new Date(row.updated_at) }; }
function mapSuiteEvidence(row: any): SuiteEvidenceRecord { return { suiteId:row.suite_id,manifestId:row.manifest_id,manifestSha256:row.manifest_sha256,schemaVersion:row.schema_version,bytes:Buffer.from(row.bytes),artifactRefs:row.artifact_refs ?? [],createdAt:new Date(row.created_at) }; }
function mapEvidence(row: any): EvidenceRecord { return { runId:row.run_id,manifestId:row.manifest_id,manifestSha256:row.manifest_sha256,schemaVersion:row.schema_version,revisionSeq:Number(row.revision_seq ?? 0),artifactRefs:row.artifact_refs ?? [],createdAt:new Date(row.created_at) }; }
function mapArtifact(row: any): DurableArtifact { return { id:row.id,runId:row.run_id,kind:row.kind,contentType:row.content_type,sha256:row.sha256,bytes:Buffer.from(row.bytes),createdAt:new Date(row.created_at) }; }
function mapLease(row: any): BrowserLease { return { runId:row.run_id,workerId:row.worker_id,leaseEpoch:Number(row.lease_epoch),expiresAt:new Date(row.expires_at),updatedAt:new Date(row.updated_at) }; }
function mapAuthAudit(row: any): AuthAuditRecord { return { id:Number(row.id),runId:row.run_id,callerId:row.caller_id ?? row.caller_partition_id,action:row.action,capabilityJtiHash:row.capability_jti_hash ?? null,argumentHash:row.argument_hash,outcome:row.outcome,detail:row.detail ?? {},observedAt:new Date(row.observed_at) }; }
function mapPrincipalProvision(row: any): PrincipalProvisionControlRecord {
  return {
    requestHash: row.request_hash,
    idempotencyKeyHash: row.idempotency_key_hash,
    principalHash: row.principal_hash,
    callerPartitionId: row.caller_partition_id,
    issuedAt: new Date(row.issued_at),
    testRunId: row.test_run_id,
    cleanupObligationId: row.cleanup_obligation_id,
    capabilityJti: row.capability_jti,
    capabilityNonce: row.capability_nonce,
    capabilityHash: row.capability_hash,
    providerExpiresAt: new Date(row.provider_expires_at),
    environment: row.environment,
    expectedDeployment: row.expected_deployment,
    mcpBuild: row.mcp_build,
    operatorSubjectHash: row.operator_subject_hash,
    authAuditId: String(row.auth_audit_id),
    auditObservedAt: new Date(row.audit_observed_at),
    state: row.state,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
    attemptCount: Number(row.attempt_count),
    receipt: row.receipt ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
function assertSameRequest(operation: OperationRecord, requestHash: string): void { if (operation.requestHash !== requestHash) throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different arguments."); }
function conflict(code: string, message: string): VoiceLabError { return new VoiceLabError(labError(code, message, "conflict")); }
function notFound(code: string, message: string): VoiceLabError { return new VoiceLabError(labError(code, message, "validation")); }
function translatePgError(error: unknown): Error {
  if (error instanceof VoiceLabError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error ? String((error as { constraint: unknown }).constraint) : "";
  if (code === "23505" && (constraint === "runs_cleanup_obligation_id_key" || constraint === "voice_lab_runs_cleanup_obligation_idx")) return conflict("CLEANUP_OBLIGATION_CONFLICT", "Cleanup obligation is already bound to a different run.");
  if (code === "23505") return conflict("IDEMPOTENCY_CONFLICT", "A unique durable operation already exists.");
  return error instanceof Error ? error : new Error(String(error));
}

const ROLLING_FIELDS = ["runStarts", "providerSeconds", "suites", "suiteChildren", "audioDurationMs", "audioBytes"] as const;
type RollingUsage = RollingAdmissionLimits["global"];
function validateRollingReservation(reservation: RollingAdmissionReservation): void {
  if (!/^[a-f0-9]{64}$/.test(reservation.reservationKey) || !/^[a-f0-9]{64}$/.test(reservation.requestHash) || Number.isNaN(reservation.observedAt.getTime())
    || ROLLING_FIELDS.some((field) => !Number.isSafeInteger(reservation[field]) || reservation[field] < 0)) throw conflict("ROLLING_ADMISSION_INVALID", "Rolling admission reservation is malformed.");
}
async function reserveRollingAdmissionTx(client: pg.PoolClient, reservation: RollingAdmissionReservation, limits: RollingAdmissionLimits, callerPartitions: CallerPartitioner): Promise<RollingAdmissionResult> {
  validateRollingReservation(reservation);
  const reservationKeys = callerPartitions.reservationKeys(reservation.reservationKey);
  const callerPartitionIds = callerPartitions.callerIds(reservation.callerId);
  await client.query("select pg_advisory_xact_lock(hashtext('sophia_voice_lab_rolling_admission'))");
  const prior = await client.query(`select * from ${SCHEMA}.admission_reservations where reservation_key=any($1::text[]) order by observed_at asc limit 1`, [reservationKeys]);
  let replay = false;
  if (prior.rows[0]) {
    assertSameRollingReservationRow(prior.rows[0], reservation, new Set(callerPartitionIds));
    replay = true;
  } else {
    const usage = await rollingUsagePg(client, reservation, limits.windowSeconds, callerPartitionIds);
    assertRollingCapacity(usage.global, usage.caller, reservation, limits);
    await client.query(
      `insert into ${SCHEMA}.admission_reservations
        (reservation_key,request_hash,caller_partition_id,environment,kind,run_starts,provider_seconds,suites,suite_children,audio_duration_ms,audio_bytes,observed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [reservationKeys[0], reservation.requestHash, callerPartitionIds[0], reservation.environment, reservation.kind, reservation.runStarts, reservation.providerSeconds, reservation.suites, reservation.suiteChildren, reservation.audioDurationMs, reservation.audioBytes, reservation.observedAt],
    );
  }
  const usage = await rollingUsagePg(client, reservation, limits.windowSeconds, callerPartitionIds);
  const earliest = await client.query<{ earliest: Date | null }>(`select min(observed_at) as earliest from ${SCHEMA}.admission_reservations where environment=$1 and observed_at > $2`, [reservation.environment, new Date(reservation.observedAt.getTime() - limits.windowSeconds * 1_000)]);
  return { replay, resetAt: new Date(new Date(earliest.rows[0]?.earliest ?? reservation.observedAt).getTime() + limits.windowSeconds * 1_000), remaining: { global: rollingRemaining(limits.global, usage.global), caller: rollingRemaining(limits.caller, usage.caller) } };
}
function assertSameRollingReservationRow(row: Record<string, unknown>, candidate: RollingAdmissionReservation, callerPartitions: ReadonlySet<string>): void {
  const stored = {
    requestHash: row.request_hash,
    callerId: row.caller_partition_id,
    environment: row.environment,
    kind: row.kind,
    runStarts: Number(row.run_starts),
    providerSeconds: Number(row.provider_seconds),
    suites: Number(row.suites),
    suiteChildren: Number(row.suite_children),
    audioDurationMs: Number(row.audio_duration_ms),
    audioBytes: Number(row.audio_bytes),
  };
  if (stored.requestHash !== candidate.requestHash || typeof stored.callerId !== "string" || !callerPartitions.has(stored.callerId) || stored.environment !== candidate.environment || stored.kind !== candidate.kind || ROLLING_FIELDS.some((field) => stored[field] !== candidate[field])) {
    throw conflict("IDEMPOTENCY_CONFLICT", "Rolling admission key was reused with different arguments.");
  }
}
async function rollingUsagePg(client: pg.PoolClient, reservation: RollingAdmissionReservation, windowSeconds: number, callerPartitions: string[]): Promise<{ global: RollingUsage; caller: RollingUsage }> {
  const result = await client.query(
    `select
       coalesce(sum(run_starts),0)::text as global_run_starts,
       coalesce(sum(provider_seconds),0)::text as global_provider_seconds,
       coalesce(sum(suites),0)::text as global_suites,
       coalesce(sum(suite_children),0)::text as global_suite_children,
       coalesce(sum(audio_duration_ms),0)::text as global_audio_duration_ms,
       coalesce(sum(audio_bytes),0)::text as global_audio_bytes,
       coalesce(sum(run_starts) filter (where caller_partition_id=any($2::text[])),0)::text as caller_run_starts,
       coalesce(sum(provider_seconds) filter (where caller_partition_id=any($2::text[])),0)::text as caller_provider_seconds,
       coalesce(sum(suites) filter (where caller_partition_id=any($2::text[])),0)::text as caller_suites,
       coalesce(sum(suite_children) filter (where caller_partition_id=any($2::text[])),0)::text as caller_suite_children,
       coalesce(sum(audio_duration_ms) filter (where caller_partition_id=any($2::text[])),0)::text as caller_audio_duration_ms,
       coalesce(sum(audio_bytes) filter (where caller_partition_id=any($2::text[])),0)::text as caller_audio_bytes
     from ${SCHEMA}.admission_reservations where environment=$1 and observed_at > $3`,
    [reservation.environment, callerPartitions, new Date(reservation.observedAt.getTime() - windowSeconds * 1_000)],
  );
  const row = result.rows[0] ?? {};
  const usage = (prefix: "global" | "caller"): RollingUsage => ({
    runStarts: Number(row[`${prefix}_run_starts`] ?? 0), providerSeconds: Number(row[`${prefix}_provider_seconds`] ?? 0), suites: Number(row[`${prefix}_suites`] ?? 0),
    suiteChildren: Number(row[`${prefix}_suite_children`] ?? 0), audioDurationMs: Number(row[`${prefix}_audio_duration_ms`] ?? 0), audioBytes: Number(row[`${prefix}_audio_bytes`] ?? 0),
  });
  return { global: usage("global"), caller: usage("caller") };
}
function assertRollingCapacity(global: RollingUsage, caller: RollingUsage, reservation: RollingAdmissionReservation, limits: RollingAdmissionLimits): void {
  for (const field of ROLLING_FIELDS) {
    if (global[field] + reservation[field] > limits.global[field] || caller[field] + reservation[field] > limits.caller[field]) throw conflict(`ROLLING_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_LIMIT`, `Rolling ${field} admission budget would be exceeded.`);
  }
}
function rollingRemaining(cap: RollingUsage, used: RollingUsage): RollingUsage {
  return Object.fromEntries(ROLLING_FIELDS.map((field) => [field, Math.max(0, cap[field] - used[field])])) as unknown as RollingUsage;
}
