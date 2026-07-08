from __future__ import annotations

import re
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class DeckIRValidationError:
    slide_index: int | None
    field: str | None
    code: str
    summary: str
    retryable: bool

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class DeckIRRepairInstruction:
    should_retry: bool
    repair_message: str
    max_retry_count: int = 1
    validation_error: DeckIRValidationError | None = None

    def to_dict(self) -> dict:
        payload = asdict(self)
        if self.validation_error is not None:
            payload["validation_error"] = self.validation_error.to_dict()
        return payload


_SLIDE_FIELD_RE = re.compile(r"\bSlide\s+(?P<slide>\d+)\s+(?P<field>[A-Za-z_][\w-]*)\b")


def deck_ir_repair_instruction_from_failure(
    *,
    failure_code: str,
    failure_summary: str,
    retryable: bool,
    attempt_count: int,
) -> DeckIRRepairInstruction:
    validation_error = _validation_error_from_failure(
        failure_code=failure_code,
        failure_summary=failure_summary,
        retryable=retryable,
    )
    if failure_code != "invalid_deck_ir" or not retryable or attempt_count >= 1:
        return DeckIRRepairInstruction(
            should_retry=False,
            repair_message="",
            validation_error=validation_error,
        )
    field_phrase = _field_phrase(validation_error)
    return DeckIRRepairInstruction(
        should_retry=True,
        repair_message=(
            "Repair the Deck IR and call prepare_deck_build exactly once more. "
            f"{field_phrase}{failure_summary.strip()} Keep the same deck title, output path, "
            "register, and visual policy. Do not end the build until this single repair retry is attempted."
        ),
        validation_error=validation_error,
    )


def _validation_error_from_failure(
    *,
    failure_code: str,
    failure_summary: str,
    retryable: bool,
) -> DeckIRValidationError:
    match = _SLIDE_FIELD_RE.search(failure_summary or "")
    slide_index = int(match.group("slide")) if match else None
    field = match.group("field") if match else None
    return DeckIRValidationError(
        slide_index=slide_index,
        field=field,
        code=failure_code,
        summary=failure_summary,
        retryable=retryable,
    )


def _field_phrase(error: DeckIRValidationError) -> str:
    if error.slide_index is None or not error.field:
        return ""
    return f"Slide {error.slide_index} has an invalid {error.field}: "
