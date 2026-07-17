"""Independent durable evidence for a DQ-1 producer double-storage failure.

The canonical producer outbox and its content-free object-store failure marker
share one storage provider.  If both writes fail, LangGraph sends this tiny
authenticated signal to the gateway, which records it through a service-role
RPC.  The payload contains identities and failure codes only: never deck/source
bytes, prompts, URLs, model output, or credentials.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from datetime import datetime
from typing import Literal, Protocol, Self, runtime_checkable

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.sophia.deck_quality.persistence import (
    DeckQualityPersistenceConfig,
    DeckQualityPersistenceProtocolError,
    DeckQualityPersistenceRpcError,
)

PRODUCER_FAILURE_SIGNAL_SCHEMA_VERSION = (
    "deck-quality-producer-failure-signal/v1"
)
PRODUCER_FAILURE_SIGNAL_CODE = "shadow_dispatch_unavailable"
MAX_PRODUCER_FAILURE_SIGNAL_BODY_BYTES = 2 * 1024
PRODUCER_FAILURE_HMAC_PROBE_USER_ID = (
    "__sophia_dq1_hmac_probe_reserved_noncanary__"
)
PRODUCER_FAILURE_HMAC_PROBE_CANDIDATE_DIGEST = (
    "ebf93716177a0c737cf2f0182c333e6c9c08d65817f218de23b491f33cdccc65"
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_QUALITY_RUN_ID_RE = re.compile(r"^quality_[0-9a-f]{64}$")
_STAGE_CODES = {
    "candidate_metadata": "candidate_metadata_invalid",
    "instrument": "instrument_invalid",
    "producer_bundle": "producer_bundle_unavailable",
}

ProducerFailureStage = Literal[
    "candidate_metadata",
    "instrument",
    "producer_bundle",
]
ProducerUpstreamFailureCode = Literal[
    "candidate_metadata_invalid",
    "instrument_invalid",
    "producer_bundle_unavailable",
]
ProducerFailureSignalOutcome = Literal["created", "replayed", "conflict"]


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProducerFailureSignal(_FrozenModel):
    """Strict content-free wire and durable identity."""

    schema_version: Literal[
        "deck-quality-producer-failure-signal/v1"
    ] = PRODUCER_FAILURE_SIGNAL_SCHEMA_VERSION
    campaign_id: Literal["DQ-1"] = "DQ-1"
    candidate_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    user_id: str = Field(min_length=1, max_length=256)
    failure_code: Literal[
        "shadow_dispatch_unavailable"
    ] = PRODUCER_FAILURE_SIGNAL_CODE
    failure_stage: ProducerFailureStage
    upstream_failure_code: ProducerUpstreamFailureCode
    quality_run_id: str | None = Field(
        default=None,
        pattern=r"^quality_[0-9a-f]{64}$",
    )
    canary_scope_proof: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
        exclude_if=lambda value: value is None,
    )

    @field_validator("user_id")
    @classmethod
    def validate_user_id(cls, value: str) -> str:
        if value != value.strip() or "\x00" in value:
            raise ValueError("producer failure signal user identity is invalid")
        return value

    @model_validator(mode="after")
    def validate_stage_code(self) -> Self:
        if _STAGE_CODES.get(self.failure_stage) != self.upstream_failure_code:
            raise ValueError("producer failure signal stage/code mismatch")
        reserved_probe = bool(
            self.candidate_digest
            == PRODUCER_FAILURE_HMAC_PROBE_CANDIDATE_DIGEST
            and self.user_id == PRODUCER_FAILURE_HMAC_PROBE_USER_ID
            and self.failure_stage == "candidate_metadata"
            and self.upstream_failure_code == "candidate_metadata_invalid"
            and self.quality_run_id is None
        )
        if self.canary_scope_proof is not None and not reserved_probe:
            raise ValueError(
                "producer failure canary scope proof is probe-only"
            )
        return self

    @property
    def signal_hash(self) -> str:
        """PostgreSQL-reproducible semantic replay fingerprint."""

        material = "\x1f".join(
            (
                self.schema_version,
                self.campaign_id,
                self.candidate_digest,
                self.user_id,
                self.failure_code,
                self.failure_stage,
                self.upstream_failure_code,
                self.quality_run_id or "",
            )
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    def rpc_payload(self) -> dict[str, str | None]:
        return {
            "p_schema_version": self.schema_version,
            "p_campaign_id": self.campaign_id,
            "p_candidate_digest": self.candidate_digest,
            "p_user_id": self.user_id,
            "p_failure_code": self.failure_code,
            "p_failure_stage": self.failure_stage,
            "p_upstream_failure_code": self.upstream_failure_code,
            "p_quality_run_id": self.quality_run_id,
            "p_signal_hash": self.signal_hash,
        }


def producer_failure_hmac_probe_signal(
    *,
    canary_scope_proof: str | None = None,
) -> ProducerFailureSignal:
    """Return the canonical reserved signal that must never be a canary."""

    return ProducerFailureSignal(
        candidate_digest=PRODUCER_FAILURE_HMAC_PROBE_CANDIDATE_DIGEST,
        user_id=PRODUCER_FAILURE_HMAC_PROBE_USER_ID,
        failure_stage="candidate_metadata",
        upstream_failure_code="candidate_metadata_invalid",
        canary_scope_proof=canary_scope_proof,
    )


def is_producer_failure_hmac_probe(
    signal: ProducerFailureSignal,
) -> bool:
    """Identify the reserved auth-only signal before any durable side effect."""

    return bool(
        signal.candidate_digest
        == PRODUCER_FAILURE_HMAC_PROBE_CANDIDATE_DIGEST
        and signal.user_id == PRODUCER_FAILURE_HMAC_PROBE_USER_ID
        and signal.failure_stage == "candidate_metadata"
        and signal.upstream_failure_code == "candidate_metadata_invalid"
        and signal.quality_run_id is None
    )


class ProducerFailureSignalReadiness(_FrozenModel):
    persisted_count: int = Field(ge=0)
    unresolved_count: int = Field(ge=0)
    conflict_count: int = Field(ge=0)
    oldest_unresolved_at: datetime | None = None

    @model_validator(mode="after")
    def validate_counts(self) -> Self:
        if self.unresolved_count > self.persisted_count:
            raise ValueError("producer failure readiness counts are inconsistent")
        if (self.unresolved_count == 0) != (self.oldest_unresolved_at is None):
            raise ValueError("producer failure readiness timestamp is inconsistent")
        return self

    def component(self) -> dict[str, object]:
        counts = {
            "persisted": self.persisted_count,
            "unresolved": self.unresolved_count,
            "conflicts": self.conflict_count,
        }
        if self.unresolved_count:
            result: dict[str, object] = {
                "status": "degraded",
                "reason": "producer_failure_signal_unresolved",
                "counts": counts,
                "transport": {"status": "ready"},
            }
            assert self.oldest_unresolved_at is not None
            result["oldest_unresolved_at"] = (
                self.oldest_unresolved_at.isoformat()
            )
            return result
        return {
            "status": "ready",
            "counts": counts,
            "transport": {"status": "ready"},
        }


class ProducerFailureSignalReceipt(ProducerFailureSignalReadiness):
    outcome: ProducerFailureSignalOutcome
    candidate_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    signal_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


@runtime_checkable
class ProducerFailureSignalRpcClient(Protocol):
    async def call(
        self,
        operation: str,
        payload: Mapping[str, object],
    ) -> object: ...


class SupabaseProducerFailureSignalRpcClient:
    """Small service-role RPC client owned by the gateway only."""

    def __init__(
        self,
        config: DeckQualityPersistenceConfig,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = config
        self._client = client or httpx.AsyncClient(timeout=2.0)
        self._owns_client = client is None

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._config.service_role_key}",
            "apikey": self._config.service_role_key,
            "Content-Type": "application/json",
        }

    async def call(
        self,
        operation: str,
        payload: Mapping[str, object],
    ) -> object:
        try:
            response = await self._client.post(
                f"{self._config.url}/rest/v1/rpc/{operation}",
                headers=self._headers(),
                json=dict(payload),
            )
        except httpx.HTTPError:
            raise DeckQualityPersistenceRpcError(operation) from None
        if response.status_code >= 400:
            raise DeckQualityPersistenceRpcError(
                operation,
                status_code=response.status_code,
            ) from None
        if not response.content:
            raise DeckQualityPersistenceProtocolError(
                f"producer failure signal RPC returned no record operation={operation}"
            )
        try:
            return response.json()
        except ValueError:
            raise DeckQualityPersistenceProtocolError(
                f"producer failure signal RPC returned invalid JSON operation={operation}"
            ) from None

    async def probe(self) -> None:
        required = {
            "/rpc/sophia_record_deck_quality_producer_failure_signal",
            "/rpc/sophia_get_deck_quality_producer_failure_readiness",
            "/rpc/sophia_resolve_deck_quality_producer_failure_signal",
        }
        try:
            response = await self._client.get(
                f"{self._config.url}/rest/v1/",
                headers={
                    **self._headers(),
                    "Accept": "application/openapi+json",
                },
            )
        except httpx.HTTPError:
            raise DeckQualityPersistenceRpcError(
                "producer_failure_signal_probe"
            ) from None
        if response.status_code >= 400:
            raise DeckQualityPersistenceRpcError(
                "producer_failure_signal_probe",
                status_code=response.status_code,
            ) from None
        try:
            paths = set(response.json()["paths"])
        except (ValueError, KeyError, TypeError):
            raise DeckQualityPersistenceProtocolError(
                "producer failure signal OpenAPI probe was invalid"
            ) from None
        if not required.issubset(paths):
            raise DeckQualityPersistenceProtocolError(
                "producer failure signal OpenAPI probe is missing required RPCs"
            )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


class SupabaseProducerFailureSignalStore:
    """Gateway-owned durable producer failure evidence API."""

    def __init__(self, rpc_client: ProducerFailureSignalRpcClient) -> None:
        self._rpc = rpc_client

    async def probe(self) -> None:
        probe = getattr(self._rpc, "probe", None)
        if not callable(probe):
            raise DeckQualityPersistenceProtocolError(
                "producer failure signal RPC client is not probeable"
            )
        await probe()

    async def aclose(self) -> None:
        close = getattr(self._rpc, "aclose", None)
        if callable(close):
            await close()

    async def _one(
        self,
        operation: str,
        payload: Mapping[str, object],
        model: type[_FrozenModel],
    ) -> _FrozenModel:
        raw = await self._rpc.call(operation, payload)
        if not isinstance(raw, list) or len(raw) != 1 or not isinstance(
            raw[0], dict
        ):
            raise DeckQualityPersistenceProtocolError(
                f"producer failure signal response shape invalid operation={operation}"
            )
        try:
            return model.model_validate(raw[0])
        except (TypeError, ValueError):
            raise DeckQualityPersistenceProtocolError(
                f"producer failure signal response validation failed operation={operation}"
            ) from None

    async def record(
        self,
        signal: ProducerFailureSignal,
    ) -> ProducerFailureSignalReceipt:
        result = await self._one(
            "sophia_record_deck_quality_producer_failure_signal",
            signal.rpc_payload(),
            ProducerFailureSignalReceipt,
        )
        assert isinstance(result, ProducerFailureSignalReceipt)
        if (
            result.candidate_digest != signal.candidate_digest
            or (
                result.outcome != "conflict"
                and result.signal_hash != signal.signal_hash
            )
        ):
            raise DeckQualityPersistenceProtocolError(
                "producer failure signal receipt identity mismatch"
            )
        return result

    async def readiness(self) -> ProducerFailureSignalReadiness:
        result = await self._one(
            "sophia_get_deck_quality_producer_failure_readiness",
            {},
            ProducerFailureSignalReadiness,
        )
        assert isinstance(result, ProducerFailureSignalReadiness)
        return result

    async def resolve(
        self,
        *,
        candidate_digest: str,
        expected_signal_hash: str,
        resolution_code: Literal[
            "canonical_recovery_verified",
            "operator_acknowledged",
        ],
    ) -> ProducerFailureSignalReadiness:
        if _SHA256_RE.fullmatch(candidate_digest) is None:
            raise ValueError("producer failure candidate digest is invalid")
        if _SHA256_RE.fullmatch(expected_signal_hash) is None:
            raise ValueError("producer failure signal hash is invalid")
        material = "\x1f".join(
            (candidate_digest, expected_signal_hash, resolution_code)
        )
        resolution_hash = hashlib.sha256(material.encode("utf-8")).hexdigest()
        result = await self._one(
            "sophia_resolve_deck_quality_producer_failure_signal",
            {
                "p_candidate_digest": candidate_digest,
                "p_expected_signal_hash": expected_signal_hash,
                "p_resolution_code": resolution_code,
                "p_resolution_hash": resolution_hash,
            },
            ProducerFailureSignalReadiness,
        )
        assert isinstance(result, ProducerFailureSignalReadiness)
        return result


def configured_producer_failure_signal_store(
) -> SupabaseProducerFailureSignalStore | None:
    config = DeckQualityPersistenceConfig.from_env()
    if config is None:
        return None
    return SupabaseProducerFailureSignalStore(
        SupabaseProducerFailureSignalRpcClient(config)
    )
