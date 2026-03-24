"""retrieve_memories — targeted deep retrieval from Mem0.

Used for reflect flow and specific user queries about past sessions.
This is the active retrieval tool — Mem0MemoryMiddleware handles
passive per-turn injection.
"""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field


class MemoryQueryInput(BaseModel):
    """Schema for the retrieve_memories tool call."""

    query: str = Field(description="What to search for in the user's memory.")
    categories: list[str] | None = Field(
        default=None,
        description="Optional category filter: fact, feeling, decision, lesson, commitment, preference, relationship, pattern, ritual_context",
    )
    period: str | None = Field(
        default=None,
        description="Optional time filter: this_week, this_month, overall",
    )


@tool(args_schema=MemoryQueryInput)
def retrieve_memories(**kwargs) -> str:
    """Search the user's memory for specific information.

    Use this for reflect flows or when the user asks about past sessions.
    Per-turn memory injection is handled automatically by the middleware.
    """
    # TODO(jorge): Wire up mem0_client.search() with category and time filters.
    return "No memories found yet."
