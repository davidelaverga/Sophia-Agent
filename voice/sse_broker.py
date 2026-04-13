from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from fastapi import Request

HEARTBEAT_INTERVAL_SECONDS = 30.0


def format_sse_event(payload: dict[str, object]) -> str:
    event_type = payload.get("type")
    if not isinstance(event_type, str) or not event_type:
        event_type = "message"

    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return f"event: {event_type}\ndata: {body}\n\n"


@dataclass
class _SessionSubscribers:
    queues: set[asyncio.Queue[str | None]] = field(default_factory=set)


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
        message = format_sse_event(payload)
        async with self._lock:
            subscribers = self._sessions.get((call_id, session_id))
            queues = tuple(subscribers.queues) if subscribers is not None else ()

        for queue in queues:
            queue.put_nowait(message)

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
    ) -> AsyncIterator[str]:
        key = (call_id, session_id)
        queue: asyncio.Queue[str | None] = asyncio.Queue()

        async with self._lock:
            subscribers = self._sessions.setdefault(key, _SessionSubscribers())
            subscribers.queues.add(queue)

        try:
            while True:
                try:
                    message = await asyncio.wait_for(
                        queue.get(),
                        timeout=self._heartbeat_interval_seconds,
                    )
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break

                    yield ": heartbeat\n\n"
                    continue

                if message is None:
                    break

                yield message
        finally:
            async with self._lock:
                subscribers = self._sessions.get(key)
                if subscribers is None:
                    return

                subscribers.queues.discard(queue)
                if not subscribers.queues:
                    self._sessions.pop(key, None)