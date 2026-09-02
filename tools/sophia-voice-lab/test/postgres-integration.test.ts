import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OAuthAccessTokenRecord, OAuthAuthorizationCodeRecord, OAuthAuthorizationRequestRecord, OAuthRefreshTokenRecord } from "../src/oauth.js";
import { PostgresOAuthLedgerStore } from "../src/oauth-postgres-store.js";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import { proveP01LiveBoundary } from "./p01-live-boundary-helper.js";

const { Client } = pg;
const execFileAsync = promisify(execFile);
const databaseUrl = process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_URL?.trim() ?? "";
const describePostgres = databaseUrl ? describe : describe.skip;
const namespace = randomUUID();
let ledger: PostgresVoiceLabLedger | undefined;
let oauth: PostgresOAuthLedgerStore | undefined;

/**
 * This suite is intentionally opt-in and destructive only to a database whose
 * name explicitly contains `voice_lab_test`. It is designed to run inside the
 * web/worker image against an isolated preview database; it never contacts the
 * product, browser, TTS, Gateway, or provider planes.
 */
describePostgres("real PostgreSQL Voice Lab adapter", () => {
  beforeAll(async () => {
    assertDedicatedTestDatabase(databaseUrl);
    const admin = new Client({ connectionString: databaseUrl, application_name: "voice-lab-pg-test-reset" });
    await admin.connect();
    try {
      await admin.query("drop schema if exists sophia_voice_lab cascade");
      await admin.query("create schema sophia_voice_lab");
      await admin.query("create table sophia_voice_lab.runs (id text primary key)");
      await expect(runMigration(databaseUrl)).rejects.toThrow();
      await admin.query("drop schema sophia_voice_lab cascade");
    }
    finally { await admin.end(); }

    // Two actual migration processes contend on the compiled advisory lock.
    // Both must attest the same immutable migration and exact catalog.
    await Promise.all([runMigration(databaseUrl), runMigration(databaseUrl)]);
    ledger = new PostgresVoiceLabLedger(databaseUrl, 20, `retention-${namespace}-00000000000000000000000000000000`, { activeKeyId: "pg-v1", keys: { "pg-v1": `caller-partition-${namespace}-000000000000000000000000` } });
    oauth = new PostgresOAuthLedgerStore(databaseUrl, 20, 86_400, { activeKeyId: "pg-v1", keys: { "pg-v1": `caller-partition-${namespace}-000000000000000000000000` } }, "operator");
    await ledger.initialize();
    expect(await ledger.health()).toEqual({ ok: true, detail: "postgres-schema-attested" });
    expect(await oauth.readiness()).toBe(true);
  }, 90_000);

  afterAll(async () => {
    await oauth?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    if (!databaseUrl) return;
    const admin = new Client({ connectionString: databaseUrl, application_name: "voice-lab-pg-test-cleanup" });
    await admin.connect();
    try { await admin.query("drop schema if exists sophia_voice_lab cascade"); }
    finally { await admin.end(); }
  }, 30_000);

  it("refuses to seal pre-existing column/index/ACL drift against the release reference", async () => {
    await ledger!.pool.query("alter table sophia_voice_lab.runs add column unexpected_drift text");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("alter table sophia_voice_lab.runs drop column unexpected_drift");

    await ledger!.pool.query("create index unexpected_drift_idx on sophia_voice_lab.runs (updated_at)");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("drop index sophia_voice_lab.unexpected_drift_idx");

    await ledger!.pool.query("grant select on sophia_voice_lab.runs to public");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("revoke all on sophia_voice_lab.runs from public");

    await ledger!.pool.query("grant select (id) on sophia_voice_lab.runs to public");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("revoke select (id) on sophia_voice_lab.runs from public");

    await ledger!.pool.query("create type sophia_voice_lab.unexpected_composite as (value text)");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("drop type sophia_voice_lab.unexpected_composite");

    // The release contract seals object ownership as the runtime role and
    // normalizes every object ACL. A role which can still DML the table must
    // not green readiness after ownership/authority drift.
    const driftRole = `voice_lab_drift_${namespace.replace(/-/g, "").slice(0, 20)}`;
    const role = `"${driftRole}"`;
    const current = await ledger!.pool.query<{ role: string }>("select quote_ident(current_user) as role");
    await ledger!.pool.query(`create role ${role} nologin`);
    try {
      await ledger!.pool.query(`grant ${role} to ${current.rows[0]!.role}`);
      await ledger!.pool.query(`grant usage,create on schema sophia_voice_lab to ${role}`);
      await ledger!.pool.query(`alter table sophia_voice_lab.runs owner to ${role}`);
      await expect(runMigration(databaseUrl)).rejects.toThrow();
      await ledger!.pool.query(`alter table sophia_voice_lab.runs owner to ${current.rows[0]!.role}`);
      await ledger!.pool.query(`revoke all on schema sophia_voice_lab from ${role}`);
      await ledger!.pool.query(`grant select on sophia_voice_lab.runs to ${role}`);
      await expect(runMigration(databaseUrl)).rejects.toThrow();
      await ledger!.pool.query(`revoke all on sophia_voice_lab.runs from ${role}`);
    } finally {
      await ledger!.pool.query(`alter table sophia_voice_lab.runs owner to ${current.rows[0]!.role}`).catch(() => undefined);
      await ledger!.pool.query(`revoke all on sophia_voice_lab.runs from ${role}`).catch(() => undefined);
      await ledger!.pool.query(`revoke all on schema sophia_voice_lab from ${role}`).catch(() => undefined);
      await ledger!.pool.query(`revoke ${role} from ${current.rows[0]!.role}`).catch(() => undefined);
      await ledger!.pool.query(`drop role if exists ${role}`).catch(() => undefined);
    }
    await expect(runMigration(databaseUrl)).resolves.toBeUndefined();
  }, 300_000);

  it("atomically replays 20 starts, appends gap-free deduped events, and preserves immutable artifacts", async () => {
    const observedAt = new Date();
    const callerId = `pg-caller-${namespace}`;
    const requestHash = sha256(`request-${namespace}`);
    const idempotencyKey = `start-${namespace}`;
    const reservationKey = sha256(`reservation-${namespace}`);
    const rolling = {
      reservation: { reservationKey, requestHash, callerId, environment: "production" as const, kind: "run" as const, runStarts: 1, providerSeconds: 1_800, suites: 0, suiteChildren: 0, audioDurationMs: 0, audioBytes: 0, observedAt },
      limits: {
        windowSeconds: 86_400,
        global: { runStarts: 100, providerSeconds: 180_000, suites: 10, suiteChildren: 100, audioDurationMs: 1_000_000, audioBytes: 100_000_000 },
        caller: { runStarts: 100, providerSeconds: 180_000, suites: 10, suiteChildren: 100, audioDurationMs: 1_000_000, audioBytes: 100_000_000 },
      },
    };
    const candidates = Array.from({ length: 20 }, () => {
      const run = testRun({ callerId, createdAt: observedAt, updatedAt: observedAt });
      const operation = { id: randomUUID(), runId: run.id, callerId, type: "start" as const, idempotencyKey, requestHash, input: { environment: "production" } };
      return { run, operation };
    });
    const results = await Promise.all(candidates.map(({ run, operation }) => ledger!.createRunWithOperation(run, operation, { global: 1, caller: 1 }, rolling)));
    expect(new Set(results.map((result) => result.run.id))).toHaveLength(1);
    expect(new Set(results.map((result) => result.operation.id))).toHaveLength(1);
    expect(results.filter((result) => !result.replay)).toHaveLength(1);
    expect(results.filter((result) => result.rollingAdmission?.replay === false)).toHaveLength(1);

    const changedRun = testRun({ callerId });
    await expect(ledger!.createRunWithOperation(changedRun, { id: randomUUID(), runId: changedRun.id, callerId, type: "start", idempotencyKey, requestHash: sha256(`changed-${namespace}`), input: {} }, { global: 1, caller: 1 }, { ...rolling, reservation: { ...rolling.reservation, requestHash: sha256(`changed-${namespace}`) } })).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_CONFLICT" } });

    const runId = results[0]!.run.id;
    const duplicate = await Promise.all(Array.from({ length: 20 }, () => ledger!.appendEvent(runId, "pg.duplicate", "worker", { proof: "same" }, "pg-duplicate")));
    expect(new Set(duplicate.map((event) => event.seq))).toEqual(new Set([1]));
    await expect(ledger!.appendEvent(runId, "pg.duplicate", "worker", { proof: "different" }, "pg-duplicate")).rejects.toMatchObject({ detail: { code: "DEDUPE_CONFLICT" } });
    await Promise.all(Array.from({ length: 40 }, (_, index) => ledger!.appendEvent(runId, "pg.unique", "worker", { index }, `pg-unique-${index}`)));
    const page = await ledger!.listEvents(runId, 0, 100);
    expect(page.events.map((event) => event.seq)).toEqual(Array.from({ length: 41 }, (_, index) => index + 1));

    const bytes = Buffer.from(`immutable-${namespace}`, "utf8");
    const artifactId = randomUUID();
    const artifact = { id: artifactId, runId, kind: "capture_json" as const, contentType: "application/json" as const, sha256: sha256(bytes), bytes, createdAt: new Date() };
    const persisted = await Promise.all(Array.from({ length: 20 }, () => ledger!.saveArtifact(artifact)));
    expect(new Set(persisted.map((row) => row.id))).toEqual(new Set([artifactId]));
    const changedBytes = Buffer.from(`changed-${namespace}`, "utf8");
    await expect(ledger!.saveArtifact({ ...artifact, sha256: sha256(changedBytes), bytes: changedBytes })).rejects.toMatchObject({ detail: { code: "ARTIFACT_ID_CONFLICT" } });

    await ledger!.recordAuthAudit({ runId: null, callerId, action: "mcp.body", argumentHash: sha256(`global-audit-${namespace}`), outcome: "denied", detail: {}, observedAt });
    const rotated = new PostgresVoiceLabLedger(databaseUrl, 2, `retention-rotated-${namespace}-0000000000000000`, { activeKeyId: "pg-v2", keys: { "pg-v2": `caller-partition-v2-${namespace}-00000000000000000000`, "pg-v1": `caller-partition-${namespace}-000000000000000000000000` } });
    const retiredTooEarly = new PostgresVoiceLabLedger(databaseUrl, 2, `retention-retired-${namespace}-0000000000000000`, { activeKeyId: "pg-v2", keys: { "pg-v2": `caller-partition-v2-${namespace}-00000000000000000000` } });
    try {
      await expect(rotated.initialize()).resolves.toBeUndefined();
      await expect(retiredTooEarly.initialize()).rejects.toMatchObject({ detail: { code: "CALLER_PARTITION_KEY_RETIRED_LIVE" } });
      await ledger!.pool.query("delete from sophia_voice_lab.admission_reservations where caller_partition_id like 'cp1:pg-v1:%'");
      await expect(retiredTooEarly.initialize()).rejects.toMatchObject({ detail: { code: "CALLER_PARTITION_KEY_RETIRED_LIVE" } });
      await ledger!.pool.query("delete from sophia_voice_lab.auth_audit where run_id is null and caller_partition_id like 'cp1:pg-v1:%'");
      await expect(retiredTooEarly.initialize()).resolves.toBeUndefined();
    } finally {
      await rotated.close();
      await retiredTooEarly.close();
    }
  }, 180_000);

  it("collects real P01 MCP envelopes/audits and attaches the signed claim to the same PostgreSQL run", async () => {
    const result = await proveP01LiveBoundary(ledger!);
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pollingCallCount).toBe(4);
  }, 60_000);

  it("serializes refresh replay/rotation/revocation by family and rolls back a mid-family failure", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const firstFamily = `family-race-${namespace}`;
    const r0 = refresh("r0", firstFamily, null, now);
    const a0 = access("a0", firstFamily, now);
    const r1 = refresh("r1", firstFamily, r0.tokenHash, now + 1);
    const a1 = access("a1", firstFamily, now + 1);
    await putInitialPair("r0", r0, a0, now);
    expect((await oauth!.rotateRefreshToken(r0.tokenHash, r0.jti, r1, a1, now + 1)).status).toBe("rotated");
    const r2 = refresh("r2", firstFamily, r1.tokenHash, now + 2);
    const a2 = access("a2", firstFamily, now + 2);
    const replayReplacement = refresh("replay", firstFamily, r0.tokenHash, now + 2);
    const replayAccess = access("replay", firstFamily, now + 2);
    const race = await Promise.all([
      oauth!.rotateRefreshToken(r0.tokenHash, r0.jti, replayReplacement, replayAccess, now + 2),
      oauth!.rotateRefreshToken(r1.tokenHash, r1.jti, r2, a2, now + 2),
    ]);
    expect(race.some((result) => result.status === "replayed")).toBe(true);
    expect(await liveFamilyRows(firstFamily)).toEqual({ access: 0, refresh: 0 });

    const revokeFamily = `family-revoke-${namespace}`;
    const q0 = refresh("q0", revokeFamily, null, now);
    const qa0 = access("qa0", revokeFamily, now);
    await putInitialPair("q0", q0, qa0, now);
    const q1 = refresh("q1", revokeFamily, q0.tokenHash, now + 1);
    const qa1 = access("qa1", revokeFamily, now + 1);
    await Promise.all([oauth!.revokeTokenFamily(revokeFamily, now + 1), oauth!.rotateRefreshToken(q0.tokenHash, q0.jti, q1, qa1, now + 1)]);
    expect(await liveFamilyRows(revokeFamily)).toEqual({ access: 0, refresh: 0 });

    const rollbackFamily = `family-rollback-${namespace}`;
    const x0 = refresh("x0", rollbackFamily, null, now);
    const xa0 = access("xa0", rollbackFamily, now);
    await putInitialPair("x0", x0, xa0, now);
    await ledger!.pool.query(`create function sophia_voice_lab.test_fail_refresh_revoke() returns trigger language plpgsql as $$ begin if new.family_id='${rollbackFamily}' then raise exception 'injected family rollback'; end if; return new; end $$`);
    await ledger!.pool.query("create trigger test_fail_refresh_revoke before update on sophia_voice_lab.oauth_refresh_tokens for each row execute function sophia_voice_lab.test_fail_refresh_revoke()");
    try {
      await expect(oauth!.revokeTokenFamily(rollbackFamily, now + 1)).rejects.toThrow("injected family rollback");
      expect(await liveFamilyRows(rollbackFamily)).toEqual({ access: 1, refresh: 1 });
    } finally {
      await ledger!.pool.query("drop trigger if exists test_fail_refresh_revoke on sophia_voice_lab.oauth_refresh_tokens");
      await ledger!.pool.query("drop function if exists sophia_voice_lab.test_fail_refresh_revoke()");
    }
  }, 60_000);

  it("stores no raw OAuth subject and blocks subject-partition key retirement until live grants expire", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const request: OAuthAuthorizationRequestRecord = {
      requestHash: sha256(`${namespace}:oauth-request-partition`),
      csrfHash: sha256(`${namespace}:oauth-csrf-partition`),
      clientId: "https://chatgpt.com/oauth/client.json",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      resource: "https://voice-lab.test/mcp",
      state: "state-partition-test",
      scopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"],
      codeChallenge: "A".repeat(43),
      subject: "operator",
      issuedAt: now,
      expiresAt: now + 300,
      consumedAt: null,
    };
    await oauth!.putAuthorizationRequest(request);
    expect((await oauth!.consumeAuthorizationRequest(request.requestHash, request.csrfHash, now + 1))?.subject).toBe("operator");
    const durable = await ledger!.pool.query<{ subject: string }>(
      `select subject from sophia_voice_lab.oauth_authorization_requests
       union all select subject from sophia_voice_lab.oauth_authorization_codes
       union all select subject from sophia_voice_lab.oauth_access_tokens
       union all select subject from sophia_voice_lab.oauth_refresh_tokens`,
    );
    expect(durable.rows.length).toBeGreaterThan(0);
    expect(durable.rows.every((row) => /^cp1:pg-v1:[a-f0-9]{64}$/.test(row.subject))).toBe(true);
    expect(JSON.stringify(durable.rows)).not.toContain("operator");

    const rotated = new PostgresOAuthLedgerStore(databaseUrl, 2, 86_400, { activeKeyId: "pg-v2", keys: { "pg-v2": `caller-partition-v2-${namespace}-00000000000000000000`, "pg-v1": `caller-partition-${namespace}-000000000000000000000000` } }, "operator");
    const retiredTooEarly = new PostgresOAuthLedgerStore(databaseUrl, 2, 86_400, { activeKeyId: "pg-v2", keys: { "pg-v2": `caller-partition-v2-${namespace}-00000000000000000000` } }, "operator");
    try {
      expect(await rotated.readiness()).toBe(true);
      expect(await retiredTooEarly.readiness()).toBe(false);
      await ledger!.pool.query("delete from sophia_voice_lab.oauth_access_tokens");
      await ledger!.pool.query("delete from sophia_voice_lab.oauth_refresh_tokens");
      await ledger!.pool.query("delete from sophia_voice_lab.oauth_authorization_codes");
      await ledger!.pool.query("delete from sophia_voice_lab.oauth_authorization_requests");
      expect(await retiredTooEarly.readiness()).toBe(true);
    } finally {
      await rotated.close();
      await retiredTooEarly.close();
    }
  }, 60_000);

  it("atomically claims the singleton and rolls back completion when its auth audit insert fails", async () => {
    const now = new Date();
    const callerId = "system.principal-provision-operator";
    const preparation = {
      requestHash: sha256(`${namespace}:principal-request`),
      idempotencyKeyHash: sha256(`${namespace}:principal-idempotency`),
      principalHash: sha256(`${namespace}:principal`),
      callerId,
      issuedAt: now,
      testRunId: randomUUID(),
      cleanupObligationId: randomUUID(),
      capabilityJti: "1".repeat(32),
      capabilityNonce: "2".repeat(32),
      capabilityHash: "3".repeat(64),
      providerExpiresAt: new Date(now.getTime() + 600_000),
      environment: "production" as const,
      expectedDeployment: { frontend: "a".repeat(40), backend: "b".repeat(40), voice: "c".repeat(40) },
      mcpBuild: "d".repeat(40),
      operatorSubjectHash: sha256(callerId),
    };
    const owners = Array.from({ length: 10 }, () => randomUUID());
    const claims = await Promise.all(owners.map((owner) => ledger!.claimPrincipalProvision(preparation, owner, 30, now)));
    expect(claims.filter((claim) => claim.disposition === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.disposition === "pending")).toHaveLength(9);
    const claimed = claims.find((claim) => claim.disposition === "claimed")!;
    const owner = owners[claims.indexOf(claimed)]!;
    const receiptCore = {
      schema: 'sophia_voice_lab_principal_provision_receipt_v1',
      ok: true,
      provisioned: true,
      idempotency_key_sha256: preparation.idempotencyKeyHash,
      operator_request_sha256: preparation.requestHash,
      principal_id_sha256: preparation.principalHash,
      capability_sha256: preparation.capabilityHash,
      capability_jti_sha256: sha256(preparation.capabilityJti),
      test_run_id_sha256: sha256(preparation.testRunId),
      cleanup_obligation_id_sha256: sha256(preparation.cleanupObligationId),
      environment: preparation.environment,
      frontend_build: preparation.expectedDeployment.frontend,
      mcp_build: preparation.mcpBuild,
      expected_deployment: preparation.expectedDeployment,
      frontend_attempts: 1,
      frontend_reconciled: false,
      auth_audit_id: claimed.record.authAuditId,
      audit_observed_at: claimed.record.auditObservedAt.toISOString(),
      operator_subject_sha256: preparation.operatorSubjectHash,
    } as const;
    const receipt = { ...receiptCore, idempotent_replay: false, receipt_sha256: canonicalRequestHash(receiptCore) };
    const audit = {
      id: claimed.record.authAuditId,
      runId: null,
      callerId,
      action: "principal.provision",
      capabilityJtiHash: sha256(preparation.capabilityJti),
      argumentHash: preparation.requestHash,
      outcome: "allowed" as const,
      detail: receipt,
      observedAt: claimed.record.auditObservedAt,
    };
    const rotatedLedger = new PostgresVoiceLabLedger(databaseUrl, 4, `retention-${namespace}-00000000000000000000000000000000`, {
      activeKeyId: 'pg-v2',
      keys: {
        'pg-v2': `caller-partition-rotated-${namespace}-000000000000000000000000`,
        'pg-v1': `caller-partition-${namespace}-000000000000000000000000`,
      },
    });
    await rotatedLedger.initialize();
    await ledger!.pool.query("create function sophia_voice_lab.test_fail_principal_audit() returns trigger language plpgsql as $$ begin if new.action='principal.provision' then raise exception 'injected principal audit rollback'; end if; return new; end $$");
    await ledger!.pool.query("create trigger test_fail_principal_audit before insert on sophia_voice_lab.auth_audit for each row execute function sophia_voice_lab.test_fail_principal_audit()");
    try {
      await expect(rotatedLedger.finalizePrincipalProvision(preparation.requestHash, owner, receipt, audit, new Date())).rejects.toThrow("injected principal audit rollback");
      expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: "prepared" });
    } finally {
      await ledger!.pool.query("drop trigger if exists test_fail_principal_audit on sophia_voice_lab.auth_audit");
      await ledger!.pool.query("drop function if exists sophia_voice_lab.test_fail_principal_audit()");
    }
    await rotatedLedger.finalizePrincipalProvision(preparation.requestHash, owner, receipt, audit, new Date());
    await rotatedLedger.close();
    expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: "completed" });
    const retiredTooEarly = new PostgresVoiceLabLedger(databaseUrl, 2, `retention-${namespace}-00000000000000000000000000000000`, {
      activeKeyId: 'pg-v2',
      keys: { 'pg-v2': `caller-partition-rotated-${namespace}-000000000000000000000000` },
    });
    await expect(retiredTooEarly.initialize()).rejects.toMatchObject({ detail: { code: 'CALLER_PARTITION_KEY_RETIRED_LIVE' } });
    await retiredTooEarly.close();
    const receiptDrifts: Array<(value: Record<string, any>) => void> = [
      (value) => { value.schema = 'foreign'; },
      (value) => { value.idempotency_key_sha256 = '0'.repeat(64); },
      (value) => { value.operator_request_sha256 = '0'.repeat(64); },
      (value) => { value.principal_id_sha256 = '0'.repeat(64); },
      (value) => { value.capability_sha256 = '0'.repeat(64); },
      (value) => { value.capability_jti_sha256 = '0'.repeat(64); },
      (value) => { value.test_run_id_sha256 = '0'.repeat(64); },
      (value) => { value.cleanup_obligation_id_sha256 = '0'.repeat(64); },
      (value) => { value.environment = 'staging'; },
      (value) => { value.frontend_build = 'e'.repeat(40); },
      (value) => { value.mcp_build = 'e'.repeat(40); },
      (value) => { value.expected_deployment.frontend = 'e'.repeat(40); },
      (value) => { value.frontend_attempts = 0; value.frontend_reconciled = false; },
      (value) => { value.auth_audit_id = String(Number(value.auth_audit_id) + 1); },
      (value) => { value.audit_observed_at = '2026-08-24T12:00:00.000Z'; },
      (value) => { value.operator_subject_sha256 = '0'.repeat(64); },
    ];
    for (const mutate of receiptDrifts) {
      const drifted = structuredClone(receipt) as Record<string, any>;
      mutate(drifted);
      const { idempotent_replay: _replay, receipt_sha256: _digest, ...driftedCore } = drifted;
      drifted.idempotent_replay = false;
      drifted.receipt_sha256 = canonicalRequestHash(driftedCore);
      await ledger!.pool.query('update sophia_voice_lab.principal_provisions set receipt=$2 where request_hash=$1', [preparation.requestHash, drifted]);
      await ledger!.pool.query('update sophia_voice_lab.auth_audit set detail=$2 where id=$1', [claimed.record.authAuditId, drifted]);
      expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'invalid' });
      await ledger!.pool.query('update sophia_voice_lab.principal_provisions set receipt=$2 where request_hash=$1', [preparation.requestHash, receipt]);
      await ledger!.pool.query('update sophia_voice_lab.auth_audit set detail=$2 where id=$1', [claimed.record.authAuditId, receipt]);
      expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'completed' });
    }
    await ledger!.pool.query("update sophia_voice_lab.auth_audit set capability_jti_hash=$2 where id=$1", [claimed.record.authAuditId, "0".repeat(64)]);
    expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: "invalid" });
    await ledger!.pool.query("update sophia_voice_lab.auth_audit set capability_jti_hash=$2 where id=$1", [claimed.record.authAuditId, audit.capabilityJtiHash]);
    expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: "completed" });
    const conflict = await ledger!.claimPrincipalProvision({ ...preparation, requestHash: sha256(`${namespace}:different-request`) }, randomUUID(), 30, new Date());
    expect(conflict.disposition).toBe("conflict");
    const stored = await ledger!.pool.query("select * from sophia_voice_lab.principal_provisions");
    expect(JSON.stringify(stored.rows)).not.toContain(callerId);
    expect(JSON.stringify(stored.rows)).not.toContain(`${namespace}:principal`);
  }, 60_000);
});

