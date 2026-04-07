import operator
from typing import Annotated, NotRequired

from langchain.agents import AgentState


class SophiaState(AgentState):
    """State schema for the Sophia companion agent.

    Extends AgentState (which provides `messages`) with companion-specific
    fields for platform, tone, skills, rituals, memory, and artifacts.
    """

    # Platform and mode
    platform: NotRequired[str]  # "voice" | "text" | "ios_voice"
    active_mode: NotRequired[str]  # "companion" | "builder"
    turn_count: NotRequired[int]

    # User context
    user_id: NotRequired[str]
    context_mode: NotRequired[str]  # "work" | "gaming" | "life"

    # Ritual state
    active_ritual: NotRequired[str | None]  # "prepare" | "debrief" | "vent" | "reset" | None
    ritual_phase: NotRequired[str | None]

    # Crisis fast-path
    force_skill: NotRequired[str | None]
    skip_expensive: NotRequired[bool]

    # Tone and skill
    active_tone_band: NotRequired[str]
    active_skill: NotRequired[str]
    skill_session_data: NotRequired[dict]

    # Artifacts
    current_artifact: NotRequired[dict | None]
    previous_artifact: NotRequired[dict | None]

    # Memory
    injected_memories: NotRequired[list[str]]

    # Builder
    builder_task: NotRequired[dict | None]
    builder_result: NotRequired[dict | None]
    delegation_context: NotRequired[dict | None]

    # Prompt assembly — accumulated by middlewares in before_agent, assembled in before_model.
    # NOTE: operator.add is kept here for documentation purposes (it signals "append"
    # semantics), but the LangGraph middleware framework uses dict merge (last-write-wins)
    # for middleware return values — it does NOT apply the channel reducer from the state
    # schema.  Therefore each middleware explicitly reads the existing list from state and
    # extends it before returning.  This is the only correct way to accumulate blocks
    # across the middleware chain.
    system_prompt_blocks: Annotated[list[str], operator.add]

    # Title
    title: NotRequired[str | None]
