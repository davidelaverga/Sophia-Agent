# Sophia Implementation Spec
## Codebase-Specific Details for Jorge and Luis

**Version:** 3.0 · March 2026
**Purpose:** Precise implementation details tied to the DeerFlow codebase. Read this alongside the backend and memory specs. Covers the full 6-week build.

---

## 1. DeerFlow Codebase Map — What Jorge Needs to Know

### Files Jorge Reads (to understand patterns) — Never Modifies
```
backend/src/agents/lead_agent/agent.py        ← make_lead_agent() pattern to follow
backend/src/agents/middlewares/               ← All 9 DeerFlow middleware examples
backend/src/sandbox/tools.py                  ← Tool definition pattern (@tool decorator)
backend/src/config/                           ← Config loading patterns
```

### Files Jorge Creates
```
backend/src/agents/sophia_agent/              ← entire directory is new
backend/src/sophia/                           ← entire directory is new (core services)
skills/public/sophia/                         ← new directory under existing skills/
users/                                        ← new directory at project root
gateway/routers/sophia.py                     ← new file in existing routers/
```

### DeerFlow Files Jorge Configures (not modifies Python, just YAML/JSON)
```
langgraph.json         ← add sophia_companion + sophia_builder registrations
config.yaml            ← add models, disable memory, configure summarization
.env                   ← add ANTHROPIC_API_KEY, MEM0_API_KEY, etc.
```

---

## 2. make_sophia_agent() — Precise Pattern

DeerFlow's `make_lead_agent()` is the reference. Sophia's follows the same factory pattern:

```python
# backend/src/agents/sophia_agent/agent.py

from langchain_anthropic import ChatAnthropic
from langchain_core.runnables import RunnableConfig
from langgraph.prebuilt import create_react_agent

from .state import SophiaState
from .middlewares.crisis_check import CrisisCheckMiddleware
from .middlewares.file_injection import FileInjectionMiddleware
from .middlewares.platform_context import PlatformContextMiddleware
from .middlewares.user_identity import UserIdentityMiddleware
from .middlewares.session_state import SessionStateMiddleware
from .middlewares.tone_guidance import ToneGuidanceMiddleware
from .middlewares.context_adaptation import ContextAdaptationMiddleware
from .middlewares.ritual import RitualMiddleware
from .middlewares.skill_router import SkillRouterMiddleware
from .middlewares.mem0_memory import Mem0MemoryMiddleware
from .middlewares.artifact import ArtifactMiddleware
from .middlewares.title import SophiaTitleMiddleware
from .middlewares.summarization import SophiaSummarizationMiddleware

from ..sophia.tools.emit_artifact import emit_artifact
from ..sophia.tools.switch_to_builder import switch_to_builder
from ..sophia.tools.retrieve_memories import retrieve_memories

SKILLS_PATH = Path("/mnt/skills/public/sophia")

def make_sophia_agent(config: RunnableConfig):
    cfg = config.get("configurable", {})
    user_id = cfg.get("user_id", "default_user")
    platform = cfg.get("platform", "voice")
    ritual = cfg.get("ritual", None)
    context_mode = cfg.get("context_mode", "life")

    model = ChatAnthropic(
        model="claude-haiku-4-5-20251001",
        api_key=os.environ["ANTHROPIC_API_KEY"],
    )

    middlewares = [
        ThreadDataMiddleware(),
        CrisisCheckMiddleware(),
        FileInjectionMiddleware(SKILLS_PATH / "soul.md"),
        FileInjectionMiddleware(SKILLS_PATH / "voice.md", skip_on_crisis=True),
        FileInjectionMiddleware(SKILLS_PATH / "techniques.md", skip_on_crisis=True),
        PlatformContextMiddleware(),
        UserIdentityMiddleware(user_id),
        SessionStateMiddleware(user_id),
        ToneGuidanceMiddleware(SKILLS_PATH / "tone_guidance.md"),
        ContextAdaptationMiddleware(SKILLS_PATH / "context", context_mode),
        RitualMiddleware(SKILLS_PATH / "rituals", ritual),
        SkillRouterMiddleware(SKILLS_PATH / "skills"),
        Mem0MemoryMiddleware(user_id),
        ArtifactMiddleware(SKILLS_PATH / "artifact_instructions.md"),
        SophiaTitleMiddleware(),
        SophiaSummarizationMiddleware(),
    ]

    tools = [emit_artifact, switch_to_builder, retrieve_memories]

    return make_agent_with_middlewares(
        model=model,
        tools=tools,
        middlewares=middlewares,
        state_schema=SophiaState,
        config=config,
    )
```

