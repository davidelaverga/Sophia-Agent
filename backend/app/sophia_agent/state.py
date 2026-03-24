"""SophiaState — TypedDict for the sophia_companion graph.

All middleware reads and writes go through this state schema.
Key fields documented in CLAUDE.md § SophiaState.
"""

from __future__ import annotations

from typing import Annotated

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict


class SophiaState(TypedDict):
    """Full state schema for the Sophia companion agent."""

    # ── Core messages ──
    messages: Annotated[list[BaseMessage], add_messages]

    # ── Platform and mode ──
    platform: str  # "voice" | "text" | "ios_voice"
    active_mode: str  # "companion" | "builder"
    turn_count: int  # first-turn logic gates on this

    # ── User context ──
    user_id: str
    context_mode: str  # "work" | "gaming" | "life"

    # ── Ritual ──
    active_ritual: str | None  # "prepare" | "debrief" | "vent" | "reset" | None
    ritual_phase: str | None  # e.g. "debrief.step2_what_worked"

    # ── Crisis ──
    force_skill: str | None  # set by CrisisCheckMiddleware
    skip_expensive: bool  # True = crisis path, most middlewares skip

    # ── Tone and skill ──
    active_tone_band: str  # band_id from tone_guidance
    active_skill: str  # skill name selected by SkillRouter
    skill_session_data: dict  # cross-turn counters (persisted via LangGraph checkpointer)

    # ── Artifacts ──
    current_artifact: dict | None
    previous_artifact: dict | None

    # ── Memory ──
    injected_memories: list[str]  # memory IDs for trace logging

    # ── Builder ──
    builder_task: dict | None
    builder_result: dict | None

    # ── Prompt assembly (populated by middlewares) ──
    system_prompt_blocks: list[str]  # ordered list of system prompt sections
