"""switch_to_builder — delegates to sophia_builder (lead_agent) via task().

Companion asks all clarifying questions first, then calls switch_to_builder
with complete specs. Builder cannot interrupt the parent graph for
clarification. Companion stays live and relays progress.
"""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field


class BuilderTaskInput(BaseModel):
    """Schema for the switch_to_builder tool call."""

    task_description: str = Field(description="Complete description of what to build. Include all details gathered from clarifying questions.")
    file_type: str | None = Field(default=None, description="Expected output file type if applicable.")
    constraints: str | None = Field(default=None, description="Any constraints or requirements for the build.")


@tool(args_schema=BuilderTaskInput)
def switch_to_builder(**kwargs) -> str:
    """Delegate a build task to sophia_builder (DeerFlow lead_agent).

    IMPORTANT: Ask all clarifying questions BEFORE calling this tool.
    The builder cannot ask follow-up questions.
    The companion stays live while the builder works asynchronously.
    """
    # TODO(jorge): Wire up task() invocation to lead_agent subgraph.
    return "Builder task submitted."
