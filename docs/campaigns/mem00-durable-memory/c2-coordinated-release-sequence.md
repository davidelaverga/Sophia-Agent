# MEM00-C2 coordinated release sequence

**Status:** prepared, not started. Every step below is gated, and the gates are
named. Nothing in this document is authorization to perform any of it.

This replaces the paragraph-form "still required before the hosted journey" note
with an ordered sequence, because the steps are no longer independent: two of
them must land together, one is another owner's, and the last one needs an
authority nobody in this campaign holds.

The two subjects this campaign keeps **out** of this sequence remain out:
**provider obligations** (historical, preserved as-is, cleanup scope unchanged)
and the **fault-injection RPC permissions** (`arm_fault`, `consume_fault`,
`clear_faults` hold `service_role` EXECUTE; a separate least-privilege question,
never bundled into an activation grant).

---

## Where the gates actually stand

| gate | state |
| --- | --- |
| Pilot branch tests | **green** — measured with the venv on `PATH` as `uv run` sets it |
| Pilot branch `ruff check .` | **green** — 0 errors |
| Shared baseline tests | **green** — 6,227 passed / 0 failed |
| Shared baseline `ruff check .` | **22 errors**, all Voice Lab's — fix prepared on `codex/voice-lab-lint-hygiene` |
| Serving grants | reviewed, signature-pinned, **unapplied** |
| Receiving authentication | built and tested, **not installed**; `langgraph.json` has no `auth` key |
| Non-cohort cutover | resolved in code; every account is still undeclared and 0 owners are governed |
| Davide's account | **not declared**, not in the cohort, no flags on |

**Withdrawn from the defect backlog:** the two `test_local_sandbox_encoding`
cases. They were a measurement error of mine (`python` vs `python3` on `PATH`),
not a code defect; see `c2-shared-baseline-lint-coordination.md` §1. Every
measurement in this sequence uses the corrected invocation.

## Step 0 — Voice owner's decisions (blocks steps 2 and 3)

From [`c2-receiving-auth-cross-owner-coordination.md`](./c2-receiving-auth-cross-owner-coordination.md):

1. A non-owner `maintenance` scope for Voice Lab's cleanup and reaper paths.
   **Built**, and eligibility is now bound to the cleanup fence rather than to
   client metadata.
2. Its exact route list. **Built** as thread search / read / delete and run
   list / read / cancel — no run creation, no `/state`, `/history` or `/copy`.
3. Whether deck-quality shares that scope. **Built as a separate one**, because
   dispatch creates runs and retention must not.
4. Whether the Voice Lab principal refusal stays absolute. **Narrowed, not
   dropped** — step 0a. The one that needs a decision rather than a review.
5. ~~Which identity owns the companion run during a Voice Lab test.~~
   **Closed.** Both work: an ordinary parent owner and the test principal itself.

### Step 0a — the substantive ask, and its acceptance record

The contract, the evidence and the signature block are in
[`c2-step-0a-acceptance.md`](./c2-step-0a-acceptance.md). Summary: the
configured Voice Lab principal is admitted for **authorized, reservation-bound
synthetic Builder work only**; ordinary companion, memory, unreserved and
cross-owner access stay refused.

The campaign sponsor supports this in principle (recorded verbatim in §3 of that
file). **The Voice owner's acceptance (§4) is still blank, and step 2 is gated
on §4, not on §3.**

### Step 0b — permission-gated synthetic acceptance setup

Acceptance is a decision; this is what has to be *configured* for that decision
to mean anything once authentication is installed. Each item is dashboard-managed
(`sync: false`) and therefore invisible to this repository — each must be
**verified present before step 2 deploys**, not assumed.

