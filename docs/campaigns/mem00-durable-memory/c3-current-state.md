# MEM00-C3 — current checkpoint

Updated: 2026-09-20 (end of first working session)
Mission authorization reference: user chat message adopting `04_LAUNCH_PROMPT.md` / `01_MISSION.md` §3, 2026-09-20. No signature fabricated.
Work branch: `codex/mem00-c3-first-use`
Current phase: **E — blocked on defect D1**
Terminal status: **IN_PROGRESS — NOT `MEMORY_TEXT_PILOT_READY`**

Companion artifacts: `c3-first-use-proof.md` (E1–E7 matrix), `c3-defects.md` (D1, D2, retractions), `c3-actions.jsonl` (receipts).

## Product result

Phases C and D are complete and verified. E1–E3 pass. E4 is half-proven. E5–E7 are unattempted, blocked by a release-blocking defect. **Do not emit `MEMORY_TEXT_PILOT_READY`.**

## Live components (all directly observed)

| Component | Exact ID |
|---|---|
| Frontend | `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t` ← source `a5982c6`, `frontend/` **byte-identical to r8 `3aebc59a`** |
| Rollback target | `dpl_4TxUxd6Ee27JF8T42jre5f7Xz2W8` (`35c6467`) — Vercel Instant Rollback |
| Gateway | `commit_sha 3aebc59a…`, `service_id srv-d7be5s9r0fns7397l4g0`, oregon |
| LangGraph | `api_variant=local_dev`, `langgraph_api_version=0.8.1`, oregon |
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

Host-enforced denials encountered and **respected, not circumvented**: `[Production Deploy]` (all deploy clicks — owner performed them), `[Credential Materialization]` (env-var pages), `[Production Reads]` (typing into the Supabase SQL editor), `[Auto-Mode Bypass]` (driving APIs via page JS — that approach was abandoned entirely).

Still blocked: PR/CI/merge (no `gh`, no token). Backend suite (Python 3.9.6 vs required ≥3.12). `sentrux` MCP fails to connect.

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

Live-tail `sophia-langgraph` on Render **without typing in the search box** (a search freezes the tail), send one governed text turn, and read the `POST /threads/{id}/runs/stream` lines to establish whether `Content-Location` is emitted and whether the run carries the correct `user_id`. That single capture settles D1 and D2 together.

## Superseded assumptions

- `02_PERMISSION_BOOTSTRAP.md` §3's CLI bootstrap does not apply to this host.
- The per-deployment ignore-step override presumes an existing r8 deployment; none existed.
- A branch push introducing no new commit SHA does not trigger Vercel.
- "Promote to Production" is not a safe substitute for a Production-target rebuild when `NEXT_PUBLIC_*` differ per environment.
- Extraction correctly discards content framed as "not a real preference" — synthetic test facts must be category-shaped and stated plainly, marked by content rather than by disclaimer.
