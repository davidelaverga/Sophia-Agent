"""Gateway-side builder-event fanout — Phase 1 foundation.

Public re-exports for the rest of the gateway and channel adapters.

The module-level ``get_global_*`` accessors let channels reach the
fanout / sink / cache without an explicit ``app.state`` handle. The
companion handler ([app/channels/telegram.py]) uses them to register
new task_ids in the resolution cache after sending the summoning
message; the workshop handler ([app/channels/telegram_workshop.py])
uses them to resolve dispatches and register receivers on the sink.
The gateway lifespan calls :func:`set_global_workshop_dependencies`
once at startup; tests should pair every ``set_…`` with a teardown.
"""

from __future__ import annotations

from app.gateway.builder_events.companion_context_store import CompanionContextStore
from app.gateway.builder_events.fanout import (
    BuilderEventFanout,
    get_builder_event_fanout,
    get_builder_event_fanout_or_none,
    install_builder_event_fanout,
)
from app.gateway.builder_events.sinks.base import BuilderEventSink
from app.gateway.builder_events.sinks.companion_awareness import CompanionAwarenessSink
from app.gateway.builder_events.sinks.trace import TraceSink
from app.gateway.builder_events.sinks.workshop_telegram import (
    WorkshopEventReceiver,
    WorkshopTelegramSink,
)
from app.gateway.builder_events.task_resolution_cache import TaskResolutionCache
from app.gateway.builder_events.types import (
    BuilderEvent,
    CompletedEvent,
    CustomEvent,
    MessageDeltaEvent,
    SubagentEvent,
    ToolCallEvent,
)

_global_fanout: BuilderEventFanout | None = None
_global_workshop_sink: WorkshopTelegramSink | None = None
_global_task_cache: TaskResolutionCache | None = None


def set_global_workshop_dependencies(
    *,
    fanout: BuilderEventFanout | None,
    workshop_sink: WorkshopTelegramSink | None,
    task_cache: TaskResolutionCache | None,
) -> None:
    """Register the gateway-singleton workshop dependencies (lifespan-only).

    Passing ``None`` for all three clears the slot — useful in test
    teardown so a stale fanout from a previous test doesn't bleed into
    the next.
    """
    global _global_fanout, _global_workshop_sink, _global_task_cache
    _global_fanout = fanout
    _global_workshop_sink = workshop_sink
    _global_task_cache = task_cache


def get_global_fanout() -> BuilderEventFanout | None:
    return _global_fanout


def get_global_workshop_sink() -> WorkshopTelegramSink | None:
    return _global_workshop_sink


def get_global_task_cache() -> TaskResolutionCache | None:
    return _global_task_cache


__all__ = [
    "BuilderEvent",
    "BuilderEventFanout",
    "BuilderEventSink",
    "CompanionAwarenessSink",
    "CompanionContextStore",
    "CompletedEvent",
    "CustomEvent",
    "MessageDeltaEvent",
    "SubagentEvent",
    "TaskResolutionCache",
    "ToolCallEvent",
    "TraceSink",
    "WorkshopEventReceiver",
    "WorkshopTelegramSink",
    "get_builder_event_fanout",
    "get_builder_event_fanout_or_none",
    "get_global_fanout",
    "get_global_task_cache",
    "get_global_workshop_sink",
    "install_builder_event_fanout",
    "set_global_workshop_dependencies",
]
