import pytest
from mem00_owner_fixture import declare_memory_owners

from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextUnavailable, MemoryRunGuard


def test_guard_constructed_legacy_rechecks_cutover_before_consumer(declare_memory_owners):
    declare_memory_owners({"owner": "legacy"})
    guard = MemoryRunGuard(owner_id="owner", config={})
    assert not guard.enabled
    declare_memory_owners({"owner": "governed"})
    with pytest.raises(MemoryContextUnavailable):
        guard.check()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("fault", ["none", "cutover_before_sql", "cutover_after_entry", "lost_reply", "wrong_receipt_owner", "seeded_owner_after_validation", "seeded_state_after_validation"])
async def test_actual_legacy_sdk_attempt_is_fenced(monkeypatch, provider, asynchronous, fault):
    from datetime import UTC, datetime, timedelta
    from types import SimpleNamespace
    from uuid import uuid4

    import httpx
    from test_mem00_model_clients import close_model, reply

    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextEntryMiddleware
    from deerflow.sophia.memory_governance import owner_authority
    from deerflow.sophia.memory_governance import observability
    from deerflow.sophia.memory_governance.legacy_model_dispatch import LegacyModelDispatchAuthority
    from deerflow.sophia.memory_governance import store as store_module
    from deerflow.sophia.memory_governance.input_provenance import INPUT_RUN_KEY
    from deerflow.sophia.memory_governance.model_clients import GovernedChatAnthropic, GovernedChatOpenAI, ModelDispatchDenied
    from deerflow.sophia.memory_governance.models import OwnerMemoryAuthority

    class Store:
        state = "legacy"
        calls = []

        def get_contract(self):
            return SimpleNamespace(schema_version="mem00.v1", contract_epoch=1, mode="enforced")

        def get_owner_authority(self, owner):
            return OwnerMemoryAuthority(user_id=owner, authority_state=self.state, authority_epoch=1, authority_declared_at=datetime.now(UTC))

        def authorize_legacy_model_dispatch(self, *, p_user_id, p_attempt):
            self.calls.append(p_attempt)
            if self.state != "legacy" or fault == "lost_reply":
                raise RuntimeError("synthetic final SQL rejection or lost reply")
            now = datetime.now(UTC)
            return {**p_attempt, "schema": "mem00.legacy-model-dispatch.v1", "owner_id": "other" if fault == "wrong_receipt_owner" else p_user_id,
                "event_id": str(uuid4()), "authority_state": "legacy", "canonical_approval_granted": False, "dispatch_observed": False,
                "single_use": True, "accepted_at": now.isoformat(), "expires_at": (now + timedelta(seconds=5)).isoformat()}

    store = Store()
    observability.reset_counters_for_test()
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "false")
    monkeypatch.setenv("SOPHIA_MEMORY_FAULT_INJECTION", "false")
    original_admit = LegacyModelDispatchAuthority.admit
    def seeded_admit(self, wire):
        receipt = original_admit(self, wire)
        if fault == "seeded_owner_after_validation":
            return receipt.model_copy(update={"owner_id": "synthetic-other-owner"})
        if fault == "seeded_state_after_validation":
            return receipt.model_copy(update={"authority_state": "governed"})
        return receipt
    monkeypatch.setattr(LegacyModelDispatchAuthority, "admit", seeded_admit)
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-legacy-model-secret-" * 2)
    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: store)
    monkeypatch.setattr(store_module, "configured_memory_store", lambda: store)
    guard = MemoryRunGuard(owner_id="owner", config={"langgraph_auth_user_id": "owner", "thread_id": str(uuid4()), INPUT_RUN_KEY: str(uuid4())})
    captured, sent = [], []

    def factory(wire):
        authority = guard.final_dispatch_authority(wire)
        captured.append(authority)
        if fault == "cutover_before_sql":
            store.state = "governed"
        return authority

    def network(transport, wire):
        sent.append(wire)
        if fault == "cutover_after_entry":
            store.state = "governed"
        return reply(provider, wire)

    async def async_network(transport, wire):
        return network(transport, wire)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", network)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", async_network)
    cls = GovernedChatAnthropic if provider == "anthropic" else GovernedChatOpenAI
    value = cls(model="existing-model", api_key="synthetic", max_retries=2, memory_authority_factory=factory)
    entry = MemoryContextEntryMiddleware(guard)
    try:
        async def invoke():
            if asynchronous:
                return await entry.awrap_model_call(None, lambda _: value.ainvoke("SYNTHETIC LEGACY SOURCE"))
            return entry.wrap_model_call(None, lambda _: value.invoke("SYNTHETIC LEGACY SOURCE"))

        seeded = fault.startswith("seeded_")
        sent_expected = fault in {"none", "cutover_after_entry"} or seeded
        if fault == "cutover_after_entry":
            # Earlier admission remains legitimate, but the existing post-model
            # guard must prevent the response reaching a later consumer.
            with pytest.raises(MemoryContextUnavailable):
                await invoke()
        elif sent_expected:
            assert await invoke()
        else:
            with pytest.raises(ModelDispatchDenied):
                await invoke()
        assert len(captured) == len(store.calls) == 1
        assert len(sent) == int(sent_expected)
        counters = observability.counter_snapshot()
        assert counters["memory_policy_escape_total"] == int(seeded)
        assert counters["memory_cross_owner_admission_total"] == int(fault == "seeded_owner_after_validation")
        assert not value._memory_lifetime.streams and value._memory_lifetime.owner is None
    finally:
        await close_model(value)
        observability.reset_counters_for_test()
