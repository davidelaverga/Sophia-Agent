from typing import NotRequired

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
    injected_memory_contents: NotRequired[list[str]]

    # Builder
    builder_task: NotRequired[dict | None]
    builder_result: NotRequired[dict | None]
    delegation_context: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]
    builder_allowed_urls: NotRequired[list[str]]
    builder_search_sources: NotRequired[list[dict]]
    builder_web_budget: NotRequired[dict]
    allow_web_research: NotRequired[bool]
    explicit_user_urls: NotRequired[list[str]]

    # Planning
    todos: NotRequired[list | None]

    # Prompt assembly — accumulated manually by before_agent middlewares for the current turn
    # only, then assembled in PromptAssemblyMiddleware before the model call. This must not
    # use an additive reducer because each middleware already extends the list explicitly.
    system_prompt_blocks: NotRequired[list[str]]

    # Title
    title: NotRequired[str | None]
