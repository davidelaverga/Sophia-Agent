from __future__ import annotations

from dataclasses import dataclass

import pytest

from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift.graph import (
    DeckDesignLiftGraphError,
    DeckDesignLiftGraphRuntime,
    compile_deck_design_lift_graph,
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

    async def build_request(self, **_kwargs: object) -> DeckDesignLiftRequest:
        self.calls += 1
        return self.request


@dataclass
class _Controller:
    calls: int = 0

    async def run(self, request: DeckDesignLiftRequest) -> DeckDesignLiftResult:
        self.calls += 1
        return DeckDesignLiftResult(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            build_id=request.build_id,
            operation_id=request.operation_id,
            disposition="NO_REPAIR_NEEDED",
            terminal_code="no_repair_needed",
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
    assert controller.calls == 1
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
