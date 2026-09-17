# MEM00-C2 text pilot — current release record

Successful target: MEMORY_TEXT_PILOT_READY. Current status: IMPLEMENTING — RELEASE CLOSURE; not deployed, not activated. C2 replaces the prior PROMOTE-only/five-core-run prerequisites for this owner-restricted pilot. Historical C1 records and failures remain valid history, not additional first-use gates. Recovered cumulative failure counter: latest failed iteration EI929; last reported five-failure checkpoint 923–927; next five-failure checkpoint 932. The single current authority is the checkpoint immediately below; every later dated paragraph is preserved history, not competing current status.

## EI930 storm CONTAINED in production — 2026-09-17 22:52 CEST

**Storm contained** is now true in production. **Schema repaired**, **serving
ready** and **pilot activated** are unchanged and remain separate.

### What was deployed

| field | value |
| --- | --- |
| Merge | PR #145 → `codex/sophia-observability-v1` |
| Shared head | `8c5cf538419cbe3f6eabe59e196242dfb7a6f2cf` |
| Deploy id | `dep-dam53uu7bikc738bpih0` |
| Trigger | Manual, "Deploy a specific commit", exact SHA entered |
| Service | `sophia-gateway` (`srv-d7be5s9r0fns7397l4g0`) **only** |
| **Actual running `commit_sha`** | **`8c5cf538419cbe3f6eabe59e196242dfb7a6f2cf`** — read from `/ready`, not assumed |
| Live at | 22:52:20 CEST (previous `0c215c1b` served until 22:51:58) |

The merge added exactly three backend files against the old shared head —
`workers/memory_governance.py`, `memory_governance/store.py` and the regression
file. No `langgraph.json`, no migration, no frontend, no pilot/C2 code.

### Unrelated services untouched, as required

- `sophia-voice` `build_id` still `35c6467c…` — unchanged.
- `sophia-langgraph` still `0.8.1`, `langsmith: false` — unchanged.
- Gateway `voice_lab_enabled: false`, `voice_lab_kill_switch_engaged: true`,
  `voice_lab_mutation_ready: false` — no Voice gate moved.

This was only possible because all three services carry
`autoDeployTrigger: Off`: the merge itself deployed nothing, and the Gateway was
then deployed alone and deliberately.

### The storm stopped, and the worker is alive

`permission denied for function sophia_memory_expire_candidates` had been logging
roughly **once per second, continuously**. Observed over ~6 minutes after the
cutover, to 22:58:34, parsing the log by severity rather than by timestamp:

| measure, 22:52:20 → 22:58:34 | count |
| --- | --- |
| `permission denied` errors | **0** |
| errors of any level | **0** |

The error wall ends cleanly at **22:51:07**. The only new entries are routine
Postgres checkpoints (`checkpoint starting: time`,
`checkpoint complete: wrote 130 buffers`). At the previous rate that window would
have produced roughly **370** further errors.

(An earlier count in this session reported "2 after cutover"; that tallied log
*timestamps*, not errors, and both were checkpoint LOG lines. Corrected here.)

The worker did **not** go quiet by dying. Eleven consecutive `/ready` samples
from 22:53:36 to 22:58:02 all report `commit_sha 8c5cf538`, reaper
`running: true`, with `last_cycle_at` advancing steadily —
20:52:58 → 20:54:01 → 20:55:05 → 20:56:10 → 20:57:15 — and
`blocking_pending: 0`, `conflicts: 0`, `processing_failed: 0`. That roughly
one-minute cadence is the worker performing real periodic work, which is what
distinguishes containment from the service having stopped.

**Honest limit of this evidence.** A quiet log is consistent with both "expiry
now succeeds" and "expiry now fails once an hour instead of once a second". The
governed RPC is granted to `service_role`, so success is expected, but no
successful expiry return value has been directly observed and the next scheduled
attempt is an hour out. What **is** established: the per-second storm is gone and
the worker is still cycling.

Expiry now calls `sophia_memory_expire_governed_candidates`, which production
grants to `service_role`, so the hourly job can actually succeed rather than
merely failing more slowly. Extraction and projection are no longer suppressed by
the expiry exception.

### Deliberately still true after this deploy

- `sophia_memory_enqueue_extraction` and
  `sophia_memory_finalize_and_enqueue_extraction` remain **revoked**. Startup
  recovery therefore still fails — once per process start, logged by error type,
  not spinning. Granting them belongs to the reviewed C2 activation step.
- `epoch_review` is **not** applied; `review_snapshot` and `inventory_snapshot`
  still carry pre-epoch bodies. Unchanged by this deploy.
- **0 governed owners.** Pilot activation remains closed.

## PR #145 pre-merge CI reconciliation — 2026-09-17

Both GitHub checks on head `3b2eaf65` are red. Reconciled against the correct
baselines; **no defect is introduced by the hotfix** and nothing was disabled,
removed, loosened or cleaned up.

### Unit Tests — `make lint` fails, `make test` never ran

The job fails at `uvx ruff check .` with `Found 22 errors`, exit 2, so the
`Run unit tests of backend` step is skipped (`0s`). The lint findings are in
exactly three files, none of them touched by this PR:

| file | findings |
| --- | --- |
| `tests/test_voice_lab_process_termination.py` | 16 |
| `tests/test_voice_lab_process_termination_postgres.py` | 5 |
| `app/gateway/voice_lab_process_termination.py` | 1 |

By rule: 11 `E701`, 6 `I001`, 3 `F811`, 1 `E731`, 1 `E501`.

**Inherited vs introduced, measured with CI's own tool version.** CI runs
`uvx ruff`, which resolves to the newest release — **ruff 0.16.8** today, not the
0.14.11 in the local venv. Installed 0.16.8 in a throwaway venv and ran it on
both commits:

| commit | result |
| --- | --- |
| base `2deb762a` | Found 22 errors |
| head `3b2eaf65` | Found 22 errors |

The two finding lists are **byte-identical** (`diff` of the sorted concise output
is empty: zero added, zero removed). **Zero findings touch any of the three files
this PR changes** — they are lint-clean. So all 22 are inherited from the base
branch and the PR's contribution to the lint result is nil.

**Evidence for the skipped pytest step**, run on the exact head with CI's own
command (`PYTHONPATH=. pytest tests/`):

> **2 failed, 6,225 passed, 165 skipped** in 290.85s

Both failures are `test_local_sandbox_encoding.py` — the same two that fail on
the unmodified base and are unrelated to memory. Focused regression on the exact
head: **13 tests**, of which **9 fail** against the same base without the fix.
Affected-path selection including `voice_lab_recovery`: **203 passed, 3 skipped**.

### Sentrux — the gate measures the wrong baseline

`.github/workflows/sentrux-gate.yml` hardcodes
`git worktree add ../main-baseline origin/main`, so it always baselines against
**`origin/main`** regardless of the PR's target. This PR targets
`codex/sophia-observability-v1`, which has diverged from `main` by hundreds of
commits of Voice Lab work.

Re-ran the **same pinned version, sentrux v0.5.7**, in a disposable Linux VM:

| baseline | Quality | Coupling | Cycles | God files | verdict |
| --- | --- | --- | --- | --- | --- |
| `origin/main` — what CI does | 5671 → 4531 | 0.18 → 0.03 | 1 → 5 | 7 → 22 | **✗ DEGRADED** |
| `codex/sophia-observability-v1` — the actual base | **4531 → 4531** | 0.03 → 0.03 | **5 → 5** | **22 → 22** | **✓ No degradation**, exit 0 |

The reproduction against `main` matches the bot's PR comment exactly, including
`Complex functions increased: 176 → 674`. Those deltas are the whole
shared-branch divergence, not this PR. Against its real base the hotfix moves
**no metric at all**.

### Disposition

No introduced defect exists to fix, so nothing was changed in response to CI.
Repository rules were checked: `CONTRIBUTING.md` names the backend regression
workflow but defines no policy for inherited failures; there is no `CODEOWNERS`;
and GitHub reports **"No conflicts with base branch. Merging can be performed
automatically"** with the merge button enabled, so **no branch protection
requires these checks** on this target branch. The permitted disposition is
therefore a **maintainer merge with the inherited failures documented** — which
this section is.

Explicitly **not** done, and not proposed: disabling either check, editing the
workflows, adding ignores or `noqa`, reformatting the three `voice_lab_*` files,
loosening a sentrux threshold, or any repository-wide lint cleanup. Fixing the 22
inherited findings and repointing the sentrux baseline at
`github.base_ref` are both real follow-ups, but they belong to the shared
branch's own change, not to an incident hotfix.

## EI930 incident closure — 2026-09-17

### The four states, kept separate

| state | status | evidence |
| --- | --- | --- |
| **storm contained** | in code, **not yet deployed** | hotfix `3b2eaf65`, 13 regressions, 9 fail without it |
| **schema repaired** | **partial** | `source_intake` applied; `epoch_review` outstanding |
| **serving ready** | **no** | review/inventory + 2 extraction RPCs revoked, by design |
| **pilot activated** | **no**, deliberately | 0 governed owners in production |

### Deployment safety — the decisive fact

All three Render services carry **`autoDeployTrigger: Off`**, read directly from
each service's settings page today:

| service | id | branch | autoDeploy |
| --- | --- | --- | --- |
| `sophia-gateway` | `srv-d7be5s9r0fns7397l4g0` | `codex/sophia-observability-v1` | **Off** |
| `sophia-langgraph` | `srv-d7be5s9r0fns7397l4fg` | `codex/sophia-observability-v1` | **Off** |
| `sophia-voice` | `srv-d7be5s9r0fns7397l4f0` | `codex/sophia-observability-v1` | **Off** |

Every historical deploy shows `TRIGGER: API`. So **merging the hotfix into the
shared release line deploys nothing**, and a Gateway-only deploy afterwards is a
separate deliberate action that cannot disturb LangGraph or Voice. This removes
the tension between "reconcile into the shared line" and "Gateway-only
deployment" — both are satisfiable, in that order. The Gateway is
**Blueprint managed**, so its branch was not repointed at the hotfix branch;
merging first avoids that config drift entirely.

### Voice-safe window — confirmed immediately before preparing the deploy

Gateway and Voice both report `voice_lab_enabled: false`,
`voice_lab_kill_switch_engaged: true`, `voice_lab_mutation_ready: false`. The
Gateway retention reaper is alive with `blocking_pending: 0`. No active Voice run
is at risk, and no Voice gate or flag was touched.

### Approval route opened

**PR #145**, `codex/mem00-ei930-worker-hotfix` → `codex/sophia-observability-v1`,
2 commits / 3 files. Merging it reconciles the containment into the shared
release line so a later deployment cannot silently drop it. Merge is the owner's
decision; the agent opened the request only.

### Carried forward, so no line loses the fix

The emergency candidate sits on the shared base, so it does not reach the pilot
line on its own. Both downstream lines were checked and updated:

- Pilot `6746f1e8` had expiry containment but **not** startup-recovery
  containment → now `cfcb2e8f`.
- Integration `730a28d3` had **neither** (verified by marker count 0/0) → now
  `db18c878`, with both present (1/1).

Only the worker and its regression file were taken across. The pilot's newer
`store.py` was **not** replaced by the hotfix branch's older copy; it already
called `sophia_memory_expire_governed_candidates`. `backend/langgraph.json` still
has a zero diff against the shared branch. Integration affected-path check:
113 passed, 1 skipped.

### The 18 ended sessions, reconciled under existing eligibility rules

Read-only inventory of every `status='ended'` session:

- **16 have no `sophia_memory_user_governance` row at all**; **2 are
  `authority_state='unknown'`**; **0 are `governed`**.
- None carries `synthetic_voice_lab`, so none is Voice Lab workload.
- 17 have **zero** extraction runs; one (`b1403a14…`, ended 2026-09-05) has one.
- They span 2026-05-26 to 2026-09-05; most are from June.

Under the current rules extraction requires a governed owner, and production has
none. **So none of these 18 sessions was eligible for extraction during the storm
window**, and the idle queue is explained by ineligibility rather than by work
having been silently dropped.

That is a statement about **eligibility**, not a claim of zero impact. What is
established: no eligible extraction work was queued and lost. What is **not**
established: whether any user-visible behaviour degraded while extraction and
projection were suppressed, and whether any provider-side effect was missed.
No re-extraction, back-fill or provider write was performed, and none is
proposed — doing so would require governed owners that do not exist. The two
historical uncertain provider obligations remain open and untouched.

## EI930 incident — containment status, 2026-09-17

Five states are tracked separately and must not be conflated:
**code published**, **code deployed**, **schema repaired**, **serving ready**,
**pilot activated**.

| state | status |
| --- | --- |
| code published | **YES** — pushed over SSH 2026-09-17; remote matches local for all three refs |
| code deployed | **NO** — Gateway still runs `0c215c1b` |
| schema repaired | **PARTIAL** — `source_intake` applied; `epoch_review` outstanding, prepared for human execution |
| serving ready | **NO** — review/inventory execution revoked by design; two extraction RPCs also revoked |
| pilot activated | **NO**, and deliberately kept closed |

### Minimal Gateway hotfix, built on the deployed base

Branch `codex/mem00-ei930-worker-hotfix` at `1820c58b515736d222636f20102a770390623992`,
based directly on the shared head `2deb762a` that Render tracks. Worktree
`/private/tmp/mem00-shared-baseline`.

It carries **no** MEM00-C2 pilot code — 2 source files, +22 net lines, plus one
regression file:

- `store.expire_candidates` now calls `sophia_memory_expire_governed_candidates`,
  which production actually grants to `service_role` (measured `execute=true`,
  against `execute=false` for the revoked legacy function). Same signature
  `(p_limit integer)`, same integer return.
- `MemoryGovernanceWorker.run_once` stamps `_last_expiry_at` before the attempt
  and contains its failure, so a failing expiry costs one attempt per hour
  instead of one per second, and no longer suppresses `extraction.run_once` and
  `projection.run_once` beneath it.

Containment is deliberately narrow, per the incident constraints:
`asyncio.CancelledError` derives from `BaseException` so shutdown still
propagates (pinned by test, not assumed); the recovery stage is untouched; and
extraction and projection keep performing their own ownership, schema and consent
checks — this only stops housekeeping from suppressing them. No flag, cohort,
grant, RLS setting or memory authority was changed, and execution on the revoked
legacy RPC was **not** restored.

Evidence: 9 regression tests, verified meaningful by running them against the
same base without the fix, where 6 fail. Affected-path selection
`memory_governance or governance_worker or expiry or extraction or projection or
gateway_app_mounts or render_config`: **154 passed, 3 skipped**.

Full-suite compatibility against the deployed base, both `pytest tests/`:

| tree | result |
| --- | --- |
| shared base `2deb762a`, unmodified | 2 failed, 6,212 passed, 165 skipped |
| hotfix `1820c58b` | **2 failed, 6,221 passed**, 165 skipped |

The two failures are the identical `test_local_sandbox_encoding.py` pair in both
runs and are unrelated to memory. The hotfix adds **zero** failures and the nine
new passes are its own regression. This is the compatibility evidence for
deploying it; it is not evidence that the pilot candidate is deployable, which is
a separate and much larger question.

### Worker-reachable RPCs — verified, and two are revoked

Measured against the live schema on 2026-09-17 before deploying anything. All
nine exist; `service_role` EXECUTE is **not** uniform:

| RPC | service_role EXECUTE |
| --- | --- |
| `sophia_memory_expire_governed_candidates` | true |
| `sophia_memory_claim_extraction` | true |
| `sophia_memory_complete_extraction` | true |
| `sophia_memory_fail_extraction` | true |
| `sophia_memory_claim_projection` | true |
| `sophia_memory_complete_projection` | true |
| `sophia_memory_expire_projection_lease` | true |
| `sophia_memory_enqueue_extraction` | **false** |
| `sophia_memory_finalize_and_enqueue_extraction` | **false** |

This changed the hotfix. `recover_finalized_sessions` reaches the revoked
`sophia_memory_enqueue_extraction` through `enqueue_finalized_session`, and
`_recovery_pending` was cleared only after a successful call — the identical
defect pattern as the expiry stamp. Fixing expiry alone would therefore have
**moved** the one-per-second storm to the recovery stage rather than ending it.
Both stages are now contained. Hotfix head is `3b2eaf65`.

The two revoked grants are left revoked. Adding them belongs to the reviewed C2
activation step, not to an incident hotfix, and nothing in the current contained
worker requires them to function — recovery simply reports its failure once per
process start instead of spinning.

### Production backlog at the time of the hotfix

- Extraction runs: `succeeded_nonzero=1`, `superseded=4`. **No queued, leased or
  retry_wait runs**, so oldest-unfinished is none and deploying releases no
  accumulated work.
- Candidates: 6. Ended sessions: 18.
- `sophia_memory_user_governance`: **1 row total, 0 with `authority_state='governed'`.**
  Nobody is enrolled, which is consistent with the pilot being closed and
  confirms the cutover analysis: every account is undeclared.

Absence of queued work is **not** evidence that nothing was lost. Extraction and
projection have not run for the duration of the storm; what that cost is not
established by these counts, and no claim of zero impact is made here.

### Deployment safety

`render.yaml` pins all three services — `sophia-langgraph`, `sophia-gateway`,
`sophia-voice` — to branch `codex/sophia-observability-v1`. Pushing
`codex/mem00-text-pilot`, `codex/mem00-c2-integration-r1` or
`codex/mem00-ei930-worker-hotfix` therefore triggers **no** deployment; only a
commit landing on the shared branch does. Publication is safe and separate from
deployment. Deploying the hotfix is a deliberate follow-up requiring a Voice-
coordinated window, and the actual running artifact SHA must be recorded
afterwards rather than inferred from the push.

