"""MEM00 durable memory authority.

Sophia's canonical database owns candidacy, consent, lifecycle, and content.
Mem0 is used only by :mod:`mem0_projection_adapter` as an approved semantic
projection.  Importing this package never initializes a provider client.
"""

from .flags import (
    MemoryFeatureFlags,
    memory_feature_flags,
    memory_feature_flags_for_owner,
)
from .refs import keyed_ref
from .service import CanonicalMemoryService, MemoryProviderContract

__all__ = [
    "CanonicalMemoryService",
    "MemoryFeatureFlags",
    "MemoryProviderContract",
    "keyed_ref",
    "memory_feature_flags",
    "memory_feature_flags_for_owner",
]
