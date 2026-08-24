import pg from "pg";

import type {
  OAuthAccessTokenRecord,
  OAuthAuthorizationCodeRecord,
  OAuthAuthorizationRequestRecord,
  OAuthEndpointAdmission,
  OAuthLedgerStore,
  OAuthRevocationReceipt,
  OAuthRefreshRotationResult,
  OAuthRefreshTokenRecord,
} from "./oauth.js";
import { attestVoiceLabSchema } from "./schema-attestation.js";
import { CallerPartitioner, type CallerPartitionKeyRing } from "./caller-partition.js";

const { Pool } = pg;
const SCHEMA = "sophia_voice_lab";
const FAMILY_LOCK_NAMESPACE = 0x534f5048;

/** Durable OAuth 2.1 store. All persisted code/token identifiers are already
 * HMAC hashes produced by OAuthAuthorizationServer; raw bearer material never
 * crosses this boundary. */
export class PostgresOAuthLedgerStore implements OAuthLedgerStore {
  readonly pool: pg.Pool;
  readonly admissionRetentionSeconds: number;
  readonly #callerPartitions: CallerPartitioner;
  readonly #operatorSubject: string;

  constructor(databaseUrl: string, max = 5, admissionRetentionSeconds = 86_400, callerPartitionKeys?: CallerPartitionKeyRing, operatorSubject?: string) {
    if (!Number.isSafeInteger(admissionRetentionSeconds) || admissionRetentionSeconds < 3_600 || admissionRetentionSeconds > 604_800) throw new Error("OAuth admission retention is invalid");
    if (!callerPartitionKeys || typeof operatorSubject !== "string" || operatorSubject.length < 1 || operatorSubject.length > 512) throw new Error("OAuth durable subject partition configuration is required");
    this.pool = new Pool({ connectionString: databaseUrl, max, application_name: "sophia-voice-lab-oauth" });
    this.admissionRetentionSeconds = admissionRetentionSeconds;
    this.#callerPartitions = new CallerPartitioner(callerPartitionKeys);
    this.#operatorSubject = operatorSubject;
  }

  async close(): Promise<void> { await this.pool.end(); }
  async readiness(): Promise<boolean> {
    if (!(await attestVoiceLabSchema(this.pool)).ok) return false;
    try { await this.#assertSubjectKeyCoverage(); return true; }
    catch { return false; }
  }

  async #assertSubjectKeyCoverage(): Promise<void> {
    const result = await this.pool.query<{ subject: string }>(
      `select distinct subject from (
         select subject from ${SCHEMA}.oauth_authorization_requests where expires_at>now()
         union all select subject from ${SCHEMA}.oauth_authorization_codes where expires_at>now()
         union all select subject from ${SCHEMA}.oauth_access_tokens where expires_at>now()
         union all select subject from ${SCHEMA}.oauth_refresh_tokens where expires_at>now()
       ) live_subjects order by subject`,
    );
    this.#callerPartitions.assertLivePartitionIds(result.rows.map((row) => row.subject));
  }

  #persistSubject(subject: string): string {
    if (subject !== this.#operatorSubject) throw new Error("OAuth durable record subject does not match the configured operator");
    return this.#callerPartitions.activeOAuthSubjectId(subject);
  }

  #restoreSubject(subject: unknown): string {
    if (typeof subject !== "string" || !this.#callerPartitions.oauthSubjectIds(this.#operatorSubject).includes(subject)) throw new Error("OAuth durable record subject partition is invalid or unconfigured");
    return this.#operatorSubject;
  }