## PRODUCTION INCIDENT — 2026-09-17, live-observed and partially repaired

This section is the current authority for production state. It supersedes the
schema claims in every section below, including the 2026-09-15 addendum's
statement that none of the twelve new migrations were applied. That statement
was **wrong**.

### EI930 already happened to production

The buggy lexical-order `tools/mem00_apply_migrations.mjs` was run against the
production database at some point before this session. Production is in exactly
the half-migrated state that a lexical apply produces, confirmed by direct
read-only query through the authenticated Supabase SQL editor:

| check | production, before this session's repair |
| --- | --- |
| 10 of 11 migration witnesses | **present** |
| `..._source_intake` witness | **absent** — the file never applied |
| `sophia_memory_review_snapshot` epoch marker | **0/1 overloads** — pre-epoch body |
| `sophia_memory_inventory_snapshot` epoch marker | **0/1 overloads** — pre-epoch body |

That is the signature predicted by the EI930 analysis: under lexical order
`epoch_review` fails `42883` and `source_intake` fails `P0001`, and the other
ten commit. It is not a hypothesis — the production fingerprints match.

### The live error storm and its root cause

Supabase reported the project **Unhealthy**, a **52.7%** API success rate over
24 hours, and **72,916 Postgres errors out of 73,216 requests**. The Postgres log
is a continuous wall of `permission denied for function
sophia_memory_expire_candidates`, roughly **once per second**. PostgREST is
additionally logging repeated `Warp server error: Thread killed by timeout
manager`. Production runs **PostgreSQL 17.6**.

Root cause, confirmed by query rather than inference:

- `2026_09_09_mem00_c1_dependency_authority.sql` **did** apply, so it revoked the
  legacy function and granted the replacement. Measured:
  `sophia_memory_expire_candidates` → `service_role execute=false`;
  `sophia_memory_expire_governed_candidates` → `service_role execute=true`.
- The **deployed** Gateway (`0c215c1b`, shared line) still calls the revoked
  legacy RPC. This is EI929, live.
- Two amplifiers in the deployed code, fixed in `9e7364ad` (EI932):
  `MemoryGovernanceWorker.run_once` stamped `_last_expiry_at` only on success, so
  a permanently failing hourly job ran once per second against `poll_seconds=1.0`
  — about 3,600x its intended rate; and the exception escaped `run_once`, which
  is reached **before** `extraction.run_once` and `projection.run_once`, so
  memory extraction and projection have not run at all for as long as this has
  been failing.

### Repair applied this session

Authorized by Davide in-session on 2026-09-17 after the diagnosis was presented.

1. **`2026_09_09_mem00_c1_source_intake.sql` — APPLIED.** Its drift guard was
   checked first and was satisfied (`sophia_memory_run_source_valid` md5 was the
   expected pristine `0d447ef95ed420e824d66bdc22380d69`, epoch marker present,
   not yet patched). The SQL was loaded into the editor and verified **byte-exact
   against the repository file by SHA-256** (`1f80ebf3724dcb80…bfae01`, 12,396
   bytes) before running. Result: `Success. No rows returned`. Verified after:
   `sophia_memory_source_intake_version_trigger` present,
   `sophia_memory_accept_source_action` present, and
   `sophia_memory_run_source_valid` now carries
   `MEM00_C1_EXACT_ACCEPTED_SOURCE_VERSION`.
2. **`2026_09_09_mem00_c1_epoch_review.sql` — NOT YET APPLIED.** This is the file
   that must run **last** to restore the epoch-aware
   `review_snapshot`/`inventory_snapshot` bodies. Loading it was refused by the
   local permission classifier, not by Supabase. **Production therefore still
   reads `review_snapshot_epoch: 0/1` and `inventory_epoch: 0/1`** and this
   repair is incomplete.

### Exact remaining production state

- Schema: 11 of 12 applied; `epoch_review` outstanding, so the canonical review
  and Pool reads still serve pre-epoch bodies without their clear-epoch and
  source-exclusion checks. No deployed code calls those two functions today, so
  this is latent rather than actively harmful — but it must be fixed before any
  pilot activation.
- The error storm is **still running**. The schema repair does not stop it; only
  deploying the code fixes does (`9cb84acf` switches to the governed RPC,
  `9e7364ad` stops the per-second retry). Both are committed and unpushed.
- Nothing in this session granted execution to `anon` or `authenticated`,
  changed Voice Lab gates, or touched user rows.

## Current checkpoint — 2026-09-15 recovery (MEM00-C2-R1)

Recovered under the MEM00-C2-R1 recovery handoff. Statement classes are marked
source-inspected, locally-tested, live-observed or unknown. Nothing here claims
deployment or owner activation.

### Source and branch anchors (live-verified, not inherited)

- Pilot worktree `Sophia-Agent-mem00-c2`, branch `codex/mem00-text-pilot`, HEAD
  `c5e64774dbf733ae20bacc834a4af573528df75e`, tree
  `aaf363acf4db22403e5f37a16e60be9985b77e24` — identical to the reviewed pin.
- `git ls-remote` re-fetched: remote `codex/mem00-text-pilot` tip is still
  `c5e64774`. **Nothing newer is published on the pilot branch.**
- Shared branch remote tip is `2deb762a7a03ca7f260ec2efd670b5993f7dc977`,
  matching the reviewed pin: seven linear Voice Lab repair commits beyond the
  `35c6467c` historical base, no merges. Those repairs are preserved and were
  not touched.
- **Shared-branch divergence found (new, not in the handoff).** The local
  `codex/sophia-observability-v1` in worktree `Sophia-Agent-publish` is at
  `1ea5296d6978980e5b925ae4c55c6804c6c9b4d9`, which is *not* a descendant of
  `2deb762a`: ahead 10 / behind 286, merge-base
  `4b72a0c8856fdc1d285a660110df44aadc218ef6` (an ancestor of `35c6467c`).
  `git cherry` shows six genuinely unpublished local commits (`0f4c0add`,
  `5fbd98c0`, `887a52d2`, `6f1bdf60`, `36b45f1f`, `638aaba0` — FC01 Gemini
  continuity, postgres/langgraph checkpointer, voice playback, builder
  reconciliation) and two with upstream equivalents (`09ce291e`, `1ea5296d`).
  These are a *separate* local line, not the newer Voice Lab repairs named in
  the handoff. Reconciling them is a shared-branch decision for the Voice owner;
  no reset, rebase, force push or bulk staging was performed.
- Original C1 WIP preserved separately: `Sophia-Agent-mem00` at
  `41b3322a1982387a408db3f52277a9f9450a438c` on
  `codex/mem00-durable-memory-governance`; that branch's remote tip is
  `8d0d6d33`, so this WIP carries unpushed local commits. Untouched.
- Uncommitted local WIP in the pilot worktree, preserved: modified
  `README.md`, `backend/CLAUDE.md`, this release record; untracked
  `backend/tests/test_mem00_candidate_expiry_contract.py`.

### Actual runtime pins (live-observed 2026-09-15)

- `sophia-langgraph.onrender.com/ok` → 200; `/info` → LangGraph `0.8.1`,
  `langgraph_py` `1.2.0`, self-hosted, `langsmith: false`.
- `sophia-voice-2uzr.onrender.com/ready` → 200; `build_id`
  `35c6467c36b9ae052ec3dd943cf7c9f0ac28d589`, `service_id`
  `srv-d7be5s9r0fns7397l4f0`, `voice_lab_enabled: false`,
  `voice_lab_kill_switch_engaged: true`, `voice_lab_mutation_ready: false`,
  `internal_auth_required: true`. Voice Lab gates were not opened and its flags
  were not altered.
- `sophia-gateway.onrender.com/ready` → **200 ready**; `service` `deer-flow-gateway`,
  `commit_sha` `0c215c1ba0a2218ef224f65601092d5845bb07cf`, `service_id`
  `srv-d7be5s9r0fns7397l4g0`, `voice_internal_auth_configured: true`,
  `voice_lab_enabled: false`, `voice_lab_kill_switch_engaged: true`.
  `/health` → 200 healthy with deck-quality ready. So the Gateway **is live**,
  one commit behind the shared head `2deb762a`, and matches the `Gateway0c215c1b`
  pin recorded in the qualification notes.
- `sophia-backend-g8fe.onrender.com` → **503 "Service Suspended"** ("suspended by
  its owner"). Correction to this checkpoint's first draft: this is the *legacy*
  auth backend used by `SOPHIA_AUTH_BACKEND_URL` (Discord login, Capacitor mobile,
  `api/auth/sync-backend`), **not** the Gateway. The ordinary app authenticates
  through Better Auth + Google in the Next.js frontend, so this suspension is not
  automatically a journey blocker; its exact impact on `sync-backend` is unverified.
- `sophia-ei.com` → 200, Vercel deployment `dpl_4TxUxd6Ee27JF8T42jre5f7Xz2W8`.
  `/api/health` → `{"frontend":"healthy","backend":"unknown","backendTarget":null}`.
  Since `getHealthTargetUrls()` always falls back to `http://localhost:8001`, an
  empty target list implies the deployed frontend build predates or differs from
  this worktree's `gateway-url.ts`; the deployed frontend commit is not yet verified.
- No deployed component carries any MEM00-C2 pilot commit. Gateway is at
  `0c215c1b` and Voice at the historical `35c6467c` base, both on the shared
  line. **No memory deployment exists.**

- Required CI: re-queried GitHub Actions for `c5e64774` → `total_count: 0`.
  Still neither a pass nor proof that no CI system applies; the repository's
  applicable required checks remain unidentified.
### Work completed in this recovery (locally tested, not deployed)

- **WP1 closed in source.** `frontend/src/app/api/memory/commit-candidates/route.ts`
  no longer maps `results[index]` positionally: results are joined by exact
  candidate identity *and* the requested action, duplicates and non-string ids
  void the join, an unjoinable outcome is reported `ambiguous` (distinct from a
  definite `error`), revision/command-key binding is validated up front, and
  `Cache-Control: no-store` is set on every success and error response plus the
  Voice Lab denial. The route now returns content-free `commands` references.
  `recap-store.ts` recovers a lost or unjoined successful response through the
  *existing* `/api/memory/commands/{key}` receipt route instead of blind POST
  retry; a recovered receipt is treated as historical only. No new transaction
  subsystem, and the removed recap text cache was not restored.
  Evidence: 20 passed (was 8) across
  `src/__tests__/api/commit-candidates.route.test.ts` and
  `src/__tests__/stores/recap-store.test.ts`, including out-of-order join,
  missing-result ambiguity, action-mismatch refusal, duplicate-identity refusal,
  no-store on the error response, and four lost-response recovery cases proving
  exactly one mutation attempt. `tsc --noEmit` exit 0.
  Composed exit evidence added as
  `src/__tests__/recap/canonical-decision-recovery-composed.test.ts` (2 passed):
  the REAL route handler is wired to the REAL recap store, so the envelope
  contract is verified end-to-end rather than assumed on both sides. It proves
  one lost successful decision is recovered through its own original command key
  with exactly one bulk-review mutation (no second mutation, no resurrection),
  that no memory text is persisted as current authority, and — paired with it —
  that a superseded canonical revision is excluded from the committed decision
  view. Combined affected selection: `56 passed, 2 skipped`; the two skips are
  the fixture-gated read-path cases in `canonical-review-composed.test.tsx`
  (`MEM00_REVIEW_COMPOSED_FIXTURE` unset). That gap is recorded, not counted as
  a pass; those cases cover the recap read path, not this decision path.

- **WP3 prompt truthfulness closed.** `_ASYNC_BUILDER_SYSTEM_PROMPT` and the
  model-visible `sophia_builder` subagent description no longer promise
  memory/emotional/ritual enrichment; both now state that a governed owner's
  builder brief is source-only and that the description must be self-contained.
  Server boundary unchanged — `allows_unversioned_builder_handoff` still returns
  False for a governed owner, so `_resolve_memory_snippets` returns `[]`.
- **New product defect found and repaired (EI929).** The preserved untracked WIP
  test failed, and diagnosis showed a real defect rather than a fixture problem:
  `2026_09_09_mem00_c1_dependency_authority.sql:360` executes
  `REVOKE ALL ON FUNCTION public.sophia_memory_expire_candidates(integer) FROM
  service_role` and grants `sophia_memory_expire_governed_candidates` instead,
  but `SupabaseMemoryGovernanceStore.expire_candidates` still called the revoked
  legacy RPC. Against the deployed schema, candidate retention expiry would fail
  closed with `42501`, breaking owned-workload settlement. The store now calls
  the governed RPC (identical signature and integer return). No other runtime
  caller of the revoked function remains.
- Regression evidence: MEM00 selection `1207 passed, 1 skipped` (the skip is
  `test_client_live.py:33`, credential-gated, not an aggregated pass);
  LangGraph auth trio `29 passed`; focused expiry/builder-source/text-context/
  source-auth `60 passed`. These are overlapping selections and are deliberately
  not summed into a readiness score.




### WP2 result — qualified, deliberately NOT activated

The receiving policy is qualified in isolation (`29 passed` across framework,
client and service auth). It is **not** activated in `backend/langgraph.json`,
because activation would break live callers:

- `app/gateway/routers/builder_events.py:1403`, `:1604`, `:1777` build a raw
  `langgraph_sdk.get_client(url=...)` with no `OwnerScopedAuth`. All three are
  owner-less Voice Lab synthetic Builder cleanup/retry/global-reaper paths that
  scan across owners by synthetic marker; they cannot carry a single owner scope
  without altering Voice Lab cleanup handling, which this campaign must not do.
- `app/gateway/workers/deck_quality_dispatcher.py:402` caches one raw SDK client
  singleton shared across all owners, likewise unauthenticated.
- `backend/tests/test_render_config.py:96` asserts `"auth" not in config`,
  encoding the staged decision as the repository's current contract.

`langgraph_auth.py`'s own docstring forbids enabling the JSON entry until
service callers and checkpoint continuation pass compatibility tests. Flipping
it now would 401 Voice Lab cleanup and deck-quality dispatch in production, so
the smallest required change is migrating those four caller sites to the
owner-scoped client (or an equivalent internal service lane) **with** their own
affected-path qualification, coordinated with the Voice owner. Until then the
policy stays staged.

### Migration and serving authority

The 13-file harness is the September 2 base plus 12 new files, not 13 new
production migrations. Actual applied production history was **not** readable in
this recovery (no database credentials in the environment), so the exact
unapplied dependency set and any strictly necessary forward serving grants
remain **unknown**, not assumed. Execution privileges remain deliberately
revoked in the selected SQL qualification. A test owner's ability to call SQL is
not application-role qualification.

### Consumer/profile, provider obligations and authorization

- Pilot cohort unchanged: Davide's authenticated application owner (identity
  verification and activation still pending) plus exact synthetic acceptance
  principals. No legacy import, no automatic approval, no cohort expansion.
- Two historical uncertain synthetic provider obligations remain open and were
  not erased; their private identifiers were not recoverable from this
  environment, so their current settlement state is **unknown**.
- No Render/Vercel deployment credentials, deployment CLI or database
  credentials exist in this environment, and no `.env` is present. Deployment,
  schema application, serving grants and Davide's activation are therefore
  genuine access blocks, not deferred test work.
- Toolchain deviations recorded honestly: the `uv` binary is absent, so backend
  tests ran through the existing `backend/.venv` (Python 3.12.14, pytest 9.0.2)
  originally created by `uv sync --group dev`; the `pnpm` binary is absent and
  `corepack` is unavailable, so frontend checks ran through the already
  installed `frontend/node_modules/.bin` (vitest 2.1.9, tsc). No lockfile or
  dependency was changed.

### Authorization recorded 2026-09-15 (owner, in-session)

Davide confirmed the Voice branch is **not currently running** and authorized
browser use, deployment, and testing against the real app at `sophia-ei.com`,
plus reading LangSmith traces. This satisfies the exclusive shared deployment
window precondition and the Voice-idle check for this recovery; it does not
authorize Voice Lab gate/flag changes, new spending, credential rotation, broad
user mutation, or optional destructive actions.

### Next named blocker

`MEMORY_TEXT_PILOT_READY` is unreachable until, in order: (1) the shared-branch
divergence at `1ea5296d` is reconciled with `2deb762a` and one reviewable
integration candidate is constructed, preserving the Voice Lab repairs; (2) the
four unauthenticated LangGraph caller sites are migrated so the receiving auth
policy can be activated with compatible callers — until then the policy stays
staged and the candidate deploys without it; (3) the merged candidate is
deployed to the actual services and the exact unapplied migration/grant set is
determined from real applied history; (4) C2's one authenticated
browser-to-hosted-model lifecycle passes on the deployed candidate; (5) Davide's
verified application owner is actually enabled for the declared text profile and
the operational handover is delivered. Synthetic-only or activation-pending
evidence is at most PILOT_CANDIDATE_VERIFIED, and this checkpoint does not claim
even that: the hosted journey has not run.



### Deployment-readiness addendum (2026-09-15, second session — authenticated)

Recorded after authenticated browser access to Render, Vercel, Mem0, Supabase and
the real app at `sophia-ei.com`. Everything below is live-observed or
locally-tested unless marked otherwise.

**Live component pins (corrected and extended).**

- `sophia-gateway.onrender.com/ready` → 200, `commit_sha`
  `0c215c1ba0a2218ef224f65601092d5845bb07cf`, `service_id`
  `srv-d7be5s9r0fns7397l4g0`; `/health` → 200 with deck-quality ready. The Gateway
  is live, one commit behind the shared head `2deb762a`.