| setting | service | why step 2 needs it |
| --- | --- | --- |
| `SOPHIA_VOICE_LAB_TEST_PRINCIPAL` | `sophia-langgraph` | `voice_lab_principal()` reads it. If it is empty, **nothing** is ever eligible for the synthetic lane and Voice Lab's Builder returns to a flat 403 — the exact failure step 0a exists to avoid. It is already declared on `sophia-gateway` and `sophia-voice`; all three must carry the **same** value. |
| `SOPHIA_VOICE_LAB_AUTH_DATABASE_URL` | `sophia-langgraph` | the cleanup fence lives there. `_reserved_builder_admission` fails **closed** on an unreachable fence, so an unset or unroutable value denies every synthetic Builder thread rather than admitting one. |
| `SOPHIA_MEMORY_REFERENCE_HMAC_SECRET` | `sophia-langgraph` | the owner label is `keyed_ref("langgraph-access-owner", …)`, an HMAC under this secret. Unset, `_filter` raises and every thread operation returns **503**. **Rotating it** after install re-keys the label, so threads created under the old value become invisible to their owner — a rotation is therefore a thread-draining operation, not a config edit. |

Explicitly **not** part of this setup: `SOPHIA_VOICE_LAB_ENABLED` stays `false`
and `SOPHIA_VOICE_LAB_KILL_SWITCH` stays `true`. Step 0a is about what the
policy permits, never about turning the lab on.

## Step 1 — shared baseline lint (independent, any time)

