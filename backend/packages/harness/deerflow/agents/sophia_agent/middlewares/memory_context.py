"""Trusted run entry, per-consumer admission and checkpoint provenance.

The guard is factory-local to one authenticated run, never an input-state flag.
Unbound contexts abort BEFORE another consumer runs. A plain-chat intersecting
context may be rebuilt once from exact independently revalidated source records.
Task/native-state recovery remains held; raising is not a rotation receipt.
"""

from __future__ import annotations

import asyncio
import os
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps
from threading import RLock
from typing import Annotated, NotRequired
from uuid import uuid4

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import PrivateStateAttr
from langchain_core.messages import ToolMessage

from deerflow.sophia.memory_governance.context_provenance import CHECKPOINT_PROOF_KEY, seal_checkpoint, seal_context, verify_checkpoint_seal
from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY, verified_current_input
from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.memory_governance.retained_context import RetainedMemoryContext
from deerflow.sophia.memory_governance.retrieval_provenance import RETRIEVAL_PROOF_KEY, verify_retrieval_proof

_active_tool_guard: ContextVar[object | None] = ContextVar("mem00_active_tool_guard", default=None)
_active_model_guard: ContextVar[object | None] = ContextVar("mem00_active_model_guard", default=None)


def active_model_guard():
    guard = _active_model_guard.get()
    return guard if isinstance(guard, MemoryRunGuard) else None


def active_governed_tool_owner():
    guard = active_governed_tool_guard()
    return guard.owner if guard is not None else None


def active_governed_tool_guard():
    guard = _active_tool_guard.get()
    return guard if isinstance(guard, MemoryRunGuard) and guard.enabled else None


def active_builder_parent_guard(owner_id, parent_thread_id):
    from deerflow.sophia.memory_governance.context_state import allows_unversioned_builder_handoff
    if allows_unversioned_builder_handoff(owner_id):
        return None
    guard = _active_tool_guard.get()
    if not isinstance(guard, MemoryRunGuard) or guard.owner != owner_id or guard.context_id != parent_thread_id or not guard.entered:
        raise MemoryContextUnavailable()
    return guard


class MemoryContextUnavailable(RuntimeError):
    def __init__(self):
        super().__init__("memory_context_rotation_required")


class MemoryContextState(AgentState):
    memory_task_retention: NotRequired[Annotated[dict | None, PrivateStateAttr]]
    memory_chat_recovery_receipt: NotRequired[Annotated[dict | None, PrivateStateAttr]]
    memory_checkpoint_proof: NotRequired[Annotated[dict | None, PrivateStateAttr]]
    memory_context_proof: NotRequired[Annotated[dict | None, PrivateStateAttr]]
    memory_retrieval_proof: NotRequired[Annotated[dict | None, PrivateStateAttr]]