function assertDedicatedTestDatabase(raw: string): void {
  const parsed = new URL(raw);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(?:^|[_-])voice[_-]lab[_-]test(?:$|[_-])/i.test(database) || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") {
    throw new Error("Postgres integration requires a dedicated *voice_lab_test* database and SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED=YES.");
  }
}

async function runMigration(url: string): Promise<void> {
  const cli = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const source = path.resolve(process.cwd(), "src/bin/migrate.ts");
  await execFileAsync(process.execPath, [cli, source], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url }, timeout: 60_000, maxBuffer: 1_000_000 });
}

function refresh(label: string, familyId: string, parentTokenHash: string | null, issuedAt: number): OAuthRefreshTokenRecord {
  return { tokenHash: sha256(`${namespace}:refresh:${label}`), issuer: "https://issuer.test", subject: "operator", clientId: "https://chatgpt.com/oauth/client.json", audience: "https://voice-lab.test/mcp", resource: "https://voice-lab.test/mcp", scopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"], familyId, parentTokenHash, replacementTokenHash: null, jti: `jti-refresh-${label}-${namespace}`, issuedAt, expiresAt: issuedAt + 3_600, usedAt: null, revokedAt: null };
}

function access(label: string, familyId: string, issuedAt: number): OAuthAccessTokenRecord {
  return { tokenHash: sha256(`${namespace}:access:${label}`), issuer: "https://issuer.test", subject: "operator", clientId: "https://chatgpt.com/oauth/client.json", audience: "https://voice-lab.test/mcp", resource: "https://voice-lab.test/mcp", scopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"], familyId, jti: `jti-access-${label}-${namespace}`, issuedAt, notBefore: issuedAt, expiresAt: issuedAt + 600, revokedAt: null };
}

async function putInitialPair(label: string, refreshRecord: OAuthRefreshTokenRecord, accessRecord: OAuthAccessTokenRecord, now: number): Promise<string> {
  const codeHash = sha256(`${namespace}:authorization-code:${label}`);
  const code: OAuthAuthorizationCodeRecord = {
    codeHash,
    clientId: refreshRecord.clientId,
    redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource: refreshRecord.resource,
    scopes: [...refreshRecord.scopes],
    codeChallenge: "A".repeat(43),
    subject: refreshRecord.subject,
    jti: `jti-code-${label}-${namespace}`,
    familyId: null,
    issuedAt: now - 1,
    expiresAt: now + 300,
    consumedAt: null,
    revokedAt: null,
  };
  await oauth!.putAuthorizationCode(code);
  expect(await oauth!.consumeAuthorizationCode(codeHash, now)).not.toBeNull();
  await oauth!.putInitialTokenPair(codeHash, refreshRecord, accessRecord);
  return codeHash;
}

async function liveFamilyRows(familyId: string): Promise<{ access: number; refresh: number }> {
  const result = await ledger!.pool.query<{ access: string; refresh: string }>(
    `select (select count(*) from sophia_voice_lab.oauth_access_tokens where family_id=$1 and revoked_at is null)::text as access,
            (select count(*) from sophia_voice_lab.oauth_refresh_tokens where family_id=$1 and revoked_at is null)::text as refresh`,
    [familyId],
  );
  return { access: Number(result.rows[0]!.access), refresh: Number(result.rows[0]!.refresh) };
}
