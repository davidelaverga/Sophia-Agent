# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DeerFlow is a LangGraph-based AI super agent system with a full-stack architecture. The backend provides a "super agent" with sandbox execution, persistent memory, subagent delegation, and extensible tool integration - all operating in per-thread isolated environments.

**Architecture**:
- **LangGraph Server** (port 2024): Agent runtime and workflow execution
- **Gateway API** (port 8001): REST API for models, MCP, skills, memory, artifacts, and uploads
- **Frontend** (port 3000): Next.js web interface
- **Nginx** (port 2026): Unified reverse proxy entry point
- **Provisioner** (port 8002, optional in Docker dev): Started only when sandbox is configured for provisioner/Kubernetes mode

**Project Structure**:
```
deer-flow/
├── Makefile                    # Root commands (check, install, dev, stop)
├── config.yaml                 # Main application configuration
├── extensions_config.json      # MCP servers and skills configuration
├── backend/                    # Backend application (this directory)
│   ├── Makefile               # Backend-only commands (dev, gateway, lint)
│   ├── langgraph.json         # LangGraph server configuration
│   ├── packages/
│   │   └── harness/           # deerflow-harness package (import: deerflow.*)
│   │       ├── pyproject.toml
│   │       └── deerflow/
│   │           ├── agents/            # LangGraph agent system
│   │           │   ├── lead_agent/    # Main agent (factory + system prompt)
│   │           │   ├── middlewares/   # 10 middleware components
│   │           │   ├── memory/        # Memory extraction, queue, prompts
│   │           │   └── thread_state.py # ThreadState schema
│   │           ├── sandbox/           # Sandbox execution system
│   │           │   ├── local/         # Local filesystem provider
│   │           │   ├── sandbox.py     # Abstract Sandbox interface
│   │           │   ├── tools.py       # bash, ls, read/write/str_replace
│   │           │   └── middleware.py  # Sandbox lifecycle management
│   │           ├── subagents/         # Subagent delegation system
│   │           │   ├── builtins/      # general-purpose, bash agents
│   │           │   ├── executor.py    # Background execution engine
│   │           │   └── registry.py    # Agent registry
│   │           ├── tools/builtins/    # Built-in tools (present_files, ask_clarification, view_image)
│   │           ├── mcp/               # MCP integration (tools, cache, client)
│   │           ├── models/            # Model factory with thinking/vision support
│   │           ├── skills/            # Skills discovery, loading, parsing
│   │           ├── config/            # Configuration system (app, model, sandbox, tool, etc.)
│   │           ├── community/         # Community tools (tavily, jina_ai, firecrawl, image_search, aio_sandbox)
│   │           ├── reflection/        # Dynamic module loading (resolve_variable, resolve_class)
│   │           ├── utils/             # Utilities (network, readability)
│   │           └── client.py          # Embedded Python client (DeerFlowClient)
│   ├── app/                   # Application layer (import: app.*)
│   │   ├── gateway/           # FastAPI Gateway API
│   │   │   ├── app.py         # FastAPI application
│   │   │   └── routers/       # 6 route modules
│   │   └── channels/          # IM platform integrations
│   ├── tests/                 # Test suite
│   └── docs/                  # Documentation
├── frontend/                   # Next.js frontend application
└── skills/                     # Agent skills directory
    ├── public/                # Public skills (committed)
    └── custom/                # Custom skills (gitignored)
```

## Important Development Guidelines

### Documentation Update Policy
**CRITICAL: Always update README.md and CLAUDE.md after every code change**

When making code changes, you MUST update the relevant documentation:
- Update `README.md` for user-facing changes (features, setup, usage instructions)
- Update `CLAUDE.md` for development changes (architecture, commands, workflows, internal systems)
- Keep documentation synchronized with the codebase at all times
- Ensure accuracy and timeliness of all documentation

## Commands

**Root directory** (for full application):
```bash
make check      # Check system requirements
make install    # Install all dependencies (frontend + backend)
make dev        # Start all services (LangGraph + Gateway + Frontend + Nginx), with config.yaml preflight
make stop       # Stop all services
```

**Backend directory** (for backend development only):
```bash
make install    # Install backend dependencies
make dev        # Run LangGraph server only (port 2024)
make gateway    # Run Gateway API only (port 8001)
make test       # Run all backend tests
make lint       # Lint with ruff
make format     # Format code with ruff
```

**Worker pool sizing for async-subagent dispatch**: when running LangGraph dev locally, prefer `langgraph dev --n-jobs-per-worker 20`. Sophia's companion dispatches builder runs in-process via deepagents `AsyncSubAgentMiddleware` (ASGI transport). A supervisor with N concurrent builder tasks needs N+1 worker slots; 20 is the LangChain-published recommended ceiling for local dev and gives ample headroom for Phase-3 dual-bot work.

