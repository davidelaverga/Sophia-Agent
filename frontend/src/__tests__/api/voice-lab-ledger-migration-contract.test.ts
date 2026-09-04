import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256,
  VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256,
  VOICE_LAB_ORDINARY_WRITE_FENCE_REPAIR_SHA256,
} from '../../server/voice-lab/session-ledger';
import { transactionBody } from '../../../scripts/voice-lab-migration-contract.mjs';

const migrationPath = resolve(
  process.cwd(),
  '../backend/migrations/2026_08_23_voice_lab_auth_grant_ledger.sql',
);
const runnerPath = resolve(process.cwd(), 'scripts/migrate-voice-lab-auth-ledger.mjs');
const cleanupMigrationPath = resolve(
  process.cwd(),
  '../backend/migrations/2026_08_23_voice_lab_cleanup_obligation_indexes.sql',
);
const ordinaryWriteFenceRepairPath = resolve(
  process.cwd(),
  '../backend/migrations/2026_09_04_voice_lab_ordinary_write_fence_repair.sql',
);

describe('Voice Lab auth-ledger operated migration contract', () => {
  it('pins the exact SQL template hash across runtime and operator runner', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    const runner = readFileSync(runnerPath, 'utf8');
    const digest = createHash('sha256').update(sql, 'utf8').digest('hex');

    expect(digest).toBe(VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256);
    expect(runner).toContain(
      `const EXPECTED_MIGRATION_SHA256 = '${VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256}'`,
    );
    expect(runner).toContain('SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL');
    expect(runner).toContain("const EXPECTED_RUNTIME_DATABASE_ROLE = 'better_auth_app'");
    expect(runner).toContain('supabase_pg17.directional_membership.v1');
    expect(runner.match(/roleMembershipAttestationSql\(\)/g)).toHaveLength(4);
    expect(runner).toContain("member_role.rolname = 'postgres'");
    expect(runner).toContain("grantor_role.rolname = 'supabase_admin'");
    expect(runner).toContain('membership.admin_option = true');
    expect(runner).toContain('membership.inherit_option = false');
    expect(runner).toContain('membership.set_option = false');
    expect(runner).toContain('WITH RECURSIVE inherited_roles');
    expect(runner).toContain('voice_lab_d02_global_effective_privileges');
    expect(runner).toContain('voice_lab_d02_global_function_authority');
    expect(runner).toMatch(
      /voice_lab_d02_global_function_authority[\s\S]*dependency\.classid = 'pg_proc'::regclass[\s\S]*dependency\.deptype = 'e'/,
    );
    expect(runner).toMatch(
      /voice_lab_d02_global_effective_privileges[\s\S]*dependency\.classid = 'pg_class'::regclass[\s\S]*dependency\.deptype = 'e'/,
    );
    expect(sql.match(/__SOPHIA_VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256__/g)).toHaveLength(1);
    expect(sql.toLowerCase()).toContain(
      'revoke all on public.sophia_voice_lab_auth_grants from public',
    );
    expect(sql).toContain("array['anon', 'authenticated']");
  });

  it('pins the cleanup indexes and immutable signed-binding write fence', () => {
    const sql = readFileSync(cleanupMigrationPath, 'utf8');
    const runner = readFileSync(runnerPath, 'utf8');
    const digest = createHash('sha256').update(sql, 'utf8').digest('hex');

    expect(digest).toBe(VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256);
    expect(runner).toContain(
      `const EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256 = '${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256}'`,
    );
    expect(sql.match(/__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__/g)).toHaveLength(33);
    expect(sql).toContain('create table if not exists public.sophia_voice_lab_cleanup_obligations');
    expect(sql).toContain('create table if not exists public.sophia_voice_lab_cleanup_admissions');
    expect(sql).toContain('create table if not exists public.sophia_voice_lab_cleanup_scan_cursors');
    expect(sql).toContain("state in ('open', 'closed', 'complete')");
    expect(sql).toContain("resource_kind in ('session', 'provider', 'builder')");
    expect(sql).toContain('pg_advisory_xact_lock(hashtextextended(cleanup_id, 731944))');
    expect(sql).toContain("obligation_row.lifecycle_phase <> 'session_provisional'");
    expect(sql).toContain('synthetic cleanup allocation admission is missing or expired');
    expect(sql).toContain('synthetic cleanup obligation admission is closed');
    expect(sql).toContain('synthetic session signed binding is immutable');
    expect(sql).toContain('synthetic provisional retention binding is malformed');
    expect(sql).toContain('synthetic artifact signed binding is immutable');
    expect(sql).toContain('synthetic auth tombstone transition is invalid');
    expect(sql).toContain('synthetic provider terminal receipt transition is invalid');
    expect(sql).toContain('sophia_voice_lab_cleanup_admissions_expiry_idx');
    expect(sql).toContain('sophia_voice_lab_cleanup_obligations_work_idx');
    expect(sql).toContain('live_cleanup_completed_at');
    expect(sql).toContain('old_cleanup_id is distinct from new_cleanup_id');
    expect(sql).toContain('grant select, insert, update, delete\n      on public.sophia_voice_lab_auth_grants');
    expect(sql).toContain('grant select, update\n      on public.sophia_sessions');
    expect(sql).toContain(
      'on public.sophia_sessions,\n         public.sophia_session_messages,\n         public.artifact_registry_records,',
    );
    expect(sql).toContain('grant select, insert, update, delete\n      on public.sophia_voice_lab_cleanup_obligations');
    expect(sql).toContain('grant select, insert, update, delete\n      on public.sophia_voice_lab_cleanup_admissions');
    expect(sql).toContain('grant select, update\n      on public.sophia_voice_lab_cleanup_scan_cursors');
    expect(sql).toContain('grant execute on function\n      public.sophia_voice_lab_d02_sources_zero(text)');
    expect(sql).toContain('operation=sources-zero exposure=gateway-runtime-readback');
  });

  it('pins the additive ordinary-row write-fence repair', () => {
    const sql = readFileSync(ordinaryWriteFenceRepairPath, 'utf8');
    const runner = readFileSync(runnerPath, 'utf8');
    const digest = createHash('sha256').update(sql, 'utf8').digest('hex');

    expect(digest).toBe(VOICE_LAB_ORDINARY_WRITE_FENCE_REPAIR_SHA256);
    expect(runner).toContain(
      `const EXPECTED_ORDINARY_WRITE_FENCE_REPAIR_SHA256 = '${VOICE_LAB_ORDINARY_WRITE_FENCE_REPAIR_SHA256}'`,
    );
    expect(sql.match(/__SOPHIA_VOICE_LAB_ORDINARY_WRITE_FENCE_REPAIR_SHA256__/g))
      .toHaveLength(1);
    expect(sql).toContain(
      "new_synthetic := coalesce(new_payload ->> ''synthetic'' = ''true'', false);",
    );
    expect(sql).toContain(
      "new_synthetic := coalesce(new_payload ->> ''synthetic_test'' = ''true'', false);",
    );
    expect(sql).toContain(
      "'0678607736ee21130257e2a87f79bc807d12a0f6d22295f55079ff6bbb4aa1b2'",
    );
    expect(transactionBody(sql, 'ordinary-write-fence-repair')).toContain(
      'Voice Lab cleanup write fence repair verification failed',
    );
  });

  it('accepts both pinned line-comment prologues and rejects arbitrary wrapper drift', () => {
    const authSql = readFileSync(migrationPath, 'utf8');
    const cleanupSql = readFileSync(cleanupMigrationPath, 'utf8');

    expect(transactionBody(authSql, 'auth')).toContain(
      'create table if not exists public.sophia_voice_lab_auth_grants',
    );
    expect(transactionBody(cleanupSql, 'cleanup')).toContain(
      'create unique index if not exists sophia_sessions_voice_lab_cleanup_obligation_idx',
    );
    expect(() => transactionBody('select 1;\nbegin;\nselect 1;\ncommit;', 'prefix')).toThrow(
      'transaction wrapper drifted',
    );
    expect(() => transactionBody('begin;\nselect 1;\ncommit;\n-- suffix', 'suffix')).toThrow(
      'transaction wrapper drifted',
    );
    expect(() => transactionBody(
      `${Array.from({ length: 17 }, (_, index) => `-- ${index}`).join('\n')}\nbegin;\nselect 1;\ncommit;`,
      'unbounded',
    )).toThrow('comment prologue is not bounded');
  });
});
