"""Default-closed, server-authorized MEM00 rollout flags."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


def _true(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


class MemoryFlagConfigurationError(RuntimeError):
    """The configured combination could expose two memory authorities."""


@dataclass(frozen=True)
class MemoryFeatureFlags:
    candidate_ledger_write: bool = False
    candidate_ledger_read: bool = False
    canonical_pool_read: bool = False
    provider_projection: bool = False
    governed_runtime_read: bool = False
    legacy_inventory: bool = False
    legacy_import: bool = False
    memory_fault_injection: bool = False

    @classmethod
    def from_environ(cls, environ: Mapping[str, str] | None = None) -> MemoryFeatureFlags:
        values = environ if environ is not None else os.environ
        prefix = "SOPHIA_MEMORY_"
        result = cls(
            candidate_ledger_write=_true(values.get(prefix + "CANDIDATE_LEDGER_WRITE")),
            candidate_ledger_read=_true(values.get(prefix + "CANDIDATE_LEDGER_READ")),
            canonical_pool_read=_true(values.get(prefix + "CANONICAL_POOL_READ")),
            provider_projection=_true(values.get(prefix + "PROVIDER_PROJECTION")),
            governed_runtime_read=_true(values.get(prefix + "GOVERNED_RUNTIME_READ")),
            legacy_inventory=_true(values.get(prefix + "LEGACY_INVENTORY")),
            legacy_import=_true(values.get(prefix + "LEGACY_IMPORT")),
            memory_fault_injection=_true(values.get(prefix + "FAULT_INJECTION")),
        )
        result.validate()
        return result

    def validate(self) -> None:
        if self.candidate_ledger_read and not self.candidate_ledger_write:
            raise MemoryFlagConfigurationError("memory_ledger_read_without_write")
        if self.canonical_pool_read and not self.candidate_ledger_read:
            raise MemoryFlagConfigurationError("memory_canonical_pool_without_ledger")
        if self.provider_projection and not self.canonical_pool_read:
            raise MemoryFlagConfigurationError("memory_projection_without_canonical_authority")
        if self.governed_runtime_read and not self.provider_projection:
            raise MemoryFlagConfigurationError("memory_runtime_read_without_projection")
        if self.legacy_import and not self.legacy_inventory:
            raise MemoryFlagConfigurationError("memory_legacy_import_without_inventory")
        if self.memory_fault_injection and not self.provider_projection:
            raise MemoryFlagConfigurationError("memory_faults_without_projection")

    def as_dict(self) -> dict[str, bool]:
        return {
            "candidate_ledger_write": self.candidate_ledger_write,
            "candidate_ledger_read": self.candidate_ledger_read,
            "canonical_pool_read": self.canonical_pool_read,
            "provider_projection": self.provider_projection,
            "governed_runtime_read": self.governed_runtime_read,
            "legacy_inventory": self.legacy_inventory,
            "legacy_import": self.legacy_import,
            "memory_fault_injection": self.memory_fault_injection,
        }

    def any_enabled(self) -> bool:
        return any(self.as_dict().values())


def memory_cohort_principals(
    environ: Mapping[str, str] | None = None,
) -> frozenset[str]:
    values = environ if environ is not None else os.environ
    raw = values.get("SOPHIA_MEMORY_COHORT_PRINCIPALS") or ""
    return frozenset(item.strip() for item in raw.split(",") if item.strip())


def memory_feature_flags(environ: Mapping[str, str] | None = None) -> MemoryFeatureFlags:
    return MemoryFeatureFlags.from_environ(environ)


def memory_feature_flags_for_owner(
    owner_id: str,
    environ: Mapping[str, str] | None = None,
) -> MemoryFeatureFlags:
    """Return enabled flags only for an exact server-authorized principal.

    A nonempty feature configuration without an explicit cohort is rejected at
    request time. Nonmembers retain the pre-cutover behavior while the global
    contract is in shadow mode; no MEM00 writer or reader activates for them.
    """

    flags = memory_feature_flags(environ)
    if not flags.any_enabled():
        return flags
    principals = memory_cohort_principals(environ)
    if not principals:
        raise MemoryFlagConfigurationError("memory_features_without_cohort")
    return flags if owner_id.strip() in principals else MemoryFeatureFlags()
