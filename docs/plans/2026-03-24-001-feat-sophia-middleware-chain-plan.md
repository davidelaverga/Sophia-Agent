---
title: "feat: Implement Sophia 14-middleware companion chain"
type: feat
status: active
date: 2026-03-24
origin: docs/specs/04_backend_integration.md
---

# feat: Implement Sophia 14-middleware companion chain

## Overview

Build the complete 14-middleware chain for the Sophia companion agent. This is the core backend component that processes every companion turn: injecting personality files, detecting crisis, calibrating tone, routing skills, retrieving memories, and managing artifacts. The chain transforms a bare LLM call into Sophia's full emotional intelligence pipeline.

## Problem Frame

Sophia's companion agent needs a middleware chain that dynamically assembles a per-turn system prompt from ~9,100 tokens of context (personality files, tone guidance, user identity, memories, skill files, artifact instructions) while respecting strict ordering dependencies. The chain must support a crisis fast-path (~200ms faster), partial tone guidance injection (1 band vs full file), and platform-aware response shaping. No Sophia Python code exists yet — this is greenfield implementation on top of DeerFlow's established `AgentMiddleware` framework.

Key references: `docs/specs/04_backend_integration.md` (Section 4), `docs/specs/06_implementation_spec.md` (Sections 2-3), and CLAUDE.md middleware chain specification.

## Requirements Trace

- R1. 14 middlewares execute in strict order as defined in CLAUDE.md Section "The 14-Middleware Chain"
- R2. Crisis fast-path: CrisisCheckMiddleware sets `skip_expensive=True`, downstream middlewares short-circuit, only `soul.md` + `crisis_redirect.md` injected
- R3. ToneGuidanceMiddleware injects one band (~726 tokens), not full file (~3,630 tokens), parsed at startup
- R4. RitualMiddleware runs before SkillRouterMiddleware (positions 11 and 12 per CLAUDE.md numbering)
- R5. Mem0MemoryMiddleware uses rule-based category selection before semantic search; writes only in offline pipeline, never in-turn
- R6. ArtifactMiddleware injects `artifact_instructions.md` and conditionally injects previous artifact
- R7. `emit_artifact` tool call required every turn via `tool_use`, never text parsing
- R8. Platform signal (`voice`/`text`/`ios_voice`) passed in configurable, shapes response length and middleware behavior
- R9. SophiaState TypedDict extends AgentState with all companion-specific fields
- R10. `soul.md` is permanently immutable and excluded from GEPA — FileInjectionMiddleware loads it without modification
- R11. `runs/stream` always for companion turns, never `runs/wait`
- R12. Agent registered in `langgraph.json` as `sophia_companion`

## Scope Boundaries

- Offline pipeline (smart opener generation, handoff writes, Mem0 extraction) is a separate plan
- Voice layer (SophiaLLM, SophiaTTS, Vision Agents integration) is Luis's track — not covered here
- Gateway API endpoints (`gateway/routers/sophia.py`) are a separate plan
- GEPA optimization system is Week 6 work
- Ritual files (`prepare.md`, `debrief.md`, `vent.md`, `reset.md`) content creation is not covered; the middleware that loads them is
- `switch_to_builder` tool implementation is scoped in but the builder middleware chain is not
- `retrieve_memories` tool implementation is scoped in

## Context & Research

### Relevant Code and Patterns

**Agent factory pattern** — `deerflow/agents/lead_agent/agent.py:make_lead_agent()`:
- Extracts configurable params from `RunnableConfig`
- Builds middleware list via `_build_middlewares()`
- Calls `create_agent(model=, tools=, middleware=, system_prompt=, state_schema=)`

**Middleware base class** — `langchain.agents.middleware.AgentMiddleware[StateT]`:
- Declare `state_schema` inner class extending `AgentState`
- Override hooks: `before_agent`, `after_agent`, `before_model`, `after_model`, `wrap_tool_call`
- Return `dict | None` with state updates (merged into state)
- Access runtime context via `runtime.context.get("thread_id")`, `runtime.context.get("user_id")`, etc.

**Concrete middleware examples in codebase:**
- `ThreadDataMiddleware` — `before_agent`, returns dict with paths
- `MemoryMiddleware` — `after_agent`, queues messages for async processing
- `TitleMiddleware` — `after_model`, generates title on first exchange
- `ViewImageMiddleware` — `before_model`, injects image data into messages

