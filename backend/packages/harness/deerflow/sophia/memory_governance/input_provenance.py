"""Server-authenticated current user input; never a retained-history approval.

Only the LangGraph create-run authorization hook issues this seal. It replaces
the final wire HumanMessage with a server-ID message and signs that message,
owner, thread and run. Earlier messages (including continuation summaries) are
NOT authenticated as fresh input. No plaintext is stored in the proof.
"""

from __future__ import annotations

import hmac
import json
from uuid import UUID, uuid4

from langchain_core.messages import HumanMessage

from .refs import keyed_ref

INPUT_PROOF_KEY = "sophia_authenticated_input_v1"
INPUT_RUN_KEY = "sophia_authenticated_input_run_id"
SCHEMA = "mem00.authenticated-input.v1"
RECORDED_SCHEMA = "mem00.authenticated-input.v2"
MAX_INPUT_BYTES = 1024 * 1024


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _message_ref(message):
    if not isinstance(message, HumanMessage) or not message.id:
        raise ValueError("authenticated_input_invalid")
    value = _json(message.model_dump(mode="json"))
    if len(value.encode()) > MAX_INPUT_BYTES:
        raise ValueError("authenticated_input_too_large")
    return keyed_ref("authenticated-input-message", value)


def issue_authenticated_input(*, owner_id, thread_id, run_id, wire_input):
    """Auth-hook only: return sanitized current input plus a content-free seal.

    The caller has already verified the bearer subject and owner filter. This
    function cannot authenticate a token or authorize any retrieved memory.
    """
    thread_id, run_id = str(UUID(str(thread_id))), str(UUID(str(run_id)))
    if not isinstance(owner_id, str) or not owner_id:
        raise ValueError("authenticated_input_owner_invalid")
    if not isinstance(wire_input, dict) or set(wire_input) != {"messages"}:
        raise ValueError("authenticated_input_fields_invalid")
    messages = wire_input["messages"]
    if not isinstance(messages, list) or not messages:
        raise ValueError("authenticated_input_messages_invalid")
    current = messages[-1]
    if not isinstance(current, dict) or current.get("role", current.get("type")) not in {"user", "human"}:
        raise ValueError("authenticated_input_role_invalid")
    if set(current) - {"role", "type", "content", "id"}:
        raise ValueError("authenticated_input_message_fields_invalid")
    content = current.get("content")
    if not isinstance(content, (str, list)):
        raise ValueError("authenticated_input_content_invalid")
    message = HumanMessage(content=content, id=str(uuid4()))
    body = {"schema": SCHEMA, "owner_ref": keyed_ref("owner", owner_id),
            "thread_ref": keyed_ref("context", thread_id), "run_ref": keyed_ref("run", run_id),
            "message_ref": _message_ref(message)}
    proof = {**body, "seal": keyed_ref("authenticated-input-seal", _json(body))}
    # Earlier input is discarded, not signed. The stored checkpoint is handled
    # separately by the retained-context boundary before any consumer runs.
    return {"messages": [message.model_dump(mode="json")]}, proof


def verified_current_input(*, proof, owner_id, thread_id, run_id, messages):
    """Return a copy of just the exact authenticated HumanMessage, else None."""
    try:
        if not isinstance(proof, dict):
            return None
        recorded = proof.get("schema") == RECORDED_SCHEMA
        fields = {"schema", "owner_ref", "thread_ref", "run_ref", "message_ref", "seal"} | ({"source_witness"} if recorded else set())
        if set(proof) != fields:
            return None
        if (proof["schema"] not in {SCHEMA, RECORDED_SCHEMA} or proof["owner_ref"] != keyed_ref("owner", owner_id)
                or proof["thread_ref"] != keyed_ref("context", str(UUID(str(thread_id))))
                or proof["run_ref"] != keyed_ref("run", str(UUID(str(run_id))))):
            return None
        body = {key: value for key, value in proof.items() if key != "seal"}
        if not isinstance(proof["seal"], str) or not hmac.compare_digest(proof["seal"], keyed_ref("authenticated-input-seal", _json(body))):
            return None
        if not isinstance(messages, (list, tuple)) or not messages or not isinstance(messages[-1], HumanMessage):
            return None
        message = messages[-1]
        if _message_ref(message) != proof["message_ref"]:
            return None
        if recorded:
            from .source_input_provenance import SourceInputWitness
            witness = SourceInputWitness.model_validate(proof["source_witness"])
            if (witness.owner_id, witness.thread_id, witness.message_id, witness.content_ref) != (
                owner_id, str(UUID(str(thread_id))), message.id, keyed_ref("source-action-content", message.content)
            ):
                return None
        return message.model_copy(deep=True)
    except Exception:
        return None


def issue_recorded_authenticated_input(*, owner_id, session_id, thread_id, run_id, wire_input, source_action, store):
    """Auth hook for ordinary human input. No source writes or receipt-as-permit."""
    from .source_input_provenance import observe_recorded_source
    from .source_intake import SourceActionRequest

    action = SourceActionRequest.model_validate(source_action)
    thread_id, run_id = str(UUID(str(thread_id))), str(UUID(str(run_id)))
    sanitized, _ = issue_authenticated_input(owner_id=owner_id, thread_id=thread_id, run_id=run_id, wire_input=wire_input)
    current = HumanMessage(**sanitized["messages"][0])
    # Attachment/spill transformations need their own exact authenticated
    # mapping. Until that is supplied, never sign different text as this source.
    if not isinstance(current.content, str) or current.content != action.content:
        raise ValueError("recorded_input_transform_unproven")
    witness = observe_recorded_source(owner_id=owner_id, session_id=session_id, thread_id=thread_id, action=action, store=store)
    message = HumanMessage(content=action.content, id=witness.message_id)
    body = {"schema": RECORDED_SCHEMA, "owner_ref": keyed_ref("owner", owner_id), "thread_ref": keyed_ref("context", thread_id),
        "run_ref": keyed_ref("run", run_id), "message_ref": _message_ref(message), "source_witness": witness.model_dump(mode="json", by_alias=True)}
    return {"messages": [message.model_dump(mode="json")]}, {**body, "seal": keyed_ref("authenticated-input-seal", _json(body))}