def _serialized_dependencies(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        with self.dependency_update_lock():
            return method(self, *args, **kwargs)
    return guarded


class MemoryRunGuard:
    @staticmethod
    def _owner_is_undeclared(owner_id) -> bool:
        """See owner_authority.owner_is_definitely_undeclared for the contract."""
        from deerflow.sophia.memory_governance.owner_authority import owner_is_definitely_undeclared

        return owner_is_definitely_undeclared(owner_id)

    def __init__(self, *, owner_id, config, scope="global"):
        from deerflow.sophia.memory_governance.context_state import allows_unversioned_builder_handoff
        self.owner = owner_id
        self.config = dict(config)
        self.context_id = self.config.get("thread_id")
        self.scope = scope
        # An undeclared owner is outside the pilot. The ordinary middlewares have
        # already resolved all-off flags for this same turn, so engaging the
        # governed branch here would demand governed_runtime_read from someone
        # who can never hold it and raise MemoryContextUnavailable out of
        # before_agent on an ordinary text turn.
        #
        # allows_unversioned_builder_handoff cannot express this on its own: it
        # swallows every exception and returns False, which correctly refuses the
        # legacy lane to an unknown owner but reads here as "governed owner".
        # Unknown still never becomes legacy -- both lanes stay closed; this only
        # stops the governed lane from being demanded.
        # Three states, not two. The guard previously assumed enabled=True meant
        # a governed owner and enabled=False meant a declared legacy owner, so
        # check() demanded the legacy lane whenever the governed one was off.
        # An undeclared owner is neither: no governed lane, no legacy lane, no
        # memory at all. Without this third state an ordinary text turn for any
        # non-pilot user raises out of before_agent.
        self.undeclared = self._owner_is_undeclared(owner_id)
        self.enabled = not self.undeclared and not allows_unversioned_builder_handoff(owner_id)
        self.entered = False
        self.admission = None
        self.completion_task_id = None
        self.source_witness = None
        self.source_dependencies = ()
        self.builder_binding = None
        self.completion_binding = None
        self.resumed_completion_binding = None
        self._resumed_completion_pending = False
        self.resume_binding = None
        self._completion_origin = None
        self._chat_recovery_attempted = False
        self._rebuilt_source_view_ref = None
        self._rebuilt_source_count = 0
        self._retained_task_marker = None
        self._last_model_result_receipts = ()

    def dependency_update_lock(self):
        """One process-local lock for all shared dependency snapshots/updates.

        ToolNode workers share this guard. A slow admission must not overwrite
        another tool's union. Reentrancy permits nested current checks. This
        does not hold a SQL transaction or assert database/file atomicity.
        """
        return self.__dict__.setdefault("_dependency_update_lock", RLock())

    def _readmit(self, context):
        from deerflow.sophia.memory_governance.flags import memory_feature_flags_for_owner
        from deerflow.sophia.memory_governance.mem0_projection_adapter import Mem0ProjectionAdapter
        from deerflow.sophia.memory_governance.retained_admission import readmit_retained_context
        from deerflow.sophia.memory_governance.service import MemoryProviderContract
        from deerflow.sophia.memory_governance.store import configured_memory_store
        if not memory_feature_flags_for_owner(self.owner).governed_runtime_read:
            raise MemoryContextUnavailable()
        result = readmit_retained_context(store=configured_memory_store(), adapter=Mem0ProjectionAdapter(),
            provider=MemoryProviderContract.from_environ(), service_name=os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph",
            owner_id=self.owner, context=context, scope=self.scope, caller="runtime_context_boundary", query="Runtime context availability check")
        if result.transition.action != "continue":
            raise MemoryContextUnavailable()
        if self.scope == "builder" and (result.context is None or result.context.inclusions or result.memories):
            raise MemoryContextUnavailable()
        return result

    def _empty_native_surface(self):
        # A checkpoint lost on restart cannot make retained sandbox material
        # fresh. No content is read and no directory is created/deleted here.
        from deerflow.config.paths import get_paths
        paths = get_paths()
        for path in (paths.sandbox_work_dir(self.context_id), paths.sandbox_uploads_dir(self.context_id), paths.sandbox_outputs_dir(self.context_id)):
            if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
                raise MemoryContextUnavailable()

    @_serialized_dependencies
    def enter(self, state):
        # C2 ordinary text cannot silently activate C1 resume, completion,
        # personal-memory handoff or attachment lineages. Keep original keys so
        # an old signed request is refused rather than treated as fresh text.
        resume_requested = any(self.config.get(key) is not None for key in (
            "sophia_builder_resume_request_v1", "sophia_builder_resume_run_v1",
            "sophia_builder_completion_run_v1",
            "sophia_source_attachments_run_v1"))
        handoff_requested = self.config.get("sophia_builder_handoff_run_v1") is not None
        if not self.enabled and not resume_requested and not handoff_requested:
            self.check()
            return None
        self.entered = False
        self.admission = None
        self.completion_task_id = None
        self.source_witness = None
        self.source_dependencies = ()
        self.builder_binding = None
        self.completion_binding = None
        self.resumed_completion_binding = None
        self._resumed_completion_pending = False
        self.resume_binding = None
        self._completion_origin = None
        self._rebuilt_source_view_ref = None
        self._rebuilt_source_count = 0
        self._retained_task_marker = None
        source_epoch_changed = False
        try:
            from deerflow.sophia.memory_governance.flags import memory_feature_flags_for_owner
            if not memory_feature_flags_for_owner(self.owner).governed_runtime_read:
                raise MemoryContextUnavailable()
            if not self.owner or self.config.get("langgraph_auth_user_id") != self.owner or not self.context_id:
                raise MemoryContextUnavailable()
            if resume_requested:
                raise MemoryContextUnavailable()
            if handoff_requested:
                if self.scope != "builder" or self.config.get(INPUT_PROOF_KEY) is not None:
                    raise MemoryContextUnavailable()
                from deerflow.sophia.memory_governance.builder_provenance import HANDOFF_RUN_KEY, verify_builder_run, verified_builder_sources
                context = verify_builder_run(owner_id=self.owner, child_thread_id=self.context_id,
                    run_id=self.config.get(INPUT_RUN_KEY), state=state, proof=self.config[HANDOFF_RUN_KEY])
                if context is None or context.inclusions:
                    raise MemoryContextUnavailable()
                self.source_dependencies = verified_builder_sources(owner_id=self.owner, child_thread_id=self.context_id,
                    run_id=self.config.get(INPUT_RUN_KEY), state=state, proof=self.config[HANDOFF_RUN_KEY])
                from deerflow.sophia.memory_governance.builder_source_binding import BuilderRunBinding
                self.builder_binding = BuilderRunBinding.model_validate(self.config[HANDOFF_RUN_KEY]["binding"])
                self._check_source()
                self._empty_native_surface()
                self.admission = self._readmit(context)
                if self.admission.context.inclusions or self.admission.memories:
                    raise MemoryContextUnavailable()
                from deerflow.sophia.memory_governance.builder_source_binding import independent_builder_runtime_seed
                from langchain_core.messages import convert_to_messages
                wire = {"messages": [item.model_dump(mode="json") for item in convert_to_messages(state["messages"])]}
                seed = independent_builder_runtime_seed(binding=self.builder_binding, wire_input=wire)
                self.entered = True
                return {**seed, "memory_context_proof": None}
            current = verified_current_input(proof=self.config.get(INPUT_PROOF_KEY), owner_id=self.owner,
                thread_id=self.context_id, run_id=self.config.get(INPUT_RUN_KEY), messages=state.get("messages"))
            if current is None:
                raise MemoryContextUnavailable()
            from deerflow.sophia.memory_governance.input_provenance import RECORDED_SCHEMA
            from deerflow.sophia.memory_governance.source_input_provenance import SourceInputWitness
            if self.config[INPUT_PROOF_KEY].get("schema") != RECORDED_SCHEMA:
                raise MemoryContextUnavailable()
            self.source_witness = SourceInputWitness.model_validate(self.config[INPUT_PROOF_KEY]["source_witness"])
            from deerflow.sophia.memory_governance.source_attachment_run import ATTACHMENT_RUN_KEY, verified_attachment_sources
            self.source_dependencies = verified_attachment_sources(owner_id=self.owner, thread_id=self.context_id, run_id=self.config.get(INPUT_RUN_KEY),
                source_witness=self.source_witness, proof=self.config.get(ATTACHMENT_RUN_KEY))
            current_sources = self.source_dependencies
            self._check_source()
            previous = {**state, "messages": state["messages"][:-1]}
            if previous["messages"] or any(value not in (None, [], {}, False, "") for key, value in previous.items() if key not in {"messages", CHECKPOINT_PROOF_KEY}):
                from deerflow.sophia.memory_governance.pending_input_recovery import checkpoint_source_history
                from deerflow.sophia.memory_governance.source_dependencies import merge_source_dependencies
                from deerflow.sophia.memory_governance.store import configured_memory_store
                history = checkpoint_source_history(owner_id=self.owner, context_id=self.context_id, state=previous,
                    current_witness=self.source_witness, store=configured_memory_store())
                from deerflow.sophia.memory_governance.task_context_retention import TASK_RETENTION_KEY, retain_verified_tasks
                if previous.get(TASK_RETENTION_KEY) is not None:
                    self._retained_task_marker = retain_verified_tasks(owner_id=self.owner, context_id=self.context_id,
                        previous=previous, history=history, store=configured_memory_store())
                context = history.context
                source_epoch_changed = context is not None and history.origin_clear_epoch != self.source_witness.memory_clear_epoch
                self.source_dependencies = merge_source_dependencies(owner_id=self.owner, groups=[self.source_dependencies,
                    history.sources])
                self._check_source()
                if history.pending_count:
                    from deerflow.sophia.memory_governance.observability import emit_memory_event
                    emit_memory_event("memory.context.pending_input", service=os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph",
                        outcome="verified", fault_owner_id=self.owner, owner_ref=keyed_ref("owner", self.owner),
                        context_ref=keyed_ref("context", self.context_id), run_ref=keyed_ref("run", self.config.get(INPUT_RUN_KEY)),
                        pending_source_count=history.pending_count, source_count=len(self.source_dependencies),
                        final_dispatch_permission=False)
            else:
                context = None
            if context is None:
                self._empty_native_surface()
                from deerflow.sophia.memory_governance.store import configured_memory_store
                clock = configured_memory_store().get_user_governance(self.owner)
                if clock.user_id != self.owner:
                    raise MemoryContextUnavailable()
                context = RetainedMemoryContext(keyed_ref("owner", self.owner), clock.user_revocation_epoch, ())
            try:
                if source_epoch_changed:
                    # The old seal predates this clear, including when its
                    # memory manifest is empty or only unrelated deltas exist.
                    # Rebuild once from exact preserved sources, not old output.
                    raise MemoryContextUnavailable()
                self.admission = self._readmit(context)
            except MemoryContextUnavailable:
                if (not context.inclusions and not source_epoch_changed) or self._chat_recovery_attempted:
                    raise
                self._chat_recovery_attempted = True
                self._empty_native_surface()
                from deerflow.sophia.memory_governance.chat_context_recovery import rebuild_plain_chat_sources
                from deerflow.sophia.memory_governance.store import configured_memory_store
                store = configured_memory_store()
                update = rebuild_plain_chat_sources(owner_id=self.owner, context_id=self.context_id,
                    run_id=self.config.get(INPUT_RUN_KEY), previous=previous, current=current,
                    current_witness=self.source_witness, dependencies=self.source_dependencies, store=store,
                    current_sources=current_sources)
                clock = store.get_user_governance(self.owner)
                if clock.user_id != self.owner:
                    raise MemoryContextUnavailable()
                self.admission = self._readmit(RetainedMemoryContext(keyed_ref("owner", self.owner), clock.user_revocation_epoch, ()))
                self._rebuilt_source_view_ref = update["memory_chat_recovery_receipt"]["source_view_ref"]
                # The receipt counts all dependencies; attachments are not
                # messages and must not extend the reconstructed prefix.
                self._rebuilt_source_count = len(update["messages"]) - 1
                from deerflow.sophia.memory_governance.task_context_retention import TASK_RETENTION_KEY
                self._retained_task_marker = deepcopy(update.get(TASK_RETENTION_KEY))
                from deerflow.sophia.memory_governance.observability import emit_memory_event
                emit_memory_event("memory.context.rebuild", service=os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph",
                    outcome="prepared", fault_owner_id=self.owner, owner_ref=keyed_ref("owner", self.owner),
                    context_ref=keyed_ref("context", self.context_id), run_ref=keyed_ref("run", self.config.get(INPUT_RUN_KEY)),
                    recovery=update["memory_chat_recovery_receipt"])
                self.entered = True
                return update
            self.entered = True
            return {"memory_context_proof": None}
        except Exception:
            self.entered = False
            # Source verification can fail before any retained read-admission
            # event exists (notably the first run). Observe this actual refusal
            # without exporting exception text or granting a model permission.
            from deerflow.sophia.memory_governance.observability import emit_memory_event, record_memory_observation_gap
            try:
                references = {}
                for domain, value in (("owner", self.owner), ("context", self.context_id), ("run", self.config.get(INPUT_RUN_KEY))):
                    if isinstance(value, str) and value:
                        references[domain + "_ref"] = keyed_ref(domain, value)
                emit_memory_event("memory.context.entry_denied", service=os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph",
                    outcome="unavailable", fault_owner_id=self.owner, safe_reason_code="memory_context_rotation_required",
                    final_dispatch_permission=False, **references)
            except Exception:
                record_memory_observation_gap()
            raise MemoryContextUnavailable() from None

    def _enter_resume(self, state):
        """Deferred C1 transition; C2 admits original source-only children only."""
        raise MemoryContextUnavailable()

    def retained_tasks_held(self, state):
        """A private verified carrier is never task text/model permission."""
        from deerflow.sophia.memory_governance.task_context_retention import validate_task_retention
        try:
            current = validate_task_retention(owner_id=self.owner, context_id=self.context_id, state=state)
            if current != self._retained_task_marker:
                raise MemoryContextUnavailable()
            return current is not None
        except Exception:
            self.entered = False
            raise MemoryContextUnavailable() from None

    def held_task_tool_result(self, request):
        if self._retained_task_marker is None:
            return None
        from deerflow.sophia.memory_governance.task_context_retention import HELD_TOOLS, NOTICE
        self.retained_tasks_held(request.state)
        if request.tool_call["name"] in HELD_TOOLS:
            return ToolMessage(content=NOTICE, name=request.tool_call["name"], tool_call_id=request.tool_call["id"], status="error")
        return None

    def is_rebuilt_source_view(self, state):
        """Recognize only this run's exact freshly reconstructed source view.

        A persisted/input receipt is not sufficient. This prevents immediate
        lossy compaction from undoing recovery; it grants no model permission.
        Appended model/tool results do not discard the recovered prefix during
        this run. The binding resets on entry; it never survives via a receipt.
        """
        if not self.enabled or not self.entered or self._rebuilt_source_view_ref is None:
            return False
        from deerflow.sophia.memory_governance.context_provenance import MAX_MESSAGES
        from deerflow.sophia.memory_governance.chat_context_recovery import rebuilt_source_view_ref
        try:
            messages = state["messages"]
            if not isinstance(messages, list) or len(messages) > MAX_MESSAGES:
                raise MemoryContextUnavailable()
            if not 1 <= self._rebuilt_source_count <= len(messages):
                return False
            return rebuilt_source_view_ref(messages[:self._rebuilt_source_count], self.source_dependencies) == self._rebuilt_source_view_ref
        except Exception:
            raise MemoryContextUnavailable() from None

    def _check_source(self):
        if self.resume_binding is not None or self.resumed_completion_binding is not None or self._resumed_completion_pending:
            raise MemoryContextUnavailable()
        if self.source_dependencies:
            from deerflow.sophia.memory_governance.source_dependencies import recheck_model_source_dependencies
            from deerflow.sophia.memory_governance.store import configured_memory_store
            store = configured_memory_store()
            if self.builder_binding is not None:
                from deerflow.sophia.memory_governance.builder_source_binding import BuilderSourceBindingService
                BuilderSourceBindingService(owner_id=self.owner, store=store).verify_historical_binding(self.builder_binding)
            if self.completion_binding is not None:
                from deerflow.sophia.memory_governance.completion_source_binding import CompletionSourceBindingService
                CompletionSourceBindingService(owner_id=self.owner, store=store).verify_historical_binding(self.completion_binding)
            recheck_model_source_dependencies(owner_id=self.owner, current_witness=self.source_witness, values=self.source_dependencies, store=store)

    @_serialized_dependencies
    def check(self):
        if self.undeclared:
            # No lane is open for this owner, so there is no admission to verify
            # and nothing to deny. enabled is False, so prepare_model returns
            # None and self.admission stays None -- no memory can reach a model
            # request through this guard.
            return
        if not self.enabled:
            from deerflow.sophia.memory_governance.owner_authority import legacy_memory_lane_allowed
            if not legacy_memory_lane_allowed(self.owner):
                raise MemoryContextUnavailable()
            return
        if not self.entered or self.admission is None:
            raise MemoryContextUnavailable()
        try:
            self._check_source()
            self.admission = self._readmit(self.admission.context)
        except Exception:
            self.entered = False
            raise MemoryContextUnavailable() from None

    @_serialized_dependencies
    def prepare_model(self, state, *, checkpoint=False):
        if not self.enabled:
            return None
        self.check()
        self.retained_tasks_held(state)
        context = self.admission.context
        inclusions = {item.memory_id: item for item in context.inclusions}
        proofs = []
        if state.get("injected_memories"):
            proofs.append((state.get(RETRIEVAL_PROOF_KEY), "\n".join(state.get("injected_memory_contents") or [])))
        for message in state.get("messages", []):
            if isinstance(message, ToolMessage) and message.name in {"retrieve_memories", "search_memories"}:
                if isinstance(message.content, str) and message.content in {"No relevant memories found.", "Memory retrieval temporarily unavailable.", "No currently authorized memories."} and not message.artifact:
                    continue
                proofs.append(((message.artifact or {}).get(RETRIEVAL_PROOF_KEY), message.content))
        for proof, rendered in proofs:
            addition = verify_retrieval_proof(owner_id=self.owner, proof=proof, rendered_text=rendered)
            if addition is None:
                self.entered = False
                raise MemoryContextUnavailable()
            # An admission may add exact revisions, never silently replace a
            # retained revision after an edit. The latter requires rotation.
            for item in addition.inclusions:
                if item.memory_id in inclusions and inclusions[item.memory_id] != item:
                    self.entered = False
                    raise MemoryContextUnavailable()
                inclusions[item.memory_id] = item
        union = RetainedMemoryContext(context.owner_ref, context.revocation_epoch, tuple(inclusions.values()))
        self.admission = self._readmit(union)
        from deerflow.sophia.memory_governance.source_attachment_run import ATTACHMENT_BLOCK_PREFIX, attachment_reference_block
        blocks = state.get("system_prompt_blocks", [])
        current_blocks = [block for block in blocks if not block.lstrip().startswith(ATTACHMENT_BLOCK_PREFIX)]
        reference_block = attachment_reference_block(owner_id=self.owner, sources=self.source_dependencies)
        if reference_block is not None:
            current_blocks.append(reference_block)
        update = {"memory_context_proof": seal_context(owner_id=self.owner, context_id=self.context_id,
            messages=state["messages"], blocks=current_blocks, admission=self.admission)}
        if current_blocks != blocks:
            update["system_prompt_blocks"] = current_blocks
        if checkpoint:
            # Persist the exact owned pre-model state even if immediate final
            # admission or transport later fails. Include this node's context
            # proof update in the sealed state, not the preceding channel view.
            # Integrity is historical provenance, never resumed-model consent.
            update[CHECKPOINT_PROOF_KEY] = seal_checkpoint(owner_id=self.owner, context_id=self.context_id,
                state={**state, **update}, admission=self.admission, run_id=self.config.get(INPUT_RUN_KEY),
                source_dependencies=self.source_dependencies)
        return update

    @_serialized_dependencies
    def _bind_completion_sources(self, *, binding, child_state, child_context):
        """Capture verified provenance only; final completion dispatch stays held."""
        from deerflow.sophia.memory_governance.completion_source_binding import CompletionSourceBindingService, CompletionSourceRequest
        from deerflow.sophia.memory_governance.store import configured_memory_store
        try:
            origin = self._completion_origin
            if origin is None or origin["child_run_id"] != binding.child_run_id:
                raise MemoryContextUnavailable()
            store = configured_memory_store()
            service = CompletionSourceBindingService(owner_id=self.owner, store=store)
            if self.completion_binding is not None:
                current = service.verify_historical_binding(self.completion_binding)
                if current.request.child_checkpoint_ref != child_state[CHECKPOINT_PROOF_KEY]["state_ref"] or current.request.child_binding != binding:
                    raise MemoryContextUnavailable()
                return
            fields = {"schema": "mem00.completion-source-request.v1", "contract_epoch": 1,
                "parent_thread_id": self.context_id, "completion_run_id": self.config.get(INPUT_RUN_KEY),
                **{key: value for key, value in origin.items() if key != "child_run_id"},
                "child_checkpoint_ref": child_state[CHECKPOINT_PROOF_KEY]["state_ref"], "child_binding": binding,
                "child_memory_manifest": [{"memory_id": str(item.memory_id), "content_revision": item.content_revision,
                    "memory_governance_revision": item.governance_revision} for item in child_context.inclusions],
                "source_dependencies": list(self.source_dependencies), "scope": self.scope,
                "initial_memory_manifest": [{"memory_id": str(item.memory_id), "content_revision": item.content_revision,
                    "memory_governance_revision": item.governance_revision} for item in self.admission.context.inclusions]}
            existing = service.lookup(completion_run_id=self.config.get(INPUT_RUN_KEY))
            if existing is not None:
                # A restarted guard has fresh read-admission observations, but
                # cannot rewrite the immutable original association. Compare
                # every origin/union field; retain original diagnostic clocks
                # and admission ID. Current checks above remain independent.
                expected = CompletionSourceRequest.model_validate({**fields, "prior_admission_id": existing.request.prior_admission_id,
                    "catalog_generation": existing.request.catalog_generation, "revocation_epoch": existing.request.revocation_epoch})
                if expected != existing.request:
                    raise MemoryContextUnavailable()
                self.completion_binding = existing
                return
            clock = store.get_user_governance(self.owner)
            request = CompletionSourceRequest.model_validate({**fields, "prior_admission_id": str(self.admission.prompt_admission_id),
                "catalog_generation": clock.user_catalog_generation, "revocation_epoch": clock.user_revocation_epoch})
            self.completion_binding = service.register(request)
        except Exception:
            self.entered = False
            raise MemoryContextUnavailable() from None

    @_serialized_dependencies
    def finish(self, state):
        if not self.enabled:
            return None
        self.check()
        self.retained_tasks_held(state)
        return {CHECKPOINT_PROOF_KEY: seal_checkpoint(owner_id=self.owner, context_id=self.context_id, state=state,
            admission=self.admission, run_id=self.config.get(INPUT_RUN_KEY), source_dependencies=self.source_dependencies)}

    @_serialized_dependencies
    def final_dispatch_authority(self, wire):
        """Bind trusted current run provenance to the actual serialized attempt.

        Rechecking retained revisions never stamps a new epoch onto stale text.
        The final SQL gate independently revalidates these exact observations.
        A child uses its durable child-run binding, never a relabeled parent
        input witness. Completion uses its own exact durable parent-run binding.
        """
        from deerflow.sophia.memory_governance.model_dispatch import FinalModelAttempt, FinalModelDispatchAuthority, snapshot_model_request
        from deerflow.sophia.memory_governance.service import MemoryProviderContract
        from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, configured_memory_store
        try:
            if active_model_guard() is not self:
                raise MemoryContextUnavailable()
            if self.resume_binding is not None or self.resumed_completion_binding is not None or self._resumed_completion_pending:
                raise MemoryContextUnavailable()
            if self.undeclared:
                # Neither SQL permit can answer for this owner: the governed one
                # requires authority_state='governed', the legacy one a durable
                # 'legacy' declaration. Sending them through either turns "not in
                # the pilot" into "cannot use the product". Nothing was admitted
                # -- prepare_model returned None and self.admission is still None
                # -- so there is no memory here for a permit to authorize. The
                # emptiness is proven at the authority boundary, not assumed.
                from deerflow.sophia.memory_governance.no_memory_model_dispatch import NoMemoryModelAttempt, NoMemoryModelDispatchAuthority
                self.check()
                if self.config.get("langgraph_auth_user_id") != self.owner:
                    raise MemoryContextUnavailable()
                attempt = NoMemoryModelAttempt.model_validate({"schema": "mem00.no-memory-model-attempt.v1",
                    "attempt_id": str(uuid4()), "run_id": self.config.get(INPUT_RUN_KEY), "thread_id": self.context_id,
                    "scope": self.scope, "authority_state": "unknown", "memory_material_present": False,
                    **snapshot_model_request(wire).__dict__})
                return NoMemoryModelDispatchAuthority(owner_id=self.owner, attempt=attempt, memory_state=(
                    self.entered, self.admission, self.source_witness, self.source_dependencies,
                    self.builder_binding, self.completion_binding, self.resume_binding,
                    self.resumed_completion_binding, self._resumed_completion_pending,
                    self.completion_task_id, self._rebuilt_source_view_ref, self._rebuilt_source_count,
                    self._retained_task_marker, self._last_model_result_receipts))
            if not self.enabled:
                from deerflow.sophia.memory_governance.legacy_model_dispatch import LegacyModelAttempt, LegacyModelDispatchAuthority
                self.check()
                if self.config.get("langgraph_auth_user_id") != self.owner:
                    raise MemoryContextUnavailable()
                attempt = LegacyModelAttempt.model_validate({"schema": "mem00.legacy-model-attempt.v1",
                    "attempt_id": str(uuid4()), "run_id": self.config.get(INPUT_RUN_KEY), "thread_id": self.context_id,
                    "scope": self.scope, "contract_epoch": 1, **snapshot_model_request(wire).__dict__})
                return LegacyModelDispatchAuthority(owner_id=self.owner, attempt=attempt, store=configured_memory_store())
            if all(value is None for value in (self.source_witness, self.builder_binding, self.completion_binding,
                self.resume_binding, self.resumed_completion_binding)):
                raise MemoryContextUnavailable()
            self.check()
            if self.admission.context is None or self.admission.prompt_admission_id is None:
                raise MemoryContextUnavailable()
            store = configured_memory_store()
            clock = store.get_user_governance(self.owner)
            if clock.user_id != self.owner or clock.user_revocation_epoch != self.admission.context.revocation_epoch:
                raise MemoryContextUnavailable()
            provider = MemoryProviderContract.from_environ()
            attempt_data = {
                "schema": "mem00.model-attempt.v4", "attempt_id": str(uuid4()), "run_id": self.config.get(INPUT_RUN_KEY),
                "thread_id": self.context_id, "scope": self.scope, "contract_epoch": provider.contract_epoch,
                **snapshot_model_request(wire).__dict__, "source_witness": self.source_witness.model_dump(mode="json", by_alias=True) if self.source_witness else None,
                "builder_binding": self.builder_binding.model_dump(mode="json", by_alias=True) if self.builder_binding else None,
                "completion_binding": self.completion_binding.model_dump(mode="json", by_alias=True) if self.completion_binding else None,
                "source_dependencies": [item.model_dump(mode="json", by_alias=True) for item in self.source_dependencies],
                "prior_admission_id": str(self.admission.prompt_admission_id),
                "authorized_manifest": [{"memory_id": str(item.memory_id), "content_revision": item.content_revision,
                    "memory_governance_revision": item.governance_revision} for item in self.admission.context.inclusions],
                "catalog_generation": clock.user_catalog_generation, "revocation_epoch": clock.user_revocation_epoch,
                "provider": provider.provider, "environment": provider.environment, "provider_project": provider.project,
                "provider_namespace": clock.provider_subject,
            }
            attempt_type, authority_type = FinalModelAttempt, FinalModelDispatchAuthority
            attempt = attempt_type.model_validate(attempt_data)
            return authority_type(owner_id=self.owner, attempt=attempt, store=store)
        except Exception:
            self.entered = False
            raise MemoryGovernanceUnavailable("memory_model_authority_unavailable") from None

    def resolve_child_execution(self, *, child_context_id, child_run_id):
        """Deferred C1 transition; C2 admits original source-only children only."""
        raise MemoryContextUnavailable()

    def resolve_child_association(self, *, child_context_id, child_run_id):
        """Read-only historical identity proof; grants no child text permission."""
        from deerflow.sophia.memory_governance.builder_source_binding import BuilderSourceBindingService
        from deerflow.sophia.memory_governance.store import configured_memory_store
        try:
            if not self.enabled:
                raise MemoryContextUnavailable()
            return BuilderSourceBindingService(owner_id=self.owner, store=configured_memory_store()).resolve_child(
                parent_thread_id=self.context_id, child_thread_id=child_context_id, child_run_id=child_run_id)
        except Exception:
            raise MemoryContextUnavailable() from None

    @_serialized_dependencies
    def admit_child_execution_checkpoint(self, *, execution, state):
        """Deferred C1 transition; C2 admits original source-only children only."""
        raise MemoryContextUnavailable()

    @_serialized_dependencies
    def admit_child_checkpoint(self, *, child_context_id, child_run_id, state):
        """Join a completed child's exact sources before importing derivatives.

        The checkpoint must belong to this owner and a child delegated by this
        parent. Re-admit both source manifests and retain their complete union;
        an old result cannot become fresh merely because its SDK status changed.
        """
        if not self.enabled:
            return
        self.check()
        if not child_run_id:
            raise MemoryContextUnavailable()
        context = verify_checkpoint_seal(owner_id=self.owner, context_id=child_context_id, run_id=child_run_id, state=state)
        delegation = state.get("delegation_context")
        if context is None or not isinstance(delegation, dict) or delegation.get("parent_user_id") != self.owner or delegation.get("parent_thread_id") != self.context_id:
            raise MemoryContextUnavailable()
        from deerflow.sophia.memory_governance.context_provenance import verified_checkpoint_sources
        from deerflow.sophia.memory_governance.source_dependencies import merge_source_dependencies
        sources = verified_checkpoint_sources(owner_id=self.owner, context_id=child_context_id, run_id=child_run_id, state=state)
        try:
            binding = self.resolve_child_association(child_context_id=child_context_id, child_run_id=child_run_id)
            if list(sources) != binding.source_dependencies:
                raise MemoryContextUnavailable()
            inclusions = {(str(item.memory_id), item.content_revision, item.governance_revision) for item in context.inclusions}
            if any((str(item.memory_id), item.content_revision, item.memory_governance_revision) not in inclusions for item in binding.initial_memory_manifest):
                raise MemoryContextUnavailable()
        except Exception:
            raise MemoryContextUnavailable() from None
        self.source_dependencies = merge_source_dependencies(owner_id=self.owner, groups=[self.source_dependencies, sources])
        self._check_source()
        child = self._readmit(context)
        current = self.admission.context
        inclusions = {item.memory_id: item for item in current.inclusions}
        for item in child.context.inclusions:
            if item.memory_id in inclusions and inclusions[item.memory_id] != item:
                raise MemoryContextUnavailable()
            inclusions[item.memory_id] = item
        # Recheck the full union through the current canonical authority after
        # both reads; choosing the older observed epoch conservatively covers
        # any intervening revocation. Proofs alone never authorize the content.
        union = RetainedMemoryContext(current.owner_ref, min(current.revocation_epoch, child.context.revocation_epoch), tuple(inclusions.values()))
        self.admission = self._readmit(union)
        if self.completion_task_id == str(child_context_id):
            self._bind_completion_sources(binding=binding, child_state=state, child_context=context)


class MemoryContextEntryMiddleware(AgentMiddleware[MemoryContextState]):
    state_schema = MemoryContextState

    def __init__(self, guard):
        self.guard = guard
        self._compiled_replacement_channels = None

    def bind_compiled_state_channels(self, channels):
        """Bind actual compiled channel kinds, including middleware state.

        Content and channel values are never copied. The factory supplies this
        once after compilation; a resumed checkpoint cannot supply its schema.
        """
        from langgraph.channels.base import BaseChannel
        from langgraph.channels.binop import BinaryOperatorAggregate

        if not isinstance(channels, dict) or not channels or any(
            not isinstance(key, str) or not isinstance(channel, BaseChannel)
            for key, channel in channels.items()
        ):
            raise MemoryContextUnavailable()
        kinds = {key: isinstance(channel, BinaryOperatorAggregate) for key, channel in channels.items()}
        if self._compiled_replacement_channels is not None and self._compiled_replacement_channels != kinds:
            raise MemoryContextUnavailable()
        self._compiled_replacement_channels = kinds

    def _entry_update(self, update):
        if self.guard.resume_binding is None or update is None:
            return update
        # A resume is a complete replacement, not ordinary reducer input.
        # Derive channel kinds from the same schema used by the actual Builder;
        # list shape alone cannot distinguish LastValue from reducer channels.
        from langgraph.channels.binop import BinaryOperatorAggregate
        from langgraph.graph import StateGraph
        from langgraph.types import Overwrite

        from deerflow.agents.sophia_agent.state import SophiaState

        try:
            channels = self._compiled_replacement_channels
            if channels is None:
                channels = {key: isinstance(channel, BinaryOperatorAggregate)
                    for key, channel in StateGraph(SophiaState).channels.items()}
            result = {}
            for key, value in update.items():
                if key not in channels:
                    if value not in (None, [], {}, False, ""):
                        raise MemoryContextUnavailable()
                    continue
                result[key] = Overwrite(value) if channels[key] else value
            return result
        except Exception:
            self.guard.entered = False
            raise MemoryContextUnavailable() from None

    def before_agent(self, state, runtime):
        return self._entry_update(self.guard.enter(state))

    async def abefore_agent(self, state, runtime):
        return self._entry_update(await asyncio.to_thread(self.guard.enter, state))

    def before_model(self, state, runtime):
        self.guard.check()

    async def abefore_model(self, state, runtime):
        await asyncio.to_thread(self.guard.check)

    def wrap_model_call(self, request, handler):
        from deerflow.sophia.memory_governance.model_result_provenance import model_result_sink, scoped_result_receipts
        self.guard.check()
        self.guard._last_model_result_receipts = ()
        token = _active_model_guard.set(self.guard)
        try:
            with model_result_sink() as receipts:
                result = handler(request)
        finally:
            _active_model_guard.reset(token)
        self.guard.check()  # Abort before any after-model consumer on drift.
        self.guard._last_model_result_receipts = scoped_result_receipts(receipts, owner_id=self.guard.owner,
            run_id=self.guard.config.get(INPUT_RUN_KEY), thread_id=self.guard.context_id)
        return result

    async def awrap_model_call(self, request, handler):
        from deerflow.sophia.memory_governance.model_result_provenance import model_result_sink, scoped_result_receipts
        await asyncio.to_thread(self.guard.check)
        self.guard._last_model_result_receipts = ()
        token = _active_model_guard.set(self.guard)
        try:
            with model_result_sink() as receipts:
                result = await handler(request)
        finally:
            _active_model_guard.reset(token)
        await asyncio.to_thread(self.guard.check)
        self.guard._last_model_result_receipts = scoped_result_receipts(receipts, owner_id=self.guard.owner,
            run_id=self.guard.config.get(INPUT_RUN_KEY), thread_id=self.guard.context_id)
        return result

    def wrap_tool_call(self, request, handler):
        from deerflow.sophia.memory_governance.model_tool_origin import bind_model_tool_origin, prepare_model_tool_origin
        self.guard.check()
        if held := self.guard.held_task_tool_result(request):
            return held
        origin = prepare_model_tool_origin(self.guard, request)
        token = _active_tool_guard.set(self.guard)
        try:
            with bind_model_tool_origin(origin):
                result = handler(request)
        finally:
            _active_tool_guard.reset(token)
        self.guard.check()
        return result

    async def awrap_tool_call(self, request, handler):
        from deerflow.sophia.memory_governance.model_tool_origin import bind_model_tool_origin, prepare_model_tool_origin, settle_file_handler
        await asyncio.to_thread(self.guard.check)
        if held := await asyncio.to_thread(self.guard.held_task_tool_result, request):
            return held
        origin = await asyncio.to_thread(prepare_model_tool_origin, self.guard, request)
        token = _active_tool_guard.set(self.guard)
        try:
            with bind_model_tool_origin(origin):
                result = await settle_file_handler(origin, handler, request)
        finally:
            _active_tool_guard.reset(token)
        await asyncio.to_thread(self.guard.check)
        return result

    def after_agent(self, state, runtime):
        return self.guard.finish(state)

    async def aafter_agent(self, state, runtime):
        return await asyncio.to_thread(self.guard.finish, state)


class MemoryContextModelProducer(AgentMiddleware[MemoryContextState]):
    state_schema = MemoryContextState

    def __init__(self, guard):
        self.guard = guard

    def before_model(self, state, runtime):
        return self.guard.prepare_model(state, checkpoint=True)

    async def abefore_model(self, state, runtime):
        return await asyncio.to_thread(self.guard.prepare_model, state, checkpoint=True)


class MemoryContextBeforeConsumer(AgentMiddleware[MemoryContextState]):
    """Readmit newly retrieved inclusions before an early briefing consumer."""

    state_schema = MemoryContextState

    def __init__(self, guard):
        self.guard = guard

    def before_agent(self, state, runtime):
        return self.guard.prepare_model(state)

    async def abefore_agent(self, state, runtime):
        return await asyncio.to_thread(self.guard.prepare_model, state)