  async reserveEndpointAdmission(admission: OAuthEndpointAdmission): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(admission.subjectHash) || !Number.isSafeInteger(admission.windowStartedAt) || !Number.isSafeInteger(admission.observedAt) || !Number.isSafeInteger(admission.limit) || admission.limit < 1 || admission.observedAt < admission.windowStartedAt || admission.observedAt - admission.windowStartedAt > 3_600) throw new Error("OAuth endpoint admission is malformed");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `insert into ${SCHEMA}.oauth_endpoint_admissions (action,subject_hash,window_started_at,request_count,updated_at)
         values ($1,$2,to_timestamp($3),1,to_timestamp($4))
         on conflict (action,subject_hash,window_started_at) do update
           set request_count=${SCHEMA}.oauth_endpoint_admissions.request_count+1,updated_at=excluded.updated_at
           where ${SCHEMA}.oauth_endpoint_admissions.request_count < $5
         returning request_count`,
        [admission.action, admission.subjectHash, admission.windowStartedAt, admission.observedAt, admission.limit],
      );
      await client.query("commit");
      return result.rowCount === 1;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async purgeExpired(now: number, limit: number): Promise<number> {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("OAuth purge boundary is malformed");
    const client = await this.pool.connect();
    let deleted = 0;
    try {
      await client.query("begin");
      for (const statement of [
        `delete from ${SCHEMA}.oauth_authorization_requests where ctid in (select ctid from ${SCHEMA}.oauth_authorization_requests where expires_at<=to_timestamp($1) order by expires_at limit $2)`,
        `delete from ${SCHEMA}.oauth_authorization_codes where ctid in (select ctid from ${SCHEMA}.oauth_authorization_codes where expires_at<=to_timestamp($1) order by expires_at limit $2)`,
        `delete from ${SCHEMA}.oauth_access_tokens where ctid in (select ctid from ${SCHEMA}.oauth_access_tokens where expires_at<=to_timestamp($1) order by expires_at limit $2)`,
        `delete from ${SCHEMA}.oauth_refresh_tokens where ctid in (select ctid from ${SCHEMA}.oauth_refresh_tokens where expires_at<=to_timestamp($1) order by expires_at limit $2)`,
        `delete from ${SCHEMA}.oauth_client_assertion_jtis where ctid in (select ctid from ${SCHEMA}.oauth_client_assertion_jtis where expires_at<=to_timestamp($1) order by expires_at limit $2)`,
        `delete from ${SCHEMA}.oauth_endpoint_admissions where ctid in (select ctid from ${SCHEMA}.oauth_endpoint_admissions where updated_at<to_timestamp($1)-make_interval(secs=>$3) order by updated_at limit $2)`,
      ]) {
        const result = await client.query(statement, statement.includes("$3") ? [now, limit, this.admissionRetentionSeconds] : [now, limit]);
        deleted += result.rowCount ?? 0;
      }
      await client.query("commit");
      return deleted;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async putAuthorizationRequest(record: OAuthAuthorizationRequestRecord): Promise<void> {
    await this.pool.query(`insert into ${SCHEMA}.oauth_authorization_requests (request_hash,csrf_hash,client_id,redirect_uri,resource,state,scopes,code_challenge,subject,issued_at,expires_at,consumed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),to_timestamp($11),null)`, [record.requestHash, record.csrfHash, record.clientId, record.redirectUri, record.resource, record.state, record.scopes, record.codeChallenge, this.#persistSubject(record.subject), record.issuedAt, record.expiresAt]);
  }

  async consumeAuthorizationRequest(requestHash: string, csrfHash: string, now: number): Promise<OAuthAuthorizationRequestRecord | null> {
    const result = await this.pool.query(`update ${SCHEMA}.oauth_authorization_requests set consumed_at=to_timestamp($3) where request_hash=$1 and csrf_hash=$2 and consumed_at is null and expires_at>to_timestamp($3) returning *`, [requestHash, csrfHash, now]);
    return result.rows[0] ? mapAuthorizationRequest(result.rows[0], this.#restoreSubject(result.rows[0].subject)) : null;
  }

  async putAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<void> {
    if (record.familyId !== null || record.revokedAt !== null || record.consumedAt !== null) throw new Error("New OAuth authorization code state is invalid");
    await this.pool.query(`insert into ${SCHEMA}.oauth_authorization_codes (code_hash,client_id,redirect_uri,resource,scopes,code_challenge,subject,jti,family_id,issued_at,expires_at,consumed_at,revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,null,to_timestamp($9),to_timestamp($10),null,null)`, [record.codeHash, record.clientId, record.redirectUri, record.resource, record.scopes, record.codeChallenge, this.#persistSubject(record.subject), record.jti, record.issuedAt, record.expiresAt]);
  }

  async consumeAuthorizationCode(codeHash: string, now: number): Promise<OAuthAuthorizationCodeRecord | null> {
    const result = await this.pool.query(`update ${SCHEMA}.oauth_authorization_codes set consumed_at=to_timestamp($2) where code_hash=$1 and consumed_at is null and revoked_at is null and expires_at>to_timestamp($2) returning *`, [codeHash, now]);
    return result.rows[0] ? mapAuthorizationCode(result.rows[0], this.#restoreSubject(result.rows[0].subject)) : null;
  }

  async putAccessToken(record: OAuthAccessTokenRecord): Promise<void> {
    await this.pool.query(`insert into ${SCHEMA}.oauth_access_tokens (token_hash,issuer,subject,client_id,audience,resource,scopes,family_id,jti,issued_at,not_before,expires_at,revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),to_timestamp($11),to_timestamp($12),null)`, [record.tokenHash, record.issuer, this.#persistSubject(record.subject), record.clientId, record.audience, record.resource, record.scopes, record.familyId, record.jti, record.issuedAt, record.notBefore, record.expiresAt]);
  }

  async getAccessToken(tokenHash: string): Promise<OAuthAccessTokenRecord | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.oauth_access_tokens where token_hash=$1`, [tokenHash]);
    return result.rows[0] ? mapAccessToken(result.rows[0], this.#restoreSubject(result.rows[0].subject)) : null;
  }

  async putRefreshToken(record: OAuthRefreshTokenRecord): Promise<void> {
    await this.pool.query(`insert into ${SCHEMA}.oauth_refresh_tokens (token_hash,issuer,subject,client_id,audience,resource,scopes,family_id,parent_token_hash,replacement_token_hash,jti,issued_at,expires_at,used_at,revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),to_timestamp($13),null,null)`, [record.tokenHash, record.issuer, this.#persistSubject(record.subject), record.clientId, record.audience, record.resource, record.scopes, record.familyId, record.parentTokenHash, record.replacementTokenHash, record.jti, record.issuedAt, record.expiresAt]);
  }

  async getRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRecord | null> {
    const result = await this.pool.query(`select * from ${SCHEMA}.oauth_refresh_tokens where token_hash=$1`, [tokenHash]);
    return result.rows[0] ? mapRefreshToken(result.rows[0], this.#restoreSubject(result.rows[0].subject)) : null;
  }

  async putInitialTokenPair(authorizationCodeHash: string, refresh: OAuthRefreshTokenRecord, access: OAuthAccessTokenRecord): Promise<void> {
    if (refresh.familyId !== access.familyId) throw new Error("OAuth token family mismatch");
    const persistedRefreshSubject = this.#persistSubject(refresh.subject);
    const persistedAccessSubject = this.#persistSubject(access.subject);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const authorization = await client.query<{ client_id: string; consumed_at: Date | null; revoked_at: Date | null; family_id: string | null }>(`select client_id,consumed_at,revoked_at,family_id from ${SCHEMA}.oauth_authorization_codes where code_hash=$1 for update`, [authorizationCodeHash]);
      const code = authorization.rows[0];
      if (!code || code.client_id !== refresh.clientId || code.consumed_at === null || code.revoked_at !== null || code.family_id !== null) throw new Error("OAuth authorization code cannot publish a token family");
      await lockFamily(client, refresh.familyId);
      await client.query(`insert into ${SCHEMA}.oauth_refresh_tokens (token_hash,issuer,subject,client_id,audience,resource,scopes,family_id,parent_token_hash,replacement_token_hash,jti,issued_at,expires_at,used_at,revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),to_timestamp($13),null,null)`, [refresh.tokenHash, refresh.issuer, persistedRefreshSubject, refresh.clientId, refresh.audience, refresh.resource, refresh.scopes, refresh.familyId, refresh.parentTokenHash, refresh.replacementTokenHash, refresh.jti, refresh.issuedAt, refresh.expiresAt]);
      await client.query(`insert into ${SCHEMA}.oauth_access_tokens (token_hash,issuer,subject,client_id,audience,resource,scopes,family_id,jti,issued_at,not_before,expires_at,revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),to_timestamp($11),to_timestamp($12),null)`, [access.tokenHash, access.issuer, persistedAccessSubject, access.clientId, access.audience, access.resource, access.scopes, access.familyId, access.jti, access.issuedAt, access.notBefore, access.expiresAt]);
      await client.query(`update ${SCHEMA}.oauth_authorization_codes set family_id=$2 where code_hash=$1`, [authorizationCodeHash, refresh.familyId]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async rotateRefreshToken(currentHash: string, expectedJti: string, replacement: OAuthRefreshTokenRecord, access: OAuthAccessTokenRecord, now: number): Promise<OAuthRefreshRotationResult> {
    const persistedReplacementSubject = this.#persistSubject(replacement.subject);
    const persistedAccessSubject = this.#persistSubject(access.subject);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const family = await client.query<{ family_id: string }>(`select family_id from ${SCHEMA}.oauth_refresh_tokens where token_hash=$1`, [currentHash]);
      if (!family.rows[0]) { await client.query("commit"); return { status: "invalid" }; }
      await lockFamily(client, family.rows[0].family_id);
      const selected = await client.query(`select * from ${SCHEMA}.oauth_refresh_tokens where token_hash=$1 for update`, [currentHash]);
      if (!selected.rows[0]) { await client.query("commit"); return { status: "invalid" }; }
      const current = mapRefreshToken(selected.rows[0], this.#restoreSubject(selected.rows[0].subject));
      if (current.usedAt !== null || current.replacementTokenHash !== null) {
        // Replay detection and family revocation are one transaction. A crash
        // after observing replay can therefore never leave the winner's access
        // token live.
        await client.query(`update ${SCHEMA}.oauth_access_tokens set revoked_at=coalesce(revoked_at,to_timestamp($2)) where family_id=$1`, [current.familyId, now]);
        await client.query(`update ${SCHEMA}.oauth_refresh_tokens set revoked_at=coalesce(revoked_at,to_timestamp($2)) where family_id=$1`, [current.familyId, now]);
        await client.query("commit");
        return { status: "replayed", familyId: current.familyId };
      }
      if (current.revokedAt !== null || current.expiresAt <= now || current.jti !== expectedJti || replacement.familyId !== current.familyId || replacement.parentTokenHash !== currentHash) { await client.query("commit"); return { status: "invalid" }; }
      await client.query(`insert into ${SCHEMA}.oauth_refresh_tokens (token_hash,issuer,subject,client_id,audience,resource,scopes,family_id,parent_token_hash,replacement_token_hash,jti,issued_at,expires_at,used_at,revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),to_timestamp($13),null,null)`, [replacement.tokenHash, replacement.issuer, persistedReplacementSubject, replacement.clientId, replacement.audience, replacement.resource, replacement.scopes, replacement.familyId, replacement.parentTokenHash, replacement.replacementTokenHash, replacement.jti, replacement.issuedAt, replacement.expiresAt]);
      await client.query(`insert into ${SCHEMA}.oauth_access_tokens (token_hash,issuer,subject,client_id,audience,resource,scopes,family_id,jti,issued_at,not_before,expires_at,revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),to_timestamp($11),to_timestamp($12),null)`, [access.tokenHash, access.issuer, persistedAccessSubject, access.clientId, access.audience, access.resource, access.scopes, access.familyId, access.jti, access.issuedAt, access.notBefore, access.expiresAt]);
      const updated = await client.query(`update ${SCHEMA}.oauth_refresh_tokens set used_at=to_timestamp($2),replacement_token_hash=$3 where token_hash=$1 returning *`, [currentHash, now, replacement.tokenHash]);
      await client.query("commit");
      return { status: "rotated", current: mapRefreshToken(updated.rows[0], this.#restoreSubject(updated.rows[0].subject)) };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async revokeToken(tokenHash: string, clientId: string, now: number): Promise<OAuthRevocationReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const authorization = await client.query<{ family_id: string | null }>(`select family_id from ${SCHEMA}.oauth_authorization_codes where code_hash=$1 and client_id=$2 for update`, [tokenHash, clientId]);
      if (authorization.rows[0]) {
        const familyId = authorization.rows[0].family_id;
        await client.query(`update ${SCHEMA}.oauth_authorization_codes set revoked_at=coalesce(revoked_at,to_timestamp($3)) where code_hash=$1 and client_id=$2`, [tokenHash, clientId, now]);
        if (familyId) {
          await lockFamily(client, familyId);
          await client.query(`update ${SCHEMA}.oauth_access_tokens set revoked_at=coalesce(revoked_at,to_timestamp($2)) where family_id=$1`, [familyId, now]);
          await client.query(`update ${SCHEMA}.oauth_refresh_tokens set revoked_at=coalesce(revoked_at,to_timestamp($2)) where family_id=$1`, [familyId, now]);
        }
        await client.query("commit");
        return { matched: true, kind: "authorization_code", familyTerminal: true };
      }
      const family = await client.query<{ family_id: string }>(`select family_id from ${SCHEMA}.oauth_refresh_tokens where token_hash=$1 and client_id=$2 union all select family_id from ${SCHEMA}.oauth_access_tokens where token_hash=$1 and client_id=$2 limit 1`, [tokenHash, clientId]);
      if (family.rows[0]) await lockFamily(client, family.rows[0].family_id);
      await client.query(`update ${SCHEMA}.oauth_access_tokens set revoked_at=coalesce(revoked_at,to_timestamp($3)) where token_hash=$1 and client_id=$2`, [tokenHash, clientId, now]);
      const refresh = await client.query<{ family_id: string }>(`select family_id from ${SCHEMA}.oauth_refresh_tokens where token_hash=$1 and client_id=$2 for update`, [tokenHash, clientId]);
      if (refresh.rows[0]) {
        await client.query(`update ${SCHEMA}.oauth_access_tokens set revoked_at=coalesce(revoked_at,to_timestamp($2)) where family_id=$1`, [refresh.rows[0].family_id, now]);
        await client.query(`update ${SCHEMA}.oauth_refresh_tokens set revoked_at=coalesce(revoked_at,to_timestamp($2)) where family_id=$1`, [refresh.rows[0].family_id, now]);
      }
      await client.query("commit");
      if (refresh.rows[0]) return { matched: true, kind: "refresh_token", familyTerminal: true };
      if (family.rows[0]) return { matched: true, kind: "access_token", familyTerminal: false };
      return { matched: false, kind: null, familyTerminal: false };
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async revokeTokenFamily(familyId: string, now: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockFamily(client, familyId);
      await client.query(`update ${SCHEMA}.oauth_access_tokens set revoked_at=coalesce(revoked_at,to_timestamp($2)) where family_id=$1`, [familyId, now]);
      await client.query(`update ${SCHEMA}.oauth_refresh_tokens set revoked_at=coalesce(revoked_at,to_timestamp($2)) where family_id=$1`, [familyId, now]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async claimClientAssertionJti(clientId: string, jti: string, expiresAt: number, now: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from ${SCHEMA}.oauth_client_assertion_jtis where expires_at<=to_timestamp($1)`, [now]);
      const result = await client.query(`insert into ${SCHEMA}.oauth_client_assertion_jtis (client_id,jti,expires_at,claimed_at) values ($1,$2,to_timestamp($3),to_timestamp($4)) on conflict do nothing returning client_id`, [clientId, jti, expiresAt, now]);
      await client.query("commit");
      return Boolean(result.rows[0]);
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
}

async function lockFamily(client: pg.PoolClient, familyId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock($1, hashtext($2))", [FAMILY_LOCK_NAMESPACE, familyId]);
}

function epoch(value: unknown): number { return Math.floor(new Date(String(value)).getTime() / 1_000); }
function maybeEpoch(value: unknown): number | null { return value === null || value === undefined ? null : epoch(value); }
function mapAuthorizationRequest(row: any, subject: string): OAuthAuthorizationRequestRecord { return { requestHash:row.request_hash,csrfHash:row.csrf_hash,clientId:row.client_id,redirectUri:row.redirect_uri,resource:row.resource,state:row.state,scopes:row.scopes ?? [],codeChallenge:row.code_challenge,subject,issuedAt:epoch(row.issued_at),expiresAt:epoch(row.expires_at),consumedAt:maybeEpoch(row.consumed_at) }; }
function mapAuthorizationCode(row: any, subject: string): OAuthAuthorizationCodeRecord { return { codeHash:row.code_hash,clientId:row.client_id,redirectUri:row.redirect_uri,resource:row.resource,scopes:row.scopes ?? [],codeChallenge:row.code_challenge,subject,jti:row.jti,familyId:row.family_id ?? null,issuedAt:epoch(row.issued_at),expiresAt:epoch(row.expires_at),consumedAt:maybeEpoch(row.consumed_at),revokedAt:maybeEpoch(row.revoked_at) }; }
function mapAccessToken(row: any, subject: string): OAuthAccessTokenRecord { return { tokenHash:row.token_hash,issuer:row.issuer,subject,clientId:row.client_id,audience:row.audience,resource:row.resource,scopes:row.scopes ?? [],familyId:row.family_id,jti:row.jti,issuedAt:epoch(row.issued_at),notBefore:epoch(row.not_before),expiresAt:epoch(row.expires_at),revokedAt:maybeEpoch(row.revoked_at) }; }
function mapRefreshToken(row: any, subject: string): OAuthRefreshTokenRecord { return { tokenHash:row.token_hash,issuer:row.issuer,subject,clientId:row.client_id,audience:row.audience,resource:row.resource,scopes:row.scopes ?? [],familyId:row.family_id,parentTokenHash:row.parent_token_hash,replacementTokenHash:row.replacement_token_hash,jti:row.jti,issuedAt:epoch(row.issued_at),expiresAt:epoch(row.expires_at),usedAt:maybeEpoch(row.used_at),revokedAt:maybeEpoch(row.revoked_at) }; }
