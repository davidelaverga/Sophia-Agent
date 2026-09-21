# MEM00-C3 — current checkpoint

Updated: 2026-09-21 (after the P1 extraction-loop outage and the `46cd2302` release)
Mission authorization reference: user chat message adopting `04_LAUNCH_PROMPT.md` / `01_MISSION.md` §3, 2026-09-20. No signature fabricated.
Work branch: `codex/mem00-c3-first-use` @ `46cd23026838cce6fdae7995df6c566639c33891`
Current phase: **E — resumable; D1 unresolved, P1 outage closed**
Terminal status: **IN_PROGRESS — NOT `MEMORY_TEXT_PILOT_READY`**

Companion artifacts: `c3-first-use-proof.md` (E1–E7 matrix), `c3-defects.md` (D1, D2, retractions), `c3-actions.jsonl` (receipts).

## Product result

Phases C and D are complete and verified. E1–E3 pass. E4 is half-proven. E5–E7 are unattempted, blocked by a release-blocking defect. **Do not emit `MEMORY_TEXT_PILOT_READY`.**

## Live components (all directly observed)

| Component | Exact ID |
|---|---|
| Frontend | `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t` ← source `a5982c6`, `frontend/` **byte-identical to r8 `3aebc59a`** |
| Rollback target | `dpl_4TxUxd6Ee27JF8T42jre5f7Xz2W8` (`35c6467`) — Vercel Instant Rollback |
| Gateway | `commit_sha 46cd23026838cce6fdae7995df6c566639c33891`, `service_id srv-d7be5s9r0fns7397l4g0`, oregon, `/ready` = `ready` |
| LangGraph | `commit 46cd23026838cce6fdae7995df6c566639c33891` via `dep-daojnn3bc2fs73e9vosg`, `service_id srv-d7be5s9r0fns7397l4fg`, oregon, `/ok` = 200; `api_variant=local_dev`, `langgraph_api_version=0.8.1` |
| Memory contract | `mem00.v1`, epoch **1** |
| Voice | `voice_lab_enabled=false`, `kill_switch_engaged=true` — untouched |
| Supabase | `vlxnwmyvhchwbousrdzc`, healthy, us-west-1 |
| Mem0 | project `default-project` (Starter), namespace `sophia-memory-v2-2df20d06afbe4c27ab4b2413bcdeafd9` |
| LangSmith | **EU** `eu.smith.langchain.com`, project `Sophia` (note: a second, empty `"Sophia"` exists — do not confuse) |
| Governed owner | `CUyZxRFmDNONbR0eKqkJjTrJ2z8nkDKd` — governed, epoch 1 |

### Activation profile as deployed

`SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL` = `SOPHIA_MEMORY_COHORT_PRINCIPALS` = the owner's own account id; `PROVIDER_PROJECTION=true`; `CANDIDATE_LEDGER_WRITE=true`; Voice Lab principal `vt00-e1df2c74-…` (distinct ✅).

**Known deviation, accepted by the owner and recorded here:** the certification principal is the owner's real account rather than an isolated synthetic identity, so the cohort holds one id where the C2 runbook expects two (`<owner>,<cert>`). All five source-derived constraints are still satisfied, so the worker builds with projection. Consequence: acceptance artefacts share an owner with real memories — mitigated by marking every test record with "Tin Otter".

**Correction to the package:** `01_MISSION.md` §7 requires projection ON; the C2 coordinated runbook says it stays OFF ("a text pilot that began projecting would be a different release"). Live config already had it ON, and E3 cannot be proven without it. Owner decided: **projection stays ON**.

## Release window 2026-09-21 — P1 outage and the `46cd2302` rollout

Recorded at the request of Codex VT00-C5-R1, which held off deploying and opened no Voice/Lab surface during this window.

**Live component tuple at window close (all directly observed, 2026-09-21 ~16:20 CEST):**

| Component | Exact ID |
|---|---|
| Gateway | `46cd23026838cce6fdae7995df6c566639c33891` · `srv-d7be5s9r0fns7397l4g0` · `/ready` = `ready` |
| LangGraph | `46cd23026838cce6fdae7995df6c566639c33891` · `srv-d7be5s9r0fns7397l4fg` · `dep-daojnn3bc2fs73e9vosg` · `/ok` = 200 |
| Frontend | `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t` (fra1) — **unchanged this window**, not rebuilt or promoted |
| Memory contract | `mem00.v1`, epoch 1 |
| Voice | `voice_lab_enabled=false`, `voice_lab_kill_switch_engaged=true`, `voice_internal_auth_configured=true` — **untouched** |
| Voice Lab admission | `voice_lab_admission_ready=true`, `voice_lab_mutation_ready=false`, reaper `ready`/running |
| Supabase | `vlxnwmyvhchwbousrdzc` — healthy, idle, 0 active backends, 0 lock waits |

