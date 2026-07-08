from __future__ import annotations

import json
from types import SimpleNamespace

import deerflow.sophia.tools.prepare_deck_build as prepare_module
from deerflow.sophia.deck_build.models import DeckBuildResult


class _RetryableInvalidIRService:
    def prepare_and_build(self, **_kwargs):
        return DeckBuildResult(
            success=False,
            build_id="deck-test",
            deck_build_path="/mnt/user-data/outputs/deck_build/build.json",
            failure_code="invalid_deck_ir",
            failure_summary="Slide 2 narrative is required and must be <= 280 chars.",
            retryable=True,
        )


class _TerminalNativeFailureService:
    def prepare_and_build(self, **_kwargs):
        return DeckBuildResult(
            success=False,
            build_id="deck-test",
            deck_build_path="/mnt/user-data/outputs/deck_build/build.json",
            failure_code="deck_native_unavailable",
            failure_summary="Native deck service is unavailable.",
            retryable=False,
        )


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(state={}, context={}, config={})


def test_prepare_deck_build_adds_repair_instruction_for_retryable_ir(monkeypatch) -> None:
    monkeypatch.setattr(prepare_module, "DeckBuildService", _RetryableInvalidIRService)

    raw = prepare_module.prepare_deck_build.func(
        runtime=_runtime(),
        deck_title="Deck",
        slides=[],
        output_path="/mnt/user-data/outputs/deck.pptx",
    )

    payload = json.loads(raw)
    assert payload["success"] is False
    assert payload["retryable"] is True
    assert payload["repair_instruction"]["should_retry"] is True
    assert "prepare_deck_build exactly once more" in payload["repair_instruction"]["repair_message"]


def test_prepare_deck_build_omits_repair_instruction_for_terminal_failure(monkeypatch) -> None:
    monkeypatch.setattr(prepare_module, "DeckBuildService", _TerminalNativeFailureService)

    raw = prepare_module.prepare_deck_build.func(
        runtime=_runtime(),
        deck_title="Deck",
        slides=[],
        output_path="/mnt/user-data/outputs/deck.pptx",
    )

    payload = json.loads(raw)
    assert payload["success"] is False
    assert "repair_instruction" not in payload
