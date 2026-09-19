# MEM00-C3 — current checkpoint

Updated: 2026-09-20
Mission authorization reference: user chat message adopting `04_LAUNCH_PROMPT.md` / `01_MISSION.md` §3, 2026-09-20. No signature fabricated, no historical authorization reattributed.
Git root: `…/pl/work/Sophia-Agent-publish`
Work branch: `codex/mem00-c3-first-use`, created at `3aebc59a` (r8), pushed to origin
Current phase: **C — compatible frontend release (in progress)**
Terminal status: IN_PROGRESS

## Product result

`MEMORY_TEXT_PILOT_READY` requires compatible production frontend/backends, real hosted memory lifecycle, verified Davide activation and handover. Frontend release is underway; D and E not started.

## Observed components

| Component | Exact ID | Observed at | Direct or source-reported? |
|---|---|---|---|
| Gateway | `commit_sha` = `3aebc59a27e8a8a381c915bc535fe041d8b2a17b`; `service_id` = `srv-d7be5s9r0fns7397l4g0` | 2026-09-20 | ✅ **DIRECT** — public `GET /ready`. Matches r8 exactly. |
| LangGraph + auth | `89e4eb83…`; `auth` key present in `3aebc59a:backend/langgraph.json` | 2026-09-20 | `auth` presence ✅ **DIRECT in git**. Live pin source-reported. |
| Frontend (production) | `dpl_4TxUxd6Ee27JF8T42jre5f7Xz2W8` → branch `codex/sophia-observability-v1`, commit **`35c6467`**, created Sep 14, state READY, target production | 2026-09-20 | ✅ **DIRECT** — Vercel API + deployment page + live `link:` headers agree. |
| Voice (unchanged) | `voice_lab_enabled=false`, `voice_lab_kill_switch_engaged=true`, `voice_internal_auth_configured=true` | 2026-09-20 | ✅ **DIRECT** via `/ready`. Not touched. |
| Memory contract | `memory_contract_schema="mem00.v1"`, `memory_supported_contract_epoch=1` | 2026-09-20 | ✅ **DIRECT** via `/ready`. Required input for the Phase D declaration RPC. |
| Supabase | project `vlxnwmyvhchwbousrdzc`; grants service_role EXECUTE 25→46 | — | Source-reported. Not yet inspected. Not rerun. |
| Mem0 / cohort | 0 governed owners; pilot dark | — | Source-reported. Not yet inspected. |

### Git anchors — verified against the live remote

| Ref | Live SHA | Anchor | Match |
|---|---|---|---|
| `codex/mem00-text-pilot` | `fdf6cf2d8bb1fda391d2c2ed0835989064a3a106` | R1 | ✅ |
| `codex/mem00-c2-integration-r8` | `3aebc59a27e8a8a381c915bc535fe041d8b2a17b` | R2 | ✅ |
| `codex/mem00-c2-integration-r6` | `89e4eb834e002d93abccb6144657d7fe50bd3f8e` | LangGraph | ✅ |

### Frontend candidate justification (causal, not assumed)

- `35c6467c` **is an ancestor of** `3aebc59a` → r8 is a strict fast-forward. No divergence, no cherry-pick risk.
- `git diff 35c6467c 3aebc59a -- frontend/` = 89 files, of which **49 are non-test product files**: `/api/memories` (+ `forget`, `restore`, `[memoryId]`), `/api/memory/commit-candidates`, `/api/memory/recent`, `/api/memory/commands/[key]`, Pool/recap envelopes, `RecapComponents`, `JournalPageClient`, `session/` orchestration hooks, `recap-store`. This is exactly the C2 memory surface.
- `frontend/package.json` and `frontend/pnpm-lock.yaml` are **unchanged** → dependency set identical, build profile stable, "no dependency upgrades" satisfied structurally.

## Access bootstrap

Host is the **Claude Desktop app** (no `claude` CLI). `02_PERMISSION_BOOTSTRAP.md` §3's `claude --settings … --permission-mode auto` route is **not executable here**; the settings seed was never loaded. Scope is adopted from the user's chat message only.

Access route: **the built-in browser pane**, in which the user signed in to all six platforms plus the app. No Chrome extension, no platform CLI, no MCP connector for any platform.

| Platform | Scope | Read | Mutation | Notes |
|---|---|---|---|---|
| GitHub | `davidelaverga/Sophia-Agent` | `VERIFIED_IN_SCOPE` | push `VERIFIED_IN_SCOPE` (SSH key `id_ed25519_sophia_agent` → authenticates as `davidelaverga`) | **PR/CI/merge `BLOCKED`** — no `gh`, no API token. |
| Render | Gateway `srv-d7be5s9r0fns7397l4g0` | Public `/ready`,`/health` ✅; dashboard session open | `CONFIGURED_NOT_EXERCISED` | |
| Vercel | team `sophia-30911edf`, project `sophia-agent-front` | `VERIFIED_IN_SCOPE` | `CONFIGURED_NOT_EXERCISED` | Dashboard SPA is slow and rate-limits (HTTP 429) under repeated reloads — prefer its JSON API over the session. |
| Supabase | `vlxnwmyvhchwbousrdzc` | session open, not yet exercised | pending | |
| LangSmith | **EU region** (`eu.smith.langchain.com`) — region discovered, not assumed | session open, not yet exercised | n/a | |
| Mem0 | `app.mem0.ai` | session open, not yet exercised | pending | |
| Sophia | `sophia-ei.com` | `VERIFIED_IN_SCOPE` — signed in, existing session visible | pending | |

