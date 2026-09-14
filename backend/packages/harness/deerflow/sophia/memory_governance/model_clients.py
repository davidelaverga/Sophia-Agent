"""Run-owned LangChain clients with final admission on every physical request.

Do not patch the globally cached default HTTP clients. Build uncached clients
with the installed integration's exact settings and gate every transport mount
(including proxies). These private integration points are covered by SDK tests.
"""

import asyncio
from collections.abc import Callable
from contextlib import asynccontextmanager, contextmanager
from functools import cached_property

import anthropic
import httpx
from langchain_anthropic import ChatAnthropic
from langchain_anthropic import chat_models as anthropic_models
from langchain_openai import ChatOpenAI
from langchain_openai.chat_models import _client_utils as openai_clients
from langchain_openai.chat_models.base import global_ssl_context
from langgraph.errors import GraphBubbleUp
from pydantic import Field, PrivateAttr, model_validator

from .model_client_lifetime import ClientCleanupUnavailable, ModelClientLifetime, bounded_cleanup, synchronous_cleanup
from .model_transport import FinalModelAsyncTransport, FinalModelTransport
from .store import MemoryGovernanceUnavailable


class ModelDispatchDenied(GraphBubbleUp):
    def __init__(self):
        super().__init__("memory_context_rotation_required")


class _AdmissionAbort(BaseException):
    """Private cancellation across SDK Exception-based network retry loops.

Always translated to GraphBubbleUp by the enclosing LangChain model method.
This must not escape a public model API or impersonate a provider failure.
"""


class _AbortTransport(FinalModelTransport):
    def handle_request(self, request):
        try:
            response = super().handle_request(request)
            response.stream = self.lifetime.track(response.stream, asynchronous=False)
            return response
        except MemoryGovernanceUnavailable:
            raise _AdmissionAbort() from None


class _AbortAsyncTransport(FinalModelAsyncTransport):
    async def handle_async_request(self, request):
        try:
            response = await super().handle_async_request(request)
            response.stream = self.lifetime.track(response.stream, asynchronous=True)
            return response
        except MemoryGovernanceUnavailable:
            raise _AdmissionAbort() from None


def _own_transports(client, factory, *, lifetime, asynchronous=False):
    expected = httpx.AsyncClient if asynchronous else httpx.Client
    if not isinstance(client, expected) or not isinstance(client._mounts, dict):
        raise ModelDispatchDenied()

    def authority(wire):
        try:
            return factory(wire)
        except Exception:
            raise MemoryGovernanceUnavailable("memory_model_authority_unavailable") from None

    wrapper = _AbortAsyncTransport if asynchronous else _AbortTransport
    wrapped = {}

    def wrap(transport):
        if transport is None:
            return None
        if id(transport) not in wrapped:
            wrapped[id(transport)] = wrapper(delegate=transport, authority_factory=authority)
            wrapped[id(transport)].lifetime = lifetime
        return wrapped[id(transport)]

    client._transport = wrap(client._transport)
    client._mounts = {pattern: wrap(transport) for pattern, transport in client._mounts.items()}
    return client


