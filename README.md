# Sophia

**An AI voice companion with genuine continuity, emotional attunement, and measurable self-improvement.**

[![Python](https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white)](./backend/pyproject.toml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](./Makefile)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Sophia is not a chatbot. She is not a therapist or a coach. She is a companion — someone who remembers across sessions, notices patterns over time, and calibrates her emotional presence to where you are right now. She meets you half a point higher than where you landed. Never more than that.

---

## What Makes Sophia Different

Most voice AI products respond to what you say. Sophia responds to where you are.

Every turn, she estimates your emotional tone on a 0–4 scale. She selects a companion skill — vulnerability holding, active listening, gentle challenge — based on that tone, your session history, and the ritual context you set at the start. Her voice carries the right emotion for what she's saying, chosen by the same model that wrote the words. Her system prompt is rebuilt fresh every turn from layered, weighted components — not loaded once and forgotten.

And she improves. Trace logging runs from Week 2 onward, capturing tone delta, emotion choices, and skill selections on every turn. By Week 6, golden turns feed into BootstrapFewShot examples injected into `voice.md`. GEPA runs an evolutionary optimization pass on the same file. `soul.md` — the file that defines who she is — is permanently excluded from any optimization. It is architecturally immutable.

---

## Architecture

Two services. One intelligence.

```
┌──────────────────────────────────────────────────────────┐
│  VOICE LAYER — Vision Agents                              │
│                                                           │
│  User ↔ WebRTC (Stream) ↔ Vision Agents server           │
│  Web app (React SDK) · iOS app (Capacitor / WKWebView)   │
│                                                           │
│  STT:            Deepgram Nova-2                          │
│  Turn detection: Smart Turn (neural)                      │
│  Barge-in:       Automatic                                │
│  TTS:            Cartesia Sonic-3 (LLM-chosen per turn)  │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP · runs/stream
┌──────────────────────────┴───────────────────────────────┐
│  INTELLIGENCE LAYER — DeerFlow fork                       │
│                                                           │
│  LangGraph server (port 2024)                             │
│  sophia_companion  ← 14-middleware chain                  │
│  sophia_builder    ← DeerFlow lead_agent (unchanged)      │
│  Mem0 Platform     ← 9-category typed persistent memory  │
│  Offline pipeline  ← handoffs, extraction, identity, GEPA│
└──────────────────────────────────────────────────────────┘
```

The voice layer handles WebRTC transport, STT, turn detection, barge-in, and TTS. It knows nothing about Sophia's personality.

The intelligence layer handles personality, emotional calibration, memory, ritual routing, skill selection, artifact generation, and self-improvement. It knows nothing about audio.

They communicate over HTTP. `runs/stream` — not `runs/wait` — pipes text tokens to Cartesia as they arrive, so Sophia's voice starts after TTFT (~600ms) not after full generation (~1,200ms). The `emit_artifact` tool call arrives after the text stream and carries emotion metadata for the next TTS call.

---

## Three Platforms, One Intelligence

| Platform | Interaction | Voice emotion | Artifact |
|---|---|---|---|
| Voice (web app) | WebRTC, real-time | Drives Cartesia TTS | Full 13-field |
| Voice (iOS app) | WebRTC via Capacitor | Drives Cartesia TTS | Full 13-field |
| Text (web app) | In-app text chat | Tracked, not delivered | Full 13-field |

The iOS app is the existing Next.js web app wrapped in a Capacitor native shell. Same voice quality. Same intelligence. One-time microphone permission — no per-session Safari prompts.

---

## The 14-Middleware Companion Chain

Every turn, the system prompt is rebuilt from scratch by 14 ordered middleware layers:

