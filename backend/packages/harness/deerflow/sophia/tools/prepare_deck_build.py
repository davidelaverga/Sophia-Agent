"""Model-facing P-1 deck build tool."""

from __future__ import annotations

import json
from typing import Any

from langchain.tools import ToolRuntime, tool

from deerflow.sophia.deck_build.ir_repair import deck_ir_repair_instruction_from_failure
from deerflow.sophia.deck_build.service import DeckBuildService


@tool("prepare_deck_build", parse_docstring=True)
def prepare_deck_build(
    runtime: ToolRuntime,
    deck_title: str,
    slides: list[dict[str, Any]],
    output_path: str,
    register: str = "professional_technical",
    visual_policy: str = "required",
    style_profile: dict[str, Any] | None = None,
) -> str:
    """Build a fresh PPTX deck from slide intent.

    Args:
        deck_title: Human-readable deck title.
        slides: Ordered slide intent dictionaries with title, narrative, role,
            layout_kind, visual_prompt, and optional speaker_notes.
        output_path: Absolute /mnt/user-data/outputs/*.pptx output path.
        register: Deck register such as professional_technical or executive.
        visual_policy: required for normal decks, text_only for explicit
            plain/no-visual deck requests.
        style_profile: Optional shared deck style profile.
    """
    result = DeckBuildService().prepare_and_build(
        runtime=runtime,
        deck_title=deck_title,
        slides=slides,
        output_path=output_path,
        register=register,
        visual_policy=visual_policy,
        style_profile=style_profile,
    )
    payload = result.to_dict()
    if payload.get("repair_instruction") is None:
        payload.pop("repair_instruction", None)
    if result.success is False and result.retryable:
        instruction = deck_ir_repair_instruction_from_failure(
            failure_code=result.failure_code or "",
            failure_summary=result.failure_summary or "",
            retryable=result.retryable,
            attempt_count=0,
        )
        if instruction.should_retry:
            payload["repair_instruction"] = instruction.to_dict()
    return json.dumps(payload)