### Registering in langgraph.json
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

### graph.py
```python
# backend/src/agents/sophia_agent/graph.py
from langgraph.graph import StateGraph, END
from .agent import make_sophia_agent
from .state import SophiaState

def build_graph():
    builder = StateGraph(SophiaState)
    # DeerFlow pattern: single agent node with middleware chain
    builder.add_node("agent", make_sophia_agent)
    builder.set_entry_point("agent")
    builder.add_edge("agent", END)
    return builder.compile()

graph = build_graph()
```

---

## 3. Middleware Implementation Pattern

DeerFlow middlewares use LangChain's middleware protocol. Study `backend/src/agents/middlewares/memory.py` for reference. Sophia middlewares follow the same pattern:

```python
# backend/src/agents/sophia_agent/middlewares/base_pattern.py
# This is the pattern — don't create this file, just follow it

class SophiaMiddleware:
    """Each middleware has before() and/or after() phases."""

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        """Runs before the LLM call. Modifies state. Returns state."""
        # Check skip_expensive flag for crisis path:
        if state.get("skip_expensive") and not self.runs_during_crisis:
            return state
        # Do work, modify state
        state["some_key"] = "some_value"
        return state

    async def after(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        """Runs after the LLM call. Reads LLM output from state. Returns state."""
        return state
```

### CrisisCheckMiddleware — Full Implementation
```python
# backend/src/agents/sophia_agent/middlewares/crisis_check.py

CRISIS_SIGNALS = [
    "want to die", "kill myself", "end it all", "don't want to be here",
    "hurt myself", "self harm", "suicide", "not worth living",
    "can't go on", "want to disappear",
]

class CrisisCheckMiddleware:
    runs_during_crisis = True  # This runs regardless

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if not state["messages"]:
            return state
        last = state["messages"][-1].content.lower()
        if any(signal in last for signal in CRISIS_SIGNALS):
            state["force_skill"] = "crisis_redirect"
            state["skip_expensive"] = True
        return state
```

### ToneGuidanceMiddleware — Band Parsing at Startup
```python
# backend/src/agents/sophia_agent/middlewares/tone_guidance.py

BAND_RANGES = {
    "shutdown":         (0.0, 0.5),
    "grief_fear":       (0.5, 1.5),
    "anger_antagonism": (1.5, 2.5),
    "engagement":       (2.5, 3.5),
    "enthusiasm":       (3.5, 4.0),
}

class ToneGuidanceMiddleware:
    def __init__(self, tone_guidance_path: Path):
        self._bands = self._parse_bands(tone_guidance_path)
        # Parsed once at startup — not re-read per turn

    def _parse_bands(self, path: Path) -> dict[str, str]:
        """Split tone_guidance.md into sections by ## Band N: header."""
        content = path.read_text()
        bands = {}
        # Each section runs from its marker to the next ## Band header
        # Returns {band_id: section_content_string}
        import re
        sections = re.split(r'(?=^## Band \d+:)', content, flags=re.MULTILINE)
        for section in sections:
            match = re.search(r'\*\*band_id: (\w+)\*\*', section)
            if match:
                bands[match.group(1)] = section.strip()
        return bands

    def _tone_to_band(self, tone: float) -> str:
        for band_id, (low, high) in BAND_RANGES.items():
            if low <= tone < high:
                return band_id
        return "engagement"  # default

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive"):
            return state
        tone = state.get("previous_artifact", {}).get("tone_estimate", 2.5)
        band = self._tone_to_band(tone)
        state["active_tone_band"] = band
        # Inject only this band section — not the full file
        state.setdefault("system_prompt_blocks", []).append(self._bands[band])
        return state
```

