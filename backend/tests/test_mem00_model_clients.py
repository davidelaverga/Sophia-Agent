import asyncio
import importlib
import json
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from mem00_owner_fixture import declare_memory_owners
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI
from test_mem00_model_dispatch import PermitStore, attempt, recorded_model_context

from deerflow.sophia.memory_governance.model_clients import GovernedChatAnthropic, GovernedChatOpenAI, ModelDispatchDenied
from deerflow.sophia.memory_governance.model_dispatch import FinalModelDispatchAuthority


def test_fallback_factory_without_owner_context_fails_closed():
    from deerflow.sophia.memory_governance.model_clients import fallback_openai_model
    value = None
    try:
        with pytest.raises(ModelDispatchDenied):
            value = fallback_openai_model(model="existing-model", api_key="synthetic")
    finally:
        if value is not None:
            asyncio.run(close_model(value))


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(name="context")
def model_context(monkeypatch):
    return recorded_model_context(monkeypatch)


def reply(provider, wire):
    streaming = json.loads(wire.content).get("stream", False)
    if provider == "anthropic":
        body = {"id": "msg_synthetic", "type": "message", "role": "assistant", "model": "existing-model",
            "content": [{"type": "text", "text": "SYNTHETIC RESPONSE"}], "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}}
        if streaming:
            events = [
                ("message_start", {"type": "message_start", "message": {**body, "content": [], "stop_reason": None}}),
                ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "SYNTHETIC RESPONSE"}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                ("message_stop", {"type": "message_stop"}),
            ]
            return httpx.Response(200, content="".join(f"event: {event}\ndata: {json.dumps(value)}\n\n" for event, value in events), headers={"content-type": "text/event-stream"})
    else:
        body = {"id": "chatcmpl_synthetic", "object": "chat.completion", "created": 1, "model": "existing-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "SYNTHETIC RESPONSE"}, "finish_reason": "stop"}]}
        if streaming:
            chunk = {**body, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "SYNTHETIC RESPONSE"}, "finish_reason": "stop"}]}
            return httpx.Response(200, content=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n", headers={"content-type": "text/event-stream"})
    return httpx.Response(200, json=body)


def model(provider, context, store, **kwargs):
    cls = GovernedChatAnthropic if provider == "anthropic" else GovernedChatOpenAI
    return cls(model="existing-model", api_key="synthetic", max_retries=2,
        memory_authority_factory=lambda wire: FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, wire), store=store), **kwargs)


async def close_model(value):
    if isinstance(value, GovernedChatAnthropic):
        if "_client" in value.__dict__:
            value._client.close()
        if "_async_client" in value.__dict__:
            await value._async_client.close()
    else:
        if value.root_client:
            value.root_client.close()
        await value.root_async_client.close()


@pytest.mark.parametrize("surface", ["companion", "builder"])
@pytest.mark.parametrize("asynchronous", [False, True])
def test_governance_abort_cannot_become_provider_fallback(monkeypatch, surface, asynchronous):
    module = importlib.import_module(f"deerflow.agents.sophia_agent.middlewares.{surface}_provider_fallback")
    getattr(module, f"reset_{surface}_primary_cooldown_for_tests")()
    middleware = getattr(module, f"{surface.title()}ProviderFallbackMiddleware")()
    request = SimpleNamespace(state={}, model="existing-model", tools=[])
    attempted = []
    monkeypatch.setattr(module, "build_fallback_chat_model", lambda: attempted.append(True))
    def handler(request):
        raise ModelDispatchDenied()
    async def async_handler(request):
        raise ModelDispatchDenied()
    with pytest.raises(ModelDispatchDenied):
        if asynchronous:
            asyncio.run(middleware.awrap_model_call(request, async_handler))
        else:
            middleware.wrap_model_call(request, handler)
    assert attempted == []


