import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect } from "vitest";
import type { RunRecord } from "../src/domain.js";
import type { RecoveryControlRecord } from "../src/recovery-control.js";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { composeVoiceLabMigration } from "../src/migration-bundle.js";
import { sha256 } from "../src/security.js";
import { persistRetainedD02OwnerDeath } from "../scripts/external-attestations/retained-owner-ingestion.js";
import { verifyRetainedD02OwnerDeath } from "../scripts/external-attestations/retained-owner-proof.js";
import { signD02WorkerTerminationReceipt } from "../scripts/external-attestations/crypto.js";
import { persistRetainedD02ProviderSettlement } from "../scripts/external-attestations/retained-provider-ingestion.js";
import { verifyRetainedProviderFixture } from "./retained-d02-provider-helper.js";
import { combinedRecoveryFixture } from "./retained-d02-recovery-helper.js";
import { recoveryAttemptAuditHash } from "../src/retained-d02-recovery.js";
import { verifyRetainedWorkerPostgres } from "./retained-worker-postgres-helper.js";
import type { D02WorkerTerminationControllerReceipt, PublicAuthorityConfig } from "../scripts/external-attestations/contracts.js";
import { RETAINED_RECOVERY_RETRY_MS } from "../src/recovery-control.js";

/** Uses only an explicitly named disposable DB and synthetic signed fixtures.
 * Does not contact Render/Gateway/provider or allocate a browser. */
