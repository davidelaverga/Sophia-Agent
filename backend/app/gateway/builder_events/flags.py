"""Feature flags for the Builder event router.

Read at call site (not cached) so flag flips roll out instantly without
a gateway restart.
"""

from __future__ import annotations

import os


def is_live_stream_enabled() -> bool:
    """``BUILDER_LIVE_STREAM_ENABLED`` — Stage 2 streaming gate.

    Stage 1A: not used (only fanout terminal events fire). Stage 2A:
    Work bot dispatches stream consumers when this is ``true``; chat
    relay sinks short-circuit when ``false`` so a flag flip is the
    rollback.
    """
    return os.environ.get("BUILDER_LIVE_STREAM_ENABLED", "").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
