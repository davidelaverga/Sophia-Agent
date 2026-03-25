"""retrieve_memories tool.

Targeted deep retrieval for reflect flow and specific memory queries.
Uses the Mem0 client for semantic search across memory categories.
"""

import logging

from langchain_core.tools import tool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class RetrieveMemoriesInput(BaseModel):
    query: str = Field(description="What to search for in memories.")
    categories: list[str] | None = Field(
        default=None,
        description="Optional category filter: fact, feeling, decision, lesson, commitment, preference, relationship, pattern, ritual_context",
    )


@tool(args_schema=RetrieveMemoriesInput)
def retrieve_memories(query: str, categories: list[str] | None = None) -> str:
    """Search user memories for specific information. Use for reflect flow,
    answering questions about past sessions, or retrieving specific context.
    Returns relevant memories as a formatted list."""
    try:
        from deerflow.sophia.mem0_client import search_memories

        results = search_memories(
            user_id="default_user",  # Will be injected via runtime context
            query=query,
            categories=categories or [],
        )

        if not results:
            return "No relevant memories found."

        lines = []
        for mem in results[:15]:
            lines.append(f"- {mem.get('content', '')}")

        return "\n".join(lines)

    except Exception:
        logger.warning("Memory retrieval failed", exc_info=True)
        return "Memory retrieval temporarily unavailable."