**Opened as [PR #146](https://github.com/davidelaverga/Sophia-Agent/pull/146)**
(`codex/voice-lab-lint-hygiene` → `codex/sophia-observability-v1`, 1 commit, 3
files, able to merge). Merge it, or the Voice owner's preferred equivalent. See
[`c2-shared-baseline-lint-coordination.md`](./c2-shared-baseline-lint-coordination.md),
which also carries the review request and the PR link.
Until this lands, `make lint` fails on the merged line and CI never reaches
`make test` — so this gates *any* PR on that line, not only this campaign's.

## Step 2 — receiving authentication install (needs steps 0a and 0b)

> **COUPLING, measured in production 2026-09-19: step 2 is not optional once the
> MEM00-C2 runtime is deployed, and it cannot be sequenced after step 4.**
>
> `final_dispatch_authority` compares
> `configurable["langgraph_auth_user_id"]` against the owner on **every**
> undeclared owner's request — which today is every request, since 0 accounts
> are governed. **Nothing in this codebase ever sets that field.** The LangGraph
> server injects it from the auth context, and only when this entry exists.
>
> Deploying the MEM00-C2 runtime to `sophia-langgraph` *without* this entry
> therefore denied model dispatch for **every user**
> (`ModelDispatchDenied`), with no run reaching the graph at all. Steps 2 and 4
> must land together on that service.
>
> The unit tests do not catch this: `test_mem00_noncohort_model_entry.py`
> supplies `langgraph_auth_user_id` itself, because it is standing in for the
> authenticated server. The test is correct; it simply cannot observe the
> configuration in which the field is absent. `test_render_config.py` now pins
> the entry and carries this reason.

One change, two files, and it must land with the callers in the same commit:

- `backend/langgraph.json` — add the `auth` entry pointing at
  `deerflow/sophia/langgraph_auth.py:auth`.
- `backend/tests/test_render_config.py:96` — the `assert "auth" not in config`
  that currently pins its absence.
- The four caller sites are **already migrated** and are inert until this lands:
  they enter their lane, the credential is minted, and an uninstalled server
  ignores the header.

Splitting this is the failure mode: installing without the callers returns 401
to Voice Lab retention cleanup and deck-quality dispatch; migrating without
installing does nothing.

## Step 3 — serving grants (needs step 2's decision, not its deploy)

`backend/migrations/2026_09_17_mem00_c2_serving_grants.sql`, unchanged since
`73c69bad`. EXECUTE only, `service_role` only, 21 frozen type-only signatures,
with signature/overload drift checks and a set-equality assertion. Rehearsed
0/21 → 21/21, total 25 → 46, idempotent, all four guards proven non-vacuous.

Ordered after step 2's decision because granting serving access before the
receiving boundary is authenticated widens the surface for longer than
necessary, not because the SQL depends on it.

## Step 4 — deployment

### 4.0 Where production actually is right now

Read from the Render deploy lists and the Vercel API on 2026-09-18, not from
the campaign's older notes, which were wrong about the Gateway:

| component | deployed commit | trigger | age |
| --- | --- | --- | --- |
| `sophia-gateway` | **`8c5cf538`** — the shared baseline | Manual | 23h |
| `sophia-langgraph` | `35c6467c` | Manual | 4d |
| `sophia-voice` | `35c6467c` | API | 4d |
| frontend (Vercel `sophia-agent-front`, team **Sophia**) | `35c6467c`, branch `codex/sophia-observability-v1` | promoted | 2026-09-14 |

**Production is already a split**, and that is the starting state this sequence
has to deploy from: the Gateway is four days ahead of everything else, on the
shared baseline. Earlier records naming `0c215c1b` as the Gateway pin describe
the deploy *underneath* the current one.

Still true, and the thing that matters most: **no deployed component carries any
MEM00-C2 commit.**

### 4.1 What each component is, exactly

| component | disposition | exact build |
| --- | --- | --- |
| **`sophia-langgraph`** (Render, docker, `autoDeployTrigger: off`) | **changes** — carries the MEM00 governance, the dispatch lanes and, after step 2, the `auth` entry | exact-commit manual deploy of the qualified successor; `backend/Dockerfile.langgraph`, `dockerContext: .` |
| **`sophia-gateway`** (Render, docker, `autoDeployTrigger: off`) | **changes** — routes, workers, session/recap paths | exact-commit manual deploy of the same SHA; `backend/Dockerfile.gateway` |
| **`sophia-voice`** (Render, docker, `autoDeployTrigger: off`) | **unchanged, and no change is necessary** — see 4.3 | do not redeploy |
| **frontend** (Vercel, `rootDirectory: frontend`) | **changes** — 49 non-test files under `frontend/src` | see 4.2 |

### 4.2 The exact compatible Next.js frontend build

The frontend is **not** optional here. The pilot changes 49 non-test files under
`frontend/src`: the memory API routes (`/api/memories/**`, `/api/memory/**`,
`/api/journal`, `/api/sessions/**`, `/api/sophia/sessions/[id]/recap`), the chat
route's memory authority and stream transformers, the recap views and store, and
the session orchestration hooks. A backend at the successor SHA with a frontend
at the currently deployed commit is a **mixed pair**, not a partial rollout.

| item | value |
| --- | --- |
| project | `sophia-agent-front`, Vercel team **Sophia** (`sophia-30911edf`), linked to this repository |
| source | the qualified integration successor, same SHA as the backend services |
| root directory | `frontend` (project setting, matching `vercel.json`) |
| install | `pnpm install --frozen-lockfile` |
| build | `pnpm build` → `next build`, output `.next` |
| package manager | **pnpm 10.26.2**, pinned by `packageManager` in `frontend/package.json` and by the e2e workflow |
| Node | **Vercel builds on 24.x** (read from the project settings). The `memory-highlights-e2e` workflow pins **22**, and this repo declares no `engines` field, so nothing reconciles the two — CI e2e and production already build on different majors. Worth closing, separately from this release |
| resolved versions | `next@16.2.2`, `react@19.2.4`, `react-dom@19.2.4`, `vitest@2.1.9`, lockfile version 9.0 — the exact resolutions `--frozen-lockfile` reproduces, not the `^16.1.7` range in `package.json` |
| dependency change | **none.** `frontend/package.json` and `frontend/pnpm-lock.yaml` are byte-identical to the shared baseline |

Because no dependency moved, the frontend build is a *source* change only: no
lockfile migration, no framework upgrade, and no Vercel project setting needs to
change.

**How it actually reaches production.** The project's production branch is set
to `main`, yet every live production deployment was built from
`codex/sophia-observability-v1`. So production is reached by **promoting a
deployment**, not by pushing a branch — and the promotion is the step to plan,
because changing the production-branch setting instead would make the next
`main` push deploy itself.

**Built locally, with its deviations named.** `next build` on the pilot tree:
compiled, TypeScript passed, 61 static pages generated across 119 routes, no
build error. Deviations from the Vercel build, each of them real: Node **24** on
this machine against CI/Vercel's 22; dependencies from the existing
`node_modules` (which match the lockfile resolutions exactly) rather than a
fresh `--frozen-lockfile` install, because `pnpm` is not present here; and
placeholder `DATABASE_URL`/`BETTER_AUTH_*` values, without which page-data
collection for `/api/test-auth/login` aborts the build — Vercel supplies the
real ones. So this is evidence the source compiles and type-checks at this SHA,
**not** a reproduction of the production build.

### 4.3 Voice service disposition

`git diff 8c5cf538...<pilot head> -- voice/` is **empty**. The Voice service
needs no change and must not be redeployed as part of this sequence. Its live
pin stays where it is (`35c6467c`, Voice Lab disabled, kill switch engaged).

Two indirect couplings exist and neither requires a Voice deploy:

- Voice reads `SOPHIA_MEMORY_SUPPORTED_CONTRACT_EPOCH=1`, which this release does
  not change.
- Voice Lab's synthetic Builder path runs **inside** `sophia-langgraph`, so
  step 0a affects Voice Lab's behaviour without touching the Voice image. That
  is precisely why the acceptance is the Voice owner's.

### 4.4 Intended runtime versions

Resolved from `backend/uv.lock`, which the images build from:

| package | version |
| --- | --- |
| Python | 3.12 (`langgraph.json`, CI `setup-python@v6`) |
| `langgraph` | 1.2.0 |
| `langgraph-api` | 0.8.1 |
| `langgraph-cli` | 0.4.14 |
| `langgraph-sdk` | 0.3.9 |
| `langgraph-checkpoint-postgres` | 3.1.2 |
| `langgraph-runtime-inmem` | 0.28.0 (tests only) |
| `fastapi` / `starlette` | 0.128.0 / 0.50.0 |

`langgraph-api` **0.8.1 is the version whose custom-auth contract the policy is
written against**: `@auth.on.threads.*`, metadata filters as the containment
mechanism, and `create_run` receiving the value it will act on. The live
LangGraph pin is already 0.8.1, so step 2 does not move it. A `langgraph-api`
upgrade is out of scope for this release and must re-run
`test_mem00_langgraph_lane_runtime.py` before it lands, because that file is the
only place the framework's actual application of the policy is checked.

### 4.5 Ordering, and what is safe in between

Deploys are not atomic across four components, so each intermediate pair has to
be safe. It is, under these constraints:

1. **Grants (step 3) before or after either service** — safe either way. Every
   `SOPHIA_MEMORY_*` availability flag is `false` and no account is governed, so
   nothing calls the newly granted functions. Granting EXECUTE changes no
   behaviour on its own.
2. **Gateway before LangGraph.** The Gateway↔LangGraph contract in this release
   is unchanged apart from authentication, and the migrated callers send a
   credential an uninstalled server ignores. So new Gateway → old LangGraph is
   safe; the reverse is what must not linger, because after step 2 LangGraph
   requires credentials that only the new Gateway mints.
3. **Frontend last, or alongside the Gateway.** The new frontend routes call
   Gateway endpoints that exist in this release; an old frontend against the new
   Gateway keeps working because the backend changes are additive on those
   paths. New frontend against old Gateway is the unsafe direction.
4. **Never set a `SOPHIA_MEMORY_*` flag before `SOPHIA_MEMORY_COHORT_PRINCIPALS`
   is set.** `configured_memory_feature_flags_for_owner` raises
   `memory_features_without_cohort` when any flag is on and the cohort is empty —
   on **every** request, for every user. This is the single most dangerous
   intermediate state in the sequence and it belongs to step 6, not step 4.
5. **Voice is not in the ordering** (4.3).

### 4.6 Existing-resource compatibility

What already exists in production when this deploys, and what happens to it:

- **The C1/C2 schema is APPLIED, not unapplied.** An earlier version of this
  document said "the twelve C1/C2 migrations are unapplied except the EI930
  repair". Measured in production on 2026-09-18:

  ```sql
  select count(*) as total_fns,
         count(*) filter (where has_function_privilege('service_role', p.oid, 'EXECUTE')) as sr_granted,
         count(*) filter (where not has_function_privilege('service_role', p.oid, 'EXECUTE')) as sr_missing
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'sophia_memory%';
  ```

  | total_fns | sr_granted | sr_missing |
  | --- | --- | --- |
  | 76 | 25 | 51 |

  76 `sophia_memory*` functions exist. What is outstanding is the **serving
  grants**, and `sr_granted = 25` is exactly the "total 25" pre-state the grant
  rehearsal recorded before going 25 → 46. Production and the rehearsal baseline
  agree, which is the confirmation step 3 needed and did not have.

  (The dashboard's `LAST MIGRATION: No migrations` means only that the Supabase
  CLI migration table is empty — everything here was applied by hand through the
  SQL editor, as the EI930 repair was.)

  The schema is forward-compatible: `authority_state` defaults to `'unknown'`,
  so every existing row reads as *undeclared*, which is the state the non-cohort
  work was built for.
- **Existing ordinary sessions and recaps keep working.** The non-cohort repairs
  make session end, idle finalization, recap read/write and deletion usable for a
  definitely-undeclared owner. A missing MEM00 credential no longer selects
  all-off behaviour in a deployment, so an existing protected recap stays
  protected instead of degrading to an unvalidated local read.
- **Existing Voice Lab cleanup obligations remain valid.** The policy consults
  the fence's own `cleanup_admission_authorized` rather than reimplementing it,
  so an obligation opened before the deploy is judged by the same rule
  afterwards. Reservations are per-thread and short-lived; there is no migration
  of in-flight admissions.
- **Existing LangGraph threads at step 2 — continuity and cleanup, specified.**
  Threads created before the `auth` entry exists carry no server-issued
  `sophia_authenticated_owner_v1` label. The filter `owned_thread` returns
  matches only on that label, so after install:

  | thread | what happens | what to do |
  | --- | --- | --- |
  | ordinary companion/Builder thread, pre-install | invisible to its owner (404), because no owner label exists to match | nothing: these are working threads, and the product creates a new one per session. No user-visible durable record lives only here — recaps and sessions are in Supabase, not in thread state |
  | in-flight Builder run, pre-install | the run continues server-side; the parent companion cannot read its thread afterwards, so its completion event is the delivery path | drain before install: deploy step 2 when no Builder run is in flight |
  | synthetic Voice Lab thread, pre-install | same 404, **and** its cleanup-fence reservation is unaffected — the fence is in Postgres, not in thread metadata | the retention reaper cleans by cleanup-obligation id, not by thread read, so cleanup still completes. Verify with the run/lease check below |
  | threads created after install | carry the label; normal | — |

  **Cleanup is therefore not at risk, but visibility is**, and the two are worth
  keeping apart: nothing becomes unreclaimable, some things become unreadable.
  The campaign's existing pre-deploy guard already covers the synthetic side —
  query Voice Lab run/lease state immediately before deploying and do not deploy
  while a run is active or a cleanup is incomplete.

  There is no migration of pre-install threads, and none is proposed: labelling
  them retroactively would mean minting ownership for threads whose authenticated
  owner was never recorded, which is precisely what the label exists to prevent.
- **Artifacts, sessions and the Supabase buckets are untouched.** No bucket,
  object key or registry shape changes in this release.

### 4.7 Safe rollback

Per component, in the order you would actually use them:

**The governing rule: durable authority is never rolled back.** Availability is
reversible; ownership is not. `sophia_memory_declare_owner_authority` is a
receipted state transition that refuses `p_expected_state = p_target_state`, and
refuses `p_target_state = 'legacy'` outright once the owner has any canonical
history (`memory_owner_has_canonical_history`). So after the pilot has written a
single memory, **there is no declaration that returns the account to its prior
state** — attempting one is not a rollback, it is a new and probably rejected
declaration. Every phase below therefore rolls back *availability*, and leaves
`authority_state = 'governed'` and its receipts standing.

| phase | rollback | what is deliberately NOT reversed |
| --- | --- | --- |
| **4 — frontend** | redeploy the previous Vercel production deployment (`35c6467c`) by promoting it. No data shape changed, so this is a pure revert. | — |
| **4 — Gateway / LangGraph** | exact-commit manual deploy of the previous SHA — Gateway `8c5cf538`, LangGraph `35c6467c`. `autoDeployTrigger: off` means nothing else moves. | the applied schema. It is additive and is never dropped. |
| **2 — receiving auth** | remove the `auth` entry from `langgraph.json` and redeploy LangGraph. The four callers are inert against an unauthenticated server and need no revert. Threads created *while* auth was installed keep their owner label; it simply stops being consulted. | the owner labels already written. They are inert, not wrong. |
| **3 — serving grants** | `REVOKE EXECUTE` on the 21 named signatures, returning `service_role` to the measured pre-state of **25** granted. Nothing calls them while the flags are off, so the revoke is not racing a caller. | the other 25. They predate this campaign. |
| **6a — flags** | set `SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE` and `SOPHIA_MEMORY_GOVERNED_RUNTIME_READ` to `false` on **both** services. The governance worker is not rebuilt, so extraction stops at the next boot. **This is the fast, complete stop** — a governed owner with all availability off reads and writes nothing. | everything else. |
| **6b — cohort** | only after 6a: clear `SOPHIA_MEMORY_COHORT_PRINCIPALS`. Doing this *before* 6a re-enters `memory_features_without_cohort` (every request, every user) and, if a flag is still on, `memory_certification_principal_not_in_cohort` at the next boot — which is a Gateway that will not start. | — |
| **6c — the declaration** | **nothing.** `authority_state` stays `governed`, the receipts stay, the canonical rows stay. A governed owner with no availability is exactly the safe resting state, and it is reversible in the direction that matters: turning the flags back on restores the pilot without re-declaring anything. | the declaration, permanently and by design. |

The order is `6a → 6b`, never the reverse, and `6c` is not a step. If the pilot
has to be abandoned rather than paused, the correct end state is still a governed
owner with availability off — not an attempt to un-declare, which the database
will refuse and which would destroy the audit trail the declaration exists to
provide.

The campaign's existing rollback invariants still hold and are not restated
here: unknown database/provider state fails closed, provider deletion is not
canonical deletion, and a canonical tombstone fences admission before any purge
(`rollout-and-rollback.md`).

## Step 5 — the single hosted C2 lifecycle

One journey, hosted, on the deployed candidate. Not a certification campaign and
not a re-run of the suite: the one lifecycle C2 has always specified.

Precondition the campaign already requires: query Voice Lab run/lease state
immediately before deploying, and do not deploy while a run is active or a
cleanup is incomplete.

## Step 6 — Davide's account activation (separate authority; **not** omitted)

This step needs an authority nobody in this campaign holds, which is a reason to
write it down precisely, not a reason to leave it out. It is three operations,
in this order, and the order is load-bearing:

1. **Declare the owner.** Call the C1 owner-authority declaration RPC for
   Davide's exact authenticated application owner id, with
   `expected_state='unknown'`, `target_state='governed'`, `contract_epoch=1`, and
   an `approval_ref` naming this authorization. The function refuses a
   mismatched expected state (`memory_owner_declaration_conflict`) and refuses to
   classify an account that already has canonical history, so it cannot be run
   speculatively.
2. **Set `SOPHIA_MEMORY_COHORT_PRINCIPALS` to TWO ids** — Davide's, *and* the
   configured `SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL` — on both
   `sophia-langgraph` and `sophia-gateway`. Identical values; a per-service
   mismatch produces a user who is governed on one path and not the other.
   Davide's id alone makes the Gateway **fail to boot** at the next step; see
   "Why the certification principal has to be in that list" in the appendix.
3. **Set the text-pilot availability flags** on both services, and only then —
   see 4.5 item 4. This selects an **extraction-only** worker;
   `SOPHIA_MEMORY_PROVIDER_PROJECTION` stays `false`, so no Mem0 projection
   adapter is constructed. See "Which worker the text pilot actually selects".

Verification required before calling it done, and this is the part earlier
records got wrong: join a fresh **signed-in ordinary product request** to its
timestamped Gateway route and its exact Better Auth owner, and compare that
owner against the cohort value in evidence. A UI save click, a guessed UUID
alias, or an empty legacy response does not satisfy it (EI-078/EI-079).

`resolved_memory_flags_for_owner` forces `candidate_ledger_read` and
`canonical_pool_read` on for a governed owner regardless of environment, so
canonical management is routed to the ledger even if the availability flags are
conservative. Activation cannot be half-done in that direction.

## Step 7 — authorized handover to Davide

After steps 5 and 6, and only after both.

## What is NOT in this sequence

Cohort expansion beyond Davide's single account. Legacy import or backfill.
Provider obligations — historical, preserved, cleanup scope unchanged. The
fault-injection RPC permissions. Enabling Voice Lab. Each is separately recorded
and none is implied by completing the seven steps above.

---

## Appendix — step 6, literally

Written out so that activation is an operation someone can perform, not a
paragraph they have to translate. `sophia_memory_declare_owner_authority` is
`REVOKE`d from `PUBLIC`, `anon`, `authenticated` and `service_role`, so this runs
in the Supabase SQL editor as the project owner — the same way the EI930 repair
was applied. Whole and unchanged, not chunked.

**1. Before.** Confirm the account is undeclared and has no canonical history;
the function refuses both cases, so this is to know in advance rather than to
find out from an exception:

```sql
SELECT user_id, authority_state, authority_epoch, authority_declared_at
FROM public.sophia_memory_user_governance
WHERE user_id = '<davide-authenticated-owner-id>';
```

Expect `authority_state = 'unknown'` or no row at all.

**2. Declare.**

```sql
SELECT public.sophia_memory_declare_owner_authority(
    '<davide-authenticated-owner-id>',  -- p_user_id, the exact Better Auth owner
    'unknown',                          -- p_expected_state
    'governed',                         -- p_target_state
    1,                                  -- p_contract_epoch, matches the deployed contract
    '<approval-ref>'                    -- p_approval_ref, names this authorization
);
```

It returns the receipt as `jsonb` and appends it to `authority_receipts`. It is
idempotent for an identical repeat and raises `memory_owner_declaration_conflict`
for a different one, so a re-run is safe and a mistaken re-run is refused.

**3. After.** Re-run the query from step 1 and confirm `governed`, epoch `1`, and
a `declared_at` timestamp.

**4. Cohort, then flags — in that order, on both `sophia-langgraph` and
`sophia-gateway`, identical values.** The cohort must contain **two** ids, and
getting this wrong does not degrade the Gateway, it stops it booting:

```
SOPHIA_MEMORY_COHORT_PRINCIPALS   = <davide-authenticated-owner-id>,<certification-principal>
# only after the line above is saved on BOTH services:
SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE = true
SOPHIA_MEMORY_GOVERNED_RUNTIME_READ  = true
```

### Why the certification principal has to be in that list

`app/gateway/app.py` calls `build_configured_memory_governance_worker()` inside
the FastAPI lifespan, **outside any `try`/`except`**. That builder does this
(`app/gateway/workers/memory_governance.py`):

```python
if not resolved.candidate_ledger_write and not resolved.provider_projection:
    return None                                   # today: no worker at all
certification_principal = memory_certification_principal()   # raises if env unset
if certification_principal not in memory_cohort_principals():
    raise MemoryFlagConfigurationError("memory_certification_principal_not_in_cohort")
```

So the moment `SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE` becomes `true`:

| condition | result |
| --- | --- |
| `SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL` unset | `memory_certification_principal_missing` → **Gateway fails to start** |
| set, but not listed in `SOPHIA_MEMORY_COHORT_PRINCIPALS` | `memory_certification_principal_not_in_cohort` → **Gateway fails to start** |
| set and in the cohort | worker builds and starts |

This is a **boot failure**, not a per-request error, and it fails the Render
health check — a worse outcome than the `memory_features_without_cohort` case in
4.5, and the earlier version of this recipe (Davide's id alone) would have caused
it. Confirm `SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL` is set on
**`sophia-gateway`** before touching any flag; it is `sync: false`, so its value
is dashboard-managed and invisible to this repository.

### Which worker the text pilot actually selects

The builder assembles two independent halves, and the text pilot takes one:

| flag | component built | text pilot |
| --- | --- | --- |
| `candidate_ledger_write` | `MemoryExtractionService` (extraction, leased, `service_name="sophia-gateway"`) | **yes** |
| `provider_projection` | `MemoryProjectionReconciler` + `Mem0ProjectionAdapter` | **no — stays `false`** |

So the running worker is **extraction-only**, with `projection=None`. No Mem0
projection adapter is constructed, no provider write path is opened, and
`SOPHIA_MEMORY_PROVIDER_PROJECTION` stays `false` through activation. A text
pilot that began projecting to the provider would be a different release.

The worker's recovery scope is `recovery_principals = tuple(sorted(cohort))` —
another reason the cohort is a deliberate two-id list rather than a single id.

`memory_fault_injection` stays `false`, so `faults=None` and the fault
controller is never constructed; the separate question of the three fault RPCs'
`service_role` EXECUTE is unchanged and still out of scope.

`SOPHIA_MEMORY_CANDIDATE_LEDGER_READ` and `SOPHIA_MEMORY_CANONICAL_POOL_READ`
may stay `false`: `resolved_memory_flags_for_owner` forces both on for a governed
owner regardless of the environment. `SOPHIA_MEMORY_PROVIDER_PROJECTION`,
`SOPHIA_MEMORY_LEGACY_INVENTORY`, `SOPHIA_MEMORY_LEGACY_IMPORT`,
`SOPHIA_MEMORY_FAULT_INJECTION` and `SOPHIA_MEMORY_LANGSMITH_EXPORT` stay
`false` — none is part of the text pilot.

**5. Verify as a user, not as an operator.** Sign in to the product, send one
ordinary request, and join it to its timestamped Gateway route and its exact
Better Auth owner. Compare that owner against the cohort value in evidence.
Reject a guessed UUID alias. This is the check EI-078/EI-079 exist because of: a
UI save click and an empty legacy response both look like success.

**Rollback:** phases `6a` (flags off, both services) then `6b` (clear the
cohort), and **`6c` does not exist** — the declaration is never reversed. See the
rollback table in 4.7 for why, and for what each earlier phase reverses. Any
other order passes through `memory_features_without_cohort` (every request, every
user) or `memory_certification_principal_not_in_cohort` (a Gateway that will not
start).
