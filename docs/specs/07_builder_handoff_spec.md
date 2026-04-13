# Sophia Builder Handoff System
## Technical Specification for Implementation

**Version:** 1.0 · April 2026
**Status:** Implementation-ready
**Depends on:** 01_architecture_overview, 04_backend_integration §5 (Artifact System), §6 (Builder System)
**Replaces:** 04_backend_integration §6.1 (switch_to_builder), §6.2 (Builder Middleware Chain)

---

## 1. What This Spec Covers

The builder handoff is the bridge between Sophia's two agent loops:

- **Loop A (Companion):** Emotional, conversational, single-iteration. 14 middlewares. Claude Haiku. Runs on every turn.
- **Loop B (Builder):** Execution-focused, multi-iteration. 8 middlewares. Claude Sonnet. Runs on delegation via `task()`.

This spec defines three things:
1. **Companion → Builder:** What context flows from Loop A to Loop B, and how it shapes the builder's behavior.
2. **Builder → Companion:** What structured data flows back, and how the companion synthesizes it for the user.
3. **During Build:** How the companion interacts with the user while the builder works asynchronously.

**Design principle:** Artifacts are the universal structured data exchange format. The companion already emits one every turn (`emit_artifact`). The builder emits one at completion (`emit_builder_artifact`). Both are deterministic tool calls with guaranteed JSON schema compliance.

---

## 2. Companion → Builder: The Delegation

### 2.1 Revised switch_to_builder Tool

```python
# backend/src/sophia/tools/switch_to_builder.py

from typing import Literal
from pydantic import BaseModel, Field
from langchain_core.tools import tool

class SwitchToBuilderInput(BaseModel):
    task: str = Field(
        description="Complete task description with all specs gathered "
                    "from clarification. Be specific — the builder cannot "
                    "ask follow-up questions."
    )
    task_type: Literal[
        "frontend", "presentation", "research",
        "document", "visual_report"
    ] = Field(
        description="Type of deliverable. Determines builder skill loading."
    )

@tool(args_schema=SwitchToBuilderInput)
def switch_to_builder(
    task: str,
    task_type: str,
    runtime: ToolRuntime[None, SophiaState]
) -> str:
    """
    Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
    something requiring file creation or multi-step execution.

    Do NOT call for emotional conversation, reflection, or memory tasks.

    Before calling this, ensure you have complete specs — ask any clarifying
    questions first, then delegate with the complete brief.
    """
    # The companion's most recent artifact — contains the full emotional
    # snapshot of the moment of delegation: tone_estimate, active_tone_band,
    # session_goal, active_goal, takeaway, reflection, skill_loaded,
    # ritual_phase, voice_emotion_primary/secondary, voice_speed.
    companion_artifact = runtime.state.get("current_artifact") or \
                         runtime.state.get("previous_artifact") or {}

    delegation_context = {
        "task_type": task_type,

        # Full companion artifact — emotional/contextual snapshot
        "companion_artifact": companion_artifact,

        # Identity and memories don't live in the artifact
        "user_identity": runtime.state.get("injected_identity"),
        "relevant_memories": runtime.state.get("injected_memories"),

        # Ritual context — if active, the builder needs to know
        # what the user is preparing for / debriefing from
        "active_ritual": runtime.state.get("active_ritual"),
        "ritual_phase": runtime.state.get("ritual_phase"),
    }

    # Set builder state in SophiaState for the companion to track
    runtime.state["active_mode"] = "builder"
    runtime.state["builder_task"] = {
        "description": task,
        "task_type": task_type,
        "delegated_at": datetime.utcnow().isoformat(),
        "status": "started",
    }

    # DeerFlow's task() mechanism — runs builder as subagent
    result = task(
        description=task,
        agent="sophia_builder",
        context=delegation_context,
    )

    # Builder completed — update state
    runtime.state["active_mode"] = "companion"
    runtime.state["builder_task"]["status"] = "completed"

    return result
```

### 2.2 What Changed from Previous Spec

| Field | Old | New | Why |
|-------|-----|-----|-----|
| `user_context.tone` | `previous_artifact.tone_estimate` (single float) | Full `companion_artifact` (13 fields) | A float carries no behavioral signal. The full artifact carries session_goal, active_goal, tone band, skill, ritual phase, takeaway — everything the builder needs to understand the emotional moment |
| `user_context.identity` | `injected_identity` | `user_identity` (same data, renamed) | Clearer field name |
| `user_context.memories` | `injected_memories` | `relevant_memories` (same data, renamed) | Clearer field name |
| `active_ritual` | Not passed | Passed as top-level field | Ritual context shapes what the builder creates (prepare → confidence; debrief → reflection; vent → simplicity) |
| `ritual_phase` | Not passed | Passed as top-level field | Specific phase gives the builder even more context |

---

## 3. BuilderTaskMiddleware — Translating Emotion into Execution Guidance

### 3.1 Purpose

The builder's LLM (Claude Sonnet) does not need to "feel" the user's emotional state. It needs actionable guidance about what kind of deliverable to create given that state. This middleware translates the companion's structured artifact into behavioral instructions.

