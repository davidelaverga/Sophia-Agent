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

## 3. Prerequisites — all verified present, 2026-09-17 refresh

Re-measured directly against production. Every dependency `epoch_review` calls
exists, with the exact signature it expects:

| function | identity arguments | present |
| --- | --- | --- |
| `sophia_memory_source_snapshot` | `(p_user_id text, p_session_id text, p_thread_id text)` | **yes** |
| `sophia_memory_run_source_valid` | `(p_user_id text, p_session_id text, p_start bigint, p_end bigint, p_dependencies jsonb)` | **yes** |
| `sophia_memory_run_input_valid` | `(p_user_id text, p_session_id text, p_context jsonb, p_input_ref text)` | **yes** |
| `sophia_memory_source_fenced` | `(p_user_id text, p_session_id text)` | **yes** |

The last two were listed as *assumed* in the first draft of this manifest. They
are now confirmed, so the `42883` failure mode that stopped `epoch_review` during
the lexical run cannot recur for these dependencies.

## 4. Baseline to compare against — recorded 2026-09-17

Current definition hashes and privileges, to be re-read after the repair:

| function | `def_md5` before | service_role | authenticated | anon |
| --- | --- | --- | --- | --- |
| `sophia_memory_review_snapshot` | `052aa245ddb00a01acada5c90046c2a2` | **true** | false | false |
| `sophia_memory_inventory_snapshot` | `b7ec2a0f39b2968d81196c5632728c21` | **true** | false | false |
| `sophia_memory_source_snapshot` | `8b9f06a0f86d8999b7fbaaafc658401b` | false | false | false |
| `sophia_memory_run_source_valid` | `80506bd04f1b4def0a296b9d70e5eb57` | false | false | false |
| `sophia_memory_run_input_valid` | `8f1d6cd28aa9715c6509818495f09239` | false | false | false |
| `sophia_memory_source_fenced` | `abb2ba8d431d6cc31e100d768f74534d` | false | false | false |

### CORRECTION — this repair REMOVES a live grant, intentionally

The first draft of this manifest said `service_role` execution on
`review_snapshot` and `inventory_snapshot` "should already be false" and told the
operator to **stop** if either read true. Both read **true**. That stop-condition
was written on a wrong assumption and is withdrawn; it does not block the repair.

The reason they are granted is that the currently applied pre-epoch files —
`..._review_snapshot.sql` and `..._snapshot_inventory.sql` — each `GRANT EXECUTE
… TO service_role`. `epoch_review` instead ends with
`REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`. So applying it
moves both from `true` to `false`.

**That is the intended end state**, not a regression: C2 requires application
execution to stay revoked until the reviewed activation step grants it narrowly.
The corroborating evidence is the disposable rehearsal, where after applying all
twelve files in the qualified order exactly 10 of 162 (function, role) pairs held
EXECUTE and neither of these two was among them.

**Consequence the operator must accept:** after this repair, any caller invoking
`sophia_memory_review_snapshot` or `sophia_memory_inventory_snapshot` as
`service_role` will receive `42501` until the C2 activation step grants them.

Assessed exposure today: **none observed.** Those RPCs are reached through the
Gateway only after `_memory_flags(user_id)` resolves, and production currently
has **0 owners with `authority_state='governed'`** (1 governance row total), so
`resolved_memory_flags_for_owner` raises for every user and the route returns 503
before touching them. That is an inference from the resolver contract plus the
measured owner count, not a traffic measurement — it is the reason to do this
while the pilot is closed rather than after activation.

### Backup observation — refreshed 2026-09-17

Daily `PHYSICAL` scheduled backups, 8 retained (10–17 Sep 2026). Most recent:
**17 Sep 2026 10:43:40 (+0000)**. Point-in-time restore is available on this plan.

Note the ordering: that backup predates the `source_intake` apply described in
§5. Restoring it would roll back `source_intake` as well as anything after it, so
it is a recovery floor, not a targeted undo for this operation.

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
