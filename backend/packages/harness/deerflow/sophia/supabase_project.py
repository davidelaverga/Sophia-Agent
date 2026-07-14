"""Fail-fast guards that keep production services on one Supabase project."""

from __future__ import annotations

import os
from urllib.parse import urlparse


class SupabaseProjectMismatchError(RuntimeError):
    pass


def supabase_project_ref(url: str) -> str | None:
    hostname = (urlparse(url).hostname or "").lower().strip(".")
    labels = hostname.split(".")
    if len(labels) >= 3 and labels[-2:] in (["supabase", "co"], ["supabase", "com"]):
        if labels[0] == "db" and len(labels) >= 4:
            return labels[1]
        if labels[0] not in {"api", "pooler"}:
            return labels[0]
    return None


def validate_expected_supabase_project(
    *,
    url: str | None = None,
    expected_ref: str | None = None,
) -> str | None:
    expected = (expected_ref or os.getenv("SOPHIA_EXPECTED_SUPABASE_PROJECT_REF") or "").strip().lower()
    if not expected:
        return None
    configured_url = (url or os.getenv("SUPABASE_URL") or "").strip()
    if not configured_url:
        raise SupabaseProjectMismatchError(
            "SOPHIA_EXPECTED_SUPABASE_PROJECT_REF is set but SUPABASE_URL is missing"
        )
    actual = supabase_project_ref(configured_url)
    if actual != expected:
        raise SupabaseProjectMismatchError(
            f"Configured Supabase project does not match expected project ref {expected!r}"
        )
    return actual