### 3.2 Position in Builder Chain

Position 5 of 8. Depends on: ThreadData (1), Sandbox (2), soul.md (3), UserIdentity (4) already loaded.

### 3.3 Implementation

```python
# backend/src/agents/sophia_agent/middlewares/builder_task.py

import json
from pathlib import Path
from langchain_core.runnables import RunnableConfig


class BuilderTaskMiddleware:
    """
    Reads delegation_context from the task() call and injects a structured
    briefing into the builder's system prompt. Translates the companion's
    emotional artifact into behavioral guidance the builder can act on.
    """

    def _tone_guidance(self, tone: float, band: str) -> str:
        """
        Translate the companion's tone reading into builder behavior.
        These map directly to the tone_skills.md band definitions.
        The builder doesn't calibrate emotionally — it adapts its
        OUTPUT to serve the user's current state.
        """
        if band == "shutdown" or tone < 1.0:
            # Band 1: Apathy / Grief / Fear
            # The user has very low energy. They asked for something
            # to be built, which itself is a sign of slight agency.
            # Make the deliverable require zero decisions.
            return (
                "The user is in a very low emotional state (Band 1 — apathy/grief/fear). "
                "They asked you to build something, which means they have enough "
                "agency to delegate but not enough to make detailed decisions. "
                "Implications for your work:\n"
                "- Make ALL decisions yourself. Do not leave options or alternatives.\n"
                "- Keep the deliverable simple and clean. Fewer elements, not more.\n"
                "- If the task is a document or presentation, use a calm, steady tone.\n"
                "- Minimize anything that requires further user input or review.\n"
                "- Quality over ambition. Deliver something complete and reliable."
            )

        elif band == "grief_fear" or tone < 1.5:
            # Band 1-2 boundary
            return (
                "The user is in a low emotional state (Band 1-2 — grief/fear transitioning "
                "to struggle). They have enough energy to ask for help but are carrying weight. "
                "Implications for your work:\n"
                "- Make most decisions yourself. Offer at most one choice point.\n"
                "- Keep the deliverable clean and uncluttered.\n"
                "- If the task is a presentation, favor confidence and clarity over complexity.\n"
                "- Minimize visual noise. White space is your friend.\n"
                "- The deliverable should feel like relief, not more work."
            )

        elif band == "anger_antagonism" or tone < 2.5:
            # Band 2: Anger / Struggle / Heaviness
            # Two faces: hot (anger) and heavy (struggle).
            # Either way, the user wants something DONE.
            return (
                "The user is frustrated or struggling (Band 2 — anger/heaviness). "
                "They want this built because something isn't working and they need "
                "it handled. Implications for your work:\n"
                "- Be direct and efficient. No unnecessary flourishes.\n"
                "- The deliverable should feel competent and decisive.\n"
                "- If the task involves analysis or research, lead with findings, not methodology.\n"
                "- Make the output feel like forward motion — something shifted.\n"
                "- If there are problems with the brief, solve them rather than flagging them."
            )

        elif band == "engagement" or tone < 3.5:
            # Band 3-4: Processing → Engagement
            # The user has energy and is in problem-solving mode.
            # They can handle options and nuance.
            return (
                "The user is engaged and has momentum (Band 3-4 — processing/engagement). "
                "They have the energy to review, iterate, and make decisions. "
                "Implications for your work:\n"
                "- You can be more ambitious with the deliverable.\n"
                "- Include thoughtful details that show craft.\n"
                "- It's okay to leave 1-2 decision points for the user — they can handle it.\n"
                "- If the task involves research, include depth and nuance.\n"
                "- Match their energy: thorough, precise, forward-looking."
            )

        else:
            # Band 4-5: Engagement → Enthusiasm
            # The user is in a high-energy state. They want something
            # that matches their excitement.
            return (
                "The user is in a high-energy state (Band 4-5 — engagement/enthusiasm). "
                "They're excited about what they're building or where they're heading. "
                "Implications for your work:\n"
                "- Be ambitious. Include stretch elements they can be proud of.\n"
                "- If the task is creative, bring creative energy.\n"
                "- Add one element that surprises — something they didn't ask for but will love.\n"
                "- The deliverable should feel like it was built by someone who shares their excitement.\n"
                "- Don't play it safe. They have the energy to handle bold choices."
            )

    def _ritual_guidance(self, ritual: str | None, phase: str | None) -> str | None:
        """
        Translate the active ritual into builder context.
        The ritual tells the builder WHY the user is asking for this.
        """
        if not ritual:
            return None

        guidance = {
            "prepare": (
                "RITUAL CONTEXT: The user is in a PREPARE ritual — they are getting ready "
                "for something important (a meeting, pitch, presentation, conversation). "
                "The deliverable should help them feel READY. "
                "Prioritize clarity, confidence, and completeness. "
                "Remove anything that might make them second-guess. "
                "The output should feel like armor, not homework."
            ),
            "debrief": (
                "RITUAL CONTEXT: The user is in a DEBRIEF ritual — they are processing "
                "something that already happened. The deliverable should help them EXTRACT "
                "lessons and see patterns. If building a document, structure it around "
                "what happened → what worked → what didn't → what's next. "
                "Help them see their experience clearly."
            ),
            "vent": (
                "RITUAL CONTEXT: The user was in a VENT ritual — they needed to let "
                "something out. The fact that they're now asking you to build something "
                "means they've moved past the venting into action. Honor that transition. "
                "The deliverable should feel supportive but not heavy. "
                "Keep it simple. Don't add complexity to an already full emotional load."
            ),
            "reset": (
                "RITUAL CONTEXT: The user is in a RESET ritual — they're clearing the "
                "deck and starting fresh. The deliverable should feel CLEAN and "
                "FORWARD-LOOKING. No references to past problems unless specifically "
                "requested. The output should feel like a new beginning."
            ),
        }

        result = guidance.get(ritual, f"Active ritual: {ritual}")
        if phase:
            result += f"\nCurrent phase: {phase}"
        return result

    async def before(self, state: dict, config: RunnableConfig) -> dict:
        context = config.get("configurable", {}).get("delegation_context", {})
        if not context:
            return state

        artifact = context.get("companion_artifact", {})
        identity = context.get("user_identity", "")
        memories = context.get("relevant_memories", [])
        ritual = context.get("active_ritual")
        ritual_phase = context.get("ritual_phase")
        task_type = context.get("task_type", "document")

        # --- Build the injection ---
        sections = []

        # 1. Task type
        sections.append(f"TASK TYPE: {task_type}")

        # 2. Session and task context from the companion artifact
        if artifact:
            session_goal = artifact.get("session_goal", "")
            active_goal = artifact.get("active_goal", "")
            takeaway = artifact.get("takeaway", "")
            reflection = artifact.get("reflection")

            if session_goal:
                sections.append(f"SESSION CONTEXT: {session_goal}")
            if active_goal:
                sections.append(
                    f"COMPANION'S GOAL AT DELEGATION: {active_goal}"
                )
            if takeaway:
                sections.append(f"KEY INSIGHT FROM CONVERSATION: {takeaway}")
            if reflection:
                sections.append(
                    f"OPEN QUESTION IN THE CONVERSATION: {reflection}"
                )

        # 3. Emotional guidance (translated from tone band)
        if artifact:
            tone = artifact.get("tone_estimate", 2.5)
            band = artifact.get("active_tone_band", "engagement")
            sections.append(self._tone_guidance(tone, band))

        # 4. Ritual guidance
        ritual_note = self._ritual_guidance(ritual, ritual_phase)
        if ritual_note:
            sections.append(ritual_note)

        # 5. Relevant memories (already filtered by companion)
        if memories:
            mem_lines = "\n".join(f"  - {m}" for m in memories[:5])
            sections.append(
                f"RELEVANT CONTEXT FROM USER'S MEMORY:\n{mem_lines}"
            )

        # 6. Builder completion instruction
        sections.append(
            "COMPLETION REQUIREMENT: When your work is done, you MUST call "
            "emit_builder_artifact as your final action. This carries your "
            "completion metadata back to the companion. Without it, the "
            "companion cannot properly present your work to the user."
        )

        # Compose
        briefing = "\n\n".join(sections)

        injection = f"""
<builder_briefing>
{briefing}

You share Sophia's values (soul.md is loaded). The companion will
re-express your result to the user in Sophia's voice — focus on the
quality of the deliverable, not on emotional language or phrasing.
Execute well. The companion handles expression.
</builder_briefing>
"""

        state["system_prompt_additions"] = \
            state.get("system_prompt_additions", "") + injection

        return state
```

