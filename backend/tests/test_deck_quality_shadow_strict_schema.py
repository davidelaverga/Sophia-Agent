from __future__ import annotations

from typing import Any

from deerflow.sophia.deck_quality.schemas import (
    BlindVisualAssessment,
    PlanRealizationAssessment,
)
from deerflow.sophia.deck_quality.strict_schema import strict_model_json_schema


def _assert_strict(value: Any) -> None:
    if isinstance(value, list):
        for item in value:
            _assert_strict(item)
        return
    if not isinstance(value, dict):
        return
    properties = value.get("properties")
    if isinstance(properties, dict):
        assert value.get("additionalProperties") is False
        assert value.get("required") == list(properties)
    assert value.get("default", "not-none") is not None
    for child in value.values():
        _assert_strict(child)


def test_assessment_schemas_are_normalized_for_strict_json_output() -> None:
    for model in (BlindVisualAssessment, PlanRealizationAssessment):
        schema = strict_model_json_schema(model)

        _assert_strict(schema)
        assert schema["properties"]["uncertainties"]["items"]["$ref"].startswith("#/$defs/")
        assert "schema_version" in schema["required"]


def test_nullable_defaults_are_removed_but_non_null_defaults_remain() -> None:
    schema = strict_model_json_schema(BlindVisualAssessment)
    criterion = schema["$defs"]["CriterionScore"]

    assert "default" not in criterion["properties"]["score"]
    assert "default" not in criterion["properties"]["applicability_reason"]
    assert schema["properties"]["strengths"]["default"] == []
