"""Identity containment for MEM00 certification and Voice Lab isolation."""

from __future__ import annotations

import os


class MemoryIdentityConfigurationError(RuntimeError):
    pass


def memory_certification_principal() -> str:
    principal = (os.getenv("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL") or "").strip()
    if not principal:
        raise MemoryIdentityConfigurationError("memory_certification_principal_missing")
    voice_lab = (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip()
    if voice_lab and principal == voice_lab:
        raise MemoryIdentityConfigurationError("memory_and_voice_lab_principals_overlap")
    return principal


def assert_not_voice_lab_principal(user_id: str) -> None:
    voice_lab = (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip()
    if voice_lab and user_id == voice_lab:
        raise MemoryIdentityConfigurationError("voice_lab_principal_memory_forbidden")
