"""Bounded same-session source reconstruction, not a checkpoint approval.

Only the run-entry guard may call this after verifying the old checkpoint and
current input. We reread exact source occurrences, not arbitrary transcripts.
Unknown/task-bearing state stays held. No database or filesystem writes occur.
"""

from langchain_core.messages import HumanMessage, RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from .context_provenance import CHECKPOINT_PROOF_KEY, MAX_SNAPSHOT_BYTES, _json
from .pending_input_recovery import checkpoint_source_history
from .refs import keyed_ref
from .source_attachment import SourceAttachment
from .source_dependencies import merge_source_dependencies, recheck_model_source_dependencies, source_dependencies
from .source_input_provenance import SourceInputWitness
from .store import MemoryGovernanceUnavailable
from .task_context_retention import TASK_RETENTION_KEY, retain_verified_tasks

RECOVERY_KEY = "memory_chat_recovery_receipt"
# Only these owned transient channels may be replaced. In particular, Builder
# tasks, summaries, artifact state and unknown extensions are not discarded.
# These owned derived fields are reset; ordinary middleware recomputes routing
# from current runtime configuration and the independently authorized view.
# The old compaction marker/skill history do not bless memory-derived state.
# Thread paths are not a license to read files: the entry guard separately
# requires the native workspace/uploads/outputs surface to be empty.
RECOMPUTED = {"thread_data": {}, "platform": None, "turn_count": 0, "context_mode": None,
    "active_tone_band": None, "active_skill": None, "skill_session_data": {}, "was_summarized": False}
# These two identity/display fields are retained ONLY in the strict neutral
# forms checked below. An arbitrary title may contain generated memory text or
# user-authored state; it is not erased or relabeled as a safe routing channel.
REPLACEABLE = {*RECOMPUTED, "user_id", "title", "messages", "system_prompt_blocks", "injected_memories", "injected_memory_contents",
    "memory_context_proof", "memory_retrieval_proof", CHECKPOINT_PROOF_KEY, RECOVERY_KEY}
PRESERVABLE = {"async_tasks", TASK_RETENTION_KEY}
FIELDS = {"id", "message_id", "user_id", "session_id", "thread_id", "sequence", "role", "content", "final", "memory_source_version"}


def rebuilt_source_view_ref(messages, dependencies):
    """Bind the exact transcript prefix and attachment references, not authority."""
    model_view = [message.model_dump(mode="json") for message in messages]
    attachments = [item for item in dependencies if isinstance(item, SourceAttachment)]
    if attachments:
        model_view = {"messages": model_view, "attachments": [item.model_dump(mode="json", by_alias=True) for item in attachments]}
    return keyed_ref("chat-recovery-source-view", _json(model_view))


def rebuild_plain_chat_sources(*, owner_id, context_id, run_id, previous, current, current_witness, dependencies, store, current_sources=None):
    """Return a model-view replacement from fully current recorded sources.

    Caller supplies verified provenance; we independently check every source
    again before and after text hydration. Final dispatch still needs its own
    atomic SQL permit. Old assistant/tool output is never a reconstruction input.
    """
    try:
        if "user_id" in previous and previous["user_id"] != owner_id:
            raise ValueError("state_owner_mismatch")
        if previous.get("title") not in (None, "", "New session"):
            raise ValueError("nonneutral_title")
        if any(value not in (None, [], {}, False, "") for key, value in previous.items() if key not in REPLACEABLE | PRESERVABLE):
            raise ValueError("task_or_unknown_state")
        proof = previous[CHECKPOINT_PROOF_KEY]
        values = source_dependencies(owner_id=owner_id, values=dependencies)
        # The entry guard supplies this group from its verified run seal,
        # before merging checkpoint ancestry. Never infer current origin from
        # the combined dependency list or accept an older action as fresh.
        fresh = source_dependencies(owner_id=owner_id, values=current_sources if current_sources is not None else [current_witness])
        if current_witness not in fresh or any(
            item != current_witness if isinstance(item, SourceInputWitness) else item.request.source_witness != current_witness
            for item in fresh
        ):
            raise ValueError("current_source_ancestry_changed")
        history = checkpoint_source_history(owner_id=owner_id, context_id=context_id, state=previous, current_witness=current_witness, store=store)
        retained_tasks = retain_verified_tasks(owner_id=owner_id, context_id=context_id, previous=previous, history=history, store=store)
        original = history.sources
        if values != merge_source_dependencies(owner_id=owner_id, groups=[original, fresh]):
            raise ValueError("source_ancestry_changed")
        if any((item.thread_id, item.session_id) != (context_id, current_witness.session_id) for item in values):
            raise ValueError("cross_session_source")
        transcript_sources = tuple(item for item in values if isinstance(item, SourceInputWitness))
        if not transcript_sources or transcript_sources[-1] != current_witness:
            raise ValueError("current_source_not_latest")
        recheck_model_source_dependencies(owner_id=owner_id, current_witness=current_witness, values=values, store=store)
        messages = []
        total = 0
        for item in transcript_sources:
            rows = store._request("GET", "sophia_session_messages", params={
                "select": ",".join(sorted(FIELDS)), "id": "eq." + item.source_row_id,
                "user_id": "eq." + owner_id, "session_id": "eq." + item.session_id,
                "thread_id": "eq." + context_id, "limit": "2"})
            if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) or set(rows[0]) != FIELDS:
                raise ValueError("source_shape")
            row = rows[0]
            if (row["id"], row["message_id"], row["user_id"], row["session_id"], row["thread_id"], row["sequence"], row["memory_source_version"]) != (
                item.source_row_id, item.message_id, owner_id, item.session_id, context_id, item.sequence, item.source_version
            ) or type(row["sequence"]) is not int or row["role"] != "user" or row["final"] is not True:
                raise ValueError("source_binding")
            content = row["content"]
            if not isinstance(content, str) or keyed_ref("source-action-content", content) != item.content_ref:
                raise ValueError("source_content")
            total += len(content.encode())
            if total > MAX_SNAPSHOT_BYTES:
                raise ValueError("source_budget")
            messages.append(HumanMessage(id=item.message_id, content=content))
        if not isinstance(current, HumanMessage) or messages[-1].model_dump() != current.model_dump():
            raise ValueError("current_input_changed")
        recheck_model_source_dependencies(owner_id=owner_id, current_witness=current_witness, values=values, store=store)
        # Bind references without hydrating bytes, cached output or filenames.
        # Document reads and final dispatch independently recheck associations.
        return {**{key: value.copy() if isinstance(value, dict) else value for key, value in RECOMPUTED.items() if key in previous},
            **({TASK_RETENTION_KEY: retained_tasks} if retained_tasks is not None else {}),
            "messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *messages],
            "system_prompt_blocks": [], "injected_memories": [], "injected_memory_contents": [],
            "memory_context_proof": None, "memory_retrieval_proof": None, CHECKPOINT_PROOF_KEY: None,
            RECOVERY_KEY: {"schema": "mem00.chat-context-recovery.v1", "origin_state_ref": proof["state_ref"],
                "run_ref": keyed_ref("run", run_id), "source_count": len(values),
                "pending_source_count": history.pending_count,
                "retained_task_count": len(previous.get("async_tasks") or {}),
                "task_model_reuse_granted": False,
                "task_retention_ref": keyed_ref("task-retention", _json(retained_tasks)) if retained_tasks is not None else None,
                "source_view_ref": rebuilt_source_view_ref(messages, values),
                "scope": "model_view_only", "final_dispatch_permission": False}}
    except Exception:
        raise MemoryGovernanceUnavailable("memory_chat_source_recovery_unavailable") from None
