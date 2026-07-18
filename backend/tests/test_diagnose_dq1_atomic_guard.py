from __future__ import annotations

import pytest

from scripts import diagnose_dq1_atomic_guard as diagnostic


@pytest.mark.parametrize(
    ("row", "reason"),
    (
        ((False, True, True, True, True, True, False, 3), "environment_invalid"),
        ((True, True, False, True, True, True, False, 3), "publication_table_missing"),
        ((True, True, True, False, True, True, False, 3), "required_split_routine_missing"),
        ((True, True, True, True, True, True, False, 2), "unexpected_target_routine_count"),
        ((True, True, True, True, True, True, True, 3), "unexpected_target_routine_count"),
        ((True, False, True, True, True, True, False, 3), "postgres_major_not_16"),
        ((True, True, True, True, True, True, False, 3), None),
        ((True, True, True, True, True, True, True, 4), None),
        ((True,), "probe_shape_invalid"),
    ),
)
def test_basic_classifier_is_static_and_ordered(row: tuple[object, ...], reason: str | None) -> None:
    assert diagnostic._classify_basic(row) == reason


@pytest.mark.parametrize(
    ("row", "reason"),
    (
        ((True, True, True, True), "legacy_rows_present"),
        ((False, False, True, True), "legacy_prosrc_mismatch"),
        ((False, True, False, True), "legacy_prosrc_mismatch"),
        ((False, True, True, False), "legacy_prosrc_mismatch"),
        ((False, True, True, True), "deep_table_or_routine_catalog_mismatch"),
        ((False,), "probe_shape_invalid"),
    ),
)
def test_legacy_detail_classifier_never_returns_probe_values(row: tuple[object, ...], reason: str) -> None:
    assert diagnostic._classify_legacy_detail(row) == reason
