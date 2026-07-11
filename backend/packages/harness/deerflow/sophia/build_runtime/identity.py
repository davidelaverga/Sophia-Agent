from __future__ import annotations

import hashlib
import os
import threading
import time
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ID_LOCK = threading.Lock()
_LAST_ID_VALUE = 0
StableId = Annotated[str, Field(min_length=8, max_length=96, pattern=r"^[A-Za-z0-9:_-]+$")]


def _encode_crockford(value: int, length: int) -> str:
    chars = ["0"] * length
    for index in range(length - 1, -1, -1):
        chars[index] = _CROCKFORD[value & 31]
        value >>= 5
    return "".join(chars)


def new_monotonic_id(prefix: str) -> str:
    """Return a sortable ULID-shaped identifier without a third-party dependency."""
    global _LAST_ID_VALUE
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    candidate = (timestamp_ms << 80) | int.from_bytes(os.urandom(10), "big")
    with _ID_LOCK:
        candidate = max(candidate, _LAST_ID_VALUE + 1)
        _LAST_ID_VALUE = candidate
    return f"{prefix}_{_encode_crockford(candidate >> 80, 10)}{_encode_crockford(candidate & ((1 << 80) - 1), 16)}"


def new_build_id() -> str:
    return new_monotonic_id("build")


def new_operation_id() -> str:
    return new_monotonic_id("op")


def new_transaction_id() -> str:
    return new_monotonic_id("txn")


def new_version_id(kind: str = "ver") -> str:
    return new_monotonic_id(kind)


def component_id(build_id: str, selector: str) -> str:
    canonical = " ".join(selector.strip().split()).casefold()
    digest = hashlib.sha256(f"{build_id}\x1f{canonical}".encode()).hexdigest()[:24]
    return f"component_{digest}"


class BuildIdentity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    build_id: StableId
    logical_artifact_id: StableId | None = None
    current_artifact_version_id: StableId | None = None


class BuildOperationIdentity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    operation_id: StableId
    transaction_id: StableId | None = None
    quality_run_id: StableId | None = None
