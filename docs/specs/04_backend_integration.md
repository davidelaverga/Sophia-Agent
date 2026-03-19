# Sophia Backend Integration
## DeerFlow Middleware Chain, Voice Pipeline, Builder Handoff, Offline Flows, GEPA
**Version:** 7.0 · March 2026
**Owner:** Jorge (Backend) + Davide (Architecture/Quality)
**Stack:** DeerFlow fork · LangGraph · Mem0 Platform · Vision Agents · FastAPI · Cartesia TTS
---
## 1. Repository Structure
```
sophia/  (fork of bytedance/deer-flow)
├── backend/
│   └── src/
│       ├── agents/
│       │   ├── lead_agent/              ← DeerFlow UNCHANGED — sophia_builder uses this
│       │   └── sophia_agent/            ← SOPHIA COMPANION
│       │       ├── graph.py             ← StateGraph definition
│       │       ├── agent.py             ← make_sophia_agent()
│       │       ├── state.py             ← SophiaState TypedDict
│       │       └── middlewares/
│       │           ├── crisis_check.py
│       │           ├── file_injection.py
│       │           ├── platform_context.py
│       │           ├── user_identity.py
│       │           ├── session_state.py
│       │           ├── tone_guidance.py
│       │           ├── context_adaptation.py
│       │           ├── ritual.py
│       │           ├── skill_router.py
│       │           ├── mem0_memory.py
│       │           ├── artifact.py
│       │           ├── title.py         ← DeerFlow TitleMiddleware (adapted)
│       │           └── summarization.py ← DeerFlow SummarizationMiddleware (enhanced)
│       └── sophia/                      ← SOPHIA SERVICES
│           ├── mem0_client.py           ← SDK wrapper + LRU cache
│           ├── extraction.py            ← Post-session Mem0 extraction
│           ├── handoffs.py              ← Handoff write/read
│           ├── smart_opener.py          ← Opener generation
│           ├── identity.py              ← Identity file assembly + update
│           ├── reflection.py            ← Reflect flow handler
│           ├── offline_pipeline.py      ← Orchestrates all post-session steps
│           ├── trace_logger.py          ← Turn trace writing
│           ├── golden_turns.py          ← Golden turn selection
│           ├── bootstrap.py             ← BootstrapFewShot implementation
│           ├── gepa.py                  ← GEPA optimization
│           └── prompts/                 ← Pipeline prompt templates (NOT skill files)
│               ├── mem0_extraction.md
│               ├── session_state_assembly.md
│               ├── smart_opener_assembly.md
│               ├── identity_file_update.md
│               └── reflect_prompt.md
├── voice/                               ← VISION AGENTS LAYER (Luis)
│   ├── server.py
│   ├── sophia_llm.py
│   ├── sophia_tts.py
│   └── sophia_turn.py                   ← Dynamic silence (future)
├── skills/public/sophia/                ← SKILL FILES (read by agent at runtime)
│   ├── soul.md                          ← Always injected directly (not via manifest)
│   ├── voice.md                         ← Always injected
│   ├── techniques.md                    ← Always injected
│   ├── tone_guidance.md                 ← Partially injected (1 band per turn)
│   ├── artifact_instructions.md         ← Injected by ArtifactMiddleware
│   ├── context/
│   │   ├── work.md
│   │   ├── gaming.md
│   │   └── life.md
│   ├── skills/
│   │   ├── active_listening.md
│   │   ├── vulnerability_holding.md
│   │   ├── crisis_redirect.md
│   │   ├── trust_building.md
│   │   ├── boundary_holding.md
│   │   ├── challenging_growth.md
│   │   ├── identity_fluidity_support.md
│   │   └── celebrating_breakthrough.md
│   └── rituals/
│       ├── prepare.md                   ← To be created
│       ├── debrief.md                   ← To be created
│       ├── vent.md                      ← To be created
│       └── reset.md                     ← To be created
├── users/                               ← PERSISTENT USER DATA
│   └── {user_id}/
│       ├── identity.md
│       ├── handoffs/
│       │   └── latest.md                ← Single file, always overwritten
│       └── traces/
│           └── {session_id}.json
├── gateway/
│   └── routers/
│       └── sophia.py                    ← Sophia-specific REST endpoints
├── langgraph.json                       ← Registers both graphs
├── config.yaml
└── .env
```
---
## 2. LangGraph Registration
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
`sophia_builder` points at DeerFlow's unmodified `lead_agent` graph. Different name, different config at invocation time (Sonnet model, full toolset). No code duplication.
---
## 3. SophiaState TypedDict
```python
# backend/src/agents/sophia_agent/state.py
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
class SophiaState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    # Platform and mode
    platform: str                 # "voice" | "text" | "ios_voice"
    active_mode: str              # "companion" | "builder"
    turn_count: int               # increments each turn; used for first-turn logic
    # User context
    user_id: str
    context_mode: str             # "work" | "gaming" | "life"
    # Ritual state
    active_ritual: str | None     # "prepare" | "debrief" | "vent" | "reset" | None
    ritual_phase: str | None      # e.g., "debrief.step2_what_worked"
    # Crisis fast-path
    force_skill: str | None       # set by CrisisCheckMiddleware
    skip_expensive: bool          # True during crisis path
    # Tone and skill
    active_tone_band: str         # current band ID from tone_guidance
    active_skill: str             # current skill name
    skill_session_data: dict      # cross-turn counters for skill routing
    # Artifacts
    current_artifact: dict | None
    previous_artifact: dict | None
    # Memory
    injected_memories: list[str]  # memory IDs for trace logging
    # Builder
    builder_task: dict | None
    builder_result: dict | None
```
---
## 4. The Companion Middleware Chain
14 middlewares in strict order. Order is load-bearing — dependencies are documented per middleware.
```python
# backend/src/agents/sophia_agent/agent.py
def make_sophia_agent(config: RunnableConfig) -> CompiledGraph:
    user_id = config.get("configurable", {}).get("user_id")
    platform = config.get("configurable", {}).get("platform", "voice")
    ritual = config.get("configurable", {}).get("ritual")
    context_mode = config.get("configurable", {}).get("context_mode", "life")
    middlewares = [
        # 1. Infrastructure
        ThreadDataMiddleware(),
        # 2. Crisis fast-path (before any expensive middleware)
        CrisisCheckMiddleware(),
        # 3. Always-loaded identity files
        FileInjectionMiddleware(SKILLS_PATH / "soul.md"),
        FileInjectionMiddleware(SKILLS_PATH / "voice.md"),
        FileInjectionMiddleware(SKILLS_PATH / "techniques.md"),
        # 4. Platform signal (downstream middlewares read state["platform"])
        PlatformContextMiddleware(),
        # 5-6. User context (stable, loaded before dynamic calibration)
        UserIdentityMiddleware(user_id),
        SessionStateMiddleware(user_id),
        # 7-9. Calibration (order matters: tone → context → ritual → skill)
        ToneGuidanceMiddleware(SKILLS_PATH / "tone_guidance.md"),
        ContextAdaptationMiddleware(SKILLS_PATH / "context", context_mode),
        RitualMiddleware(SKILLS_PATH / "rituals", ritual),  # BEFORE SkillRouter
        # 10. Skill routing (reads tone band + ritual from state)
        SkillRouterMiddleware(SKILLS_PATH / "skills"),
        # 11. Memory (after ritual+skill set — retrieval biased by both)
        Mem0MemoryMiddleware(user_id),
        # 12. Artifact system
        ArtifactMiddleware(SKILLS_PATH / "artifact_instructions.md"),
        # 13. Session title (DeerFlow, adapted for ritual-aware titles)
        TitleMiddleware(),
        # 14. Summarization (enhanced with artifact arc extraction)
        SummarizationMiddleware(),
    ]
    tools = [
        emit_artifact_tool,      # REQUIRED every turn
        switch_to_builder_tool,  # delegation to builder
        retrieve_memories_tool,  # targeted deep retrieval
    ]
    return create_sophia_agent(
        model=get_model("claude-haiku-4.5"),
        middlewares=middlewares,
        tools=tools,
        config=config,
    )
```
### Middleware Details
#### 1. ThreadDataMiddleware (DeerFlow)
Creates per-thread directories: `workspace/`, `uploads/`, `outputs/`. No changes from DeerFlow.
#### 2. CrisisCheckMiddleware (NEW)
```python
CRISIS_SIGNALS = [
    "want to die", "kill myself", "end it all", "don't want to be here",
    "hurt myself", "self harm", "suicide", "not worth living", "can't go on",
]
async def before(self, state):
    last = state["messages"][-1].content.lower()
    if any(s in last for s in CRISIS_SIGNALS):
        state["force_skill"] = "crisis_redirect"
        state["skip_expensive"] = True
    return state
```
When `skip_expensive=True`: FileInjection loads only soul.md + crisis_redirect.md. All other middlewares short-circuit. Crisis path response time: ~200ms faster than normal.
#### 3-5. FileInjectionMiddleware × 3 (Sophia)
Generic middleware, instantiated three times. Reads file from path, appends to system prompt block. Checks `state["skip_expensive"]` — on crisis path, only soul.md runs (second and third injections check and skip).
#### 6. PlatformContextMiddleware (NEW)
```python
PLATFORM_PROMPTS = {
    "voice":     "Platform: voice. Respond in 1-3 sentences. Spoken rhythm. Think before each word.",
    "text":      "Platform: in-app text. Respond in 2-5 sentences. Same directness, slightly more space.",
    "ios_voice": "Platform: iOS voice. Respond in 1-3 sentences. Spoken rhythm. Same as voice.",
}
```
Sets `state["platform"]` and `state["platform_prompt"]`. Downstream middlewares gate on `state["platform"]`. `ios_voice` inherits full voice behaviour — full artifact, streaming.
#### 7. UserIdentityMiddleware (Sophia)
Reads `users/{user_id}/identity.md`. Returns empty block on first session (file not yet created). ~650 tokens when populated.
#### 8. SessionStateMiddleware (Sophia)
Reads `users/{user_id}/handoffs/latest.md`. Extracts `smart_opener` from YAML frontmatter. When `state["turn_count"] == 0`, injects FIRST TURN INSTRUCTION block. Does not inject on subsequent turns.
#### 9. ToneGuidanceMiddleware (Sophia)
Reads `tone_estimate` from `state["previous_artifact"]`. Loads the matching band section from `tone_guidance.md` — NOT the full file. Each band section is pre-parsed at startup and cached in memory. Only ~726 tokens injected (vs ~3,630 for full file).
```python
class ToneGuidanceMiddleware:
    def __init__(self, tone_guidance_path):
        self.bands = self._parse_bands(tone_guidance_path)
        # self.bands = {"shutdown": "...", "grief_fear": "...", ...}
    def _parse_bands(self, path):
        # Split on ## Band N: headers using band_id markers
        # Returns dict of {band_id: section_content}
        ...
    async def before(self, state):
        if state.get("skip_expensive"):
            return state
        tone = state.get("previous_artifact", {}).get("tone_estimate", 2.5)
        band = self._tone_to_band(tone)
        state["active_tone_band"] = band
        state["tone_guidance_block"] = self.bands[band]
        return state
```
#### 10. ContextAdaptationMiddleware (Sophia)
Loads `skills/public/sophia/context/{context_mode}.md` (~130 tokens). Skips on `skip_expensive=True`.
#### 11. RitualMiddleware (Sophia) — MUST BE BEFORE SKILL ROUTER
Loads ritual file from `skills/public/sophia/rituals/{ritual}.md` when ritual is set in configurable. Sets `state["active_ritual"]` and initializes `state["ritual_phase"]` if not already set. Advances ritual phase based on conversation turns — never on a timer.
#### 12. SkillRouterMiddleware (Sophia)
Deterministic cascade. Reads: `state["force_skill"]`, current message, `state["active_tone_band"]`, `state["active_ritual"]`, `state["skill_session_data"]`.
```python
SKILL_CASCADE = [
    ("crisis_redirect",            is_force_crisis),
    ("crisis_redirect",            has_danger_language),
    ("boundary_holding",           has_boundary_violation),
    ("vulnerability_holding",      has_raw_vulnerability),
    ("trust_building",             is_new_or_guarded),
    ("identity_fluidity_support",  has_fixed_identity_language, tone_above_2),
    ("celebrating_breakthrough",   has_tone_spike_and_insight),
    ("challenging_growth",         has_stuck_loop, trust_established, tone_above_2),
    ("active_listening",           always_true),  # default
]
# skill_session_data structure:
# {
#   "sessions_total": int,
#   "trust_established": bool,  # sessions_total >= 5
#   "complaint_signatures": {"topic_hash": count},  # for stuck loop detection
#   "skill_history": deque(maxlen=5),  # last 5 skill selections
# }
```
`skill_session_data` is persisted in LangGraph state — automatically durable across turns via checkpointer. Resets with each new thread (correct — per-session tracking only).
#### 13. Mem0MemoryMiddleware (Sophia)
Before-phase: rule-based category selection → cached_search → inject memories (~750 tokens). After-phase: queues session for offline extraction (does NOT write per-turn).
#### 14. ArtifactMiddleware (Sophia)
Before-phase: if platform is `voice`, `ios_voice`, or `text` → inject full `artifact_instructions.md` (~2,760 tokens) + previous artifact (conditional). After-phase: reads `emit_artifact` tool call result from latest messages, stores as `state["current_artifact"]` and `state["previous_artifact"]`.
**Previous artifact injection is conditional:** Only inject when `previous_artifact.tone_delta > 0.3` OR a skill was active that should persist context. Skip on stable-state turns. Saves ~200 tokens on ~60% of turns.
#### 15. TitleMiddleware (DeerFlow, adapted)
Runs after-phase on first turn only. Sophia-customized title prompt:
```
Generate a 3-5 word session title.
Ritual: {ritual_phase}
Session goal: {session_goal from current_artifact}
Examples: "Morning prepare ritual" / "Work stress debrief" / "Identity reset"
No quotes. No punctuation at end.
```
#### 16. SummarizationMiddleware (DeerFlow, enhanced)
Configuration:
```yaml
summarization:
  enabled: true
  model_name: claude-haiku-4-5-20251001
  trigger:
    - type: tokens
      value: 8000
    - type: messages
      value: 40
  keep:
    type: messages
    value: 30        # generous — emotional continuity matters
  trim_tokens_to_summarize: 6000
  summary_prompt: |
    Extract the most important context from this conversation.
    Preserve emotional states in the user's own words where possible.
    Capture decisions made, commitments stated, unresolved tensions.
    Return only the extracted context, no preamble.
```
**Artifact arc enhancement:** Before compressing old messages, extract emotional arc from their `emit_artifact` tool call results:
```python
def extract_emotional_arc(messages_to_compress):
    artifacts = [
        json.loads(msg.content)
        for msg in messages_to_compress
        if hasattr(msg, 'name') and msg.name == 'emit_artifact'
    ]
    if not artifacts:
        return ""
    return f"""
[Emotional arc of summarized turns]
Tone: {artifacts[0]['active_tone_band']} ({artifacts[0]['tone_estimate']})
   → {artifacts[-1]['active_tone_band']} ({artifacts[-1]['tone_estimate']})
Skills activated: {', '.join(dict.fromkeys(a['skill_loaded'] for a in artifacts))}
"""
```
Summary block = text summary + emotional arc. Preserves emotional continuity through compression.
---
## 5. The Artifact System
### 5.1 The emit_artifact Tool
The artifact is delivered as a required tool_use call on every companion turn — never as appended JSON text. This guarantees schema compliance (Anthropic guarantees valid JSON on tool calls).
```python
# backend/src/sophia/tools/emit_artifact.py
from langchain_core.tools import tool
from pydantic import BaseModel
class ArtifactSchema(BaseModel):
    session_goal: str
    active_goal: str
    next_step: str
    takeaway: str
    reflection: str | None
    tone_estimate: float
    tone_target: float
    active_tone_band: str
    skill_loaded: str
    ritual_phase: str
    voice_emotion_primary: str
    voice_emotion_secondary: str
    voice_speed: str
@tool(args_schema=ArtifactSchema)
def emit_artifact(**kwargs) -> str:
    """
    REQUIRED: Call this tool on EVERY turn to emit your internal state.
    This is not optional. Your spoken response goes in the message content.
    This tool carries your calibration data.
    The user never sees this — it drives TTS emotion and session continuity.
    """
    return "Artifact recorded."
```
### 5.2 Text + Artifact in One Turn
The model produces:
1. Message content: the spoken/written response (streams to user)
2. `emit_artifact` tool call: all 13 fields (arrives after text, non-blocking)
The `ArtifactMiddleware` after-phase reads the tool call result from the last messages and stores it in state.
---
## 6. The Builder System
### 6.1 switch_to_builder Tool
```python
@tool
def switch_to_builder(
    task: str,
    task_type: str,   # "frontend"|"presentation"|"research"|"document"|"visual_report"
    runtime: ToolRuntime[None, SophiaState]
) -> str:
    """
    Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
    something requiring file creation or multi-step execution.
    Do NOT call for emotional conversation, reflection, or memory tasks.
    Before calling this, ensure you have complete specs — ask any clarifying
    questions first, then delegate with the complete brief.
    """
    user_context = {
        "identity": runtime.state.get("injected_identity"),
        "tone": runtime.state.get("previous_artifact", {}).get("tone_estimate"),
        "memories": runtime.state.get("injected_memories"),
    }
    # This internally calls DeerFlow's task() mechanism
    result = task(
        description=task,
        agent="sophia_builder",
        context={
            "task_type": task_type,
            "user_context": user_context,
        }
    )
    return result
```
### 6.2 Builder Middleware Chain (7 steps)
| # | Middleware | Source | Notes |
|---|-----------|--------|-------|
| 1 | ThreadDataMiddleware | DeerFlow | Shares thread with companion |
| 2 | SandboxMiddleware | DeerFlow | Builder's core capability |
| 3 | FileInjectionMiddleware (soul.md only) | Sophia | Values persist; voice not needed |
| 4 | UserIdentityMiddleware | Sophia | Personalizes build work |
| 5 | BuilderTaskMiddleware | Sophia NEW | Injects task brief from task() call |
| 6 | TodoListMiddleware | DeerFlow | Always plan mode — builder benefits from tracked steps |
| 7 | ~~TitleMiddleware~~ | Skipped | Subagents don't get titles |
No emotional middleware, no artifact system, no ritual routing, no Mem0 retrieval. The builder executes. The companion expresses the result.
### 6.3 Clarification Before Delegation
The `ClarificationMiddleware` cannot work inside a subagent (subagents cannot interrupt the parent graph). The pattern:
1. Companion detects build intent
2. **Companion asks any necessary clarifying questions first** ("Is this for your team or external stakeholders?")
3. User answers in the companion conversation
4. Companion now has complete specs
5. Companion calls `switch_to_builder` with the full brief
6. Builder receives complete context, executes without ambiguity
---
## 7. The Voice Layer
### 7.1 SophiaLLM Plugin
Key changes from previous version:
- Uses `runs/stream` not `runs/wait`
- Text tokens piped to TTS immediately as they arrive
- Artifact arrives via tool call result (not text parsing)
```python
class SophiaLLM(LLM):
    async def generate(self, conversation, *args, **kwargs):
        last_message = conversation.messages[-1].content
        user_id = conversation.messages[-1].user_id or "default_user"
        thread_id = await self._get_or_create_thread(user_id)
        text_parts = []
        artifact = {}
        async with self.client.stream(
            "POST",
            f"{self.url}/threads/{thread_id}/runs/stream",
            json={
                "assistant_id": "sophia_companion",
                "input": {"messages": [{"role": "user", "content": last_message}]},
                "config": {"configurable": {
                    "user_id": user_id,
                    "platform": "voice",
                    "ritual": self.active_ritual,
                    "context_mode": self.context_mode,
                }},
            }
        ) as response:
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                # Text tokens → pipe to TTS immediately
                if event.get("type") == "messages-tuple":
                    if event["data"].get("type") == "ai":
                        chunk = event["data"].get("content", "")
                        text_parts.append(chunk)
                        if self._tts_ref:
                            await self._tts_ref.stream_chunk(chunk)
                # Artifact → tool call result
                if event.get("type") == "messages-tuple":
                    if event["data"].get("type") == "tool" and \
                       event["data"].get("name") == "emit_artifact":
                        artifact = json.loads(event["data"]["content"])
                        if self._tts_ref:
                            self._tts_ref.update_from_artifact(artifact)
        self.last_artifact = artifact
        return "".join(text_parts)
```
### 7.2 Session End Detection
Vision Agents emits a WebRTC disconnect event when the user closes the session. SophiaLLM catches this and signals the offline pipeline:
```python
async def on_session_end(self, user_id, thread_id):
    """Called on WebRTC disconnect."""
    await trigger_offline_pipeline(user_id, thread_id, trigger="disconnect")
# Background inactivity watcher (runs every 5 minutes):
async def check_inactive_threads():
    for thread_id, last_active in active_threads.items():
        if time.time() - last_active > 600:  # 10 minutes
            user_id = thread_user_map[thread_id]
            await trigger_offline_pipeline(user_id, thread_id, trigger="timeout")
            del active_threads[thread_id]
```
---
## 8. DeerFlow Configuration
```yaml
# config.yaml
models:
  - name: claude-haiku
    display_name: Claude Haiku 4.5
    use: langchain_anthropic:ChatAnthropic
    model: claude-haiku-4-5-20251001
    api_key: $ANTHROPIC_API_KEY
    max_tokens: 4096
    supports_thinking: false
    supports_vision: true
  - name: claude-sonnet
    display_name: Claude Sonnet 4.6
    use: langchain_anthropic:ChatAnthropic
    model: claude-sonnet-4-6
    api_key: $ANTHROPIC_API_KEY
    max_tokens: 8192
    supports_thinking: true
    supports_vision: true
memory:
  enabled: false    # Sophia uses Mem0 directly — DeerFlow memory disabled
summarization:
  enabled: true
  model_name: claude-haiku-4-5-20251001
  trigger:
    - type: tokens
      value: 8000
    - type: messages
      value: 40
  keep:
    type: messages
    value: 30
  trim_tokens_to_summarize: 6000
subagents:
  enabled: true     # Required for builder delegation via task()
  max_concurrent: 3
  timeout_seconds: 900
skills:
  paths:
    - skills/public/sophia
  always_inject: []  # soul.md injected by FileInjectionMiddleware, not DeerFlow's skills system
sandbox:
  use: src.sandbox.local:LocalSandboxProvider  # Switch to Docker for production
```
---
## 9. Gateway API
```python
# gateway/routers/sophia.py
router = APIRouter(prefix="/api/sophia", tags=["sophia"])
# Memory candidates (existing + edit)
GET    /api/sophia/{user_id}/memories/recent?status=pending_review
PUT    /api/sophia/{user_id}/memories/{memory_id}     # keep or edit
DELETE /api/sophia/{user_id}/memories/{memory_id}     # discard
POST   /api/sophia/{user_id}/memories/bulk-review     # batch approve/discard
# Visual artifacts
GET    /api/sophia/{user_id}/visual/weekly
GET    /api/sophia/{user_id}/visual/decisions
GET    /api/sophia/{user_id}/visual/commitments
# Reflect flow
POST   /api/sophia/{user_id}/reflect
  body: {query: str, period: "this_week"|"this_month"|"overall"}
  returns: {voice_context: str, visual_parts: [...]}
# Journal
GET    /api/sophia/{user_id}/journal
```
---
## 10. GEPA Integration
Trace schema (every turn):
```json
{
  "turn_id": "sess_{session_id}_turn_{n}",
  "timestamp": "ISO8601",
  "tone_before": 0.0,
  "tone_after": 0.0,
  "tone_delta": 0.0,
  "is_golden_turn": false,
  "voice_emotion_primary": "sympathetic",
  "voice_emotion_secondary": "calm",
  "voice_speed": "gentle",
  "skill_loaded": "vulnerability_holding",
  "active_tone_band": "grief_fear",
  "ritual": "debrief",
  "platform": "voice",
  "context_mode": "work",
  "memory_injected": ["mem_abc123", "mem_def456"],
  "prompt_versions": {
    "voice_md": 1,
    "tone_guidance_md": 1,
    "active_skill_md": 1
  }
}
```
**Five invariants:**
1. `soul.md` is NEVER a GEPA target — architecturally blocked
2. Trace files are never optimized — ground truth
3. Global files require human review before deployment
4. Tone regression is a hard block
5. Schema version increments on structural changes
---
*Companion specs:*
- *`01_architecture_overview.md` — System overview, platforms, iOS Capacitor*
- *`02_build_plan.md` — 6-week phased build, three parallel tracks*
- *`03_memory_system.md` — Mem0, categories, retrieval, handoffs, smart opener, reflection*
- *`05_frontend_ux.md` — Vision Agents, memory candidates, Journal, visual artifacts, Capacitor iOS*
- *`06_implementation_spec.md` — Codebase-specific implementation details for Jorge and Luis*