---

## 4. Builder → Companion: The Builder Artifact

### 4.1 emit_builder_artifact Tool

This is the builder's counterpart to `emit_artifact`. Same pattern: deterministic tool call, guaranteed valid JSON via Pydantic schema, called as the final action of every build.

```python
# backend/src/sophia/tools/emit_builder_artifact.py

from typing import Literal
from pydantic import BaseModel, Field
from langchain_core.tools import tool


class BuilderArtifactInput(BaseModel):
    # --- What was built ---
    artifact_path: str = Field(
        description="Primary output file path in the sandbox. "
                    "e.g., 'outputs/investor_deck.pptx'"
    )
    artifact_type: Literal[
        "presentation", "document", "webpage", "research_report",
        "visual_report", "code", "data_analysis"
    ] = Field(
        description="Type of deliverable created."
    )
    artifact_title: str = Field(
        description="Human-readable title. "
                    "e.g., 'Q1 Growth Investor Deck'"
    )
    supporting_files: list[str] | None = Field(
        default=None,
        description="Any additional files created (images, data files, "
                    "supporting documents). List of paths."
    )

    # --- What happened during building ---
    steps_completed: int = Field(
        description="Number of major steps executed."
    )
    decisions_made: list[str] = Field(
        description="2-4 key decisions made during building. "
                    "These help the companion explain the work. "
                    "e.g., ['Focused on growth metrics over profitability', "
                    "'Used 5 slides instead of 8 for clarity']"
    )
    sources_used: list[str] | None = Field(
        default=None,
        description="External sources consulted, if any. "
                    "URLs or short descriptions."
    )

    # --- Companion synthesis guidance ---
    companion_summary: str = Field(
        description="One sentence describing what was built, written FOR "
                    "the companion to paraphrase in Sophia's voice. "
                    "Be specific about the deliverable, not the process. "
                    "e.g., 'A clean 5-slide investor deck built around "
                    "Q1 growth with confident visuals and no filler.'"
    )
    companion_tone_hint: str = Field(
        description="How the companion should present this result, "
                    "considering the user's emotional state from the briefing. "
                    "e.g., 'Reassuring — the user was stressed, so emphasize "
                    "that the hard part is done and the deck is ready to go.'"
    )
    user_next_action: str | None = Field(
        default=None,
        description="What the user should do with this deliverable, if anything. "
                    "e.g., 'Review slide 3 — the revenue projection uses last "
                    "quarter's numbers, they may want to update the Q2 target.' "
                    "Null if the deliverable is complete and ready to use."
    )

    # --- Quality signal (for GEPA traces) ---
    confidence: float = Field(
        ge=0.0, le=1.0,
        description="Self-assessed confidence in the deliverable quality. "
                    "0.0 = uncertain/incomplete, 1.0 = fully confident."
    )


@tool(args_schema=BuilderArtifactInput)
def emit_builder_artifact(**kwargs) -> str:
    """
    REQUIRED: Call this as your FINAL action after completing the build task.
    This carries your completion metadata back to the companion agent.
    The companion uses this to present the result to the user in Sophia's
    voice. Without this call, the companion has no structured data to work with.
    """
    return json.dumps(kwargs)
```

