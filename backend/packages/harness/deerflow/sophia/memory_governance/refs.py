"""Domain-separated keyed references for content-free evidence."""

from __future__ import annotations

import hashlib
import hmac
import os


class MemoryReferenceConfigurationError(RuntimeError):
    pass


def _secret(secret: bytes | None = None) -> bytes:
    resolved = secret if secret is not None else os.getenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "").encode()
    if len(resolved) < 32:
        raise MemoryReferenceConfigurationError("memory_reference_hmac_secret_invalid")
    return resolved


def keyed_ref(domain: str, value: str | bytes, *, secret: bytes | None = None) -> str:
    """Return a non-reversible stable reference without logging the input."""

    normalized_domain = domain.strip().lower()
    if not normalized_domain or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789._-" for ch in normalized_domain):
        raise ValueError("memory_reference_domain_invalid")
    payload = value if isinstance(value, bytes) else value.encode()
    digest = hmac.new(
        _secret(secret),
        b"sophia.mem00.ref.v1\x00" + normalized_domain.encode() + b"\x00" + payload,
        hashlib.sha256,
    ).hexdigest()
    return f"hmac-sha256:{normalized_domain}:{digest}"


def request_digest(payload: bytes, *, secret: bytes | None = None) -> str:
    return keyed_ref("request", payload, secret=secret)
