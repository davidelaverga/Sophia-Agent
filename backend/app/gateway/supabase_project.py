"""Gateway-owned fail-fast guard for the production Supabase target."""

from __future__ import annotations

import os
from urllib.parse import urlparse


def validate_expected_supabase_project() -> str | None:
    expected = (os.getenv("SOPHIA_EXPECTED_SUPABASE_PROJECT_REF") or "").strip().lower()
    if not expected:
        return None
    configured_url = (os.getenv("SUPABASE_URL") or "").strip()
    if not configured_url:
        raise RuntimeError("SOPHIA_EXPECTED_SUPABASE_PROJECT_REF is set but SUPABASE_URL is missing")
    hostname = (urlparse(configured_url).hostname or "").lower().strip(".")
    actual = hostname.split(".", 1)[0] if hostname.endswith(".supabase.co") else None
    if actual != expected:
        raise RuntimeError(f"Configured Supabase project does not match expected project ref {expected!r}")
    return actual