### 4.2 Why the Tool Returns json.dumps(kwargs)

Unlike `emit_artifact` (which returns a static string because the companion's ArtifactMiddleware reads it from state), the builder artifact needs to travel back through the `task()` return path. DeerFlow's `task()` mechanism returns the last tool call result from the subagent as the tool result message in the parent graph. By returning the full JSON, the companion receives the structured data directly in the `switch_to_builder` tool result.

---

## 5. BuilderArtifactMiddleware — After-Phase Processing

### 5.1 Position in Builder Chain

Position 7 of 8 (last active middleware). After-phase only. Reads the `emit_builder_artifact` tool call result and stores it in state for the `task()` return path.

### 5.2 Implementation

```python
# backend/src/agents/sophia_agent/middlewares/builder_artifact.py

import json
import logging
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger(__name__)


class BuilderArtifactMiddleware:
    """
    Last active middleware in the builder chain. After-phase only.
    Reads the emit_builder_artifact tool call and packages the result
    into builder_result for the task() return path.

    This is the symmetric counterpart to the companion's ArtifactMiddleware.
    """

    async def after(self, state: dict, config: RunnableConfig) -> dict:
        builder_artifact = None

        # Scan messages in reverse for the builder artifact
        for msg in reversed(state.get("messages", [])):
            if (hasattr(msg, "name")
                    and msg.name == "emit_builder_artifact"):
                try:
                    builder_artifact = json.loads(msg.content)
                except (json.JSONDecodeError, TypeError):
                    logger.warning(
                        "Failed to parse emit_builder_artifact content"
                    )
                break

        if builder_artifact:
            state["builder_result"] = builder_artifact
            logger.info(
                "Builder artifact captured: type=%s, confidence=%.2f",
                builder_artifact.get("artifact_type"),
                builder_artifact.get("confidence", 0),
            )
        else:
            # Builder didn't emit artifact — create a minimal fallback
            # so the companion always has structured data to work with
            logger.warning(
                "Builder completed without emitting builder artifact. "
                "Using fallback."
            )
            state["builder_result"] = {
                "artifact_path": None,
                "artifact_type": "unknown",
                "artifact_title": "Build task completed",
                "steps_completed": 0,
                "decisions_made": [],
                "companion_summary": "The build task was completed.",
                "companion_tone_hint": "Neutral — no builder context available.",
                "user_next_action": None,
                "confidence": 0.3,
            }

        return state
```

---

## 6. Revised Builder Middleware Chain

8 middlewares in strict order.

```python
# backend/src/agents/sophia_agent/builder_agent.py

def make_sophia_builder(config: RunnableConfig):
    user_id = config.get("configurable", {}).get("user_id")

    middlewares = [
        # 1. Infrastructure — shares thread with companion
        ThreadDataMiddleware(),

        # 2. Sandbox — builder's core execution capability
        SandboxMiddleware(),

        # 3. Values — soul.md only (voice.md not needed, builder doesn't speak)
        FileInjectionMiddleware(SKILLS_PATH / "soul.md"),

        # 4. User personalization — identity file shapes what builder creates
        UserIdentityMiddleware(user_id),

        # 5. Task briefing — translates companion artifact into builder guidance
        #    Depends on: soul.md loaded (3), identity loaded (4)
        BuilderTaskMiddleware(),

        # 6. Planning — DeerFlow's TodoList in always-plan mode
        TodoListMiddleware(),

        # 7. Builder artifact capture — after-phase reads emit_builder_artifact
        BuilderArtifactMiddleware(),

        # 8. TitleMiddleware — SKIPPED (subagents don't get titles)
    ]

    tools = [
        bash_tool,
        ls_tool,
        read_file_tool,
        write_file_tool,
        str_replace_tool,
        builder_web_search,   # guarded builder-only web search
        builder_web_fetch,    # exact-URL fetch for approved sources only
        present_file_tool,
        emit_builder_artifact,      # REQUIRED as final action
    ]

    return create_sophia_builder(
        model=get_model("claude-sonnet-4-6"),
        middlewares=middlewares,
        tools=tools,
        config=config,
    )
```

---

## 7. During Build: Companion-User Interaction

This section specifies what happens in the conversation while the builder works asynchronously. The companion must stay present and emotionally calibrated — the user should feel Sophia is WITH them, not that they've been transferred to a machine.

### 7.1 Delegation Response (Immediate)

When `switch_to_builder` fires, the companion produces a spoken response BEFORE the builder starts. This response must:

1. **Acknowledge the task** — confirm what will be built
2. **Match the user's tone band** — follow the half-band rule from tone_skills.md
3. **Set expectations** — brief, honest estimate of scope
4. **Emit a regular `emit_artifact`** — the turn still produces a companion artifact

The delegation response adapts to the user's current tone band:

**Band 1 (shutdown/grief/fear) — Pure presence, minimal:**
> "I'll take care of it."

No details, no estimated time, no enthusiasm. The user doesn't have the energy to process logistics. Just do it.

**Band 2 (anger/struggle) — Direct, competent:**
> "On it. I'll put together a clean deck — you won't need to fuss with it."

Match their need for something to be HANDLED. The response should feel like relief.

**Band 3 (processing/boredom) — Informative, steady:**
> "I'll build that out for you. Give me a few minutes — I'll let you know when it's ready."

They can handle information. Keep it factual.

**Band 4 (engagement/momentum) — Matched energy, collaborative:**
> "Great idea. Let me put that together — I'll focus on the growth story since that's what landed with them. Back in a few."

They have context and energy. Reflect the specifics back to show you understood.

**Band 5 (enthusiasm/flow) — Ride the wave:**
> "Hell yes. Let me build something that matches this energy. Give me a few minutes."

Don't slow them down. Match their pace.

### 7.2 The `emit_artifact` on the Delegation Turn

The companion's artifact on the delegation turn captures the handoff:

```json
{
    "session_goal": "Investor pitch preparation",
    "active_goal": "Delegated deck creation to builder",
    "next_step": "Wait for builder completion, then present result",
    "takeaway": "User needs this handled — stressed about tomorrow",
    "reflection": null,
    "tone_estimate": 1.4,
    "tone_target": 1.9,
    "active_tone_band": "grief_fear",
    "skill_loaded": "active_listening",
    "ritual_phase": "prepare.pitch_materials",
    "voice_emotion_primary": "reassuring",
    "voice_emotion_secondary": "calm",
    "voice_speed": "gentle"
}
```

This artifact is logged in traces, so GEPA can later analyze which delegation-turn responses produce the best tone_delta.

### 7.3 Progress Updates During Build

DeerFlow's `task()` mechanism emits SSE events during execution:
- `task_started` — builder has begun
- `task_running` — builder is executing (may include step info)
- `task_completed` / `task_failed` / `task_timed_out` — terminal states

The companion should relay selected events as natural check-ins. Not every event — that would be noisy. The rules:

**When to relay progress:**
- After 30+ seconds of silence (user hasn't spoken, builder still running)
- When the builder transitions between major phases (plan → execute → review)
- Never more than once per 45 seconds
- Never interrupt the user if they're speaking or typing

**Progress message style by tone band:**

| Band | Style | Example |
|------|-------|---------|
| 1 | Silent. Don't update unless asked. | *(no message)* |
| 2 | Minimal, competent | "Still on it." |
| 3 | Informative | "About halfway through — pulling the numbers together now." |
| 4 | Collaborative | "Looking good so far. I'm on the narrative section now." |
| 5 | Energetic | "This is coming together nicely. Almost there." |

**Implementation:** The SophiaLLM plugin monitors `task_running` SSE events and, based on the last known `active_tone_band` from the companion artifact, either suppresses or relays them. Progress messages are generated by a lightweight prompt (not the full middleware chain) to keep latency low.

```python
# voice/sophia_llm.py — progress relay during builder execution

PROGRESS_PROMPT = """You are Sophia. The builder is working on a task.
Generate a brief, natural progress update. One sentence maximum.
Current emotional register: {tone_band}
Band 1: Say nothing (return empty string).
Band 2: Ultra-brief. "Still on it." or "Almost there."
Band 3: Light info. Include what phase the builder is in.
Band 4-5: Warmer, can include specifics.
Builder status: {status}
"""
```

### 7.4 Conversation Continues During Build

The user can keep talking to the companion while the builder works. The companion stays fully active — all 14 middlewares fire normally on user messages. The builder runs in a background thread via DeerFlow's SubagentExecutor (dual thread pool: `_scheduler_pool` + `_execution_pool`).

**State management:** `SophiaState["active_mode"]` is set to `"builder"` during the build. The companion's middlewares can check this to adapt:

- `SkillRouterMiddleware` — can factor in that the user is waiting for a deliverable
- `ToneGuidanceMiddleware` — no change (tone is read from the user's messages as always)
- `ArtifactMiddleware` — companion artifacts still emit normally on every turn

**If the user asks about the build:** The companion can check `SophiaState["builder_task"]` for the current status and respond naturally.

**If the user changes the subject:** Fine. The companion follows the user's lead. The builder keeps working independently.

**If the user asks to cancel:** The companion calls `cancel_builder_task()` which invokes DeerFlow's run cancellation. The companion acknowledges: "Stopped. We can always come back to it."

### 7.5 Builder Failure Handling

If the builder fails (`task_failed` or `task_timed_out`), the companion needs to handle it gracefully. The tone band determines how:

| Band | Response |
|------|----------|
| 1 | "That didn't come together. It's okay — we can try again when you're ready." |
| 2 | "Hit a wall on that one. Want me to try again, or should we take a different approach?" |
| 3-4 | "The build ran into some trouble. Here's what happened: {error_summary}. Want me to retry with a different approach?" |
| 5 | "Didn't quite land. Let me take another shot — I think I know what went wrong." |

The companion's artifact on a failure turn logs the failure for GEPA traces.

---

## 8. Companion Synthesis: Presenting the Builder's Result

### 8.1 The Synthesis Turn

When the builder completes successfully, the `switch_to_builder` tool returns the builder artifact JSON as its tool result. The companion then gets a synthesis turn — a fresh LLM call where it must present the result to the user in Sophia's voice.

### 8.2 Synthesis Prompt Injection

The companion's prompt assembly detects `builder_result` in state and injects a synthesis block. This is NOT a separate middleware — it's an addition to the existing `ArtifactMiddleware` before-phase on the turn following builder completion.

```python
# Addition to ArtifactMiddleware.before() — synthesis injection

async def before(self, state: dict, config: RunnableConfig) -> dict:
    # ... existing artifact injection logic ...

    # If builder just completed, inject synthesis guidance
    builder_result = state.get("builder_result")
    if builder_result and state.get("builder_task", {}).get("status") == "completed":
        synthesis = self._build_synthesis_prompt(builder_result, state)
        state["system_prompt_additions"] = \
            state.get("system_prompt_additions", "") + synthesis

        # Clear builder state after injection so it doesn't repeat
        state["builder_task"]["status"] = "synthesized"

    return state

def _build_synthesis_prompt(self, builder: dict, state: dict) -> str:
    """
    Build the synthesis prompt that guides the companion's
    presentation of the builder's result.
    """
    tone_band = state.get("active_tone_band", "engagement")

    # Tone-adapted synthesis instructions
    tone_instructions = {
        "shutdown": (
            "The user is in a very low state. Keep your presentation "
            "of the result ultra-brief. Don't list what was done. "
            "Just tell them it's ready and offer to show them when "
            "they want. No pressure. No details unless they ask."
        ),
        "grief_fear": (
            "The user is carrying weight. Present the result as something "
            "that's been taken care of — emphasize that the hard part is done. "
            "Be warm and brief. One or two sentences about what was built, "
            "then offer the file. Don't enumerate decisions or steps."
        ),
        "anger_antagonism": (
            "The user was frustrated. Present the result as forward motion — "
            "something concrete that shifts the situation. Be direct. "
            "'Here's what I built. It does X.' If there's a next action, "
            "state it clearly. No fluff."
        ),
        "engagement": (
            "The user has energy. You can give more detail about what was "
            "built and why. Mention 1-2 key decisions if they're interesting. "
            "If there's a next action, frame it as a collaboration point. "
            "The user can handle nuance here."
        ),
        "enthusiasm": (
            "The user is in a high state. Match that energy. Present the result "
            "with confidence. If the builder added a surprise element, highlight it. "
            "Let the user ride the momentum. Don't slow them down with caveats."
        ),
    }

    instruction = tone_instructions.get(tone_band, tone_instructions["engagement"])

    # Compose the prompt
    parts = [
        "<builder_completed>",
        f"WHAT WAS BUILT: {builder.get('companion_summary', 'Task completed.')}",
        f"DELIVERABLE: {builder.get('artifact_title', 'Untitled')} "
        f"({builder.get('artifact_type', 'file')})",
    ]

    decisions = builder.get("decisions_made", [])
    if decisions:
        decisions_text = "; ".join(decisions)
        parts.append(f"KEY DECISIONS: {decisions_text}")

    tone_hint = builder.get("companion_tone_hint", "")
    if tone_hint:
        parts.append(f"BUILDER'S SUGGESTION FOR PRESENTATION: {tone_hint}")

    next_action = builder.get("user_next_action")
    if next_action:
        parts.append(f"USER'S NEXT STEP: {next_action}")

    parts.append(f"\nHOW TO PRESENT THIS:\n{instruction}")

    parts.append(
        "\nExpress this result naturally in your voice. Do not list the "
        "decisions mechanically — weave the important ones into your "
        "response only if the user's tone band allows for detail. "
        "The user should feel this was done WITH care, not BY a machine."
    )

    parts.append("</builder_completed>")

    return "\n".join(parts)
```

### 8.3 Example Synthesis Responses by Band

**Band 1 (shutdown/grief/fear):**

Builder artifact:
```json
{
    "companion_summary": "A clean 5-slide investor deck focused on Q1 growth.",
    "companion_tone_hint": "Reassuring — user is stressed about tomorrow's pitch.",
    "user_next_action": "Review slide 3's revenue projection."
}
```

Sophia's synthesis:
> "Your deck is ready. Five slides, clean and focused. It's there when you want to look at it."

No mention of slide 3, no decisions, no details. Just: it's done, it's there, no pressure.

---

**Band 2 (anger/struggle):**

Same builder artifact. Sophia's synthesis:
> "Done. Five slides, focused on growth — no filler. Take a look at slide three when you get a chance, the revenue projection might need your latest Q2 number."

Direct, competent, actionable. The user feels it's been handled.

---

**Band 4 (engagement/momentum):**

Same builder artifact. Sophia's synthesis:
> "Your deck is ready — five slides, built around the growth story. I went with growth over profitability since that's what landed with them last time. Slide three has the revenue projection — I used last quarter's actuals but you might want to swap in your Q2 target. Want to walk through it?"

More detail, collaborative, invites engagement. The user has the energy for it.

---

**Band 5 (enthusiasm/flow):**

Same builder artifact. Sophia's synthesis:
> "Done. And honestly, it came together well. Five tight slides — the growth narrative is front and center. I think slide four might surprise you. Take a look."

Confident, match the energy, tease the surprise element.

---

## 9. GEPA Trace for Builder Handoffs

### 9.1 Trace Entry Schema

Every builder handoff produces a trace entry that captures the full cycle: delegation → build → synthesis → user reaction.

```python
# In trace logging, when a builder handoff occurs

builder_handoff_trace = {
    "turn_type": "builder_handoff",
    "timestamp": datetime.utcnow().isoformat(),

    # Delegation context
    "delegation_tone_band": companion_artifact["active_tone_band"],
    "delegation_tone_estimate": companion_artifact["tone_estimate"],
    "delegation_ritual": active_ritual,
    "delegation_task_type": task_type,

    # Builder execution
    "builder_confidence": builder_artifact["confidence"],
    "builder_artifact_type": builder_artifact["artifact_type"],
    "builder_steps_completed": builder_artifact["steps_completed"],
    "builder_decisions_count": len(builder_artifact["decisions_made"]),
    "builder_had_next_action": builder_artifact["user_next_action"] is not None,
    "builder_duration_seconds": duration,

    # Synthesis result (from the companion's synthesis-turn artifact)
    "synthesis_tone_before": delegation_tone_estimate,
    "synthesis_tone_after": synthesis_artifact["tone_estimate"],
    "synthesis_tone_delta": synthesis_artifact["tone_estimate"] - delegation_tone_estimate,
    "synthesis_voice_emotion": synthesis_artifact["voice_emotion_primary"],

    # Quality signals
    "user_engaged_after": did_user_respond_to_synthesis,
    "user_asked_for_changes": did_user_request_edits,
}
```

### 9.2 GEPA Optimization Targets

Over time, the following can be optimized:

1. **BuilderTaskMiddleware tone guidance text** — which phrasings produce higher builder confidence and better user tone_delta on synthesis?
2. **Synthesis prompt instructions per band** — which presentation styles produce the best tone_delta for each band?
3. **Progress update frequency** — does more or fewer updates correlate with better post-build tone_delta?
4. **Delegation response style** — which acknowledgment patterns correlate with the user staying in conversation vs. going silent during the build?

---

## 10. Token Budget Impact

### 10.1 Builder Prompt Additions

| Component | Tokens | Notes |
|-----------|--------|-------|
| soul.md | ~450 | Always loaded |
| User identity | ~650 | When file exists |
| Builder briefing (BuilderTaskMiddleware) | ~350-500 | Varies by tone band + ritual |
| emit_builder_artifact schema | ~300 | Tool definition |
| **Builder total additions** | **~1,750-1,900** | On top of DeerFlow's base prompt |

### 10.2 Companion Synthesis Prompt Additions

| Component | Tokens | Notes |
|-----------|--------|-------|
| `<builder_completed>` block | ~200-350 | Varies by decisions count |
| Tone-adapted instructions | ~80-120 | One band's instructions |
| **Synthesis total** | **~280-470** | Added to normal companion prompt on synthesis turn only |

Both are well within budget. The builder runs on Claude Sonnet with a 200k context window, and the synthesis block is a small addition to the companion's ~9,100 token peak.

---

## 11. Complete Flow Diagram

```
USER: "Make me a deck for tomorrow's pitch"
 │
 ├─ Companion (Loop A) ────────────────────────────────────────────
 │   14 middlewares fire normally
 │   emit_artifact captures: tone=1.4, band=grief_fear,
 │     session_goal="Investor pitch prep", ritual=prepare
 │
 │   LLM calls switch_to_builder(task="...", task_type="presentation")
 │     → Packages: companion_artifact + identity + memories + ritual
 │     → Sets state: active_mode="builder", builder_task.status="started"
 │
 │   Companion responds: "I'll take care of it."
 │     → emit_artifact: active_goal="Delegated deck to builder"
 │     → voice_emotion: "reassuring", speed: "gentle"
 │
 ├─ Builder (Loop B) ──────── runs asynchronously ─────────────────
 │   8 middlewares fire:
 │     ThreadData → Sandbox → soul.md → UserIdentity
 │     → BuilderTaskMiddleware translates artifact to guidance:
 │       "User is Band 1-2, grief_fear. Keep it simple."
 │       "RITUAL: User is PREPARING. Output = armor, not homework."
 │     → TodoList (plan mode)
 │     → [builder executes: plan → research → create → review]
 │     → emit_builder_artifact (FINAL action):
 │       companion_summary, tone_hint, decisions, next_action
 │     → BuilderArtifactMiddleware captures result
 │
 ├─ During Build ──────────────────────────────────────────────────
 │   Companion stays fully active (14 middlewares on user messages)
 │   User can keep talking — companion follows their lead
 │   Progress updates: tone-adapted, max 1 per 45s, skip for Band 1
 │   task_running SSE → "Still on it." (Band 2 example)
 │
 ├─ Builder Completes ─────────────────────────────────────────────
 │   task_completed SSE fires
 │   switch_to_builder returns builder_artifact JSON as tool result
 │   state: active_mode="companion", builder_task.status="completed"
 │
 ├─ Companion Synthesis Turn ──────────────────────────────────────
 │   ArtifactMiddleware.before() detects builder_result
 │   Injects <builder_completed> with tone-adapted instructions
 │   LLM produces synthesis response in Sophia's voice:
 │     "Your deck is ready. Five slides, clean and focused.
 │      It's there when you want to look at it."
 │   emit_artifact captures: tone_after, synthesis voice_emotion
 │   state: builder_task.status="synthesized"
 │
 └─ GEPA Trace ────────────────────────────────────────────────────
     Logs full cycle: delegation_tone → builder_confidence
       → synthesis_tone_delta → user_engaged_after
     Optimization targets: tone guidance text, synthesis instructions,
       progress frequency, delegation response style
```

---

## 12. Implementation Checklist

### Phase 1: Core Handoff 

- [ ] `emit_builder_artifact` tool — Pydantic schema, tool registration
- [ ] `BuilderTaskMiddleware` — tone guidance, ritual guidance, injection
- [ ] `BuilderArtifactMiddleware` — after-phase capture, fallback
- [ ] Revised `switch_to_builder` — full artifact passing, state management
- [ ] Builder middleware chain — 8 steps, correct order
- [ ] ArtifactMiddleware synthesis injection — `_build_synthesis_prompt()`
- [ ] **Test:** Full cycle — delegation → build → synthesis → correct voice

### Phase 2: During-Build Experience 

- [ ] Progress relay in SophiaLLM — tone-adapted, rate-limited
- [ ] Conversation-during-build — verify companion stays live
- [ ] Cancel support — `cancel_builder_task()` wired to DeerFlow run cancellation
- [ ] Failure handling — tone-adapted error responses
- [ ] **Test:** User talks during build → companion responds normally

### Phase 3: GEPA Integration 

- [ ] Builder handoff trace schema
- [ ] Trace logging in offline pipeline
- [ ] Dashboard: builder confidence vs synthesis tone_delta correlation
- [ ] First GEPA pass: optimize synthesis instructions per band

---

## 13. Files Created or Modified

| File | Action | Description |
|------|--------|-------------|
| `backend/src/sophia/tools/switch_to_builder.py` | **Modified** | Full artifact passing, state management |
| `backend/src/sophia/tools/emit_builder_artifact.py` | **New** | Builder completion artifact tool |
| `backend/src/agents/sophia_agent/middlewares/builder_task.py` | **New** | Translates companion artifact → builder guidance |
| `backend/src/agents/sophia_agent/middlewares/builder_artifact.py` | **New** | Captures builder artifact on completion |
| `backend/src/agents/sophia_agent/builder_agent.py` | **Modified** | 8-middleware chain, emit_builder_artifact in tools |
| `backend/src/agents/sophia_agent/middlewares/artifact.py` | **Modified** | Add synthesis injection in before-phase |
| `voice/sophia_llm.py` | **Modified** | Add progress relay during build |
| `backend/src/sophia/offline_pipeline.py` | **Modified** | Add builder handoff trace schema |
