# DeerFlow Backend

DeerFlow is a LangGraph-based AI super agent with sandbox execution, persistent memory, and extensible tool integration. The backend enables AI agents to execute code, browse the web, manage files, delegate tasks to subagents, and retain context across conversations - all in isolated, per-thread environments.

---

## Architecture

```
                        ┌──────────────────────────────────────┐
                        │          Nginx (Port 2026)           │
                        │      Unified reverse proxy           │
                        └───────┬──────────────────┬───────────┘
                                │                  │
              /api/langgraph/*  │                  │  /api/* (other)
                                ▼                  ▼
               ┌────────────────────┐  ┌────────────────────────┐
               │ LangGraph Server   │  │   Gateway API (8001)   │
               │    (Port 2024)     │  │   FastAPI REST         │
               │                    │  │                        │
               │ ┌────────────────┐ │  │ Models, MCP, Skills,   │
               │ │  Lead Agent    │ │  │ Memory, Uploads,       │
               │ │  ┌──────────┐  │ │  │ Artifacts              │
               │ │  │Middleware│  │ │  └────────────────────────┘
               │ │  │  Chain   │  │ │
               │ │  └──────────┘  │ │
               │ │  ┌──────────┐  │ │
               │ │  │  Tools   │  │ │
               │ │  └──────────┘  │ │
               │ │  ┌──────────┐  │ │
               │ │  │Subagents │  │ │
               │ │  └──────────┘  │ │
               │ └────────────────┘ │
               └────────────────────┘
```

**Request Routing** (via Nginx):
- `/api/langgraph/*` → LangGraph Server - agent interactions, threads, streaming
- `/api/*` (other) → Gateway API - models, MCP, skills, memory, artifacts, uploads
- `/` (non-API) → Frontend - Next.js web interface

---

## Core Components

### Lead Agent

The single LangGraph agent (`lead_agent`) is the runtime entry point, created via `make_lead_agent(config)`. It combines:

- **Dynamic model selection** with thinking and vision support
- **Middleware chain** for cross-cutting concerns (9 middlewares)
- **Tool system** with sandbox, MCP, community, and built-in tools
- **Subagent delegation** for parallel task execution
- **System prompt** with skills injection, memory context, and working directory guidance
### Sophia Companion + Builder

The Sophia graphs (`sophia_companion`, `sophia_builder`) now use a stateful builder handoff flow:

- `switch_to_builder` queues builder work asynchronously and returns a structured `builder_handoff` payload immediately (no blocking polling loop)
- `switch_to_builder` now resolves builder `user_id` from runtime configurable/context first and prefers the latest non-empty in-turn `emit_artifact` tool payload over stale persisted artifacts when building delegation context (empty payloads fall back to state artifacts)
- `switch_to_builder` also emits handoff resolution diagnostics (`user_id_source`, `artifact_source`, and source-presence flags) in both logs and handoff payloads for faster production triage
- `BuilderSessionMiddleware` consumes the handoff payload, tracks task status from background execution, writes `builder_task` / `builder_result` into companion state, and logs adopted handoffs plus timeout debug fields (`task_id`, `last_tool_calls`, `late_tool_calls_after_timeout`)
- Builder execution now tracks non-artifact tool turns and escalates endgame instructions so the builder explicitly finalizes with `emit_builder_artifact`
- Background subagent timeout handling preserves terminal safety while capturing late-turn diagnostics (`last` and `late` tool-call summaries) for debugging
- Companion synthesis remains in `ArtifactMiddleware` and runs when `builder_task.status == "completed"`
- Companion chain now includes config-driven `SummarizationMiddleware` wiring
- Builder chain now includes `SandboxMiddleware` and `TodoMiddleware` for execution parity

Regression command for this flow:

```bash
PYTHONPATH=. uv run pytest tests/test_sophia_builder_flow.py -v
```

### Middleware Chain

Middlewares execute in strict order, each handling a specific concern:

