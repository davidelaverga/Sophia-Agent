"""Discard prior transient memory admissions before a fresh governed lookup.

This is not a checkpoint/history or per-model revocation protocol. It clears only
the explicit memory state fields owned by the retrieval middlewares.
"""


def cleared_memory_state(state: dict) -> dict:
    return {
        "injected_memories": [],
        "injected_memory_contents": [],
        "system_prompt_blocks": [block for block in (state.get("system_prompt_blocks") or []) if not block.lstrip().startswith(("<memory>", "<memories>"))],
    }
