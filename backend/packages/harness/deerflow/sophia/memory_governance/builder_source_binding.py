"""Durable task/source associations, never current memory or model permission.

Trusted producers supply the exact handoff and the auth hook supplies its real
child run. Ambiguous replies recover by original identity, without a new write.
Actual producer/auth/final-dispatch wiring must independently enforce origin.
"""

from typing import Literal

from pydantic import Field, field_validator, model_validator

from .identity import assert_not_voice_lab_principal
from .source_dependencies import SourceDependency, source_dependencies
from .source_intake import HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable


class BindingMemoryInclusion(IntakeModel):
    memory_id: UuidText
    content_revision: int = Field(gt=0)
    memory_governance_revision: int = Field(gt=0)


def independent_builder_source_text(*, owner_id, thread_id, run_id, input_proof, messages, store):
    """Recover only this run's recorded human request, not an enriched brief.

    This is source validation, not a child launch or final model permit. The
    caller must bind a fresh child with zero memory inclusions independently.
    """
    from .input_provenance import RECORDED_SCHEMA, verified_current_input
    from .source_input_provenance import SourceInputWitness, recheck_recorded_source
    from .refs import keyed_ref

    try:
        assert_not_voice_lab_principal(owner_id)
        from langchain_core.messages import HumanMessage
        witness = SourceInputWitness.model_validate(input_proof["source_witness"])
        originals = [item for item in messages if isinstance(item, HumanMessage) and item.id == witness.message_id]
        if len(originals) != 1:
            raise ValueError("source")
        current = verified_current_input(proof=input_proof, owner_id=owner_id,
            thread_id=thread_id, run_id=run_id, messages=originals)
        if current is None or input_proof.get("schema") != RECORDED_SCHEMA or not isinstance(current.content, str):
            raise ValueError("source")
        if witness.content_ref != keyed_ref("source-action-content", current.content):
            raise ValueError("content")
        recheck_recorded_source(witness=witness, owner_id=owner_id, thread_id=thread_id, store=store)
        return current.content
    except Exception:
        raise MemoryGovernanceUnavailable("independent_builder_source_unavailable") from None