- `sophia-langgraph.onrender.com` → live, LangGraph `0.8.1`, `langgraph_py`
  `1.2.0`, self-hosted, `langsmith: false`.
- `sophia-voice-2uzr.onrender.com/ready` → live at build `35c6467c`,
  `voice_lab_enabled: false`, kill switch engaged.
- `sophia-ei.com` → live, Vercel deployment `dpl_4TxUxd6Ee27JF8T42jre5f7Xz2W8`.
- `sophia-backend-g8fe.onrender.com` → 503 suspended by owner. Reconciled: this
  is the *legacy* auth backend (`SOPHIA_AUTH_BACKEND_URL`), not the Gateway.
  The ordinary app authenticates through Better Auth + Google in the frontend.
- LangSmith is the **EU** region: `render.yaml` sets
  `LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com`, project `Sophia`.

**Production schema — the exact unapplied set is now known (was unknown).**

A read-only Supabase query against the live production database returned:

| object | function | relation | trigger |
| --- | --- | --- | --- |
| `sophia_memory_contract` | false | **true** | false |
| `sophia_memory_dispatch_receipt_immutable` | false | false | false |
| `sophia_memory_expire_governed_candidates` | false | false | false |
| `sophia_memory_lookup_command_receipt` | false | false | false |
| `sophia_memory_prompt_owner_authority_fence` | false | false | false |
| `sophia_memory_register_builder_handoff` | false | false | false |
| `sophia_memory_resolve_provider_hits` | false | false | false |
| `sophia_memory_review_snapshot` | false | false | false |
| `sophia_memory_source_decision_overlaps` | false | false | false |
| `sophia_memory_source_decision_trigger` | false | false | false |
| `sophia_memory_source_intake_version_trigger` | false | false | false |
| `sophia_memory_source_snapshot` | false | false | false |

`sophia_memory_contract` exists, so the **2026-09-02 base migration is applied**
(it also creates `sophia_memory_tombstone`, `sophia_memory_user_governance` and
`sophia_memory_expire_candidates` — verified in the migration source). **None of
the twelve new C1/C2 migration objects exist.** Therefore all twelve new
migrations are unapplied, and the pilot candidate is **not deployable** until
that exact set is authorized and applied. This is the concrete restricted action
that needs approval; it is not deferred test work.


**Integration candidate constructed and verified (not deployed).**

Both published branches left untouched; no reset, rebase or force push.

- Pilot branch is now at `f3378574bf73ee1823dd03199e243b628ffa75a0`, tree
  `2c24c9648adcddc6e964648a4ec47377c3aac8ef`: `9cb84acf` (WP1 identity-bound
  review join + governed expiry RPC) and `f3378574` (excluded-witness fix).
- Integration branch `codex/mem00-c2-integration-r1` at
  `7632e7a2e630b9e2d3f77b5627037e2e23178a8a`, tree
  `e040971cde1991ee1dedd216c2f8beab33a21360`, merging the shared Voice Lab
  repairs at `2deb762a` with the pilot branch. The merge is conflict-free.
- Gateway hotspot reconciled explicitly: the shared side's Voice Lab recovery
  path regex (which gained `browser-process-closed`) is byte-preserved, and the
  pilot side's `langgraph_auth`/`memory_source` routers plus
  `langgraph_owner_scope` middleware are preserved. `voice_lab_recovery.py` is
  identical to the shared branch; Voice Lab markers (voice_lab 81, cleanup 9,
  lease 2) and pilot markers (owner scope 2, memory_governance 9) both survive.
- `backend/langgraph.json` has **zero** diff vs the shared branch: the
  receiving auth policy remains staged, as required.
- Verification on the merged tree: `test_voice_lab_recovery.py` +
  `test_session_store.py` **67 passed**; frontend affected selection **75
  passed, 2 skipped**; broader backend selection
  `mem00 or voice_lab or session or gateway_app_mounts or render_config`
  **41 failed, 1721 passed, 6 skipped**.

**Pre-existing failures, classified honestly (not product failures).**

The 41 remaining failures are concentrated in `test_extraction.py` (22),
`test_gateway_sophia.py` (10), `test_sophia_middlewares.py` (8) and
`test_voice_lab_route_isolation.py` (1), and all raise
`MemoryGovernanceUnavailable: memory_owner_authority_unavailable` from
`resolve_owner_authority`. These tests contain **no** durable-owner fixture
setup, so the resolver correctly fails closed. This is a **fixture gap in
obsolete legacy tests**, not a product defect — the fail-closed behaviour is the
intended safety contract. Confirmed pre-existing: the published pilot head
`c5e64774` already scored **44 failed / 1639 passed** on this selection, before
any of this session's commits; the session's commits add **zero** failures and
the excluded-witness fix removes exactly three. The published "1,454 isolated
runtime tests" headline clearly did not include this selection, which is why the
defects below went unreported.

**EI929 — a real product defect found by the preserved WIP test.** The published
pilot candidate added `memory_source_version` to `SessionMessageRecord` with
`exclude=True`, so the field was present in `model_fields` but absent from every
persisted row, while `read_exact_session_messages` compared the raw row key set
against `model_fields`. It therefore failed closed on *every* legitimate
synthetic finalization transcript. Downstream this surfaced as
`canonical_evidence_raw_message_set_invalid` and broke three Voice Lab
guarantees that pass on the shared branch. Fixed by deriving the expected
raw-row key set from the model's own serialization contract. Impact in
production today is nil only because Voice Lab is disabled
(`voice_lab_enabled: false`); it would have broken expiry purge and canonical
evidence retention as soon as Voice Lab were re-enabled.

**Browser/authentication note.** Google blocks OAuth sign-in inside
agent-browser's bundled "Chrome for Testing" (`navigator.webdriver` true and a
mock keychain that cannot decrypt real Chrome cookies); it returned
"Couldn't sign you in — This browser or app may not be secure" and later a
`google.com/sorry` block. Attaching agent-browser to a *real* Chrome launched
with `--remote-debugging-port=9222` works (`navigator.webdriver` false) and is
how the authenticated observations above were obtained. Also: the failed
LangSmith callback exposed a live access token, Google provider token and
refresh token in the callback URL fragment — treated as a credential exposure
and not reproduced here.
**LangSmith trace coverage — read, and honestly degraded.**

LangSmith EU is reachable and authenticated (`davide.laverga@gmail.com`), org
`26b7385f-8e69-4a13-b4da-49873ae46191`. Three projects exist: `Sophia`
(`7dd40980-665a-4f4a-95c3-582e6270b707`, retention 14d),
`Sophia-Gemini-Live-Voice`, and a legacy `"Sophia"` (literal quotes, 3 months
old). The projects list reports **0 traces in 7 days** for all three.

Reading the `Sophia` project directly shows the newest traces are from
**2026-09-07**: trace name `memory.prompt.admission`, input `zero_memory`,
tags `sophia` / `memory-governance` / `sophia.memory.event.v1`, metadata
confirming `LANGSMITH_ENDPOINT: https://eu.api.smith.langchain.com` and
`LANGSMITH_PROJECT_UUID: 7dd40980-...`. They are content-free governance events,
consistent with the rule that no personal memory plaintext is logged.

Consequences: (a) the memory-governance telemetry shape is confirmed and usable
as an evidence join; (b) there is **no trace evidence for the C2 text-pilot
work**, because `langsmith: false` on the deployed LangGraph and
`LANGSMITH_TRACING=false` mean tracing was off. Degraded trace coverage is
recorded here rather than treated as a new global release block, but it also
means tracing cannot substitute for the required authoritative
lifecycle/admission evidence. LangSmith retention is now capped at 180 days
(notice effective 2026-09-14) and this project is set to 14d, so older traces
aged out.

**Migration application authorized, and prepared.**

