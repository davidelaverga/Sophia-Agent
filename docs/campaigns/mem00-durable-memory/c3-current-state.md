# MEM00-C3 — current checkpoint

Updated: 2026-09-20
Mission authorization reference: user chat message adopting `04_LAUNCH_PROMPT.md` / `01_MISSION.md` §3, 2026-09-20. No signature fabricated.
Git root: `…/pl/work/Sophia-Agent-publish`
Work branch: `codex/mem00-c3-first-use`
Current phase: **C complete → D not started**
Terminal status: IN_PROGRESS

## Product result

`MEMORY_TEXT_PILOT_READY` requires compatible frontend/backends, real hosted memory lifecycle, verified Davide activation and handover. **The frontend release is done.** D (activation profile) and E (lifecycle) have not started.

## ✅ Phase C — compatible frontend live on sophia-ei.com

| Item | Value |
|---|---|
| Live production deployment | **`dpl_99vszUEXAXnZ5LP68EPKWJ3w843t`** |
| Source | `a5982c6` on `codex/mem00-c3-first-use`; `frontend/` **byte-identical to r8 `3aebc59a`** |
| Build | Ready, 1m 25s, Environment=Production, clean build (no cache) |
| Previous production | `dpl_4TxUxd6Ee27JF8T42jre5f7Xz2W8` / `35c6467` — **rollback target** (Instant Rollback) |
| Verified how | `curl` of the served domain: every asset references the new `dpl_`; old id absent. HTTP 200 in 0.44s; apex 308 → www intact; `/session` 200, `/journal` 200; title `Sophia – Voice-first emotional companion` |

Not a dashboard banner — the served domain was inspected after the change, per the recorded incident where a success banner masked a redeploy of the already-live SHA.

### How the ignored-build blocker was actually cleared

The package's route (per-deployment *Use project's Ignore Build Step* override) presumed an existing r8 deployment. **None existed** — Vercel reported "No successful deploy, yet" for `codex/mem00-c2-integration-r8`, and the only mem00-line deployment was **r5 `91a8007`**, the wrong candidate.

Sequence actually used:
1. Pushed `codex/mem00-c3-first-use`. A push at exactly `3aebc59a` produced **no** deployment (no new commit SHA). A docs-only commit `a5982c6` supplied a fresh SHA with `frontend/` and `backend/` byte-identical to r8.
2. Created a deployment from `a5982c6` → **CANCELED** by `exit 0`, exactly as documented. That canceled record is what gave the per-deployment override a correct candidate to act on.
3. Redeploy with *Use project's Ignore Build Step* **unchecked** → **first real build ever attempted** → **failed**.
4. Fixed the cause (below), rebuilt → Preview Ready, renders correctly.
5. Redeploy with **Environment=Production**, ignore step unchecked → Ready → live.

**Project setting `exit 0` was never modified.** Ignored Build Step remains Behavior="Don't build anything", Command=`exit 0`. Production Branch remains `codex/sophia-observability-v1`, unchanged. No DNS, protection or auto-deploy setting touched.

### Defect found and fixed — the frontend had never built

`exit 0` had skipped every build, so this was invisible:

```
✓ Compiled successfully   ✓ Finished TypeScript
Collecting page data ... Error: database_tls_ca_required
Failed to collect page data for /api/test-auth/login
```

- Thrown at `frontend/src/server/better-auth/database-tls.mjs:97` — `if (supabase && !ca) throw`.
- **Not a regression**: `/api/test-auth/login` and the TLS module are byte-identical between `35c6467c` (which built fine) and r8.
- **Not a runtime hole**: the route 404s unless `SOPHIA_E2E_TEST_AUTH === 'true'` (confirmed unset in Vercel).
- `export const dynamic = 'force-dynamic'` would **not** have helped: `config.ts` does `export const auth = betterAuth({ database: getBetterAuthDatabase() })` **eagerly at module scope**, and Next imports every route module during page-data collection.
- **Cause**: the Preview environment had `BETTER_AUTH_DATABASE_URL` (the throw requires a parsed Supabase hostname) but not `BETTER_AUTH_DATABASE_SSL_CA`. Owner added Preview scope to that variable; build then succeeded. The CA is a public trust anchor, not a credential, so this granted no new database access.

