"""retrieve_memories tool factory.

Targeted deep retrieval for reflect flow and specific memory queries.
Uses the Mem0 client for semantic search across memory categories.

The tool is created via make_retrieve_memories_tool(user_id) at agent
construction time, binding the actual user_id via closure.
"""

import logging

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class RetrieveMemoriesInput(BaseModel):
    query: str = Field(description="What to search for in memories.")
    categories: list[str] | None = Field(
        default=None,
        description="Optional category filter: fact, feeling, decision, lesson, commitment, preference, relationship, pattern, ritual_context",
    )


def make_retrieve_memories_tool(user_id: str) -> StructuredTool:
    """Create a retrieve_memories tool bound to a specific user_id.

    The user_id is captured via closure so the LLM-facing tool signature
    remains (query, categories) without exposing user_id as a parameter.
    """

    def _retrieve_memories(query: str, categories: list[str] | None = None) -> str:
        try:
            from deerflow.sophia.mem0_client import search_memories

            results = search_memories(
                user_id=user_id,
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

    return StructuredTool.from_function(
        func=_retrieve_memories,
        name="retrieve_memories",
        description=(
            "Search user memories for specific information. Use for reflect flow, "
            "answering questions about past sessions, or retrieving specific context. "
            "Returns relevant memories as a formatted list."
        ),
        args_schema=RetrieveMemoriesInput,
    )