| # | Middleware | Purpose |
|---|-----------|---------|
| 1 | **ThreadDataMiddleware** | Creates per-thread isolated directories (workspace, uploads, outputs) |
| 2 | **UploadsMiddleware** | Injects newly uploaded files into conversation context |
| 3 | **SandboxMiddleware** | Acquires sandbox environment for code execution |
| 4 | **SummarizationMiddleware** | Reduces context when approaching token limits (optional) |
| 5 | **TodoListMiddleware** | Tracks multi-step tasks in plan mode (optional) |
| 6 | **TitleMiddleware** | Auto-generates conversation titles after first exchange |
| 7 | **MemoryMiddleware** | Queues conversations for async memory extraction |
| 8 | **ViewImageMiddleware** | Injects image data for vision-capable models (conditional) |
| 9 | **ClarificationMiddleware** | Intercepts clarification requests and interrupts execution (must be last) |

### Sandbox System

Per-thread isolated execution with virtual path translation:

- **Abstract interface**: `execute_command`, `read_file`, `write_file`, `list_dir`
- **Providers**: `LocalSandboxProvider` (filesystem) and `AioSandboxProvider` (Docker, in community/)
- **Virtual paths**: `/mnt/user-data/{workspace,uploads,outputs}` → thread-specific physical directories
- **Skills path**: `/mnt/skills` → `deer-flow/skills/` directory
- **Skills loading**: Recursively discovers nested `SKILL.md` files under `skills/{public,custom}` and preserves nested container paths
- **Tools**: `bash`, `ls`, `read_file`, `write_file`, `str_replace`

### Subagent System

Async task delegation with concurrent execution:

- **Built-in agents**: `general-purpose` (full toolset) and `bash` (command specialist)
- **Concurrency**: Max 3 subagents per turn, 15-minute timeout
- **Execution**: Background thread pools with status tracking and SSE events
- **Retention**: Terminal task states remain queryable for 15 minutes after cleanup so channel pollers and gateway status routes can still resolve final outcomes
- **Flow**: Agent calls `task()` tool → executor runs subagent in background → polls for completion → returns result

### Memory System

LLM-powered persistent context retention across conversations:

- **Automatic extraction**: Analyzes conversations for user context, facts, and preferences
- **Structured storage**: User context (work, personal, top-of-mind), history, and confidence-scored facts
- **Debounced updates**: Batches updates to minimize LLM calls (configurable wait time)
- **System prompt injection**: Top facts + context injected into agent prompts
- **Storage**: JSON file with mtime-based cache invalidation

### Tool Ecosystem

| Category | Tools |
|----------|-------|
| **Sandbox** | `bash`, `ls`, `read_file`, `write_file`, `str_replace` |
| **Built-in** | `present_files`, `ask_clarification`, `view_image`, `task` (subagent) |
| **Community** | Tavily (web search), Jina AI (web fetch), Firecrawl (scraping), DuckDuckGo (image search) |
| **MCP** | Any Model Context Protocol server (stdio, SSE, HTTP transports) |
| **Skills** | Domain-specific workflows injected via system prompt |

### Gateway API

FastAPI application providing REST endpoints for frontend integration:

| Route | Purpose |
|-------|---------|
| `GET /api/models` | List available LLM models |
| `GET/PUT /api/mcp/config` | Manage MCP server configurations |
| `GET/PUT /api/skills` | List and manage skills |
| `POST /api/skills/install` | Install skill from `.skill` archive |
| `GET /api/memory` | Retrieve memory data |
| `POST /api/memory/reload` | Force memory reload |
| `GET /api/memory/config` | Memory configuration |
| `GET /api/memory/status` | Combined config + data |
| `POST /api/threads/{id}/uploads` | Upload files (auto-converts PDF/PPT/Excel/Word to Markdown, rejects directory paths) |
| `GET /api/threads/{id}/uploads/list` | List uploaded files |
| `GET /api/threads/{id}/artifacts/{path}` | Serve generated artifacts |
| `POST /api/v1/sessions/{session_id}/touch` | Compatibility activity ping for external session pollers; missing `thread_id` defaults to `session_id` |
| `POST /api/sophia/{user_id}/telegram/link` | Create one-time Telegram deep-link token for Sophia account linking |
| `GET /api/sophia/{user_id}/telegram/link` | Get Telegram link status for a Sophia user |
| `DELETE /api/sophia/{user_id}/telegram/link` | Unlink Telegram from a Sophia user |
| `GET /api/sophia/{user_id}/tasks/{task_id}` | Inspect active or recently completed builder task state, including derived artifact metadata |

### IM Channels
The IM bridge supports Feishu, Slack, and Telegram. Slack and Telegram use the final `runs.wait()` response path, while Feishu streams through `runs.stream(["messages-tuple", "values"])` and updates a single in-thread card in place.