**LangGraph registration** — `langgraph.json` uses `"deerflow.agents:make_lead_agent"` import path pattern

**State pattern** — `ThreadState(AgentState)` uses `NotRequired` for optional fields, `Annotated[..., reducer]` for merge-able collections

### Codebase Path Discrepancy

The specs reference `backend/src/agents/sophia_agent/` but the actual DeerFlow code lives at `backend/packages/harness/deerflow/agents/`. Since sophia_agent must be importable as `deerflow.agents.sophia_agent` for LangGraph registration, the code must live inside the harness package.

**Decision: Place sophia_agent at `backend/packages/harness/deerflow/agents/sophia_agent/`** and sophia services at `backend/packages/harness/deerflow/sophia/`.

### Skills Path Discrepancy

Existing skill files are at `skills/public/Sophia/Emotional Skills/` (spaces, mixed case). The spec expects `skills/public/sophia/` (lowercase, no spaces). The middleware will need a `SKILLS_PATH` constant pointing to the actual location.

**Decision: Reorganize skills to match spec layout (`skills/public/sophia/`)** as a prerequisite unit. The current flat layout with spaces and `(1)` suffixes in filenames needs cleanup anyway.

## Key Technical Decisions

- **System prompt assembly via `before_model`**: Since `create_agent()` takes a static `system_prompt` string, dynamic per-turn prompt blocks accumulated by middlewares in `before_agent` will be assembled and prepended as a system message in a dedicated `before_model` hook on a `PromptAssemblyMiddleware` (or as part of the first middleware that fires `before_model`). Each middleware appends to a `system_prompt_blocks: list[str]` state field during `before_agent`.

- **Middleware hook selection**: Most Sophia middlewares use `before_agent` (runs once per turn) to set state and accumulate prompt blocks. `ArtifactMiddleware` uses both `before_agent` (inject instructions + previous artifact) and `after_model` (capture `emit_artifact` tool call output). `TitleMiddleware` and `SummarizationMiddleware` adapt DeerFlow's existing `after_model` patterns.

- **Crisis short-circuit via state flag**: `CrisisCheckMiddleware` sets `skip_expensive=True` in state. Each downstream middleware checks this flag at the top of its `before_agent` and returns `None` (no-op) when set. This is simpler than a middleware chain interrupt mechanism and follows the spec exactly.

- **SophiaState extends AgentState, not ThreadState**: Sophia doesn't need sandbox, uploads, viewed_images, or todos fields. Clean separation. Uses `NotRequired` for optional fields.

- **ThreadDataMiddleware reused from DeerFlow**: Position 1 is DeerFlow's existing `ThreadDataMiddleware` imported directly — no re-implementation needed.

- **Mem0 client as a service module**: `deerflow/sophia/mem0_client.py` wraps the Mem0 SDK with LRU cache (60s TTL). Used by `Mem0MemoryMiddleware` for retrieval and by the offline pipeline for writes. In-turn middleware only reads — never writes.

- **Tools defined in `deerflow/sophia/tools/`**: `emit_artifact`, `switch_to_builder`, `retrieve_memories` follow DeerFlow's `@tool` decorator pattern from `langchain_core.tools`.

## Open Questions

### Resolved During Planning

- **Q: Where does sophia_agent code live?** In `backend/packages/harness/deerflow/agents/sophia_agent/` to match DeerFlow's import structure (`deerflow.agents.sophia_agent`). (see Context & Research above)

- **Q: How do middlewares inject dynamic prompt content?** Via a `system_prompt_blocks` list in state, assembled into the system message in a `before_model` hook. Each middleware appends its block in `before_agent`.

- **Q: Should we reuse DeerFlow's ThreadDataMiddleware or write a new one?** Reuse directly — it's infrastructure middleware with no Sophia-specific behavior needed.

- **Q: What about the `SummarizationMiddleware` — DeerFlow's or custom?** Adapt DeerFlow's `SummarizationMiddleware` with a custom summary prompt and emotional arc extraction. Import the base and configure it, similar to how `_create_summarization_middleware()` works in `lead_agent/agent.py`.

### Deferred to Implementation

- **Exact Mem0 SDK method signatures**: Depends on the `mem0` package version installed. The middleware will wrap calls; exact API will be discovered during implementation.

- **SkillRouter complaint signature hashing**: The MD5-based approach in the spec may need tuning based on real conversation patterns. Start with the spec's approach, iterate based on testing.