### SkillRouterMiddleware — Cascade Logic
```python
# backend/src/agents/sophia_agent/middlewares/skill_router.py

import hashlib
from collections import deque

SKILL_FILES = {
    "crisis_redirect": "crisis_redirect.md",
    "boundary_holding": "boundary_holding.md",
    "vulnerability_holding": "vulnerability_holding.md",
    "trust_building": "trust_building.md",
    "identity_fluidity_support": "identity_fluidity_support.md",
    "celebrating_breakthrough": "celebrating_breakthrough.md",
    "challenging_growth": "challenging_growth.md",
    "active_listening": "active_listening.md",
}

IDENTITY_FLUIDITY_PATTERNS = [
    "i'm broken", "i'm just not", "that's just who i am", "i'll never be",
    "i'm bad at", "i've always been", "i can't change",
]

TONE_SPIKE_THRESHOLD = 1.0  # for celebrating_breakthrough

class SkillRouterMiddleware:
    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self._skill_contents = {
            name: (skills_dir / filename).read_text()
            for name, filename in SKILL_FILES.items()
        }

    def _init_session_data(self) -> dict:
        return {
            "sessions_total": 0,
            "trust_established": False,
            "complaint_signatures": {},
            "skill_history": list(deque(maxlen=5)),
        }

    def _select_skill(self, state: SophiaState) -> str:
        sd = state.get("skill_session_data", self._init_session_data())
        msg = state["messages"][-1].content.lower() if state["messages"] else ""
        prev = state.get("previous_artifact", {})
        tone = prev.get("tone_estimate", 2.5)
        tone_prev = prev.get("tone_estimate", tone)
        tone_delta = tone - tone_prev

        # 1. Force override (crisis middleware set this)
        if state.get("force_skill"):
            return state["force_skill"]

        # 2. Danger language
        if any(s in msg for s in ["want to die", "hurt myself", "suicide"]):
            return "crisis_redirect"

        # 3. Boundary violation
        if any(s in msg for s in ["sexual", "send me", "be my girlfriend"]):
            return "boundary_holding"

        # 4. Raw vulnerability
        if any(s in msg for s in ["never told anyone", "i'm ashamed", "i hate myself"]):
            return "vulnerability_holding"
        if tone < 1.5 and any(s in msg for s in ["crying", "can't stop", "breaking"]):
            return "vulnerability_holding"

        # 5. New or guarded user
        if not sd.get("trust_established"):
            return "trust_building"

        # 6. Fixed identity language (tone > 2.0 required)
        if tone > 2.0 and any(p in msg for p in IDENTITY_FLUIDITY_PATTERNS):
            return "identity_fluidity_support"

        # 7. Breakthrough (tone spike + insight language)
        if tone_delta >= TONE_SPIKE_THRESHOLD:
            insight_words = ["i just realized", "oh my god", "i never saw", "i've been"]
            if any(w in msg for w in insight_words):
                return "celebrating_breakthrough"

        # 8. Stuck loop (complaint count >= 3, trust established, tone > 2.0)
        if sd.get("trust_established") and tone > 2.0:
            sig = hashlib.md5(msg[:50].encode()).hexdigest()[:6]
            if sd["complaint_signatures"].get(sig, 0) >= 3:
                return "challenging_growth"

        # 9. Default
        return "active_listening"

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive") and state.get("force_skill") == "crisis_redirect":
            # Crisis path: inject crisis_redirect skill and return
            state.setdefault("system_prompt_blocks", []).append(
                self._skill_contents["crisis_redirect"]
            )
            return state

        # Update session data
        sd = state.get("skill_session_data", self._init_session_data())
        sd["sessions_total"] += 1
        sd["trust_established"] = sd["sessions_total"] >= 5

        # Track complaint signatures
        if state["messages"]:
            msg = state["messages"][-1].content
            sig = hashlib.md5(msg[:50].encode()).hexdigest()[:6]
            sd["complaint_signatures"][sig] = sd["complaint_signatures"].get(sig, 0) + 1

        skill = self._select_skill(state)
        state["active_skill"] = skill

        # Track skill history
        history = list(sd.get("skill_history", []))
        history.append(skill)
        sd["skill_history"] = history[-5:]
        state["skill_session_data"] = sd

        # Inject skill file
        state.setdefault("system_prompt_blocks", []).append(
            self._skill_contents[skill]
        )
        return state
```

