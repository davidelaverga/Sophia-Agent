import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MEM00_DELETE_SOURCE_SHA256,
  MEM00_DELETE_TRIGGER,
  MEM00_SOURCE_ACCEPTANCE_EPOCH_SOURCE_SHA256,
  MEM00_SOURCE_ACCEPTANCE_EPOCH_TRIGGER,
  MEM00_SOURCE_INTAKE_VERSION_SOURCE_SHA256,
  MEM00_SOURCE_INTAKE_VERSION_TRIGGER,
  MEM00_SOURCE_VERSION_SOURCE_SHA256,
  MEM00_SOURCE_VERSION_TRIGGER,
  withoutAttestedMem00Trigger,
} from '@/server/voice-lab/mem00-trigger-contract.mjs';

const MIGRATIONS = join(process.cwd(), '..', 'backend', 'migrations');

/** Body text Postgres stores in prosrc, read from the shipped migration. */
function migrationFunctionBody(file: string, functionName: string, tag = 'fn'): string {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  const pattern = new RegExp(
    `(?:CREATE|create)\\s+(?:(?:OR|or)\\s+(?:REPLACE|replace)\\s+)?(?:FUNCTION|function)`
    + `\\s+public\\.${functionName}\\s*\\(\\s*\\)`
    + `[\\s\\S]*?\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`,
  );
  const match = pattern.exec(sql);
  if (!match) throw new Error(`no body for ${functionName} in ${file}`);
  return match[1];
}

const SOURCES: Record<string, string> = {
  [MEM00_SOURCE_ACCEPTANCE_EPOCH_TRIGGER]: migrationFunctionBody(
    '2026_09_09_mem00_c1_transactional_clear.sql',
    'sophia_memory_source_acceptance_epoch_trigger',
  ),
  [MEM00_SOURCE_VERSION_TRIGGER]: migrationFunctionBody(
    '2026_09_09_mem00_c1_dependency_authority.sql',
    'sophia_memory_source_version_trigger',
  ),
  [MEM00_SOURCE_INTAKE_VERSION_TRIGGER]: migrationFunctionBody(
    '2026_09_09_mem00_c1_source_intake.sql',
    'sophia_memory_source_intake_version_trigger',
  ),
};

const SOURCE_TRIGGERS = [
  [MEM00_SOURCE_ACCEPTANCE_EPOCH_TRIGGER, 'sophia_memory_source_acceptance_epoch_trigger',
    MEM00_SOURCE_ACCEPTANCE_EPOCH_SOURCE_SHA256],
  [MEM00_SOURCE_VERSION_TRIGGER, 'sophia_memory_source_version_trigger',
    MEM00_SOURCE_VERSION_SOURCE_SHA256],
  [MEM00_SOURCE_INTAKE_VERSION_TRIGGER, 'sophia_memory_source_intake_version_trigger',
    MEM00_SOURCE_INTAKE_VERSION_SOURCE_SHA256],
] as const;

type Row = { tgname: string } & Record<string, unknown>;
type RowOverride = Record<string, unknown>;

