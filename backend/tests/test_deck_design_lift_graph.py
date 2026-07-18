from __future__ import annotations

import threading
from dataclasses import dataclass

import pytest

from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift.graph import (
    DeckDesignLiftGraphError,
    DeckDesignLiftGraphRuntime,
    compile_deck_design_lift_graph,
    make_deck_design_lift_graph,
)
from deerflow.sophia.deck_design_lift.runtime import (
    DeckDesignLiftRequest,
    DeckDesignLiftResult,
)
from deerflow.sophia.deck_design_lift.schemas import SelectorSourceAuthorization

CANARY = "canary-user-01"


def _artifact() -> BuildArtifactVersion:
    return BuildArtifactVersion(
        version_id="artifact-version-01",
        build_id="build-0001",
        logical_artifact_id="logical-artifact-01",
        manifest_revision=1,
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        artifact_hash="a" * 64,
        storage_object_path=("artifacts/canary-user-01/thread-0001/foundation/.builder/builds/build-0001/artifacts/artifact-version-01/deck.pptx"),
        verified=True,
    )


def _request(**updates: object) -> DeckDesignLiftRequest:
    values: dict[str, object] = {
        "campaign_run_id": "campaign-0001",
        "experiment_id": "experiment-0001",
        "build_id": "build-0001",
        "user_id": CANARY,
        "operation_id": "operation-0001",
        "lease_owner": "lease-owner-0001",
        "expected_manifest_revision": 1,
        "initial_artifact": _artifact(),
        "source_authorizations": (
            SelectorSourceAuthorization(
                selector="slide:1",
                source_roles=("body", "slide_css"),
            ),
        ),
        "rubric_version": "deck-rubric-v2",
        "instrument_hash": "b" * 64,
    }
    values.update(updates)
    return DeckDesignLiftRequest.model_validate(values)


def _state(**updates: object) -> dict[str, object]:
    values: dict[str, object] = {
        "campaign_run_id": "campaign-0001",
        "experiment_id": "experiment-0001",
        "build_id": "build-0001",
        "user_id": CANARY,
        "operation_id": "operation-0001",
        "lease_owner": "lease-owner-0001",
    }
    values.update(updates)
    return values


@dataclass
class _Factory:
    request: DeckDesignLiftRequest
    calls: int = 0
    transaction_ids: list[str | None] | None = None

    async def build_request(self, **kwargs: object) -> DeckDesignLiftRequest:
        self.calls += 1
        transaction_id = kwargs.get("transaction_id")
        assert isinstance(transaction_id, str) or transaction_id is None
        if self.transaction_ids is None:
            self.transaction_ids = []
        self.transaction_ids.append(transaction_id)
        return self.request.model_copy(update={"transaction_id": transaction_id})


@dataclass
class _Controller:
    calls: int = 0
    recovery_calls: int = 0
    recovered_transaction_id: str | None = None

    async def recover_incomplete(self, **_kwargs: object) -> str | None:
        self.recovery_calls += 1
        return self.recovered_transaction_id

    async def run(self, request: DeckDesignLiftRequest) -> DeckDesignLiftResult:
        self.calls += 1
        return DeckDesignLiftResult(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            build_id=request.build_id,
            operation_id=request.operation_id,
            disposition="NO_REPAIR_NEEDED",
            terminal_code="no_repair_needed",
            transaction_id=request.transaction_id,
            initial_quality_run_id="quality_initial_01",
        )


@pytest.mark.anyio
async def test_graph_runs_only_safe_identifiers_and_projects_safe_result() -> None:
    factory = _Factory(_request())
    controller = _Controller()
    graph = compile_deck_design_lift_graph(
        DeckDesignLiftGraphRuntime(
            controller=controller,
            request_factory=factory,
            canary_user_ids=frozenset({CANARY}),
        )
    )

    result = await graph.ainvoke(_state())

    assert factory.calls == 1
    assert factory.transaction_ids == [None]
    assert controller.calls == 1
    assert controller.recovery_calls == 1
    assert result["disposition"] == "NO_REPAIR_NEEDED"
    assert result["terminal_code"] == "no_repair_needed"
    assert result["initial_quality_run_id"] == "quality_initial_01"
    assert "initial_artifact" not in result
    assert "source_authorizations" not in result
    assert "repair_program" not in result