---

## 4. The emit_artifact Tool — Full Implementation

```python
# backend/src/sophia/tools/emit_artifact.py

from typing import Literal
from pydantic import BaseModel, Field
from langchain_core.tools import tool

TONE_BANDS = ["shutdown", "grief_fear", "anger_antagonism", "engagement", "enthusiasm"]
SKILLS = ["active_listening", "vulnerability_holding", "crisis_redirect",
          "trust_building", "boundary_holding", "challenging_growth",
          "identity_fluidity_support", "celebrating_breakthrough"]
VOICE_SPEEDS = ["slow", "gentle", "normal", "engaged", "energetic"]

class ArtifactInput(BaseModel):
    session_goal: str = Field(description="What this session is about. Set on turn 1, stable after.")
    active_goal: str = Field(description="What YOU are doing for the user THIS turn.")
    next_step: str = Field(description="What should happen next turn.")
    takeaway: str = Field(description="One insight worth remembering from this exchange.")
    reflection: str | None = Field(description="A question for the user to sit with. Can be null.")
    tone_estimate: float = Field(ge=0.0, le=4.0, description="User's current tone (0-4).")
    tone_target: float = Field(ge=0.0, le=4.0, description="tone_estimate + 0.5, capped at 4.0.")
    active_tone_band: str = Field(description="One of: shutdown|grief_fear|anger_antagonism|engagement|enthusiasm")
    skill_loaded: str = Field(description="Active skill name.")
    ritual_phase: str = Field(description="Format: ritual_name.step_description or freeform.topic")
    voice_emotion_primary: str = Field(description="Cartesia emotion for TTS. See vocabulary in artifact_instructions.md")
    voice_emotion_secondary: str = Field(description="Fallback emotion from primary set.")
    voice_speed: Literal["slow", "gentle", "normal", "engaged", "energetic"] = Field(
        description="TTS speed."
    )

@tool(args_schema=ArtifactInput)
def emit_artifact(**kwargs) -> str:
    """
    REQUIRED ON EVERY TURN. Call this tool with your internal state calibration.
    Your spoken response goes in the message content. This tool carries the
    metadata that drives voice emotion, session continuity, and self-improvement.
    The user never sees this output.
    """
    return "Artifact recorded."
```

---

## 5. Offline Pipeline — Precise Implementation

```python
# backend/src/sophia/offline_pipeline.py

import asyncio
from anthropic import Anthropic

client = Anthropic()

async def run_offline_pipeline(user_id: str, session_id: str, thread_id: str):
    """
    Idempotent — safe to run twice. Check processed flag before each step.
    """
    # Load inputs once
    session_memories = await mem0_get_session(user_id, session_id)
    session_artifacts = await load_session_artifacts(thread_id)
    previous_handoff = load_handoff(user_id)

    # Step 1: Smart opener (before handoff — handoff includes it)
    opener = await generate_smart_opener(
        user_id=user_id,
        previous_handoff=previous_handoff,
        session_artifacts=session_artifacts,
        session_memories=session_memories,
    )

    # Step 2: Handoff write
    handoff_content = await generate_handoff(
        user_id=user_id,
        session_artifacts=session_artifacts,
        session_memories=session_memories,
        smart_opener=opener,
    )
    write_handoff(user_id, handoff_content)

    # Step 3: Mem0 extraction (parallel — doesn't depend on handoff)
    memories = await extract_memories(
        user_id=user_id,
        session_id=session_id,
        session_artifacts=session_artifacts,
    )
    for memory in memories:
        metadata = {**memory["metadata"], "status": "pending_review"}
        mem0_client.add(
            [{"role": "user", "content": memory["content"]}],
            user_id=user_id,
            agent_id="sophia_companion",
            run_id=session_id,
            metadata=metadata,
        )
    invalidate_user_cache(user_id)

    # Step 4: In-app notification
    await notify_frontend(user_id, len(memories))

    # Step 5: Trace aggregation
    await aggregate_traces(user_id, session_id, session_artifacts)

    # Step 6: Identity update (conditional)
    if should_update_identity(user_id, get_session_count(user_id)):
        await update_identity_file(user_id)

    # Step 7: Visual artifact check (conditional)
    if get_sessions_this_week(user_id) >= 3:
        await generate_visual_artifact(user_id)


async def generate_smart_opener(user_id, previous_handoff, session_artifacts, session_memories):
    """Generate the smart opener for the next session."""
    prompt_template = Path("backend/src/sophia/prompts/smart_opener_assembly.md").read_text()

    final_tone = session_artifacts[-1].get("tone_estimate", 2.5) if session_artifacts else 2.5
    feeling = extract_feeling_from_artifacts(session_artifacts)
    next_steps = extract_next_steps_from_handoff(previous_handoff)

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=100,
        messages=[{
            "role": "user",
            "content": prompt_template.format(
                previous_handoff=previous_handoff or "No previous session.",
                final_tone=final_tone,
                feeling=feeling,
                next_steps=next_steps,
            )
        }]
    )
    return response.content[0].text.strip()
```

