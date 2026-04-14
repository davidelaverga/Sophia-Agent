"""The emit_builder_artifact tool — required on every builder turn completion.

Carries the builder's output metadata back through the task() return path.
Delivered as a tool_use call (never text parsing) to guarantee valid JSON.
"""

import json
from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field


class BuilderSourceReference(BaseModel):
    title: str = Field(description="Human-readable source title.")
    url: str = Field(description="Exact source URL used during research.")


class BuilderArtifactInput(BaseModel):
    artifact_path: str = Field(description="Primary output file path (e.g., 'outputs/investor_deck.pptx').")
    artifact_type: Literal[
        "presentation",
        "document",
        "webpage",
        "research_report",
        "visual_report",
        "code",
        "data_analysis",
    ] = Field(description="Type of artifact produced.")
    artifact_title: str = Field(description="Human-readable title for the deliverable.")
    supporting_files: list[str] | None = Field(default=None, description="Additional files created alongside the primary artifact.")
    steps_completed: int = Field(description="Number of major steps executed during building.")
    decisions_made: list[str] = Field(description="2-4 key decisions made during the build process.")
    sources_used: list[BuilderSourceReference | str] | None = Field(
        default=None,
        description="External sources consulted during building. Prefer structured {title, url} entries; legacy strings remain accepted.",
    )
    companion_summary: str = Field(description="One sentence for the companion to paraphrase in Sophia's voice.")
    companion_tone_hint: str = Field(description="How the companion should present the result given the user's emotional state.")
    user_next_action: str | None = Field(default=None, description="What the user should do with the deliverable.")
    confidence: float = Field(ge=0.0, le=1.0, description="Self-assessed quality confidence (0.0-1.0).")


@tool(args_schema=BuilderArtifactInput, return_direct=True)
def emit_builder_artifact(**kwargs) -> str:
    """REQUIRED when the builder finishes its task. Call this ONCE with the build
    results. The JSON payload travels back through the task() return path so the
    companion can relay the outcome to the user in Sophia's voice.
    IMPORTANT: Call this exactly once per build. After calling, do NOT call any more tools.
    Your build is complete after this tool call."""
    serializable = {
        key: [item.model_dump() if hasattr(item, "model_dump") else item for item in value]
        if isinstance(value, list)
        else value.model_dump()
        if hasattr(value, "model_dump")
        else value
        for key, value in kwargs.items()
    }
    return json.dumps(serializable)
