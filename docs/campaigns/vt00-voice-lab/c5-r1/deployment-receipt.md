# VT00-C5-R1 — deployment receipt

Window owner: Claude Code (MEM00-C3 agent), acting on the VT00-C5 coordination request.
Window opened: 2026-09-21 ~18:35 CEST · Window closed: **2026-09-21T17:02:30Z** (19:02 CEST)
Deployed code SHA: **`406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490`**

MEM00 files were not modified in this window. This receipt is the only file written.

## Live component tuple at window close (directly observed)

| Component | Exact ID |
|---|---|
| Gateway | `406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490` · `srv-d7be5s9r0fns7397l4g0` · deploy `dep-daom0f5bedkc73aq9f10` · 2m08s · `/ready` = `ready` |
| LangGraph | `406ff0a6…` · `srv-d7be5s9r0fns7397l4fg` · deploy `dep-daom262d0e5s73fgogug` · 3m20s · **Live** · `/ok` = 200 |
| Frontend | `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t` — **not redeployed** |
| Supabase | `vlxnwmyvhchwbousrdzc` — no migration, no schema or grant change in this window |

Deployed sequentially, Gateway first (12 min before LangGraph), because the DQ-2 startup audit in LangGraph POSTs to the Gateway and would fail spuriously against a restarting one. Route: **Manual Deploy → Deploy a specific commit**; Production Branch remains `codex/sophia-observability-v1` on both services and was not changed. `406ff0a6` was not merged into it.

## Preserved gates, verified after rollout

| Gate | Value |
|---|---|
| `voice_internal_auth_configured` | `true` — receiving authentication intact |
| `voice_lab_enabled` | `false` |
| `voice_lab_kill_switch_engaged` | `true` |
| `voice_lab_mutation_ready` | `false` |
| `voice_lab_admission_ready` / `protected_plane_ready` | `true` / `true` |
| retention reaper | `ready`, running, `last_error_type = None` |
| memory contract | `mem00.v1`, epoch `1` |

No activation, no run, no frontend/Voice/Lab redeploy, no migration, no Blueprint sync, no new service or spend.

## Independent review performed before rollout

Delta reviewed: `13eb09d3 → 406ff0a6` (VT00 change) and `46cd2302 → 406ff0a6` (Gateway's actual jump).

- **No infra delta.** `config.production.yaml`, `backend/langgraph.json`, both Dockerfiles, `pyproject.toml`, `uv.lock`, `render.yaml` and `backend/migrations/` are byte-identical across both ranges. No new `$VAR` reference, so no `resolve_env_variables` startup risk.
- **MEM00 untouched** by the VT00 commits, confirmed by path filter.
- `create_run` denies the new `sophia:voice-lab-thread` permission, so the lane cannot start a run and therefore cannot reach the companion, its tools or memory.
- `verify_authorization` is a domain-separated HMAC-SHA256 over the existing service signing key with `compare_digest`, exact claim-set equality, version pin, exact TTL and time-window checks, and a fail-closed catch-all. `authorize_thread` re-validates at use time and binds `thread_id` to the admission's `resource_id`.
- Every new branch in `sessions.py` is gated on `owner_id == SOPHIA_VOICE_LAB_TEST_PRINCIPAL`; for any other owner `thread_authority` stays `None` and the path is byte-equivalent to the previous revision.
- The change **removes** the last documented unsigned direct LangGraph caller (`_fence_langgraph_thread_cleanup_admission`, previously marked `KNOWN UNMIGRATED … will fail with 401`). Net strengthening of receiving auth.
- All three call sites of that now fail-closed fence pass `admission=`; none left behind.

## Gates NOT cleared — stated, not claimed

- **Sentrux versus main fails** with an inherited delta not yet isolated. `CLAUDE.md` makes this a blocking PR gate for merge. It could not be run here either: the `sentrux` MCP server fails with `ENOENT: stdio`. **This gate is not claimed as passed and still blocks merge of PR149.**
- Hosted backend CI was cancelled; the local scanner crashes. Neither was reproduced here.
- **Substituted gate, actually run:** full backend suite at branch tip `0085e5b4` (docs-only above `406ff0a6`, so identical code) on Python 3.12 — **7278 passed, 168 skipped, 2 failed**. The two failures are `test_local_sandbox_encoding.py::test_exact_fixed_image_command_preserves_baseline_provider_only` and `::test_fixed_image_manifest_rejects_input_outside_current_thread_roots`, both **pre-existing and unrelated**, independently confirmed present at unmodified HEAD with all changes stashed. Tracked separately.

## Observations recorded rather than acted on

- **This was not a no-op rollout.** With `SOPHIA_VOICE_LAB_TEST_PRINCIPAL` set in production, the new reserved-thread lane is authenticable. Voice/Lab product gates stay closed and the lane cannot start runs, but it is a new authenticated surface and is recorded as such.
- A LangGraph deploy of `8c5cf53` (`dep-daom228ae00c73c3ek80`, the 2026-09-17 EI930 merge) was started at 18:53:29 CEST and **Canceled** after 2.9s. It never became live; `406ff0a6` is the only Live deploy. Flagged in case it was unintended.
- MEM00-C3 remains `IN_PROGRESS`, not `MEMORY_TEXT_PILOT_READY`. Its open items are recorded in `docs/campaigns/mem00-durable-memory/c3-current-state.md` and were not advanced during this window.
