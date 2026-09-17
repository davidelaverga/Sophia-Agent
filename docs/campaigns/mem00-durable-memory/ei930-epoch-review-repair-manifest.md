# EI930 — `epoch_review` production repair manifest

**Status:** prepared for human approval or direct administrator execution.
**Prepared:** 2026-09-17. **Not executed by the agent** — loading this file into
the SQL editor was refused by the local permission classifier, and that refusal
is respected rather than worked around.

This is the *only* remaining database operation in the EI930 repair.
`2026_09_09_mem00_c1_source_intake.sql` already succeeded (see §5) and **must not
be repeated**. Do **not** run a full-batch or fresh-install migration runner
against this partially repaired database.

---

## 1. Target

| field | value |
| --- | --- |
| Provider / project ref | Supabase, `vlxnwmyvhchwbousrdzc` |
| Environment | **production** (`main`, marked PRODUCTION in the dashboard) |
| Engine | PostgreSQL **17.6** (observed via PostgREST log) |
| Candidate commit | `c5e64774dbf733ae20bacc834a4af573528df75e` (published pilot head) |
| File | `backend/migrations/2026_09_09_mem00_c1_epoch_review.sql` |
| Size | 24,578 bytes, 316 lines |
| SHA-256 | `1e4b7f2e87dd0414b21133ac728936dfe389d0d4cb11a706d31552b1fa8a460a` |

The SHA-256 was **recomputed from the pinned candidate bytes**, not taken from a
prior report: `git show c5e64774:backend/migrations/2026_09_09_mem00_c1_epoch_review.sql | shasum -a 256`.
It is identical at the published head `c5e64774`, at the local pilot head
`056ae9ba`, and in the working tree, so the file is unchanged since publication
and can be reviewed on GitHub at the published commit.

Verify before executing:

```bash
git -C "/Users/davidelaverga/Documents/Codex/2026-08-19/pl/work/Sophia-Agent-mem00-c2" show c5e64774:backend/migrations/2026_09_09_mem00_c1_epoch_review.sql | shasum -a 256
```

## 2. Why this operation

The lexical-order defect (EI930) was executed against this database before
2026-09-17. `epoch_review` failed with `42883` at that time because it sorts
*before* `epoch_source_target`, which creates its dependency. The other files
committed. Production therefore serves the **pre-epoch** bodies of
`sophia_memory_review_snapshot` and `sophia_memory_inventory_snapshot`, without
their clear-epoch and source-exclusion checks.

No deployed code calls those two functions today, so this is **latent, not
actively harmful**. It is nonetheless a prerequisite for any pilot activation and
should not be left half-applied.

This operation does **not** address the live error storm. That is the Gateway
hotfix (§6), which is independent of this approval.

## 3. Prerequisites — all verified present in production

`epoch_review` replaces two functions and depends on objects created earlier.
Read-only verification on 2026-09-17 showed:

| prerequisite | created by | production state |
| --- | --- | --- |
| `sophia_memory_source_snapshot` | `..._epoch_source_target.sql` | **present** |
| `sophia_memory_source_decision_overlaps` | `..._transactional_clear.sql` | **present** |
| `sophia_memory_run_source_valid` | `..._dependency_authority.sql` | **present**, and now carries `MEM00_C1_EXACT_ACCEPTED_SOURCE_VERSION` |
| `sophia_memory_source_fenced` | base / C1 | assumed present — **re-assert in §4** |
| `sophia_memory_run_input_valid` | C1 | assumed present — **re-assert in §4** |
| `sophia_memory_review_snapshot` | `..._review_snapshot.sql` | present, **pre-epoch body** |
| `sophia_memory_inventory_snapshot` | `..._snapshot_inventory.sql` | present, **pre-epoch body** |

`sophia_memory_source_intake_version_trigger` and
`sophia_memory_accept_source_action` are also present following §5.

## 4. Record current state BEFORE applying

Run this read-only query first and keep the output. It is the comparison
baseline, and it re-asserts the two prerequisites not yet directly confirmed.

```sql
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       md5(pg_get_functiondef(p.oid))            as def_md5,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role_exec,
       has_function_privilege('authenticated',  p.oid, 'EXECUTE') as authenticated_exec,
       has_function_privilege('anon',           p.oid, 'EXECUTE') as anon_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('sophia_memory_review_snapshot','sophia_memory_inventory_snapshot',
                    'sophia_memory_source_snapshot','sophia_memory_run_source_valid',
                    'sophia_memory_run_input_valid','sophia_memory_source_fenced')
order by p.proname;
```

**Stop and re-plan if** `sophia_memory_source_snapshot`,
`sophia_memory_run_input_valid` or `sophia_memory_source_fenced` is missing —
`epoch_review` would fail `42883` again.