Deploy route: **Manual Deploy → "Deploy a specific commit"**, which deploys from any branch. Both services remain wired to Production Branch `codex/sophia-observability-v1`; that setting was **not** changed, and `46cd2302` was **not** merged into it. Gateway was deployed and confirmed `ready` *before* LangGraph, because LangGraph's DQ-2 startup audit POSTs to the Gateway and would fail spuriously against a restarting one.

### P1 outage — 22:08 UTC 2026-09-20 → 12:40 UTC 2026-09-21 (~14.5 h, both backends down)

**Root cause.** Extraction run `942f3f97-550c-49bb-82a2-49bbdfe7d311` was enqueued for session `ebd83dbc-2e26-4d1b-a345-9b716c6ac0b2`, which never left `status='resumable'`. Its source could therefore never be realigned, so `MemoryExtractionService.run_once` took the realignment branch, got `None` from `enqueue_finalized_session`, and **returned `True` anyway**. `MemoryGovernanceWorker._run` reads `True` as work and skips its poll delay entirely, and the branch never reached `fail_extraction`, so the run stayed `leased` and `sophia_memory_claim_extraction` re-leased it every iteration. The eight-attempt budget was never consulted.

**Blast radius.** ~1,344 PostgREST requests/second sustained; 4.57 M Postgres errors in 24 h; 4.9 % success rate; t4g.micro CPU pinned at 95 %; 17 backends convoying on `Lock/tuple`. PostgREST's connection pool saturated, so the Gateway's Voice Lab retention-reaper probe 504'd with `PGRST003` and fail-closed (`gateway_voice_lab_retention_reaper_probe_failed`), and LangGraph's DQ-2 `configured_build_mutation_store(...).probe()` fail-closed (`enabled DQ-2 requires the durable mutation transaction RPCs`). Both services then crash-looped and could not restart.

**Containment (owner executed all SQL; the agent was classifier-denied `[Modify Shared Resources]`).**
1. Superseded the poisoned run — `safe_terminal_reason='operator_outage_containment_2026_09_21'`. Necessary but not sufficient: it removed the discovery path, not the in-flight convoy.
2. `REVOKE EXECUTE ON FUNCTION sophia_memory_authorize_extraction_dispatch(text,uuid,uuid,uuid,text,text) FROM service_role` — broke the convoy immediately (18 → 0 active backends). Both services self-healed on their next restart with **no deploy**.
3. Grant restored after recovery; `has_function_privilege('service_role', …)` = `true` at window close.

**Collateral, owned.** Four legitimate backlog runs (sessions `534d30bf…` ended 2026-08-21 — the previously-recorded stranded session — plus `5d6c4f9c…`, `dc8aa777…`, `707ac996…`) exhausted their retry budget against the revoke and are now `failed_terminal` / `retry_budget_exhausted` at `attempt_count=8`. Transcripts and sessions are intact; only the automatic extraction was lost. **Whether these can be re-enqueued is unresolved** — `sophia_memory_enqueue_extraction` needs an `idempotency_key`, `request_digest` and `input_manifest_ref` that the pipeline derives as HMACs from real source state, and hand-crafting them would fabricate provenance. The two relevant unique indexes are *partial* on `extractor_input_ref` nullability and all four dead rows carry a non-null ref, so a worker-issued re-enqueue is likely permissible; this was not verified and must not be assumed.

**Fix shipped in `46cd2302`.** Record the durable failure when realignment queues nothing, so the existing 5 s→900 s backoff and eight-attempt budget bound the run. Causal regression proven by reverting the source change and observing both new assertions fail. Qualified on Python 3.12: `ruff` clean; 7265 passed, 168 skipped. Two failures in `test_local_sandbox_encoding.py` are **pre-existing and unrelated** — confirmed identical with the change stashed; tracked separately.

**Still open from this incident:** why session `ebd83dbc-…` never reached `ended`. That is upstream of everything above and would poison another run the same way.

## Phase C — how the ignored-build blocker was cleared

The package's route presumed an existing r8 deployment to apply the per-deployment override to. **None existed.** Sequence used: push branch → docs-only commit for a fresh SHA → deployment created and CANCELED by `exit 0` → **Redeploy with "Use project's Ignore Build Step" unchecked** → first real build → fix → **Production-target rebuild**.

