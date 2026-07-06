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

The Sophia graphs (`sophia_companion`, `sophia_builder`) use the deepagents v0.5 async-subagent pattern:

- `start_builder_task` is the canonical companion-side dispatch tool. It launches the builder via deepagents `AsyncSubAgentMiddleware` (LangGraph SDK ASGI in-process transport) and returns a `task_id` immediately, written to `state["async_tasks"]`
- `start_builder_task` enriches the builder's brief with relevant memories from the session, current emotional context (tone + active_goal), active ritual / phase, and explicit user-supplied URLs; the wrapper also seeds `delegation_context`, `allow_web_research`, `explicit_user_urls`, and `builder_web_budget` on the builder's input
- The wrapper resolves builder `user_id` with strict priority: runtime configurable/context → state → `make_start_builder_task_tool(user_id)` closure → LLM-supplied tool arg (warning) → `default_user` (warning). The LLM tool arg never overrides a trusted source; mismatches are logged for prompt-injection audit
- Duplicate-launch protection uses a terminal-status blacklist so unknown / future LangGraph statuses (`pending`, `interrupted`, …) correctly block new launches conservatively
- Empty `tool_call_id` causes the wrapper to refuse to launch (prevents orphaned LangGraph runs that the lifecycle tools couldn't manage)
- Lifecycle (`check_async_task`, `update_async_task`, `cancel_async_task`, `list_async_tasks`) is owned by the native deepagents middleware; `start_async_task` is filtered from the model-visible tool set
- Builder execution now tracks non-artifact tool turns and escalates endgame instructions so the builder explicitly finalizes with `emit_builder_artifact`
- Builder artifact force-recovery treats only `_generate_*.py` files as runnable generator scripts (avoids false positives from similarly named helper files like `_generator_*.py`)
- `BuilderArtifactMiddleware` rejects path-traversal artifact paths (for both `artifact_path` and `supporting_files`) so emit verification/mirroring cannot escape `/mnt/user-data/outputs/`
- Background subagent timeout surfaces as a terminal status (`error`, `failed`, `timeout`, `timed_out`) on the corresponding `state["async_tasks"][task_id]` entry; the companion learns about it via `check_async_task`
- Companion synthesis remains in `ArtifactMiddleware` and runs against the builder's `emit_builder_artifact` payload returned via `check_async_task`
- Companion chain now includes config-driven `SummarizationMiddleware` wiring
- Builder chain now includes `SandboxMiddleware` and `TodoMiddleware` for execution parity

Regression command for this flow:

```bash
PYTHONPATH=. uv run pytest tests/test_sophia_builder_flow.py -v
```

### Sophia Vision Port (PR #132)

The companion and builder can both see images in-process — same `viewed_images` state channel that DeerFlow's lead_agent uses upstream, wrapped in narrow thread-scoped tools so the companion can't address other threads' filesystems.

**Capability gate**: `deerflow.agents.sophia_agent.vision_gate.supports_vision(model_name)` returns True for `claude-sonnet-5` and `claude-haiku-4-5-20251001` by default; operators can override per-model via `app_config.models[*].supports_vision`. Vision tools, middlewares, and uploaded-image briefing are all gated on this signal — a vision-off run never advertises a tool it can't call.

**Companion tools** (in `packages/harness/deerflow/sophia/tools/`):

| Tool | Use when | Notes |
|------|----------|-------|
| `view_user_image(image_filename)` | User shares an image (photo, screenshot, chart) and Sophia needs to see it. | Whitelists current thread's `uploads/` + `outputs/`; bare filename only (no paths). Rejects `.gif` (Anthropic flags as low-quality input). Caps at `MAX_VIEWABLE_IMAGE_BYTES = 10 MiB` raw — base64 expands ~33% and Anthropic's request envelope is 32 MB, so the cap returns a clean tool-side error instead of a provider 400. |
| `read_user_document(document_filename)` | Text PDFs, DOCX, PPTX, XLSX, MD, TXT — anything where vision would hallucinate fine print. Always prefer this over `view_user_image` for documents. | Converts to markdown via `markitdown` (no size cap). |

**`SophiaViewImageMiddleware`** (subclass of upstream `ViewImageMiddleware`):
- Recognizes both `view_image` (builder) and `view_user_image` (companion) tool names.
- **Skips injection when `viewed_images` is empty** (Codex P2 PR #132 later iteration). The tool's failure paths clear the registry to `{}` (via `merge_viewed_images` reducer's empty-dict sentinel) so a previously-loaded image from this session doesn't get re-injected after a failed lookup — without this, Sophia would answer about the OLD image while the user is asking about the missing one. The middleware skip prevents upstream's "No images have been viewed." HumanMessage from being synthesized into the cleared state.

**Builder uploads briefing** (`BuilderTaskMiddleware`):
- Surfaces images the user attached to the dispatching companion turn at `/mnt/user-data/uploads/{name}` in a `<uploaded_images>` block.
- Two rendering branches: vision-on says `Use view_image(image_path=...)`; vision-off says "the vision tool is NOT available in this build context — acknowledge the upload but don't call view_image". Picks the right branch from `BuilderTaskMiddleware(vision_enabled=...)` plumbed through `build_builder_middleware_chain`.

**Cross-thread image copy** (`start_builder_task._copy_parent_uploaded_images`):
- Each LangGraph thread has its own sandbox via `ThreadDataMiddleware`; the builder cannot read the companion's filesystem directly. At dispatch time, the wrapper copies eligible images from the companion's `user-data/uploads/` into the builder's freshly-allocated sandbox.
- Scoped to **current-turn attachments only** (Codex P1 PR #132 latest iteration). `_extract_current_turn_attachment_filenames(messages)` parses the synthesized `[The user has uploaded N file(s) ...]` block from the latest HumanMessage (the format produced by `frontend/src/app/stores/attachment-prompt.ts::buildAttachmentPrompt`). Only filenames in the block are copied — previously the loop enumerated EVERY image in the parent uploads dir, so an unrelated later builder request would re-expose private images from earlier turns. Defense-in-depth: bullets outside the bracketed block are ignored; filenames are re-filtered through `[A-Za-z0-9._-]+`.

Regression target for the vision port:

```bash
PYTHONPATH=. uv run pytest \
  tests/test_sophia_vision_dispatch.py \
  tests/test_sophia_vision_tools.py \
  tests/test_sophia_view_image_middleware.py -v
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
| **Sophia companion** | `view_user_image`, `read_user_document` (thread-scoped wrappers — see Vision Port below) |
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
| `GET /api/threads/{id}/uploads/list` | List uploaded files (also proxied by frontend at `/api/threads/{id}/uploads/list` to seed the AttachmentBar uniquifier against on-disk state — Codex P2 PR #132) |
| `DELETE /api/threads/{id}/uploads/{filename}` | Remove an uploaded file from disk (proxied by frontend so chip × actually clears bytes — Codex P2 PR #132) |
| `GET /api/threads/{id}/artifacts/{path}` | Serve generated artifacts |

### IM Channels

The IM bridge supports Feishu, Slack, and Telegram. Slack and Telegram still use the final `runs.wait()` response path, while Feishu now streams through `runs.stream(["messages-tuple", "values"])` and updates a single in-thread card in place.
Telegram inbound attachment downloads (photo/PDF path) are executed on Telegram's polling event loop via a loop-hop helper, so manager-side file reader calls avoid cross-loop bot runtime errors.

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

Sandbox mirror hook regression coverage (write_file/str_replace/bash wiring):

```bash
PYTHONPATH=. uv run pytest tests/test_sandbox_tools.py -v
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
