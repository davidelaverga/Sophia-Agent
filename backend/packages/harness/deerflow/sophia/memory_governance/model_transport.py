"""Dedicated model-client transports; not global HTTP/Mem0 instrumentation.

Each SDK HTTP retry/fallback needs a new authority from the trusted run factory.
These wrappers see serialized bytes after SDK processing and HTTP auth. Installing
them into all enabled model factories and recording actual dispatch is mandatory;
their existence alone does not qualify an application model path.
"""

import asyncio
from time import monotonic

import httpx

from .legacy_model_dispatch import LegacyModelDispatchAuthority
from .model_dispatch import FinalModelDispatchAuthority
from .model_observation import observe_model_transport
from .store import MemoryGovernanceUnavailable


class FinalModelTransport(httpx.BaseTransport):
    def __init__(self, *, delegate: httpx.BaseTransport, authority_factory):
        self.delegate = delegate
        self.authority_factory = authority_factory

    def handle_request(self, request):
        started = monotonic()
        authority = receipt = response = None
        entered = False
        try:
            authority = self.authority_factory(request)
            if not isinstance(authority, (FinalModelDispatchAuthority, LegacyModelDispatchAuthority)):
                raise MemoryGovernanceUnavailable("memory_model_authority_missing")
            receipt = authority.admit(request)
            receipt.require_live()
            authority.require_exact(request)
            # No evidence I/O between the final check and transport entry.
            entered = True
            response = self.delegate.handle_request(request)
            return response
        finally:
            observe_model_transport(authority=authority, receipt=receipt, entered=entered,
                response=response, cancelled=False, started=started)

    def close(self):
        self.delegate.close()


class FinalModelAsyncTransport(httpx.AsyncBaseTransport):
    def __init__(self, *, delegate: httpx.AsyncBaseTransport, authority_factory):
        self.delegate = delegate
        self.authority_factory = authority_factory

    async def handle_async_request(self, request):
        started = monotonic()
        authority = receipt = response = None
        entered = cancelled = False
        def authorize():
            nonlocal authority
            authority = self.authority_factory(request)
            if not isinstance(authority, (FinalModelDispatchAuthority, LegacyModelDispatchAuthority)):
                raise MemoryGovernanceUnavailable("memory_model_authority_missing")
            return authority, authority.admit(request)
        # Cancellation cannot stop a synchronous database request already in
        # flight. Keep the invocation lease until that worker settles; never
        # let its late guard mutation race a reused client/run. A cancelled
        # attempt never reaches the model, even if its SQL permit committed.
        admission = asyncio.create_task(asyncio.to_thread(authorize))
        try:
            while not admission.done():
                try:
                    await asyncio.shield(admission)
                except asyncio.CancelledError:
                    cancelled = True
                except Exception:
                    break
            if cancelled:
                try:
                    _, receipt = admission.result()
                except BaseException:
                    pass  # Consume the outcome, preserve caller cancellation.
                raise asyncio.CancelledError()
            authority, receipt = admission.result()
            receipt.require_live()  # A queued event-loop continuation can expire.
            authority.require_exact(request)
            entered = True
            response = await self.delegate.handle_async_request(request)
            return response
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            observe_model_transport(authority=authority, receipt=receipt, entered=entered,
                response=response, cancelled=cancelled, started=started)

    async def aclose(self):
        await self.delegate.aclose()
