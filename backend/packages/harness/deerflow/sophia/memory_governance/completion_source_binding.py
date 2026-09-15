"""Immutable completion-run ancestry in the existing governance ledger.

Only the trusted run guard may capture this after verifying the service trigger,
unchanged parent checkpoint, exact original child binding and child checkpoint,
then re-admitting their complete source/canonical union. A receipt is historical
association, never permission to dispatch a model or reuse retained text.
"""

from typing import Literal

from pydantic import Field, field_validator, model_validator

from .builder_source_binding import BindingMemoryInclusion, BuilderRunBinding
from .identity import assert_not_voice_lab_principal
from .source_dependencies import SourceDependency, merge_source_dependencies, source_dependencies
from .source_intake import HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable


class CompletionSourceRequest(IntakeModel):
    schema_name: Literal["mem00.completion-source-request.v1"] = Field(alias="schema")
    contract_epoch: Literal[1]
    parent_thread_id: UuidText
    completion_run_id: UuidText
    trigger_ref: str = Field(pattern=r"^hmac-sha256:completion-trigger:[a-f0-9]{64}$")
    parent_checkpoint_ref: str = Field(pattern=r"^hmac-sha256:checkpoint-state:[a-f0-9]{64}$")
    parent_checkpoint_run_ref: str = Field(pattern=r"^hmac-sha256:run:[a-f0-9]{64}$")
    child_checkpoint_ref: str = Field(pattern=r"^hmac-sha256:checkpoint-state:[a-f0-9]{64}$")
    child_binding: BuilderRunBinding
    parent_source_dependencies: list[SourceDependency] = Field(min_length=1, max_length=128)
    source_dependencies: list[SourceDependency] = Field(min_length=1, max_length=128)
    parent_memory_manifest: list[BindingMemoryInclusion] = Field(max_length=100)
    child_memory_manifest: list[BindingMemoryInclusion] = Field(max_length=100)
    initial_memory_manifest: list[BindingMemoryInclusion] = Field(max_length=100)
    prior_admission_id: UuidText
    scope: Literal["global", "life", "work", "gaming"]
    catalog_generation: int = Field(ge=0)
    revocation_epoch: int = Field(ge=0)

    @field_validator("contract_epoch", mode="before")
    @classmethod
    def exact_epoch(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("completion_epoch_invalid")
        return value

    @model_validator(mode="after")
    def exact_sources(self):
        binding = self.child_binding
        if self.parent_thread_id != binding.parent_thread_id or self.completion_run_id in {binding.child_run_id, binding.parent_run_id}:
            raise ValueError("completion_run_scope_invalid")
        sources = source_dependencies(owner_id=binding.owner_id, values=self.source_dependencies)
        if sources != merge_source_dependencies(owner_id=binding.owner_id, groups=[self.parent_source_dependencies, binding.source_dependencies]):
            raise ValueError("completion_source_union_incomplete")
        if any(item.thread_id != self.parent_thread_id or item.memory_clear_epoch != binding.memory_clear_epoch for item in sources):
            raise ValueError("completion_source_scope_invalid")
        if any(item not in sources for item in binding.source_dependencies):
            raise ValueError("completion_child_ancestry_omitted")
        if len({item.memory_id for item in self.initial_memory_manifest}) != len(self.initial_memory_manifest):
            raise ValueError("completion_manifest_duplicate")
        if any(item not in self.initial_memory_manifest for item in binding.initial_memory_manifest):
            raise ValueError("completion_child_memory_omitted")
        union = {}
        for manifest in (self.parent_memory_manifest, self.child_memory_manifest):
            if len({item.memory_id for item in manifest}) != len(manifest):
                raise ValueError("completion_memory_union_duplicate")
            for item in manifest:
                if item.memory_id in union and union[item.memory_id] != item:
                    raise ValueError("completion_memory_union_conflict")
                union[item.memory_id] = item
        if union != {item.memory_id: item for item in self.initial_memory_manifest}:
            raise ValueError("completion_memory_union_incomplete")
        if any(item not in self.child_memory_manifest for item in binding.initial_memory_manifest):
            raise ValueError("completion_child_manifest_incomplete")
        return self


class CompletionRunBinding(IntakeModel):
    schema_name: Literal["mem00.completion-source-run.v1"] = Field(alias="schema")
    binding_event_id: UuidText
    owner_id: str = Field(min_length=1)
    completion_run_id: UuidText
    request: CompletionSourceRequest
    memory_clear_epoch: int = Field(ge=0)
    accepted_at: str
    historical_result_only: HistoricalOnly

    @model_validator(mode="after")
    def exact_request(self):
        if (self.owner_id, self.completion_run_id, self.memory_clear_epoch) != (
            self.request.child_binding.owner_id, self.request.completion_run_id, self.request.child_binding.memory_clear_epoch
        ):
            raise ValueError("completion_receipt_scope_invalid")
        return self


class CompletionSourceBindingService:
    def __init__(self, *, owner_id, store):
        assert_not_voice_lab_principal(owner_id)
        if not isinstance(owner_id, str) or not owner_id.strip() or owner_id.strip() != owner_id:
            raise MemoryGovernanceUnavailable("memory_completion_owner_invalid")
        self.owner, self.store = owner_id, store

    def lookup(self, *, completion_run_id):
        """Read-only original-run lookup; absence is distinct from uncertainty."""
        try:
            from uuid import UUID
            run = str(UUID(str(completion_run_id)))
            raw = self.store.get_completion_source_run(p_user_id=self.owner, p_completion_run_id=run)
            if raw is None:
                return None
            receipt = CompletionRunBinding.model_validate(raw)
            if receipt.owner_id != self.owner or receipt.completion_run_id != run:
                raise ValueError("receipt")
            return receipt
        except Exception:
            raise MemoryGovernanceUnavailable("memory_completion_binding_unavailable") from None

    def register(self, request):
        try:
            request = CompletionSourceRequest.model_validate(request.model_dump(mode="json", by_alias=True))
            if request.child_binding.owner_id != self.owner:
                raise ValueError("owner")
            try:
                raw = self.store.register_completion_source_run(p_user_id=self.owner, p_completion=request.model_dump(mode="json", by_alias=True))
            except Exception:
                # Recover ONLY this actual run. Never mint a replacement run,
                # refresh the request's witnesses, or repeat the uncertain write.
                raw = self.store.get_completion_source_run(p_user_id=self.owner, p_completion_run_id=request.completion_run_id)
            receipt = CompletionRunBinding.model_validate(raw)
            if receipt.owner_id != self.owner or receipt.request != request:
                raise ValueError("receipt")
            return receipt
        except Exception:
            raise MemoryGovernanceUnavailable("memory_completion_binding_unavailable") from None

    def verify_historical_binding(self, receipt):
        try:
            receipt = CompletionRunBinding.model_validate(receipt.model_dump(mode="json", by_alias=True))
            if receipt.owner_id != self.owner:
                raise ValueError("owner")
            current = CompletionRunBinding.model_validate(self.store.get_completion_source_run(
                p_user_id=self.owner, p_completion_run_id=receipt.completion_run_id))
            if current != receipt:
                raise ValueError("receipt")
            return current
        except Exception:
            raise MemoryGovernanceUnavailable("memory_completion_binding_unavailable") from None
