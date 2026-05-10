"""Builder event fanout — single-process router for all Builder events.

Stage 1A: only the webhook ingress publishes here. Trace JSONL sink is
the only real sink. Mid-flight streaming + chat relay sinks land in
Stage 2.

See ``~/.claude/plans/users-davidelaverga-desktop-sophia-v3-s-tingly-sonnet.md``
for the implementation plan.
"""

from __future__ import annotations

from threading import Lock

from app.gateway.builder_events.fanout import BuilderEventFanout
from app.gateway.builder_events.flags import is_live_stream_enabled
from app.gateway.builder_events.types import BuilderEvent, BuilderEventType

_fanout: BuilderEventFanout | None = None
_fanout_lock = Lock()


def get_fanout() -> BuilderEventFanout:
    """Return the gateway-process singleton ``BuilderEventFanout``.

    Lazily constructed on first call; thread-safe. The gateway
    lifespan calls this once at startup to register sinks; the webhook
    handler calls it on every event to publish.
    """
    global _fanout
    if _fanout is None:
        with _fanout_lock:
            if _fanout is None:
                _fanout = BuilderEventFanout()
    return _fanout


def reset_fanout_for_tests() -> None:
    """Drop the singleton so a test fixture can install a fresh one."""
    global _fanout
    with _fanout_lock:
        _fanout = None


__all__ = [
    "BuilderEvent",
    "BuilderEventType",
    "BuilderEventFanout",
    "get_fanout",
    "is_live_stream_enabled",
    "reset_fanout_for_tests",
]
