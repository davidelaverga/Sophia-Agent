"""retrieve_memories tool factory.

Targeted deep retrieval for reflect flow and specific memory queries.
Uses the Mem0 client for semantic search across memory categories.

The tool is created via make_retrieve_memories_tool(user_id) at agent
construction time, binding the actual user_id via closure.
"""

import logging

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from deerflow.sophia.tools.retrieve_memories_contract import (
    retrieve_memories_for_text_companion,
)

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

    def _retrieve_memories(query: str, categories: list[str] | None = None) -> tuple[str, dict | None]:
        try:
            from deerflow.sophia.memory_governance.flags import memory_feature_flags_for_owner
            if memory_feature_flags_for_owner(user_id).canonical_pool_read:
                from deerflow.sophia.mem0_client import search_memories_with_diagnostics
                from deerflow.sophia.memory_governance.retrieval_provenance import RETRIEVAL_PROOF_KEY, verify_retrieval_proof
                from deerflow.sophia.tools.retrieve_memories_contract import sanitize_retrieve_memories_query
                clean_query, _ = sanitize_retrieve_memories_query(query)
                if not clean_query:
                    return "No relevant memories found.", None
                result = search_memories_with_diagnostics(user_id=user_id, query=clean_query, categories=categories or [],
                    limit=15, log_content_previews=False, caller="text_explicit_retrieve_memories")
                rows = result["memories"]
                if not rows:
                    return ("No relevant memories found." if result.get("provider_status") == "ok" else "Memory retrieval temporarily unavailable."), None
                text = "\n".join("- " + item["content"] for item in rows)
                proof = rows[0].get(RETRIEVAL_PROOF_KEY)
                if verify_retrieval_proof(owner_id=user_id, proof=proof, rendered_text=text) is None:
                    return "Memory retrieval temporarily unavailable.", None
                return text, {RETRIEVAL_PROOF_KEY: proof}
            return retrieve_memories_for_text_companion(
                user_id=user_id,
                query=query,
                categories=categories or [],
            ), None
        except Exception:
            logger.warning("Memory retrieval failed ownerExcluded=true contentExcluded=true")
            return "Memory retrieval temporarily unavailable.", None

    return StructuredTool.from_function(
        func=_retrieve_memories,
        name="retrieve_memories",
        description=(
            "Search user memories for specific information. Use for reflect flow, "
            "answering questions about past sessions, or retrieving specific context. "
            "Returns relevant memories as a formatted list."
        ),
        args_schema=RetrieveMemoriesInput,
        response_format="content_and_artifact",
    )
