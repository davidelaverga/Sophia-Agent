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
- **Visual deliverables (.pptx, generated images, infographics)**: `OPENAI_API_KEY` is required. The `image-generation` skill calls OpenAI's `gpt-image-2`, and `ppt-generation` orchestrates that skill. Without the key set, the script exits 2 immediately so the builder doesn't loop — see [skills/public/image-generation/scripts/generate.py](../skills/public/image-generation/scripts/generate.py).
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

### Builder progress streaming (webhook relay — Phase 4H+)

The live `[ Researching ]` → `[ Drafting ]` → `[ Finalizing ]` → `[ Done ]` placeholder UX is delivered via an HTTP webhook relay (NOT SDK streaming). The full architecture and rationale are documented in [CLAUDE.md (root)](../CLAUDE.md) under "Builder progress streaming". Key gateway-side primitives:

- **`app/gateway/builder_progress/registry.py::BuilderProgressRegistry`** — per-process singleton, channel-agnostic. Maps `task_id` → `(chat_id, message_id, channel_name, run_id, ProgressRenderer)`. Per-entry `asyncio.Lock` serializes renderer mutation + callback await so concurrent webhooks for the same task_id can't interleave at the renderer-state boundary. Identity-guarded unregister (`expected_entry=entry`) protects against the `update_async_task` replacement-run race. Bounded terminal-edit retry (3 attempts, 2/5/15s backoff) protects against transient Telegram 5xx — completion webhooks are LRU-deduped server-side so a single failed edit without retry would permanently strand the placeholder.
- **`app/channels/telegram_progress_renderer.py::ProgressRenderer`** — event → plain-text body. `_TOOL_LABELS` maps tool name → `(emoji, verb)`; `_HIDDEN_TOOLS = {"ls", "read_file", "str_replace", "todo_read", "todo_write", "bash"}` suppresses noisy tools from the activity stream (bash hidden because verification/inline-Python ops clutter the placeholder — trade-off accepted: binary-deliverable generator scripts also show no live signal during the ~30-60s run; the artifact still arrives via the terminal webhook). `mark_done` clears accumulated `activity_lines` so the final body is `[ Done ]` + optional summary. `mark_stalled` (per-event timeout) and `mark_stopped` (error / cancel) PRESERVE activity history — in those degraded states the history is the user's last honest signal.
- **`app/gateway/routers/builder_events.py`** — three internal POST endpoints + two webapp SSE GET endpoints:
  - `POST /internal/builder-events` — terminal completion from langgraph (fire-and-forget channel fan-out via `asyncio.create_task` so the daemon-thread timeout doesn't trip).
  - `POST /internal/builder-progress` — live progress events from `BuilderProgressMiddleware`.
  - `GET /api/threads/{thread_id}/builder-events` — webapp SSE for terminal events.
  - `GET /api/threads/{thread_id}/builder-events/last` — late-mount recovery (returns the most recent terminal event if still in the TTL window).
- **`packages/harness/deerflow/agents/sophia_agent/middlewares/builder_progress.py::BuilderProgressMiddleware`** — async lifecycle hooks (`abefore_agent` / `aafter_model` / `aafter_agent`) emit fire-and-forget HTTP POSTs to `/internal/builder-progress`. Tool-name classification uses lowercase substring match (e.g., `search`/`fetch`/`browse`/`scrape` → `researching`). `_trim_tool_args` strips heavy fields like `write_file.content` from the payload (preserves only `query`/`url`/`path`/`command` per tool — the renderer only reads those). Strong-ref `_POST_TASKS` set with discard-on-done prevents GC of in-flight POSTs (v3-migration learning #4).

**Webapp integration path (not yet built)**:

The registry is channel-agnostic. To wire the webapp into the same streaming primitives:

1. **Build an SSE bridge** at `GET /api/threads/{thread_id}/builder-progress` (mirror the terminal-events SSE). On webhook arrival, the registry's edit callback for the webapp channel publishes per-thread to an SSE worker; clients connected to the endpoint receive each body.
2. **Register the webapp callback** at gateway startup: `registry.register_channel_callback("webapp", _emit_sse_event)` where `_emit_sse_event(chat_id, message_id, body) -> bool` returns `True` after publishing (Phase 4M codex P1 explicit-True contract; `None`/`False` = no-op).
3. **Register placeholder slots** when the webapp shows a placeholder: `registry.register_task(task_id=..., chat_id=..., message_id=..., channel_name="webapp", run_id=...)`. `chat_id` and `message_id` can be webapp-internal handles (any stable identifier for the placeholder DOM node / store entry).
4. **Terminal finalization is free** — the existing `_on_builder_completion` on the message bus calls `registry.mark_done(task_id, run_id)` / `mark_stopped(task_id, reason, run_id)` for ALL registered channels. The webapp's callback receives the final `[ Done ]` body alongside Telegram.

The langgraph-side middleware doesn't change — events fire for every task regardless of who's subscribed.

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
