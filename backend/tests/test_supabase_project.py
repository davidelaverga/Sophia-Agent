from __future__ import annotations

import pytest

from app.gateway.supabase_project import validate_expected_supabase_project as validate_gateway_supabase_project
from deerflow.sophia.supabase_project import (
    SupabaseProjectMismatchError,
    supabase_project_ref,
    validate_expected_supabase_project,
)


def test_extracts_rest_and_direct_database_project_refs() -> None:
    assert supabase_project_ref("https://vlxnwmyvhchwbousrdzc.supabase.co") == "vlxnwmyvhchwbousrdzc"
    assert supabase_project_ref("postgresql://postgres@db.vlxnwmyvhchwbousrdzc.supabase.co:5432/postgres") == "vlxnwmyvhchwbousrdzc"


def test_expected_project_guard_rejects_cross_project_configuration() -> None:
    with pytest.raises(SupabaseProjectMismatchError, match="does not match"):
        validate_expected_supabase_project(
            url="https://qtyqgvdkbhjfmnfkxyvm.supabase.co",
            expected_ref="vlxnwmyvhchwbousrdzc",
        )


def test_expected_project_guard_accepts_target() -> None:
    assert (
        validate_expected_supabase_project(
            url="https://vlxnwmyvhchwbousrdzc.supabase.co",
            expected_ref="vlxnwmyvhchwbousrdzc",
        )
        == "vlxnwmyvhchwbousrdzc"
    )


def test_gateway_project_guard_uses_the_same_target_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_EXPECTED_SUPABASE_PROJECT_REF", "vlxnwmyvhchwbousrdzc")
    monkeypatch.setenv("SUPABASE_URL", "https://vlxnwmyvhchwbousrdzc.supabase.co")

    assert validate_gateway_supabase_project() == "vlxnwmyvhchwbousrdzc"
