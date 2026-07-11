from __future__ import annotations

from enum import StrEnum


class BuildFoundationCapability(StrEnum):
    ABSOLUTE_DEADLINE = "absolute_deadline"
    STABLE_IDENTITY = "stable_identity"
    EVENT_JOURNAL = "event_journal"
    MANIFEST_CAS = "manifest_cas"
    IMMUTABLE_VERSIONS = "immutable_versions"
    MODEL_ROUTES = "model_routes"
    RESOURCE_BUDGETS = "resource_budgets"
    MUTATION_TRANSACTIONS = "mutation_transactions"
    SAFE_BOUNDARY = "safe_boundary"
    ARTIFACT_ACCEPTANCE = "artifact_acceptance"


FOUNDATION_CAPABILITIES = frozenset(BuildFoundationCapability)