### Why "Promote to Production" was deliberately NOT used

The frontend inlines **21 `NEXT_PUBLIC_*` values at build time**, including `NEXT_PUBLIC_SOPHIA_AUTH_BYPASS` (11 refs), `NEXT_PUBLIC_DEV_BYPASS_AUTH` (9) and `NEXT_PUBLIC_SOPHIA_USER_ID` (4). Promoting the Preview-built artifact would have shipped Preview-scoped values — potentially an auth bypass — onto the live domain. A Production-target rebuild uses Production values instead. (`01_MISSION.md` §6: no "placeholder-auth build" as deployment evidence.)

**Standing caveat:** production now serves a deployment built from `codex/mem00-c3-first-use`, while the project's Production Branch is still `codex/sophia-observability-v1`. Auto-deploys remain blocked by `exit 0`, but if that ignore step is ever removed, a push to the production branch would rebuild the old lineage and replace this deployment.

## Observed components

| Component | Exact ID | Direct or reported? |
|---|---|---|
| Gateway | `commit_sha`=`3aebc59a…`; `service_id`=`srv-d7be5s9r0fns7397l4g0`; oregon | ✅ DIRECT — public `/ready` |
| LangGraph | `89e4eb83…`; oregon, Deployed; `auth` key present in `3aebc59a:backend/langgraph.json` | `auth` ✅ DIRECT in git; live pin reported |
| Frontend | `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t` / `a5982c6` (frontend ≡ r8) | ✅ DIRECT — served domain |
| Voice | `voice_lab_enabled=false`, `kill_switch_engaged=true` | ✅ DIRECT via `/ready`. Untouched |
| Memory contract | `mem00.v1`, **epoch 1** | ✅ DIRECT via `/ready` |
| Supabase | `vlxnwmyvhchwbousrdzc`, Healthy, us-west-1, MICRO | ✅ DIRECT — dashboard |
| Mem0 | project `default-project` (Starter); namespaces `sophia-memory-v2-2df20d06afbe4c27ab4b2413bcdeafd9` (active) and `sophia-memory-v2:mem00-cert:700f15ea-3961-5710-8506-7c8a4c9a97c3` | ✅ DIRECT — dashboard |
| LangSmith | **EU** (`eu.smith.langchain.com`), project `Sophia` (44 traces, 5% errors). A second, empty `"Sophia"` exists — do not confuse | ✅ DIRECT |

## Phase D — activation profile, derived from source (not the old recipe)

| Requirement | Enforced at | Failure |
|---|---|---|
| `SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL` set | `identity.py:13` | `memory_certification_principal_missing` |
| ≠ `SOPHIA_VOICE_LAB_TEST_PRINCIPAL` | `identity.py:16` | `memory_and_voice_lab_principals_overlap` |
| In `SOPHIA_MEMORY_COHORT_PRINCIPALS` | worker builder `:139` | `memory_certification_principal_not_in_cohort` |
| `SOPHIA_MEMORY_PROVIDER_PROJECTION` enabled | worker builder `:154` | projection reconciler never constructed |
| ≥1 of ledger-write / projection | worker builder `:133` | returns `None` — no worker at all |

Truthy = `1|true|yes|on`. Cohort = comma-separated. An owner outside the cohort resolves to **all-flags-off** (`flags.py:100`) — the isolation mechanism.

**The superseded "Davide-only cohort + projection=false" recipe would build a worker with no projection reconciler**, so approved memory would never reach Mem0 and E3 recall would fail while everything upstream looked healthy.

Contract epoch for the declaration RPC: **1**, schema `mem00.v1`.