function sourceCompanionRow(trigger: string, fn: string, overrides: RowOverride = {}): Row {
  return {
    tgname: trigger,
    tablename: 'sophia_session_messages',
    tgenabled: 'O',
    proname: fn,
    function_schema: 'public',
    function_is_public_identity: true,
    owner_is_expected: true,
    owner_matches_control: true,
    prosecdef: false,
    provolatile: 'v',
    lanname: 'plpgsql',
    mem00_function_authority_valid: true,
    proconfig: ['search_path=pg_catalog, public'],
    trigger_definition:
      `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON sophia_session_messages`
      + ` FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    prosrc: SOURCES[trigger],
    ...overrides,
  };
}

const DELETE_BODY = migrationFunctionBody(
  '2026_09_06_mem00_ordinary_session_delete_order.sql',
  MEM00_DELETE_TRIGGER,
  'function',
);
function deleteCompanionRow(overrides: RowOverride = {}): Row {
  return {
    tgname: MEM00_DELETE_TRIGGER,
    tablename: 'sophia_sessions',
    tgenabled: 'O',
    proname: MEM00_DELETE_TRIGGER,
    function_schema: 'public',
    function_is_public_identity: true,
    owner_is_expected: true,
    owner_matches_control: true,
    prosecdef: true,
    provolatile: 'v',
    lanname: 'plpgsql',
    mem00_function_authority_valid: true,
    proconfig: ['search_path=pg_catalog, public'],
    trigger_definition:
      `CREATE TRIGGER ${MEM00_DELETE_TRIGGER} BEFORE DELETE ON sophia_sessions`
      + ` FOR EACH ROW EXECUTE FUNCTION ${MEM00_DELETE_TRIGGER}()`,
    prosrc: DELETE_BODY,
    ...overrides,
  };
}

/** The four Voice Lab fences must survive every path through the filter. */
const FENCES: Row[] = [
  { tgname: 'sophia_voice_lab_cleanup_write_fence', tablename: 'sophia_sessions' },
  { tgname: 'sophia_voice_lab_message_write_fence', tablename: 'sophia_session_messages' },
  { tgname: 'sophia_voice_lab_artifact_write_fence', tablename: 'artifact_registry_records' },
  { tgname: 'sophia_voice_lab_auth_grant_write_fence', tablename: 'sophia_voice_lab_auth_grants' },
];

describe('MEM00 companion trigger attestation', () => {
  it('pins the source hashes actually shipped by the migrations', () => {
    for (const [trigger, , pin] of SOURCE_TRIGGERS) {
      const body = SOURCES[trigger];
      expect(createHash('sha256').update(body, 'utf8').digest('hex')).toBe(pin);
    }
  });

  it('passes the fences through untouched when no MEM00 migration is applied', () => {
    expect(withoutAttestedMem00Trigger([...FENCES])).toEqual(FENCES);
  });

  it('filters every attested companion and keeps exactly the four fences', () => {
    const rows = [
      ...FENCES,
      deleteCompanionRow(),
      ...SOURCE_TRIGGERS.map(([t, fn]) => sourceCompanionRow(t, fn)),
    ];
    expect(withoutAttestedMem00Trigger(rows)).toEqual(FENCES);
  });

  it('filters each source companion independently', () => {
    for (const [trigger, fn] of SOURCE_TRIGGERS) {
      const rows = [...FENCES, sourceCompanionRow(trigger, fn)];
      expect(withoutAttestedMem00Trigger(rows)).toEqual(FENCES);
    }
  });

  it('retains unknown triggers so the caller count check rejects them', () => {
    const unknown = { tgname: 'some_unreviewed_trigger', tablename: 'sophia_session_messages' };
    const rows = [...FENCES, unknown, sourceCompanionRow(SOURCE_TRIGGERS[0][0], SOURCE_TRIGGERS[0][1])];
    expect(withoutAttestedMem00Trigger(rows)).toEqual([...FENCES, unknown]);
  });

  it('rejects a duplicated source companion', () => {
    const [trigger, fn] = SOURCE_TRIGGERS[0];
    const rows = [...FENCES, sourceCompanionRow(trigger, fn), sourceCompanionRow(trigger, fn)];
    expect(() => withoutAttestedMem00Trigger(rows)).toThrow(/duplicated/);
  });

  const DRIFTS: Array<[string, RowOverride]> = [
    ['wrong table', { tablename: 'sophia_sessions' }],
    ['disabled trigger', { tgenabled: 'D' }],
    ['replica-only trigger', { tgenabled: 'R' }],
    ['wrong function name', { proname: 'sophia_memory_something_else' }],
    ['non-public function schema', { function_schema: 'mem00' }],
    ['non-public identity', { function_is_public_identity: false }],
    ['unexpected owner', { owner_is_expected: false }],
    ['owner not matching control', { owner_matches_control: false }],
    ['security definer instead of invoker', { prosecdef: true }],
    ['non-volatile function', { provolatile: 's' }],
    ['wrong language', { lanname: 'sql' }],
    ['function authority invalid', { mem00_function_authority_valid: false }],
    ['extra proconfig entry', { proconfig: ['search_path=pg_catalog, public', 'role=postgres'] }],
    ['widened search_path', { proconfig: ['search_path=pg_catalog, public, mem00'] }],
    ['missing proconfig', { proconfig: null }],
    ['altered trigger definition', { trigger_definition: 'CREATE TRIGGER x AFTER INSERT ON y' }],
    ['altered function body', { prosrc: 'BEGIN RETURN NEW; END' }],
    ['non-string body', { prosrc: null }],
  ];

  it.each(DRIFTS)('rejects a source companion with %s', (_label, override) => {
    const [trigger, fn] = SOURCE_TRIGGERS[0];
    const rows = [...FENCES, sourceCompanionRow(trigger, fn, override)];
    expect(() => withoutAttestedMem00Trigger(rows)).toThrow(/drifted/);
  });

  it('still rejects the delete companion turned invoker', () => {
    const rows = [...FENCES, deleteCompanionRow({ prosecdef: false })];
    expect(() => withoutAttestedMem00Trigger(rows)).toThrow(/drifted/);
  });

  it('rejects a source companion bearing the delete companion body', () => {
    const [trigger, fn] = SOURCE_TRIGGERS[0];
    const rows = [...FENCES, sourceCompanionRow(trigger, fn, { prosrc: DELETE_BODY })];
    expect(() => withoutAttestedMem00Trigger(rows)).toThrow(/drifted/);
  });

  it('keeps the delete companion pin tracking its migration', () => {
    expect(MEM00_DELETE_SOURCE_SHA256).toBe(
      '4087a488f957a0fb77d758de1db94f9938644411103ecfc77c62f5b9664716ce',
    );
    expect(createHash('sha256').update(DELETE_BODY, 'utf8').digest('hex'))
      .toBe(MEM00_DELETE_SOURCE_SHA256);
  });

  it('filters the delete companion on its own', () => {
    expect(withoutAttestedMem00Trigger([...FENCES, deleteCompanionRow()])).toEqual(FENCES);
  });
});