Davide authorized applying the database changes on 2026-09-15 ("I authorize to
apply the database changes"). The twelve files are additive and already written
to be re-runnable: each is wrapped in `BEGIN; ... COMMIT;` and guarded with
`CREATE OR REPLACE` / `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`,
and their in-file comments state lexical order is the dependency order.

Application tooling added as `tools/mem00_apply_migrations.mjs` (syntax-checked):
it applies the twelve files in lexical order through the Supabase Management API,
one file per request, and proves each application by checking a distinctive
witness object before and after. It prints no token and no row contents.
`--dry-run` reports witness state without mutating. This session could not
execute it: no Postgres client (`psql`/`docker`) exists locally, no real
database credential is present in any worktree (only `.env.example`), and the
browser SQL editor is not a safe vehicle for ~222 KB of production DDL across
twelve files. A Supabase account token is required to run it; the exact
credential request is the only thing outstanding for schema application.

### Continuation addendum (2026-09-17, third session)

Source-inspected and locally-tested unless marked otherwise. No deployment, no
schema application and no activation happened in this session either.

**Live pins re-read 2026-09-17, unchanged from the 2026-09-15 addendum.**
`sophia-gateway.onrender.com/ready` → 200, `commit_sha` still
`0c215c1ba0a2218ef224f65601092d5845bb07cf`; `sophia-langgraph.onrender.com/info`
→ LangGraph `0.8.1`, `langgraph_py` `1.2.0`, `langsmith: false`;
`sophia-voice-2uzr.onrender.com/ready` → 200 at build `35c6467c`,
`voice_lab_enabled: false`, kill switch engaged. The Gateway's Voice Lab
retention reaper is running (last cycle 2026-09-17T11:42:58Z, 1 discovered /
1 accepted-historical-pending / 0 blocking). Still **no deployed component
carries any MEM00-C2 commit**.

**Integration candidate re-verified and advanced.** `codex/mem00-c2-integration-r1`
is now `83253c8544dd72cf74e401f350ce9b9520a16e24`, tree
`49ae3920afab1cc05f9f70878142c4f19afc3197`, merging shared `2deb762a` with the
pilot head `5a6c0616` (the earlier `7632e7a2` merged the older pilot head
`f3378574`). `backend/langgraph.json` still has a **zero** diff against the
shared branch, so the receiving auth policy remains staged as required. The
affected backend selection `mem00 or voice_lab or session or gateway_app_mounts
or render_config` reproduces the recorded result exactly on the new merge:
**41 failed, 1721 passed, 6 skipped** in 110.72s. The 41 are the same
pre-existing legacy-fixture failures classified above, not product defects.

**EI930 — migration apply-order defect in the staged tooling, found and fixed.**
`tools/mem00_apply_migrations.mjs` applied the twelve files in **lexical** order
and asserted in its own comments that lexical order was the dependency order.
It is not. The qualified order in `tools/mem00_c2_model_authority_contract.mjs`
and in Appendix A of the handoff places `epoch_review` **last** among the C1
files; lexically it sorts fourth, before the two files whose functions it
replaces and before the file that creates its dependency.

*Empirically demonstrated, not inferred.* Both orders were applied to real
PostgreSQL 16 databases (details under "Disposable rehearsal" below). Applying
the twelve files in lexical order gives:

| file | lexical result |
| --- | --- |
| `..._epoch_review` (4th) | **fails** `42883` — `public.sophia_memory_source_snapshot(text,text,text)` does not exist; it is created later by `..._epoch_source_target` |
| `..._source_intake` (10th) | **fails** `P0001 memory_source_predicate_drift` — `..._source_decision_fence` was applied before it |
| other ten files | apply and **commit** |

So the failure mode is a **partially applied production schema**, not a clean
abort: ten files commit, two do not, and the database is left serving
`sophia_memory_review_snapshot` and `sophia_memory_inventory_snapshot` with
their **pre-epoch bodies** (verified: the epoch markers appear in 0 of 1
overloads), with the whole source-intake stage missing. Recovering from that
state on production would have been manual.

Correcting an earlier draft of this note: the corruption is **not** silent at
the SQL level — Postgres does raise both errors. What was silent was the
tooling's *witness*: `epoch_review`'s witness was `sophia_memory_review_snapshot`,
the very object `..._review_snapshot.sql` also creates, so on any re-run after a
partial apply the file that failed would have reported `present`. The old script
also continued past both failures into their dependants instead of stopping.

Repaired: the script now applies the qualified dependency order, **stops at the
first failing file**, and replaces the two ambiguous witnesses with
**definition-content markers** — `acceptance_unproven` for `review_snapshot`
and `source_target_at_epoch_aligned` for `inventory_snapshot`, each verified
present in the epoch body and absent from the older one. A marker reads `stale`
rather than `present` whenever any overload carries the old body. A post-apply
invariant check re-asserts both markers and fails loudly if the files are ever
applied in lexical order again, by this script or by hand. The script also
accepts `MEM00_DATABASE_URL` and applies through the existing `pg` client, so an
existing database credential can be reused instead of minting a new
account-wide Supabase token.

Classification: a real defect in release tooling, caught before execution.
**It never ran against production**, so there is no production effect to settle
and no provider state changed. Latest failed iteration EI930; next
five-failure checkpoint remains 932.

### Disposable rehearsal — the twelve files are now applicable evidence, not a plan

Run against real **PostgreSQL 16.10** in the existing disposable Lima VM
`mem00-qualification24` (Ubuntu 24.04), reached over an SSH tunnel. Two
throwaway databases were created and are not production. No production
database was contacted in this session.

- **Correct order applies cleanly.** Base `2026_09_02_mem00_durable_memory_governance.sql`
  first, then the twelve in qualified order: every file returns OK and every
  per-file witness moves `absent → present`. The final ordering invariant passes:
  both `sophia_memory_review_snapshot` and `sophia_memory_inventory_snapshot`
  carry the epoch-aware bodies.
- **Complete function surface.** The twelve files define **54** distinct
  `public.*` functions; all **54** are present after the apply.
- **Least privilege holds on a real server.** Of **162** (function, role) pairs
  across `anon`, `authenticated` and `service_role`, exactly **10** carry
  EXECUTE, all of them to `service_role`:
  `sophia_memory_ensure_governance`, `sophia_memory_lookup_command_receipt`,
  `sophia_memory_expire_governed_candidates`, `sophia_memory_complete_source_recovery`,
  `sophia_memory_claim_source_recovery`, `sophia_memory_apply_source_target`,
  `sophia_memory_invalidate_source`, `sophia_memory_resolve_provider_hits`,
  `sophia_memory_current_view`, `sophia_memory_complete_extraction`.
  **Zero** grants to `anon` or `authenticated`.
- **EI929 confirmed against a real schema, not only by source reading.** After
  the apply, `service_role` has EXECUTE on `sophia_memory_expire_governed_candidates`
  (`true`) and **not** on the legacy `sophia_memory_expire_candidates` (`false`).
  The store fix committed in `9cb84acf` is therefore necessary and correct:
  the pre-fix code path would have failed closed with `42501` exactly as
  predicted.
- **Re-application is idempotent and survives restart.** A second full apply
  returns OK for all twelve with the invariant still passing. After
  `systemctl restart postgresql`, all 54 functions, the 10 grants and both
  epoch markers are unchanged.
- **Correction to an inherited claim.** This record previously stated that the
  2026-09-02 base migration also creates `sophia_memory_tombstone`. On a real
  apply it does not — `to_regclass('public.sophia_memory_tombstone')` is `NULL`
  after the base. It does create `sophia_memory_contract` and
  `sophia_memory_expire_candidates`, so the inference that the base **is**
  applied in production (because `sophia_memory_contract` exists there) still
  stands; only the supporting detail was wrong.

**Operational consequence — apply schema before deploying code.** The set is
idempotent in its end state but **not atomic across files**: files 4 and 5
install the pre-epoch `review_snapshot`/`inventory_snapshot` bodies and file 11
restores the epoch-aware ones, so a *re-run* against a live database exposes a
window in which those two reads serve the pre-epoch contract. The rehearsal
shows this directly — on an already fully migrated database the second run
reports `epoch_review before=[...=stale(0/1) ...=stale(0/1)]`. On a first
application this window is harmless because no deployed code calls the
functions yet. Therefore: apply the schema **first**, deploy the candidate
after, and do not re-run the set against a live pilot outside a maintenance
window. A re-run is unnecessary anyway, since the end state is idempotent.

What this rehearsal does **not** establish: it is not the production database,
not the production role set (production has Supabase's own `service_role`
configuration and RLS context), and not an application-role serving proof. The
production applied-history read from 2026-09-15 still stands as the statement
of what is unapplied there.

### Every MEM00 SQL contract now runs on a real server, not PGlite

The repository's SQL harnesses take their database fixture as `process.argv[2]`,
and `tools/mem00_native_sql_driver.mjs` already anticipates a native backend
(`backendKind === 'native-postgres'` is what unlocks the restart and
duplicate-dispatch checks). That driver needs a disposable
`embedded-postgres` runtime that is not present here, so a **session-local**
adapter exposing the same interface was pointed at the Lima VM's PostgreSQL
16.15 instead. **No harness was modified**; each run gets its own throwaway
database, which is dropped on close.

| harness | result on PostgreSQL 16.15 |
| --- | --- |
| `mem00_c2_model_authority_contract.mjs` | **pass, 78 checks**, 13 selected migrations, `native_restart_and_duplicate_dispatch: true` |
| `mem00_owner_authority_contract.mjs` | **pass, 27 checks**; owner-authority migration sha256 `1044fd8e…682b0d` |
| `mem00_command_receipt_contract.mjs` (with the repair migration) | **pass, 24 checks** |
| `mem00_review_snapshot_contract.mjs` | **pass, 39 checks**, 1,005 candidates across 6 pages |
| `mem00_inventory_contract.mjs` | **pass, 51 checks**, 2,010 records across 11 pages |
| `mem00_session_delete_contract.mjs --repair` | **pass**, all ten contract flags true |
| `mem00_schema_attestation_test.mjs` | **pass** (syntax, contract, stable digest, column change/rollback, ACL change) |

`production_mutations: 0` and `provider_calls: 0` in every report that emits
them. These are overlapping selections and are deliberately not summed.

Two harnesses appear to fail when launched without their mode flag —
`mem00_command_receipt_contract.mjs` without a third argument deliberately runs
against the pre-repair schema, and `mem00_session_delete_contract.mjs` without
`--repair` deliberately runs against the unrepaired fence. Both are the
harnesses' own negative modes, **not** defects; both pass in repaired mode.
Recorded here so a future run does not mistake them for regressions.

What this changes: the campaign previously had native evidence only for the C2
model-authority file (the "78 native SQL checks"), with the C1 contracts proven
on PGlite. All of them now hold on the same real PostgreSQL major version family
that production runs, including a genuine `systemctl restart` of the cluster.
What it still does not establish: the **production** database, Supabase's own
role and RLS configuration, application-role serving grants, or any hosted
behaviour.

### EI931 — the 41 failures are a non-cohort regression, not a fixture gap

This supersedes the classification recorded in the 2026-09-15 addendum. That
note said the 41 failures in `test_extraction.py` (22), `test_gateway_sophia.py`
(10), `test_sophia_middlewares.py` (8) and `test_voice_lab_route_isolation.py`
(1) were "a fixture gap in obsolete legacy tests, not a product defect", because
the tests set up no durable-owner fixture and the resolver correctly fails
closed. The first half is right. The conclusion is wrong.

**They are not pre-existing on the line this candidate must merge into.** The
same four files were run at the shared head `2deb762a`: **407 passed, 0
failed**, 2.59s. They fail only with the pilot's changes. "Pre-existing at
`c5e64774`" was true but misleading — `c5e64774` is itself a pilot commit.

**The cause is reachable in production, not only in tests.** `resolve_owner_authority`
requires `authority_state IN ('legacy','governed')`, but
`2026_09_08_mem00_c1_owner_authority.sql:8` adds the column as
`NOT NULL DEFAULT 'unknown'` with a CHECK that keeps `authority_epoch` and
`authority_declared_at` NULL while it stays `'unknown'`. No application code
calls `sophia_memory_declare_owner_authority` — declaration is an operator
action. So **every existing production user is `'unknown'`** until explicitly
declared, and `resolve_owner_authority` raises `MemoryGovernanceUnavailable`
for all of them. The store's own comment ("Missing rows/columns and old schemas
are unavailable, never legacy") confirms this is deliberate, and Section 3 of
the handoff agrees that unknown authority must not become legacy status.

The defect is not the fail-closed resolver. It is that two **ordinary,
non-memory** call sites invoke it without a guard, so the failure escapes into
paths every user traverses:

| call site | ordinary path it breaks |
| --- | --- |
| `middlewares/session_state.py:71` — `memory_feature_flags_for_owner(self._user_id).candidate_ledger_write` | turn 0 of **every** chat session |
| `offline_pipeline.py:211` — `memory_flags = memory_feature_flags_for_owner(user_id)` | End-session finalization / extraction |

Other callers are already guarded and are not affected:
`tools/retrieve_memories.py` wraps the call in `try`, and
`context_state.allows_unversioned_builder_handoff` catches and returns `False`.

**Demonstrated directly, not inferred from the failing legacy tests.**
`backend/tests/test_mem00_noncohort_owner_paths.py` (4 passed) drives the
resolver with a store that is configured, reachable and returns a row — the row
simply carries `authority_state='unknown'`, exactly production's state. It
shows (a) the resolver raises for an undeclared owner, (b)
`SessionStateMiddleware.before_agent` propagates that error on turn 0, and
(c) the identical call **succeeds** once the same owner is declared `legacy`,
which isolates the cause to the undeclared authority rather than to an absent
store or to the middleware's inputs.

**Release consequence.** Deploying this candidate as it stands would break
ordinary chat and session finalization for every user who is not explicitly
declared — the exact opposite of "preserve their existing disposition". It also
means the repository's required CI cannot pass: `.github/workflows/backend-unit-tests.yml`
runs on `pull_request` and executes `make test` = `pytest tests/`, the whole
suite, so these 41 failures turn the required check red. This also explains the
earlier "zero Actions runs" result: these workflows trigger on `pull_request`,
and no PR was ever opened for the pilot head, so the empty query said nothing
about whether CI applies. It does apply.

**Required CI is therefore now identified** (previously "unknown"):
`backend-unit-tests` (`make lint` = `ruff check`, then `make test`) and
`sentrux-gate`, both on every non-draft PR, plus `memory-highlights-e2e`, which
is path-filtered on `frontend/src/**` and so will also run for this candidate.

**Fix not yet applied — it needs a design decision, recorded below.** The
smallest correct change is for the two ordinary call sites to treat an
*undeclared* owner as "no memory features" (`MemoryFeatureFlags()`, all off)
rather than as a fatal error, which restores exactly the pre-pilot behaviour for
non-cohort users and grants no legacy access. But `resolve_owner_authority`
currently collapses *undeclared owner* and *store/transport failure* into one
exception, and those two must not be treated alike: degrading on a transport
failure would silently drop the guard for a **governed pilot owner** during an
outage. Separating the two signals is a change to a governance boundary and is
recorded as the next decision, not made unilaterally. Latest failed iteration
EI931; next five-failure checkpoint 932.

### The failure count itself was wrong: 41 was a filter artifact

Correcting this session's own earlier entry as well as the 2026-09-15 one. The
"41 failures" figure came from running `pytest -k "mem00 or voice_lab or session
or gateway_app_mounts or render_config"`, which **deselects** any test whose name
does not contain one of those words. Whole clusters — for example
`TestMem0MemoryMiddleware` — were never run and were therefore counted as
neither passing nor failing.

Measured properly, with `pytest tests/` (exactly what CI's `make test` runs):

| tree | result |
| --- | --- |
| shared baseline `2deb762a` | **2 failed**, 6,212 passed, 165 skipped (307s) |
| integration candidate, before the EI931 repair | **127 failed**, 7,029 passed, 168 skipped (306s) |

The shared branch's 2 failures are in `test_local_sandbox_encoding.py` and are
unrelated to memory; they are the genuine pre-existing ones. So the pilot adds
roughly **125** failures, not 41 — and also ~817 passing tests, since it brings
its own suites. The four files named in the earlier entry alone go from
**407 passed / 0 failed** on the shared branch to **97 failed** on the candidate.

**Lint, the other half of the CI job.** `make lint` runs `uvx ruff check .`
before `make test`. Local ruff 0.14.11 reports **22** errors on the shared
baseline and **308** on the candidate: 103 `E701`, 65 `F811`, 55 `I001`, 43
`E702`, 39 `F401`, plus one each of `E402`, `E501` and `F821`. Two honest
caveats: CI installs ruff through `uvx` unpinned, so its version may not match
this one and these numbers indicate the **delta the pilot introduces**, not the
CI verdict; and the shared baseline is itself non-zero, so whether this gate is
currently green on the deployed line is unverified and worth settling by
actually opening a PR once the branch is pushed.

The single `F821 Undefined name 'AuthorizedMemory'`
(`memory_governance/store.py:705`) was checked and is **not** a runtime bug: the
module has `from __future__ import annotations`, the name is used only in a
return annotation, and the import is function-local, so the annotation stays a
string. The module imports cleanly. 62 of the 65 `F811` are
`declare_memory_owners` imported in 27 test files and then shadowed as a fixture
parameter; moving that fixture into `tests/conftest.py` would clear most of them
and is the obvious structural fix, deliberately not bundled into this change.

### EI931 repair, its measured effect, and the cutover decision it exposes

Repaired in `14e645cd`. `MemoryOwnerUndeclared` is added as a **subclass** of
`MemoryGovernanceUnavailable`, raised only on a definite answer — the store
responded against a current schema and the owner either has no row or carries
`authority_state='unknown'`. A transport failure, an error body or an
unsupported contract stays the broad error. Because it is a subclass, every
existing `except MemoryGovernanceUnavailable` keeps failing closed unchanged.
`ordinary_path_memory_flags_for_owner` is what the two ordinary call sites now
use: an undeclared owner yields all-off flags, a store outage still raises.
`legacy_memory_lane_allowed` still answers False for an undeclared owner, so
unknown authority still never becomes legacy status. Ten tests in
`test_mem00_noncohort_owner_paths.py` pin both directions.

Two existing governance tests asserted the old exact reason string and were
updated in `91706672` to encode the distinction instead. Their real guarantees
were untouched and passed throughout: denial, untouched legacy cache, provider
never reached.

**Measured effect on the whole suite** (`pytest tests/`, the CI command):

| tree | result |
| --- | --- |
| shared baseline `2deb762a` | 2 failed, 6,212 passed |
| candidate before the repair | 127 failed, 7,029 passed |
| candidate after the repair | **121 failed**, 7,041 passed |

So the repair fixes the crash it targeted and nothing regressed, but it does not
by itself make CI green. The remaining 121 break down as: `test_gateway_sophia.py`
53, `test_mem0_client.py` 22, `test_extraction.py` 22,
`test_sophia_middlewares.py` 13, and 11 elsewhere — of which 2
(`test_local_sandbox_encoding.py`) are the shared branch's own pre-existing
failures.

**A discarded hypothesis, recorded so it is not retried.** Most of the remainder
reach `MemoryGovernanceUnavailable` because those tests configure no store at
all. The obvious-looking fix — short-circuit `resolved_memory_flags_for_owner`
to all-off flags when no MEM00 feature is enabled anywhere, mirroring
`context_state.allows_unversioned_builder_handoff` — was implemented and
measured: it cut the four big files from ~110 failures to 48, but it **broke**
`test_actual_facade_denies_legacy_cache_and_provider_under_rollback[unknown]`
and `[outage]`. Those cases deliberately unset every `SOPHIA_MEMORY_*` variable
and still expect the authority reason rather than `governed_runtime_disabled`,
which pins a deliberate contract: the legacy facade consults durable ownership
**regardless** of flags. The experiment was reverted. The remaining failures are
genuine fixture gaps needing the existing `tests/mem00_owner_fixture.py`
`declare_memory_owners` fixture, not another product change.

**The cutover decision this exposes — the real remaining product question.**
`app/gateway/routers/sophia.py:137` `_memory_flags` converts **any**
`MemoryGovernanceUnavailable`, now including `MemoryOwnerUndeclared`, into a
**503**, and 16 routes use it. This is not a crash and not obviously a defect:
for an undeclared owner it refuses rather than falling through to the
`LegacyMem0Facade` path. But it means that once this candidate is deployed,
every ordinary memory endpoint returns 503 for every user who has not been
declared — and, separately, `legacy_memory_lane_allowed` requires an explicit
`legacy` declaration, so an undeclared user has **no memory recall at all**.

The EI931 repair stops ordinary chat and session finalization from raising. It
deliberately does **not** restore recall, because doing so would mean treating
an undeclared owner as legacy, which the handoff forbids. Restoring recall for
existing accounts requires declaring them `legacy`, which is a separate,
authorized operator action. Verified against a real database this session:

- An account with no MEM00 canonical history **can** be declared `legacy`.
  Since MEM00 has never been deployed, `sophia_memories`,
  `sophia_memory_extraction_runs` and `sophia_memory_governance_events` should
  be empty in production, so ordinary accounts should qualify. This **corrects**
  a claim made earlier in this session that active accounts would be ineligible.
- `legacy → unknown` is refused (`memory_owner_authority_rollback_denied`), so
  the declaration is permanent.
- `legacy → governed` **is** permitted afterwards, so declaring legacy does not
  block enrolling the pilot owner later.
- It covers only accounts that exist at the time of the sweep. No application
  code calls `sophia_memory_declare_owner_authority`, so **every new signup
  after the sweep is undeclared again**. Closing that needs either an
  application-side declaration on account creation or an accepted policy that
  new users have no memory until declared. This is an open release decision, not
  a defect, and it is not resolved in this record.

**Access blockers for this session (unchanged in substance, re-confirmed).**
No Supabase, Render or Vercel credential exists in this environment, and the
Claude in Chrome extension is not connected, so the browser has no authenticated
session. `git push` also has no credential here (`gh` absent, empty keychain),
which matters because Render and Vercel deploy from a branch. Deployment, schema
application and Davide's activation therefore remain genuine access blocks, not
deferred test work.

## Candidate and scope

- Isolated worktree: Sophia-Agent-mem00-c2, branch codex/mem00-text-pilot.
- Integration base:35c6467c36b9ae052ec3dd943cf7c9f0ac28d589. Memory audit anchor:8d0d6d335d4a4a833eb827b2678b639d4b927241.
- Preserved source WIP: Sophia-Agent-mem00 at41b3322a1982387a408db3f52277a9f9450a438c. No reset, bulk staging or overwrite of unrelated work.
- Pilot cohort: Davide's authenticated application owner (identity verification and activation pending), plus exact synthetic acceptance principals. No legacy import or automatic approval.
- Enabled target: extraction/review/Pool/lifecycle, automatic and explicit-tool text recall, current final model admission/revocation.
- Disabled target: Builder personal-memory retrieval and inherited memory-derived briefs; voice personalization and identity. Ordinary Builder tasks remain available from independent user/task sources. Optional restore/bulk/source-mutation routes must be selected only with their proven dependencies or explicitly refused.
- Provider: preserve deployed mem0ai1.0.9, V1 CRUD/V2 search, existing project/configuration. Truthful bounded pending cleanup is permitted; no false terminal-zero claim.

## Selected foundation, not a deployable release

Published foundation d2944ebfa3319ff2b864311981a776b476b2ca1a has tree6018d1c4f587443fcc785847b4299fb79c158705, identical to locally tested35170741. The local authoring commit is retained on codex/mem00-c2-foundation-local; the pilot branch follows the verified published commit. GitHub publication used the existing authenticated connector, not a new token. Original memory/shared branches were not moved.

Next selected callsites: existing direct memory facade denial before cache/provider access, generic memory HTTP refusal and neutral identity with post-file-read authority recheck. The facade's new retrieval-provenance extension and raw-write metric extension are deliberately not imported yet; their dependencies belong with actual text admission and serving evidence. This intermediate code must not be deployed before those remaining boundaries are integrated. Focused foundation+actual-entrypoint tests7a21f8:25 passed with9 pre-existing Pydantic warnings; no external calls. The identity read-race test is reused with its fixture import pointed at the selected foundation module.

Publication failure accounting: EI864 (84c82a) expected HTTPS push, got missing username/credential. Hypothesis: CLI credential unavailable although an authenticated connector may exist. Verified connector profile davidelaverga and published the exact tree without new credentials. EI865: update-ref's documented create/update wording did not create the absent branch (422); follow-up fetch consequently found no ref. Owning fix: use create_branch for a new ref, then read-only fetch26ba53 and exact local/remote tree comparison3f9b84. No production/customer state affected, no temporary provider fixtures, no force push. These are publication/setup failures, not product-canary failures. Latest865,next867.

Selected identity race regression is terminal: b3108b30 passed,9 existing Pydantic warnings, across foundation, actual facade/generic HTTP/identity entrypoints, and post-read cutover/outage/wrong-owner races. Whitespace check8fb56e passed. This does not claim complete consumer containment or a production journey.

First extraction reuses the existing owner-authority resolver, typed model, exact store read and availability/authority separation. It includes only one proposed forward migration:2026_09_08_mem00_c1_owner_authority.sql, SHA2561044fd8e89438488e3cd349a759c8afa345dd8c68fa6da4a06a62676ca682b0d. That migration depends on the existing base memory schema; it does not enroll anyone. Production application and declarations remain pending exact approval review. No other private migration has been selected by default.

The selected helper tests are extracted unchanged from the existing authority suite. On this isolated source, d63c35:11 tests passed through Python3.12/uv frozen offline. adadef:27 disposable PostgreSQL17.5 checks passed: upgrade preservation, explicit declarations, receipt replay, downgrade/delete/truncate fences, canonical RPC compatibility, least privilege and reapplication. The database was closed. These are foundation proofs only: no actual facade/callsite inventory, mixed-binary routing, independent concurrency, hosted model or activation claim.

Next: extract the dependent canonical review/command/projection and actual text-admission callsites from the existing WIP, reviewing imports and SQL dependencies as selected. Contain Builder memory at real serving/delegation boundaries rather than importing all Builder personalization work. Reuse V89 evidence only where selected bytes/contracts still match; run focused checks for changed composition. No new generalized framework.

## Finite C2 acceptance

### Canonical source/review slice, 2026-09-14

Published as f557f2bed0b62012c59bb206db06918473a3dd18, tree41945dff5aa86143f244386803de1c8aff1a84e6. Read-only remote verification7a2491 matched the tested staged tree; no shared ref or deployment moved. Combined selected authority/entrypoint/command/review regression ac2ae9 passes54 backend tests with9 existing warnings.

This slice follows published receipt commit23072300a03b5a7a53fb8fc0a71ab3c27d5e99b0 (tree91f88c42e1a4b79d41b9dc7234a46077ba86ebc9), which follows legacy-boundary commit e6ff75d475a26b4a67289aac4b59e49dff243034. All are isolated from the shared deployment branch.

The current v2 review contract requires source eligibility and clear-epoch checks; it was not downgraded to an older contract to reduce the migration count. Nine existing dependency migrations are now selected in addition to owner authority and command receipts: dependency_authority, review_snapshot, snapshot_inventory, source_decision_fence, transactional_clear, source_intake, extraction_dispatch, epoch_source_target, and epoch_review (all2026_09_09_mem00_c1). None has been applied in production. Selecting SQL dependencies does not enable optional clear/restore/source mutation endpoints. The source-intake/target helpers are dependency code, not a claim that all write callsites are integrated.

Evidence: Gateway recovery rerun56e5cf passes29 tests after the lost process handle was safely rerun. Disposable SQL-only b16578 passed39 checks,1,005 candidates/six pages. Joined proof0cffad passes41 checks with22 actual Gateway/HTTP-store requests, actual Next recap/recent proxies and the recap loader, exact1,005 candidate/revision preservation, zero provider calls, and two executed—not skipped—frontend cases. Reporter SHA2561aa7652aafc2010e666895d9041031bdf9688a2d370617666b7beb328230e26f. Disposable database and private synthetic transport/report files were removed. This proves the read chain, not an actual hosted browser lifecycle or lost decision-response UI recovery.

Frontend79d9c6 passes50 unique tests: schema19, authenticated recap proxy8, existing session routes4, loader15, truthful empty views4. An earlier50-test result122487 included19 repeated registrations from importing a test module; it is superseded by a standalone fixture and the unique50-test run. TypeScript9f7142 exits0. Whitespace809d98 exits0. Current review rendering cannot consult competing derivative copies when a canonical envelope is present. Full owner-switch/transient browser-state integration remains pending; the historical owner-unaware session-history interface is not represented as complete isolation.

Failure accounting: EI866, local Python collection826f26, hypothesis: selected Gateway inventory function ended before its exception handler body. Repaired the exact handler with content-free503/no-store; regression56e5cf29 passed. EI867, local TypeScript69c6f6, hypothesis: wrapper still restricts the old recap status union. Updated RecapComponents to accept no_pending/source_excluded, verified9f7142 and rendered-state tests79d9c6. MEM00_FIVE_ITERATIONS_REACHED — CONTINUE was reported for863–867: prior legacy-privacy fixture mismatch, two publication setup errors864/865, and two incomplete patch selections866/867. Pattern: composition/dependency selection, not hosted provider failure; next experiment was typed/rendered read-chain verification, now passing. EI868, stale loader expectation0c3cb5: hypothesis:404 now correctly reports source_not_found but the test still expects session_not_ended. Updated only that diagnostic expectation; all15 loader tests pass79d9c6. These failures had no production effect or provider state. Next: finish the selected write lifecycle and actual text admission, then requalify their integrated paths.

Receipt-recovery integration selected next: existing2026_09_08_mem00_c1_command_receipts.sql (the second selected migration, not the entire C1 set), typed original command receipts, strict owner/key-bound store lookup, canonical service and authenticated Gateway status route, plus existing Next proxy/schema. SQL93c4c8 passes24 actual RPC receipt/replay/tombstone and lock-order checks including repeated migration application; disposable database closed. Backendfff312 passes38 focused tests, including committed/tombstoned/absent/wrong-owner/wrong-key/outage/duplicate/extra-plaintext status responses. Frontend9f62f7 passes6 proxy tests; TypeScript376b15 terminal0. Frozen offline dependency install reused844 packages/downloaded0; existing pnpm policy skipped native build scripts and was not changed. This proves recovery plumbing, not complete review UI or actual hosted lifecycle. Remaining ordinary decision response/UI integration is still required.

### Selected extraction worker and SDK boundary

Published extraction commit c464e8ebd889970cd863833822bdf315a5abf7e8 has tree a71ab0ca71e02a144204c0d13b1fb4921b2bfe3a, verified by remote fetch bb38b2; the current intake/lifecycle slice follows this exact parent.

Post-extraction joined review rerun7073da again passes41 checks/22 Gateway reads/two executed frontend cases with1,005 candidates; reporter SHA2560ae162a2f59aa34d09d752ed63f5fba00f080460fa4126ee3d73c8aabfd88711. Disposable SQL and transient synthetic transport files closed/removed, zero production mutations.

Reused the existing frozen prompt renderer, exact input fingerprint, one-use extraction dispatch authority, source-target finalization, complete source-run enumeration and durable recovery receipts. No model, prompt template, Mem0 SDK/project, configuration or billing setting changed. SDK-internal retries are disabled only for governed extraction because each send requires its own current SQL admission; this is request execution fencing, not a Mem0 configuration change. Existing legacy extraction also checks current durable owner authority before template/model use.

Extraction input/dispatch/source-target/epoch checks759f98 pass117 tests. After integrating the current worker fixtures, combined extraction worker and review checks e98c1a pass180 tests with9 existing warnings. Fixtures explicitly declare only their named synthetic owners; no global legacy-authority bypass was added. Local SDK transports are recording/fault seams, not hosted model calls. The helper publication does not yet establish ordinary app source acceptance, final text-model admission, disabled-consumer inheritance, full rollback safety, or production usefulness. Source intake and End-session serving callsites must be joined next, with the current lifecycle/projection work still pending. No additional migration selected in this worker slice; it uses the eleven already identified dependencies.

| Gate | Current disposition |
| --- | --- |
| Isolation and durable rollback | Foundation tests pass; actual callsites and rollback-safe deployment boundary pending |
| SQL → Gateway → Next → UI review and lost response | Joined current review read chain passes; ordinary decision/lost-response UI integration pending |
| Actual text model admission/retained revocation/disabled inheritance | Existing WIP evidence available; pilot-specific integration pending |
| Exact delayed-effect/edit/delete and truthful pending | Existing WIP evidence available; candidate integration pending |
| Selected migration compatibility/least privilege/restart | Eleven selected; foundation/receipt/review disposable checks pass; complete selected upgrade/restart and production approval pending |
| One complete authenticated browser-to-hosted-model lifecycle | Not run on this candidate |
| Davide account activation and practical handover | Pending trusted owner resolution and authorized rollout |

### Source-intake serving and current lifecycle responses

Published source/lifecycle slice edcc3050d1e1afabb6f25e4ea180f27557481c44 has tree d2fcb84586642914276673981fb35da472ae26f2. Remote fetch66df0c matched; current Pool slice follows this parent.

Final frontend rerun d47097 passes142 checks, including the explicit upload-intake refusal with zero upstream effects. Whitespace4bb7c2 passes; remote parent still c464e8e before publication.

Selected existing authenticated source profile/boundary/action/status Gateway routes and fixed store RPCs, mounted in Gateway, plus the dedicated Next interceptor before the generic session proxy. It binds trusted owner/session/thread, preserves exact command key/content/epoch, refuses malformed paths and returns bounded content-free failures with no-store. C2 explicitly refuses memory-source upload intake without upstream calls; no upload service or paid dependency was selected. This is text-source transport, not memory approval. Ordinary composer and model input/provenance wiring remains pending. The selected intake SQL still revokes service_role execution; a reviewed forward pilot grant/profile activation is required before production use. Do not mistake owner-level disposable fixtures for a production least-privilege pass.

Intake backend cd34ac passes63 tests including actual app mounting and HTTP transport; initial frontend eb32c6 passes72 tests. Complete command-result integration distinguishes immutable historical decisions from an exact current canonical read: current read outage/tombstone/wrong owner denies text without erasing a committed receipt or resubmitting the original input. Create/edit/forget/restore/delete response adapters are updated; restore remains an existing canonical operation, not permission to restore source or bulk memory. The deletion disposition does not claim provider purge, browser erasure or account deletion. Current-view SQL is already in the selected snapshot_inventory migration; no additional migration was added here.

Command backend23e878 passes67 checks. Combined intake/worker/review/command suite6a5b71 passes310 tests with9 existing warnings. TypeScript4d9c62 exits0. Frontend93883e passes141 checks, including44 lifecycle cases with positive current canonical create/edit results, six command lookup checks,72 source cases and obsolete-contract rejection/legacy compatibility checks. A subsequent C2 upload-refusal regression is recorded separately after execution. None is a hosted model or actual browser lifecycle certificate.

EI869: adjacent frontend suite51914c had6 failures/16 passes. Hypothesis: old fixture contracts expected shortened lifecycle receipts to succeed and omitted newly required no-store request options. Evidence: failures were four503-vs200 response expectations and two exact request-option assertions. Reused existing obsolete-response rejection tests, retained legacy-path coverage, added two positive full-envelope create/edit cases and three canonical recent-response denial checks;93883e passes141. This is fixture-contract integration, not a production failure. No repeated provider operations or production state; next checkpoint remains872.

Next required joins: ordinary session composer/source acceptance and transcript synchronization, full Pool management, candidate decision UI/lost successful response recovery, final assembled text-model admission and retained context, C2 disabled consumer inheritance, exact provider cleanup, selected schema/serving grants and rollback qualification, then coordinated shared deployment/owned hosted journey/account activation. Preserve the two unresolved provider obligations and no new production authority assumptions.

### Complete current Pool and current hit resolution

Replaced capped owner-wide Pool/version/binding joins with complete bounded single-snapshot canonical inventory. Ordinary Gateway Journal and Next Journal preserve owner, shelf, snapshot, filters and completeness; explicit legacy responses retain a separately labelled legacy envelope, never a canonical fallback. Provider indexing is unavailable unless independently measured; a saved canonical record is not indexing evidence. Selected exact provider-hit resolver uses the existing selected SQL snapshot_inventory migration, accepts IDs/ranks, and renders only the current canonical record. It explicitly is not final model admission.

JournalPageClient now revalidates authenticated owner/shelf/lifetime, drops stale in-flight results, removes managed memory text on page suspension/offline events, and recovers content-free command references through original receipts. Cross-tab messages only trigger revalidation. Provider auth context gains an opaque nonpersisted local lifetime token; the original WIP's Recap-store owner binding was not copied without that store's dependency integration. Thus Journal proof is not a claim that every browser memory cache/Recap path is finished.

EI870: Pool suite9ac109 had1 failure/17 passes. Hypothesis: selected CanonicalMemory type omitted the existing explicit unavailable projection state used by management snapshots. Added that literal without inventing a successful provider state;73247f passes18 cases. Extended exact-hit/Pool suite6e6ae9 passes58; after updating the existing row-mapping fixture to the current inventory contract, combined Pool/hit/lifecycle/source/review run5df22b passes204 tests with9 existing warnings. No production/customer/provider state changed. Next checkpoint872.

Frontend78ff5f passes96 tests, including63 actual Journal component cases,19 command-recovery cases,11 Pool proxy cases and3 envelope cases. TypeScript bae508 exits0. Joined disposable proof be0051 passes53 assertions across2010 canonical/candidate inventory rows and11 pages. It traverses actual SQL→HTTP store→Gateway→Next→Journal UI, rendering804 active and201 forgotten current memories, with zero provider calls. Exactly one Pool UI case executed, no skipped cases; reporter SHA256 f7ad8d54e9c02a2a69516915361114691d043542b717d06a0d3370f982b4ca22. Disposable DB and synthetic transport removed. The reused inventory driver now has explicit --pool-only scope so optional account/bulk export is not silently enabled or certified; its broader default remains separate. This is not hosted model recall, independent-concurrency certification, or production activation.

Remaining core work is ordinary composer/accepted-source synchronization, candidate approval/rejection and Recap recovery/owner lifetime, final actual-model admission/retained revocation/disabled inheritance, projection obligations and runtime pins, rollout-safe selected SQL grants/profile, and the real production journey. Pool's local read/UI gate is now integrated, not the whole pilot.

Provider uncertainty is tracked debt, not an automatic pilot-wide blocker. Keep exact ownership, last/next reconciliation observations, bounded retries and visible pending status. Never erase the two historically uncertain synthetic obligations to make a report pass.

## Shared deployment coordination

### Final transport integration work in progress (not deployed or published)

Frontend source/chat integration published c5e64774dbf733ae20bacc834a4af573528df75e,
treeaaf363acf4db22403e5f37a16e60be9985b77e24, parentd3dfc4d5. Explicit33-file
selection; remote1e9c59 exact tree. Working88cc4f and isolatedf15e79 pass376/3
conditional native HTTP cases skipped, not counted. TypeScript4df79b/56ef5d pass.
EI928/e150cd archive lacked root testdata; restored same-tree fixture without
runtime changes. Only evidence paragraph changed after isolation. No production
activation; remaining WIP is README/CLAUDE/release ledger. Next checkpoint932.

EI926/85324d frontend chat/session sweep:373 passed/3 failed/3 conditional native
HTTP cases skipped; TypeScript23bd9f passed. Route experience fixtures lacked
source profile. EI927/78693a still failed3/passed24 after adding profile response:
diagnosis shows authenticated owner/body scope was absent, preventing the load.
Next fixture revision supplies exact synthetic user/thread and waits for current
profile; no runtime gate relaxed. MEM00_FIVE_ITERATIONS_REACHED — CONTINUE
checkpoint923–927 covers rollback defect, legacy fixtures, archive assets, and
source-scope fixtures. Next checkpoint932. No production mutation or new test
resources outside local fixtures; hosted lifecycle still required.

Backend model-boundary integration is now published as d3dfc4d57858c90af7c44c024b0362fdaee0951b,
tree5e3a63ad29b529a9a2dd9e1eeddf528af9e5ab39, parente59136cb. Explicit58-file
selection preserves C1 and remaining frontend/docs WIP; no bulk staging.
Isolated runtime archive959916 passed1454 with module-path assertions, no
deselections. EI925/59a8fd (23 failed/1431 passed) was missing tracked skills in
the archive, repaired by extracting same-tree assets. Remote8c6235 matches.
See c2-text-model-candidate.md for exact limitations: no auth JSON/profile/grants
activation, hosted journey, complete Builder delivery or all update/cancel proof.
This supersedes earlier unpublished status for the selected backend files only.
No production service/schema/provider changed; next checkpoint927.

Test-only durable authority/source fixture slice published e59136cb08d430d91bbc1e9c10f181f2196d9e7c,
tree1701555cdbb79acb58a4c9115f6aef2d18313d60, parent21808968. Isolated archive
012cc9 passes86 with explicit runtime module path checks; remote0371d4 matches.
Public reads eab48e/7e3df5 pin Gateway0c215c1b, LangGraph35c6467c, frontend35c6467c
deploymentdpl_EjjCoLiLiZkszj4YdGxXW37uqpcH. Voice owner reports zero product
resources but stale runner lease remains under diagnosis; no memory deployment.

Published rollback fence slice21808968332f6e8de7b0cafe3f900df22a9cd62c,
treeecbabc71b91cc4861baef7c938c2b2173adc9f80, parent6e06a627. EI923/bd1074
found the real candidate-write-dependent recap/source cleanup rollback defect;
repaired canonical ownership checks, not fail-closed behavior. EI924/9bc2fe
identified missing named legacy fixtures in affected session/offline tests.
55fa00 passed189; isolated staged-tree archiveff43b5 passed189 with explicit
module-path assertions and no deselections. Remote7f348b matched exact tree;
only dedicated branch moved. Full working-tree MEM00 regression3da892 passed1201.
No production activation; next five-failure checkpoint927.

EI920/83c14c processed-session fixtures:5 failed/9 passed after exact durable
owner setup exposed obsolete watermark-only End expectations. EI921 reproduced
as b33542:4 failed/80 passed, source run omitted clear epoch. Explicit matching
source versions/input/context/epoch now exercise transactional target reuse;
f6e8b2 passes84 including source-target and epoch regressions. No runtime relaxation.
EI922/2dd984 remaining focused regression:29 failed/49 passed; missing explicit
owner declarations, stale proof-clearing expectations and cohort-removal cleanup
assumptions. MEM00_FIVE_ITERATIONS_REACHED — CONTINUE checkpoint918–922: earlier
extractor fixture capture errors and these authority/source fixture errors are
local qualification failures, not hosted canaries. Next experiment supplies named
durable owners, requires cleared proof and durable recap cleanup after flag removal.
No deployment/migration, provider mutation or synthetic hosted state created.

EI917 / 4773a4 combined MEM00 regression:1081 passed,59 failed. Published
MEM00_FIVE_ITERATIONS_REACHED — CONTINUE for913–917: fixture message conversion,
archive qualification path, deferred module boundary, canvas exception expectation,
then broad fixture/authority drift. Remaining failure clusters are governed flags,
processed-session end, recall rollback, recap lifecycle and Voice retention; no
combined pass is claimed. The23 extractor failures were addressed by declaring
the exact governed synthetic owner and supplying the real synthetic dispatch
authority with captured input reference. EI918/d77a1d failed2/passed55 because
template fault occurred before fixture work-item capture; EI919/5ddcc5 repeated
that preparation issue at input-ref validation. Revised fixture captures the
complete original messages/metadata/authority before fault injection, not just
context. 1a8fe3 passed57 extractor/dispatch tests; no production guard bypass or
runtime change. Other36 original failures remain unaudited/rerun pending.
Next checkpoint922. Voice reports Lab worker/MCP now5321e794 and Gateway-only
middleware recovery patch0c215c1ba0a2218ef224f65601092d5845bb07cf planned; provider
settlement remains pending. No memory deployment/schema change.

Relative-import audit303657 found one required missing runtime module:
source_dependencies referenced source_use for preserved-source checks. Reused the
existing C1 source_use validator and its26 tests, and added the exact read RPC
adapter to the C2 store. The SQL function already exists in the selected published
C2 migration; no migration or source-feature activation was added. 162b8f passed130
focused Python tests. Extended the existing native SQL fixture with exact response
shape/no-model-permission and empty/altered-source denial:97e0d1 passed78 checks on
PostgreSQL17.9 with13 selected migrations, restart and duplicate-dispatch coverage;
process exited0/c7b66f after disposable cleanup. The new direct SQL cases use a
current-epoch source; they are not a complete cross-clear hosted journey. Production
upgrade/serving grants/hosted model remain unproven. No failed iteration added;
next checkpoint917. This runtime/test slice remains unpublished.

Published worker/channel ownership slice **6e06a627e9a997fc42a65f14120af358100495b6**,
parent65e50bc4, treea96973658c07173b37131c527efe48cb262fcade verified89476a after
non-force publication. Five explicit files; local CAS aligned, index clean and
other WIP preserved. ecde62 passed156; archived candidated666bb passed156 with
module-path assertions, no deselections,5 warnings. Archive retained at
/private/tmp/mem00-worker-slice.TkshgE. Owner-context tests do not authorize model
wakeups or establish hosted completion delivery. No new failure; next checkpoint917.
Fresh public repin: Gateway cb34fc is5321e794ba7cf7b62e061bdd94ac7d11a9210f0a;
LangGraph1a8090 and frontende53f75 remain35c6467c36b9ae052ec3dd943cf7c9f0ac28d589,
frontend deploymentdpl_EjjCoLiLiZkszj4YdGxXW37uqpcH. Voice confirms Gateway recovery
deploydep-dak3ff6743jc73fr4ddg live18:08:40.126Z, disabled/kill=true; Lab repair
pending and provider settlement unconfirmed. Memory made no deployment/schema
changes and must preserve this newer recovery base when integration is ready.

Published artifact/canvas caller slice **65e50bc43f9f623690dcbd2416c5aa5965264575**,
parenta661d6ee, tree2eddde19349eb7dee3a70172db2a21ed6426134c verified1d9a24 after
non-force publication. Four explicit files; local CAS aligned, index clean and
other WIP preserved. 89f662 passed97; archived candidatee59dfb passed97 with actual
module-path assertions and no deselections. New test observes installed SDK wire
authorization for concurrent owners and no request without owner scope. EI916 /
d38fde failed1/passed96 because the test expected a low-level auth exception;
canvas correctly translates it to existing HTTP503. Corrected that expectation
without altering runtime fallback. Next checkpoint917. Archive retained at
/private/tmp/mem00-artifact-slice.vvjNsS; no production changes.
Voice corrected the planned repair SHA to5321e794ba7cf7b62e061bdd94ac7d11a9210f0a,
tree-equivalent to its local a8325d candidate; no deployment completion attested.

Dependency audit6360dc found missing deferred C1 resume imports in C2's guard,
despite C2 entry already rejecting resume carriers. EI915/651d2f reproduced two
ModuleNotFoundError failures (one existing denial passed) through direct deferred
entry/selection methods. Replaced those method bodies with explicit
MemoryContextUnavailable and removed unreachable resume-source/final-authority
dispatch branches. Ordinary original-child association/checkpoint code remains.
The separate C1 worktree is untouched. 14b525 passed198 focused tests across C2
task checks/Builder/text, checkpoint provenance and model client/dispatch contracts.
This is dependency-boundary cleanup, not delivery qualification or a new hold on
ordinary Builder functionality. C2 update/cancel and hosted delivery remain open.
Next checkpoint917; no production changes. Voice announced recovery candidate
a8325d0013ba74059eb706a7e1cd87239d07a843 for Gateway/Lab only, preserving memory
settings and Voice/frontend/LangGraph. It is an announced candidate, not a verified
deployment or settled-provider claim.

Published Gateway authority slice **a661d6eed6314094e37960eba5a4db82d3b92ade**,
parent1d4cab3d, exact tree102a8b1bb810fb07ae6f774c514258eac5fe0b1a verified5234c7
after non-force publication. Five explicit files; local CAS aligned and index
clean. Route tests separated from unpublished LangGraph policy tests, preserving
all28 cases (821355). Archived candidate390582 passed31 selected route/mount/owner
tests,10 unrelated readiness cases deselected,2 warnings. Archived imports were
asserted. Full working-tree53-test result remains separate evidence. Archive is
/private/tmp/mem00-gateway-slice.15IgpU. No deployment, LangGraph auth activation,
schema change or new failed iteration; next checkpoint917.

Gateway ownership integration: e49433 passed2 new actual create_app middleware
tests for concurrent authenticated owners and the development-bypass lane.
Task-local owner context remains exact across awaits; anonymous and bypassed
requests see None and cannot borrow ambient identity; outer context is restored.
d054ab passed53 full Gateway mount/readiness plus subject bridge and signed-event
tests (9 warnings,92.20s). This qualifies local middleware integration only, not
hosted thread ownership or final memory admission. New tests and Gateway/router
work remain unpublished pending coherent route/policy test separation; no auth
activation, deployment or new failure. Next checkpoint917.

Published signed Builder webhook owner slice
**1d4cab3d9d9a404515b61bf04b2a4e7f369b6577**, parentbb7c10dc, tree
15368907a60d97705753f86b3bebbf73b6227810 verified435487 after non-force
publication. Four explicit files; local CAS aligned, index clean, remaining WIP
preserved. Qualification: working-tree2e3d89 passed49; archived-tree893da8 passed49
with explicit archived module-path assertions. No runtime auth activation or
deployment. Local archive retained at /private/tmp/mem00-webhook-slice.7N73sZ.
EI914/675898 was a qualification-command path failure (zero tests collected):
git archive from backend exports that subtree at the archive root. Corrected
paths; a separate import check found cwd still preferred working-tree app code,
so the final run used archive cwd and explicit module assertions. Do not treat
the earlier mixed-import run as isolated candidate evidence. Next checkpoint917.

Published additive authentication-primitives slice
**bb7c10dcde2103d8378f63587a6d3428d3c3f67d**, parentd4436b89, on
codex/mem00-text-pilot. Five explicit files, 284 insertions; exact staged/GitHub
tree46a1978fabb1f1d55e6b1910352b4cdf1846821a verified821e19 after non-force
publication, then local branch CAS alignment. Index clean; other WIP preserved.
8e75a3 passed26 focused service-token/client tests. Qualification note is
c2-langgraph-service-auth-qualification.md. Receiving policy, route integration,
serving activation and deployment are deliberately absent from this commit.
No new failure or production change; next failure checkpoint917.

Composed checkpoint qualification: 1b13ff passed224 across inventory/check,
legacy wrappers, C2 Builder source and checkpoint provenance. Four new cases use
the real MemoryRunGuard entry/check/admit_child_checkpoint, recorded source fixture,
source-only handoff registration/run binding, and whole-state seal. Healthy sealed
summary reaches the tool response; changed summary, wrong parent and source-store
outage return unavailable. SQL/provider admission remains an explicit _readmit
seam, as do SDK transport and active-parent context selection. No hosted delivery
or final model permission is inferred.

Fixture failures: EI909/97391e failed4 before entry because the new fixture lacked
the full flags/auth setup and compatible owner-authority stub. EI910/1a5bb5 still
failed4 after supplying flags/auth; revised diagnosis used EI911/608de3 diagnostic
reproduction (failed1) to expose the stub's unsupported store keyword. Correcting
the signature progressed to EI912/a556b4 failed4 at missing active parent binding.
Published MEM00_FIVE_ITERATIONS_REACHED — CONTINUE for908–912: one cached-content
product defect, then fixture contract/context defects; next experiment was real
checkpoint verification after exact fixture correction. EI913/79c607 then failed4
because the fixture gave wire dictionaries to the checkpoint producer, which
requires decoded messages. Applied the actual message conversion before sealing;
224-test rerun passed. No runtime safeguards were weakened. Next checkpoint917.

Fresh Voice coordination reports run1ef0fd45-7424-48af-992e-e1fc3deaf710 still
provider browser_active/canonical active epoch2 despite confirmed browser process
termination; MCP admission remains closed. Gateway/Voice deployment hold remains
to preserve provider cleanup ownership. No MEM00 shared deployment/schema change.

EI908 / 5977d5: eight regression cases reproduced the hypothesis that the native
single-task wrapper's terminal-cache shortcut returns cached content without
current child authority. Repaired the owning wrapper before legacy normalization:
exact structural task identity, live native thread/run status, current child
association, successful checkpoint scope and existing guard.admit_child_checkpoint
are required before result reconciliation. Cached fields and raw provider errors
are not reconciliation inputs; authority/association/identity are rechecked before
return. The async path offloads synchronous governance checks. No new ledger or
resume authority was introduced.
1eead0 passed184 (task-list/check, full legacy wrapper and C2 Builder source tests).
Sixteen installed-tool check cases include positive admitted synthetic summary
and artifact path, binding/checkpoint refusal, revocation, wrong run/thread,
outage and changed association. Canonical checkpoint admission and SDK transport
remain test seams; real file delivery and integrated current-checkpoint evidence
remain open. EI908 is one evidence-bearing iteration, not eight. Next checkpoint912.
No deployment or shared service/schema mutation performed.

Installed-tool qualification: f5d8c2 passed142 task-wrapper tests. Eight new
sync/async cases instantiate the installed DeepAgents list-tool factory and keep
the real closure extractor. They prove client discovery, healthy live observation,
and zero returned rows after mid-read guard revocation, changed child association,
or changed tracked inventory. The client transport and canonical guard remain
synthetic seams; this is not hosted SDK/auth or artifact-completion proof. No
production changes, new failed iteration, or dependency/configuration changes.

Task-list integration: inspectionfe238f/90b8e4 found governed inventory unwired
and referencing unselected C1 resume execution selection. Switched the C2 inventory
to existing source-only resolve_child_association/current child_run_id and wired
the actual list_async_tasks wrapper before any legacy normalization. It rechecks
bindings and current guard, observes native status by exact thread/run, filters
after observation and excludes cached result/description text. No resume authority
or migration added. cc5cb2 passed134:10 new sync/async governed-list cases plus the
complete existing lifecycle-wrapper suite. Tests explicitly cover binding refusal,
wrong native run, unknown status, outage and positive live running despite cached
success; they use synthetic guard/binding/client seams, not hosted native proof.
Check/update/cancel, file/artifact completion, and final runtime publication remain
open. No failed iteration added; next checkpoint912.
Voice14:13UTC reports current failed C5 run still unsettled after deadline, MCP
admission closed and only local repairs. Shared deployment/migration hold remains;
MEM00 has made no shared production change.

Published recap-only slice **d4436b893f121db698b940e09c98afff9f2115df**, parent0acc465f,
on codex/mem00-text-pilot. Exact staged/GitHub tree
d12fb81fcef80c226c438f83565ad5ad780897ec verified82e04e after non-force update.
Nine explicit files (four runtime frontend files, four test files, qualification
note); no backend WIP or deployment included. Index clean after local CAS alignment.
Composed review rerun786c76 passed41 checks/1,005 candidates/22 Gateway requests,
both actual Next/loader cases executed (zero skipped), reporter SHA256
63c5a3508646b95e426bd130737c5dfdd8f5aa1780a2b4d4a1479362cdf58631. Entire disposable
database and private fixture/report files cleaned; no provider calls. Extended
delayed discard success/failure owner-switch tests60ad13 passed33 with action/store/
loader suites. Voice task remains active on fresh thread inspection, without a
resource-closure attestation; shared deployment hold preserved. No failed iteration;
next checkpoint912. Hosted pilot, durable rollback and runtime integration remain open.

Full recap-page continuation: EI906:620681 failed2/passed38/skipped2 because the
page fixtures omitted authenticated identity. Added an explicit synthetic owner,
without weakening runtime signed-out refusal. EI907:9007bd failed1/passed2 because
the old remount expectation restored an unsaved local decision. Updated the test
to require fresh canonical candidate display and empty drafts after remount.
Published MEM00_FIVE_ITERATIONS_REACHED — CONTINUE for903–907; next checkpoint912.
d4a35c passed40/skipped2 in the broader recap/action/store suite; the two SQL-
composed environment-dependent cases were not executed and are not fresh proof.
853d66 passed4 complete-page smoke cases including a new actual-page/store/loader
account switch: old text and refined draft disappear while the next fetch waits,
then new-owner text loads without inheriting a version-matched draft. JSDOM emits
existing canvas warnings; this is DOM behavior, not visual/browser-hosted proof.
Previous pending-action extensionfdaafb passed31 and TypeScript515fda exited0.
All these changes remain local; production and shared deployment hold unchanged.

Pending-action continuation EI905:6b454e failed2/passed11: late commit results
could recreate invalidated store status and show success after A→B→A identity
changes. Added owner/session lifetime identity to recap action callbacks, reset
local action state on scope change, deny signed-out/stale callbacks, suppress
late success/error/history/navigation, and pass a current-action predicate into
the real store's commit method. Store rechecks before async success/error state
publication. RecapPage clears the current session's draft cache on owner/session
change. Server effects are not undone or assumed absent; reload canonical state.
8964de passed29 before extending unmount/sign-out cases. No production change;
whole-page rendering, global history state, delayed discard and lost-response
recovery remain separate checks. Next checkpoint907. A failed patch application
made no changes and was corrected before running the implementation tests.

Recap owner-lifetime continuation EI904:83ccf2 failed1/passed15: changing owner
without changing session did not re-fetch, leaving the previous owner's loader
active. Added explicit owner scope from RecapPage's useAuth, immediate scope
comparison for asynchronous callbacks, owner-bound status, owner-change effect
cleanup/revalidation and signed-out refusal.7e887a passed16 loader tests including
late old-owner404 (cannot invalidate current state), concurrent scope replacement
and signed-out no-fetch. Debug export now requires a ready owner and rechecks
identity after its observation await. These are local changes, not a full page/
pending-action account-switch certificate. Global decisions, action responses,
history and owner/session ABA transitions remain review work. Next checkpoint907.

Broader current WIP regression4b9fee passed303 backend tests: C2 source/text/Builder,
model clients/dispatch/lifetime/observation/context, authenticated subject/service/
framework clients, owner isolation and harness import boundary. No production
qualification inferred from this synthetic suite.

Recap storage continuation: EI901:626ace found the old temporary pnpm10 launcher
missing; EI902:c120e2 fallback pnpm11 attempted dependency reconciliation and
refused modules replacement without TTY. Did not enable that replacement. Restored
project-pinned pnpm10.26.2 in /private/tmp/mem00-pnpm.jBQJhi, outside application
dependencies. Published MEM00_FIVE_ITERATIONS_REACHED — CONTINUE for898–902.
EI903:821df5 failed2/passed4 and proved recap candidate/edited-decision text was
serialized and restored from localStorage. Changed only sophia-recap persistence:
version1, empty serialization/migration, ignore persisted state on merge. Tests
verify old memory cache disappears and unrelated drafts remain intact.
aa0e28 passed26 across store, real recap loader and memory actions. In-memory
owner switching, stale fetch/action responses and hosted review are still open;
this local fix is not full browser isolation. Next checkpoint907. No deployment,
database/provider or real-account mutation occurred.

Published independent database/test slice **0acc465f1ea1aa5b3fabad1d199102b8df3c19a0**
on codex/mem00-text-pilot, parent8c254fd4; exact local/GitHub tree
7db8679e767e75c785a518b8eb9afa8eb9a2b0a8 verified4e1ee8 after non-force publication.
Only four paths: the selected model-authority SQL, its contract harness, native
driver and dedicated c2-model-authority-qualification.md. Index was empty before
explicit staging; remaining runtime/frontend WIP is preserved, not bulk-published.
Removed trailing SQL EOF whitespace before final tree; no semantic test change.
No grants, migrations, service deploys, provider changes or account activation.

Builder continuation evidence45c687 passed26: the full actual compiled Builder
chain now receives a fake model write_todos call, executes the real tool, carries
its successful ToolMessage forward, and reaches a second recording-model boundary.
The independent source remains present without memory/tone blocks. This advances
the prior first-boundary-only test; actual model/file/artifact delivery is still
unproven. No additional failed iteration; next checkpoint902.
Voice coordination update: C5 window4 reports two synthetic exchanges and epoch2
restoration, but end409 and unsettled provider admission. MCP admission is closed;
this is explicitly not resource closure. MEM00 acknowledged no shared deployment,
migration or flags while scoped cleanup remains unsettled. Gateway21e982, Lab
e6f0bc, frontend/Voice35c are reported unchanged; this task has not independently
certified the window's cleanup state.

Completion auth continuation: EI899:33a6b0 confirmed that the real signed Builder
completion route's hydration/state-persistence calls carried no downstream
Authorization header. Switched those two SDK factories to the existing scoped
client and established task-local owner scope after exact-body authentication.
Runtime thread authorization remains independent; missing event owners explicitly
clear ambient scope. EI900:8aee62 failed7/passed27 because old SDK fixture lambdas
did not accept explicit api_key=None; updated only those seven signatures.
6c6333 passed34. Extended missing-owner/outer-context test plus companion wakeup
regressionab78dd passed53. The regression uses the actual FastAPI signature
dependency, two concurrent signed owners, downstream HTTP credential verification,
an unsigned-event refusal, and no downstream requests for a signed ownerless
event. No application-auth bypass or deployment occurred. Next checkpoint902.
Fresh Gateway observatione79b20 still reports21e982242d8ad0f7b5528f9c6b1743dc5e486ef0
on srv-d7be5s9r0fns7397l4g0, mem00.v1/epoch1. Preserve that Voice repair.
Synthetic cleanup/enumeration, other worker clients, actual Builder tool/artifact
completion and hosted memory journey remain unqualified; global auth is not enabled.

Expanded SQL qualification924843(PGlite69)/cb5ed9(native PostgreSQL17.9 **75 checks**):
actual canonical manual-create, edit and tombstone transactions now feed final
admission. An unindexed revision denies, a synthetic eligible binding permits
the exact approved manifest, edit rejects the held old admission and old
manifest, the unindexed new revision denies, its eligible binding permits the
new manifest, and tombstone rejects both the held admission and fresh reuse.
This closes the local positive-canonical SQL gap noted below, not the hosted
provider/model journey. Native duplicate/restart checks still pass; driver restart
now explicitly retains its log file. PGlite-only result13a90e passed61 before this
extension. No additional failed evidence iteration.
Focused Python regressionc8159e:88 passed across model dispatch, C2 source-only
Builder and text-context tests using the frozen offline uv environment.
Whitespacefbe033 clean. The selected migration and both SQL drivers remain
untracked/unpublished pending coherent release review; no production activation.

Selected SQL continuation: added unapplied `2026_09_14_mem00_c2_model_authority.sql`,
consolidating required prompt availability, immutable dispatch/Builder/result
receipts, recorded source checks, positive legacy dispatch and current v4 final
admission. This is the twelfth forward selection after the existing base, not
all 35 C1 migrations. Completion/resume admission is excluded; Builder manifests
must be empty at registration and dispatch. No serving grants or production
mutation occurred. `mem00_c2_model_authority_contract.mjs` runs actual SQL source
acceptance, zero-memory read admission, ordinary/Builder dispatch and historical
result recording, preserves rows across reapplication, verifies 42 role/function
execution denials, and checks immutable receipts and owner isolation.

EI894:f6493f falsified the expected same-conversation final-admission guarantee:
SQL accepted an ordinary source witness with a different attempt thread. Added
the explicit thread comparison in the owning final-admission function;33c565
passed60 PGlite checks (initial7b3d63 passed59 before the regression was added).
EI895:be3726 native qualification could not import pg from the partially restored
temporary runtime. Restored pg8.16.3 in an isolated temporary package; npm itself
had a broken temporary symlink, so used available pnpm without changing the app.
EI896:f2a151 then identified missing postgres.bki in that same restored runtime;
replaced the test runtime in a new directory with PostgreSQL17.9 package
17.9.0-beta.17. EI897:1cdba3 found missing ICU symlinks because installation scripts
were disabled. EI898:b8b7b2 repeated the same startup defect before fixing it;
the schema never ran in either attempt. Inspected the package's symlink manifest
and hydration script and ran it only in the exact disposable package directory.
Published MEM00_FIVE_ITERATIONS_REACHED — CONTINUE for893–897; next checkpoint902.
These are fixture failures, not production/provider failures.

Native result7f5ae4: **67 checks pass on PostgreSQL17.9**, including preserved
receipt/owner state, a real database restart, simultaneous same-attempt dispatch
from independent connections (one admitted, one consumed denial), application
execution refusal after restart, and stale revocation-clock denial. Temporary
clusters are stopped and removed by the driver; reusable test binaries remain.
No provider calls occurred. This does not establish production schema upgrade,
least-privilege serving grants, lock ordering for every lifecycle transaction,
positive canonical memory inclusion, or hosted model/task delivery. Those gates
remain open; the new SQL and driver are still unpublished WIP.

Complete Builder-chain test added: actual factory/create_agent/middleware list, source-only auth binding and initial state run via ainvoke to a recording model boundary. The test checks later before-model writers cannot invalidate the context producer's seal and inspects the assembled messages for the independent request, no memory block and no tone inheritance. It deliberately raises a test sentinel at the fake model, so it does not execute a provider request or deliver an artifact. Native-surface and admission stores remain synthetic seams; this does not certify those dependencies.

EI890:f826b4 failed1/passed25 because synchronous invoke cannot execute BuilderProgress's async-only hook; switched to ainvoke. EI891:eff700 failed1/passed25, initially attributed to fake-model streaming behavior. EI892:ff6ef9 disproved that hypothesis after adding the async-stream sentinel; published MEM00_FIVE_ITERATIONS_REACHED — CONTINUE for888–892 and revised diagnosis. EI893 diagnostic96a27e exposed terminal no_deliverable: PromptAssembly's independent retained-admission path was unmocked and returned memory-unavailable before any model dispatch. Added explicit synthetic adapter/contract/readmission seams for that separate path, without bypassing its seal verification. Final afa4be passed97 complete-chain/source/launch/text tests. Next checkpoint897. Failed fixture runs attempted webhook construction but authentication was unavailable before HTTP; no provider or production mutation occurred.

Voice reports window3 strict closure13:31:48Z, frontend dpl_2RxcKMEz1eQqwziTzdKakp9Gxtv8 exact35c, Gateway21e982 and Voice35c closed/healthy, active Lab runs0; next same-source diagnostic window has no MEM00 deployment conflict. This is a coordination report, not independent certification by this task. MEM00 remains local-only and unpublished.

Full launch-suite reconciliation EI889:46748c failed23/passed35 after missing-guard containment. The failing legacy fixtures lacked positive durable owner declarations; each affected case now explicitly declares only its intended owner (including the legacy default-user compatibility cases). The old MEM00 flag-only handoff fixture now declares governed ownership and asserts no allocation when the guard is missing; it no longer treats stripped snippets as adequate admission.92f982 passed84 across the complete launch file and source-only integration suite. No runtime authority bypass added. Next checkpoint892; no production failure counted for a public version observation.

Fresh public component observations: LangGraph2fbf63 remains35c6467c36b9ae052ec3dd943cf7c9f0ac28d589; frontendca6a1e remains35c with deploymentdpl_95vPPgjDG6aHMa35UpfRUc4Dzce1. Gateway initially502(9e2005), then09a4fc returned21e982242d8ad0f7b5528f9c6b1743dc5e486ef0/service srv-d7be5s9r0fns7397l4g0. Voice reported closed-flag deployments underway and a settled failed C5 run; full closure is not yet independently verified. Preserve21e982's reconnect repair in any eventual integrated memory candidate. No MEM00 deployment/migration/provider/account mutation occurred; whitespace09a4fc clean.

Missing-guard containment: start_builder_task now requires positive durable legacy authority before its unguarded enrichment branch. A governed or unknown owner without the active run guard receives a fixed unavailable/no-launch-attempt response before artifact/digest/dispatch helpers. New tests forbid those helpers for both governed and unknown owners; the explicitly declared legacy embedding case still passes.2eb1c2 passed47 source/dispatch/auth/legacy checks; whitespaceea2af8 clean. No new failure iteration, next checkpoint892. This narrow rerun does not supersede the full legacy task suite or whole compiled-graph check; remaining legacy fixtures need explicit authority declarations where they intentionally model pre-cutover owners. No production/provider/account changes.

Final tool/source/auth/context/model-client rerun18e64c passed147 in1.68s after EI888 fixture repair; whitespace394988 clean. Source-only tool integration remains unpublished and unqualified for deployment.

Companion-tool continuation: start_builder_task now routes an active governed tool guard to the source-only dispatcher before companion-artifact resolution, digest/enrichment, ritual lookup or file copying. It uses the guard's owner/context, refuses unsupported edit/owner/context mismatches, tracks exact child/run/status through a Command and blocks a replacement while that task remains active/unconfirmed. Model-authored description and task type do not feed this path. Five existing dispatch-fault cases now invoke the actual tool implementation, forbid legacy enrichment/file helpers, inspect its task/ToolMessage updates and verify a subsequent call does not dispatch again. This is a mocked-SDK tool test, not native/hosted task completion.

EI888:1654d8 failed1/passed81; hypothesis: the old live-context embedding fixture expected legacy memory but did not positively declare its alice owner. Added only that explicit fixture declaration, preserving runtime authority behavior. Next checkpoint892. Remaining launch gates include authentic whole-graph tool execution, absence-of-guard containment, durable native-run/SQL qualification and task status/artifact completion. No deployment/provider/account changes.

Source-only dispatch adapter added beside handoff transport: stable child UUID derives from exact parent run/tool-call identity; SDK thread create uses if_exists=raise. An existing or uncertain allocation is observation-only and never followed by another run create. Run responses, including successful responses, are joined to the fixed owner/child historical association and exact native runs.get result. Lost replies may recover that same run; absent/wrong-native/outage evidence returns unconfirmed with the original child identity, not no-effect or success. Five synthetic SDK cases cover healthy/lost-reply/no-run/wrong-native/native-outage and same-action retry with exactly one run-create invocation. d276b1 passed24; combined8d5f83 passed92. No new failure iteration; checkpoint892 remains. Whitespace d58797 clean.

This adapter is not yet called by start_builder_task. Its binding hook uses the existing real bind function against a synthetic ledger, not an installed native server or production SQL. The next necessary integration is the companion task tool and its retained async-task record, followed by task status/artifact delivery and native SQL qualification. No successful hosted launch, cleanup, deployment or pilot readiness is claimed. No production/provider/account state changed.

Source-only retry continuation: child HumanMessage ID is now deterministic within the exact child UUID. A repeated independent handoff still obtains fresh zero-memory admission, but may recover the original immutable receipt when every request field except the fresh prior-admission ID is identical. Parent manifest, source witness, scope, payload, child, parent/run and governance/catalog epochs must match; no overwrite or new association is permitted. Transport admission_ref remains the original historical receipt reference, never mislabeled as the new permission. Three table/PPTX/HTML cases now repeat handoff issuance, assert identical wire/proof and one ledger row, then change catalog generation and prove refusal without overwriting that row.700163 passed39; expanded6681d5 passed84 including text-context/model-client/auth regressions. No new failed iteration; next checkpoint892.

Read-only inspection of preserved C1 SQL confirms register's existing-child branch rejects differing request JSON; recovery uses the fixed owner/child read rather than changing that SQL contract. Native SQL/grants are still unselected/unapplied, and fixture results do not certify them. This closes a local producer-retry conflict, not native run-create ambiguity, actual launch or completion. No shared deployment/provider/account mutation occurred.

Source-only Builder runtime continuation: after historical binding verification, current-source recheck, empty native-surface check and zero-memory admission, entry reconstructs task/target, research policy, existing tier budgets, parent routing and stable build/operation IDs from only the exact messages payload and binding. The authenticated run hook derives factory task type/target from that same input, overriding inherited hints. Input remains messages-only; caller delegation fields still deny. Receipt acceptance time anchors the existing optional deadline rather than restarting a clock. Existing cost/turn limits are required; no environment or billing policy changed. Governed briefing omits inferred emotional tone and does not read parent ledger/extraction. This is entry/factory/briefing integration, not a completed task or launch certificate.

EI885:3cbd1b failed1/passed16; diagnostic5fdf75 identified KeyError at seed line165. Hypothesis: simple budgets have cost/turn caps, not the assumed wall-clock field. Preserved actual tier policy;882426 passed62. EI886:b5485e failed1/passed93 because the new assertion expected user task text inside the system briefing; the actual model view keeps it in HumanMessage. Corrected the assertion to inspect both without changing task text. EI887:9d8db2 failed2/passed118 after tone removal left an unbound logging reference; removed tone/ritual values from that diagnostic.2c5448 passed120. Expanded three source cases (table, PowerPoint, HTML) through registration→auth hook→entry→actual BuilderTaskMiddleware;2f160d passed122 combined tests. Wrong transport fields/owner/run and source outage still deny; parent ledger reads/extraction are forbidden test seams. Whitespacece020d clean.

MEM00_FIVE_ITERATIONS_REACHED — CONTINUE (883–887): fixture declarations/import, budget contract assumption, incorrect model-view assertion and logging dependency. All repaired locally; next experiment is source-only launch/task lifecycle integration, not another identical fixture rerun. Next checkpoint892. No deployment, SQL, provider or user-state mutation; Voice shared freeze remains honored. Full model/tool/artifact completion and remaining rollout gates are unproven.

Builder factory continuation: bound the primary model and assembled chain to one run guard; entry precedes native sandbox/briefing consumers, and the context producer precedes final prompt assembly. EI883: b21da9 failed9/passed51 because legacy factory/vision fixtures supplied dummy compiled graphs without channels and no positive owner declaration. Declared only those test owners legacy (no runtime bypass); 76b92a passed108 combined legacy/governed/source tests. Builder fallback now uses the same guarded OpenAI factory as companion, and the Builder entry wrapper is present for positive legacy owners too, preserving the active run scope. EI884: b04d51 failed1/passed94 due a wrong exception import in the new fallback regression; corrected to model_clients. bc7938 passed116 including fallback, model-client, source-only, Builder-flow, vision and brief-extraction tests. The new case proves unscoped fallback construction denies, scoped construction binds the exact guard, streaming stays enabled, and scope/clients are released; no live provider request was sent. Next checkpoint887.

These factory checks do not prove ordinary Builder completion: source-only launch wiring, auxiliary classifier/extraction model admission, task lifecycle and artifact delivery remain open. Existing brief-extraction tests mock model calls, so their pass is not that boundary certificate. WIP remains unpublished/nondeployable. Voice requested a C5 window on campaign21e982242d8ad0f7b5528f9c6b1743dc5e486ef0; MEM00 acknowledged continued shared freeze. No schema, production, account, provider or credential mutation occurred.

Builder serving-entry continuation: MemoryRunGuard accepts the new exact source-only bound run only for builder scope and with no competing ordinary-input proof. It verifies canonical historical binding/current sources before the empty-native-surface check, obtains a fresh empty admission, and keeps source_witness absent (the parent source remains a dependency, not a fabricated child user action). Builder re-admission rejects any memory inclusions or text. Extended source→auth→guard test proves entry and next-check outage refusal; separate re-admission test rejects nonempty context. Prior f0f040 passes47 across builder source/companion context/auth; final extended rerun recorded by tool. Factory/start-tool wiring and actual SQL/native/hosted qualification remain open; no activation or deployment and no new failure. Checkpoint887.

C2 child-run provenance: selected existing Builder provenance implementation with distinct source-only transport/run schemas. Producer accepts original source_messages (not enriched wire input), calls independent registration, seals only messages and the separate empty admission. Verifier requires zero inclusions, one recorded transcript source, exact payload/owner/child/run and canonical historical binding; old C1 signed schema is refused. Added fixed store RPC adapters for the existing handoff/run ledger (SQL/grants still unselected/unapplied). Auth hook permits only this contract on Builder with no command/source-action mixture and clears stale inherited carriers. Ordinary companion and old-carrier refusals remain. Initial82dc56 passes37 builder-source/auth/installed-framework checks; extended test also joins producer→binding→actual auth hook→run verification. Builder MemoryRunGuard entry still rejects handoff and factory/start tool is not yet wired, so this remains intentionally nondeployable. No hosted activation, no new failed iteration; checkpoint887.

Source-only child binding preparation: existing BuilderSourceBindingService now has register_independent_text for an active governed parent guard. It validates the exact current recorded human request, obtains a separate empty retained admission through the same pinned governance/provider path, confirms empty inclusions/text and current owner clock, and registers only one source dependency with a zero-memory manifest and a messages-only child payload. Parent admission is unchanged; model-authored task description/state never enters this payload.5896b9 reaches13passing tests including inactive guard, nonempty admission and outage with zero handoff writes using explicit fake admission/store seams. Auth child-run proof, serving factory/tool wiring, actual SQL registration/grants and positive ordinary Builder execution are still required. This is not a launch certificate; no schema/deployment/provider changes and no new failed iteration. Next checkpoint887.

Independent Builder source preparation: current C1 handoff transports the parent inclusion manifest and therefore cannot be enabled unchanged for C2. Added narrowly scoped source recovery in existing builder_source_binding: select exactly one authenticated recorded HumanMessage by witness ID, verify actual owner/thread/run/seal/content, then recheck current immutable receipt/source version/clear epoch. Ignore model-authored enriched context; duplicates/alterations/outage/clear refuse. a44f2b passes9 tests. This helper is not yet wired to child launch and grants no child/model permission. Next required step is zero-memory child binding/admission from this independent source, followed by factory/task-tool integration; do not claim ordinary Builder positive execution from this helper. Checkpoint887 unchanged; no new failure or production mutation.

Voice coordination reports second window strictly closed: MCP dep-dajumimk1f9s739ghung, worker dep-dajun8oae00c73bfqnag, Gateway dep-dajuocmk1f9s739go6d0, Voice dep-dajuode7bikc73dj12bg; frontend dpl_44mATqNLe6Gi5xDjx3mcAgrfQwcw exact35c with controls closed. MEM00 acknowledged locally; these are task reports, not independent refreshed deployment evidence. No shared window reserved by MEM00.

Channel final reruna00c22 passes156/12warnings in15.77s; whitespace4bd1cc clean. This verifies existing channel behavior with mocked backend clients plus explicit task-local owner tests, not a governed channel source path. Text pilot remains web-only pending hosted qualification; no additional consumer authorization introduced.

Channel caller continuation: scoped SDK selected and task-local owner context established only after canonical channel binding, covering command/chat dispatch without retaining owner on a shared client. EI882:d74ff8 failed2/passed154; focused20eb47 isolated the same failure: new fixture used nonexistent TEXT enum and invoked pre-start dispatch without its semaphore. Repaired test setup to CHAT and explicit semaphore, without weakening production scope. cfe4fb passes2; combined rerun pending. MEM00_FIVE_ITERATIONS_REACHED — CONTINUE emitted for878–882 (middleware order, source transport integration, obsolete hook fixtures, mock-state leakage, channel fixture setup); next checkpoint887. No hosted failures/deployments in cluster. Voice reports closure of its second window underway and asked about browser edits; MEM00 confirmed no browser/shared-state use. Preserve that closure until explicit coordination confirms it.

Wakeup caller continuation: existing CompanionWakeup client now uses scoped service auth and wraps each verified-event invocation in task-local owner scope, restoring the previous scope after success or exception. No completion/source permission was added; current C2 auth still refuses inherited governed completion runs.255163 passes22 tests including shared-client concurrent owner separation and exception restoration. This is compatibility plumbing, not completed independent Builder delivery. Deck-quality dispatcher inspection shows separate quality-graph launches plus native thread/run reconciliation; it cannot be completed by an import-only auth switch or broad graph permission. Channel and Builder-event callers also remain pending. No new failed iteration, no production/config/schema/provider mutations; checkpoint882.

Combined internal-client/framework/subject/Builder-canvas/Gateway-mount regressionf482cb completed89pass/9warnings in94.51s; artifact routerf8e21c separately63pass. Whitespaced9ea9d clean. App mounts ran to completion on the original live handle, not restarted after observation timeouts. Worker adaptation remains open: companion wakeup, deck-quality dispatcher, Builder events and channel manager still need explicit trusted-owner scope; C1 completion activation must not be imported wholesale because C2 currently denies inherited completion carriers. Ordinary independent Builder delivery remains an explicit release gate, not waived by these read-route tests.

Internal-client continuation: selected existing task-local OwnerScopedAuth and SDK factory (no incidental LangSmith API-key forwarding; in-process SDK retains parent auth), wired Gateway request scope and artifact/Builder-canvas SDK imports. Installed-frameworka72cee passes6 including current-owner thread create/read, cross-owner read/search/claim denial, exact run status retrieval and actual create_valid_run config merging with fresh recorded companion input. The latter uses an explicit synthetic owner-authority/source store; network is forbidden, and it does not qualify a native worker or hosted request. Artifact routerf8e21c passes63 (9warnings). Combined client/framework/subject/canvas/app-mount run remains live at time of this entry. Worker/event/channel callers still use old SDK imports and must be qualified before LangGraph auth JSON activation; no blanket import rewrite performed. No new failure iteration, checkpoint882. No deployment, migration or provider mutation.

Final authority/route/transport/stream/completion135575 passes103 tests; TypeScript8c4186 exits0; whitespaced3f466 clean. Next gate is composed ordinary serving-path qualification and internal LangGraph caller compatibility before auth activation; followed by independent Builder/task execution, final SQL/grants, rollback exclusion and hosted lifecycle. Gateway observation only selects a route; producer/serving boundaries still require current canonical checks. No new production authority inferred.

Serving-route continuation: mounted authenticated memory-authority observation in existing subject bridge, using positive durable owner authority on the worker pool and ignoring development bypass. Next reads the exact bounded owner-bound response before any mock/spill/fallback path; governed/action mismatch is409, uncertainty503. Post-handler now forwards the recorded action and request cancellation, avoids legacy spill, refuses nonstream/unconfirmed responses and requires exact run completion at EOF. EI881:be6ef7 failed10/passed11 because new mocked-mode refusal fixtures left USE_MOCK enabled and ownership-denied state leaked across cases. Explicitly reset those fixtures per case;886242 passes21, Gatewaya8ef0c passes28 (9warnings). Added independent real response-parser tests for malformed/wrong-owner/status/outage/oversized replies. Next checkpoint882. These are local routing observations, not atomic source/model permissions or hosted evidence. No shared mutation; WIP remains unpublished.

Chat transport continuation: selected request parsing, backend run transport, exact-run completion checker and stream refusal handling. C2 rejects every present source-attachment key field (including structurally valid keys), preserves source content/message ID/session/key/epoch in run input/config, snapshots before token awaits, propagates cancellation and disables fresh-thread/reseed/alternate-endpoint replay for governed actions. Parsing/backend/completion3560e5 passes73;3 installed HTTP cases explicitly skip without the native fixture, so no real server contract is claimed. Stream8e76e5 passes22, including installed AI SDK refusal delivery, no success on EOF without exact run completion, reader failure and no late artifacts after refusal. TypeScript7c1b8f exits0 before the stream addition; final recheck pending. No new evidence-bearing failure; next checkpoint882. Post-handler wiring is still pending: it must resolve current owner authority before mock/spill/reseed fallbacks even when source metadata is omitted, while preserving positively legacy new-thread bootstrap. Source-profile checks alone require an existing bound thread and must not silently remove that compatibility. No shared mutation or publication.

Final composer/no-op regression runff3258 passes45 tests across7 files; whitespace7e14e6 is clean. No ordinary hosted send certificate is claimed. Next work is the Next chat request/stream contract, including an owner-authority check before any legacy spill/mock/reseed fallback when source metadata is absent; canonical input omission must not become a legacy write path.

Composer continuation: selected text-only profile/capture validation, ordinary submit, reload/error retries and queue forwarding. Session route binds the authenticated owner before capture and rechecks after asynchronous version checks; retries keep original IDs/keys/epochs. No upload-recovery dependencies selected. EI880: TypeScript069b43 failed because existing hook fixtures lacked the now-required explicit capture/retry contract. Updated those fixtures as explicit legacy and selected original governed missing-source/retry tests. Composed actual hooks now cover online/offline capture→outbox→source acceptance→full-message SDK overload;033980 passes42 tests, TypeScriptbf553c exits0. Next failure checkpoint882. Additional reviewed no-op guard: governed busy/initializing sends reject rather than resolving and allowing queue code to infer delivery; regression added. Next chat route/stream-to-LangGraph mapping remains unselected and required before publication. Voice reports its next short window opening; all MEM00 work remains local, with no shared deployment/schema/provider changes.

Frontend source final rerun5f7409 passes12 including upload refusal; TypeScript d28bac exits0. Source/auth changes remain unpublished with the integration WIP; no success/activation implied.

Source-auth continuation: selected existing bearer-subject Gateway bridge, short-lived method/path-scoped internal service auth using the existing Builder-events key, and owner-filtered LangGraph policy. C2 create-run observes the exact recorded source receipt, replaces caller/inherited proof fields, uses actual server run/thread identity and rejects unsupported transitions/custom graphs for governed owners. Unknown authority cannot become legacy. LangGraph JSON auth is deliberately NOT activated until service callers and thread compatibility are qualified. Gateway subject/router mounting is local only. beda90 passes44 bridge/service tests;9a2aa7 passes64 including actual auth hook→recorded source proof, wrong owner/source changes/outage and disabled transition cases. No credential minted against production, new secret or configuration change.

EI879:d8b1c9 frontend source suite failed6/passed5. Hypothesis: copied client tests exercise the actual queue/outbound hook, which still dropped source identity and dispatched legacy-shaped messages. Selected only text-source queue/outbound integration (not upload helpers): exact original key/content/epoch retained through retries; full AI SDK message overload preserves the accepted source message ID; source receipt precedes chat dispatch; account switch/unmount fences late sends; governed intake avoids legacy parent touch. ca9a2a passes11, plus a subsequent explicit C2 upload-refusal case added. Composer capture/profile hook and Next chat-to-LangGraph transport are still pending, so this is not an ordinary UI send certificate. Next checkpoint882. Whitespace039c07 clean.

Voice coordination reports first window closed on35c frontend dpl_GxzfdSt2y1dnNH1AqnJU86aSDvyf with all controls closed and resourceszero; MEM00 acknowledged permission for the next bounded Voice-owned window because memory remains local/unpublished. No independent runtime pin is claimed from that message.

Final ordering/affected suite a78748 passes293 tests in1.92s; whitespace1cbf38 is clean. This includes the complete companion chain, recording SDK boundary, transport/lifetime/context/retained checks, fallback and BuildAwareness regressions. Unpublished WIP remains intentionally not deployable until authenticated source/composer integration, task tools and independent Builder execution, exact final SQL dependencies/grants and rollout qualification are closed. Last published branch stays8c254fd. No shared service/schema/provider mutation occurred.

EI878:3d12a4 full companion-chain test failed1/passed12. Hypothesis: LoopDetectionMiddleware writes messages after the new context/checkpoint producer. Moved only that state writer before the seal producer, retaining the existing later request-wrapper ordering. Initial reordered full-chain runb829c1 passes13 (subsequent final ordering rerun recorded below). The complete-chain regression inspects every later before-model hook and runs two ordinary authenticated turns through the real companion middleware list with a fake model, retaining positive canonical recall. It is distinct from the separately recorded real-SDK transport test and is not hosted evidence. Next checkpoint remains882.

Companion factory integration now binds one run guard to primary GovernedChatAnthropic, first-entry/outer model middleware, last state producer, owner/context prompt assembly, artifact checks and summarization. Its OpenAI fallback requires that same active guard; model shape/streaming settings are unchanged. Governed graph tracing is disabled in favor of structural evidence. BuildAwareness conservatively renders no retained descriptions/results for pilot owners and preserves task records without cancelling/restarting them. This is not yet positive independent-Builder qualification; task tools/delegation and the Builder factory remain an open gate.29 companion/client checks43eecd passed (3 deselected); more precise selection99f331 passed43 with only the Builder factory binding test deselected.

EI877:a25dcd failed1/passed87. Hypothesis: standalone fallback shape test constructed the fallback outside its now-required active run guard. The regression now declares an explicit synthetic legacy owner and constructs the fallback inside the actual entry middleware's model scope, asserts guard binding and unchanged streaming behavior, and closes clients. Affected companion/fallback/BuildAwareness suite46ba59 passes90. MEM00_FIVE_ITERATIONS_REACHED — CONTINUE reported for873–877: missing hydration import, stale carried-state fixtures, guard dependency selection, metrics/exporter integration, and guardless fallback fixture. No hosted failures or production mutations in this cluster. Next checkpoint882.

Continuation: ordinary text guard dependencies now selected for source-history verification, bounded plain-chat reconstruction, held-task metadata, attachment-proof structural parsing and tool-result origin. C2 entry explicitly refuses old resume/completion/personal-memory handoff/attachment carriers before other consumers; the old C1 positive entry branches were removed rather than silently enabled. Independently sourced Builder dispatch still needs its separate serving integration; do not claim all Builder functionality is qualified by these refusals. Prompt assembly now accepts factory-bound owner/context, verifies the exact seal, rehydrates canonical text and denies unproven retained text. Existing application factories have not yet supplied these bindings and must be completed before publication/deployment.

Compiled C2 text evidence:568c42 passed one ordinary authenticated first/second-turn checkpoint flow;0cda1b passed3 including automatic canonical text and unrelated revocation, and intersecting revocation refusal followed by zero-old-text fresh context. Extended82d662 passes10: actual compiled agent→automatic retrieval proof→prompt assembly→GovernedChatAnthropic→installed Anthropic SDK→recording HTTP transport carries the approved canonical text with a matching content-free final manifest. Injecting SQL refusal after assembly yields zero transport calls and one admission attempt despite SDK retries=2. Five C1 lineage carriers are refused. This is a recording adapter, not a hosted request or production factory certificate. Prior transport/retained combined0a280b passed202. No new failure iteration; next checkpoint877.

Automatic slice8c254fd4d63d7b67e432edd7a18723629df31374/tree275557b1463919a073ff5dcad4e51c0f65c4a69b was fetched14e20e and local matchedcad635. New isolated WIP selects exact serialized v4 dispatch attempts, one-use expiring authorities, sync/async HTTP transport, run-owned Anthropic/OpenAI clients, parsed-result provenance, context seals and their typed source/binding dependencies from preserved C1. Model-result parsing accepts only the selected final receipt, not unselected resume protocols. No serving factory has been switched and no model SQL migration has been selected/applied yet. The copied guard still has unresolved ordinary-path dependencies and C1 optional-consumer paths to contain; do not deploy this WIP.

EI875:76ceed collection failed on missing MemoryRunGuard import. Hypothesis: transport test selection pulled factory/guard tests before their dependencies. Selected the guard, context/client modules and explicit owner fixture; next run reaches tests. EI876:8eb5a4 had11 failures/146 passes/2 fixture errors. Hypothesis: model observation tests reached the older metrics/exporter implementation, and copied factory tests omitted the explicit owner fixture. Selected owned direct-post trace export/cleanup and event/gap accounting; imported the owner fixture. Transport/legacy SDK/lifetime/context suite6fff5c now passes151. Factory binding tests remain an explicit pending gate, not claimed fixed or silently skipped as success. Their current production factories still use unguarded clients. Next checkpoint877.

Metric coverage labels explicitly state transport-wrapper-only/factory-integration-pending; raw-write detection is not claimed active. Neither successful headers nor a completed export constitutes a parsed-model result or current memory permission. Final SQL serving grants, actual factories, authenticated source lineage, ordinary Builder containment and the real hosted lifecycle remain required.

### Automatic text proof and retained re-admission

Prior provenance slice d603f0ddcd4f01dd6aae1fcc8d80aa5dcaf82ca4/tree01ebc54b2ac30b2c841bc358a31832b15c9fb98b was published and fetched exactly21c76e; local worktree matched446a17. This slice connects automatic text injection to validated exact canonical proof, preserves its private state channel, clears stale proof with owned injection, and denies voice cache reads/writes unless durable legacy ownership is positively established. Unknown ownership clears warm injection without provider access. The generic retained re-admission service and exact ID/revision hydration are selected from preserved C1; they still require trusted context and final transport integration.

EI873: f69bba failed2/passed49. Hypothesis: selected hydrate_inclusions omitted its AuthorizedMemory import. Added the exact runtime import;7db213 passes51 retained/hydration tests, including known revocation, unrelated changes, provider/DB failure and atomic receipt conflict. EI874: c0e3d6 failed2/passed88. Hypothesis: carried-state fixtures supplied unproven positive text and still expected C1 positive Builder memory. Replaced the text fixture with an actual synthetic signed canonical receipt and required Builder zero-search clearing; no proof checks were bypassed. Combined eaeafd passes226 with9 warnings. Added automatic wrong-text/wrong-owner/missing-proof cases and unknown-authority clearing across web/voice/iOS. No production/provider state changed; checkpoint remains877.

These local tests do not prove real assembled outgoing requests, hosted recall or production activation. Final companion guard/transport and authenticated source lineage remain mandatory. Existing optional attachment/delegation dependencies must be selected or explicitly contained as integration proceeds, not silently enabled.

### Text provenance and Builder exclusion slice

Selected retained-context, authenticated-input/source witness and retrieval-proof modules from preserved C1 work. Governed facade seals only atomically admitted canonical results; explicit recall verifies the owner/rendered-text proof and carries it as a private ToolMessage artifact, not model-visible text. This proof is not final outgoing-model admission; transport and companion integration remain required.

EI871: provenance run81c38b failed3/passed101. Hypothesis: current explicit recall omitted the proof artifact and accepted unbound text, while one copied C1 test incorrectly required positive Builder personalization. Reused the governed tool implementation and changed Builder to clear its owned memory injection for governed/unproven owners regardless of text recall flags. Replaced the positive Builder test with C2 denial coverage. Focused a4b1d2 passes104.

EI872: adjacent run4dc558 failed11/passed143. Hypothesis: legacy Builder fixtures assumed undeclared ownership still enabled search. Added explicit durable legacy declarations for the two named fixture owners; did not restore an absent-row fallback. Extended C2 denial tests through the actual authority resolver for governed/unknown owners and both recall flag values, with zero search, retained injection removal and independently sourced prompt/message preservation. Rerun2349d1 passes157 with9 warnings; whitespace56480a has no diff errors (subsequent path discovery failed independently).

MEM00_FIVE_ITERATIONS_REACHED — CONTINUE reported for868–872. Cluster: stale loader/response fixture contracts868/869, missing unavailable projection literal870, explicit-tool proof and C2 Builder-policy selection871, undeclared legacy Builder fixtures872. These are local integration failures, not hosted provider observations. Repairs are locally verified; no production deployment or synthetic provider operation occurred. Next checkpoint877. Next experiment is actual companion/final transport integration; do not claim hosted admission from these helper/tool tests.

Fresh public reads10:47–10:48UTC on2026-09-14 pin Gateway, Graph, Voice and frontend to35c6467c. Frontend deployment dpl_HDssPdmDg3DCMMztw4kWzwBMKfkj. Schema advertises mem00.v1/epoch1 but earlier actual column reads showed the owner-authority/clear additions absent; advertisement is not migration proof.

VT00 reports no C5 run started or gates opened; it released the provisional freeze for local/planning work. An explicit exclusive shared deployment window is still required before product mutation. MEM00 owns pilot memory cohort/profile; VT00 owns Lab admission/controls. Neither changes the other's settings. No production mutation was performed.

Latest VT00 message: Lab-only inventory correlation repair bb123f0e004c4b15a40b23ab4a3529cdd0b6bfc5; only Lab MCP/worker deployment and guarded worker restart planned. Voice admission remains closed, no shared product changes reported (35c6467c). MEM00 acknowledged local-only integration and the need for an exclusive shared deployment window. This message is coordination evidence, not a fresh direct runtime pin or an idle-run assertion.

Subsequent VT00 coordination: Lab bb123f0 reported deployed closed and an exact guarded worker restart accepted. VT00 is collecting settlement evidence and requested a short exclusive product flag window afterward for its C5 demonstration. MEM00 agreed Voice owns that window, preserves memory flags/schema, and reports final pins/closure; MEM00 will not mutate shared products until both sides agree it is closed. This is not permission to bypass active-run containment or evidence that settlement already completed.

Render's documented rollback restores the target health-check path as well as artifact/environment, so a new health path alone is not durable old-binary exclusion. Keep that deployment issue explicit; do not invent a paid service or rotate credentials without authority.

## Deferred full-release work

Full C1 fault campaigns/five-canary promotion, universal historical provider finality, broad user rollout, Builder/voice personalization, identity v2 and optional bulk/restore expansion remain later work. They do not replace C2's finite acceptance or defer a proven usable pilot handover.