Telegram now supports Sophia account linking and media-first workflows:
- Web app creates one-time `/api/sophia/{user_id}/telegram/link` tokens, redeemed in Telegram with `/start <token>` (private chat).
- Re-linking a Telegram chat to a different Sophia user clears the previous user reverse mapping to keep status/unlink behavior consistent.
- Unlinked chats are gated; linked chats can send normal text, `/build <task>`, and photo/document inputs.
- Telegram media is downloaded by the channel and persisted into thread uploads, but supported attachments are sent to Sophia inline so runs do not depend on gateway-local upload paths being visible to LangGraph.
- Supported Telegram photos become native Anthropic `image` blocks; PDFs, converted office docs, and text-like files become native `document` blocks with truncation or fallback notes when needed.

`ChannelManager` now also:
- Enforces one active run per conversation key (`channel:chat:topic`) and sends a busy message for overlapping requests.
- Polls queued builder handoff tasks and publishes asynchronous completion/failure follow-up messages (including artifact attachments when available).
- Relies on retained terminal subagent results plus `GET /api/sophia/{user_id}/tasks/{task_id}` so async pollers can still resolve builder outcomes after executor cleanup.
- Self-heals stale LangGraph thread mappings: on a `404 {"detail": "Thread or assistant not found."}` from `runs.wait`/`runs.stream`, the manager clears the stored `channel:chat` mapping, creates a fresh LangGraph thread, and retries the run once. This keeps Telegram/Slack chats alive across LangGraph redeploys that use the in-memory runtime. When the inbound message carries file attachments, the manager also re-runs `_read_and_store_inbound_files` under the healed thread and rebuilds `human_message_payload` before the retry so virtual paths resolve against the new thread's uploads dir rather than the stale one; both `_handle_chat` and `_handle_streaming_chat` take this path.
- Registers optional per-channel inbound file readers (used by Telegram) through `ChannelService`.
- Releases temporary sandbox acquisitions made for inbound file syncing after each ingestion run.
- Materializes Sophia's transient top-level `builder_delivery` payload into the gateway service's own outputs directory before outbound upload, so synchronous builder completions and later resend requests can deliver files back to Telegram even when LangGraph and Gateway are on separate Render disks.
- Accepts external activity pings through `POST /api/v1/sessions/{session_id}/touch`, defaulting a missing `thread_id` to `session_id` for legacy voice/getaway callers.

Sophia's custom companion/builder agents also inherit DeerFlow-native `web_search` and `web_fetch` tools from config, so Render needs those tool definitions plus `TAVILY_API_KEY` / `JINA_API_KEY` on the services that load `config.production.yaml`.
The companion-side resend path for prior builder artifacts now uses an explicit empty input schema so Anthropic/OpenAI tool binding can succeed even though the tool only depends on injected runtime state.
Builder runs now default to `claude-sonnet-4-6` unless `SOPHIA_BUILDER_MODEL` is set, and the handoff path can synthesize a builder artifact from `present_files` output when files exist but `emit_builder_artifact` was never called.

Builder safeguards (PR G):
- `switch_to_builder` uses per-task-type timeouts (`document=600`, `presentation=900`, `research=900`, `visual_report=900`, `frontend=720`, default `600s`) and a module-level cancel event per task, so timed-out subagents stop between streaming chunks instead of lingering on further Anthropic calls. The builder's `ChatAnthropic` also pins a `default_request_timeout=180.0`.
- The companion passes `retry_attempt` (0–2) and `resume_from_task_id` alongside `task`/`task_type`. Builder results carry a `status` field (`completed | partial | failed_retryable | failed_terminal`), and `ToolMessage` phrasing adapts: retry prompt on the first failure, alternatives on the second, pause-and-ask on a partial.
- A hard turn cap in `BuilderArtifactMiddleware` (40 tool-bearing turns) pauses runaway builds with a canonical `partial` result (`continuation_task_id`, `completed_files`, `summary_of_done`). The builder's `recursion_limit` is set to 120 super-steps so the cap is actually reachable (each tool turn costs ~2 super-steps). The `continuation_task_id` is the original subagent `task_id`, so the companion's follow-up `switch_to_builder(resume_from_task_id=<continuation_task_id>)` resolves cleanly against the retained task store within its 15-minute window, and `BuilderTaskMiddleware` injects a `<resume_from>` briefing listing the already-completed files.
- `skills/public/sophia/AGENTS.md` ships as a shared companion↔builder building contract (roles, data contract, status taxonomy, crash posture) and is injected into both agents via `FileInjectionMiddleware`.
- `BuilderTaskMiddleware` loads task-type-specific skill files (chart-visualization, data-analysis, deep-research, frontend-design) into the builder prompt, and the builder's toolset now includes `view_image_tool` for visual iteration.
- `backend/scripts/sandbox_capability_check.py` is a standalone post-deploy diagnostic that prints the availability of pandoc / weasyprint / reportlab / matplotlib / pillow and exits non-zero when required capabilities are missing.
Both the Sophia companion and builder chains run `DanglingToolCallMiddleware`, which injects a synthetic `ToolMessage` for any `tool_use` id that lacks a matching `tool_result`. This keeps `web_search`, `switch_to_builder`, and other tool-heavy turns alive after transient tool failures, interrupted subagent runs, or mid-turn cancellations, where Anthropic would otherwise reject the next call with a `400 tool_use ids were found without tool_result blocks` error.

