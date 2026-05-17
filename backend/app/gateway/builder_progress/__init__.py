"""Gateway-side builder-progress relay.

Replaces the ``runs.join_stream`` HTTP subscriber path (which doesn't
work cross-process against ``langgraph dev``'s in-mem runtime). The
builder's ``BuilderProgressMiddleware`` POSTs phase events to the
gateway via ``/internal/builder-progress``; this module maintains a
per-process registry mapping ``task_id`` → placeholder anchor + per-
task ``ProgressRenderer``, dispatches each event through the renderer,
and invokes a per-channel edit callback to push the new placeholder
body to the user's chat.

Spec: PR #126 Phase 4H (webhook relay).
"""

from app.gateway.builder_progress.registry import (
    BuilderProgressEntry,
    BuilderProgressRegistry,
    get_progress_registry,
)

__all__ = [
    "BuilderProgressEntry",
    "BuilderProgressRegistry",
    "get_progress_registry",
]