```
1.  ThreadDataMiddleware        — per-thread workspace directories
2.  CrisisCheckMiddleware       — keyword scan, fast-paths to crisis_redirect
3.  FileInjectionMiddleware     — soul.md (always)
4.  FileInjectionMiddleware     — voice.md (skipped on crisis)
5.  FileInjectionMiddleware     — techniques.md (skipped on crisis)
6.  PlatformContextMiddleware   — sets platform signal for all downstream
7.  UserIdentityMiddleware      — loads identity.md (empty on first session)
8.  SessionStateMiddleware      — injects smart opener on first turn
9.  ToneGuidanceMiddleware      — injects one band section, not the full file
10. ContextAdaptationMiddleware — loads work / gaming / life context file
11. RitualMiddleware            — loads ritual file, tracks phase across turns
12. SkillRouterMiddleware       — selects companion skill via deterministic cascade
13. Mem0MemoryMiddleware        — rule-based category selection → semantic search
14. ArtifactMiddleware          — injects artifact instructions + previous artifact
    SophiaTitleMiddleware       — ritual-aware session title (after LLM)
    SophiaSummarizationMiddleware — artifact arc preserved on compression
```

Order is load-bearing. `RitualMiddleware` must precede `SkillRouterMiddleware` — the cascade reads `active_ritual` from state. `ToneGuidanceMiddleware` injects one band section (~726 tokens), not the full file (~3,630 tokens). The crisis fast-path (steps 2 → skip all expensive → 12) saves ~200ms per crisis turn.

---

## Memory System

Mem0 Platform is the single memory authority. No competing providers.

Nine custom categories:

| Category | What it stores |
|---|---|
| `fact` | Static user info — name, job, location. High stability. |
| `feeling` | Emotional patterns. Always include `tone_estimate` in metadata. |
| `decision` | Genuine decisions made. Not considerations. |
| `lesson` | Insights the user articulated or realized. |
| `commitment` | Goals, deadlines, stated intentions. |
| `preference` | Communication style, how they want to be treated. |
| `relationship` | People in the user's life — names, roles, dynamics. |
| `pattern` | Recurring behavioral observations. Require 2+ session evidence. |
| `ritual_context` | How the user uses each ritual — what works, preferences. |

Per-turn retrieval uses rule-based category selection in Python (zero latency), then semantic search within those categories. LRU cache (60s TTL) hits ~70% of turns within a session.

Writes happen only in the offline pipeline — never in-turn. Every write includes full entity scoping: `user_id`, `agent_id`, `run_id` (session), `timestamp`, and metadata including `tone_estimate` (required for `feeling` category).

---

## The Smart Opener System

At session end, the offline pipeline generates a single warm, context-aware sentence Sophia will use to open the next session — before the user says anything.

Examples by scenario:

- Upcoming event: *"The investor pitch is tomorrow. How are you feeling going into it?"*
- Unresolved thread: *"You mentioned the conversation with your co-founder — did that happen?"*
- After absence (3+ days): *"It's been a few days. Where are you at?"*
- Low tone, no open threads: *"How are you doing today?"*
- Post-breakthrough: *"Something shifted last time. How does it feel from the other side?"*

---

## Self-Improvement Loop

```
Week 2:  Trace logging starts — every turn writes tone, emotion, skill, platform, ritual
Week 6:  BootstrapFewShot — scan golden turns (tone_delta ≥ 0.5), inject into voice.md
Week 6:  GEPA first pass — evolutionary optimization of voice.md on tone_delta signal
```

Five invariants:

1. `soul.md` is never a GEPA target — architecturally excluded
2. Trace files are ground truth — never modified
3. Global files require human review before deployment
4. Tone regression is a hard block
5. Schema version increments on structural changes

---

## Repository Structure