export async function verifyOwnerIngestionPostgres(url: string, run: RunRecord, control: RecoveryControlRecord,
  receipt: D02WorkerTerminationControllerReceipt, publicConfig: PublicAuthorityConfig, privateKeyPath: string) {
  const parsed = new URL(url);
  if (!/^\/voice_lab_test_c4_owner_[a-z0-9_]+$/.test(parsed.pathname)
    || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") throw new Error("Dedicated owner-test database/reset approval required");
  const ledger = new PostgresVoiceLabLedger(url, 4, "synthetic-retention-key-000000000000001");
  const pool = ledger.pool;
  try {
    expect((await pool.query("select current_database() as name")).rows[0].name).toBe(parsed.pathname.slice(1));
    await pool.query("drop schema if exists sophia_voice_lab cascade");
    await pool.query(composeVoiceLabMigration(await readFile("../../backend/migrations/2026_08_23_sophia_voice_lab.sql"), await readFile("migrations/004_recovery_controls.sql")).toString("utf8"));
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId,
      type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 10, caller: 10 });
    // Synthetic fixture projections; service/adapter tests prove their derivation.
    await pool.query(`update sophia_voice_lab.recovery_controls set binding=$2, browser_allocation_ever=true,
      execution_ownership=$3,d02_journal=$4,browser_context_binding=$5,live_cleanup_complete=false where run_id=$1`,
    [run.id, control.binding, control.executionOwnership, control.d02Journal, control.browserContextBinding]);
    await pool.query("insert into sophia_voice_lab.browser_leases values ($1,$2,$3,now()+interval '1 hour',now())", [run.id, "worker-instance-before", control.executionOwnership!.browserLeaseEpoch]);
    const input = { pool, runId: run.id, expectedVersion: 1, receipt, publicConfig,
      expectedWorkerServiceIdSha256: receipt.binding.worker_service_id_sha256 };
    const { signature: _signature, ...unsigned } = receipt;
    const expiredReceipt = await signD02WorkerTerminationReceipt({ ...unsigned, expires_at: new Date(Date.now() - 1).toISOString() }, publicConfig, privateKeyPath);
    await expect(ledger.persistRetainedD02OwnerDeath({ ...input, receipt: expiredReceipt })).rejects.toThrow("OWNER_RECEIPT_TIME_INVALID");
    expect((await ledger.getRecoveryControl(run.id))!.d02OwnerDeath).toBeUndefined();
    await expect(ledger.persistRetainedD02OwnerDeath({ ...input, expectedVersion: 2 })).rejects.toThrow("OWNER_CONTROL_VERSION_CONFLICT");
    await pool.query(`create function sophia_voice_lab.test_owner_abort() returns trigger language plpgsql as $$
      begin if NEW.d02_owner_death is not null then raise exception 'OWNER_POST_WRITE_FAILURE'; end if; return NEW; end $$`);
    await pool.query("create trigger test_owner_abort after update of d02_owner_death on sophia_voice_lab.recovery_controls for each row execute function sophia_voice_lab.test_owner_abort()");
    try { await expect(ledger.persistRetainedD02OwnerDeath(input)).rejects.toThrow("OWNER_POST_WRITE_FAILURE"); }
    finally {
      await pool.query("drop trigger test_owner_abort on sophia_voice_lab.recovery_controls");
      await pool.query("drop function sophia_voice_lab.test_owner_abort()");
    }
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ version: 1, liveCleanupComplete: false });
    expect((await ledger.getRecoveryControl(run.id))!.d02OwnerDeath).toBeUndefined();
    // Short-lived real signature permits a genuine expiry/reconnect replay test.
    const shortReceipt = await signD02WorkerTerminationReceipt({ ...unsigned, expires_at: new Date(Date.now() + 1500).toISOString() }, publicConfig, privateKeyPath);
    const request = { ...input, receipt: shortReceipt };
    const results = await Promise.all([ledger.persistRetainedD02OwnerDeath(request), ledger.persistRetainedD02OwnerDeath(request)]);
    expect(results.filter(r => r.replay)).toHaveLength(1);
    expect(results[0]!.proof).toEqual(results[1]!.proof);
    expect(results[0]!.version).toBe(2);
    const proof = results[0]!.proof;
    const providerFixture = verifyRetainedProviderFixture((await ledger.getRecoveryControl(run.id))!);
    const providerRequest = { pool, runId: run.id, expectedVersion: 2, receipt: providerFixture.receipt, authority: providerFixture.authority };
    await expect(ledger.persistRetainedD02ProviderSettlement({ ...providerRequest, expectedVersion: 3 })).rejects.toThrow("PROVIDER_CONTROL_VERSION_CONFLICT");
    await pool.query(`create function sophia_voice_lab.test_provider_abort() returns trigger language plpgsql as $$
      begin if NEW.d02_provider_settlement is not null then raise exception 'PROVIDER_POST_WRITE_FAILURE'; end if; return NEW; end $$`);
    await pool.query("create trigger test_provider_abort after update of d02_provider_settlement on sophia_voice_lab.recovery_controls for each row execute function sophia_voice_lab.test_provider_abort()");
    try { await expect(ledger.persistRetainedD02ProviderSettlement(providerRequest)).rejects.toThrow("PROVIDER_POST_WRITE_FAILURE"); }
    finally {
      await pool.query("drop trigger test_provider_abort on sophia_voice_lab.recovery_controls");
      await pool.query("drop function sophia_voice_lab.test_provider_abort()");
    }
    expect((await ledger.getRecoveryControl(run.id))!.d02ProviderSettlement).toBeUndefined();
    expect((await ledger.getRecoveryControl(run.id))!.version).toBe(2);
    const providers = await Promise.all([ledger.persistRetainedD02ProviderSettlement(providerRequest), ledger.persistRetainedD02ProviderSettlement(providerRequest)]);
    expect(providers.filter(r => r.replay)).toHaveLength(1);
    expect(providers[0]).toMatchObject({ version: 3, proof: providerFixture.proof });
    expect(providers[1]!.proof).toEqual(providers[0]!.proof);
    expect((await pool.query("select count(*)::int as n from sophia_voice_lab.browser_leases where run_id=$1", [run.id])).rows[0].n).toBe(1);
    expect((await ledger.getRecoveryControl(run.id))!.executionCleanupProof).toBeUndefined();
    const current = (await ledger.getRun(run.id))!;
    await ledger.updateRun(run.id, current.version, { state: "failed_harness", retentionPurgeDueAt: new Date(Date.now() - 1), retentionPurgePending: true });
    await ledger.purgeExpiredRetention(new Date(), 10);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect((await ledger.getRecoveryControl(run.id))!.d02OwnerDeath).toEqual(proof);
    expect((await ledger.getRecoveryControl(run.id))!.d02ProviderSettlement).toEqual(providerFixture.proof);
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(shortReceipt.expires_at) - Date.now() + 20)));
    const retained = (await ledger.getRecoveryControl(run.id))!;
    expect(() => verifyRetainedD02OwnerDeath({ control: retained, receipt: shortReceipt, publicConfig,
      expectedWorkerServiceIdSha256: input.expectedWorkerServiceIdSha256, acceptedAt: new Date() })).toThrow("OWNER_RECEIPT_TIME_INVALID");
    const independent = new pg.Pool({ connectionString: url, max: 1 });
    try {
      expect(await persistRetainedD02OwnerDeath({ ...request, pool: independent })).toMatchObject({ replay: true, proof });
      expect(await persistRetainedD02ProviderSettlement({ ...providerRequest, pool: independent })).toMatchObject({ replay: true, proof: providerFixture.proof });
      await expect(persistRetainedD02ProviderSettlement({ ...providerRequest, pool: independent, receipt: { ...providerRequest.receipt, signature: "a".repeat(86) } })).rejects.toThrow("PROVIDER_SETTLEMENT_IMMUTABLE");
      await expect(persistRetainedD02OwnerDeath({ ...request, pool: independent, receipt: { ...shortReceipt, signature: "a".repeat(86) } })).rejects.toThrow("OWNER_DEATH_IMMUTABLE");
    } finally { await independent.end(); }
    expect(await ledger.countActiveRuns()).toBe(1);
    expect((await ledger.getRecoveryControl(run.id))!.liveCleanupComplete).toBe(false);
    const afterFacts = Math.ceil(Math.max(Date.parse(proof.acceptedAt), Date.parse(providerFixture.proof.observedAt)) / 1000) * 1000;
    const delay = Math.max(1, afterFacts - Date.now() + 20);
    if (delay > 20_000) throw new Error("Synthetic fixture clock drift exceeded bound");
    await new Promise(resolve => setTimeout(resolve, delay));
    const beforeSettlement = (await ledger.getRecoveryControl(run.id))!;
    const { event, attempt } = combinedRecoveryFixture(beforeSettlement, Math.floor(Date.now() / 1000));
    await expect(ledger.settleRecoveryControl(run.id, beforeSettlement.version, event, attempt)).rejects.toMatchObject({ detail: { code: "RECOVERY_ATTEMPT_AUDIT_MISSING" } });
    await ledger.recordRecoveryCapabilityAudit(run.id, beforeSettlement.version, sha256("synthetic-capability-jti"), recoveryAttemptAuditHash(beforeSettlement, attempt));
    const incomplete = structuredClone(event);
    incomplete.payload.receipt.components.builder.authoritative_zero_tasks = false;
    await expect(ledger.settleRecoveryControl(run.id, beforeSettlement.version, incomplete, attempt)).rejects.toThrow();
    await pool.query("update sophia_voice_lab.browser_leases set worker_id='different-owner' where run_id=$1", [run.id]);
    await expect(ledger.settleRecoveryControl(run.id, beforeSettlement.version, event, attempt)).rejects.toMatchObject({ detail: { code: "RECOVERY_LEASE_MISMATCH" } });
    await pool.query("update sophia_voice_lab.browser_leases set worker_id='worker-instance-before' where run_id=$1", [run.id]);
    await pool.query(`create function sophia_voice_lab.test_combined_abort() returns trigger language plpgsql as $$
      begin
        if NEW.d02_recovery_settlement is not null then
          if exists (select 1 from sophia_voice_lab.browser_leases where run_id=NEW.run_id) then raise exception 'LEASE_NOT_DELETED'; end if;
          raise exception 'COMBINED_POST_LEASE_FAILURE';
        end if; return NEW;
      end $$`);
    await pool.query("create trigger test_combined_abort before update of d02_recovery_settlement on sophia_voice_lab.recovery_controls for each row execute function sophia_voice_lab.test_combined_abort()");
    try {
      await expect(ledger.settleRecoveryControl(run.id, beforeSettlement.version, event, attempt)).rejects.toThrow("COMBINED_POST_LEASE_FAILURE");
      await verifyRetainedWorkerPostgres(ledger, beforeSettlement, false);
    }
    finally {
      await pool.query("drop trigger test_combined_abort on sophia_voice_lab.recovery_controls");
      await pool.query("drop function sophia_voice_lab.test_combined_abort()");
    }
    expect(await ledger.getRecoveryControl(run.id)).toEqual(beforeSettlement);
    expect(await ledger.getBrowserLease(run.id)).not.toBeNull();
    expect(await ledger.countActiveRuns()).toBe(1);
    // The failed transactional cleanup attempt consumed a scheduling slot,
    // not a cleanup proof. Its persisted retry interval survives rollback.
    expect(await ledger.scheduleRetainedRecovery(1)).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, RETAINED_RECOVERY_RETRY_MS + 100));
    const transported = await verifyRetainedWorkerPostgres(ledger, beforeSettlement, true);
    const settlements = await Promise.all([ledger.settleRecoveryControl(run.id, beforeSettlement.version, transported.event, transported.attempt), ledger.settleRecoveryControl(run.id, beforeSettlement.version, transported.event, transported.attempt)]);
    expect(settlements[0]).toEqual(settlements[1]);
    expect(settlements[0]).toMatchObject({ version: beforeSettlement.version + 1, liveCleanupComplete: true, remotePurgeComplete: true, d02RecoverySettlement: { ready: true, attemptId: transported.attempt.attemptId } });
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
    expect(await ledger.countActiveRuns()).toBe(0);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "confirmed" });
  } finally {
    await pool.query("drop schema if exists sophia_voice_lab cascade");
    await ledger.close();
  }
}