@pytest.mark.anyio
async def test_graph_rejects_non_canary_before_request_loading() -> None:
    factory = _Factory(_request())
    graph = compile_deck_design_lift_graph(
        DeckDesignLiftGraphRuntime(
            controller=_Controller(),
            request_factory=factory,
            canary_user_ids=frozenset({CANARY}),
        )
    )

    with pytest.raises(DeckDesignLiftGraphError, match="canary_scope_mismatch"):
        await graph.ainvoke(_state(user_id="different-user-01"))

    assert factory.calls == 0


@pytest.mark.anyio
async def test_graph_rejects_request_factory_identity_drift() -> None:
    factory = _Factory(_request(build_id="build-0002", initial_artifact=_artifact().model_copy(update={"build_id": "build-0002"})))
    controller = _Controller()
    graph = compile_deck_design_lift_graph(
        DeckDesignLiftGraphRuntime(
            controller=controller,
            request_factory=factory,
            canary_user_ids=frozenset({CANARY}),
        )
    )

    with pytest.raises(DeckDesignLiftGraphError, match="request_identity_mismatch"):
        await graph.ainvoke(_state())

    assert controller.calls == 0


@pytest.mark.anyio
async def test_graph_recovers_matching_transaction_before_request_loading() -> None:
    transaction_id = "transaction-recovered-0001"
    factory = _Factory(_request())
    controller = _Controller(recovered_transaction_id=transaction_id)
    graph = compile_deck_design_lift_graph(
        DeckDesignLiftGraphRuntime(
            controller=controller,
            request_factory=factory,
            canary_user_ids=frozenset({CANARY}),
        )
    )

    result = await graph.ainvoke(_state())

    assert controller.recovery_calls == 1
    assert factory.transaction_ids == [transaction_id]
    assert result["transaction_id"] == transaction_id
    assert result["terminal_code"] == "no_repair_needed"


@pytest.mark.anyio
async def test_graph_skips_recovery_for_explicit_transaction() -> None:
    transaction_id = "transaction-explicit-0001"
    factory = _Factory(_request())
    controller = _Controller()
    graph = compile_deck_design_lift_graph(
        DeckDesignLiftGraphRuntime(
            controller=controller,
            request_factory=factory,
            canary_user_ids=frozenset({CANARY}),
        )
    )

    result = await graph.ainvoke(_state(transaction_id=transaction_id))

    assert controller.recovery_calls == 0
    assert factory.transaction_ids == [transaction_id]
    assert result["terminal_code"] == "no_repair_needed"


def test_graph_runtime_rejects_open_scope_and_unlocked_deadline() -> None:
    with pytest.raises(ValueError, match="exact canary"):
        DeckDesignLiftGraphRuntime(
            controller=_Controller(),
            request_factory=_Factory(_request()),
            canary_user_ids=frozenset(),
        )
    with pytest.raises(ValueError, match="deadline"):
        DeckDesignLiftGraphRuntime(
            controller=_Controller(),
            request_factory=_Factory(_request()),
            canary_user_ids=frozenset({CANARY}),
            timeout_seconds=299,
        )


@pytest.mark.anyio
async def test_registered_factory_closes_request_scoped_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia.deck_design_lift import runner

    closed: list[str] = []
    factory_threads: list[int] = []
    event_loop_thread = threading.get_ident()

    class _ManagedRuntime(DeckDesignLiftGraphRuntime):
        async def aclose(self) -> None:
            closed.append("closed")

    runtime = _ManagedRuntime(
        controller=_Controller(),
        request_factory=_Factory(_request()),
        canary_user_ids=frozenset({CANARY}),
    )

    def configured_runtime() -> _ManagedRuntime:
        factory_threads.append(threading.get_ident())
        return runtime

    monkeypatch.setattr(runner, "configured_graph_runtime", configured_runtime)

    async with make_deck_design_lift_graph({}) as graph:
        assert closed == []
        result = await graph.ainvoke(_state())
        assert result["terminal_code"] == "no_repair_needed"

    assert closed == ["closed"]
    assert len(factory_threads) == 1
    assert factory_threads[0] != event_loop_thread
