"""Discard prior transient memory admissions before a fresh governed lookup.

This is not a checkpoint/history or per-model revocation protocol. It clears only
the explicit memory state fields owned by the retrieval middlewares.
"""


def allows_unversioned_builder_handoff(owner_id: str | None) -> bool:
    """Legacy-only inheritance; metadata-less snippets are not admissions.

    The owner must come from authenticated configuration, not delegated state.
    A missing owner is acceptable only when no MEM00 feature is enabled.
    Configuration uncertainty never enables the legacy path.
    """
    from .flags import memory_feature_flags, memory_feature_flags_for_owner

    try:
        if not isinstance(owner_id, str) or not owner_id.strip():
            return not memory_feature_flags().any_enabled()
        return not memory_feature_flags_for_owner(owner_id).canonical_pool_read
    except Exception:
        return False


def cleared_memory_state(state: dict) -> dict:
    return {
        "injected_memories": [],
        "injected_memory_contents": [],
        "memory_retrieval_proof": None,
        "system_prompt_blocks": [block for block in (state.get("system_prompt_blocks") or []) if not block.lstrip().startswith(("<memory>", "<memories>"))],
    }
