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


class BuilderArtifactFile(BaseModel):
    path: str = Field(description="File path under /mnt/user-data/outputs/.")
    role: Literal["primary", "source", "preview", "illustration_asset", "internal"] = Field(
        description="How the file should be surfaced. Only primary is user-downloadable by default; preview is for canvas rendering."
    )
    name: str | None = Field(default=None, description="Optional display filename.")


class BuilderArtifactInput(BaseModel):
    artifact_path: str = Field(
        description="Primary output file path. Prefer an absolute sandbox path under /mnt/user-data/outputs/ (e.g., '/mnt/user-data/outputs/investor_deck.pptx')."
    )
    artifact_type: Literal[
        "presentation",
        "document",
        "html",
        "pdf",
        "webpage",
        "research_report",
        "visual_report",
        "code",
        "data_analysis",
    ] = Field(description="Type of artifact produced.")
    artifact_title: str = Field(description="Human-readable title for the deliverable.")
    supporting_files: list[str] | None = Field(
        default=None,
        description="Legacy internal supporting files created alongside the primary artifact. Prefer artifact_files with roles for new payloads."
    )
    artifact_files: list[BuilderArtifactFile] | None = Field(
        default=None,
        description="Structured file metadata. Use role=primary for the requested deliverable, preview for render-only preview files, source/internal for non-user-facing support files."
    )
    steps_completed: int = Field(description="Number of major steps executed during building.")
    decisions_made: list[str] = Field(description="2-4 key decisions made during the build process.")
    sources_used: list[BuilderSourceReference | str] | None = Field(
        default=None,
        description="External sources consulted during building. Prefer structured {title, url} entries; legacy strings remain accepted.",
    )
    companion_summary: str = Field(description="One sentence for the companion to paraphrase in Sophia's voice.")
    companion_tone_hint: str = Field(description="How the companion should present the result given the user's emotional state.")
    user_next_action: str | None = Field(default=None, description="What the user should do with the deliverable.")
    source_artifact_path: str | None = Field(default=None, description="Optional original artifact path when this output revises a completed builder artifact.")
    revision_of_artifact_path: str | None = Field(default=None, description="Optional original artifact path that this output revises.")
    confidence: float = Field(ge=0.0, le=1.0, description="Self-assessed quality confidence (0.0-1.0).")
    brief_assumptions: list[str] | None = Field(
        default=None,
        description=(
            "Assumptions stated for brief fields not present in the parent "
            "conversation (Spec D D-5). Empty/omitted when the brief was "
            "complete or every gap was recovered via read_session_context."
        ),
    )


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