**Expected, and important:** `service_role_exec` for `review_snapshot` and
`inventory_snapshot` should already be **false**. Their own migrations revoke
application execution. If either currently reads **true**, stop — applying
`epoch_review` would remove a grant something may depend on, which needs review
before proceeding.

Backup reference: the dashboard reported **LAST BACKUP 5 hours ago** as of
2026-09-17 ~17:40 local. Confirm a current backup exists before executing.

## 5. Already applied — do NOT repeat

`2026_09_09_mem00_c1_source_intake.sql` was applied on 2026-09-17 and verified.
Its drift guard was satisfied beforehand (`sophia_memory_run_source_valid` md5
was the expected pristine `0d447ef95ed420e824d66bdc22380d69`) and the editor
content was verified byte-exact by SHA-256 (`1f80ebf3…bfae01`, 12,396 bytes)
before running. Result: `Success. No rows returned`.

Post-verification: `sophia_memory_source_intake_version_trigger` present,
`sophia_memory_accept_source_action` present, and `sophia_memory_run_source_valid`
now contains `MEM00_C1_EXACT_ACCEPTED_SOURCE_VERSION`.

Re-running it is **not** a no-op in the sense that matters: its `DO $migration$`
block would find the predicate already patched and skip, which is safe, but there
is no reason to run it again.

## 6. Execution

Apply the file **whole and unchanged**, as a single transaction. It already
contains `BEGIN;` … `COMMIT;`.

- Do **not** split, chunk, re-encode or reformat it.
- Do **not** edit any already-applied migration.
- Stop on the first error and report the real transaction outcome — a failure
  inside the transaction rolls the whole file back, so a partial apply is not
  expected, but the reported outcome must be the actual one.

Supabase will show a "destructive operations" warning; that is its heuristic
reacting to `CREATE OR REPLACE` and `REVOKE`. The file is additive and
transactional.

Either route is acceptable:

- **SQL editor:** paste the whole file, confirm the warning, run.
- **psql:** `psql "$CONNECTION_STRING" -v ON_ERROR_STOP=1 -f backend/migrations/2026_09_09_mem00_c1_epoch_review.sql`

## 7. What it changes

Two `CREATE OR REPLACE FUNCTION` statements with **identical signatures** to the
existing ones, so these are replacements, not new overloads:

- `public.sophia_memory_review_snapshot(text,text,bigint,text,jsonb,text,uuid,integer)`
- `public.sophia_memory_inventory_snapshot(text,text,text,text,integer)`

Plus `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` on both, and
`NOTIFY pgrst,'reload schema'`.

**ACL effect, intended:** execution stays revoked for every application role,
including `service_role`. That is deliberate. Narrowly scoped application grants
belong to the reviewed C2 activation step — **never** `GRANT ALL`, and not part
of this repair.

No table, column, index, trigger, row or user data is touched.

## 8. Assertions AFTER applying

```sql
select 'review_snapshot'   as fn,
       count(*) filter (where pg_get_functiondef(p.oid) like '%acceptance_unproven%') as epoch_marker,
       count(*) as overloads,
       bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')) as service_role_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and p.proname='sophia_memory_review_snapshot'
union all
select 'inventory_snapshot',
       count(*) filter (where pg_get_functiondef(p.oid) like '%source_target_at_epoch_aligned%'),
       count(*),
       bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE'))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and p.proname='sophia_memory_inventory_snapshot';
```

Pass criteria:

| assertion | expected |
| --- | --- |
| `epoch_marker` = `overloads` for both rows | **yes** (currently 0 of 1 for each) |
| `overloads` = 1 for both | **yes** — more than one means an unintended overload |
| `service_role_exec` | **false** for both — revoked on purpose |
| schema cache | PostgREST logs a reload, from the file's `NOTIFY` |

A marker at 1/1 proves the **definition** landed. It does not prove the function
is usable or authorized for serving; execution remains revoked until the C2
activation step grants it deliberately.

## 9. Ledger

Supabase's own migration history shows **"No migrations"** — this project's
schema was not applied through the Supabase CLI, so there is no CLI history to
reconcile and none should be fabricated. Record the repair in this campaign's
release record instead. Do not mark anything "applied" merely to change a count.

## 10. Explicitly out of scope

- Any `GRANT` to `anon`, `authenticated` or `service_role`.
- Restoring execution on the revoked legacy `sophia_memory_expire_candidates`.
- Disabling row-level security, governance flags, cohort settings or recall.
- Pilot activation, which remains closed and still requires receiving
  authorization, grants, consumer isolation, a compatible deployment and the
  single hosted C2 journey.