```
sophia/  (fork of bytedance/deer-flow)
├── backend/src/
│   ├── agents/
│   │   ├── lead_agent/           ← DeerFlow — NEVER MODIFIED
│   │   └── sophia_agent/         ← Companion (entirely new)
│   │       ├── graph.py
│   │       ├── agent.py          ← make_sophia_agent()
│   │       ├── state.py          ← SophiaState TypedDict
│   │       └── middlewares/      ← 14 middleware files
│   └── sophia/                   ← Services (entirely new)
│       ├── mem0_client.py
│       ├── offline_pipeline.py
│       ├── trace_logger.py
│       ├── bootstrap.py
│       ├── gepa.py
│       └── prompts/              ← Pipeline prompt templates (NOT skill files)
├── voice/                        ← Vision Agents layer
│   ├── server.py
│   ├── sophia_llm.py
│   └── sophia_tts.py
├── skills/public/sophia/         ← Skill files (read by agent at runtime)
│   ├── soul.md                   ← IMMUTABLE
│   ├── voice.md
│   ├── techniques.md
│   ├── tone_guidance.md
│   ├── artifact_instructions.md
│   ├── context/                  ← work.md · gaming.md · life.md
│   ├── skills/                   ← 8 companion skill files
│   └── rituals/                  ← prepare · debrief · vent · reset
├── users/{user_id}/
│   ├── identity.md
│   ├── handoffs/latest.md
│   └── traces/{session_id}.json
├── gateway/routers/sophia.py
├── CLAUDE.md                     ← AI context for Claude Code
├── COMPOUND_LOG.md               ← Team compound engineering log
├── langgraph.json
├── config.yaml
└── .env
```

---

## Quick Start

### Prerequisites

- Python 3.12+
- Node.js 22+
- uv (fast Python package manager)
- pnpm
- A Stream account (WebRTC transport)
- API keys: Anthropic, Mem0, Cartesia, Deepgram

### 1. Clone and configure

```bash
git clone https://github.com/davidelaverga/Sophia-Agent.git
cd Sophia-Agent
make config
```

This creates local configuration files based on the provided example templates.

### 2. Set API keys

Copy `.env.example` to `.env` and fill in:

```bash
# Required — core
ANTHROPIC_API_KEY=sk-ant-...
MEM0_API_KEY=m0-...

# Voice layer
CARTESIA_API_KEY=...
SOPHIA_VOICE_ID=...         # Cartesia voice ID for Sophia
DEEPGRAM_API_KEY=...
STREAM_API_KEY=...
STREAM_API_SECRET=...
```

### 3. Configure models

Edit `config.yaml`:

```yaml
models:
  - name: claude-haiku
    display_name: Claude Haiku 4.5
    use: langchain_anthropic:ChatAnthropic
    model: claude-haiku-4-5-20251001
    api_key: $ANTHROPIC_API_KEY
    max_tokens: 4096

  - name: claude-sonnet
    display_name: Claude Sonnet 4.6
    use: langchain_anthropic:ChatAnthropic
    model: claude-sonnet-4-6
    api_key: $ANTHROPIC_API_KEY
    max_tokens: 8192

memory:
  enabled: false       # Sophia uses Mem0 directly
subagents:
  enabled: true        # Required for builder delegation
```

### 4. Register Sophia graphs

`langgraph.json` should contain:

```json
{
  "graphs": {
    "sophia_companion": "./backend/src/agents/sophia_agent/graph.py:graph",
    "sophia_builder": "./backend/src/agents/lead_agent/graph.py:graph"
  },
  "env": ".env",
  "python_version": "3.12",
  "dependencies": ["./backend"]
}
```

### 5. Running the Application

#### Option 1: Docker (Recommended)

**Development** (hot-reload, source mounts):

```bash
make docker-init    # Pull sandbox image (only once or when image updates)
make docker-start   # Start services (auto-detects sandbox mode from config.yaml)
```

`make docker-start` starts `provisioner` only when `config.yaml` uses provisioner mode (`sandbox.use: deerflow.community.aio_sandbox:AioSandboxProvider` with `provisioner_url`).

**Production** (builds images locally, mounts runtime config and data):

```bash
make up     # Build images and start all production services
make down   # Stop and remove containers
```

> [!NOTE]
> The LangGraph agent server currently runs via `langgraph dev` (the open-source CLI server).

Access: http://localhost:2026

See [CONTRIBUTING.md](CONTRIBUTING.md) for the detailed Docker development guide.

#### Option 2: Local Development