class _GovernanceAbortBoundary:
    def _prepare_memory_clients(self):
        pass

    @contextmanager
    def _memory_client_scope(self, *, public=False):
        try:
            outer = self._memory_lifetime.claim(public=public)
        except ClientCleanupUnavailable:
            raise ModelDispatchDenied() from None
        try:
            if outer:
                self._prepare_memory_clients()
            yield
        finally:
            if outer:
                clean = False
                try:
                    synchronous_cleanup(self._close_memory_clients)
                    clean = True
                except Exception:
                    raise ModelDispatchDenied() from None
                finally:
                    self._memory_lifetime.release(clean=clean)

    @asynccontextmanager
    async def _async_memory_client_scope(self, *, public=False):
        try:
            outer = self._memory_lifetime.claim(public=public)
        except ClientCleanupUnavailable:
            raise ModelDispatchDenied() from None
        try:
            if outer:
                self._prepare_memory_clients()
            yield
        finally:
            if outer:
                clean = False
                try:
                    interrupted = await bounded_cleanup(self._close_memory_clients)
                    clean = True
                    if interrupted:
                        raise asyncio.CancelledError()
                except Exception:
                    raise ModelDispatchDenied() from None
                finally:
                    self._memory_lifetime.release(clean=clean)

    def invoke(self, input, config=None, *, stop=None, **kwargs):
        with self._memory_client_scope(public=True):
            return super().invoke(input, config=config, stop=stop, **kwargs)

    async def ainvoke(self, input, config=None, *, stop=None, **kwargs):
        async with self._async_memory_client_scope(public=True):
            return await super().ainvoke(input, config=config, stop=stop, **kwargs)

    def stream(self, input, config=None, *, stop=None, **kwargs):
        with self._memory_client_scope(public=True):
            yield from super().stream(input, config=config, stop=stop, **kwargs)

    async def astream(self, input, config=None, *, stop=None, **kwargs):
        async with self._async_memory_client_scope(public=True):
            stream = super().astream(input, config=config, stop=stop, **kwargs)
            try:
                async for chunk in stream:
                    yield chunk
            finally:
                await stream.aclose()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        from .model_result_provenance import parsed_model_scope
        try:
            with self._memory_client_scope(), parsed_model_scope() as (capture, root):
                result = super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
                if root:
                    capture.complete_generation(result.generations[0] if len(result.generations) == 1 else None, result.llm_output)
                return result
        except _AdmissionAbort:
            raise ModelDispatchDenied() from None

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        from .model_result_provenance import parsed_model_scope, settle_result_observation
        try:
            async with self._async_memory_client_scope():
                with parsed_model_scope() as (capture, root):
                    result = await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
                    if root:
                        await settle_result_observation(capture.complete_generation,
                            result.generations[0] if len(result.generations) == 1 else None, result.llm_output)
                    return result
        except _AdmissionAbort:
            raise ModelDispatchDenied() from None

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        from .model_result_provenance import ParsedStream, bind_parsed_capture, parsed_stream_capture
        try:
            with self._memory_client_scope():
                capture, root = parsed_stream_capture()
                parsed = ParsedStream(capture)
                stream = super()._stream(messages, stop=stop, run_manager=run_manager, **kwargs)
                try:
                    while True:
                        with bind_parsed_capture(capture):
                            try:
                                chunk = next(stream)
                            except StopIteration:
                                break
                            parsed.add(chunk)
                        yield chunk
                    with bind_parsed_capture(capture):
                        if root:
                            parsed.complete()
                        else:
                            parsed.validate()
                finally:
                    with bind_parsed_capture(capture):
                        stream.close()
        except _AdmissionAbort:
            raise ModelDispatchDenied() from None

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        from .model_result_provenance import ParsedStream, bind_parsed_capture, parsed_stream_capture, settle_result_observation
        try:
            async with self._async_memory_client_scope():
                capture, root = parsed_stream_capture()
                parsed = ParsedStream(capture)
                stream = super()._astream(messages, stop=stop, run_manager=run_manager, **kwargs)
                try:
                    while True:
                        with bind_parsed_capture(capture):
                            try:
                                chunk = await anext(stream)
                            except StopAsyncIteration:
                                break
                            parsed.add(chunk)
                        yield chunk
                    with bind_parsed_capture(capture):
                        if root:
                            await settle_result_observation(parsed.complete)
                        else:
                            parsed.validate()
                finally:
                    with bind_parsed_capture(capture):
                        await stream.aclose()
        except _AdmissionAbort:
            raise ModelDispatchDenied() from None


