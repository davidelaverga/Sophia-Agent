// MEM00-C2 staged migration application (operator-invoked, authorized).
//
// Applies the twelve additive C1/C2 migration files to the production Supabase
// database in the QUALIFIED DEPENDENCY ORDER, one file per request. Every file
// is transactional (BEGIN..COMMIT) and guarded (IF NOT EXISTS / CREATE OR
// REPLACE), so a re-run is a no-op rather than a second mutation.
//
// ORDER IS NOT LEXICAL. The order below is copied from the qualified harness
// `tools/mem00_c2_model_authority_contract.mjs` and from Appendix A of the
// MEM00-C2-R1 handoff. Two functions are defined by more than one file with an
// identical signature, so the LAST writer wins:
//
//   public.sophia_memory_review_snapshot     <- 2026_09_09_..._epoch_review
//   public.sophia_memory_inventory_snapshot  <- 2026_09_09_..._epoch_review
//
// In lexical order `epoch_review` sorts BEFORE `review_snapshot` and
// `snapshot_inventory`, so a lexical apply silently overwrites the epoch-aware
// bodies with the older pre-epoch ones. No error is raised and plain
// object-existence witnesses still report success, but the deployed canonical
// review and Pool reads would lose their clear-epoch and source-exclusion
// checks. EI930. See the post-apply invariant check at the end of this file.
//
// Authorization: Davide granted explicit approval to apply these database
// changes on 2026-09-15. This script never prints the token, the connection
// string, or any row contents; it reports only per-file status and object or
// definition-marker presence.
//
// Usage (choose ONE transport):
//   SUPABASE_ACCESS_TOKEN=... node tools/mem00_apply_migrations.mjs --dry-run
//   SUPABASE_ACCESS_TOKEN=... node tools/mem00_apply_migrations.mjs --apply
//   MEM00_DATABASE_URL=postgres://... node tools/mem00_apply_migrations.mjs --apply
//
// MEM00_DATABASE_URL is preferred when available: it reuses an existing
// database credential instead of minting a new account-wide Supabase token.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';

const PROJECT_REF = 'vlxnwmyvhchwbousrdzc';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const MIGRATIONS_DIR = path.resolve('backend/migrations');

// Qualified dependency order. Do not sort this list.
const FILES = [
  '2026_09_08_mem00_c1_owner_authority.sql',
  '2026_09_08_mem00_c1_command_receipts.sql',
  '2026_09_09_mem00_c1_dependency_authority.sql',
  '2026_09_09_mem00_c1_review_snapshot.sql',
  '2026_09_09_mem00_c1_snapshot_inventory.sql',
  '2026_09_09_mem00_c1_source_decision_fence.sql',
  '2026_09_09_mem00_c1_transactional_clear.sql',
  '2026_09_09_mem00_c1_source_intake.sql',
  '2026_09_09_mem00_c1_extraction_dispatch.sql',
  '2026_09_09_mem00_c1_epoch_source_target.sql',
  '2026_09_09_mem00_c1_epoch_review.sql',
  '2026_09_14_mem00_c2_model_authority.sql',
];

// A witness proves THIS file's own effect.
//
// `object` witnesses check existence of a function, relation or trigger that
// only this file creates. `epoch_review` creates no new object — it replaces
// two existing functions — so it uses `marker` witnesses, which assert that a
// string unique to the epoch-aware body is present in the installed
// definition. That is what makes an out-of-order overwrite detectable.
const WITNESS = {
  '2026_09_08_mem00_c1_owner_authority.sql': {object: 'sophia_memory_prompt_owner_authority_fence'},
  '2026_09_08_mem00_c1_command_receipts.sql': {object: 'sophia_memory_lookup_command_receipt'},
  '2026_09_09_mem00_c1_dependency_authority.sql': {object: 'sophia_memory_expire_governed_candidates'},
  '2026_09_09_mem00_c1_review_snapshot.sql': {object: 'sophia_memory_review_snapshot'},
  '2026_09_09_mem00_c1_snapshot_inventory.sql': {object: 'sophia_memory_resolve_provider_hits'},
  '2026_09_09_mem00_c1_source_decision_fence.sql': {object: 'sophia_memory_source_decision_trigger'},
  '2026_09_09_mem00_c1_transactional_clear.sql': {object: 'sophia_memory_source_decision_overlaps'},
  '2026_09_09_mem00_c1_source_intake.sql': {object: 'sophia_memory_source_intake_version_trigger'},
  '2026_09_09_mem00_c1_extraction_dispatch.sql': {object: 'sophia_memory_dispatch_receipt_immutable'},
  '2026_09_09_mem00_c1_epoch_source_target.sql': {object: 'sophia_memory_source_snapshot'},
  '2026_09_09_mem00_c1_epoch_review.sql': {
    marker: [
      ['sophia_memory_review_snapshot', 'acceptance_unproven'],
      ['sophia_memory_inventory_snapshot', 'source_target_at_epoch_aligned'],
    ],
  },
  '2026_09_14_mem00_c2_model_authority.sql': {object: 'sophia_memory_register_builder_handoff'},
};

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';
const databaseUrl = (process.env.MEM00_DATABASE_URL || '').trim();
const token = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();