---

## 6. Session End Detection

```python
# backend/src/sophia/offline_pipeline.py (continued)

active_threads: dict[str, float] = {}   # {thread_id: last_activity_timestamp}
thread_user_map: dict[str, str] = {}    # {thread_id: user_id}
processed_sessions: set[str] = set()    # {session_id} — prevent double processing

async def on_turn_complete(thread_id: str, user_id: str, session_id: str):
    """Called after every companion turn completes."""
    active_threads[thread_id] = time.time()
    thread_user_map[thread_id] = user_id

async def on_disconnect(thread_id: str):
    """Called on WebRTC disconnect from SophiaLLM."""
    if thread_id in active_threads:
        user_id = thread_user_map[thread_id]
        session_id = get_session_id(thread_id)
        if session_id not in processed_sessions:
            processed_sessions.add(session_id)
            asyncio.create_task(run_offline_pipeline(user_id, session_id, thread_id))
        del active_threads[thread_id]

async def inactivity_watcher():
    """Runs every 5 minutes. Fires offline pipeline for inactive threads."""
    while True:
        await asyncio.sleep(300)
        now = time.time()
        for thread_id, last_active in list(active_threads.items()):
            if now - last_active > 600:  # 10 minutes
                user_id = thread_user_map[thread_id]
                session_id = get_session_id(thread_id)
                if session_id not in processed_sessions:
                    processed_sessions.add(session_id)
                    asyncio.create_task(
                        run_offline_pipeline(user_id, session_id, thread_id)
                    )
                del active_threads[thread_id]
```

---

## 7. Filesystem Paths — Complete Reference

All paths relative to project root:

```
# Skills (read-only, mounted at /mnt/skills/ in sandbox)
skills/public/sophia/soul.md
skills/public/sophia/voice.md
skills/public/sophia/techniques.md
skills/public/sophia/tone_guidance.md
skills/public/sophia/artifact_instructions.md
skills/public/sophia/context/work.md
skills/public/sophia/context/gaming.md
skills/public/sophia/context/life.md
skills/public/sophia/skills/active_listening.md
skills/public/sophia/skills/vulnerability_holding.md
skills/public/sophia/skills/crisis_redirect.md
skills/public/sophia/skills/trust_building.md
skills/public/sophia/skills/boundary_holding.md
skills/public/sophia/skills/challenging_growth.md
skills/public/sophia/skills/identity_fluidity_support.md
skills/public/sophia/skills/celebrating_breakthrough.md
skills/public/sophia/rituals/prepare.md        ← TO CREATE
skills/public/sophia/rituals/debrief.md        ← TO CREATE
skills/public/sophia/rituals/vent.md           ← TO CREATE
skills/public/sophia/rituals/reset.md          ← TO CREATE

# Pipeline prompt templates (not skill files — not visible to agent)
backend/src/sophia/prompts/mem0_extraction.md
backend/src/sophia/prompts/session_state_assembly.md
backend/src/sophia/prompts/smart_opener_assembly.md
backend/src/sophia/prompts/identity_file_update.md
backend/src/sophia/prompts/reflect_prompt.md

# User data (per user, per session)
users/{user_id}/identity.md
users/{user_id}/handoffs/latest.md
users/{user_id}/traces/{session_id}.json

# Sandbox (per thread, generated at runtime)
/mnt/user-data/{thread_id}/workspace/
/mnt/user-data/{thread_id}/uploads/
/mnt/user-data/{thread_id}/outputs/

# iOS (Capacitor — Luis's workspace, Week 6)
ios/                                               ← generated by `npx cap add ios`
capacitor.config.ts
```