The Mem0 namespace exposes a prior certification principal `700f15ea-3961-5710-8506-7c8a4c9a97c3` — **a candidate to reverify, not authority**.

## Access

Host is the Claude Desktop app; `02_PERMISSION_BOOTSTRAP.md` §3's CLI bootstrap is not executable and the settings seed was never loaded. Access is via the built-in browser pane, signed in to all six platforms.

| Platform | Read | Mutation |
|---|---|---|
| GitHub | ✅ | push ✅ (SSH `id_ed25519_sophia_agent`). **PR/CI/merge BLOCKED** — no `gh`, no token |
| Vercel | ✅ | ✅ exercised (build + production deploy). Deploy clicks require owner action — classifier denies `[Production Deploy]` |
| Render | ✅ | not exercised |
| Supabase | ✅ | not exercised |
| Mem0 / LangSmith | ✅ | not exercised |
| Sophia app | ✅ | not exercised |

Classifier denials encountered and **respected, not circumvented**: `[Production Deploy]` (deploy actions), `[Credential Materialization]` (env-vars page), `[Auto-Mode Bypass]` (driving APIs via page JS — abandoned that approach entirely).

Local: Node 24.21.0 ✅, pnpm 10.26.2 ✅. **Python 3.9.6 vs required ≥3.12** — backend suite cannot run locally; r8's recorded 7,262-pass evidence remains valid only while `backend/` is unchanged. `sentrux` MCP fails to connect (`ENOENT`); CI runs the same gate.

## Remaining gates

| Gate | Status |
|---|---|
| Reconciliation | ✅ done |
| Compatible frontend live | ✅ **done** |
| Acceptance profile correct | not started — needs Render env + Supabase |
| E1–E7 lifecycle | not started |
| Final code/CI hygiene | blocked (no `gh`; Python 3.12) |
| Handover | not started |

## Blockers vs deferred

**Open:** PR/CI/merge (no `gh`/token). Backend tests (no Python ≥3.12).

**Security finding, out of scope, flagged separately:** Supabase advisor reports 17 issues incl. CRITICAL *RLS Disabled in Public* on `turn_feedback`, `conversation_sessions_backup_20251127`, `conversation_messages_backup_20251127`, `emotion_scores_backup_20251127`. Pre-existing; spun out as its own task rather than folded into this release.

**Risk-ledger item closed with evidence:** the historical 2,602-Postgres-error card — current rate is **15 errors / 24h** (590 warnings). Not an active pattern; per §5 item 3 this is a bounded historical limitation, not a blocker.

**Still preserved, untouched, no cause invented:** stranded 2026-08-21 session; three session-start 502s (release record attributed these to the Vercel proxy in front of the *old* frontend — **recheck now that the frontend changed**); two historical uncertain Mem0 operations; Voice Lab cleanup-fence obligation (not assumed absent because Lab is disabled).

**Benign, checked:** `GET /api/memory/commit-candidates` returns 200 unauthenticated on both old and new builds — it is an API **schema descriptor** (`endpoint`/`method`/`description`/`body`/`response`), not user data.

## Budget

New variable usage: **~4 build-minutes** (one failed 1m03s, one Preview 1m28s, one Production 1m25s) / US$25 ceiling. No paid provider calls. No synthetic records created. No SQL run. No provider record altered.

## Exact next action

Phase D: read the Gateway service's current MEM00 env values on Render, resolve Davide's authenticated owner id from trusted records, then set a coherent certification-principal / cohort / projection profile satisfying the five source-derived constraints above.

## Superseded assumptions

- CLI bootstrap in `02_PERMISSION_BOOTSTRAP.md` §3 does not apply to this host.
- The per-deployment ignore-step override presumes an existing r8 deployment; none existed and one had to be produced first.
- A branch push introducing no new commit SHA does not trigger Vercel.
- "Promote to Production" is **not** a safe substitute for a Production-target rebuild when `NEXT_PUBLIC_*` values differ per environment.
