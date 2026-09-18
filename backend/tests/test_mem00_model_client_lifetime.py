import httpx
import pytest
from test_mem00_model_clients import close_model, model, reply
from test_mem00_model_dispatch import PermitStore, recorded_model_context


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(name="context")
def model_context(monkeypatch):
    return recorded_model_context(monkeypatch)


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
@pytest.mark.parametrize("asynchronous", [False, True])
async def test_model_invocation_closes_owned_http_clients(monkeypatch, context, provider, asynchronous):
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", lambda transport, wire: reply(provider, wire))

    async def network(transport, wire):
        return reply(provider, wire)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", network)
    value = model(provider, context, PermitStore())
    if provider == "anthropic":
        clients = [value._client._client, value._async_client._client]
    else:
        clients = [value.http_client, value.http_async_client]
    try:
        if asynchronous:
            assert await value.ainvoke("SYNTHETIC USER")
        else:
            assert value.invoke("SYNTHETIC USER")
        assert all(client.is_closed for client in clients)
    finally:
        await close_model(value)


def observe_clients(monkeypatch):
    from deerflow.sophia.memory_governance import model_clients
    owned = []
    original = model_clients._own_transports

    def capture(client, *args, **kwargs):
        owned.append(client)
        return original(client, *args, **kwargs)

    monkeypatch.setattr(model_clients, "_own_transports", capture)
    return owned


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("mode", ["invoke", "stream", "early_stream"])
async def test_reuse_closes_clients_and_open_streams(monkeypatch, context, provider, asynchronous, mode):
    from deerflow.sophia.memory_governance.model_clients import ModelDispatchDenied
    owned, streams = observe_clients(monkeypatch), []

    class SyncBody(httpx.SyncByteStream):
        closed = False

        def __init__(self, body):
            self.body = body

        def __iter__(self):
            yield self.body

        def close(self):
            self.closed = True

    class AsyncBody(httpx.AsyncByteStream):
        closed = False

        def __init__(self, body):
            self.body = body

        async def __aiter__(self):
            yield self.body

        async def aclose(self):
            self.closed = True

    def response(wire, asynchronous):
        base = reply(provider, wire)
        body = (AsyncBody if asynchronous else SyncBody)(base.content)
        streams.append(body)
        return httpx.Response(200, headers=base.headers, stream=body)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", lambda transport, wire: response(wire, False))

    async def network(transport, wire):
        return response(wire, True)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", network)
    store, value = PermitStore(), None
    value = model(provider, context, store)
    try:
        for _ in range(2):
            if mode == "invoke":
                assert await value.ainvoke("SYNTHETIC USER") if asynchronous else value.invoke("SYNTHETIC USER")
            elif asynchronous:
                iterator = value.astream("SYNTHETIC USER")
                if mode == "early_stream":
                    await anext(iterator)
                    await iterator.aclose()
                else:
                    assert [chunk async for chunk in iterator]
            else:
                iterator = value.stream("SYNTHETIC USER")
                if mode == "early_stream":
                    next(iterator)
                    iterator.close()
                else:
                    assert list(iterator)
            assert all(client.is_closed for client in owned)
            assert all(stream.closed for stream in streams)
            assert not value._memory_lifetime.streams
            assert value._memory_lifetime.owner is None and not value._memory_lifetime.poisoned
        assert len(store.calls) == 2
        store.failure = RuntimeError("synthetic SQL unavailable")
        with pytest.raises(ModelDispatchDenied):
            if asynchronous:
                await value.ainvoke("SYNTHETIC USER")
            else:
                value.invoke("SYNTHETIC USER")
        assert len(streams) == 2
        assert all(client.is_closed for client in owned)
    finally:
        await close_model(value)


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
async def test_cancelled_admission_worker_finishes_before_model_scope_reopens(monkeypatch, context, provider):
    import asyncio
    import threading

    from deerflow.sophia.memory_governance.model_clients import ModelDispatchDenied

    started, release, completed = threading.Event(), threading.Event(), threading.Event()
    sent = []
    owned = observe_clients(monkeypatch)

    class SlowStore(PermitStore):
        def authorize_model_dispatch(self, **kwargs):
            started.set()
            assert release.wait(3)
            try:
                return super().authorize_model_dispatch(**kwargs)
            finally:
                completed.set()

    async def network(transport, wire):
        sent.append(wire)
        return reply(provider, wire)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", network)
    value = model(provider, context, SlowStore())
    task = asyncio.create_task(value.ainvoke("SYNTHETIC USER"))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        # The SQL worker is held behind an explicit thread barrier. Cancellation
        # cannot settle the outer call while that worker still owns run state.
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(task), timeout=0.05)
        with pytest.raises(ModelDispatchDenied):
            await value.ainvoke("SYNTHETIC OTHER")
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert completed.is_set() and sent == []
        assert all(client.is_closed for client in owned)
        assert value._memory_lifetime.owner is None
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert await asyncio.to_thread(completed.wait, 2)
        await close_model(value)


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
async def test_one_guard_cannot_share_concurrent_invocations_but_other_models_can(monkeypatch, context, provider):
    import asyncio

    from deerflow.sophia.memory_governance.model_clients import ModelDispatchDenied

    owned = observe_clients(monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()

    async def network(transport, wire):
        if b"SYNTHETIC SLOW" in wire.content:
            entered.set()
            await release.wait()
        return reply(provider, wire)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", network)
    first_store, other_store = PermitStore(), PermitStore()
    first, other = model(provider, context, first_store), model(provider, context, other_store)
    task = asyncio.create_task(first.ainvoke("SYNTHETIC SLOW"))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        with pytest.raises(ModelDispatchDenied):
            await first.ainvoke("SYNTHETIC OVERLAP")
        assert await other.ainvoke("SYNTHETIC INDEPENDENT")
        release.set()
        assert await task
        assert len(first_store.calls) == len(other_store.calls) == 1
        assert all(client.is_closed for client in owned)
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        await close_model(first)
        await close_model(other)


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
async def test_unverified_cleanup_poison_prevents_another_dispatch(monkeypatch, context, provider):
    from deerflow.sophia.memory_governance.model_clients import ModelDispatchDenied

    owned = observe_clients(monkeypatch)

    async def network(transport, wire):
        return reply(provider, wire)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", network)
    store = PermitStore()
    value = model(provider, context, store)
    original = value._memory_lifetime.drain

    async def failed_close():
        raise RuntimeError("synthetic unverified stream close")

    monkeypatch.setattr(value._memory_lifetime, "drain", failed_close)
    try:
        with pytest.raises(ModelDispatchDenied):
            await value.ainvoke("SYNTHETIC USER")
        assert value._memory_lifetime.poisoned
        assert all(client.is_closed for client in owned)
        with pytest.raises(ModelDispatchDenied):
            await value.ainvoke("SYNTHETIC REUSE")
        assert len(store.calls) == 1
    finally:
        monkeypatch.setattr(value._memory_lifetime, "drain", original)
        await close_model(value)


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
async def test_repeated_cancellation_waits_for_client_close_before_reuse(monkeypatch, context, provider):
    import asyncio

    from deerflow.sophia.memory_governance.model_clients import ModelDispatchDenied

    owned = observe_clients(monkeypatch)
    closing, release = asyncio.Event(), asyncio.Event()

    async def network(transport, wire):
        return reply(provider, wire)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", network)
    value = model(provider, context, PermitStore())
    cls, original = type(value), type(value)._close_memory_clients

    async def held_close(self):
        closing.set()
        await release.wait()
        await original(self)

    monkeypatch.setattr(cls, "_close_memory_clients", held_close)
    task = asyncio.create_task(value.ainvoke("SYNTHETIC USER"))
    try:
        await asyncio.wait_for(closing.wait(), 2)
        task.cancel()
        with pytest.raises(ModelDispatchDenied):
            await value.ainvoke("SYNTHETIC OVERLAP")
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert all(client.is_closed for client in owned)
        assert value._memory_lifetime.owner is None and not value._memory_lifetime.poisoned
        monkeypatch.setattr(cls, "_close_memory_clients", original)
        assert await value.ainvoke("SYNTHETIC REUSE")
        assert all(client.is_closed for client in owned)
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        monkeypatch.setattr(cls, "_close_memory_clients", original)
        await close_model(value)