@pytest.mark.parametrize("surface", ["companion", "builder"])
def test_real_sophia_factory_binds_model_and_middleware_to_same_guard(monkeypatch, declare_memory_owners, surface, caplog):
    owner = "synthetic-private-factory-owner"
    declare_memory_owners({owner: "governed"})
    caplog.set_level("INFO")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "false")
    captured = {}
    class InspectableAgent:
        recursion_limit = 0

        def with_config(self, config):
            self.config = config
            return self

    def capture(**kwargs):
        from langgraph.graph import StateGraph

        captured.update(kwargs)
        fake = InspectableAgent()
        fake.channels = StateGraph(kwargs["state_schema"]).channels
        return fake
    cfg = {"user_id": owner, "langgraph_auth_user_id": owner, "thread_id": str(uuid4()), "platform": "text"}
    if surface == "companion":
        from deerflow.agents.sophia_agent import agent as module
        monkeypatch.setattr(module, "create_agent", capture)
        monkeypatch.setattr(module, "load_sophia_web_tools", lambda: [])
        module.make_sophia_agent({"configurable": cfg})
        value = captured["model"]._runnable
    else:
        from deerflow.agents.sophia_agent import builder_agent as module
        monkeypatch.setattr(module, "create_agent", capture)
        module._create_builder_agent(user_id=owner, trace_config={"configurable": cfg})
        value = captured["model"]
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextEntryMiddleware
    entry = next(item for item in captured["middleware"] if isinstance(item, MemoryContextEntryMiddleware))
    assert isinstance(value, GovernedChatAnthropic)
    assert value.memory_authority_factory.__self__ is entry.guard
    assert entry.guard.owner == owner and entry.guard.context_id == cfg["thread_id"]
    asyncio.run(close_model(value))
    assert owner not in caplog.text, "routine factory log exported a raw owner identifier"


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
@pytest.mark.parametrize("mode", ["invoke", "stream"])
@pytest.mark.parametrize("denied", [False, True])
def test_actual_sync_langchain_sdk_gate_and_abort(monkeypatch, context, provider, mode, denied):
    store, seen = PermitStore(), []
    if denied:
        store.failure = RuntimeError("SYNTHETIC SQL OUTAGE")
    def network(transport, wire):
        seen.append(wire)
        assert len(store.calls) == len(seen)
        return reply(provider, wire)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", network)
    value = model(provider, context, store)
    try:
        def invoke():
            return value.invoke("SYNTHETIC USER") if mode == "invoke" else list(value.stream("SYNTHETIC USER"))
        if denied:
            with pytest.raises(ModelDispatchDenied):
                invoke()
            assert not seen and len(store.calls) == 1  # SDK retries were cancelled.
        else:
            assert invoke()
            assert len(seen) == 1 and len(store.calls) == 1
        assert "memory_authority_factory" not in value.model_dump()
    finally:
        asyncio.run(close_model(value))


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
@pytest.mark.parametrize("mode", ["invoke", "stream"])
@pytest.mark.parametrize("denied", [False, True])
async def test_actual_async_langchain_sdk_gate_and_abort(monkeypatch, context, provider, mode, denied):
    store, seen = PermitStore(), []
    if denied:
        store.failure = RuntimeError("SYNTHETIC SQL OUTAGE")
    async def network(transport, wire):
        seen.append(wire)
        assert len(store.calls) == len(seen)
        return reply(provider, wire)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", network)
    value = model(provider, context, store)
    try:
        async def invoke():
            return await value.ainvoke("SYNTHETIC USER") if mode == "invoke" else [item async for item in value.astream("SYNTHETIC USER")]
        if denied:
            with pytest.raises(ModelDispatchDenied):
                await invoke()
            assert not seen and len(store.calls) == 1
        else:
            assert await invoke()
            assert len(seen) == 1 and len(store.calls) == 1
    finally:
        await close_model(value)


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_provider_failure_still_retries_with_new_permits(monkeypatch, context, provider):
    store, seen = PermitStore(), []
    def network(transport, wire):
        seen.append(wire)
        if len(seen) == 1:
            return httpx.Response(500, json={"error": {"type": "api_error", "message": "synthetic failure"}}, headers={"retry-after-ms": "1"})
        return reply(provider, wire)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", network)
    value = model(provider, context, store)
    try:
        assert value.invoke("SYNTHETIC USER")
        assert len(seen) == 2 and len({item["attempt_id"] for item in store.calls}) == 2
    finally:
        asyncio.run(close_model(value))


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_client_settings_preserved_and_shared_default_transport_unmodified(context, provider):
    baseline_class = ChatAnthropic if provider == "anthropic" else ChatOpenAI
    baseline = baseline_class(model="existing-model", api_key="synthetic", timeout=37, max_retries=2)
    old_http = baseline._client._client if provider == "anthropic" else baseline.root_client._client
    old_transport, old_mounts = old_http._transport, dict(old_http._mounts)
    value = model(provider, context, PermitStore(), timeout=37)
    try:
        new_http = value._client._client if provider == "anthropic" else value.root_client._client
        assert old_http is not new_http and old_http._transport is old_transport and old_http._mounts == old_mounts
        assert old_http.timeout == new_http.timeout and old_http.base_url == new_http.base_url
        if provider == "anthropic":
            assert baseline._client_params == value._client_params
        else:
            assert value.stream_usage == baseline.stream_usage
            assert value.root_client.max_retries == baseline.root_client.max_retries
            assert value.root_client.base_url == baseline.root_client.base_url
    finally:
        asyncio.run(close_model(value))


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
@pytest.mark.parametrize("asynchronous", [False, True])
async def test_explicit_proxy_mount_cannot_bypass_admission(monkeypatch, context, provider, asynchronous):
    store, sent = PermitStore(), []
    def network(transport, wire):
        sent.append(wire)
        assert len(store.calls) == 1
        return reply(provider, wire)
    async def async_network(transport, wire):
        return network(transport, wire)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", network)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", async_network)
    settings = {"anthropic_proxy" if provider == "anthropic" else "openai_proxy": "http://127.0.0.1:9"}
    value = model(provider, context, store, **settings)
    try:
        if asynchronous:
            assert await value.ainvoke("SYNTHETIC USER")
        else:
            assert value.invoke("SYNTHETIC USER")
        assert len(sent) == 1
    finally:
        await close_model(value)


def test_caller_http_client_cannot_bypass_owned_openai_transports(context):
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as client:
        with pytest.raises(ModelDispatchDenied):
            model("openai", context, PermitStore(), http_client=client)