- Project setting `exit 0` ("Don't build anything") was **never modified**.
- Production Branch remains `codex/sophia-observability-v1`. No DNS/protection/auto-deploy change.
- **"Promote to Production" was deliberately avoided**: 21 `NEXT_PUBLIC_*` values inline at build time, including `NEXT_PUBLIC_SOPHIA_AUTH_BYPASS` and `NEXT_PUBLIC_DEV_BYPASS_AUTH`. Promoting a Preview artefact could have shipped an auth bypass.
- **The frontend had never once built.** `exit 0` had been masking `database_tls_ca_required`, caused by `BETTER_AUTH_DATABASE_SSL_CA` missing from the Preview scope (owner added it). Not a code regression — the failing route is byte-identical to the commit that builds fine.

**Standing caveat:** production serves a deployment built from `codex/mem00-c3-first-use` while Production Branch is still `codex/sophia-observability-v1`. Auto-deploys remain blocked by `exit 0`, but if that ignore step is ever removed, a push to the production branch would rebuild the old lineage and replace this deployment.

## Open defects

**D1 (release-blocking)** — governed turns fail `confirmCompletion()` at SSE EOF; on tool-call turns the continuation is lost, leaving a dangling tool call that **permanently bricks the thread**. Latent until Phase D activated the governed code path. Full trace, ruled-out causes and candidate fixes in `c3-defects.md`.

**D2 (high)** — `memory.context.entry_denied → unavailable` correlated with LangGraph resolving `user_id=eq.default_user` and `platform=voice` on a text session. Correlation, not proof — no run-path log captured yet.

**Retracted** (do not re-investigate): "Journal UI broken" (it's a correct `visibilityState` guard) and "projection not happening" (Mem0 confirms both memories stored, `Active`).

## Access

Host is the Claude Desktop app; `02_PERMISSION_BOOTSTRAP.md` §3's CLI bootstrap is not executable and the settings seed was never loaded. Platform access is via the built-in browser pane.

Host-enforced denials encountered and **respected, not circumvented**: `[Modify Shared Resources]` (all production SQL writes — owner executed every one), `[Credential Materialization]` (env-var pages), `[Auto-Mode Bypass]` (driving APIs via page JS — that approach was abandoned entirely). Earlier `[Production Deploy]` denials did not recur on 2026-09-21; the agent performed both `46cd2302` deploys directly under the adopted standing scope.

Resolved since 2026-09-20: Python 3.12.14 via `uv` (full backend suite now runnable locally — 7267 collected); git push works over SSH with `id_ed25519_sophia_agent` (note `origin` is HTTPS and has no credentials here, so pushes must target the `git@github.com:` URL explicitly).

Still blocked: PR/CI/merge (no `gh`, no token). `sentrux` MCP fails to connect (`ENOENT: stdio`), so the CLAUDE.md Sentrux baseline/score gate was **not** run for `46cd2302`.

## Cleanup owed

| Item | State |
|---|---|
| `14c6a3f8-…`, `a9352106-…` canonical test records | **outstanding** — forget during E6 |
| Their 2 Mem0 projections | **outstanding** |
| Session `f1a7f011-…` | **stuck, should be closed** |
| Owner's 2 real candidates from `f7199e38-…` | **owner's decision — agent must not touch** |
| 6 pre-existing withheld candidates, 1 pre-existing canonical | untouched, correctly withheld |

## Budget

New variable usage: **~4 build-minutes + a handful of model turns**, well under the US$25 ceiling. No paid provider calls, no new services, no plan change.

## Exact next action

Both backends now run `46cd2302`, which carries the retained-revision fix (`5f4ed1cb`) that LangGraph had never received — E4's edit-then-recall half was previously unprovable in production for that reason. Re-run **E4 (edit → recall current revision)** against the live stack, then continue E5–E7.

Independently, and before any further E-phase runs: determine why session `ebd83dbc-…` never reached `ended`. Until that is understood, another session can strand the same way. `46cd2302` bounds the *consequence* (the run now retires after eight attempts instead of spinning forever); it does not prevent the *cause*.

Still unresolved from 2026-09-20: D1's `confirmCompletion()` failure at SSE EOF, and D2. The earlier "exact next action" — live-tailing `sophia-langgraph` during one governed text turn to read `POST /threads/{id}/runs/stream`, **without typing in the search box** (a search freezes the tail) — remains the right capture for both.

## Superseded assumptions

- `02_PERMISSION_BOOTSTRAP.md` §3's CLI bootstrap does not apply to this host.
- The per-deployment ignore-step override presumes an existing r8 deployment; none existed.
- A branch push introducing no new commit SHA does not trigger Vercel.
- "Promote to Production" is not a safe substitute for a Production-target rebuild when `NEXT_PUBLIC_*` differ per environment.
- Extraction correctly discards content framed as "not a real preference" — synthetic test facts must be category-shaped and stated plainly, marked by content rather than by disclaimer.
