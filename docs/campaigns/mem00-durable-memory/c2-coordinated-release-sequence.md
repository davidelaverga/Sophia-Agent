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
| `SOPHIA_MEMORY_REFERENCE_HMAC_SECRET` | both | the owner label is `keyed_ref("langgraph-access-owner", …)`. A per-service mismatch makes every owner filter miss and the runtime returns 404 for threads their owner created. |

Explicitly **not** part of this setup: `SOPHIA_VOICE_LAB_ENABLED` stays `false`
and `SOPHIA_VOICE_LAB_KILL_SWITCH` stays `true`. Step 0a is about what the
policy permits, never about turning the lab on.

## Step 1 — shared baseline lint (independent, any time)

Merge `codex/voice-lab-lint-hygiene` (from `8c5cf538`), or the Voice owner's
preferred equivalent. See
[`c2-shared-baseline-lint-coordination.md`](./c2-shared-baseline-lint-coordination.md),
which also carries the review request and the PR link.
Until this lands, `make lint` fails on the merged line and CI never reaches
`make test` — so this gates *any* PR on that line, not only this campaign's.

## Step 2 — receiving authentication install (needs steps 0a and 0b)

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
| source | the qualified integration successor, same SHA as the backend services |
| root directory | `frontend` (from `vercel.json`) |
| install | `pnpm install --frozen-lockfile` |
| build | `pnpm build` → `next build`, output `.next` |
| package manager | **pnpm 10.26.2**, pinned by `packageManager` in `frontend/package.json` and by the e2e workflow |
| Node | **22**, as `memory-highlights-e2e` pins via `actions/setup-node@v4`. Vercel's project Node version must match; this repo declares no `engines` field, so nothing enforces it at build time |
| Next.js | `^16.1.7`, React 19.x, TypeScript 5.8.x — **unchanged by the pilot**; `frontend/package.json` and `frontend/pnpm-lock.yaml` are byte-identical to the shared baseline |

Because no dependency moved, the frontend build is a *source* change only: no
lockfile migration, no framework upgrade, and no Vercel project setting needs to
change.

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

- **The twelve C1/C2 migrations are unapplied except the EI930 repair.** The
  additive schema already in place is forward-compatible; `authority_state`
  defaults to `'unknown'`, so every existing row reads as *undeclared*, which is
  exactly the state the non-cohort work was built for.
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
- **In-flight LangGraph threads at step 2.** Threads created before the `auth`
  entry exists carry no server-issued owner label. After install, the owner
  filter will not match them and they read as 404 to their creator. They are
  Builder/companion working threads bounded by TTL, not durable user data — but
  **step 2 should be deployed at a quiet moment**, and the Voice Lab run/lease
  check the campaign already requires before any deploy covers the synthetic
  side of this.
- **Artifacts, sessions and the Supabase buckets are untouched.** No bucket,
  object key or registry shape changes in this release.

### 4.7 Safe rollback

Per component, in the order you would actually use them:

| what went wrong | rollback |
| --- | --- |
| frontend regression | redeploy the previous Vercel production deployment. No data shape changes, so this is a pure revert. |
| Gateway or LangGraph regression | exact-commit manual deploy of the previous SHA (`autoDeployTrigger: off` means nothing else moves). The additive schema is **not** dropped. |
| step 2 turns out wrong | remove the `auth` entry from `langgraph.json` and redeploy LangGraph. The four callers are inert against an unauthenticated server, so they need no revert. This is the only reason to prefer step 2 as its own deploy. |
| step 3 turns out wrong | `REVOKE EXECUTE` on the 21 named signatures. Nothing calls them while the flags are off, so the revoke is not racing a caller. |
| step 6 turns out wrong | **flags off first, then cohort, then the declaration.** Reversing that order re-enters the `memory_features_without_cohort` state. The owner declaration is a state transition with a receipt, not a delete; the additive rows stay. |

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
2. **Add that exact id to `SOPHIA_MEMORY_COHORT_PRINCIPALS`** on both
   `sophia-langgraph` and `sophia-gateway`. Identical values; a per-service
   mismatch produces a user who is governed on one path and not the other.
3. **Set the text-pilot availability flags** on both services. Only then — see
   4.5 item 4.

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
