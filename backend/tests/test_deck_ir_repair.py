from __future__ import annotations

from deerflow.sophia.deck_build.ir_repair import deck_ir_repair_instruction_from_failure


def test_retryable_invalid_deck_ir_first_attempt_gets_instruction() -> None:
    instruction = deck_ir_repair_instruction_from_failure(
        failure_code="invalid_deck_ir",
        failure_summary="Slide 2 narrative is required and must be <= 280 chars.",
        retryable=True,
        attempt_count=0,
    )

    assert instruction.should_retry is True
    assert instruction.max_retry_count == 1
    assert "prepare_deck_build exactly once more" in instruction.repair_message
    assert "Slide 2" in instruction.repair_message
    assert instruction.validation_error is not None
    assert instruction.validation_error.slide_index == 2
    assert instruction.validation_error.field == "narrative"


def test_retryable_invalid_deck_ir_second_attempt_does_not_retry() -> None:
    instruction = deck_ir_repair_instruction_from_failure(
        failure_code="invalid_deck_ir",
        failure_summary="Slide 2 narrative is required and must be <= 280 chars.",
        retryable=True,
        attempt_count=1,
    )

    assert instruction.should_retry is False


def test_non_retryable_failure_does_not_retry() -> None:
    instruction = deck_ir_repair_instruction_from_failure(
        failure_code="deck_native_unavailable",
        failure_summary="Native deck service is unavailable.",
        retryable=False,
        attempt_count=0,
    )

    assert instruction.should_retry is False
