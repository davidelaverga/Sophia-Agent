from typing import NotRequired, TypedDict

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

    # Prompt assembly — built fresh each middleware pass, assembled in before_model
    # NOTE: No additive reducer. Each middleware pass rebuilds this list from scratch.
    # Using operator.add would cause unbounded growth across agent loop iterations.
    system_prompt_blocks: NotRequired[list[str]]

    # Title
    title: NotRequired[str | None]