The `langchain` dependency is pinned to `>=1.2.15`. Earlier releases (through 1.2.3) contained a LangChain bug where the `_fetch_last_ai_and_tool_messages` helper raised `UnboundLocalError: cannot access local variable 'last_ai_index'` whenever the `tools_to_model` routing edge saw a state slice with no `AIMessage` (e.g. during Sophia's parallel `web_search` tool fan-out). LangChain 1.2.15 returns `(None, [])` in that case and the routing edges exit cleanly. The bump also pulls `langchain-core` to `>=1.3.0` and `langgraph` to `>=1.1.8` as transitive requirements.

Sophia tools that emit a `Command(update={...})` resolve their tool call id through `deerflow.sophia.tools._tool_call_id.resolve_tool_call_id`, which prefers `runtime.tool_call_id` (always present on LangChain `ToolRuntime`) over the `Annotated[str, InjectedToolCallId]` parameter. This guarantees every returned `ToolMessage` is paired with the originating `tool_use` id, even when an explicit empty `args_schema` (used by `share_builder_artifact` for Anthropic JSON-schema compatibility) silently leaves the injected parameter as an empty string. `share_builder_artifact` is also documented as a re-share-only tool: the model is instructed never to invoke it in the same turn as `switch_to_builder`, since `switch_to_builder` already attaches the builder deliverable through `state["builder_delivery"]`.
For Feishu card updates, DeerFlow stores the running card's `message_id` per inbound message and patches that same card until the run finishes, preserving the existing `OK` / `DONE` reaction flow.

---

## Quick Start

### Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) package manager
- API keys for your chosen LLM provider

### Installation

```bash
cd deer-flow

# Copy configuration files
cp config.example.yaml config.yaml

# Install backend dependencies
cd backend
make install
```

### Configuration

Edit `config.yaml` in the project root:

```yaml
models:
  - name: gpt-4o
    display_name: GPT-4o
    use: langchain_openai:ChatOpenAI
    model: gpt-4o
    api_key: $OPENAI_API_KEY
    supports_thinking: false
    supports_vision: true
```

Set your API keys:

```bash
export OPENAI_API_KEY="your-api-key-here"
```

### Running

**Full Application** (from project root):

```bash
make dev  # Starts LangGraph + Gateway + Frontend + Nginx
```

Access at: http://localhost:2026

**Backend Only** (from backend directory):

```bash
# Terminal 1: LangGraph server
make dev

# Terminal 2: Gateway API
make gateway
```

Direct access: LangGraph at http://localhost:2024, Gateway at http://localhost:8001

---

## Project Structure

```
backend/
├── src/
│   ├── agents/                  # Agent system
│   │   ├── lead_agent/         # Main agent (factory, prompts)
│   │   ├── middlewares/        # 9 middleware components
│   │   ├── memory/             # Memory extraction & storage
│   │   └── thread_state.py    # ThreadState schema
│   ├── gateway/                # FastAPI Gateway API
│   │   ├── app.py             # Application setup
│   │   └── routers/           # 6 route modules
│   ├── sandbox/                # Sandbox execution
│   │   ├── local/             # Local filesystem provider
│   │   ├── sandbox.py         # Abstract interface
│   │   ├── tools.py           # bash, ls, read/write/str_replace
│   │   └── middleware.py      # Sandbox lifecycle
│   ├── subagents/              # Subagent delegation
│   │   ├── builtins/          # general-purpose, bash agents
│   │   ├── executor.py        # Background execution engine
│   │   └── registry.py        # Agent registry
│   ├── tools/builtins/         # Built-in tools
│   ├── mcp/                    # MCP protocol integration
│   ├── models/                 # Model factory
│   ├── skills/                 # Skill discovery & loading
│   ├── config/                 # Configuration system
│   ├── community/              # Community tools & providers
│   ├── reflection/             # Dynamic module loading
│   └── utils/                  # Utilities
├── docs/                       # Documentation
├── tests/                      # Test suite
├── langgraph.json              # LangGraph server configuration
├── pyproject.toml              # Python dependencies
├── Makefile                    # Development commands
└── Dockerfile                  # Container build
```

---

## Configuration

### Main Configuration (`config.yaml`)

Place in project root. Config values starting with `$` resolve as environment variables.

Key sections:
- `models` - LLM configurations with class paths, API keys, thinking/vision flags
- `tools` - Tool definitions with module paths and groups
- `tool_groups` - Logical tool groupings
- `sandbox` - Execution environment provider
- `skills` - Skills directory paths
- `title` - Auto-title generation settings
- `summarization` - Context summarization settings
- `subagents` - Subagent system (enabled/disabled)
- `memory` - Memory system settings (enabled, storage, debounce, facts limits)

Provider note:
- `models[*].use` references provider classes by module path (for example `langchain_openai:ChatOpenAI`).
- If a provider module is missing, DeerFlow now returns an actionable error with install guidance (for example `uv add langchain-google-genai`).

### Extensions Configuration (`extensions_config.json`)

MCP servers and skill states in a single file:

```json
{
  "mcpServers": {
    "github": {
      "enabled": true,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_TOKEN": "$GITHUB_TOKEN"}
    },
    "secure-http": {
      "enabled": true,
      "type": "http",
      "url": "https://api.example.com/mcp",
      "oauth": {
        "enabled": true,
        "token_url": "https://auth.example.com/oauth/token",
        "grant_type": "client_credentials",
        "client_id": "$MCP_OAUTH_CLIENT_ID",
        "client_secret": "$MCP_OAUTH_CLIENT_SECRET"
      }
    }
  },
  "skills": {
    "pdf-processing": {"enabled": true}
  }
}
```

### Environment Variables

- `DEER_FLOW_CONFIG_PATH` - Override config.yaml location
- `DEER_FLOW_EXTENSIONS_CONFIG_PATH` - Override extensions_config.json location
- Model API keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, etc.
- Tool API keys: `TAVILY_API_KEY`, `GITHUB_TOKEN`, etc.

---

## Development

### Commands

```bash
make install    # Install dependencies
make dev        # Run LangGraph server (port 2024)
make gateway    # Run Gateway API (port 8001)
make lint       # Run linter (ruff)
make format     # Format code (ruff)
```

### Code Style

- **Linter/Formatter**: `ruff`
- **Line length**: 240 characters
- **Python**: 3.12+ with type hints
- **Quotes**: Double quotes
- **Indentation**: 4 spaces
- **Import hygiene**: keep imports used and remove unused imports (`ruff` F401)

### Testing

```bash
uv run pytest
```

---

## Technology Stack

- **LangGraph** (1.0.6+) - Agent framework and multi-agent orchestration
- **LangChain** (1.2.3+) - LLM abstractions and tool system
- **FastAPI** (0.115.0+) - Gateway REST API
- **langchain-mcp-adapters** - Model Context Protocol support
- **agent-sandbox** - Sandboxed code execution
- **markitdown** - Multi-format document conversion
- **tavily-python** / **firecrawl-py** - Web search and scraping

---

## Documentation

- [Configuration Guide](docs/CONFIGURATION.md)
- [Architecture Details](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [File Upload](docs/FILE_UPLOAD.md)
- [Path Examples](docs/PATH_EXAMPLES.md)
- [Context Summarization](docs/summarization.md)
- [Plan Mode](docs/plan_mode_usage.md)
- [Setup Guide](docs/SETUP.md)

---

## License

See the [LICENSE](../LICENSE) file in the project root.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.
