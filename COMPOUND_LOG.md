# Sophia — Compound Learning Log
Every merged PR appends an entry here. This file is the team's accumulating institutional memory.
---
## Entry Format
```
## YYYY-MM-DD · [component] · PR #[N]
**Author:** name · **Track:** backend | voice | frontend · **Spec:** docs/specs/0X_name.md

### What Changed
- Bullet list of changes

### What We Learned
- Insights, surprises, gotchas

### CLAUDE.md Updates
- Any additions or corrections made to CLAUDE.md as a result of this PR (or "None")

### Skills Created / Modified
- Skill files added or changed (or "None")

### GEPA Log Entry
- If a prompt file changed: before behavior → after behavior, tone_delta (if measurable), trace pair available (yes/no)
- If no prompt file changed: "N/A"
```
---
## Log
<!-- Append new entries below this line -->

## 2026-05-07 · [phase-2-telegram-memory-handoff] · PRs #[pending]
**Author:** Claude Code (with Davide) · **Track:** backend + frontend · **Spec:** `~/Desktop/sophia_async_migration_telegram_diagnostic_spec.md` (Phase 2) + plan at `~/.claude/plans/users-davidelaverga-desktop-sophia-asyn-peppy-riddle.md`

### What Changed
- **Telegram session-end pipeline** ([backend/app/channels/telegram_session_tracker.py](backend/app/channels/telegram_session_tracker.py)). Mirrors `inactivity_watcher` but keys on `chat_id`. On 10-min idle: mints a fresh `session_id` (UUID4 hex) + persists a `SessionRecord`, fires `run_offline_pipeline`, calls `_pause_tracked_session`, then enqueues the review notification. Activity is registered from [`backend/app/channels/manager.py`](backend/app/channels/manager.py) (Telegram-only branch). Watcher started/stopped in the gateway lifespan alongside the existing web watcher.
- **"Memories ready" notifier** ([backend/app/channels/telegram_review_notifier.py](backend/app/channels/telegram_review_notifier.py)). Async function the tracker awaits. Resolves the running Telegram channel via the new public `ChannelService.get_channel(name)` getter and calls `TelegramChannel.send_review_notification(...)` (added in [backend/app/channels/telegram.py](backend/app/channels/telegram.py)). Two delivery modes: a Telegram-attested `LoginUrl` button (default) or a one-time-token plain URL (fallback when `/setdomain` isn't configured). Message body capped at 4096 chars via the existing `_truncate_for_telegram` helper. Cross-loop hop reuses `_run_bot_call_on_telegram_loop` so bot calls run on the polling loop.
- **Reverse-binding index** in [backend/app/gateway/telegram_link_store.py](backend/app/gateway/telegram_link_store.py). New `_bindings_by_telegram_user_id` dict + `resolve_user_id_by_telegram_user_id()` lookup. Maintained from `bind_chat`, `_install_binding_locked` (rehydration), `unbind_chat`, `unbind_user`, and `clear_all`. Picks the freshest binding when a single Telegram user has multiple chats.
- **Frontend handoff route** ([frontend/src/app/api/auth/telegram-login/route.ts](frontend/src/app/api/auth/telegram-login/route.ts)). Verifies the Telegram HMAC payload (key = `SHA256(TELEGRAM_BOT_TOKEN)`), validates the `session` query param against a UUID-shape regex (no open redirect), enforces a 5-minute `auth_date` window via `crypto.timingSafeEqual`, sets a 60-second `sophia-telegram-handoff` correlation cookie, and 302-redirects to `/recap/{session}?next=/recap/{session}&from=telegram`.
- **Plain-URL fallback route** ([frontend/src/app/api/auth/telegram-token/route.ts](frontend/src/app/api/auth/telegram-token/route.ts)) calls a new internal gateway endpoint [`/api/sophia/internal/redeem-telegram-review-token`](backend/app/gateway/routers/telegram_review.py) (guarded by `X-Sophia-Internal-Token`) which validates the token via the existing `pop_link_token`. Closed-by-default — if `SOPHIA_INTERNAL_TOKEN` is unset, the endpoint returns 503.
- **AuthGate `?next=` plumbing** ([frontend/src/app/components/AuthGate.tsx](frontend/src/app/components/AuthGate.tsx)) calls a new [`resolveSafeCallbackURL`](frontend/src/app/lib/auth/safe-redirect.ts) helper that prefers a same-origin `?next=` value and falls back to `pathname` (intentionally stripping the query string to avoid echoing unsafe `?next=` values). Same-origin validation rejects protocol-relative, scheme-prefixed, backslash-injecting values and anything over 256 chars.
- **Tests added (145 pass; 116 backend + 29 frontend).** Reverse index: 8 cases incl. rehydration. Tracker: 12 cases incl. concurrent chats and async failure isolation. Notifier: 10 cases incl. fallback-mode URL construction. Send helper: 6 cases incl. LoginUrl vs plain-URL button shape. Internal redeem: 7 cases. HMAC verifier: 13 cases incl. timing-safe length-mismatch handling. Safe-redirect: 11 cases. Login route: 5 end-to-end cases incl. tampered-hash and expired-auth_date rejection.

### What We Learned
- **The auth fence is two-token deep**: Better Auth session cookie (Google OAuth) + a separate `sophia-backend-token` httpOnly cookie minted by a "legacy bridge" Next.js route. Trying to "skip Google" from a Telegram-attested payload requires a Better Auth plugin that mints a session via `auth.$context → internalAdapter.createSession(userId)` + `setSessionCookie(ctx, ...)`. We deferred that to a follow-up — this PR ships the simpler "verify HMAC, redirect with ?next, let AuthGate handle Google sign-in" path because the user explicitly accepted that fallback behavior in the original ask. Telegram-attested-login-without-Google is the next optimization, not a blocker.
- **Closed-by-default for shared-secret endpoints**: when `SOPHIA_INTERNAL_TOKEN` is unset, `_check_internal_secret` returns 503 instead of accepting any caller. The naive read ("if there's no expected value, no value matches → reject") was right and the test (`test_unset_secret_returns_503`) caught the explicit branch where I needed to handle empty-expected separately.
- **`pathname + search` is the wrong fallback for callbackURL**: if the current URL contains an unsafe `?next=//evil.com`, echoing the full pathname+search to Better Auth round-trips the unsafe param back. The unit test caught this immediately (vs. only catching it via review). Fix: drop the search entirely from the fallback. Cheap win, would have shipped a quietly bad redirect otherwise.
- **`crypto.timingSafeEqual` throws on mismatched-length inputs.** Solution: pre-check `expectedHash.length !== hash.length` before calling, so a malformed `hash` query param (e.g. `?hash=deadbeef`) returns `invalid_hash` instead of an unhandled exception. A single try/catch around the call would also work but length-checking is cheaper and more honest about what we're doing.
- **The session-id idempotency guard cuts both ways.** `run_offline_pipeline`'s `processed_sessions` set prevents double-processing — but it also silently no-ops on a *reused* session_id. That's why the tracker mints a fresh UUID4 per chat per inactivity window rather than reusing some stable `(chat_id, day)` key. Documented in the tracker docstring.
- **Cross-loop bot calls are a recurring pattern.** PTB-bot internals are loop-affine to `_tg_loop` (the polling thread's loop). Anything dispatched from the main gateway loop has to hop via `_run_bot_call_on_telegram_loop`. This is the third place that uses the same pattern (inbound file reader, builder completion, now review notification). Worth extracting if a fourth shows up.
- **`pytest.mark.anyio` (not `asyncio`) is the convention here.** Setting up async test plugins is a one-line difference but a five-minute debug if you guess wrong.

### CLAUDE.md Updates
- backend/CLAUDE.md: added a "Telegram → web memory review handoff" paragraph documenting the new flow, the BotFather `/setdomain` requirement, and the `TELEGRAM_REVIEW_USE_LOGIN_URL` fallback knob.
- .env.example: documented `SOPHIA_WEB_BASE_URL`, `TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED`, `TELEGRAM_REVIEW_USE_LOGIN_URL`, `SOPHIA_INTERNAL_TOKEN` with usage guidance.
- frontend/CLAUDE.md: no changes needed (auth architecture already documented; this PR didn't change it).

### Skills Created / Modified
- None.

### GEPA Log Entry
- N/A (no companion / builder prompt files changed).

### Active diagnostic breadcrumbs (keep)
- `telegram_session_tracker.session_started chat_id=… user_id=… session_id=… thread_id=…` — fires on each new tracked session
- `telegram_session_tracker.idle chat_id=… user_id=… session_id=… thread_id=…` — fires when the watcher detects a chat past its window
- `telegram_review_notifier.no_base_url …` — fires when the bot can't construct a review URL because `SOPHIA_WEB_BASE_URL` is unset (= silent no-op, deliberate)
- `[Telegram] review notification sent chat=… session=… use_login_url=…` — bot-side success log

### Post-PR follow-ups (May 8, end-to-end live)
After the initial PR landed, six follow-up commits made the flow actually render in production. Three of them are load-bearing lessons worth carrying forward:

- **Offline pipeline must accept three message shapes, not two.** `_serialize_messages` now handles (a) LangChain `BaseMessage` objects (`msg.type` / `msg.content`), (b) LangChain JSON-serialized dicts from `GET /threads/{id}/state` (`{"type": "human", ...}` — no `role`, and `content` is either top-level or nested under `data.content` depending on the wire encoder), and (c) channel-adapter raw dicts (`{"role": "human", "content": ...}`). The dict branch reads `msg.get("role") or msg.get("type", "")` for role and falls back to `msg["data"]["content"]` when top-level `content` is `None`. The original PR only handled (a) + (c); the LangGraph HTTP wire shape silently dropped every Telegram message at `extraction._format_transcript`, producing 0 Mem0 candidates from real conversations.
- **`recap_artifacts: {}` not `null`.** The frontend recap mapper early-null-returns on `null`, so the loader never reaches `status='ready'` and the user sees "Recap not found" even though the gateway returned 200. Truthy empty dict lets hydration synthesize a payload from session metadata and merge Mem0 candidates from `/api/memory/recent`. Backstop in `useRecapArtifactsLoader` synthesizes the payload from session metadata when the gateway returns a sparse envelope, so any future writer that emits `null` or omits the field can't re-trigger the bug.
- **Sparse recaps need a retry window before being marked reviewed.** Telegram-originated recaps land sparse (no LLM-synthesized takeaway / reflection) until Mem0 candidates hydrate. The loader keeps retrying until either the candidates arrive or the retry window expires; only then do we mark the recap reviewed.

Other fixes (terse): codex P1 — `register_activity` moved to AFTER `runs.wait` so stale-thread recovery can't strand the tracker on an old thread_id (afb7265a); codex P2 — declined LoginUrl (no `hash` param) now 302s to `/recap` with `from=telegram` instead of returning 400 (78c96b9b → refined in c9a3667b which also fixed Vercel `Buffer→BinaryLike` typing under newer `@types/node`).

### Open follow-ups
- **Skip Google entirely for already-bound users**: write a Better Auth plugin (`frontend/src/server/better-auth/plugins/telegram.ts`) that exposes a server-only endpoint guarded by `X-Sophia-Internal-Token`. The endpoint calls `ctx.context.internalAdapter.createSession(userId)` + `setSessionCookie(ctx, {session, user})` and returns the Set-Cookie headers. The frontend redeem route forwards those headers + 302s to `/recap/{session}`. This is the "fully seamless" UX the user originally asked about. Deferred only because of the Better Auth plugin lift.
- **Telegram session "active conversation" detection** could be tighter than 10 minutes — a user actively typing replies should reset the timer immediately, but if they go silent for >10 min mid-conversation we currently end the session. Match the web behavior for now; revisit if the alpha shows it's wrong.

---

## 2026-05-07 · [phase-1-async-migration + phase-3-lite] · PRs #104–#116
**Author:** Claude Code (with Davide) · **Track:** backend · **Spec:** `sophia_async_migration_telegram_diagnostic_spec.md`

### What Changed (consolidated across the PR train)
- **Phase 1 — async-subagent migration.** Replaced the legacy sync `switch_to_builder` + `SubagentExecutor` + `BuilderSessionMiddleware` + `_install_fetch_last_ai_patch` stack with deepagents v0.5 native `AsyncSubAgentMiddleware`. Companion now dispatches builder work via a new wrapper [`start_builder_task`](backend/packages/harness/deerflow/sophia/tools/start_builder_task.py) over LangGraph SDK ASGI in-process transport. `start_async_task` is filtered from the model-visible tool set; the four lifecycle tools (`check`/`update`/`cancel`/`list_async_task`) stay native. `BuilderCommandMiddleware` synthesizes `start_builder_task` (was `switch_to_builder`). Net deletion ≈1.4k LOC of compensation code.
- **Phase 3 Lite — Telegram delivery + build awareness.** Added `BuildAwarenessMiddleware` (companion side, between `Mem0` and `Artifact`) that refreshes `state["async_tasks"]` via `langgraph_sdk.runs.get` with a 10s TTL cache and injects a short prompt block (active / just-finished / errored). `BuilderArtifactMiddleware.after_model` now fires `fire_completion_webhook_from_artifact` to the gateway webhook on every terminal path (success, ceiling fallback, consecutive-rejection short-circuit, plain-text end), restoring Telegram artifact delivery without needing the deleted `SubagentExecutor` terminal-flip handler.
- **Artifact namespacing convention.** Builder artifacts upload to Supabase under the **parent (companion) thread_id**, not the ephemeral builder thread. `_signed_artifact_url` and `BuilderArtifactMiddleware._upload_builder_outputs_to_supabase` both read `state["delegation_context"]["parent_thread_id"]` first, fall back to runtime.context. Aligns the upload path, signed URL, webhook payload `thread_id`, and channel-adapter `download_artifact()` lookup so they all key off the same Supabase namespace.
- **Skill-file contract update.** [`skills/public/sophia/AGENTS.md`](skills/public/sophia/AGENTS.md) rewritten to teach `start_builder_task` + `async_tasks` lifecycle. (This file is in every companion + builder system prompt — without the rewrite the model would call the deleted tool by name.)
- **Dead-code cleanup (PR #116).** Removed `emit_completion_event` + `build_completion_payload(SubagentResult)` + `_extract_task_brief` + `should_emit_for_agent` + `_OBSERVED_AGENT_NAMES` from `sophia/builder_events.py`; removed `_emit_builder_completion_event` + 4 call sites + cancel-path block from `subagents/executor.py`; deleted `tests/test_builder_events_publisher.py` (~630 LOC of legacy-only tests). Eliminates one circular dependency (`subagents.executor ↔ sophia.builder_events`) per Sentrux.

### What We Learned
- **Phase-1 was a 4-layer iceberg** in production. Each fix uncovered the next layer:
  1. **PR #107** — `Annotated[str, InjectedToolCallId]` is silently dropped under `@tool(args_schema=…)`. Source must be `runtime.tool_call_id`.
  2. **PR #108** — `runtime: ToolRuntime[X, Y] | None` annotation also breaks injection (Union origin masks the ToolRuntime type). Bare `runtime: ToolRuntime` is the working pattern.
  3. **PR #109** — `@tool(args_schema=…)` *itself* disables typed-parameter auto-injection. The fix is `@tool(name, parse_docstring=True)` with field descriptions in the docstring's `Args:` section. Multi-line descriptions break the parser if prose contains `word:` patterns — keep entries terse.
  4. **PR #110** — passing `thread_id` via `runs.create(config={"configurable": …})` doesn't propagate to the running graph's `runtime.config["configurable"]` on `langgraph-api 0.8.x`. State (passed via `input=…`) does propagate; that's the canonical channel for cross-graph values.
- **`runtime.execution_info.thread_id` is the canonical source per langgraph >= 1.0.** `runtime.context["thread_id"]` happens to work on the ASGI in-process path but is NOT populated under LangGraph Platform / distributed deployments. Always probe `execution_info` first, then `context`, then `config.configurable` (mirroring `ThreadDataMiddleware`).
- **`langgraph.runtime.Runtime` does not always expose `.config`.** The attribute lives on `ToolRuntime` / `RunnableConfig` paths; production middlewares MUST use `getattr(runtime, "config", None)` defensively. We crashed once because a single unwrapped read in `build_completion_payload_from_artifact` raised `AttributeError` and silently killed the whole webhook chain.
- **The "deleted SubagentExecutor" left a hidden coupling**: `SubagentExecutor.execute_async`'s terminal-flip handler called `emit_completion_event` which fed the Telegram delivery webhook. After we deleted SubagentExecutor for the builder path, the webhook trigger went silent and Telegram delivery broke even though everything else looked fine. The fix wasn't to resurrect the executor — it was to call the webhook from inside `BuilderArtifactMiddleware.after_model`, which already runs at every builder terminal point.
- **deepagents native dispatch creates a fresh thread per build**, breaking the pre-migration implicit assumption that "the artifact lives at the thread_id the channel adapter knows about". Restoring that implicit alignment requires explicitly namespacing the upload at the parent thread_id (Option B), which is also more semantically correct: artifacts belong to the conversation, not the ephemeral build thread.
- **Diagnostic logging at every guard is cheap and saved hours.** PR #112 added a permanent `[Builder] fire_completion_webhook: dispatching task_id=… parent_thread_id=… status=… artifact_url_present=…` log line plus explicit logs at each early-exit (non-terminal status, missing thread_id, dedup hit). Every subsequent failure was diagnosed in one log line. Worth doing prophylactically on any chain that fans out into a daemon thread / network call.
- **`@tool(parse_docstring=True)` precedent is in-repo.** [`task_tool.py`](backend/packages/harness/deerflow/tools/builtins/task_tool.py) and [`setup_agent_tool.py`](backend/packages/harness/deerflow/tools/builtins/setup_agent_tool.py) both use it. Should have copied that pattern from the start instead of going straight to `@tool(args_schema=…)`. Lesson: when adding a new tool that needs `runtime` / `tool_call_id` injection, mirror an existing tool that does it successfully.
- **Sentrux gate's `Quality` metric can rise even on a deletion-only PR** (see PR #116: `5459 → 5918` despite removing ~870 LOC) — but EXIT=0 with `cycles 2 → 1` indicates a real architectural improvement. The absolute Quality number is noisy; the cycle / coupling deltas are the load-bearing signals.

### CLAUDE.md Updates
- Root CLAUDE.md: tools list (`switch_to_builder` → `start_builder_task` + four lifecycle tools); `start_builder_task` section rewritten; SophiaState includes `async_tasks` + `delegation_context` as primary builder lifecycle fields; middleware chain now lists `BuildAwarenessMiddleware` and `AsyncSubAgentMiddleware`.
- backend/CLAUDE.md: Sophia Companion + Builder section now documents `BuildAwarenessMiddleware`, the parent-thread-id artifact-namespacing convention, and the three-tier thread-id resolution order (`execution_info` → `context` → `config.configurable`).

### Skills Created / Modified
- [`skills/public/sophia/AGENTS.md`](skills/public/sophia/AGENTS.md) rewritten — full pivot from `switch_to_builder` semantics to `start_builder_task` + `async_tasks` lifecycle. (Production-blocker: this file is system-prompt-injected on every companion + builder turn.)

### GEPA Log Entry
- N/A (no companion-prompt skill files changed beyond AGENTS.md, which is contract-shaped not behaviour-shaped).

### Active diagnostic breadcrumbs (keep)
- `[Builder] start_builder_task dispatching: task_type=… parent_thread=… …` — companion-side, fires on every dispatch
- `[Builder] start_builder_task launched: task_id=… run_id=… trace=…` — companion-side, post-SDK
- `[Builder] fire_completion_webhook: dispatching task_id=… parent_thread_id=… status=… artifact_url_present=…` — builder-side, fires on every terminal path
- `[Builder] fire_completion_webhook: missing builder thread_id …` — builder-side, fires on the rare AttributeError / unresolved-thread path

---

## 2026-04-13 · [builder-web-research] · PR #[pending]
**Author:** Codex · **Track:** backend · **Spec:** docs/specs/01_architecture_overview.md, docs/specs/04_backend_integration.md, docs/specs/07_builder_handoff_spec.md

### What Changed
- Added builder-only guarded web research to `sophia_builder` via `builder_web_search` and `builder_web_fetch`, reusing DeerFlow's configured web providers while enforcing URL allowlists and call budgets.
- Added `BuilderResearchPolicyMiddleware`, extended builder delegation/state with explicit research permissions and source provenance, and updated builder output guidance to require citations or source appendices when browsing is used.
- Wired `ToolErrorHandlingMiddleware` into the builder runtime, restored `BuilderSessionMiddleware` to the companion chain so delegated work can synthesize back correctly, and fixed the Mem0 memory-content injection typo uncovered by the touched regression suite.
- Strengthened `emit_builder_artifact` so `sources_used` can carry structured `{title, url}` entries and documented that Sophia's builder is now a dedicated guarded agent rather than the unmodified lead agent.

### What We Learned
- DeerFlow already had native web search providers, but Sophia's dedicated builder path had diverged enough that “native support exists” did not mean the builder could use it safely without explicit wrappers.
- Builder-side browsing needs a provenance channel separate from voice artifacts; otherwise citations either disappear or leak into spoken output where they do not belong.
- The companion's builder synthesis path silently depended on `BuilderSessionMiddleware` being present in the live chain; importing it without wiring it left delegated-task completion more brittle than the docs implied.
- Running the touched Sophia suite exposed a small but real Mem0 injection typo, which was cheap to fix once surfaced and worth keeping in the green path.

### CLAUDE.md Updates
- None

### Skills Created / Modified
- None

### GEPA Log Entry
- N/A

## 2026-04-06 · [memory-review] · PR #[pending]
**Author:** GitHub Copilot · **Track:** backend + frontend · **Spec:** docs/specs/03_memory_system.md, docs/specs/04_backend_integration.md, docs/specs/05_frontend_ux.md

### What Changed
- Hardened the recap memory-review path so frontend fallback data no longer reintroduces approved or discarded memories as pending candidates.
- Reduced unnecessary Mem0 detail hydration for `status=pending_review` by honoring the local review metadata overlay before deciding whether a per-memory fetch is needed.
- Switched dev auth bypass away from the tracked `dev-user` default to avoid booting local sessions on top of seeded runtime artifacts.
- Added backend and frontend regression coverage for the fallback filtering and overlay-driven hydration paths.

### What We Learned
- Mem0 is not a reliable immediate source of truth for review metadata; the local review metadata store has to drive recap moderation semantics.
- Status-filtered review endpoints can silently turn into N+1 Mem0 traffic if overlay state is ignored before hydration.
- A fallback route that broadens its source query must still preserve the original semantic contract; otherwise the UI revives already-reviewed candidates.
- Committing runtime `users/` artifacts makes full-branch IDE review significantly heavier and requires a neutral dev-bypass user default.

### CLAUDE.md Updates
- Added pitfalls covering overlay-first `pending_review` hydration, recap fallback filtering, and neutral dev bypass defaults when runtime user artifacts are tracked.

### Skills Created / Modified
- Added `.claude/skills/sophia/memory-review-overlay/SKILL.md`

### GEPA Log Entry
- N/A

## 2026-04-09 · [frontend-validation-and-auth-smoke] · PR #[pending]
**Author:** GitHub Copilot · **Track:** frontend · **Spec:** docs/specs/05_frontend_ux.md, docs/specs/06_implementation_spec.md

### What Changed
- Added a dedicated non-bypass Better Auth smoke path for browser validation and confirmed it passes locally.
- Fixed the journal saved-memory edit/delete path for `local:` review-backed memory IDs and revalidated the browser flow.
- Stabilized recap polling behavior for recently ended sessions so the live recap/journal flow and recap hook coverage pass again.
- Documented the current frontend validation baseline in `frontend/README.md`, including which deployment-oriented checks are green and which legacy UI unit suites still fail.
- Revalidated the deploy-oriented frontend gate locally: `pnpm lint` passes with warnings only, `pnpm typecheck` passes, and `BETTER_AUTH_SECRET=local-dev-secret pnpm build` passes.

### What We Learned
- The frontend auth smoke must run against a fresh non-bypass Next server; reusing an existing bypass-enabled dev server gives a false result.
- The live frontend E2E suite is stack-dependent: LangGraph, gateway, voice server, and frontend all need to be up for `pnpm test:e2e:live` to be meaningful.
- The remaining red `pnpm test` suites are expectation drift in older UI tests, not evidence that the newly validated auth/recap/journal/live-voice paths are broken.
- For Render/Vercel readiness on this branch, the strongest production-facing gate is `pnpm lint`, `pnpm typecheck`, and `BETTER_AUTH_SECRET=... pnpm build`.
- Better Auth accepts the local build secret for validation, but the build warns correctly if the secret is short or low-entropy; production deploys should replace it with a generated secret.

### CLAUDE.md Updates
- None

### Skills Created / Modified
- None

### GEPA Log Entry
- N/A

## 2026-04-09 · [frontend-auth-postgres-cleanup] · PR #[pending]
**Author:** GitHub Copilot · **Track:** frontend · **Spec:** docs/specs/06_implementation_spec.md

### What Changed
- Removed stale frontend signals that implied Better Auth still ran on SQLite.
- Clarified in `frontend/.env.example` that frontend auth now uses Postgres.
- Audited remaining SQLite references and confirmed the runtime path is Postgres-backed while lockfile references persist through Better Auth optional dependencies.

### What We Learned
- Removing ignore rules before deleting local auth artifacts can expose a local SQLite database that still contains live session and OAuth material.
- Cleaning the manifest alone is not enough to remove SQLite from the dependency story; `pnpm-lock.yaml` can still resolve `better-sqlite3` as an optional Better Auth dependency.
- Frontend auth migration state should be documented in both repo memory and committed env examples, otherwise future debugging falls back to stale SQLite assumptions.

### CLAUDE.md Updates
- None

### Skills Created / Modified
- None

### GEPA Log Entry
- N/A

## 2026-04-09 · [voice-e2e-hardening] · PR #[pending]
**Author:** GitHub Copilot · **Track:** frontend + voice · **Spec:** docs/specs/04_backend_integration.md, docs/specs/05_frontend_ux.md, docs/specs/06_implementation_spec.md

### What Changed
- Restored dev-bypass compatibility for hardened user-scoped frontend routes by returning a synthetic `dev-bypass-token` when local bypass is enabled without a backend cookie or configured fallback token.
- Fixed `frontend/src/app/hooks/useStreamVoiceSession.ts` so React Strict Mode cleanup no longer leaves the hook permanently destroyed, and relaxed voice readiness from exact remote session-id matching to remote participant presence in the joined one-on-one call.
- Stabilized the retry/update effect in `frontend/src/app/companion-runtime/voice-runtime.ts` by depending on stable derived primitives instead of the whole `voiceState` object, eliminating the browser-side update-depth loop.
- Added regressions for the dev-bypass token path, Strict Mode cleanup behavior, and remote-participant readiness, then revalidated with targeted Vitest, `pnpm typecheck`, targeted ESLint, a direct browser probe, and the live Playwright voice plus text→voice→text specs.

### What We Learned
- Hardening route auth can silently break local E2E if dev bypass no longer produces a backend token; the first symptom is often a stalled session bootstrap rather than an explicit auth error.
- In the Stream one-on-one voice flow, exact voice-agent session-id matching is too brittle as a frontend readiness gate; remote participant presence is the reliable signal that allows transcript and artifact custom events to flow.
- React Strict Mode effect cleanup can poison async startup refs if setup does not explicitly reset them on remount.
- When backend voice logs show transcript/custom-event traffic but the browser still times out, inspect the frontend capture bridge before touching STT/TTS; readiness gating and client-side render loops can drop an otherwise healthy turn.

### CLAUDE.md Updates
- None

### Skills Created / Modified
- None

### GEPA Log Entry
- N/A

## 2026-04-09 · [user-scoped-auth-hardening] · PR #[pending]
**Author:** GitHub Copilot · **Track:** backend + frontend · **Spec:** docs/specs/04_backend_integration.md, docs/specs/05_frontend_ux.md, docs/specs/06_implementation_spec.md

### What Changed
- Added a local Better Auth-backed compatibility bridge under `frontend/src/app/api/v1/auth/*` plus `frontend/src/server/legacy-backend-auth.ts`, so local auth validation no longer depends on the missing legacy `:8000` auth service.
- Updated backend gateway auth to prefer `SOPHIA_AUTH_BACKEND_URL`, and updated `scripts/sophia-e2e.ps1` plus frontend auth helpers so both frontend token minting and gateway validation hit the same local bridge.
- Hardened active user-scoped frontend routes to use user-scoped auth helpers instead of broad server fallback, including `resume`, `privacy/*`, `sophia/[userId]/voice/*`, `bootstrap/*`, `companion/invoke`, `conversation/*`, `sessions/*`, `usage/*`, `ws-ticket`, and the `api/chat` backend client path.
- Removed the remaining `api/chat` trust on client-supplied `user_id` by deriving canonical user identity from Better Auth server-side before forwarding backend chat requests.
- Added regression coverage for the auth bridge round-trip, sync-backend canonical user binding, voice/session proxy auth, ws-ticket auth, and the chat handler path that now ignores client `user_id`.

### What We Learned
- Restoring end-to-end auth confidence required more than reviving `/api/v1/auth/me`; the minted backend token has to carry the same canonical `session.user.id` that the gateway compares against path `user_id`.
- “Generic” proxy routes are easy to misclassify. Conversation history, bootstrap opener/status, usage, websocket ticketing, and companion invoke all operate on the current user and should not inherit `BACKEND_API_KEY` fallback semantics.
- The remaining active broad-auth route after cleanup is `frontend/src/app/api/community/latest-learning/route.ts`, which is intentionally treated as optional curated content rather than a user-scoped data surface; `_archived_session/bootstrap` remains excluded as archived code.
- The right fix for `api/chat` was not only swapping auth helpers; it also required removing the last server-side acceptance of client-provided `user_id` from the chat request pipeline.

### CLAUDE.md Updates
- None

### Skills Created / Modified
- None

### GEPA Log Entry
- N/A

## 2026-04-10 · [auth-runtime-cleanup-and-voice-connect-fix] · PR #[pending]
**Author:** GitHub Copilot · **Track:** backend + frontend + voice · **Spec:** docs/specs/04_backend_integration.md, docs/specs/05_frontend_ux.md, docs/specs/06_implementation_spec.md

### What Changed
- Verified the remaining local auth regressions were caused by process-scoped E2E bypass variables leaking into the live frontend and gateway runtime, then restarted both services in a clean environment with the bypass flags removed.
- Confirmed the backend auth path now stays scoped to backend-only bypass variables while the frontend keeps its public dev-bypass handling isolated to local UI behavior.
- Diagnosed the mic blink-and-stop failure to the gateway generating voice `call_id` values directly from mixed-case Better Auth user IDs, which violated the voice server contract that only allows lowercase `a-z`, digits, `_`, and `-`.
- Patched `backend/app/gateway/routers/voice.py` to sanitize the user-derived `call_id` fragment before dispatching the voice session, and added regression coverage in `backend/tests/test_voice_gateway.py` for mixed-case user IDs.
- Revalidated the targeted voice gateway suite locally (`24 passed`) and reran the deploy-oriented frontend checks: `pnpm lint` with warnings only, `pnpm typecheck`, and `BETTER_AUTH_SECRET=local-dev-secret pnpm build`.

### What We Learned
- Public E2E bypass flags do not need to be persisted at the OS level to break local auth; a contaminated shell is enough to split frontend identity from gateway identity.
- A successful `/voice/connect` response is not proof that live voice bootstrapped correctly; the downstream voice session creation can still fail and leave the frontend with a brief start-stop blink.
- Better Auth user IDs are not safe to reuse as downstream transport identifiers without normalization because external systems may impose stricter character contracts.
- The strongest local release signal for this branch remains targeted backend tests plus frontend lint, typecheck, and production build, while backend repo-wide lint is still blocked by unrelated pre-existing issues.

### CLAUDE.md Updates
- None

### Skills Created / Modified
- None

### GEPA Log Entry
- N/A

## 2026-05-10 · [phase-3-stage-1-builder-as-main-work-bot] · PR #120
**Author:** Claude Code (with Davide) · **Track:** backend + deployment · **Spec:** `~/Desktop/Sophia V3 specs/sophia_builder_as_main_work_bot_spec.md` (Phase 3, Stage 1)

### What Changed
- **`TelegramWorkChannel`** ([backend/app/channels/telegram_work.py](backend/app/channels/telegram_work.py)) — sibling channel registered as `"telegram_work"` in [service.py](backend/app/channels/service.py)'s registry. Owns its own polling thread + `Application` for `@Sophia_Work_bot`. Inbound DMs bypass the bus + ChannelManager and dispatch directly to `sophia_builder` via `client.runs.wait`. Placeholder + edit pattern for blocking response (Stage 1 — streaming deferred to Stage 2). Channel name `"telegram_work"` keeps store keys isolated from EI's `"telegram"` namespace per the prefix-discipline note in [store.py](backend/app/channels/store.py).
- **3-step identity resolver** in `TelegramWorkChannel._resolve_sophia_user_id`: forward fast-path (`resolve_user_id("telegram", chat_id)`) → reverse lookup (`resolve_user_id_by_telegram_user_id(tg_user_id)`) → auto-bind via `bind_chat`. Means any user already bound through @Sophia_EI_bot's deep-link is auto-recognised by Work bot on first DM (Stage 1C "any EI-bound user welcome" works without any webapp changes). Different chat_ids per bot (Telegram assigns one per bot DM); the reverse index bridges them by Telegram user.id. `_auto_bind_work_dm` swallows binding errors with WARNING so failure of the persistence call doesn't block the in-flight build.
- **`BuilderTaskMiddleware.abefore_agent`** synthesises `delegation_context` via single Haiku 4.5 structured-output classifier call when missing on input — `parent_thread_id: None` is the **D3 marker** that distinguishes Builder-as-Main mode from companion-subagent mode. Classifier prompt at [agents/sophia_agent/prompts/builder_brief_classification.md](backend/packages/harness/deerflow/agents/sophia_agent/prompts/builder_brief_classification.md). Conservative fallback on any failure (no API key, template missing, SDK error, malformed response) so the Builder run always proceeds.
- **`BuilderMem0RetrievalMiddleware`** ([packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_retrieval.py](backend/packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_retrieval.py)) — pre-fetches top-K user memories scoped to the current brief via Mem0. 2.0s timeout, swallow-all-errors. Helps both paths: Work-bot DM (sole memory injection) AND companion-subagent (orthogonal to the 5 snippets `start_builder_task` already embeds). Inserted between `UserIdentityMiddleware` and `BuilderTaskMiddleware` in the builder chain. Writes both `injected_memory_contents` and a `<memory>` block to `system_prompt_blocks` (which `PromptAssemblyMiddleware` at the end of the chain naturally absorbs).
- **D7/C2 recursion guard** at `_create_builder_agent` in [builder_agent.py](backend/packages/harness/deerflow/agents/sophia_agent/builder_agent.py) raises `RuntimeError` if `task` or `start_async_task` is in the tool list. Stage 3 may relax this for specific specialist subagents, but the relaxation must be threaded through the registry layer, not added back to the tool list silently.
- **`builder_middlewares.py`** extracted from `builder_agent.py` (Phase B cleanup) — `build_builder_middleware_chain(user_id)` owns the 9 middleware imports + composition. Drops `builder_agent.py`'s import fan-out from 19 to ~9 (removed it from sentrux's god-files list).
- **`_sophia_artifact_bridge.py`** (Phase C cleanup) — single re-export of `download_artifact` from `deerflow.sophia.storage`. Both `telegram.py` (EI bot — D2-relaxed for a 1-line import substitution) and `telegram_work.py` route through it. Cuts duplicate cross-layer edges.
- **Production deployment wiring** — added `channels.telegram_work` block to `config.production.yaml` (the file `Dockerfile.gateway:8` copies to `/app/config.yaml`); declared `TELEGRAM_WORKER_BOT_TOKEN` on the gateway service in `render.yaml`. Hardcoded `bot_username: Sophia_Work_bot` in YAML (NOT env-var-resolved) because the langgraph service ALSO loads this file and the config resolver hard-fails on any missing `$VAR`.
- **Tests added**: 8 new test files / classes covering work-channel construction, identity binding (forward / reverse / auto-bind / failure), summary + artifact extraction, synthetic delegation (3 classifier scenarios + fallback paths), Mem0 retrieval (timeout / error / dedup / truncate), recursion guard, and the **dispatch payload shape regression guard**. Total suite: 1591 pass / 0 regressions.

### What We Learned

#### Render deployment topology — read this BEFORE editing config files

The repo's root `config.yaml` is **`.gitignore`'d**. The actual production config is **`config.production.yaml`** (tracked). It gets copied to `/app/config.yaml` inside the container by `backend/Dockerfile.gateway:8` via `COPY config.production.yaml ./config.yaml`. Editing the local `config.yaml` does NOTHING to production.

**Both services load this same file.** `Dockerfile.langgraph` and `Dockerfile.gateway` both run from a base image that has `config.production.yaml` baked in. The `langgraph_api` runtime calls `AppConfig.from_file(...)` which calls `resolve_env_variables` which **raises a hard `ValueError` on any missing `$VAR`** (see [packages/harness/deerflow/config/app_config.py:188-190](backend/packages/harness/deerflow/config/app_config.py)). There is no tolerant fallback syntax.

This means: **any new `$VAR` reference in `config.production.yaml` requires the env var to be set on EVERY service that loads the file** (langgraph + gateway minimum). When in doubt, hardcode the value in YAML if it's not a secret. We hit this with `bot_username` and ended up hardcoding it — the cosmetic public bot name doesn't need to be an env var.

`render.yaml` declares which env vars MUST be set on each service in the dashboard (`sync: false` = "operator-set, Render won't auto-populate"). Currently the gateway needs: `ANTHROPIC_API_KEY`, `MEM0_API_KEY`, `STREAM_API_KEY`, `STREAM_API_SECRET`, `LANGGRAPH_URL`, `SOPHIA_VOICE_SERVER_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WORKER_BOT_TOKEN`. Langgraph needs `ANTHROPIC_API_KEY`, `MEM0_API_KEY`, plus any token referenced by `config.production.yaml` (currently `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WORKER_BOT_TOKEN`).

To verify what your live `/app/config.yaml` looks like, SSH into the Render service and run `cat /app/config.yaml`. The file timestamp matches the deploy time — confirms it's baked in at image build, not externally mounted.

#### langgraph-api 0.7+ runs.wait validation rejects both-channels payloads

`runs.wait` (and `runs.create`) returns HTTP 400 in <1ms (pure validation, before the run starts) when the request sets BOTH `config["configurable"]` AND `context` with overlapping keys:

```
"Cannot specify both configurable and context. Prefer setting context alone."
(langgraph_api/models/run.py:225-228)
```

Pattern to use (mirrors [manager.py:633-645](backend/app/channels/manager.py)):
```python
run_config = {"recursion_limit": 100}                    # NO "configurable" key
run_context = {"thread_id": ..., "user_id": ..., ...}    # single source of truth
result = await client.runs.wait(thread_id, assistant_id,
                                input=..., config=run_config, context=run_context)
```

langgraph-api copies `context` → `configurable` server-side via `configurable = context.copy()` (run.py:233), so factories like `make_sophia_builder(config)` still read `cfg["configurable"]["user_id"]` correctly. The Stage 1 PR shipped a buggy version of this that set both, and every real DM to @Sophia_Work_bot crashed with the 400 the moment a user said anything past `/start`. Fixed in commit `34018743`. Regression-guard test in [tests/test_telegram_work_channel.py::TestDispatchPayloadShape](backend/tests/test_telegram_work_channel.py) asserts `"configurable" not in call.kwargs["config"]` so this can't sneak back in.

`start_builder_task.py` is allowed to set `configurable` because it dispatches via the SDK ASGI in-process transport (`get_client(url=None)`), which has different validation than the HTTP-mode SDK client used by channel adapters.

#### Sentrux scoring — what actually moves quality_signal in v0.5.7

The blocking gate (`sentrux gate .`) does **NOT** fail on small `quality_signal` deltas. It fails on **categorical** regressions: cycles count, god-files count, complex-functions count, coupling threshold breaches. The gate has internal tolerance bands; we shipped `+14 quality_signal vs main` with `✓ No degradation detected` because no categorical axis crossed a threshold.

What we tried, ranked by impact (CI scan results, NOT local — they can disagree by ~5-10 points; CI is authoritative):

| Action | quality_signal Δ (CI) | god_files Δ | Architectural value |
|---|---|---|---|
| Lazy-import cross-layer deps (Phase A) | **0** | 0 | small (defers SDK init) |
| Extract sub-module to drop file fan-out (Phase B) | **+1** | **-1** | real (removes one god-file) |
| Bridge module to consolidate cross-layer edges (Phase C) | **+1** | 0 | real (one crossing point for future swap) |

**Bottom line:** sentrux's geometric mean penalises **file-count overhead** roughly equal to (or slightly more than) the per-axis modularity / coupling gains. Within-module file extraction nets out **roughly neutral** on `quality_signal` while genuinely improving structure. **Lazy imports do nothing for the score** — sentrux v0.5.7's parser walks function bodies via Python's full AST. Don't bother lazy-importing for sentrux purposes.

What DID matter for clearing the gate the first time:
1. **Cyclomatic complexity threshold is CC ≥ 16** in v0.5.7. Functions at C(15) are fine; D(20+) trip it. Refactor by extracting helpers — easy mechanical wins. We had 4 functions over the threshold and got them all under by splitting into 3-5 small named helpers each.
2. **Lint must be clean**. `make lint` (ruff) is a hard gate. Auto-fix what `--fix` will fix; manually rename for `F811` duplicate definitions (which pytest may have been silently shadowing — surfacing them can also reveal pre-existing latent test bugs, as it did for us).
3. **God-files threshold is fan-out > 15**. Extract collaborators into sibling modules; `builder_agent.py` went from 19 → 9 by moving the middleware chain to `builder_middlewares.py`.

Local sentrux: `mcp__sentrux__rescan` then `mcp__sentrux__health`. CI uses the same `sentrux v0.5.7` binary. `CI scan` and `local scan` can disagree by ~5-10 points on `quality_signal` — the local incremental scan and the CI clean-checkout scan compute slightly different file sets. Trust CI.

#### Cross-bot Telegram identity binding works without webapp changes

The identity store at [app/gateway/telegram_link_store.py](backend/app/gateway/telegram_link_store.py) maintains TWO indexes: `_bindings_by_chat[(channel, chat_id)]` (forward) AND `_bindings_by_telegram_user_id[tg_user_id]` (reverse). Both are populated by every `bind_chat` call. When a user DMs `@Sophia_Work_bot`, the chat_id is different from their @Sophia_EI_bot DM (Telegram assigns per-bot chat_ids), so the forward lookup misses. But `update.effective_user.id` is the same Telegram identity in both DMs. The reverse lookup bridges them and we auto-bind the new (channel, Work-DM-chat-id) → user_id pair so subsequent forward lookups hit fast.

Net result: any user already bound through EI's `/start` deep-link flow is auto-recognised by Work bot on first DM. **No webapp UI changes needed for Stage 1C "any EI-bound user welcome".** A standalone Work-bot deep-link flow (for brand-new users who never use EI) would be a Stage 2 webapp PR.

#### `pytest.mark.anyio` (not `asyncio`) is the convention here

Continues to be true. Anyio plugin is what's installed; `@pytest.mark.asyncio` silently produces "tests skipped" results. Worth a 1-minute check if a fresh async test "passes" suspiciously fast.

### CLAUDE.md Updates
- Root `CLAUDE.md`: extended the existing "Builder-as-Main DM (Stage 1, Phase 3 Telegram diagnostic)" section with a "Render deployment topology" subsection (config.production.yaml as source-of-truth, Dockerfile.gateway:8 COPY, env-var requirements per service, the `runs.wait` 400 trap reference).
- `backend/CLAUDE.md`: added a "Render production deployment" subsection covering the same topology + the `runs.wait` 400 gotcha + sentrux scoring learnings + cross-bot identity resolver implementation.
- `README.md`: extended IM Channels section with `telegram_work` block + added a "Production deployment (Render)" subsection covering the config.production.yaml ↔ /app/config.yaml mapping and required env vars per service.

### Skills Created / Modified
- New: `backend/packages/harness/deerflow/agents/sophia_agent/prompts/builder_brief_classification.md` — single-Haiku-call classifier prompt loaded by `BuilderTaskMiddleware._classify_brief` when no companion-supplied delegation_context is on input. Used only on the Builder-as-Main path. Verbatim from spec §6.4. Per-request agent prompt (NOT a pipeline prompt — distinct from `sophia/prompts/` which CLAUDE.md hard constraint #8 reserves for the offline pipeline).

### GEPA Log Entry
- `builder_brief_classification.md` is a per-request agent prompt, not a target for GEPA optimization. Tone delta not applicable (Builder doesn't speak; classifier output is structured tool-call). No trace pair needed; behavior is deterministic given the same user_brief input.