---

## 8. Environment Variables

```bash
# Required — core
ANTHROPIC_API_KEY=sk-ant-...
MEM0_API_KEY=m0-...
SOPHIA_USER_ID=...           # For single-user deployment; multi-user: per-user

# Voice layer
CARTESIA_API_KEY=...
SOPHIA_VOICE_ID=...          # Cartesia voice ID for Sophia
DEEPGRAM_API_KEY=...
STREAM_API_KEY=...
STREAM_API_SECRET=...

# Optional
MEM0_BASE_URL=...            # If self-hosting Mem0
SOPHIA_SKILLS_PATH=...       # Override default skills path
```

---

## 9. Testing Checklist — Week 1 Day 1

**Morning: Infrastructure tests (Jorge)**
```bash
# 1. Fork is running
cd sophia && make dev
curl http://localhost:2026/health

# 2. sophia_companion graph registered
curl http://localhost:2024/assistants | jq '.[] | .assistant_id'
# Should show: "sophia_companion", "sophia_builder"

# 3. emit_artifact fires correctly
curl -X POST http://localhost:2024/threads \
  -H "Content-Type: application/json" -d '{}'
# → {"thread_id": "..."}

curl -X POST http://localhost:2024/threads/{thread_id}/runs/stream \
  -H "Content-Type: application/json" \
  -d '{"assistant_id": "sophia_companion", "input": {"messages": [{"role": "user", "content": "Hi"}]}, "config": {"configurable": {"user_id": "test", "platform": "voice"}}}'
# → SSE stream with text tokens + emit_artifact tool call

# 4. Artifact arrives as tool call (not appended text)
# Grep response for: "name": "emit_artifact"
# Grep response for: "tone_estimate" inside the tool call content

# 5. Latency measurement
time curl -X POST http://localhost:2024/threads/{thread_id}/runs/stream ...
# First token should arrive within 800ms in dev environment
```

**Afternoon: Mem0 tests (Jorge)**
```python
# Test category auto-classification
from mem0 import MemoryClient
client = MemoryClient(api_key=os.environ["MEM0_API_KEY"])

messages = [
    {"role": "user", "content": "I'm really anxious about my investor pitch tomorrow"},
    {"role": "assistant", "content": "That's a lot of pressure. What's driving the anxiety?"},
]
client.add(messages, user_id="test_user", run_id="test_session_1")

results = client.get_all(filters={"user_id": "test_user"})
# Verify: anxiety about pitch → category="feeling", importance >= 0.4
# Verify: investor pitch → category="fact" or "commitment"
```

**Voice loop test (Luis)**
```python
# Vision Agents server running
python voice/server.py run

# Navigate to Stream demo URL
# Speak: "Hi Sophia, I'm feeling really stressed today"
# Verify:
# 1. Deepgram transcribes correctly
# 2. Smart Turn fires within 1.5s of silence
# 3. DeerFlow receives message (check logs)
# 4. Response streams — first audio within 3s total
# 5. Check artifact arrives: print self.last_artifact in SophiaLLM
```

---

## 10. Testing Checklist — Week 6 (Capacitor + GEPA)