class GovernedChatAnthropic(_GovernanceAbortBoundary, ChatAnthropic):
    memory_authority_factory: Callable = Field(exclude=True, repr=False)
    _memory_lifetime: ModelClientLifetime = PrivateAttr(default_factory=ModelClientLifetime)

    async def _close_memory_clients(self):
        failed = False
        try:
            await self._memory_lifetime.drain()
        except Exception:
            failed = True
        for name in ("_client", "_async_client"):
            client = self.__dict__.get(name)
            if client is not None:
                try:
                    if name == "_async_client":
                        await client.close()
                    else:
                        client.close()
                    self.__dict__.pop(name, None)
                except Exception:
                    failed = True
        if failed:
            raise ClientCleanupUnavailable()

    def _dedicated_http(self, *, asynchronous=False):
        params = self._client_params
        settings = {"base_url": params["base_url"]}
        if "timeout" in params:
            settings["timeout"] = params["timeout"]
        if self.anthropic_proxy:
            settings["anthropic_proxy"] = self.anthropic_proxy
        getter = anthropic_models._get_default_async_httpx_client if asynchronous else anthropic_models._get_default_httpx_client
        client = getter.__wrapped__(**settings)
        return _own_transports(client, self.memory_authority_factory, lifetime=self._memory_lifetime, asynchronous=asynchronous)

    @cached_property
    def _client(self):
        return anthropic.Client(**self._client_params, http_client=self._dedicated_http())

    @cached_property
    def _async_client(self):
        return anthropic.AsyncClient(**self._client_params, http_client=self._dedicated_http(asynchronous=True))


class GovernedChatOpenAI(_GovernanceAbortBoundary, ChatOpenAI):
    memory_authority_factory: Callable = Field(exclude=True, repr=False)
    _memory_lifetime: ModelClientLifetime = PrivateAttr(default_factory=ModelClientLifetime)

    def _prepare_memory_clients(self):
        if self.http_client.is_closed:
            client = httpx.Client(proxy=self.openai_proxy, verify=global_ssl_context) if self.openai_proxy else openai_clients._build_sync_httpx_client(self.openai_api_base, self.request_timeout)
            self.http_client = _own_transports(client, self.memory_authority_factory, lifetime=self._memory_lifetime)
            if self.root_client is not None:
                self.root_client = self.root_client.with_options(http_client=self.http_client)
                self.client = self.root_client.chat.completions
        if self.http_async_client.is_closed:
            client = httpx.AsyncClient(proxy=self.openai_proxy, verify=global_ssl_context) if self.openai_proxy else openai_clients._build_async_httpx_client(self.openai_api_base, self.request_timeout)
            self.http_async_client = _own_transports(client, self.memory_authority_factory, lifetime=self._memory_lifetime, asynchronous=True)
            self.root_async_client = self.root_async_client.with_options(http_client=self.http_async_client)
            self.async_client = self.root_async_client.chat.completions

    async def _close_memory_clients(self):
        failed = False
        try:
            await self._memory_lifetime.drain()
        except Exception:
            failed = True
        try:
            self.http_client.close()
        except Exception:
            failed = True
        try:
            await self.http_async_client.aclose()
        except Exception:
            failed = True
        if failed:
            raise ClientCleanupUnavailable()

    @model_validator(mode="after")
    def validate_environment(self):
        # Only this factory owns the clients. Accepting caller-supplied SDK
        # objects could bypass the transport or mutate a shared connection pool.
        if any(getattr(self, field) is not None for field in (
            "client", "async_client", "root_client", "root_async_client", "http_client", "http_async_client"
        )):
            raise ModelDispatchDenied()
        super().validate_environment()
        # Preserve stream_usage inference and all root SDK options from the
        # installed integration, including headers/query/org/endpoint/retries.
        sync = self.http_client or openai_clients._build_sync_httpx_client(self.openai_api_base, self.request_timeout)
        asynchronous = self.http_async_client or openai_clients._build_async_httpx_client(self.openai_api_base, self.request_timeout)
        self.http_client = _own_transports(sync, self.memory_authority_factory, lifetime=self._memory_lifetime)
        self.http_async_client = _own_transports(asynchronous, self.memory_authority_factory, lifetime=self._memory_lifetime, asynchronous=True)
        if self.root_client is not None:
            self.root_client = self.root_client.with_options(http_client=self.http_client)
            self.client = self.root_client.chat.completions
        self.root_async_client = self.root_async_client.with_options(http_client=self.http_async_client)
        self.async_client = self.root_async_client.chat.completions
        return self


def fallback_openai_model(**kwargs):
    from deerflow.agents.sophia_agent.middlewares.memory_context import active_model_guard

    guard = active_model_guard()
    if guard is None:
        raise ModelDispatchDenied()
    return GovernedChatOpenAI(memory_authority_factory=guard.final_dispatch_authority, **kwargs)