Prerequisite: complete the configuration steps above first (`make config` and API keys).

1. **Check prerequisites**:
   ```bash
   make check  # Verifies Node.js 22+, pnpm, uv, nginx
   ```

2. **Install dependencies**:
   ```bash
   make install  # Install backend + frontend dependencies
   ```

3. **(Optional) Pre-pull sandbox image**:
   ```bash
   make setup-sandbox
   ```

4. **Start services**:
   ```bash
   make dev
   ```

5. **Access**: http://localhost:2026

   Intelligence layer: `http://localhost:2024`
   Voice layer: `python voice/server.py run`

### 6. Verify

```bash
# Confirm both graphs are registered
curl http://localhost:2024/assistants | jq '.[].assistant_id'
# → "sophia_companion", "sophia_builder"

# Confirm emit_artifact fires on first turn
curl -X POST http://localhost:2024/threads -d '{}'
curl -X POST http://localhost:2024/threads/{thread_id}/runs/stream \
  -H "Content-Type: application/json" \
  -d '{"assistant_id": "sophia_companion",
       "input": {"messages": [{"role": "user", "content": "Hi"}]},
       "config": {"configurable": {"user_id": "test", "platform": "voice"}}}'
# → SSE stream — look for emit_artifact tool call in response
```

---

## Advanced

### Sandbox Mode

DeerFlow supports multiple sandbox execution modes:

- **Local Execution** (runs sandbox code directly on the host machine)
- **Docker Execution** (runs sandbox code in isolated Docker containers)
- **Docker Execution with Kubernetes** (runs sandbox code in Kubernetes pods via provisioner service)

For Docker development, service startup follows `config.yaml` sandbox mode. In Local/Docker modes, `provisioner` is not started.