### Local toolchain

- Node **24.21.0** ✅ matches the expected 24.x profile; Vercel project Node setting is **24.x** ✅.
- `pnpm@10.26.2` installed ✅ matches `frontend/package.json` `packageManager` pin.
- Python is **3.9.6**; `backend/pyproject.toml` requires **>=3.12**. No brew/pyenv/uv. Backend suite **cannot run locally**. Reusing r8's recorded 7,262-pass evidence is valid while backend contents are unchanged; any backend edit re-opens this.
- `sentrux` MCP server **fails to connect** (`ENOENT: stdio`). `CLAUDE.md` expects it for structural-change blast-radius checks. CI runs the same gate, so this degrades local pre-checks only — recorded, not worked around.

## Vercel release state — before any mutation

- Production branch: `codex/sophia-observability-v1` (**not** to be changed).
- **Ignored Build Step — Behavior: "Don't build anything", Command: `exit 0`** ✅ directly read from the settings form. This is the recorded blocker, confirmed.
- Every one of the last 20 production deployments is the same `35c6467` commit, many labelled "Redeploy of …" — the old-SHA-redeploy pattern the package warns about.
- `dpl_6fCqoMRMCGNMjVN2ou6M19WWuWQk` (Sep 18) is the mem00 line's only recent deployment: **CANCELED**, reason stated verbatim by Vercel as *"The deployment was canceled because the Ignored Build Step command is configured to skip this build."* Its source is **r5 `91a8007`** — the wrong candidate; redeploying it would have built r5.
- **No deployment has ever existed for `codex/mem00-c2-integration-r8`** ("No successful deploy, yet"), so the per-deployment *Use project's Ignore Build Step* override had no candidate to act on.

### Route chosen, and why

Push `codex/mem00-c3-first-use` and let Vercel produce a deployment whose source is r8's frontend tree, then **Redeploy it with "Use project's Ignore Build Step" unchecked** ([W7]) and promote. This leaves the project's `exit 0` setting untouched — no mutation window in which an unintended automatic production deploy could fire, and no restore step to forget. The production branch is never involved.

**Observation:** pushing the branch at exactly `3aebc59a` produced **no** Vercel deployment (confirmed over ~3 minutes via the deployments API). The push introduced no new commit SHA, and Vercel skips SHAs it has already seen. A docs-only commit on top supplies a fresh SHA while leaving `frontend/` byte-identical to r8 — verified with `git diff --quiet 3aebc59a <commit> -- frontend/`.

## Remaining gates

| Gate | Status | Next causal action |
|---|---|---|
| Current-state reconciliation | ✅ **done** for git + Gateway + Vercel; Supabase/Mem0/LangSmith pending | Inspect on entry to D |
| Compatible frontend live | **in progress** | Trigger build of r8 frontend tree, redeploy without ignore step, promote, verify served `dpl_` |
| Acceptance profile correct | not started | Needs Supabase + Render config |
| E1–E7 lifecycle | not started | Needs the frontend live first |
| Final code/CI hygiene | blocked | No `gh`/token; local backend suite blocked on Python 3.12 |
| Handover | not started | Downstream |

## Real blockers versus deferred issues

**Real, still open:** PR/CI/merge operations (no `gh`/token). Backend test execution (no Python ≥3.12). Neither blocks the frontend release.

**Not investigated (correctly deferred, nothing invented):** stranded 2026-08-21 session; three session-start 502s; historical 2,602 Postgres-error card; Voice Lab cleanup-fence obligation. All preserved as recorded, none touched, no cause asserted. Note the 502s were attributed in the release record to "the Vercel proxy, and the frontend there is still the old `35c6467c` build" — the frontend promotion may bear on them, so recheck after promotion rather than closing them now.

## Budget and outstanding effects

New variable usage: **US$0.00** measured / US$25 ceiling. One Vercel preview build (~1–2 build-minutes) is the only spend anticipated so far.
Owned synthetic records: none created.
Historical provider obligations: two uncertain Mem0 operations preserved under existing ownership; not inspected, not altered.
Voice cleanup obligations: not verified — **not assumed absent** because Lab is disabled.

## Exact next action

Commit this checkpoint on `codex/mem00-c3-first-use` (docs-only, `frontend/` untouched), push to trigger a Vercel deployment, then redeploy that deployment with *Use project's Ignore Build Step* unchecked.

## Superseded assumptions

- `02_PERMISSION_BOOTSTRAP.md` §3's CLI bootstrap does not apply to this host; the settings seed contributed nothing.
- The package's per-deployment Ignore-Build-Step route presumes an existing r8 deployment. None existed; one has to be produced first.
- A branch push alone does not trigger Vercel when it introduces no new commit SHA.