- **`system_prompt_blocks` assembly order**: Whether blocks are joined with newlines, section headers, or XML tags will be determined during implementation based on Claude Haiku's response quality.

- **SummarizationMiddleware emotional arc extraction**: The exact parsing of `emit_artifact` tool call messages from LangGraph's message format needs runtime discovery.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Turn lifecycle (before_agent phase):

  User message arrives
       │
  ┌────▼─────────────────────────────────────────┐
  │ 1. ThreadDataMiddleware.before_agent          │ → thread_data paths
  │ 2. CrisisCheckMiddleware.before_agent         │ → force_skill, skip_expensive
  │ 3. FileInjection(soul.md).before_agent        │ → system_prompt_blocks += soul
  │ 4. FileInjection(voice.md).before_agent       │ → system_prompt_blocks += voice  (skip on crisis)
  │ 5. FileInjection(techniques.md).before_agent  │ → system_prompt_blocks += tech   (skip on crisis)
  │ 6. PlatformContext.before_agent               │ → platform, platform_prompt
  │ 7. UserIdentity.before_agent                  │ → system_prompt_blocks += identity.md
  │ 8. SessionState.before_agent                  │ → smart_opener (turn 0 only)
  │ 9. ToneGuidance.before_agent                  │ → active_tone_band, 1 band block
  │10. ContextAdaptation.before_agent             │ → context mode block
  │11. Ritual.before_agent                        │ → active_ritual, ritual_phase, ritual block
  │12. SkillRouter.before_agent                   │ → active_skill, skill block
  │13. Mem0Memory.before_agent                    │ → injected_memories, memory block
  │14. Artifact.before_agent                      │ → artifact_instructions + prev artifact
  └────┬─────────────────────────────────────────┘
       │
  ┌────▼──────────────────────┐
  │ PromptAssembly.before_model│ → assemble system_prompt_blocks into system message
  └────┬──────────────────────┘
       │
  ┌────▼──────┐
  │ LLM call  │ → text response + emit_artifact tool call
  └────┬──────┘
       │
  ┌────▼──────────────────────────────────────────┐
  │ Artifact.after_model       │ → capture emit_artifact, store in state
  │ Title.after_model          │ → generate session title (turn 1 only)
  │ Summarization.after_model  │ → compress if over token/message threshold
  │ Mem0Memory.after_agent     │ → queue session for offline extraction
  └──────────────────────────────────────────────┘