class BuilderSourceHandoff(IntakeModel):
    schema_name: Literal["mem00.builder-source-handoff.v1"] = Field(alias="schema")
    contract_epoch: Literal[1]
    parent_run_id: UuidText
    parent_thread_id: UuidText
    child_thread_id: UuidText
    payload_ref: str = Field(pattern=r"^hmac-sha256:checkpoint-state:[a-f0-9]{64}$")
    prior_admission_id: UuidText
    scope: Literal["global", "life", "work", "gaming"]
    source_dependencies: list[SourceDependency] = Field(min_length=1, max_length=128)
    initial_memory_manifest: list[BindingMemoryInclusion] = Field(max_length=100)
    catalog_generation: int = Field(ge=0)
    revocation_epoch: int = Field(ge=0)

    @field_validator("contract_epoch", mode="before")
    @classmethod
    def exact_epoch(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("builder_source_epoch_invalid")
        return value

    @model_validator(mode="after")
    def source_scope(self):
        if self.parent_thread_id == self.child_thread_id or any(item.thread_id != self.parent_thread_id for item in self.source_dependencies):
            raise ValueError("builder_source_scope_invalid")
        source_dependencies(owner_id=self.source_dependencies[0].owner_id, values=self.source_dependencies)
        if len({item.memory_id for item in self.initial_memory_manifest}) != len(self.initial_memory_manifest):
            raise ValueError("builder_source_manifest_invalid")
        return self


class BuilderHandoffReceipt(IntakeModel):
    schema_name: Literal["mem00.builder-source-handoff-receipt.v1"] = Field(alias="schema")
    event_id: UuidText
    owner_id: str = Field(min_length=1)
    child_thread_id: UuidText
    request: BuilderSourceHandoff
    memory_clear_epoch: int = Field(ge=0)
    initial_memory_manifest: list[BindingMemoryInclusion] = Field(max_length=100)
    accepted_at: str
    historical_result_only: HistoricalOnly

    @model_validator(mode="after")
    def exact_source_scope(self):
        if self.child_thread_id != self.request.child_thread_id:
            raise ValueError("builder_handoff_receipt_scope")
        if self.initial_memory_manifest != self.request.initial_memory_manifest:
            raise ValueError("builder_handoff_receipt_manifest")
        if any(item.owner_id != self.owner_id or item.memory_clear_epoch != self.memory_clear_epoch for item in self.request.source_dependencies):
            raise ValueError("builder_handoff_receipt_scope")
        return self


class BuilderRunBinding(IntakeModel):
    schema_name: Literal["mem00.builder-source-run.v1"] = Field(alias="schema")
    binding_event_id: UuidText
    handoff_event_id: UuidText
    owner_id: str = Field(min_length=1)
    parent_thread_id: UuidText
    parent_run_id: UuidText
    child_thread_id: UuidText
    child_run_id: UuidText
    payload_ref: str = Field(pattern=r"^hmac-sha256:checkpoint-state:[a-f0-9]{64}$")
    source_dependencies: list[SourceDependency] = Field(min_length=1, max_length=128)
    memory_clear_epoch: int = Field(ge=0)
    initial_memory_manifest: list[BindingMemoryInclusion] = Field(max_length=100)
    accepted_at: str
    historical_result_only: HistoricalOnly

    @model_validator(mode="after")
    def exact_source_scope(self):
        source_dependencies(owner_id=self.owner_id, values=self.source_dependencies)
        if self.child_thread_id == self.parent_thread_id or any(item.thread_id != self.parent_thread_id or item.memory_clear_epoch != self.memory_clear_epoch for item in self.source_dependencies):
            raise ValueError("builder_run_receipt_scope")
        return self


def independent_builder_runtime_seed(*, binding, wire_input):
    """Reconstruct task machinery only after verified source-only entry.

    This deterministic transformation is not authorization. The entry guard
    verifies the binding, current source and zero-memory admission first. No
    caller-supplied task type, budget, artifact, file or parent state is used.
    """
    from datetime import datetime
    from langchain_core.messages import HumanMessage, convert_to_messages
    from .context_provenance import _state_ref
    from deerflow.sophia.tools.start_builder_task import (
        _resolve_target_format, _suggest_artifact_target_path,
        should_allow_builder_web_research, extract_explicit_user_urls, make_builder_web_budget,
    )
    from deerflow.agents.sophia_agent.middlewares.builder_budget import builder_budget_for_task

    try:
        binding = BuilderRunBinding.model_validate(binding)
        if binding.initial_memory_manifest or set(wire_input) != {"messages"} or _state_ref(wire_input) != binding.payload_ref:
            raise ValueError("source")
        messages = convert_to_messages(wire_input["messages"])
        if len(messages) != 1 or not isinstance(messages[0], HumanMessage) or not isinstance(messages[0].content, str):
            raise ValueError("source")
        text = messages[0].content
        resolution = _resolve_target_format(current_user_text=text, description=None, task_type="document")
        task_type = {"pptx": "presentation", "html": "frontend", "pdf": "visual_report"}.get(resolution.final_ext, "document")
        target = _suggest_artifact_target_path(task_type, text, ext_override=resolution.final_ext)
        allow_web = should_allow_builder_web_research(task_type, text)
        urls = extract_explicit_user_urls(text)
        web_budget = make_builder_web_budget(task_type)
        budget = builder_budget_for_task(task_type=task_type, artifact_ext=resolution.final_ext, cost_model_key=None)
        accepted = datetime.fromisoformat(binding.accepted_at.replace("Z", "+00:00"))
        if accepted.tzinfo is None:
            raise ValueError("clock")
        kickoff = int(accepted.timestamp() * 1000)
        # Preserve existing tier policy: simple tasks have cost/turn limits
        # rather than a wall-clock cap; presentations additionally have one.
        seconds = int(budget.get("max_wall_clock_seconds", 0))
        if seconds < 0 or float(budget["max_cost_usd"]) <= 0 or int(budget["max_non_artifact_turns"]) <= 0:
            raise ValueError("unbounded")
        build_id = "build_" + binding.handoff_event_id
        operation_id = "op_" + binding.binding_event_id
        return {
            "delegation_context": {
                "task": text, "task_type": task_type, "artifact_target_path": target,
                "parent_thread_id": binding.parent_thread_id, "parent_user_id": binding.owner_id,
                "companion_artifact": {}, "relevant_memories": [], "user_identity": None,
                "active_ritual": None, "ritual_phase": None, "uploaded_image_paths": [],
                "allow_web_research": allow_web, "explicit_user_urls": urls,
                "builder_web_budget": web_budget, "search_mode": "autonomous",
                "user_requested_ext": resolution.user_requested_ext,
                "format_resolution_source": resolution.source,
                "build_id": build_id, "operation_id": operation_id,
            },
            "allow_web_research": allow_web, "explicit_user_urls": urls,
            "builder_web_budget": web_budget, "builder_budget": budget,
            "builder_task_kickoff_ms": kickoff, "builder_timeout_seconds": seconds,
            "builder_deadline_epoch_ms": kickoff + seconds * 1000 if seconds else 0,
            "builder_build_id": build_id, "builder_operation_id": operation_id,
            "builder_artifact_target_path": target,
        }
    except Exception:
        raise MemoryGovernanceUnavailable("independent_builder_runtime_unavailable") from None


class BuilderSourceBindingService:
    def __init__(self, *, owner_id, store):
        assert_not_voice_lab_principal(owner_id)
        if not isinstance(owner_id, str) or not owner_id.strip() or owner_id != owner_id.strip():
            raise MemoryGovernanceUnavailable("memory_builder_source_owner_invalid")
        self.owner, self.store = owner_id, store

    def register_independent_text(self, *, guard, child_thread_id, messages):
        """Bind source-only child input using a separate zero-memory admission.

        No parent admission is overwritten. The returned receipt is historical
        origin only; authenticated child-run binding and final dispatch remain
        independently required.
        """
        from uuid import UUID, uuid5
        from langchain_core.messages import HumanMessage
        from deerflow.agents.sophia_agent.middlewares.memory_context import active_builder_parent_guard
        from .context_provenance import _state_ref
        from .input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY
        from .refs import keyed_ref
        from .retained_context import RetainedMemoryContext
        from .source_input_provenance import SourceInputWitness

        try:
            if guard is None or active_builder_parent_guard(self.owner, guard.context_id) is not guard:
                raise ValueError("parent")
            guard.check()
            text = independent_builder_source_text(owner_id=self.owner, thread_id=guard.context_id,
                run_id=guard.config.get(INPUT_RUN_KEY), input_proof=guard.config.get(INPUT_PROOF_KEY), messages=messages, store=self.store)
            witness = SourceInputWitness.model_validate(guard.config[INPUT_PROOF_KEY]["source_witness"])
            clock = self.store.get_user_governance(self.owner)
            zero = guard._readmit(RetainedMemoryContext(keyed_ref("owner", self.owner), clock.user_revocation_epoch, ()))
            if (zero.transition.action != "continue" or zero.context is None or zero.context.owner_ref != keyed_ref("owner", self.owner)
                    or zero.context.inclusions or zero.memories or zero.prompt_admission_id is None):
                raise ValueError("memory_inheritance")
            after = self.store.get_user_governance(self.owner)
            if after.user_id != self.owner or after.user_revocation_epoch != zero.context.revocation_epoch:
                raise ValueError("changed")
            message_id = str(uuid5(UUID(child_thread_id), "mem00-c2-independent-source-message"))
            wire = {"messages": [HumanMessage(content=text, id=message_id).model_dump(mode="json")]}
            request = BuilderSourceHandoff(schema="mem00.builder-source-handoff.v1", contract_epoch=1,
                parent_run_id=guard.config[INPUT_RUN_KEY], parent_thread_id=guard.context_id, child_thread_id=child_thread_id,
                payload_ref=_state_ref(wire), prior_admission_id=str(zero.prompt_admission_id), scope=guard.scope,
                source_dependencies=[witness], initial_memory_manifest=[], catalog_generation=after.user_catalog_generation,
                revocation_epoch=after.user_revocation_epoch)
            try:
                receipt = self.register(request)
            except MemoryGovernanceUnavailable:
                # A retry gets a fresh zero-memory admission, but the original
                # handoff remains historical. Recover only the identical
                # source/payload/epoch/child association; never overwrite it.
                receipt = BuilderHandoffReceipt.model_validate(self.store.get_builder_handoff(
                    p_user_id=self.owner, p_child_thread_id=child_thread_id))
                if receipt.owner_id != self.owner or receipt.request.model_dump(exclude={"prior_admission_id"}) != request.model_dump(exclude={"prior_admission_id"}):
                    raise ValueError("retry_conflict")
            return wire, receipt, zero
        except Exception:
            raise MemoryGovernanceUnavailable("independent_builder_handoff_unavailable") from None

    def register(self, request):
        try:
            request = BuilderSourceHandoff.model_validate(request.model_dump(mode="json", by_alias=True))
            if any(item.owner_id != self.owner for item in request.source_dependencies):
                raise ValueError("owner")
            try:
                raw = self.store.register_builder_handoff(p_user_id=self.owner, p_handoff=request.model_dump(mode="json", by_alias=True))
            except Exception:
                raw = self.store.get_builder_handoff(p_user_id=self.owner, p_child_thread_id=request.child_thread_id)
            receipt = BuilderHandoffReceipt.model_validate(raw)
            if receipt.owner_id != self.owner or receipt.request != request:
                raise ValueError("receipt")
            return receipt
        except Exception:
            raise MemoryGovernanceUnavailable("memory_builder_handoff_unavailable") from None

    def bind(self, *, handoff, child_run_id):
        try:
            handoff = BuilderHandoffReceipt.model_validate(handoff.model_dump(mode="json", by_alias=True))
            if handoff.owner_id != self.owner:
                raise ValueError("owner")
            from uuid import UUID
            run_id = str(UUID(str(child_run_id)))
            try:
                raw = self.store.bind_builder_source_run(p_user_id=self.owner, p_handoff_event_id=handoff.event_id,
                    p_child_thread_id=handoff.child_thread_id, p_child_run_id=run_id, p_payload_ref=handoff.request.payload_ref)
            except Exception:
                raw = self.store.get_builder_source_run_for_handoff(p_user_id=self.owner, p_handoff_event_id=handoff.event_id)
            receipt = BuilderRunBinding.model_validate(raw)
            common = {"parent_thread_id", "parent_run_id", "child_thread_id", "payload_ref", "source_dependencies"}
            if receipt.model_dump(include=common) != handoff.request.model_dump(include=common) or (
                receipt.owner_id, receipt.handoff_event_id, receipt.child_run_id, receipt.memory_clear_epoch, receipt.initial_memory_manifest
            ) != (self.owner, handoff.event_id, run_id, handoff.memory_clear_epoch, handoff.initial_memory_manifest):
                raise ValueError("receipt")
            return receipt
        except Exception:
            raise MemoryGovernanceUnavailable("memory_builder_run_binding_unavailable") from None

    def verify_historical_binding(self, receipt):
        try:
            receipt = BuilderRunBinding.model_validate(receipt.model_dump(mode="json", by_alias=True))
            if receipt.owner_id != self.owner:
                raise ValueError("owner")
            current = BuilderRunBinding.model_validate(self.store.get_builder_source_run(p_user_id=self.owner, p_binding_event_id=receipt.binding_event_id))
            if current != receipt:
                raise ValueError("receipt")
            return current
        except Exception:
            raise MemoryGovernanceUnavailable("memory_builder_run_binding_unavailable") from None

    def resolve_child(self, *, parent_thread_id, child_thread_id, child_run_id):
        """Read the original child association; never bind/recover by writing.

        Completion cannot upgrade a signed checkpoint into a delegation. The
        original ledger must independently join this parent and actual run.
        This proves origin only; current source/consent checks remain required.
        """
        try:
            from uuid import UUID
            parent, child, run = (str(UUID(str(value))) for value in (parent_thread_id, child_thread_id, child_run_id))
            handoff = BuilderHandoffReceipt.model_validate(self.store.get_builder_handoff(p_user_id=self.owner, p_child_thread_id=child))
            binding = BuilderRunBinding.model_validate(self.store.get_builder_source_run_for_handoff(p_user_id=self.owner, p_handoff_event_id=handoff.event_id))
            if (handoff.owner_id, handoff.child_thread_id, handoff.request.parent_thread_id) != (self.owner, child, parent):
                raise ValueError("handoff_scope")
            fields = {"parent_thread_id", "parent_run_id", "child_thread_id", "payload_ref", "source_dependencies"}
            if binding.model_dump(include=fields) != handoff.request.model_dump(include=fields) or (
                binding.owner_id, binding.handoff_event_id, binding.child_run_id, binding.memory_clear_epoch, binding.initial_memory_manifest
            ) != (self.owner, handoff.event_id, run, handoff.memory_clear_epoch, handoff.initial_memory_manifest):
                raise ValueError("binding_scope")
            return self.verify_historical_binding(binding)
        except Exception:
            raise MemoryGovernanceUnavailable("memory_builder_child_association_unavailable") from None
