"""Ownership of guarded model sockets and response streams, not memory consent.

One model is bound to one mutable run guard. Concurrent invocations on that same
instance cannot share it; independent instances remain concurrent. Internal SDK
methods may inherit a lease through LangChain's child-task context, but a second
public invocation cannot. No request bodies,
credentials or canonical text are copied into this registry.
"""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar

import httpx

_active_leases: ContextVar[tuple] = ContextVar("mem00_model_client_leases", default=())


class ClientCleanupUnavailable(RuntimeError):
    pass


def execution_identity():
    try:
        task = asyncio.current_task()
    except RuntimeError:
        task = None
    return threading.get_ident(), id(task) if task else None


class ModelClientLifetime:
    def __init__(self):
        self._lock = threading.Lock()
        self.owner = None
        self.lease = None
        self.poisoned = False
        self.streams = set()

    def claim(self, *, public=False):
        identity = execution_identity()
        with self._lock:
            if self.poisoned:
                raise ClientCleanupUnavailable()
            if not public and self.lease is not None and (id(self), self.lease) in _active_leases.get():
                return False
            if self.owner is not None:
                raise ClientCleanupUnavailable()
            self.owner = identity
            self.lease = object()
            _active_leases.set((*_active_leases.get(), (id(self), self.lease)))
            return True

    def release(self, *, clean):
        with self._lock:
            self.poisoned = self.poisoned or not clean or bool(self.streams)
            key = (id(self), self.lease)
            _active_leases.set(tuple(item for item in _active_leases.get() if item != key))
            self.owner = None
            self.lease = None

    def track(self, stream, *, asynchronous):
        wrapped = AsyncOwnedStream(self, stream) if asynchronous else SyncOwnedStream(self, stream)
        with self._lock:
            self.streams.add(wrapped)
        return wrapped

    def remove(self, stream):
        with self._lock:
            self.streams.discard(stream)

    async def drain(self):
        with self._lock:
            pending = tuple(self.streams)
        failed = False
        for stream in pending:
            try:
                if isinstance(stream, AsyncOwnedStream):
                    await stream.aclose()
                else:
                    stream.close()
            except Exception:
                failed = True
        if failed:
            raise ClientCleanupUnavailable()


class SyncOwnedStream(httpx.SyncByteStream):
    def __init__(self, owner, delegate):
        self.owner, self.delegate = owner, delegate
        self.closed = False

    def __iter__(self):
        yield from self.delegate

    def close(self):
        if not self.closed:
            self.delegate.close()
            self.closed = True
            self.owner.remove(self)


class AsyncOwnedStream(httpx.AsyncByteStream):
    def __init__(self, owner, delegate):
        self.owner, self.delegate = owner, delegate
        self.closed = False

    async def __aiter__(self):
        async for value in self.delegate:
            yield value

    async def aclose(self):
        if not self.closed:
            await self.delegate.aclose()
            self.closed = True
            self.owner.remove(self)


async def bounded_cleanup(close):
    # Shield from caller cancellation until owned resources have finished
    # closing. The cleanup itself has a deadline and failure poisons reuse.
    task = asyncio.create_task(asyncio.wait_for(close(), timeout=5))
    interrupted = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            interrupted = True
    task.result()
    return interrupted


def synchronous_cleanup(close):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(bounded_cleanup(close))
    # A synchronous model may be called on an event-loop thread. Its unused
    # async client must still close without nesting or stopping that loop.
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="mem00-client-close") as executor:
        return executor.submit(lambda: asyncio.run(bounded_cleanup(close))).result()