```

## Implementation Units

### Phase 1: Foundation (State, Agent Factory, Registration)

- [ ] **Unit 1: SophiaState TypedDict and skills path reorganization**

  **Goal:** Define the SophiaState schema and reorganize skill files to match spec layout.

  **Requirements:** R9, R10

  **Dependencies:** None

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/__init__.py`
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/state.py`
  - Reorganize: `skills/public/Sophia/Emotional Skills/*` → `skills/public/sophia/` (flat structure matching spec: `soul.md`, `voice.md`, `techniques.md`, `tone_guidance.md`, `artifact_instructions.md`, `context/`, `skills/`, `rituals/`)
  - Test: `backend/tests/test_sophia_state.py`

  **Approach:**
  - `SophiaState` extends `AgentState` with all fields from CLAUDE.md spec
  - Use `NotRequired` for optional fields, proper defaults
  - Add `system_prompt_blocks: list[str]` field for middleware prompt accumulation (use `Annotated[list[str], operator.add]` reducer so middleware dicts merge correctly)
  - Rename skill files: strip `skill_` prefix, remove `(1)` suffixes from prompt templates, flatten directory structure
  - Move prompt templates to `backend/packages/harness/deerflow/sophia/prompts/`

  **Patterns to follow:**
  - `deerflow/agents/thread_state.py` — TypedDict extension pattern, reducers, `NotRequired`

  **Test scenarios:**
  - SophiaState is valid TypedDict with all required fields
  - Default values are correct for optional fields
  - `system_prompt_blocks` reducer correctly concatenates lists from multiple middleware returns
  - All skill files exist at new paths after reorganization

  **Verification:**
  - State schema instantiable with minimal required fields
  - All skill `.md` files accessible at `skills/public/sophia/` paths

- [ ] **Unit 2: Agent factory and LangGraph registration**

  **Goal:** Create `make_sophia_agent()` factory and register in `langgraph.json`.

  **Requirements:** R1, R8, R11, R12

  **Dependencies:** Unit 1

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`
  - Modify: `backend/langgraph.json`
  - Modify: `backend/packages/harness/deerflow/agents/__init__.py` (export `make_sophia_agent`)
  - Test: `backend/tests/test_sophia_agent_factory.py`

  **Approach:**
  - Factory extracts `user_id`, `platform`, `ritual`, `context_mode` from `config.configurable`
  - Hardcodes model to `claude-haiku-4-5-20251001` via `ChatAnthropic` (no dynamic model selection)
  - Builds middleware list in strict order (placeholder instances initially — real middleware classes added in subsequent units)
  - Registers as `"sophia_companion": "deerflow.agents.sophia_agent:make_sophia_agent"` in `langgraph.json`
  - Also registers `"sophia_builder": "deerflow.agents:make_lead_agent"` (same code, different name/config)

  **Patterns to follow:**
  - `deerflow/agents/lead_agent/agent.py:make_lead_agent()` — configurable extraction, `create_agent()` call

  **Test scenarios:**
  - Factory returns a compiled graph when given valid config
  - Missing `user_id` defaults to `"default_user"`
  - Missing `platform` defaults to `"voice"`
  - `langgraph.json` contains both `sophia_companion` and `sophia_builder` entries

  **Verification:**
  - `make_sophia_agent(config)` returns without error
  - LangGraph server can discover the `sophia_companion` graph

### Phase 2: Infrastructure and Crisis Middlewares (Positions 1-2)

- [ ] **Unit 3: CrisisCheckMiddleware**

  **Goal:** Implement crisis fast-path detection that short-circuits the rest of the chain.

  **Requirements:** R2

  **Dependencies:** Unit 1

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/__init__.py`
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/crisis_check.py`
  - Test: `backend/tests/test_sophia_crisis_check.py`

  **Approach:**
  - 10 crisis signal phrases from CLAUDE.md, checked via substring match on lowercased last message
  - Sets `force_skill = "crisis_redirect"` and `skip_expensive = True` in returned state dict
  - Must handle empty messages list gracefully
  - Uses `before_agent` hook

  **Patterns to follow:**
  - `deerflow/agents/middlewares/thread_data_middleware.py` — `AgentMiddleware[StateT]` subclass, `state_schema`, `before_agent` returning dict

  **Test scenarios:**
  - Each of the 10 crisis signals triggers `force_skill` and `skip_expensive`
  - Case-insensitive matching ("Want To Die" matches)
  - Non-crisis message returns `None` (no state changes)
  - Empty messages list returns `None`
  - Crisis signal embedded in longer sentence still matches ("I want to die sometimes")

  **Verification:**
  - Crisis input sets both `force_skill` and `skip_expensive` in returned dict
  - Non-crisis input returns `None`

### Phase 3: File Injection Middlewares (Positions 3-5)

- [ ] **Unit 4: FileInjectionMiddleware**

  **Goal:** Generic middleware that reads a markdown file and appends its content to `system_prompt_blocks`. Instantiated 3 times for soul.md, voice.md, techniques.md.

  **Requirements:** R2 (crisis skip), R10 (soul.md always injected)

  **Dependencies:** Unit 1, Unit 3

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/file_injection.py`
  - Test: `backend/tests/test_sophia_file_injection.py`

  **Approach:**
  - Constructor takes `path: Path` and `skip_on_crisis: bool = False`
  - Reads file content once at init, caches in memory
  - `before_agent`: if `skip_on_crisis=True` and `state.skip_expensive=True`, return `None`
  - Otherwise return `{"system_prompt_blocks": [self._content]}`
  - `soul.md` instance: `skip_on_crisis=False` (always injected, even on crisis path)
  - `voice.md` and `techniques.md` instances: `skip_on_crisis=True`

  **Test scenarios:**
  - File content appended to `system_prompt_blocks` on normal path
  - `soul.md` instance injects even when `skip_expensive=True`
  - `voice.md` instance skips when `skip_expensive=True`
  - Missing file raises clear error at init time, not at runtime

  **Verification:**
  - Three instances produce correct block injection behavior for normal and crisis paths

### Phase 4: Platform and User Context (Positions 6-8)

- [ ] **Unit 5: PlatformContextMiddleware**

  **Goal:** Set platform state and inject platform-specific response length guidance.

  **Requirements:** R8

  **Dependencies:** Unit 1

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/platform_context.py`
  - Test: `backend/tests/test_sophia_platform_context.py`

  **Approach:**
  - Reads `platform` from `runtime.context` (set via configurable)
  - Maps to platform prompt string (voice: 1-3 sentences, text: 2-5 sentences, ios_voice: same as voice)
  - Returns `{"platform": platform, "system_prompt_blocks": [platform_prompt]}`
  - Skips on crisis path

  **Test scenarios:**
  - Each platform value produces correct prompt
  - Unknown platform defaults to `"voice"`
  - Skips when `skip_expensive=True`

  **Verification:**
  - State contains correct `platform` value and platform guidance block

- [ ] **Unit 6: UserIdentityMiddleware and SessionStateMiddleware**

  **Goal:** Load user identity file and session handoff with smart opener injection on turn 0.

  **Requirements:** R8 (platform-aware), R12

  **Dependencies:** Unit 1

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/user_identity.py`
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/session_state.py`
  - Test: `backend/tests/test_sophia_user_context.py`

  **Approach:**
  - `UserIdentityMiddleware`: reads `users/{user_id}/identity.md`, returns empty block if file doesn't exist (first session). Skips on crisis.
  - `SessionStateMiddleware`: reads `users/{user_id}/handoffs/latest.md`, extracts `smart_opener` from YAML frontmatter. On `turn_count == 0`, injects first-turn instruction block with the opener. Skips on crisis.
  - Both receive `user_id` as constructor parameter

  **Patterns to follow:**
  - File reading pattern from `FileInjectionMiddleware`, but read at runtime (not cached at init) since user data changes between sessions

  **Test scenarios:**
  - Identity file loaded and injected as prompt block
  - Missing identity file produces empty/no block (no error)
  - Smart opener injected only on `turn_count == 0`
  - Smart opener not injected on `turn_count > 0`
  - Missing handoff file handled gracefully
  - Both skip on crisis path

  **Verification:**
  - First turn includes smart opener block; subsequent turns do not
  - Missing user files don't crash the chain

### Phase 5: Calibration Middlewares (Positions 9-12)

- [ ] **Unit 7: ToneGuidanceMiddleware**

  **Goal:** Parse tone_guidance.md into 5 bands at startup, inject only the matching band per turn.

  **Requirements:** R3

  **Dependencies:** Unit 1

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/tone_guidance.py`
  - Test: `backend/tests/test_sophia_tone_guidance.py`

  **Approach:**
  - Constructor parses `tone_guidance.md` into 5 named band sections using regex on `## Band N:` headers and `**band_id: X**` markers
  - `_tone_to_band(tone: float)` maps tone estimate to band using BAND_RANGES dict
  - `before_agent`: reads `tone_estimate` from `state.previous_artifact` (default 2.5), selects band, returns `{"active_tone_band": band_id, "system_prompt_blocks": [band_content]}`
  - Skips on crisis path

  **Test scenarios:**
  - Each tone value maps to correct band (boundary values: 0.0, 0.5, 1.5, 2.5, 3.5, 4.0)
  - Only one band section injected (~726 tokens), not full file (~3,630 tokens)
  - Default tone (2.5) maps to "engagement" band
  - Missing `previous_artifact` defaults to engagement band
  - Band parsing handles the actual `tone_guidance.md` file format

  **Verification:**
  - Injected content is a single band section, not the full file
  - `active_tone_band` set correctly in state

- [ ] **Unit 8: ContextAdaptationMiddleware and RitualMiddleware**

  **Goal:** Inject context mode file and ritual file, maintaining strict ordering (ritual before skill router).

  **Requirements:** R4 (ritual before skill router)

  **Dependencies:** Unit 1

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/context_adaptation.py`
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/ritual.py`
  - Test: `backend/tests/test_sophia_context_ritual.py`

  **Approach:**
  - `ContextAdaptationMiddleware`: reads `skills/public/sophia/context/{context_mode}.md` (~130 tokens). Skips on crisis.
  - `RitualMiddleware`: reads `skills/public/sophia/rituals/{ritual}.md` when ritual is set. Sets `active_ritual` and initializes `ritual_phase`. Skips on crisis. Returns `None` when no ritual is active.
  - Both receive path and mode/ritual as constructor params

  **Test scenarios:**
  - Context file loaded for each mode (work, gaming, life)
  - Invalid context mode falls back gracefully
  - Ritual file loaded when ritual is set
  - No injection when ritual is None
  - `active_ritual` and `ritual_phase` set in state
  - Both skip on crisis path

  **Verification:**
  - Context block injected for valid mode
  - Ritual state fields populated when ritual is active

- [ ] **Unit 9: SkillRouterMiddleware**

  **Goal:** Deterministic skill cascade that selects and injects the appropriate skill file.

  **Requirements:** R2 (crisis redirect), R4 (reads ritual state)

  **Dependencies:** Unit 1, Unit 7, Unit 8

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/skill_router.py`
  - Test: `backend/tests/test_sophia_skill_router.py`

  **Approach:**
  - Pre-loads all 8 skill file contents at init
  - Cascade priority: force_skill (crisis) → danger language → boundary violation → raw vulnerability → new/guarded user → identity fluidity (tone > 2.0) → breakthrough (tone spike) → stuck loop (complaint count >= 3) → active_listening (default)
  - Updates `skill_session_data` (sessions_total, trust_established, complaint_signatures, skill_history)
  - On crisis path: only inject crisis_redirect skill file
  - Returns `{"active_skill": skill_name, "skill_session_data": updated_data, "system_prompt_blocks": [skill_content]}`

  **Patterns to follow:**
  - Cascade logic from `docs/specs/06_implementation_spec.md` Section 3 (SkillRouterMiddleware)

  **Test scenarios:**
  - Each cascade level triggers correctly in isolation
  - `force_skill` from crisis middleware takes highest priority
  - Trust not established (`sessions_total < 5`) routes to `trust_building`
  - `identity_fluidity_support` requires tone > 2.0
  - `challenging_growth` requires trust_established AND tone > 2.0 AND complaint count >= 3
  - `active_listening` is the default fallback
  - `skill_session_data` persists across turns via state
  - Crisis path only injects crisis_redirect

  **Verification:**
  - Correct skill selected for each scenario
  - `active_skill` and `skill_session_data` in returned state dict

### Phase 6: Memory and Artifact (Positions 13-14)

- [ ] **Unit 10: Mem0 client service and Mem0MemoryMiddleware**

  **Goal:** Mem0 SDK wrapper with LRU cache and middleware that retrieves context-appropriate memories.

  **Requirements:** R5

  **Dependencies:** Unit 1, Unit 8 (ritual state), Unit 9 (skill state)

  **Files:**
  - Create: `backend/packages/harness/deerflow/sophia/__init__.py`
  - Create: `backend/packages/harness/deerflow/sophia/mem0_client.py`
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_memory.py`
  - Test: `backend/tests/test_sophia_mem0.py`

  **Approach:**
  - `mem0_client.py`: wraps `MemoryClient` from `mem0` SDK. LRU cache with 60s TTL on `search()` results. `invalidate_user_cache(user_id)` for post-write invalidation. `search_memories(user_id, query, categories)` method.
  - Middleware `before_agent`: rule-based category selection (from CLAUDE.md spec), then `mem0_client.search_memories()`, inject results as prompt block (~750 tokens for ~10 results). Sets `injected_memories` list of memory IDs.
  - Middleware `after_agent`: queues session for offline extraction (does NOT write per-turn). Sets a flag or calls a queue mechanism.
  - Skips retrieval on crisis path

  **Test scenarios:**
  - Category selection matches CLAUDE.md rules (e.g., vent ritual adds feeling + relationship)
  - LRU cache returns same results within 60s TTL
  - Cache invalidation clears user's entries
  - `injected_memories` populated with memory IDs
  - No Mem0 writes happen during the turn (only queuing for offline)
  - Graceful handling of Mem0 API failures (log warning, continue without memories)

  **Verification:**
  - Memories injected as prompt block with correct categories
  - No writes to Mem0 during middleware execution

- [ ] **Unit 11: ArtifactMiddleware and emit_artifact tool**

  **Goal:** Inject artifact instructions, capture emit_artifact tool output, manage previous artifact state.

  **Requirements:** R6, R7

  **Dependencies:** Unit 1

  **Files:**
  - Create: `backend/packages/harness/deerflow/sophia/tools/__init__.py`
  - Create: `backend/packages/harness/deerflow/sophia/tools/emit_artifact.py`
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py`
  - Test: `backend/tests/test_sophia_artifact.py`

  **Approach:**
  - `emit_artifact` tool: Pydantic schema with 13 required fields (session_goal, active_goal, next_step, takeaway, reflection, tone_estimate, tone_target, active_tone_band, skill_loaded, ritual_phase, voice_emotion_primary, voice_emotion_secondary, voice_speed). Returns `"Artifact recorded."`.
  - Middleware `before_agent`: inject `artifact_instructions.md` content. Conditionally inject previous artifact (only when `tone_delta > 0.3` or active skill should persist context).
  - Middleware `after_model`: scan latest messages for `emit_artifact` tool call result, parse content, store as `current_artifact`. Shift `current_artifact` → `previous_artifact`.

  **Patterns to follow:**
  - `deerflow/sandbox/tools.py` — `@tool` decorator with Pydantic `args_schema`
  - `deerflow/agents/middlewares/title_middleware.py` — `after_model` hook for post-LLM processing

  **Test scenarios:**
  - `emit_artifact` tool validates all 13 fields
  - `tone_estimate` constrained to 0.0-4.0
  - `voice_speed` constrained to enum values
  - Artifact instructions injected on all platforms
  - Previous artifact injected conditionally (tone_delta threshold)
  - `after_model` correctly parses tool call result from messages
  - `current_artifact` → `previous_artifact` shift works across turns

  **Verification:**
  - Tool schema validates correctly via Pydantic
  - Artifact state lifecycle (inject → capture → shift) works end-to-end

### Phase 7: Adapted DeerFlow Middlewares and Prompt Assembly (Positions 15-16 + Assembly)

- [ ] **Unit 12: SophiaTitleMiddleware, SophiaSummarizationMiddleware, and PromptAssemblyMiddleware**

  **Goal:** Adapt DeerFlow's title and summarization for Sophia, plus the prompt assembly that turns accumulated blocks into the system message.

  **Requirements:** R1 (chain completeness)

  **Dependencies:** Unit 1, Unit 11

  **Files:**
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/title.py`
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/summarization.py`
  - Create: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/prompt_assembly.py`
  - Test: `backend/tests/test_sophia_title_summarization.py`

  **Approach:**
  - `SophiaTitleMiddleware`: `after_model` on first turn only. Custom title prompt referencing ritual_phase and session_goal from artifact. 3-5 word titles.
  - `SophiaSummarizationMiddleware`: Configure DeerFlow's `SummarizationMiddleware` with custom summary prompt preserving emotional states, and emotional arc extraction from `emit_artifact` tool calls before compression.
  - `PromptAssemblyMiddleware`: `before_model` hook. Joins all `system_prompt_blocks` from state into a single system message. Prepends to `messages` list. This runs before every LLM call to ensure the dynamic prompt is always current.

  **Test scenarios:**
  - Title generated only on first complete exchange
  - Title prompt includes ritual and session_goal context
  - Summarization triggers at correct thresholds (8000 tokens or 40 messages)
  - Emotional arc preserved through summarization
  - Prompt assembly joins all blocks into system message
  - Prompt assembly handles empty blocks list gracefully

  **Verification:**
  - Title appears after first turn
  - Summarization preserves emotional arc data
  - System message assembled from all middleware blocks

### Phase 8: Remaining Tools and Integration

- [ ] **Unit 13: switch_to_builder and retrieve_memories tools**

  **Goal:** Implement the two remaining companion tools.

  **Requirements:** R7 (tool_use pattern)

  **Dependencies:** Unit 10 (mem0 client), Unit 2 (agent factory)

  **Files:**
  - Create: `backend/packages/harness/deerflow/sophia/tools/switch_to_builder.py`
  - Create: `backend/packages/harness/deerflow/sophia/tools/retrieve_memories.py`
  - Test: `backend/tests/test_sophia_tools.py`

  **Approach:**
  - `switch_to_builder`: Takes task description and task_type. Packages user context (identity, tone, memories) from state. Delegates via DeerFlow's `task()` mechanism to `sophia_builder` agent. Returns result.
  - `retrieve_memories`: Targeted deep retrieval tool for reflect flow and specific queries. Calls `mem0_client.search_memories()` with custom query and categories. Returns formatted memory list.

  **Test scenarios:**
  - `switch_to_builder` packages correct context fields
  - `switch_to_builder` validates task_type enum
  - `retrieve_memories` returns formatted results
  - `retrieve_memories` handles empty results gracefully

  **Verification:**
  - Both tools callable via `@tool` decorator
  - Builder delegation creates task with correct context

- [ ] **Unit 14: Full chain integration and wire-up**

  **Goal:** Wire all 14 middlewares into `make_sophia_agent()` in correct order and verify end-to-end.

  **Requirements:** R1 (strict ordering), R2, R3, R4, R5, R6, R7, R8

  **Dependencies:** All previous units

  **Files:**
  - Modify: `backend/packages/harness/deerflow/agents/sophia_agent/agent.py` (replace placeholder middlewares with real instances)
  - Test: `backend/tests/test_sophia_integration.py`

  **Approach:**
  - Wire all 14 middlewares + PromptAssemblyMiddleware in the exact order from CLAUDE.md
  - Integration test: send a message through the full chain, verify state fields populated, system prompt assembled, artifact tool called
  - Crisis integration test: send crisis message, verify fast-path (only soul.md + crisis_redirect.md injected)
  - Platform test: verify different platform configs produce different response length guidance

  **Test scenarios:**
  - Normal turn: all 14 middlewares fire, system prompt contains expected blocks, `emit_artifact` tool call present in response
  - Crisis turn: only ThreadData + CrisisCheck + soul.md FileInjection + SkillRouter (crisis_redirect) fire; other middlewares short-circuit
  - Voice vs text platform: different platform prompt blocks
  - First turn: smart opener injected
  - Subsequent turn: no smart opener, previous artifact carries over
  - Middleware ordering verified: ritual state available when skill router runs

  **Verification:**
  - End-to-end message produces text response + artifact tool call
  - Crisis path response time measurably faster (fewer middleware executions)
  - All state fields populated after full chain execution

## System-Wide Impact

- **Interaction graph:** `make_sophia_agent()` is called by LangGraph Server when processing `sophia_companion` graph requests. The voice layer (`SophiaLLM`) calls LangGraph via HTTP with `runs/stream`. Gateway routes (`sophia.py`) will call the same graph.
- **Error propagation:** Middleware failures should log and continue (graceful degradation) rather than crash the turn. A missing skill file or Mem0 timeout should not prevent Sophia from responding.
- **State lifecycle risks:** `skill_session_data` persists via LangGraph checkpointer — resets per thread (correct for per-session tracking). `previous_artifact` carries across turns within a session. `system_prompt_blocks` must be rebuilt fresh each turn (not accumulated across turns).
- **API surface parity:** `sophia_companion` and `sophia_builder` both registered in `langgraph.json`. Builder uses the unmodified `lead_agent` graph — no parity concern there.
- **Integration coverage:** End-to-end test (Unit 14) should cover: message in → middleware chain → LLM call → artifact capture → state update. Mocked LLM to avoid API costs in CI.

## Risks & Dependencies

- **`langchain.agents` middleware API stability:** The `AgentMiddleware` class and `create_agent()` function are from `langchain>=1.2.3`. If the API changes, all middlewares need updating. Mitigation: pin version in `pyproject.toml`.
- **Mem0 SDK availability:** `mem0` package must be installed and `MEM0_API_KEY` configured. Middleware should handle API failures gracefully (log and continue without memories).
- **Skills file reorganization risk:** Moving files from `skills/public/Sophia/Emotional Skills/` to `skills/public/sophia/` may break any existing references. Mitigation: do this in Unit 1 before anything depends on the old paths.
- **System prompt token budget:** Peak ~9,144 tokens is 4.6% of Claude Haiku's 200k context. Not a risk, but monitor if prompt blocks grow.
- **`system_prompt_blocks` reducer:** Using `Annotated[list[str], operator.add]` means each middleware's returned dict with `{"system_prompt_blocks": [...]}` will append to the list. Must verify this works correctly with LangGraph's state merging.

## Sources & References

- **Spec (middleware chain):** `docs/specs/04_backend_integration.md` Section 4
- **Spec (implementation details):** `docs/specs/06_implementation_spec.md` Sections 2-3
- **CLAUDE.md:** Middleware chain, SophiaState, Mem0 categories, tools, platform values
- **DeerFlow middleware base:** `backend/packages/harness/deerflow/agents/middlewares/thread_data_middleware.py`
- **DeerFlow agent factory:** `backend/packages/harness/deerflow/agents/lead_agent/agent.py`
- **DeerFlow state:** `backend/packages/harness/deerflow/agents/thread_state.py`
- **Existing skills:** `skills/public/Sophia/Emotional Skills/`