if (!databaseUrl && !token) {
  console.error('Set MEM00_DATABASE_URL (preferred) or SUPABASE_ACCESS_TOKEN.');
  process.exit(2);
}

// --- transports -------------------------------------------------------------

async function managementQuery(sql) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({query: sql}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {status: response.status, ok: response.ok, rows: Array.isArray(parsed) ? parsed : [], body: parsed};
}

async function makePgQuery() {
  // `pg` ships with the frontend workspace; resolve it from there.
  const require = createRequire(path.resolve('frontend/package.json'));
  const {Client} = require('pg');
  // Supabase requires TLS; a disposable local rehearsal server has none. Honour
  // an explicit sslmode=disable and default to TLS otherwise.
  const sslDisabled = /[?&]sslmode=disable(&|$)/.test(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: sslDisabled ? false : {rejectUnauthorized: false},
    application_name: 'mem00_apply_migrations',
  });
  await client.connect();
  return {
    query: async (sql) => {
      try {
        const result = await client.query(sql);
        const last = Array.isArray(result) ? result[result.length - 1] : result;
        return {status: 200, ok: true, rows: last?.rows ?? [], body: null};
      } catch (error) {
        // Each file is BEGIN..COMMIT; a failure rolls that file back whole.
        return {status: 0, ok: false, rows: [], body: {message: error.message, code: error.code}};
      }
    },
    end: () => client.end(),
  };
}

const transport = databaseUrl ? await makePgQuery() : {query: managementQuery, end: async () => {}};
const query = transport.query;

// --- witnesses --------------------------------------------------------------

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function objectPresent(name) {
  const sql =
    `SELECT (EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace ` +
    `WHERE n.nspname='public' AND p.proname=${quote(name)}) OR ` +
    `EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace ` +
    `WHERE n.nspname='public' AND c.relname=${quote(name)}) OR ` +
    `EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid ` +
    `JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ` +
    `AND t.tgname=${quote(name)})) AS present;`;
  const result = await query(sql);
  if (!result.ok) return `unknown(${result.status})`;
  return result.rows[0]?.present === true ? 'present' : 'absent';
}

// True only when EVERY overload of `fn` that exists contains `marker`, and at
// least one exists. A stale pre-epoch body therefore reads `absent`, which is
// exactly the out-of-order overwrite this check exists to catch.
async function markerPresent(fn, marker) {
  const sql =
    `SELECT count(*) FILTER (WHERE d.def LIKE '%' || ${quote(marker)} || '%') AS hits, ` +
    `count(*) AS total FROM (SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p ` +
    `JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ` +
    `AND p.proname=${quote(fn)}) d;`;
  const result = await query(sql);
  if (!result.ok) return `unknown(${result.status})`;
  const row = result.rows[0];
  if (!row) return 'unknown(no-row)';
  const total = Number(row.total ?? 0);
  const hits = Number(row.hits ?? 0);
  if (total === 0) return 'absent';
  return hits === total ? 'present' : `stale(${hits}/${total})`;
}

async function witnessState(file) {
  const witness = WITNESS[file];
  if (witness.object) return objectPresent(witness.object);
  const states = [];
  for (const [fn, marker] of witness.marker) states.push(`${fn}=${await markerPresent(fn, marker)}`);
  return states.join(' ');
}

// --- apply ------------------------------------------------------------------

const transportName = databaseUrl ? 'postgres' : 'management-api';
console.log(`MEM00 migration application — mode=${mode} project=${PROJECT_REF} transport=${transportName}`);
console.log('order=qualified-dependency (NOT lexical)\n');

let failures = 0;
for (const file of FILES) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  const before = await witnessState(file);
  if (mode === 'dry-run') {
    console.log(`${file}  witness_before=[${before}]  bytes=${sql.length}  (dry-run, not applied)`);
    continue;
  }
  const result = await query(sql);
  const after = result.ok ? await witnessState(file) : 'not-checked';
  console.log(`${file}  http=${result.status} before=[${before}] after=[${after}]`);
  if (!result.ok) {
    failures += 1;
    console.error(`  error: ${JSON.stringify(result.body).slice(0, 400)}`);
    console.error('  stopping: later files depend on this one.');
    break;
  }
}

// Post-apply invariant: the two multiply-defined functions must carry the
// epoch-aware bodies. This is the check that fails loudly if the files are ever
// applied in lexical order again, by this script or by hand.
if (mode === 'apply' && failures === 0) {
  console.log('\nfinal ordering invariant (epoch bodies must be the last writers):');
  for (const [fn, marker] of WITNESS['2026_09_09_mem00_c1_epoch_review.sql'].marker) {
    const state = await markerPresent(fn, marker);
    console.log(`  public.${fn}: ${state}`);
    if (state !== 'present') {
      failures += 1;
      console.error(`  INVARIANT VIOLATED: ${fn} is not the epoch-aware body. Re-apply 2026_09_09_mem00_c1_epoch_review.sql last.`);
    }
  }
}

await transport.end();
console.log(failures === 0 ? '\nALL FILES OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