**Production worker pool (PR #129, Phase 2A)**: `backend/Dockerfile.langgraph` CMD passes `--n-jobs-per-worker 10`. The `langgraph dev` CLI hardcodes default 1 AND explicitly overrides any external env var (`langgraph_api/cli.py:262-263, 286`), so setting `N_JOBS_PER_WORKER=10` on Render has NO effect — the Dockerfile flag is the only knob. `render.yaml` carries a comment documenting this trap. Confirmed regression: pre-fix production runs at 2026-05-20 19:43–19:54 UTC had `Worker stats max=1`; companion's mid-build update sat in queue 7m 47s behind the builder run before timing out at the gateway's 5-min `runs.wait` ReadTimeout.

**Telegram → web memory review handoff** (Phase-2 spec, May 2026): when a Telegram chat goes idle for 10 minutes, [`telegram_session_tracker`](app/channels/telegram_session_tracker.py) fires `run_offline_pipeline` (handoff + identity + Mem0 candidates + sparse recap envelope) and publishes a "memories ready" event on the channel `MessageBus`; the Telegram channel adapter subscribes and DMs the user a button. The button is a Telegram `LoginUrl` pointing at `SOPHIA_WEB_BASE_URL/api/auth/telegram-login?session=<id>`; the frontend route HMAC-verifies the payload (key = SHA256(TELEGRAM_BOT_TOKEN)) and 302-redirects to `/recap/{session}` with `?next=` plumbing so AuthGate completes Google sign-in if the user has no session. **One-time BotFather setup required**: run `/setdomain` against `@Sophia_EI_bot` and enter the host of `SOPHIA_WEB_BASE_URL` — without this, Telegram refuses to render the LoginUrl button.

**Offline-pipeline message-shape contract**: `_serialize_messages` ([sophia/offline_pipeline.py](packages/harness/deerflow/sophia/offline_pipeline.py)) must accept three shapes — LangChain `BaseMessage` objects (`msg.type` / `msg.content`), LangChain JSON-serialized dicts from `GET /threads/{id}/state` (`{"type": "human", ...}` with no `role`, and `content` either top-level or nested under `data.content`), and channel-adapter raw dicts (`{"role": "human", "content": ...}`). The dict branch reads `msg.get("role") or msg.get("type", "")` for role and falls back to `msg["data"]["content"]` when top-level `content` is `None`. Multimodal list-of-blocks content is flattened via `_flatten_content` (text blocks only; image / pdf bytes are dropped — the extractor only inspects text). Recap envelopes written here must use `recap_artifacts: {}` (not `null`) so the frontend mapper doesn't early-null-return.

Regression tests related to Docker/provisioner behavior:
- `tests/test_docker_sandbox_mode_detection.py` (mode detection from `config.yaml`)
- `tests/test_provisioner_kubeconfig.py` (kubeconfig file/directory handling)

Boundary check (harness → app import firewall):
- `tests/test_harness_boundary.py` — ensures `packages/harness/deerflow/` never imports from `app.*`

CI runs these regression tests for every pull request via [.github/workflows/backend-unit-tests.yml](../.github/workflows/backend-unit-tests.yml).

## Architecture

### Harness / App Split

The backend is split into two layers with a strict dependency direction:

- **Harness** (`packages/harness/deerflow/`): Publishable agent framework package (`deerflow-harness`). Import prefix: `deerflow.*`. Contains agent orchestration, tools, sandbox, models, MCP, skills, config — everything needed to build and run agents.
- **App** (`app/`): Unpublished application code. Import prefix: `app.*`. Contains the FastAPI Gateway API and IM channel integrations (Feishu, Slack, Telegram).

**Dependency rule**: App imports deerflow, but deerflow never imports app. This boundary is enforced by `tests/test_harness_boundary.py` which runs in CI.

**Import conventions**:
```python
# Harness internal
from deerflow.agents import make_lead_agent
from deerflow.models import create_chat_model

# App internal
from app.gateway.app import app
from app.channels.service import start_channel_service

# App → Harness (allowed)
from deerflow.config import get_app_config

# Harness → App (FORBIDDEN — enforced by test_harness_boundary.py)
# from app.gateway.routers.uploads import ...  # ← will fail CI
```

### Agent System

**Lead Agent** (`packages/harness/deerflow/agents/lead_agent/agent.py`):
- Entry point: `make_lead_agent(config: RunnableConfig)` registered in `langgraph.json`
- Dynamic model selection via `create_chat_model()` with thinking/vision support
- Tools loaded via `get_available_tools()` - combines sandbox, built-in, MCP, community, and subagent tools
- System prompt generated by `apply_prompt_template()` with skills, memory, and subagent instructions

**Sophia Companion + Builder** (`packages/harness/deerflow/agents/sophia_agent/`):
- `start_builder_task` (in `sophia/tools/start_builder_task.py`) is the canonical companion-side dispatch tool. It launches the builder via deepagents `AsyncSubAgentMiddleware` (LangGraph SDK ASGI in-process transport) and returns immediately with a `task_id` written to `state["async_tasks"]`
- `start_builder_task` enriches the builder's brief with relevant memories from this session, current emotional context (tone + active_goal), active ritual / phase, and explicit user-supplied URLs; the wrapper also seeds `delegation_context`, `allow_web_research`, `explicit_user_urls`, and `builder_web_budget` on the builder's input so its middlewares (`BuilderTaskMiddleware`, `BuilderResearchPolicyMiddleware`) read them as state
- Trusted user_id resolution priority: `runtime.config.configurable.user_id` → `runtime.context.user_id` → `state.user_id` → `make_start_builder_task_tool(user_id)` closure → LLM-supplied tool arg (warning) → `default_user` (warning). The LLM tool arg never overrides a trusted source; mismatches are logged for prompt-injection audit
- Duplicate-launch protection uses a terminal-status blacklist (`success`/`completed`/`error`/`failed`/`cancelled`/`timeout`/`timed_out`) — anything not terminal is treated as still active so unknown / future LangGraph statuses (`pending`, `interrupted`, …) correctly block new launches
- Empty `tool_call_id` makes the wrapper REFUSE to launch (prevents orphaned LangGraph runs) — the lifecycle tools resolve tasks from `state["async_tasks"]` which can only be written when there is a matching `tool_call_id`
- Lifecycle (`check_async_task`, `update_async_task`, `cancel_async_task`, `list_async_tasks`) is owned by the native deepagents `AsyncSubAgentMiddleware`; `start_async_task` is filtered from the model-visible tool set so the model only ever launches builds via the enriched wrapper
- **`update_async_task` is also filtered and replaced by a custom wrapper** (PR #129, Phase 2B+2E+2F: `deerflow.sophia.tools.update_async_task_wrapper.make_update_async_task_wrapper`). The wrapper: (a) on TERMINAL target — returns a directive ToolMessage redirecting to `start_builder_task` with a v2 brief (success path) or a fresh-start brief (failed path); never lets the native dispatch create a new run on a finished thread (which would loop on dangling tool calls). (b) on NON-TERMINAL target — does a live `runs.get` SDK call to defeat ~10s cache staleness, then if live status is also non-terminal, AUGMENTS the user message with a `[Sophia/post-interrupt build directive]` prefix carrying a slug-derived concrete filename + "RESUMING (not restarting)" language, then delegates to native. Idempotent via marker sentinel; uses `_safe_task_type` to ensure `task_type` is always in `_CANONICAL_TASK_TYPES`
- **Builder file-target resilience** (PR #129, Phase 2F.2): `write_file_tool` auto-prefixes BARE filenames (no `/` separator) to `/mnt/user-data/outputs/<name>`, but ONLY when invoked from the `sophia_builder` graph — gated by `_is_builder_runtime_context(runtime)` which checks both `runtime.config["configurable"]["graph_id"] == "sophia_builder"` (set explicitly by `start_builder_task`) AND `runtime.state["delegation_context"]` presence (Tier-2 fallback for post-interrupt runs where configurable doesn't propagate). Non-builder callers (companion, lead_agent) still get strict path validation so they don't silently land scratch files in the outputs dir
- **Builder turn-budget reset + path-correction escape** (PR #129, Phase 2E.1+2F.3): `BuilderArtifactMiddleware.before_model` / `abefore_model` detect "new HumanMessage after AIMessage with tool_calls" (post-interrupt-update signal) and reset `builder_non_artifact_turns` to 0 so the post-update work gets a fresh 30-turn budget. Separately, after 3 consecutive `write_file_tool` error tool results, the middleware injects a corrective HumanMessage (`[Sophia/path-correction directive]`) telling the model to use `/mnt/user-data/outputs/` and sets `builder_path_correction_emitted=True` for idempotency
- Companion wakeup turns are enqueued with LangGraph `context` (not a separate `configurable` payload) so runtime identity flags (`user_id`, `platform`, `is_builder_wakeup`) are propagated consistently on langgraph-api 0.7+
- The legacy `switch_to_builder` tool, `BuilderSessionMiddleware`, and the `_install_fetch_last_ai_patch` defensive monkeypatch were deleted in the Phase-1 async migration (May 2026) — the native `async_tasks` channel + `AsyncSubAgentMiddleware` own builder lifecycle now
- `BuildAwarenessMiddleware` (companion side, between `Mem0MemoryMiddleware` and `ArtifactMiddleware`) refreshes non-terminal builder entries in `state["async_tasks"]` via `langgraph_sdk.runs.get` (10s TTL cache) and injects a short prompt block (active / just-finished / errored). Sophia answers "how's the build?" naturally without the model having to call `check_async_task`
- Artifact storage / Telegram delivery: `BuilderArtifactMiddleware.after_model` uploads to Supabase under the **parent / companion thread_id** (read from `state["delegation_context"]["parent_thread_id"]`, fallback `runtime.context.thread_id`). The `_signed_artifact_url` mint and the channel-adapter `download_artifact()` lookup use the same parent thread_id, so the upload path / signed URL / bytes-download path are all aligned. `fire_completion_webhook_from_artifact` fires the gateway webhook from inside the builder graph (replaces the deleted `SubagentExecutor.terminal-flip` call site)
- Thread-id resolution in builder middlewares: prefer `runtime.execution_info.thread_id` (canonical per langgraph >= 1.0), fall back to `runtime.context["thread_id"]`, then `runtime.config["configurable"]["thread_id"]`. `langgraph-api 0.8.x` does NOT forward custom `runs.create(config={"configurable": {...}})` keys, so prefer state (e.g. `delegation_context.parent_thread_id`) for cross-graph values
- Builder middleware tracks non-artifact tool-call turns and injects stronger `<builder_endgame>` completion guidance when finalization drifts
- Builder artifact middleware only treats `_generate_*.py` files (not similarly named `_generator*.py` helpers) as forced-bash generator scripts and hard-ceiling generator fallback candidates
- `BuilderArtifactMiddleware` rejects path-traversal values in `emit_builder_artifact` (`artifact_path` + `supporting_files`) so verification/mirroring stays confined to `/mnt/user-data/outputs/`
- `SubagentExecutor` keeps timeout terminal-state guarantees while recording `last_ai_message_summary` and `late_ai_message_summary` for post-timeout diagnostics
- Companion chain now wires `SummarizationMiddleware` from `summarization` config trigger settings
- Builder chain includes `SandboxMiddleware` + `TodoMiddleware` in addition to builder-specific task/artifact middlewares
- **Builder middleware chain order** (post-Phase-4): `build_subagent_runtime_middlewares` → `FileInjectionMiddleware(soul, AGENTS)` → `UserIdentityMiddleware` → `BuilderMem0RetrievalMiddleware` → `BuilderTaskMiddleware` → `BuilderResearchPolicyMiddleware` → **`BuilderProgressMiddleware`** (Phase 4G, fires HTTP POSTs to `/internal/builder-progress` on each lifecycle hook) → `TodoMiddleware` → `BuilderArtifactMiddleware` → `PromptAssemblyMiddleware` → `DanglingToolCallMiddleware`. See [packages/harness/deerflow/agents/sophia_agent/builder_middlewares.py](packages/harness/deerflow/agents/sophia_agent/builder_middlewares.py) for the canonical wiring.
- **Builder recursion guard (D7/C2)**: [`builder_agent.py`](packages/harness/deerflow/agents/sophia_agent/builder_agent.py) raises `RuntimeError` at agent-build time if `task` or `start_async_task` is in the Builder's tool list. Builder must NEVER spawn AsyncSubAgents — that would create unbounded Builder→Builder recursion. Regression: `tests/test_builder_no_subagent_recursion.py`
- **Builder authoring tools (Phase 4M)**: `write_file_tool` documents `append: bool` — for long documents that won't fit a single model output, first call writes the opening chunk (`append=False` or omit), subsequent calls extend with `append=True`. `bash_tool` is for EXECUTION only — heredocs / `python -c "with open(...)"` / `echo > file` / `printf > file` for file authoring are explicitly prohibited by the builder system prompt every turn. Regression: [tests/test_builder_task_authoring_guidance.py](tests/test_builder_task_authoring_guidance.py)
- Regression target for the builder lifecycle: `PYTHONPATH=. uv run pytest tests/test_sophia_builder_flow.py tests/test_builder_mem0_retrieval.py tests/test_builder_no_subagent_recursion.py tests/test_builder_task_authoring_guidance.py tests/test_builder_artifact_ceiling_fallback.py -v`
- **Builder memory-contamination guard (PR #137)**: prior-task memories must NOT reach the builder, or it builds the wrong subject (a "report on Hermes" brief retrieved a prior "user requested … about OpenClaw" `fact`/`decision` at score ~1.0 and built OpenClaw). Defended on every path that feeds the builder:
  - **Builder retrieval** ([mem0_retrieval.py](packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_retrieval.py)) covers `_BUILDER_MEMORY_CATEGORIES = ["preference", "fact", "relationship", "decision", "commitment", "lesson"]` — durable build-relevant categories — **over-fetches** `_BUILDER_SEARCH_POOL = 25` then trims to `top_k` (Mem0 applies the category filter *after* the score-ranked fetch, so top_k-only could return zero rows), and **post-filters by category AND content**: a row is kept only if `category ∈` the durable set AND `_candidate_policy_rejection_reason(content) is None`. The content filter (not category-exclusion) is what removes episodic "user requested creation of X" rows — written under any category, incl. a blank/mislabeled `fact` — so Builder-as-Main runs still see durable facts/relationships ("make a card for my daughter" gets the daughter's name) while task-history can't contaminate. The original "preference only" rule was too blunt (PR #137 codex follow-up).
  - **Companion-injection path** ([mem0_memory.py](packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_memory.py) `_drop_task_history_memories`) strips **any policy-rejected** memory (drops on `_candidate_policy_rejection_reason(content) is not None`, not just `task_history` — `_candidate_policy_rejection_reason` returns the FIRST reason in priority order credential→non_durable→task_history, so a build request whose subject holds a credential marker ("a report about API key rotation") reports as `credential_like` and would otherwise mask the task-history signal; credential/non_durable records should not be injected anyway) from the companion's `<memories>` block **before the model call** — the companion always retrieves `fact`, so otherwise a stored "user asked for a report about OpenClaw" fact is visible to the model and can be echoed into a new build's `start_builder_task(description=…)` before any downstream filter runs. Lexical-only (synchronous) — this is the per-turn voice-latency path, so no LLM. Like the builder path it **over-fetches** `_MEMORY_SEARCH_POOL = 25` then trims to the platform budget (`memory_limit` — 4 voice / 10 text) *after* the drop, so a store where the top `memory_limit` rows are all build-requests still surfaces genuine memories ranked just below them instead of injecting an empty block (PR #137 Codex follow-up).
  - **Companion-embedding path** ([start_builder_task.py](packages/harness/deerflow/sophia/tools/start_builder_task.py) `_resolve_memory_snippets`) runs the same `task_history` classifier so a stored build-request snippet can't be embedded into the builder brief (defense-in-depth after the injection filter).
  - **Write side**: defense in three layers, in [extraction.py](packages/harness/deerflow/sophia/extraction.py) `_filter_policy_rejected_entries`. (1) [mem0_extraction.md](packages/harness/deerflow/sophia/prompts/mem0_extraction.md) skip-lists deliverable/build requests (the primary lever). (2) Deterministic hard drops: `credential_like` / `non_durable` (`_candidate_policy_rejection_reason`) never reach the LLM. (3) **`task_history` is LLM-authoritative**: `_classify_task_history_with_llm` (a focused **Haiku** pass, offline only, batched) decides over ALL remaining *reviewable* candidates, so a lexical false positive can't pre-empt it. **Failure semantics are load-bearing**: the classifier returns a `set` on success (possibly empty = "flag nothing") and **`None`** when classification is unavailable (error / missing client / non-JSON / non-list / no integer indices); `_filter_policy_rejected_entries` falls back to the lexical signal on `None` — a failure must NOT be read as "drop nothing" or a lexical build-request hit would slip into Mem0 (the P1 regression). The lexical `_is_deliverable_request` (request verb ask/request/want/need/would-like incl. "asked to build", "asked me/you/us for", and "would like a report" / "'d like a deck", with an optional tightly-scoped time phrase between asked/recipient and for/to — `_REQUEST_TIME_PHRASE`, "asked on Tuesday for a report" / "asked me yesterday to build" / absolute dates "asked on June 12 / 2026-06-12 / 06/12 / the 12th for …" (`_ABSOLUTE_DATE`, since the extraction prompt resolves temporals to absolute dates) — that can't swallow a topic phrase; intent/subject split so incidental topic words don't exempt; STRONG deliverable noun — report/presentation/deck/slide/webpage/infographic/spreadsheet/write-up plus frontend/web deliverables website/web page/web site/landing page/web app/single-page app/site (`_WEB_DELIVERABLE_FRAGMENT`, in parity with `start_builder_task._HTML_OUTPUT_RE` so old frontend subjects don't contaminate) plus PowerPoint/pptx/power-point (`_PPTX_DELIVERABLE_FRAGMENT`, in parity with `_PPTX_OUTPUT_RE`) — or weak noun (pdf/html/document/material/summary/brief/article/explainer/proposal/memo/whitepaper/newsletter/essay + visual chart/image/diagram/graph/illustration/mockup/wireframe/flowchart (a build-visual scoped by "of X" — "chart of Q2 revenue" — also drops; "image of …" excluded as a likely photo) + format csv/json/markdown/docx/xlsx/excel — builder deliverable types; "to brief" is exempted as a verb) + create/build cue (create/build/make/draft/generate/design/produce/prepare/write/put-together plus content-production summarize/compile/collate/assemble/export/render and the transformation "turn/convert <X> into a PDF/deck"), OR a weak noun scoped to a subject ("a PDF about X" — the subject-scoping is itself the build signal, so no create cue needed; subject markers include content participles "summarizing/outlining/detailing/describing/analyzing X" alongside about/on/covering/comparing); skill-modifier nouns like "presentation coaching", singular support-role modifiers ("a presentation coach/mentor/tutor"), and project/product compounds naming the user's own work ("report generator/tool/app", "slide builder") excluded ONLY when there is no subject AND the request is not Sophia-directed (`_PROJECT_PRODUCT_COMPOUND_RE` gated on `not _SOPHIA_DIRECTED_RE` (any directing verb — ask/request/want/need/have/get/tell/expect — at sophia/me/you/us, incl. causative "have/get Sophia build"; or asked/requested-to-<create>), no-subject branch only — "asked Sophia to build a report generator about/for X" still drops); a deliverable word used as a verb ("wants to report on X"), as the object of a help/practice/prep request ("asked for help with a presentation"), a strong noun in a non-deliverable compound ("a deck of cards", "a report card", "a deck chair/shoes", "a slide rule") or person/role compound ("website developer", "presentation designer"), the activity context of an emotional/support goal ("wants confidence for presentations", "presentation confidence/anxiety"), or an own-work goal/commitment where the user states their own intent to act ("needs to prepare a presentation by Monday", "wants to finish the report" — `_OWN_WORK_RE` "want/need/plan/… TO <verb>" gated on `not _SOPHIA_DIRECTED_RE`) excluded — but the exemption is scoped to the request INTENT, never the subject, so a real "deck about practicing for interviews" still drops; temporal "on &lt;weekday/date&gt;" is not a subject marker (so "asked on Tuesday for a report" still drops, while "focus on the presentation" stays); never a delivery preference or third-party-attributed request (third-party guard covers the party as asker "boss asked", as redirected requestee "asked their manager to", as the deliverable's SOURCE "a report from their manager", or the passive asker "was requested by their boss") — but the delivery-preference exemption checks the SINGULAR one-off signal first, so an adjectival "preferred" inside a concrete build ("requested a report in their preferred format for OpenClaw") doesn't short-circuit it, while a generic standing preference ("prefers concise reports") stays) is the fast fallback and the **synchronous companion-snippet filter** (`start_builder_task._drop_builder_task_history`, which can't call the LLM, so its noun list must stay in parity with the classifier prompt). Natural-language "is this a build request about a subject" is hard for regexes (many review rounds), so the LLM is the reliable layer. Regression: [tests/test_extraction.py](tests/test_extraction.py), [tests/test_builder_mem0_retrieval.py](tests/test_builder_mem0_retrieval.py), [tests/test_start_builder_task.py](tests/test_start_builder_task.py).

**ThreadState** (`packages/harness/deerflow/agents/thread_state.py`):
- Extends `AgentState` with: `sandbox`, `thread_data`, `title`, `artifacts`, `todos`, `uploaded_files`, `viewed_images`
- Uses custom reducers: `merge_artifacts` (deduplicate), `merge_viewed_images` (merge/clear)

**Runtime Configuration** (via `config.configurable`):
- `thinking_enabled` - Enable model's extended thinking
- `model_name` - Select specific LLM model
- `is_plan_mode` - Enable TodoList middleware
- `subagent_enabled` - Enable task delegation tool

### Middleware Chain

Middlewares execute in strict order in `packages/harness/deerflow/agents/lead_agent/agent.py`:

1. **ThreadDataMiddleware** - Creates per-thread directories (`backend/.deer-flow/threads/{thread_id}/user-data/{workspace,uploads,outputs}`)
2. **UploadsMiddleware** - Tracks and injects newly uploaded files into conversation
3. **SandboxMiddleware** - Acquires sandbox, stores `sandbox_id` in state
4. **DanglingToolCallMiddleware** - Injects placeholder ToolMessages for AIMessage tool_calls that lack responses (e.g., due to user interruption)
5. **SummarizationMiddleware** - Context reduction when approaching token limits (optional, if enabled)
6. **TodoListMiddleware** - Task tracking with `write_todos` tool (optional, if plan_mode)
7. **TitleMiddleware** - Auto-generates thread title after first complete exchange and normalizes structured message content before prompting the title model
8. **MemoryMiddleware** - Queues conversations for async memory update (filters to user + final AI responses)
9. **ViewImageMiddleware** - Injects base64 image data before LLM call (conditional on vision support)
10. **SubagentLimitMiddleware** - Truncates excess `task` tool calls from model response to enforce `MAX_CONCURRENT_SUBAGENTS` limit (optional, if subagent_enabled)
11. **ClarificationMiddleware** - Intercepts `ask_clarification` tool calls, interrupts via `Command(goto=END)` (must be last)

### Configuration System

**Main Configuration** (`config.yaml`):

Setup: Copy `config.example.yaml` to `config.yaml` in the **project root** directory.

**Config Versioning**: `config.example.yaml` has a `config_version` field. On startup, `AppConfig.from_file()` compares user version vs example version and emits a warning if outdated. Missing `config_version` = version 0. Run `make config-upgrade` to auto-merge missing fields. When changing the config schema, bump `config_version` in `config.example.yaml`.

Configuration priority:
1. Explicit `config_path` argument
2. `DEER_FLOW_CONFIG_PATH` environment variable
3. `config.yaml` in current directory (backend/)
4. `config.yaml` in parent directory (project root - **recommended location**)

Config values starting with `$` are resolved as environment variables (e.g., `$OPENAI_API_KEY`).

**Required environment variables by deliverable type**:
- Text / markdown / PDF research deliverables: only the LLM key (`ANTHROPIC_API_KEY` etc.) is required.
- **Visual deliverables (.pptx, generated images, infographics)**: `OPENAI_API_KEY` is required on the `sophia-langgraph` service because builder skills execute there. The `image-generation` skill calls OpenAI's `gpt-image-2`, and `ppt-generation` orchestrates that skill. Without the key set on LangGraph, the script exits 2 immediately so the builder doesn't loop — see [skills/public/image-generation/scripts/generate.py](../skills/public/image-generation/scripts/generate.py).
- Charts (`chart-visualization` skill): currently shells out to a Node.js script and the upstream Alipay-hosted GPT-Vis service; ensure Node.js ≥18 is on the container if you expect the model to use that path.

**Extensions Configuration** (`extensions_config.json`):

MCP servers and skills are configured together in `extensions_config.json` in project root:

Configuration priority:
1. Explicit `config_path` argument
2. `DEER_FLOW_EXTENSIONS_CONFIG_PATH` environment variable
3. `extensions_config.json` in current directory (backend/)
4. `extensions_config.json` in parent directory (project root - **recommended location**)

### Gateway API (`app/gateway/`)

FastAPI application on port 8001 with health check at `GET /health`.

**Routers**:

| Router | Endpoints |
|--------|-----------|
| **Models** (`/api/models`) | `GET /` - list models; `GET /{name}` - model details |
| **MCP** (`/api/mcp`) | `GET /config` - get config; `PUT /config` - update config (saves to extensions_config.json) |
| **Skills** (`/api/skills`) | `GET /` - list skills; `GET /{name}` - details; `PUT /{name}` - update enabled; `POST /install` - install from .skill archive (accepts standard optional frontmatter like `version`, `author`, `compatibility`) |
| **Memory** (`/api/memory`) | `GET /` - memory data; `POST /reload` - force reload; `GET /config` - config; `GET /status` - config + data |
| **Uploads** (`/api/threads/{id}/uploads`) | `POST /` - upload files (auto-converts PDF/PPT/Excel/Word); `GET /list` - list; `DELETE /{filename}` - delete |
| **Artifacts** (`/api/threads/{id}/artifacts`) | `GET /{path}` - serve artifacts; `?download=true` for file download |
| **Suggestions** (`/api/threads/{id}/suggestions`) | `POST /` - generate follow-up questions; rich list/block model content is normalized before JSON parsing |

Proxied through nginx: `/api/langgraph/*` → LangGraph, all other `/api/*` → Gateway.

### Sandbox System (`packages/harness/deerflow/sandbox/`)

**Interface**: Abstract `Sandbox` with `execute_command`, `read_file`, `write_file`, `list_dir`
**Provider Pattern**: `SandboxProvider` with `acquire`, `get`, `release` lifecycle
**Implementations**:
- `LocalSandboxProvider` - Singleton local filesystem execution with path mappings
- `AioSandboxProvider` (`packages/harness/deerflow/community/`) - Docker-based isolation

**Virtual Path System**:
- Agent sees: `/mnt/user-data/{workspace,uploads,outputs}`, `/mnt/skills`
- Physical: `backend/.deer-flow/threads/{thread_id}/user-data/...`, `deer-flow/skills/`
- Translation: `replace_virtual_path()` / `replace_virtual_paths_in_command()`
- Detection: `is_local_sandbox()` checks `sandbox_id == "local"`

**Sandbox Tools** (in `packages/harness/deerflow/sandbox/tools.py`):
- `bash` - Execute commands with path translation and error handling
- `ls` - Directory listing (tree format, max 2 levels)
- `read_file` - Read file contents with optional line range
- `write_file` - Write/append to files, creates directories
- `str_replace` - Substring replacement (single or all occurrences)
- When `SOPHIA_SUPABASE_MIRROR_ALL` is enabled, local `write_file`/`str_replace` calls mirror changed outputs incrementally and `bash` performs a post-command outputs scan for missed file writes.

### Subagent System (`packages/harness/deerflow/subagents/`)

**Built-in Agents**: `general-purpose` (all tools except `task`) and `bash` (command specialist)
**Execution**: Dual thread pool - `_scheduler_pool` (3 workers) + `_execution_pool` (3 workers)
**Concurrency**: `MAX_CONCURRENT_SUBAGENTS = 3` enforced by `SubagentLimitMiddleware` (truncates excess tool calls in `after_model`), 15-minute timeout
**Flow**: `task()` tool → `SubagentExecutor` → background thread → poll 5s → SSE events → result
**Events**: `task_started`, `task_running`, `task_completed`/`task_failed`/`task_timed_out`

### Tool System (`packages/harness/deerflow/tools/`)

`get_available_tools(groups, include_mcp, model_name, subagent_enabled)` assembles:
1. **Config-defined tools** - Resolved from `config.yaml` via `resolve_variable()`
2. **MCP tools** - From enabled MCP servers (lazy initialized, cached with mtime invalidation)
3. **Built-in tools**:
   - `present_files` - Make output files visible to user (only `/mnt/user-data/outputs`)
   - `ask_clarification` - Request clarification (intercepted by ClarificationMiddleware → interrupts)
   - `view_image` - Read image as base64 (added only if model supports vision)
   - Sophia companion-only: `view_user_image`, `read_user_document` (thread-scoped wrappers — see Sophia Vision Port below)
4. **Subagent tool** (if enabled):
   - `task` - Delegate to subagent (description, prompt, subagent_type, max_turns)

**Community tools** (`packages/harness/deerflow/community/`):
- `tavily/` - Web search (5 results default) and web fetch (4KB limit)
- `jina_ai/` - Web fetch via Jina reader API with readability extraction
- `firecrawl/` - Web scraping via Firecrawl API
- `image_search/` - Image search via DuckDuckGo

### MCP System (`packages/harness/deerflow/mcp/`)

- Uses `langchain-mcp-adapters` `MultiServerMCPClient` for multi-server management
- **Lazy initialization**: Tools loaded on first use via `get_cached_mcp_tools()`
- **Cache invalidation**: Detects config file changes via mtime comparison
- **Transports**: stdio (command-based), SSE, HTTP
- **OAuth (HTTP/SSE)**: Supports token endpoint flows (`client_credentials`, `refresh_token`) with automatic token refresh + Authorization header injection
- **Runtime updates**: Gateway API saves to extensions_config.json; LangGraph detects via mtime

### Skills System (`packages/harness/deerflow/skills/`)

- **Location**: `deer-flow/skills/{public,custom}/`
- **Format**: Directory with `SKILL.md` (YAML frontmatter: name, description, license, allowed-tools)
- **Loading**: `load_skills()` recursively scans `skills/{public,custom}` for `SKILL.md`, parses metadata, and reads enabled state from extensions_config.json
- **Injection**: Enabled skills listed in agent system prompt with container paths
- **Installation**: `POST /api/skills/install` extracts .skill ZIP archive to custom/ directory

### Model Factory (`packages/harness/deerflow/models/factory.py`)

- `create_chat_model(name, thinking_enabled)` instantiates LLM from config via reflection
- Supports `thinking_enabled` flag with per-model `when_thinking_enabled` overrides
- Supports `supports_vision` flag for image understanding models
- Config values starting with `$` resolved as environment variables
- Missing provider modules surface actionable install hints from reflection resolvers (for example `uv add langchain-google-genai`)

### IM Channels System (`app/channels/`)

Bridges external messaging platforms (Feishu, Slack, Telegram) to the DeerFlow agent via the LangGraph Server.

**Architecture**: Channels communicate with the LangGraph Server through `langgraph-sdk` HTTP client (same as the frontend), ensuring threads are created and managed server-side.

**Components**:
- `message_bus.py` - Async pub/sub hub (`InboundMessage` → queue → dispatcher; `OutboundMessage` → callbacks → channels)
- `store.py` - JSON-file persistence mapping `channel_name:chat_id[:topic_id]` → `thread_id` (keys are `channel:chat` for root conversations and `channel:chat:topic` for threaded conversations)
- `manager.py` - Core dispatcher: creates threads via `client.threads.create()`, routes commands, keeps Slack/Telegram on `client.runs.wait()`, and uses `client.runs.stream(["messages-tuple", "values"])` for Feishu incremental outbound updates
- `base.py` - Abstract `Channel` base class (start/stop/send lifecycle)
- `service.py` - Manages lifecycle of all configured channels from `config.yaml`
- `slack.py` / `feishu.py` / `telegram.py` - Platform-specific implementations (`feishu.py` tracks the running card `message_id` in memory and patches the same card in place)
- Telegram attachment downloads triggered by `ChannelManager` must be dispatched back onto `telegram.py`'s `_tg_loop` (using `asyncio.run_coroutine_threadsafe`) because PTB bot I/O is loop-affine to the polling thread loop.
- Telegram builder completion delivery uploads artifact bytes directly (instead of passing signed URLs to Telegram), and truncates outgoing text to Telegram API limits (`send_document` caption 1024 chars, `send_message` text 4096 chars).

### Builder deliverable truth + visual reliability (2026-06-10 incident wave)

Root-caused from production logs (Anthropic credit exhaustion at 09:11 UTC pushed all builder turns onto the OpenAI provider fallback, which follows the visual workflow weakly): text-only decks/PDFs shipped while generated chart PNGs sat unused, rendered primaries were mislabeled as fallbacks, and the frontend surfaced `.pdf.md` render sources over the real PDFs. The invariants now enforced:

- **A delivered artifact in the requested format is NEVER a fallback.** `_apply_artifact_request_metadata` ([builder_artifact.py](packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py)) force-clears `artifact_is_fallback`/`fallback_reason` when `artifact_ext == requested_ext`. Missing visuals on a rendered primary become `quality_warning="visuals_not_embedded"` + `visuals_missing=true` (capped confidence, honest tone hint) via `_apply_visual_missing_quality_metadata` — never a fallback flag.
- **Format-swapped fallbacks are DISABLED for pdf/pptx requests.** A `.md`/`.html` emission for a pdf/pptx target is rejected at emit time (`pdf_fallback_disabled` / `pptx_fallback_disabled`), and `_build_ceiling_fallback` refuses to promote a mismatched-extension file — the build completes as an honest failure (`artifact_path=null`) instead. Intermediate sources stay in session artifacts. The workflow cards (`skills/public/sophia/builder_workflows/{pdf,pptx}.md`) document the policy; regression in `tests/test_builder_prompt_contract.py`.
- **ONE carve-out (correction wave 2026-06-12, NOT a fallback): explicit user intent beats a misderived target.** `_format_conflict_user_override` fires only when ALL hold: `delegation_context["user_requested_ext"]` is stamped (dispatch-derived from the CURRENT user turn, negation-vetoed), it differs from the target ext, the EMITTED ext equals the user ext exactly, and no post-interrupt target update/epoch advanced. It re-points `builder_artifact_target_path` (state overlay at the three emit decision sites, BEFORE `_authoritative_pdf_emit_args` — which would otherwise hijack the reverse conflict) so the emitted format's own integrity gates re-apply and `_apply_artifact_request_metadata` takes the never-a-fallback branch. Stamps `format_conflict_resolved="user_intent"` + `format_conflict_original_target_ext` (whitelisted in the 3 payload sites) — every occurrence is a dispatch-resolution failure signal. Prod incident: a correct 9-page PDF was rejected on every emit because dispatch said pptx for an "actual PDF report (not a presentation)" ask. Regression: `tests/test_builder_format_conflict_guard.py`.
- **Visual hard gate, bounded to one repair turn.** `_visual_gate_blocks_emit` (applied at emit decision points in `after_model` + `wrap_tool_call`, NOT inside `_artifact_files_exist` — recovery/override helpers depend on that predicate staying permissive) rejects the first visuals-requested emit with no embedded visuals; the rejection message lists the already-generated PNG paths with format-specific embed instructions. `builder_visual_embed_rejections` spends the repair turn; the second emit soft-passes with the quality warning.
- **Plan auto-wiring.** `_maybe_autowire_pptx_plan_visuals` intercepts the ppt-generation bash call: drops slide `image`/`chart_path`/`visual_path` refs pointing at nonexistent files (which would abort composition) and, when visuals were requested but no slide references one, assigns existing `outputs/visuals/*.png` assets round-robin across content slides before the script runs. `generate.py` also degrades a missing slide image to the text layout instead of raising.
- **`render_markdown_to_pdf` resolves relative image refs.** Pandoc runs with `cwd` at the source dir + `--resource-path` (source dir + outputs root) — the card-prescribed `![Diagram](visuals/x.png)` previously dropped silently (pandoc warns but exits 0 → `image_count=0` text-only PDFs). The success payload now carries `source_image_ref_count`, `images_missing`, and `missing_resources` (parsed from pandoc stderr) so the model and the visual gate can react.
- **Source siblings are not re-uploaded as deliverables.** `_is_source_sibling_of_primary` filters `supporting_files` at upload (e.g. `sophia-roadmap.pdf.md` next to `sophia-roadmap.pdf`); frontend ranking must also never auto-surface them.
- **PPTX canvas preview.** After a valid `.pptx` emit, `deerflow/sophia/pptx_preview.py::maybe_render_pptx_preview` converts it to `<stem>.preview.pdf` via headless `soffice` (Dockerfile.langgraph installs `libreoffice-impress`; skipped gracefully when absent), attaches `artifact_preview_filename` to the completion payload (whitelisted through `builder_events.py` + `builder_canvas.py`), and the webapp renders the deck through the existing PDF canvas while downloads keep serving the `.pptx`.

Regression targets: `tests/test_render_markdown_to_pdf.py tests/test_builder_visual_artifacts.py tests/test_builder_artifact_ceiling_fallback.py tests/test_pptx_preview.py tests/test_sophia_middlewares.py tests/test_builder_prompt_contract.py`.

### Spec VQ wave — visual quality gates + build-to-condition loop (2026-06-11)

Implements `spec_vq_builder_visual_quality.md` (validated against prod logs + the two failed artifacts) plus three prod bug fixes:

- **F1 — HTML truncation loop FIXED**: builder `max_tokens` 8192→32768 + client timeout 240s ([builder_agent.py](packages/harness/deerflow/agents/sophia_agent/builder_agent.py)); `_truncation_correction_update` injects a chunking-specific correction when missing tool args coincide with `stop_reason=max_tokens` (the generic arg-correction retried the same oversized write until the 4-strike stop); completion_instruction teaches HTML chunk-by-default. Regression: `tests/test_builder_truncation_correction.py`.
- **F2 — duplicate tool_result 400 FIXED**: `patch_dangling_tool_call_messages` is duplicate-PROOF (every same-id tool_result after the first is dropped request-side; Anthropic now rejects duplicates — the old docstring claimed otherwise) and logs `tool:id` of dropped duplicates as the root-cause diagnostic. Regression: `tests/test_dangling_tool_call_middleware.py`.
- **F3 — PDF template FIXED**: prod rc=5 was a `$if$` token in the template's own HEADER COMMENT (pandoc's template engine reads every `$`, LaTeX comments included). Validated against the exact container pandoc 2.17.1.1. Guards: `test_template_has_no_bare_dollar_directives` (pure), pandoc-gated full-parse test (CI installs pandoc), `make pdf-template-smoke` (docker, exact-version). `$coverimage$` hook added (VQ-5).
- **VQ-1/2 — deterministic visual engine** ([generate_visual_asset.py](packages/harness/deerflow/sophia/tools/generate_visual_asset.py)): `_fit_text` measure→wrap(<tspan>)→shrink→ellipsize engine kills label overlap + title clipping on all three renderers (pillow fallback now walks tspans); 10 kinds → 10 distinct layouts (real matrix grid, layered architecture diagram with orthogonal arrows, radial concept map, chevron process flow; optional `rows`/`edges`/`groups` schema). G-VIS-1 (zero bbox overlap) + G-VIS-2 (structural distinctness) goldens: `tests/test_visual_engine_goldens.py`.
- **VQ-3 — outcome accounting**: harness-stamped `image_generation_outcome {attempted, succeeded, skip_reason?}` on every enrichment-enabled completion (never model-supplied); `--preflight` on the image-gen script (env/auth check, one JSON line) recorded via `_image_generation_preflight_delta` (never counted as an attempt, never blocked). skip_reason taxonomy: env_missing | auth_invalid | egress_blocked | org_not_verified | content_policy | model_skipped | failed_after_retry.
- **VQ-4 — hero/cover gate**: `_hero_gate_blocks_emit` — enrichment-enabled deck/PDF with zero generated images and no honest skip gets a repair turn (preflight → hero JSON → script → `full_bleed_image` wiring); soft-pass ships `quality_warning=hero_missing|cover_missing`.
- **VQ-5 — PDF enrichment scope**: `_image_generation_enabled` now includes `.pdf ∧ visuals-requested`; per-ext cap (`_image_generation_max_calls`: pdf=2, else 3); `render_markdown_to_pdf` auto-passes `-V coverimage=` when `visuals/cover-*.png` exists (forces titlepage).
- **VQ-6 — preview self-review**: repair turns attach `pdftoppm` rasters of the deck preview / PDF pages + the Composio-adapted checklist as image blocks on the rejection ToolMessage (poppler-utils in Dockerfile.langgraph; graceful text-only fallback).
- **VQ-7 — variety guard**: per-build fingerprint registry (`outputs/visuals/.registry.json`) rejects duplicate (kind, title+data) calls with the existing path.
- **VQ-8 — design language**: 6 compositor themes (+terra, +noir), `motif` field, `stat_band` layout, `lint_plan` cadence warnings (PLAN_LINT stderr), SKILL.md Design Ideas (60/30/10, never-stack-charts, layout-content matching).
- **VQ-10 — build-to-condition loop (cap=3)**: shared `build_iterations` budget across visual/hero/advisory gates ([build_condition.py](packages/harness/deerflow/sophia/build_condition.py): `iteration_cap` via `SOPHIA_BUILDER_MAX_ITERATIONS`, default 3, =1 restores one-shot); budget pre-grant (`budget_allows_iteration`, ~$0.25/iteration estimate); ONE advisory Haiku+vision pass (`builder_advisory_consumed`, env `SOPHIA_BUILDER_VQ_ADVISORY`); `iterations_used` + `unmet_conditions[]` in the completion payload; `refining` progress phase; anti-masking `loop_masking_candidate` logs. **CRITICAL hook-order trap**: gate counters and `build_iterations` increment ONLY in the wrap_tool_call rejection Command — after_model runs BEFORE tool execution, and incrementing there makes wrap_tool_call see the gate as spent and accept without a repair turn.
- **VQ-9 — provider matrix**: `SOPHIA_BUILDER_FORCE_PROVIDER=openai` eval hook in builder_provider_fallback; anchor fixtures + SDK-driven runner `tests/evals/visuals/run_matrix.py`; `make eval-visuals`; nightly + manual-dispatch lane [.github/workflows/visual-evals.yml](../.github/workflows/visual-evals.yml). PRs run only the free goldens.

Regression targets: `tests/test_builder_truncation_correction.py tests/test_dangling_tool_call_middleware.py tests/test_builder_enrichment_gates.py tests/test_build_condition_loop.py tests/test_visual_engine_goldens.py tests/test_generate_visual_asset.py tests/test_ppt_generation_layouts.py tests/test_render_markdown_to_pdf.py`.

### Image-gen enrichment + artifact-skill quality (2026-06-11 wave)

Follow-up to the incident wave: prompt-layer truth fixes + enrichment-by-default + skill upgrades.

- **Generated imagery is ON BY DEFAULT for decks** (`task_type ∈ {presentation, visual_report}` or `.pptx` target): `_image_generation_enabled` ([builder_task.py](packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py)) replaces the old explicit-marker gate; plain markers (`plain`, `text-only`, `no images`, `minimal`, `charts only`) opt out. An `<image_enrichment>` briefing block states the policy. `start_builder_task._build_enriched_description` appends a `Visual expectations:` line to presentation/visual_report briefs.
- **Discipline is harness-enforced**: `BuilderArtifactMiddleware._image_generation_block_command` intercepts image-gen bash calls — hard cap `_IMAGE_GENERATION_MAX_CALLS = 3` per build (counts `&&`-chained invocations), terminal-error short-circuit (`missing_api_key` etc. after one failure ⇒ "proceed with charts/text"), plus a one-shot `[Sophia/image-generation stop]` correction after 2 failed attempts. `BuilderBudgetMiddleware` folds `_IMAGE_GEN_COST_USD = 0.07 × attempts` into the cost ceiling (reads `builder_pptx_diagnostics` via `state.get` — NEVER redeclare that reducer-backed channel in a middleware state schema). Safety/craft guidance lives in `skills/public/image-generation/SKILL.md` § "Business Deck & Report Enrichment" (no identifiable people/celebrities/logos/text-in-images; hero-first with `--reference-images` chaining; 16:9 hero / 4:3 card; `visuals/hero-<desc>.png` naming).
- **PPTX compositor** (`skills/public/ppt-generation/scripts/generate.py`): 8 layouts via `LAYOUT_DISPATCH` + `resolve_layout` (per-slide `layout` field, backward-compatible inference) and 4 named `THEMES` (boardroom/daylight/ember/mist, `plan.theme` > `plan.style` via `_STYLE_ALIASES`, default daylight). Autowire (`_maybe_autowire_pptx_plan_visuals`) is layout-aware: GPT-generated images (`builder_pptx_diagnostics.image_output_paths`, .png/.jpg — previously never autowired) go hero-first onto title/divider slides as `full_bleed_image`; deterministic chart PNGs round-robin onto content slides.
- **PDF template**: `render_markdown_to_pdf` renders through the vendored pandoc template [sophia/assets/sophia.latex](packages/harness/deerflow/sophia/assets/sophia.latex) with `_PDF_THEMES` (boardroom/minimal/warm; theme param → `sophia-theme:` frontmatter → minimal), cover page from `title:`/`subtitle:` frontmatter, fancyhdr footer, auto `--toc` over ~3500 words; one template-less retry on failure (`template_fallback: true` in the payload). Conservative LaTeX package whitelist only (no tikz/tcolorbox/fontawesome — container lacks texlive-fonts-extra); the skipif-gated integration smoke in the container validates it.
- **Prompt truth**: `builder_obligations.md` "Deliverable Truth — No Format Swaps" + "Visual Strategy" replace the stale fallback contract; `builder_task.py` per-turn guidance strings rewritten (no more ".md/.html fallback" instructions); `companion_delegation.md` Result Handling covers `quality_warning`/`visuals_missing` success, honest failure (`artifact_path=null`), voice brevity, and Visual Briefs; `BuildAwarenessMiddleware._render_terminal_block` surfaces the quality note and relays the builder's failure summary.

Regression targets: `tests/test_builder_image_generation_cap.py tests/test_ppt_generation_layouts.py tests/test_render_markdown_to_pdf.py tests/test_build_awareness_lifecycle_block.py tests/test_start_builder_task.py tests/test_builder_budget.py`.

### Correction wave — target-format truth (2026-06-12)

From the 2026-06-12 prod analysis ([docs/audits/prod-log-analysis-2026-06-12.md](../docs/audits/prod-log-analysis-2026-06-12.md)): two intended-PDF runs dispatched as `target_ext=pptx` (description contamination + pptx-before-pdf ordering); one failed terminally with a correct PDF on disk.

- **Current-turn-first format resolution** ([start_builder_task.py](packages/harness/deerflow/sophia/tools/start_builder_task.py) `_resolve_target_format`): `user_requested_ext` matches the CURRENT user turn (`extract_last_human_text(state["messages"])`); the model-authored description only fills in when the turn is silent; task-type default last. Edit-flow overrides convert to the user's ext when it differs from the source artifact's (`current_user_turn_conversion`). `delegation_context` gains `user_requested_ext` + `format_resolution_source`; the dispatch log gains both plus `context_inferred_ext` + `negation_vetoed_rules` (rule names only — never prompt text).
- **Negation veto** (`_pattern_affirmative_match`): a format mention preceded by negation ("not a presentation", "no slides", "instead of", "rather than", "without", "don't want") within a 32-char lookback never claims the target; a pattern wins only on an affirmative hit. Shared by the update wrapper via `_requested_output_extension`.
- **Emit-time format-conflict guard**: see the carve-out bullet under "Builder deliverable truth" above.
- **Provider-resilient brief extraction** ([brief_extraction.py](packages/harness/deerflow/sophia/brief_extraction.py)): a provider-classified primary failure (`classify_provider_error` — same sophia-layer classifier the builder fallback uses) gets ONE retry via `build_fallback_chat_model()`; skip reasons name the error class (`reason=auth_error` not `model_error`). During the 2026-06-12 Anthropic 401 outage extraction was dead for the whole window.
- **Ledger log hygiene** ([delegation_ledger.py](packages/harness/deerflow/sophia/delegation_ledger.py)): Supabase answers **400** (not only 404) for the expected no-mirror-yet first-turn shape — now `debug` "no mirror yet", with warning+traceback reserved for real transport failures; the no-event-loop mirror skip in the middleware now logs instead of silently degrading.

Regression targets: `tests/test_target_format_resolution.py tests/test_builder_format_conflict_guard.py tests/test_brief_extraction.py tests/test_delegation_ledger.py tests/test_start_builder_task.py`.

### Spec D — Delegation Boundary: builder context package (2026-06-11)

Implements `spec_d_delegation_boundary.md`: the companion→builder boundary gains a flush above (digest + extraction) and a floor beneath (ledger + recall tool). Before this wave the builder received only the Haiku-authored `description` + ≤5 current-turn memory snippets — no conversation record, authored from a possibly-compacted view.

- **D-1 — delegation ledger** ([delegation_ledger.py](packages/harness/deerflow/sophia/delegation_ledger.py) + [middlewares/delegation_ledger.py](packages/harness/deerflow/agents/sophia_agent/middlewares/delegation_ledger.py)): append-only per-session JSONL at `users/{user_id}/traces/{thread_id}.ledger.jsonl` — one entry per companion turn (`turn_number`, verbatim `user_text` ≤4k chars + truncation flag, emit_artifact subset, deterministic `deliverable_intent`). `DelegationLedgerMiddleware` sits **immediately after ArtifactMiddleware, before summarization is appended** (chain-position-locked by test); local append is sub-ms and never raises. **Turn numbering comes from the ledger, not `turn_count`** (`next_turn_number`) — `turn_count` is message-derived and collapses after `RemoveMessage(REMOVE_ALL_MESSAGES)`.
- **Supabase mirror (topology-required)**: companion/builder/start_builder_task are all langgraph-side (same disk), but session DELETION is gateway-side on a separate ephemeral disk — so every append fire-and-forget mirrors the whole file to `{thread_id}/ledger/session.jsonl` (`ledger_object_name()` beside `uploads_object_name`); reads fall back to the mirror (`read_ledger_with_fallback`); `append_turn` **materializes the mirror before the first post-restart append** (else the next whole-file upsert overwrites the longer pre-restart copy); gateway `delete_session` + `delete_all_sessions` delete the mirror object (404-idempotent) + best-effort local unlink. **NEVER await the mirror inline in the turn path** (100-300ms/turn).
- **D-2 — deterministic digest**: `start_builder_task._resolve_dispatch_digest` reads the ledger once at dispatch → `build_digest` (goal-evolution header + deliverable-intent ∪ last-5 `t{n}:` lines, ≤1,400 chars, deterministic drop order, omitted under 4 entries) → "Conversation decisions relevant to this build:" section in the enriched description. `delegation_context` gains `delegation_ledger` stats (`turns/deliverable_intent_turns/was_summarized/available`) + `dispatched_at_turn` (**a LEDGER watermark = last entry + 1, never state `turn_count`** — the delta filter compares ledger numbering). `update_async_task_wrapper._delta_digest_block` prefixes `[Conversation since dispatch]` (≤700 chars, `turn_number > dispatched_at_turn`) inside `_augment_update_message`.
- **D-3 — brief extraction, BUILDER-side** ([brief_extraction.py](packages/harness/deerflow/sophia/brief_extraction.py)): approved divergence from the spec text — a Haiku call inside `start_builder_task` would add 1-3s to the dispatching companion turn (voice 3s target) exactly on long sessions. Runs in `BuilderTaskMiddleware` briefing assembly: deterministic trigger (`was_summarized OR turns ≥ 20 OR deliverable_intent_turns ≥ 6`, from the dispatch-stamped stats), one Haiku call (advisory_review pattern: timeout 30s, max_retries=0, any-failure→None+`[BriefExtraction] skipped reason=…`), schema `{audience, purpose, format_and_length, must_include[], must_exclude[], sources_and_examples[], style_preferences[], decisions_made[], open_questions[]}` — **every populated field must carry `[t{n}]` provenance or it is NULLED, never invented**. Rendered as `<build_brief_schema>`; raw dict → `state["brief_schema"]`. Idempotent across resume runs (existing schema skips the call AND the duplicate section). **Never import this into a companion-side hook.**
- **D-4 — read_session_context** ([tools/read_session_context.py](packages/harness/deerflow/sophia/tools/read_session_context.py)): builder tool, `read_user_document` scoping discipline — NO user/session params; parent scope from `state["delegation_context"]` (canonical; langgraph-api 0.8.x drops custom configurable keys) with config fallback; `validate_user_id`+`safe_user_path` make cross-session reads structurally impossible. BM25-lite token overlap, recency tie-break, `t{n} (ts): text` hits. **Cap 4/build self-enforced in the tool** via `builder_session_context_reads` (declared on BuilderTaskState — Command updates only persist for declared keys); no budget fold (pure local read). Registered behind the flag in builder_agent.py; `<session_recall>` briefing line when a ledger exists.
- **D-5 — brief gate as briefing directive, NOT the emit-time iteration controller** (approved divergence): the controller fires at emit; rejecting there wastes an entire build on a turn-0-repairable brief and re-opens the counter/rejection-loop trap. `build_condition.brief_complete(task_type, schema)` (presentation/visual_report/document: audience+purpose+format_and_length+≥1 of must_include|sources; code/frontend: purpose+format_and_length+must_include; no schema/unknown type → always complete) → `<brief_gate>` block naming missing fields ("recover via read_session_context; genuinely absent → stated assumption; NEVER ask the user"). New optional emit arg `brief_assumptions[]` (14th field) whitelisted in the 3 canonical payload sites + BuildAwareness terminal block + companion_delegation.md relay rule. **Honesty stamp**: `brief_gate_unmet_conditions` appends `brief_incomplete:<field>` to the existing `unmet_conditions[]` when gaps were flagged ∧ assumptions empty ∧ zero reads — observability, never a rejection.
- **Flags** (all default ON, each independently reverts to current behavior): `SOPHIA_DELEGATION_LEDGER` · `SOPHIA_DELEGATION_DIGEST` · `SOPHIA_DELEGATION_EXTRACTION` · `SOPHIA_DELEGATION_READ_TOOL` · `SOPHIA_DELEGATION_BRIEF_GATE`. Every consumer treats ledger-missing as feature-silently-off.
- **Privacy (AD-6)**: no ledger content in any log line — IDs, turn numbers, byte counts only. Session deletion deletes the ledger (mirror = the authoritative prod copy). Interim posture: plaintext JSONL in the existing Supabase bucket (same class as PR #132 uploads) until S0-Δ2.
- **Supporting changes**: `was_summarized: True` stamped by SophiaSummarizationMiddleware on compaction (no flag existed; inferring from `<prior_context_state>` is fragile); fixture `tests/evals/fixtures/delegation_long_session.json` (40 turns; audience@t3, style@t12, data@t18, exclusion@t25).

Live lane: `make eval-delegation` (`tests/evals/delegation/run_matrix.py` — runner and langgraph must share a working dir; complete + incomplete-brief fixtures; the OpenAI leg asserts extraction degrades to digest-only without failing the build).

Regression targets: `tests/test_delegation_ledger.py tests/test_delegation_digest.py tests/test_brief_extraction.py tests/test_read_session_context.py tests/test_brief_gate.py tests/test_start_builder_task.py`.

### Builder progress streaming (webhook relay — Phase 4H+)

The live `[ Researching ]` → `[ Drafting ]` → `[ Finalizing ]` → `[ Done ]` placeholder UX is delivered via an HTTP webhook relay (NOT SDK streaming). The full architecture and rationale are documented in [CLAUDE.md (root)](../CLAUDE.md) under "Builder progress streaming". Key gateway-side primitives:

- **`app/gateway/builder_progress/registry.py::BuilderProgressRegistry`** — per-process singleton, channel-agnostic. Maps `task_id` → `(chat_id, message_id, channel_name, run_id, ProgressRenderer)`. Per-entry `asyncio.Lock` serializes renderer mutation + callback await so concurrent webhooks for the same task_id can't interleave at the renderer-state boundary. Identity-guarded unregister (`expected_entry=entry`) protects against the `update_async_task` replacement-run race. Bounded terminal-edit retry (3 attempts, 2/5/15s backoff) protects against transient Telegram 5xx — completion webhooks are LRU-deduped server-side so a single failed edit without retry would permanently strand the placeholder.
- **`app/channels/telegram_progress_renderer.py::ProgressRenderer`** — event → plain-text body. `_TOOL_LABELS` maps tool name → `(emoji, verb)`; `_HIDDEN_TOOLS = {"ls", "read_file", "str_replace", "todo_read", "todo_write", "bash"}` suppresses noisy tools from the activity stream (bash hidden because verification/inline-Python ops clutter the placeholder — trade-off accepted: binary-deliverable generator scripts also show no live signal during the ~30-60s run; the artifact still arrives via the terminal webhook). `mark_done` clears accumulated `activity_lines` so the final body is `[ Done ]` + optional summary. `mark_stalled` (per-event timeout) and `mark_stopped` (error / cancel) PRESERVE activity history — in those degraded states the history is the user's last honest signal.
- **`app/gateway/routers/builder_events.py` and `app/gateway/routers/builder_canvas.py`** — internal webhook endpoints plus the authenticated browser interface:
  - `POST /internal/builder-events` — terminal completion from langgraph (fire-and-forget channel fan-out via `asyncio.create_task` so the daemon-thread timeout doesn't trip).
  - `POST /internal/builder-progress` — live progress events from `BuilderProgressMiddleware`.
  - `GET /api/sophia/{user_id}/threads/{thread_id}/builder-canvas/events` — authenticated webapp SSE for curated progress and terminal events; consumed through the same-origin frontend proxy.
  - `GET /api/sophia/{user_id}/threads/{thread_id}/builder-canvas/snapshot` — native-run hydration plus bounded recent activity recovery.
- **`packages/harness/deerflow/agents/sophia_agent/middlewares/builder_progress.py::BuilderProgressMiddleware`** — async lifecycle hooks (`abefore_agent` / `aafter_model` / `aafter_agent`) emit fire-and-forget HTTP POSTs to `/internal/builder-progress`. Tool-name classification uses lowercase substring match (e.g., `search`/`fetch`/`browse`/`scrape` → `researching`). `_trim_tool_args` strips heavy fields like `write_file.content` from the payload (preserves only `query`/`url`/`path`/`command` per tool — the renderer only reads those). Strong-ref `_POST_TASKS` set with discard-on-done prevents GC of in-flight POSTs (v3-migration learning #4).

**Webapp integration path (Stream Canvas V1)**:

The browser does not register a channel placeholder. `BuilderCanvasWorker` independently receives valid webhook events, projects curated phase/tool labels without raw arguments, buffers 64 events per run for SSE reconnect, and merges terminal completion into the same stream. The browser opens the same-origin `/api/sophia/builder/threads/{threadId}/canvas/*` proxy routes; authenticated gateway endpoints verify session-thread ownership and use native LangGraph `async_tasks` / run status for snapshot and cancel authority.

Event sequence the webapp will see:

```
custom   {"name": "phase", "phase": "starting"}    → header [ Working ]
updates  {"agent": {"messages": [{"tool_calls": [{"name": "builder_web_search", "args": {"query": "..."}}]}]}}
                                                   → activity line "🔍 Searching: ..."
custom   {"name": "phase", "phase": "researching"} → header [ Researching ]
... (drafting / finalizing transitions as the builder progresses)
custom   {"name": "phase", "phase": "done"}        → header [ Done ], activity cleared
(terminal webhook delivers artifact via _on_builder_completion)
```

The webapp can either reuse `ProgressRenderer.apply` directly (delivers plain-text bracket-header bodies that work in any UI) OR consume the structured events and render a richer UI matching the same `_TOOL_LABELS` / `_HIDDEN_TOOLS` conventions for visual consistency with Telegram.

**Message Flow**:
1. External platform -> Channel impl -> `MessageBus.publish_inbound()`
2. `ChannelManager._dispatch_loop()` consumes from queue
3. For chat: look up/create thread on LangGraph Server
4. Feishu chat: `runs.stream()` → accumulate AI text → publish multiple outbound updates (`is_final=False`) → publish final outbound (`is_final=True`)
5. Slack/Telegram chat: `runs.wait()` → extract final response → publish outbound
6. Feishu channel sends one running reply card up front, then patches the same card for each outbound update (card JSON sets `config.update_multi=true` for Feishu's patch API requirement)
7. For commands (`/new`, `/status`, `/models`, `/memory`, `/help`): handle locally or query Gateway API
8. Outbound → channel callbacks → platform reply

**Configuration** (`config.yaml` -> `channels`):
- `langgraph_url` - LangGraph Server URL (default: `http://localhost:2024`)
- `gateway_url` - Gateway API URL for auxiliary commands (default: `http://localhost:8001`)
- Per-channel configs: `feishu` (app_id, app_secret), `slack` (bot_token, app_token), `telegram` (bot_token)

### Render production deployment

**TL;DR:** the file the live containers actually load is `/app/config.yaml`, baked in at Docker build time from **`config.production.yaml`** (the tracked one in repo root) via `COPY config.production.yaml ./config.yaml` in both [Dockerfile.gateway:8](Dockerfile.gateway) and `Dockerfile.langgraph`. The repo's local `config.yaml` is `.gitignore`'d and irrelevant to production.

**Critical: the config resolver hard-fails on any missing `$VAR`.** [`AppConfig.resolve_env_variables`](packages/harness/deerflow/config/app_config.py) at line 188-190 raises `ValueError` when an env var referenced via `$NAME` syntax isn't set in the process environment. There is no tolerant `${NAME:-default}` syntax. **Both services load this file at startup** — adding a `$VAR` to `config.production.yaml` requires the env var to be set on **both** the gateway service and the langgraph service in Render's dashboard (or the missing one crashes at boot).

**Hardcode-vs-env-var rule:** if the value is a secret (token, key, signed URL), use `$VAR` and ensure both services have it. If the value is public (bot username, channel name, `recursion_limit`), hardcode it in YAML.

**Required Render env vars** (declared in `render.yaml` with `sync: false` = "operator-set in dashboard, Render won't auto-populate"):

| Service | Required env vars |
|---|---|
| `sophia-gateway` | `ANTHROPIC_API_KEY`, `MEM0_API_KEY`, `STREAM_API_KEY`, `STREAM_API_SECRET`, `LANGGRAPH_URL`, `SOPHIA_VOICE_SERVER_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` |
| `sophia-langgraph` | `ANTHROPIC_API_KEY`, `MEM0_API_KEY`, `SOPHIA_GATEWAY_URL` (target for `BuilderProgressMiddleware` HTTP POSTs — defaults to `http://localhost:8001`), plus any token referenced by `config.production.yaml` (currently `TELEGRAM_BOT_TOKEN`) |
| `sophia-voice` | (see render.yaml for the voice service envVars list) |

**Deployment verification recipe** (run in the Render shell after a deploy):
```bash
cat /app/config.yaml | head -60   # confirm the file is the one baked from config.production.yaml
ls -la /app/config.yaml           # timestamp matches deploy time = baked at build
echo "---"
env | grep -E "TELEGRAM|ANTHROPIC|MEM0|SOPHIA_GATEWAY_URL" | sed 's/=.*$/=<set>/'   # verify env vars set
```

**Startup log fingerprints** (gateway service): the channels listed in `config.production.yaml::channels` log `Channel <name> started` (or `disabled, skipping` if `enabled: false`). Builder progress signals look like `[BuilderProgress] task registered task_id=... run_id=... message_id=...` (channel callback registered the placeholder) and `[BuilderProgress] task unregistered task_id=...` (on terminal).

**The `runs.wait` 400 trap** — channel adapters that call `client.runs.wait(...)` / `runs.create(...)` against the langgraph HTTP service MUST set `thread_id` / `user_id` / `channel` in `context` ONLY, NEVER also in `config["configurable"]`. langgraph-api 0.7+ rejects both-channels payloads with HTTP 400 in <1ms (pre-run validation):
```
"Cannot specify both configurable and context. Prefer setting context alone."
(langgraph_api/models/run.py:225-228)
```
See [manager.py](app/channels/manager.py) for the working pattern. langgraph-api copies `context` → `configurable` server-side (run.py:233), so factories like `make_sophia_builder(config)` still read `cfg["configurable"]["user_id"]` correctly. `start_builder_task.py` is allowed to set `configurable` because it dispatches via SDK ASGI in-process transport (`get_client(url=None)`), which has different validation. Regression-guard test in [tests/test_channels.py::TestDispatchPayloadShape](tests/test_channels.py).

**`readabilipy` / `jsdom` build-time install (Phase 4L)** — `Dockerfile.langgraph` pre-installs the readabilipy Node.js dependency (`jsdom`) at image build time via `cd .../readabilipy/javascript && rm -rf node_modules && npm install`. Without this, the wheel-shipped partial `node_modules/jsdom/` tree causes a runtime `ENOTEMPTY` npm error on every `web_fetch` → Readability.js falls back to pure-Python extraction → content quality collapses → long-form research builds loop until force-emit ceiling. The pre-install is langgraph-only — `Dockerfile.gateway` doesn't need it.

### Sentrux scoring (CI gate at `.github/workflows/sentrux-gate.yml`)

The blocking gate (`sentrux gate .`) does **NOT** fail on small `quality_signal` deltas. It fails on **categorical** regressions: cycles count, god-files count, complex-functions count, coupling threshold breaches. The gate has internal tolerance bands; PR #120 shipped `+14 quality_signal vs main` with `✓ No degradation detected` because no categorical axis crossed a threshold.

What actually moves the score (CI scan results, NOT local — they can disagree by ~5-10 points; CI is authoritative):

| Action | quality_signal Δ (CI) | god_files Δ | Architectural value |
|---|---|---|---|
| Lazy-import cross-layer deps | **0** | 0 | small (defers SDK init) |
| Extract sub-module to drop file fan-out | **+1** | **-1** | real (removes one god-file) |
| Bridge module to consolidate cross-layer edges | **+1** | 0 | real (one crossing point) |

**Sentrux v0.5.7's geometric mean penalises file-count overhead** roughly equal to (or slightly more than) per-axis modularity / coupling gains. Within-module file extraction nets out roughly neutral on `quality_signal` while genuinely improving structure. **Lazy imports do nothing for the score** — sentrux's parser walks function bodies via Python's full AST. Don't bother lazy-importing for sentrux purposes.

What DID matter for clearing the gate:
1. **Cyclomatic complexity threshold is CC ≥ 16** in v0.5.7. Functions at C(15) are fine; D(20+) trip it. Refactor by extracting helpers — easy mechanical wins.
2. **Lint must be clean**. `make lint` (ruff) is a hard gate. Auto-fix what `--fix` will fix; manually rename for `F811` duplicate definitions (which pytest may have been silently shadowing).
3. **God-files threshold is fan-out > 15**. Extract collaborators into sibling modules (e.g., `builder_agent.py` 19 → 9 by moving the middleware chain to `builder_middlewares.py`).

Local sentrux: `mcp__sentrux__rescan` then `mcp__sentrux__health`. CI is authoritative when local and CI scans disagree.

### Memory System (`packages/harness/deerflow/agents/memory/`)

**Components**:
- `updater.py` - LLM-based memory updates with fact extraction, whitespace-normalized fact deduplication (trims leading/trailing whitespace before comparing), atomic file I/O, and timezone-aware UTC timestamp serialization (`...Z`) for memory metadata.
- `queue.py` - Debounced update queue (per-thread deduplication, configurable wait time)
- `prompt.py` - Prompt templates for memory updates

**Data Structure** (stored in `backend/.deer-flow/memory.json`):
- **User Context**: `workContext`, `personalContext`, `topOfMind` (1-3 sentence summaries)
- **History**: `recentMonths`, `earlierContext`, `longTermBackground`
- **Facts**: Discrete facts with `id`, `content`, `category` (preference/knowledge/context/behavior/goal), `confidence` (0-1), `createdAt`, `source`

**Workflow**:
1. `MemoryMiddleware` filters messages (user inputs + final AI responses) and queues conversation
2. Queue debounces (30s default), batches updates, deduplicates per-thread
3. Background thread invokes LLM to extract context updates and facts
4. Applies updates atomically (temp file + rename) with cache invalidation, skipping duplicate fact content before append
5. Next interaction injects top 15 facts + context into `<memory>` tags in system prompt

Focused regression coverage for the updater lives in `backend/tests/test_memory_updater.py`.
Focused regression coverage for sandbox mirror hook wiring lives in `backend/tests/test_sandbox_tools.py`.

**Configuration** (`config.yaml` → `memory`):
- `enabled` / `injection_enabled` - Master switches
- `storage_path` - Path to memory.json
- `debounce_seconds` - Wait time before processing (default: 30)
- `model_name` - LLM for updates (null = default model)
- `max_facts` / `fact_confidence_threshold` - Fact storage limits (100 / 0.7)
- `max_injection_tokens` - Token limit for prompt injection (2000)

### Reflection System (`packages/harness/deerflow/reflection/`)

- `resolve_variable(path)` - Import module and return variable (e.g., `module.path:variable_name`)
- `resolve_class(path, base_class)` - Import and validate class against base class

### Config Schema

**`config.yaml`** key sections:
- `models[]` - LLM configs with `use` class path, `supports_thinking`, `supports_vision`, provider-specific fields
- `tools[]` - Tool configs with `use` variable path and `group`
- `tool_groups[]` - Logical groupings for tools
- `sandbox.use` - Sandbox provider class path
- `skills.path` / `skills.container_path` - Host and container paths to skills directory
- `title` - Auto-title generation (enabled, max_words, max_chars, prompt_template)
- `summarization` - Context summarization (enabled, trigger conditions, keep policy)
- `subagents.enabled` - Master switch for subagent delegation
- `memory` - Memory system (enabled, storage_path, debounce_seconds, model_name, max_facts, fact_confidence_threshold, injection_enabled, max_injection_tokens)

**`extensions_config.json`**:
- `mcpServers` - Map of server name → config (enabled, type, command, args, env, url, headers, oauth, description)
- `skills` - Map of skill name → state (enabled)

Both can be modified at runtime via Gateway API endpoints or `DeerFlowClient` methods.

### Embedded Client (`packages/harness/deerflow/client.py`)

`DeerFlowClient` provides direct in-process access to all DeerFlow capabilities without HTTP services. All return types align with the Gateway API response schemas, so consumer code works identically in HTTP and embedded modes.

**Architecture**: Imports the same `deerflow` modules that LangGraph Server and Gateway API use. Shares the same config files and data directories. No FastAPI dependency.

**Agent Conversation** (replaces LangGraph Server):
- `chat(message, thread_id)` — synchronous, returns final text
- `stream(message, thread_id)` — yields `StreamEvent` aligned with LangGraph SSE protocol:
  - `"values"` — full state snapshot (title, messages, artifacts)
  - `"messages-tuple"` — per-message update (AI text, tool calls, tool results)
  - `"end"` — stream finished
- Agent created lazily via `create_agent()` + `_build_middlewares()`, same as `make_lead_agent`
- Supports `checkpointer` parameter for state persistence across turns
- `reset_agent()` forces agent recreation (e.g. after memory or skill changes)

**Gateway Equivalent Methods** (replaces Gateway API):

| Category | Methods | Return format |
|----------|---------|---------------|
| Models | `list_models()`, `get_model(name)` | `{"models": [...]}`, `{name, display_name, ...}` |
| MCP | `get_mcp_config()`, `update_mcp_config(servers)` | `{"mcp_servers": {...}}` |
| Skills | `list_skills()`, `get_skill(name)`, `update_skill(name, enabled)`, `install_skill(path)` | `{"skills": [...]}` |
| Memory | `get_memory()`, `reload_memory()`, `get_memory_config()`, `get_memory_status()` | dict |
| Uploads | `upload_files(thread_id, files)`, `list_uploads(thread_id)`, `delete_upload(thread_id, filename)` | `{"success": true, "files": [...]}`, `{"files": [...], "count": N}` |
| Artifacts | `get_artifact(thread_id, path)` → `(bytes, mime_type)` | tuple |

**Key difference from Gateway**: Upload accepts local `Path` objects instead of HTTP `UploadFile`, rejects directory paths before copying, and reuses a single worker when document conversion must run inside an active event loop. Artifact returns `(bytes, mime_type)` instead of HTTP Response. `update_mcp_config()` and `update_skill()` automatically invalidate the cached agent.

**Tests**: `tests/test_client.py` (77 unit tests including `TestGatewayConformance`), `tests/test_client_live.py` (live integration tests, requires config.yaml)

**Gateway Conformance Tests** (`TestGatewayConformance`): Validate that every dict-returning client method conforms to the corresponding Gateway Pydantic response model. Each test parses the client output through the Gateway model — if Gateway adds a required field that the client doesn't provide, Pydantic raises `ValidationError` and CI catches the drift. Covers: `ModelsListResponse`, `ModelResponse`, `SkillsListResponse`, `SkillResponse`, `SkillInstallResponse`, `McpConfigResponse`, `UploadResponse`, `MemoryConfigResponse`, `MemoryStatusResponse`.

## Development Workflow

### Test-Driven Development (TDD) — MANDATORY

**Every new feature or bug fix MUST be accompanied by unit tests. No exceptions.**

- Write tests in `backend/tests/` following the existing naming convention `test_<feature>.py`
- Run the full suite before and after your change: `make test`
- Tests must pass before a feature is considered complete
- For lightweight config/utility modules, prefer pure unit tests with no external dependencies
- If a module causes circular import issues in tests, add a `sys.modules` mock in `tests/conftest.py` (see existing example for `deerflow.subagents.executor`)

```bash
# Run all tests
make test

# Run a specific test file
PYTHONPATH=. uv run pytest tests/test_<feature>.py -v
```

### Running the Full Application

From the **project root** directory:
```bash
make dev
```

This starts all services and makes the application available at `http://localhost:2026`.

**Nginx routing**:
- `/api/langgraph/*` → LangGraph Server (2024)
- `/api/*` (other) → Gateway API (8001)
- `/` (non-API) → Frontend (3000)

### Running Backend Services Separately

From the **backend** directory:

```bash
# Terminal 1: LangGraph server
make dev

# Terminal 2: Gateway API
make gateway
```

Direct access (without nginx):
- LangGraph: `http://localhost:2024`
- Gateway: `http://localhost:8001`

### Frontend Configuration

The frontend uses environment variables to connect to backend services:
- `NEXT_PUBLIC_LANGGRAPH_BASE_URL` - Defaults to `/api/langgraph` (through nginx)
- `NEXT_PUBLIC_BACKEND_BASE_URL` - Defaults to empty string (through nginx)

When using `make dev` from root, the frontend automatically connects through nginx.

## Key Features

### File Upload

Multi-file upload with automatic document conversion:
- Endpoint: `POST /api/threads/{thread_id}/uploads`
- Supports: PDF, PPT, Excel, Word documents (converted via `markitdown`)
- Rejects directory inputs before copying so uploads stay all-or-nothing
- Reuses one conversion worker per request when called from an active event loop
- Files stored in thread-isolated directories
- Agent receives uploaded file list via `UploadsMiddleware`

See [docs/FILE_UPLOAD.md](docs/FILE_UPLOAD.md) for details.

### Plan Mode

TodoList middleware for complex multi-step tasks:
- Controlled via runtime config: `config.configurable.is_plan_mode = True`
- Provides `write_todos` tool for task tracking
- One task in_progress at a time, real-time updates

See [docs/plan_mode_usage.md](docs/plan_mode_usage.md) for details.

### Context Summarization

Automatic conversation summarization when approaching token limits:
- Configured in `config.yaml` under `summarization` key
- Trigger types: tokens, messages, or fraction of max input
- Keeps recent messages while summarizing older ones

See [docs/summarization.md](docs/summarization.md) for details.

### Vision Support

For models with `supports_vision: true`:
- `ViewImageMiddleware` processes images in conversation
- `view_image_tool` added to agent's toolset
- Images automatically converted to base64 and injected into state

### Sophia Vision Port (PR #132)

The companion and builder both see images in-process. Same `viewed_images` channel as upstream, wrapped in narrow thread-scoped tools so the companion can't address other threads' filesystems.

**Capability gate** (`deerflow.agents.sophia_agent.vision_gate.supports_vision`):
- Default-on for `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`.
- Operators can override per-model via `app_config.models[*].supports_vision`.
- Vision tools, middlewares, and uploaded-image briefing ALL gate on this — vision-off runs never advertise a tool they can't call.

**Companion tools** ([packages/harness/deerflow/sophia/tools/](packages/harness/deerflow/sophia/tools)):
- `view_user_image(image_filename)` — Whitelists current thread's `uploads/` + `outputs/`. Bare filename, no paths. Rejects `.gif`. Hard cap at `MAX_VIEWABLE_IMAGE_BYTES = 10 MiB` raw (base64 expansion → Anthropic 32 MB envelope risk).
- `read_user_document(document_filename)` — text PDFs / DOCX / PPTX / XLSX / MD / TXT via `markitdown`. No size cap. Routing rule: vision tool for images only; documents always go through this path so the model doesn't hallucinate fine print.
- Both tools resolve `thread_id` from `runtime.context` and look in `backend/.deer-flow/threads/{thread_id}/user-data/{uploads,outputs}/`. Path resolution reuses `replace_virtual_path` from sandbox tools.

**`SophiaViewImageMiddleware`** ([agents/sophia_agent/middlewares/view_image.py](packages/harness/deerflow/agents/sophia_agent/middlewares/view_image.py)):
- Subclasses upstream `ViewImageMiddleware`.
- Recognizes BOTH `view_image` (builder uses upstream tool directly) and `view_user_image` (companion uses the narrow wrapper).
- Overrides `_should_inject_image_message` to skip when `state["viewed_images"]` is empty. Pairs with the tool's clear-on-failure: every failure path in `view_user_image` returns `{"viewed_images": {}}` (the `merge_viewed_images` reducer's "clear all" sentinel) so a previously-loaded image from this session doesn't get re-injected after a failed lookup. Without the middleware skip, upstream's `_create_image_details_message` would synthesize a misleading "No images have been viewed." HumanMessage into the cleared state.

**Builder uploads briefing** (`BuilderTaskMiddleware`):
- Surfaces images attached to the dispatching companion turn at `/mnt/user-data/uploads/{name}` inside a `<uploaded_images>` block.
- Two rendering branches: vision-on tells the model to call `view_image(image_path=...)`; vision-off acknowledges the upload but instructs the model NOT to call view_image. Branch selection is `BuilderTaskMiddleware(vision_enabled=...)`, plumbed through `build_builder_middleware_chain(user_id, vision_enabled=...)`.

**Cross-thread image copy** ([sophia/tools/start_builder_task.py](packages/harness/deerflow/sophia/tools/start_builder_task.py)):
- Each LangGraph thread has its own sandbox via `ThreadDataMiddleware`. The builder cannot read the companion's filesystem directly, so `_copy_parent_uploaded_images` copies eligible images into the builder's fresh sandbox at dispatch time.
- **Scoped to current-turn attachments only** (Codex P1 PR #132 latest iteration). `_extract_current_turn_attachment_filenames(messages)` parses the synthesized `[The user has uploaded N file(s) ...]` block from the latest HumanMessage (format produced by `frontend/src/app/stores/attachment-prompt.ts::buildAttachmentPrompt`). Only filenames in that block are copied. Previously the loop enumerated EVERY image in the parent uploads dir, so an unrelated later builder request would re-expose private images from earlier turns. Defense-in-depth: bullets outside the bracketed block are ignored; names are re-filtered through `[A-Za-z0-9._-]+`.
- Other safety filters (extension allow-list, hidden-file skip, oversize log+skip, prompt-injection allow-list) all stay.

**Frontend integration** (Codex P1/P2 iteration on PR #132):
- `POST /api/threads/{thread_id}/uploads` — multipart proxy with `userOwnsThread` gate (two-pass `/api/v1/sessions/open` → `/list?limit=100` fallback).
- `GET /api/threads/{thread_id}/uploads/list` — list proxy used by the frontend AttachmentBar to seed its uniquifier against on-disk state (so a re-pick of `image.png` after chips were cleared by `useSessionOutboundSend` doesn't silently overwrite the earlier upload).
- `DELETE /api/threads/{thread_id}/uploads/{filename}` — DELETE proxy so chip × actually clears bytes.
- `/api/chat` post-handler runs the same `userOwnsThread` gate on ANY existing-thread send (not just attachment-bearing ones — a foreign thread_id with no attachments can still trigger `view_user_image` via prompt injection). Mock-mode (`USE_MOCK_STREAMING=true`) short-circuits BEFORE the ownership gate so offline-dev sessions don't fail closed.

#### Production hardening wave (PR #132, post-initial-port — verified live on sophia-ei.com)

The initial port worked locally but broke in the split Render deployment (gateway and langgraph are **separate web services with separate ephemeral disks** — `render.yaml` declares no shared/persistent disk). The fixes below make uploads survive that topology. Most were Codex-review-driven; the diagnosis that found them used Render + Vercel logs + driving production in Chrome DevTools.

- **Cross-service Supabase bridge — the core fix.** The gateway writes uploads to *its* disk; the companion's read tools run in the *langgraph* container and read *its* disk → the file is invisible. Fix: the gateway upload route mirrors every saved file (and its converted `<stem>.md`) to Supabase Storage; the read tools download from the mirror on a local miss.
  - Mirror helpers live in `app/gateway/routers/uploads.py` (`_mirror_upload_to_supabase`, `_delete_supabase_mirror`, `_list_supabase_upload_filenames`) and delegate to `deerflow.sophia.storage.supabase_artifact_store`.
  - Read-tool fallback: `read_user_document._materialize_from_supabase`, `view_user_image._materialize_image_from_supabase`, and `start_builder_task._materialize_current_turn_images_from_supabase` (the builder copy fetches whitelisted current-turn **images** from the mirror before the local `is_dir()` check, so an immediate "build a deck from this image" works even before the companion materialized it locally).
  - All best-effort: any Supabase miss/failure degrades to the existing "not found" / local-only behavior; nothing fails the turn. Local/dev with no Supabase keeps working unchanged.
- **Separate Supabase keyspace for uploads.** Uploads mirror under `{thread_id}/uploads/{name}`; builder OUTPUTS mirror under `{thread_id}/{name}` (`supabase_mirror.py`). `supabase_artifact_store.uploads_object_name()` is the SINGLE source of truth for the `uploads/` prefix, used by all five upload sites (mirror upload + delete + the three read-tool downloads). Without the split, a user `report.pdf` and a builder `report.pdf` would overwrite each other (`x-upsert`).
- **Idempotent DELETE.** `delete_uploaded_file` runs the path-traversal check first, then does NOT 404 on a local miss — it best-effort-unlinks locally AND always removes the Supabase mirror (original + `.md` sibling). On the ephemeral disk the local file may be gone while the mirror is live; a discarded file must not re-materialize. `supabase_artifact_store.delete_artifact` is 404-idempotent.
- **`/uploads/list` unions local + mirror.** The endpoint no longer early-returns when the local dir is absent; it unions the local listing with `list_upload_filenames(thread_id)` (deduped by filename, local wins, mirror-only entries tagged `source: "supabase-mirror"`). The frontend AttachmentBar seeds its uniquifier from this list, so after a restart the mirrored names still reserve against re-attach-overwrite.
- **Gateway upload routes enforce auth unconditionally.** The gateway is independently reachable, so the routes can't rely on the Next.js proxy's ownership check. `uploads.py::verify_thread_access` (router-level `Depends`) resolves the bearer token via `auth.resolve_bearer_user_id` (async, path-param-free; honors `SOPHIA_AUTH_BYPASS` for local/tests) and 403s unless the user owns the thread (checked against `SessionStore.list_open` + `list_recent`). Enforcement is **unconditional** — an earlier flag-gated version (`SOPHIA_GATEWAY_AUTH_ENABLED`) was rejected because `render.yaml` never set the flag, leaving the routes open.
- **Base64 accumulation guards.** `ClearOnInjectViewImageMiddleware` clears `viewed_images` after injection AND prunes prior injected image messages from the persistent `messages` channel: each injected image `HumanMessage` is stamped with `additional_kwargs["sophia_injected_image"]` + a stable id; a new injection emits `RemoveMessage(id=...)` for prior ones. Without the prune, multiple ~10 MiB views accumulate in history and blow Anthropic's 32 MB request envelope despite the state-channel clear.

#### Frontend AttachmentBar robustness (PR #132, prod silent-attach wave)

- **Live `FileList` snapshot.** `handleFileSelection` copies `event.target.files` into an array BEFORE resetting `input.value`. In Chrome `input.value = ""` empties the live `FileList`, so reading `.length` after the reset saw 0 and the handler silently bailed (no chip, no upload, no error) — the production silent-attach root cause. Unit mocks didn't catch it (a mocked FileList isn't emptied by a value reset; `dispatchLiveFilesOnto` in the test now emulates the live semantics).
- **Convertible `.md`-sibling reservation.** The pre-pass reserves `deriveMarkdownSibling()` for original picks; the registration loop ALSO reserves the derived `.md` of any **renamed** convertible (`report.pdf` → `report-1.pdf` must reserve `report-1.md`); the post-hoc server-truth rename uses `uniquifyFilenameAvoidingMdSibling` so a convertible's conversion output can't clobber a literal `.md` already on the server.
- **Discard-before-upload race.** `uploadOneFile` checks `readChipStatus()` at the top and bails (drops the chip, no POST) when the user clicked × (status `deleting`) before the upload loop reached it — otherwise a discarded file lands on disk and the post-success cleanup DELETE might never run.

**Regression command**:

```bash
PYTHONPATH=. uv run pytest \
  tests/test_sophia_vision_dispatch.py \
  tests/test_sophia_vision_tools.py \
  tests/test_sophia_view_image_middleware.py \
  tests/test_uploads_router.py \
  tests/test_uploads_supabase_mirror.py \
  tests/test_uploads_auth.py -v
```

**Deploy requirement:** the cross-service bridge means BOTH `sophia-gateway` AND `sophia-langgraph` must redeploy together — the gateway needs the mirror/delete/list code, langgraph needs the download-fallback + builder-materialize code. The Supabase bucket (`SUPABASE_BUILDER_BUCKET`, local default `sophia-builder-artifacts`) must exist and must be set explicitly in production; both services need `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.

## Code Style

- Uses `ruff` for linting and formatting
- Line length: 240 characters
- Python 3.12+ with type hints
- Double quotes, space indentation
- Keep imports used and remove unused imports (`ruff` F401)

## Documentation

See `docs/` directory for detailed documentation:
- [CONFIGURATION.md](docs/CONFIGURATION.md) - Configuration options
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - Architecture details
- [API.md](docs/API.md) - API reference
- [SETUP.md](docs/SETUP.md) - Setup guide
- [FILE_UPLOAD.md](docs/FILE_UPLOAD.md) - File upload feature
- [PATH_EXAMPLES.md](docs/PATH_EXAMPLES.md) - Path types and usage
- [summarization.md](docs/summarization.md) - Context summarization
- [plan_mode_usage.md](docs/plan_mode_usage.md) - Plan mode with TodoList