See the [Sandbox Configuration Guide](backend/docs/CONFIGURATION.md#sandbox) to configure your preferred mode.

### MCP Server

DeerFlow supports configurable MCP servers and skills to extend its capabilities. For HTTP/SSE MCP servers, OAuth token flows are supported (`client_credentials`, `refresh_token`).

See the [MCP Server Guide](backend/docs/MCP_SERVER.md) for detailed instructions.

### IM Channels

DeerFlow supports receiving tasks from messaging apps. Channels auto-start when configured — no public IP required for any of them.

| Channel | Transport | Difficulty |
|---------|-----------|------------|
| Telegram | Bot API (long-polling) | Easy |
| Slack | Socket Mode | Moderate |
| Feishu / Lark | WebSocket | Moderate |

**Configuration in `config.yaml`:**

```yaml
channels:
  langgraph_url: http://localhost:2024
  gateway_url: http://localhost:8001

  session:
    assistant_id: lead_agent
    config:
      recursion_limit: 100
    context:
      thinking_enabled: true
      is_plan_mode: false
      subagent_enabled: false

  feishu:
    enabled: true
    app_id: $FEISHU_APP_ID
    app_secret: $FEISHU_APP_SECRET

  slack:
    enabled: true
    bot_token: $SLACK_BOT_TOKEN
    app_token: $SLACK_APP_TOKEN
    allowed_users: []

  telegram:
    enabled: true
    bot_token: $TELEGRAM_BOT_TOKEN
    allowed_users: []
```

Set the corresponding API keys in your `.env` file:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
FEISHU_APP_ID=cli_xxxx
FEISHU_APP_SECRET=your_app_secret
```

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation |
| `/status` | Show current thread info |
| `/models` | List available models |
| `/memory` | View memory |
| `/help` | Show help |

> Messages without a command prefix are treated as regular chat — DeerFlow creates a thread and responds conversationally.

---

## Core DeerFlow Features

Sophia is built on DeerFlow's agent harness. These capabilities are inherited and fully available.

### Skills & Tools

Skills are structured capability modules — Markdown files that define workflows, best practices, and references. DeerFlow ships with built-in skills for research, report generation, slide creation, web pages, image and video generation, and more.

Sophia adds its own skill files in `skills/public/sophia/` — companion skills, rituals, tone guidance, and artifact instructions. These are loaded progressively by the middleware chain, not all at once.

Tools follow the same philosophy. DeerFlow comes with a core toolset — web search, web fetch, file operations, bash execution — and supports custom tools via MCP servers and Python functions.

### Sub-Agents

Complex tasks rarely fit in a single pass. The lead agent can spawn sub-agents on the fly — each with its own scoped context, tools, and termination conditions.

Sophia's `sophia_builder` delegates to DeerFlow's unmodified `lead_agent` graph. The companion asks all clarifying questions first, then hands off complete specs. The current implementation waits for the builder to finish inside the same turn, persists the result in Sophia state, and attaches a relay-safe delivery payload so Telegram can receive the generated file even when LangGraph and Gateway run on separate Render disks. The companion can also intentionally resend the latest builder file in a later turn.

Sophia companion and builder mode now inherit DeerFlow-native `web_search` and `web_fetch` tools from config, so research-backed replies and builder outputs can browse and retrieve external sources without a Sophia-specific web integration.

### Sandbox & File System

Each task runs inside an isolated Docker container with a full filesystem — skills, workspace, uploads, outputs. The agent reads, writes, and edits files. It executes bash commands and code. All sandboxed, all auditable, zero contamination between sessions.

```
# Paths inside the sandbox container
/mnt/user-data/
├── uploads/          ← your files
├── workspace/        ← agents' working directory
└── outputs/          ← final deliverables
```

### Context Engineering

**Isolated Sub-Agent Context**: Each sub-agent runs in its own isolated context, ensuring focus without distraction from the main agent or other sub-agents.

**Summarization**: DeerFlow manages context aggressively — summarizing completed sub-tasks, offloading intermediate results to the filesystem, compressing what's no longer immediately relevant.

### Long-Term Memory

Sophia uses [Mem0 Platform](https://mem0.ai) as its single memory authority — see the [Memory System](#memory-system) section above. DeerFlow's built-in memory system is disabled (`memory.enabled: false` in `config.yaml`).

### Embedded Python Client

DeerFlow can be used as an embedded Python library without running the full HTTP services:

```python
from deerflow.client import DeerFlowClient

client = DeerFlowClient()

response = client.chat("Analyze this paper for me", thread_id="my-thread")

for event in client.stream("hello"):
    if event.type == "messages-tuple" and event.data.get("type") == "ai":
        print(event.data["content"])

models = client.list_models()
skills = client.list_skills()
client.update_skill("web-search", enabled=True)
client.upload_files("thread-1", ["./report.pdf"])
```

See `backend/packages/harness/deerflow/client.py` for the full API documentation.

---

## iOS App (Capacitor)

The existing Next.js web app wrapped in a native iOS shell. No Swift required.

```bash
npm install @capacitor/core @capacitor/cli
npx cap init "Sophia" "com.sophia.app" --web-dir=out
npx cap add ios
npm run build && npx cap sync ios
npx cap open ios        # Opens Xcode
```

Key test: tap the microphone once, grant permission, close the app, reopen — the system dialog must not appear again. If it does, the native permission flow is broken.

The `ios/` directory is gitignored. Configure icons, splash screen, and capabilities in Xcode, not in code.

---

## Prompt Token Budget (Companion, Voice Peak)

| Component | Tokens |
|---|---|
| soul.md + voice.md + techniques.md | ~2,853 |
| Tone guidance (1 of 5 bands) | ~726 |
| Context file (1 of 3) | ~130 |
| Ritual file (when active) | ~600 |
| artifact_instructions.md | ~2,760 |
| User identity file | ~650 |
| Session handoff | ~375 |
| Mem0 memories (~10 results) | ~750 |
| Active skill file | ~650 |
| Previous artifact (conditional) | ~200 |
| **Peak total** | **~9,144** |

4.6% of Claude Haiku's 200k context. No compression needed at normal operation.

---

## Gateway API

```
GET    /api/sophia/{user_id}/memories/recent?status=pending_review
PUT    /api/sophia/{user_id}/memories/{memory_id}
DELETE /api/sophia/{user_id}/memories/{memory_id}
POST   /api/sophia/{user_id}/memories/bulk-review
GET    /api/sophia/{user_id}/visual/weekly
GET    /api/sophia/{user_id}/visual/decisions
GET    /api/sophia/{user_id}/visual/commitments
POST   /api/sophia/{user_id}/reflect
       body:    { query: string, period: "this_week" | "this_month" | "overall" }
       returns: { voice_context: string, visual_parts: [...] }
GET    /api/sophia/{user_id}/journal
```

---

## Session Structure

The user drives every session. There is no ambiguous intent detection.

**Context mode** (app setting, 3 options):

- `work` — strategic ally, professional stakes, grounded confidence
- `gaming` — teammate and coach, higher energy, faster rhythm
- `life` — deepest register, patient, willing to wait

**Session type** (user choice at session start):

- Free conversation — no ritual, Sophia follows
- Prepare — structured intention-setting for what's ahead
- Debrief — processing what happened
- Vent — holding space, no agenda
- Reset — grounding when overwhelmed

Ritual and context pass as `configurable` parameters to the LangGraph server. The middleware chain reads them — never guesses them.

---

## Specification Documents

Full implementation detail in `docs/specs/`:

| File | Contents |
|---|---|
| `01_architecture_overview.md` | System overview, platforms, iOS Capacitor, key principles |
| `02_build_plan.md` | 6-week three-track execution plan, API contracts, convergence checklists |
| `03_memory_system.md` | Mem0 configuration, categories, retrieval, handoffs, smart opener, reflect flow |
| `04_backend_integration.md` | Middleware chain details, voice pipeline, builder system, offline pipeline, GEPA |
| `05_frontend_ux.md` | Vision Agents, voice experience, memory candidates, Journal, visual artifacts, Capacitor iOS |
| `06_implementation_spec.md` | Codebase-specific patterns, common pitfalls, testing checklists |

---

## Foundation

Sophia is built on [DeerFlow](https://github.com/bytedance/deer-flow) (MIT License) by ByteDance. The unmodified `lead_agent` graph powers Sophia's builder subagent. DeerFlow's middleware pattern, LangGraph integration, sandbox system, and summarization pipeline are the architectural foundation.

Sophia's companion intelligence, memory system, voice layer, and self-improvement loop are entirely new work built alongside DeerFlow — not on top of it as a dependency.

---

## Documentation

- [Contributing Guide](CONTRIBUTING.md) — Development environment setup and workflow
- [Configuration Guide](backend/docs/CONFIGURATION.md) — Setup and configuration instructions
- [Architecture Overview](backend/CLAUDE.md) — Technical architecture details
- [Backend Architecture](backend/README.md) — Backend architecture and API reference

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, workflow, and guidelines.

---

## License

This project is open source and available under the [MIT License](./LICENSE).

---

## Acknowledgments

Sophia is built upon the incredible work of the open-source community:

- **[DeerFlow](https://github.com/bytedance/deer-flow)** — The super agent harness that serves as Sophia's architectural foundation.
- **[LangChain](https://github.com/langchain-ai/langchain)** — Powers LLM interactions and chains.
- **[LangGraph](https://github.com/langchain-ai/langgraph)** — Enables multi-agent orchestration and the middleware pattern.
- **[Mem0](https://mem0.ai)** — Persistent memory platform with typed categories.
- **[Cartesia](https://cartesia.ai)** — Emotionally expressive text-to-speech.
- **[Deepgram](https://deepgram.com)** — Real-time speech-to-text.
- **[Stream](https://getstream.io)** — WebRTC transport layer.

### Key DeerFlow Contributors

A heartfelt thank you to the core authors of DeerFlow, whose work made Sophia possible:

- **[Daniel Walnut](https://github.com/hetaoBackend/)**
- **[Henry Li](https://github.com/magiccube/)**