**Capacitor iOS tests (Luis)**
```bash
# 1. Capacitor project initialized
npm install @capacitor/core @capacitor/cli
npx cap init "Sophia" "com.sophia.app" --web-dir=out
npx cap add ios
npm run build && npx cap sync ios
npx cap open ios
# → Xcode opens with iOS project

# 2. Web app runs in simulator
# Build → Run in Xcode → Sophia loads in simulator
# Verify: full web experience works (chat, journal, visual artifacts)

# 3. Microphone permission is ONE-TIME
# Tap mic → iOS system dialog appears → tap Allow
# Close app, reopen → tap mic → NO dialog (permission persisted)
# ← This is the key test. If dialog appears again, something is wrong.

# 4. WebRTC works in WKWebView
# Switch to Live mode → speak → hear Sophia
# Verify: same latency as web browser (~1.5–2.5s)

# 5. Submit to TestFlight
# Archive → Distribute → TestFlight → install on physical device
# Full smoke test: voice live mode, text mode, journal, visual artifacts
```

**GEPA tests (Jorge)**
```python
# 1. Golden turn scan
from sophia.golden_turns import scan_golden_turns
golden = scan_golden_turns(user_id="test", min_delta=0.5)
# Verify: returns 3–5 turns with tone_delta >= 0.5
# Verify: each turn includes voice_emotion_primary

# 2. BootstrapFewShot injection
from sophia.bootstrap import inject_examples_into_voice_md
inject_examples_into_voice_md(golden_turns=golden[:5])
# Verify: voice.md now contains "Real Session Examples" section
# Verify: soul.md is NOT modified (it is excluded by design)

# 3. GEPA first pass
from sophia.gepa import run_gepa_pass
result = run_gepa_pass(target_file="voice.md", traces_path="users/test/traces/")
# Verify: variant generated
# Verify: tone regression check passes (no variant worse than baseline)
# Verify: human review step fires before deployment
```

---

## 11. Common Pitfalls to Avoid

### Jorge:
- `RitualMiddleware` MUST be at position 11 (before SkillRouter at 12). If swapped, skill cascade doesn't know the ritual context.
- `ToneGuidanceMiddleware` injects ONE band section, not the full `tone_guidance.md`. Injecting the full file doubles the baseline prompt size.
- Handoff path is always `users/{user_id}/handoffs/latest.md` — NEVER accumulate files.
- Pipeline prompt templates go in `backend/src/sophia/prompts/` — NOT in `skills/public/sophia/`. They are not skill files and should never appear in the agent's context.
- `soul.md` is never a GEPA target. Add it to the exclusion list before running any optimization.
- The offline pipeline must be idempotent. Use `processed_sessions` set to prevent double processing.
- `generate_smart_opener` does not receive cross-platform memories. The prompt template must not reference them — remove any `{cross_platform_memories}` placeholder from `smart_opener_assembly.md`.

### Luis:
- Use `runs/stream` not `runs/wait` for all voice and text conversations. Text tokens pipe to Cartesia immediately. This is the difference between 1.5s and 2.5s voice response time.
- Artifact arrives AFTER the text stream completes (as a tool call result). It updates the emotion for the NEXT TTS call, not the current one. Design the `SophiaTTS` plugin accordingly.
- Pass `platform: "voice"` vs `platform: "text"` vs `platform: "ios_voice"` in the `configurable` parameter. The middleware chain behaves differently per platform.
- The smart opener arrives in the FIRST message of a new session. It's injected by `SessionStateMiddleware` as a FIRST TURN INSTRUCTION — Sophia delivers it as her opening line before the user says anything.
- WebRTC in WKWebView requires the `WKWebViewConfiguration` to have `allowsInlineMediaPlayback = true` and `mediaTypesRequiringUserActionForPlayback = []`. Capacitor sets these by default — verify if Live mode audio doesn't work on device.
- The Capacitor-generated `ios/` directory should be gitignored. Xcode project settings (icons, splash, capabilities) are configured in Xcode, not in code.

---

*Companion specs:*
- *`01_architecture_overview.md` — System overview, platforms, iOS Capacitor*
- *`02_build_plan.md` — 6-week phased build, three parallel tracks*
- *`03_memory_system.md` — Mem0, categories, retrieval, handoffs, smart opener, reflection*
- *`04_backend_integration.md` — DeerFlow middleware chain, voice pipeline, offline flows, GEPA*
- *`05_frontend_ux.md` — Vision Agents, memory candidates, Journal, visual artifacts, Capacitor iOS*
