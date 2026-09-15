"""One-use SQL permission for an exact, already-serialized model request.

An earlier retrieval receipt proves neither final admission nor transmission.
The source and inclusion manifests must come from trusted run governance, not
client input. Factories/transport wiring and dispatch observation are separate.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from time import monotonic
from typing import Literal

import httpx
from pydantic import Field, field_validator, model_validator

from .builder_source_binding import BuilderRunBinding
from .completion_source_binding import CompletionRunBinding
from .identity import assert_not_voice_lab_principal
from .refs import keyed_ref
from .source_dependencies import SourceDependency
from .source_input_provenance import SourceInputWitness
from .source_intake import HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable

MAX_MODEL_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True)
class ModelPayloadSnapshot:
    payload_ref: str
    endpoint_ref: str
    model_ref: str


def snapshot_model_request(request: httpx.Request) -> ModelPayloadSnapshot:
    """Hash exact wire bytes and endpoint-affecting headers, never export text."""
    try:
        if request.method != "POST" or not request.url.host or request.url.scheme not in {"http", "https"}:
            raise ValueError("request")
        body = request.content
        if not isinstance(body, bytes) or not 0 < len(body) <= MAX_MODEL_BYTES:
            raise ValueError("body")
        text = body.decode("utf-8")
        value = json.loads(text)
        if not isinstance(value, dict) or not isinstance(value.get("model"), str) or not 0 < len(value["model"]) <= 512:
            raise ValueError("model")
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError("content_type")
        # Credentials are neither copied into records nor used as authority.
        # Version/beta/project and retry headers remain part of the exact route.
        headers = sorted((key.lower(), item) for key, item in request.headers.multi_items()
            if key.lower() not in {"authorization", "x-api-key", "cookie", "proxy-authorization"})
        endpoint = json.dumps({"method": request.method, "url": str(request.url), "headers": headers},
            ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        return ModelPayloadSnapshot(keyed_ref("model-payload", text), keyed_ref("model-endpoint", endpoint), keyed_ref("model-route", value["model"]))
    except Exception:
        raise MemoryGovernanceUnavailable("memory_model_payload_unavailable") from None


class ModelMemoryInclusion(IntakeModel):
    memory_id: UuidText
    content_revision: int = Field(gt=0)
    memory_governance_revision: int = Field(gt=0)


class FinalModelAttempt(IntakeModel):
    schema_name: Literal["mem00.model-attempt.v4"] = Field(alias="schema")
    attempt_id: UuidText
    run_id: UuidText
    thread_id: UuidText
    scope: str = Field(min_length=1, max_length=512)
    contract_epoch: Literal[1]
    payload_ref: str = Field(pattern=r"^hmac-sha256:model-payload:[a-f0-9]{64}$")
    endpoint_ref: str = Field(pattern=r"^hmac-sha256:model-endpoint:[a-f0-9]{64}$")
    model_ref: str = Field(pattern=r"^hmac-sha256:model-route:[a-f0-9]{64}$")
    source_witness: SourceInputWitness | None
    builder_binding: BuilderRunBinding | None
    completion_binding: CompletionRunBinding | None
    source_dependencies: list[SourceDependency] = Field(min_length=1, max_length=128)
    prior_admission_id: UuidText
    authorized_manifest: list[ModelMemoryInclusion] = Field(max_length=100)
    catalog_generation: int = Field(ge=0)
    revocation_epoch: int = Field(ge=0)
    provider: Literal["mem0"]
    environment: str = Field(min_length=1, max_length=512)
    provider_project: str = Field(min_length=1, max_length=512)
    provider_namespace: str = Field(min_length=1, max_length=512)

    @field_validator("contract_epoch", mode="before")
    @classmethod
    def exact_contract_epoch(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("model_contract_epoch_invalid")
        return value

    @model_validator(mode="after")
    def exact_scope(self):
        from .source_dependencies import source_dependencies
        if sum(item is not None for item in (self.source_witness, self.builder_binding, self.completion_binding)) != 1:
            raise ValueError("model_source_authority_ambiguous")
        authority = self.source_witness or self.builder_binding or self.completion_binding
        owner = authority.owner_id
        sources = source_dependencies(owner_id=owner, values=self.source_dependencies)
        if self.source_witness is not None:
            root = self.source_witness
            if root not in sources or any(item.thread_id != self.thread_id or item.memory_clear_epoch > root.memory_clear_epoch
                or (item.memory_clear_epoch < root.memory_clear_epoch and item.session_id != root.session_id) for item in sources):
                raise ValueError("model_source_ancestry_unbound")
        elif self.builder_binding is not None:
            binding = self.builder_binding
            if self.scope != "builder" or (self.thread_id, self.run_id) != (binding.child_thread_id, binding.child_run_id):
                raise ValueError("model_builder_run_unbound")
            if self.source_dependencies != binding.source_dependencies:
                raise ValueError("model_builder_sources_unbound")
            manifest = [item.model_dump() for item in self.authorized_manifest]
            if any(item.model_dump() not in manifest for item in binding.initial_memory_manifest):
                raise ValueError("model_builder_manifest_unbound")
        else:
            binding = self.completion_binding
            origin = binding.request
            if (self.scope, self.thread_id, self.run_id) != (origin.scope, origin.parent_thread_id, binding.completion_run_id):
                raise ValueError("model_completion_run_unbound")
            if self.source_dependencies != origin.source_dependencies:
                raise ValueError("model_completion_sources_unbound")
            manifest = [item.model_dump() for item in self.authorized_manifest]
            if any(item.model_dump() not in manifest for item in origin.initial_memory_manifest):
                raise ValueError("model_completion_manifest_unbound")
        if len({row.memory_id for row in self.authorized_manifest}) != len(self.authorized_manifest):
            raise ValueError("model_attempt_scope_invalid")
        return self


class FinalModelDispatchReceipt(IntakeModel):
    schema_name: Literal["mem00.model-dispatch.v4"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    attempt_id: UuidText
    run_id: UuidText
    thread_id: UuidText
    event_id: UuidText
    prompt_admission_id: UuidText
    prior_admission_id: UuidText
    payload_ref: str
    endpoint_ref: str
    model_ref: str
    catalog_generation: int = Field(ge=0)
    revocation_epoch: int = Field(ge=0)
    memory_clear_epoch: int = Field(ge=0)
    authorized_manifest: list[ModelMemoryInclusion] = Field(max_length=100)
    source_event_id: UuidText | None
    builder_binding_id: UuidText | None
    completion_binding_id: UuidText | None
    source_dependencies: list[SourceDependency] = Field(min_length=1, max_length=128)
    accepted_at: str
    expires_at: str
    single_use: HistoricalOnly
    dispatch_observed: bool

    @field_validator("dispatch_observed", mode="before")
    @classmethod
    def not_sent(cls, value):
        if value is not False:
            raise ValueError("model_dispatch_not_observed")
        return value

    def require_live(self):
        accepted = datetime.fromisoformat(self.accepted_at.replace("Z", "+00:00"))
        expires = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))
        if accepted.tzinfo is None or expires.tzinfo is None or not accepted <= datetime.now(UTC) < expires or not 0 < (expires - accepted).total_seconds() <= 5:
            raise MemoryGovernanceUnavailable("memory_model_permit_expired")


class FinalModelDispatchAuthority:
    """Consumed even after an uncertain SQL reply; never reusable permission."""

    attempt_type = FinalModelAttempt
    receipt_type = FinalModelDispatchReceipt
    store_method = "authorize_model_dispatch"

    def __init__(self, *, owner_id: str, attempt: FinalModelAttempt, store):
        assert_not_voice_lab_principal(owner_id)
        self.owner_id = owner_id
        validated = self.attempt_type.model_validate(attempt.model_dump(mode="python", by_alias=True))
        self._attempt_json = validated.model_dump_json(by_alias=True)
        if any(item.owner_id != owner_id for item in validated.source_dependencies):
            raise MemoryGovernanceUnavailable("memory_model_attempt_scope_invalid")
        self.store = store
        self._lock = Lock()
        self._used = False

    @property
    def attempt(self):
        # A caller inspecting a typed manifest must not mutate the captured
        # authority through a nested list or source-witness object.
        return self.attempt_type.model_validate_json(self._attempt_json)

    def _matches_origin(self, result, attempt):
        source, binding, completion = attempt.source_witness, attempt.builder_binding, attempt.completion_binding
        return (result.owner_id, result.source_event_id, result.builder_binding_id, result.completion_binding_id, result.memory_clear_epoch) == (
            self.owner_id, source.event_id if source else None, binding.binding_event_id if binding else None,
            completion.binding_event_id if completion else None, (source or binding or completion).memory_clear_epoch)

    def require_exact(self, request):
        snapshot = snapshot_model_request(request)
        if (snapshot.payload_ref, snapshot.endpoint_ref, snapshot.model_ref) != (self.attempt.payload_ref, self.attempt.endpoint_ref, self.attempt.model_ref):
            raise MemoryGovernanceUnavailable("memory_model_payload_changed")

    def admit(self, request: httpx.Request) -> FinalModelDispatchReceipt:
        with self._lock:
            if self._used:
                raise MemoryGovernanceUnavailable("memory_model_attempt_consumed")
            self._used = True
        started = monotonic()
        try:
            self.require_exact(request)
            result = self.receipt_type.model_validate(getattr(self.store, self.store_method)(
                p_user_id=self.owner_id, p_attempt=self.attempt.model_dump(mode="json", by_alias=True)))
            fields = {"attempt_id", "run_id", "thread_id", "prior_admission_id", "payload_ref", "endpoint_ref", "model_ref",
                "catalog_generation", "revocation_epoch", "authorized_manifest", "source_dependencies"}
            attempt = self.attempt
            if result.model_dump(include=fields) != attempt.model_dump(include=fields) or not self._matches_origin(result, attempt):
                raise ValueError("receipt_scope")
            if monotonic() - started >= 5:
                raise ValueError("receipt_delayed")
            result.require_live()
            self.require_exact(request)
            return result
        except Exception:
            raise MemoryGovernanceUnavailable("memory_model_dispatch_unavailable") from None
