"""Gateway-side builder-event fanout — Phase 1 foundation.

Public re-exports for the rest of the gateway and channel adapters.
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
    "install_builder_event_fanout",
]
