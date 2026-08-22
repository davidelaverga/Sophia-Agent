from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from fastapi import Request

HEARTBEAT_INTERVAL_SECONDS = 30.0


def format_sse_event(
    payload: dict[str, object],
    *,
    event_id: int | str | None = None,
) -> str:
    event_type = payload.get("type")
    if not isinstance(event_type, str) or not event_type:
        event_type = "message"

    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    id_line = f"id: {event_id}\n" if event_id is not None else ""
    return f"{id_line}event: {event_type}\ndata: {body}\n\n"


@dataclass(frozen=True)
class _SessionEvent:
    event_id: int
    payload: dict[str, object]


@dataclass
class _SessionSubscribers:
    queues: set[asyncio.Queue[_SessionEvent | None]] = field(default_factory=set)
    history: list[_SessionEvent] = field(default_factory=list)
    next_event_id: int = 1


class VoiceEventBroker:
    def __init__(
        self,
        heartbeat_interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
    ) -> None:
        self._heartbeat_interval_seconds = heartbeat_interval_seconds
        self._sessions: dict[tuple[str, str], _SessionSubscribers] = {}
        self._lock = asyncio.Lock()

    async def publish(
        self,
        call_id: str,
        session_id: str,
        payload: dict[str, object],
    ) -> None:
        async with self._lock:
            subscribers = self._sessions.setdefault(
                (call_id, session_id),
                _SessionSubscribers(),
            )
            event = _SessionEvent(
                event_id=subscribers.next_event_id,
                payload=dict(payload),
            )
            subscribers.next_event_id += 1
            subscribers.history.append(event)
            queues = tuple(subscribers.queues)

        for queue in queues:
            queue.put_nowait(event)

    async def close_session(self, call_id: str, session_id: str) -> None:
        async with self._lock:
            subscribers = self._sessions.pop((call_id, session_id), None)
            queues = tuple(subscribers.queues) if subscribers is not None else ()

        for queue in queues:
            queue.put_nowait(None)

    async def stream(
        self,
        call_id: str,
        session_id: str,
        request: Request,
        *,
        after_event_id: int | None = None,
    ) -> AsyncIterator[str]:
        key = (call_id, session_id)
        queue: asyncio.Queue[_SessionEvent | None] = asyncio.Queue()

        async with self._lock:
            subscribers = self._sessions.setdefault(key, _SessionSubscribers())
            subscribers.queues.add(queue)
            cursor = max(after_event_id or 0, 0)
            for event in subscribers.history:
                if event.event_id > cursor:
                    queue.put_nowait(event)

        try:
            while True:
                try:
                    event = await asyncio.wait_for(
                        queue.get(),
                        timeout=self._heartbeat_interval_seconds,
                    )
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break

                    yield ": heartbeat\n\n"
                    continue

                if event is None:
                    break

                yield format_sse_event(event.payload, event_id=event.event_id)
        finally:
            async with self._lock:
                subscribers = self._sessions.get(key)
                if subscribers is None:
                    return

                subscribers.queues.discard(queue)
