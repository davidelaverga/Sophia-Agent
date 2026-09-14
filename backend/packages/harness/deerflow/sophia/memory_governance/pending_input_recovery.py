"""Authenticate pending user occurrences without blessing an unsigned checkpoint.

An interrupted entry can persist the input before any middleware state update.
Verify the exact old whole-state seal after removing only an appended suffix;
then independently prove each suffix item via its immutable intake receipt.
No source, receipt, checkpoint, task or filesystem writes occur here.
"""

import re
from dataclasses import dataclass

from langchain_core.messages import HumanMessage

from .context_provenance import CHECKPOINT_PROOF_KEY, MAX_MESSAGES, _state_ref, verified_checkpoint_sources, verify_checkpoint_seal
from .refs import keyed_ref
from .retained_context import RetainedMemoryContext
from .source_dependencies import MAX_SOURCE_DEPENDENCIES, SourceDependency, merge_source_dependencies
from .source_input_provenance import SourceInputWitness, _witness, recheck_recorded_source
from .source_intake import SourceActionReceipt
from .store import MemoryGovernanceUnavailable


@dataclass(frozen=True)
class CheckpointSourceHistory:
    context: RetainedMemoryContext | None
    sources: tuple[SourceDependency, ...]
    pending_count: int
    origin_clear_epoch: int | None = None


def checkpoint_source_history(*, owner_id, context_id, state, current_witness, store):
    """Current input is checked separately; earlier input is never assumed fresh."""
    try:
        if not isinstance(state, dict) or not isinstance(state.get("messages"), list) or len(state["messages"]) > MAX_MESSAGES:
            raise ValueError("state_shape")
        current_witness = SourceInputWitness.model_validate(
            current_witness.model_dump(mode="python", by_alias=True, warnings=False)
            if isinstance(current_witness, SourceInputWitness) else current_witness
        )
        if (current_witness.owner_id, current_witness.thread_id) != (owner_id, context_id):
            raise ValueError("current_scope")
        context = verify_checkpoint_seal(owner_id=owner_id, context_id=context_id, state=state)
        if context is not None:
            sources = verified_checkpoint_sources(owner_id=owner_id, context_id=context_id, state=state)
            return CheckpointSourceHistory(context, sources, 0, max(item.memory_clear_epoch for item in sources))
        _state_ref(state)  # Bound/validate the complete unsealed state, too.
        proof = state.get(CHECKPOINT_PROOF_KEY)
        if proof is None:
            # First-run entry failure: no generated or task state may be
            # laundered into a fresh context. Every prior message still needs
            # an explicit immutable user-action receipt.
            if any(value not in (None, [], {}, False, "") for key, value in state.items() if key not in {"messages", CHECKPOINT_PROOF_KEY}):
                raise ValueError("unsealed_nonmessage_state")
            original, pending = (), state["messages"]
        else:
            refs = proof["context_proof"]["message_refs"]
            if not isinstance(refs, list) or not 1 <= len(refs) < len(state["messages"]):
                raise ValueError("no_exact_appended_suffix")
            prefix = {**state, "messages": state["messages"][:len(refs)]}
            original = verified_checkpoint_sources(owner_id=owner_id, context_id=context_id, state=prefix)
            context = verify_checkpoint_seal(owner_id=owner_id, context_id=context_id, state=prefix)
            if context is None:
                raise ValueError("old_whole_state_changed")
            pending = state["messages"][len(refs):]
        if not 1 <= len(pending) <= MAX_SOURCE_DEPENDENCIES:
            raise ValueError("pending_bound")
        previous_sequence = max((item.sequence for item in original
            if isinstance(item, SourceInputWitness) and (item.session_id, item.thread_id) == (current_witness.session_id, context_id)), default=0)
        sources = []
        for message in pending:
            if not isinstance(message, HumanMessage) or not isinstance(message.content, str) or not isinstance(message.id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,200}", message.id):
                raise ValueError("not_plain_user_input")
            raw = store.source_action_receipt_for_message(user_id=owner_id, session_id=current_witness.session_id, message_id=message.id)
            receipt = SourceActionReceipt.model_validate(raw)
            witness = _witness(receipt)
            if (witness.owner_id, witness.session_id, witness.thread_id, witness.message_id) != (
                owner_id, current_witness.session_id, context_id, message.id
            ) or witness.memory_clear_epoch > current_witness.memory_clear_epoch or not previous_sequence < witness.sequence < current_witness.sequence:
                raise ValueError("pending_source_order_or_scope")
            if witness.content_ref != keyed_ref("source-action-content", message.content):
                raise ValueError("pending_source_text_changed")
            if message.model_dump(mode="json") != HumanMessage(id=witness.message_id, content=message.content).model_dump(mode="json"):
                raise ValueError("pending_message_metadata")
            if witness.memory_clear_epoch == current_witness.memory_clear_epoch:
                recheck_recorded_source(witness=witness, owner_id=owner_id, thread_id=context_id, store=store)
            else:
                from .source_dependencies import recheck_model_source_dependencies
                recheck_model_source_dependencies(owner_id=owner_id, current_witness=current_witness,
                    values=[witness, current_witness], store=store)
            sources.append(witness)
            previous_sequence = witness.sequence
        groups = [sources] + ([original] if original else [])
        merged = merge_source_dependencies(owner_id=owner_id, groups=groups)
        return CheckpointSourceHistory(context, merged, len(pending), max((item.memory_clear_epoch for item in original), default=None))
    except Exception:
        raise MemoryGovernanceUnavailable("memory_pending_source_history_unproven") from None
