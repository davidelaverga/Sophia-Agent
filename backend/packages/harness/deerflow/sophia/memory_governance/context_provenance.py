"""Content-free server seal for an EXACT retained model-input snapshot.

The seal proves origin/integrity, not present consent. Verification must be
followed by canonical re-admission. New input, tool output, compaction, block
changes and Builder delegation each need an independently trusted transition;
this helper deliberately does not infer those transitions from caller state.
"""

import hmac
import json

from .refs import keyed_ref
from .retained_admission import RetainedAdmission
from .retained_context import decode_context_manifest, encode_context_manifest

SCHEMA = "mem00.context-provenance.v1"
MAX_MESSAGES = 2048
MAX_BLOCKS = 128
MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
CHECKPOINT_PROOF_KEY = "memory_checkpoint_proof"


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _snapshot_refs(messages, blocks):
    if not isinstance(messages, (list, tuple)) or not 1 <= len(messages) <= MAX_MESSAGES:
        raise ValueError("context_messages_invalid")
    if not isinstance(blocks, (list, tuple)) or len(blocks) > MAX_BLOCKS or any(not isinstance(block, str) for block in blocks):
        raise ValueError("context_blocks_invalid")
    message_refs = []
    total = sum(len(block.encode()) for block in blocks)
    for message in messages:
        # Include tool calls, artifacts, additional kwargs and message IDs, not
        # merely visible text. Unsupported message types cannot be silently lost.
        from langchain_core.messages import BaseMessage
        if not isinstance(message, BaseMessage):
            raise ValueError("context_message_type_invalid")
        value = _json(message.model_dump(mode="json"))
        total += len(value.encode())
        if total > MAX_SNAPSHOT_BYTES:
            raise ValueError("context_snapshot_too_large")
        message_refs.append(keyed_ref("context-message", value))
    return message_refs, [keyed_ref("context-block", block) for block in blocks]


def seal_context(*, owner_id: str, context_id: str, messages, blocks, admission: RetainedAdmission) -> dict:
    """Called only by a trusted model/transition boundary, never an API route.

    Passing a caller's messages through this function would launder provenance.
    A producer must first establish every input's source and inclusion union.
    """
    if not isinstance(owner_id, str) or not owner_id or not isinstance(context_id, str) or not context_id:
        raise ValueError("context_identity_invalid")
    if admission.transition.action != "continue" or admission.context is None or admission.prompt_admission_id is None:
        raise ValueError("context_admission_required")
    owner_ref = keyed_ref("owner", owner_id)
    if admission.context.owner_ref != owner_ref:
        raise ValueError("context_owner_mismatch")
    expected = {(item.memory_id, item.content_revision, item.governance_revision) for item in admission.context.inclusions}
    actual = {(item.memory_id, item.content_revision, item.memory_governance_revision) for item in admission.memories}
    if expected != actual or len(admission.memories) != len(expected):
        raise ValueError("context_inclusion_union_incomplete")
    message_refs, block_refs = _snapshot_refs(messages, blocks)
    body = {
        "schema": SCHEMA, "owner_ref": owner_ref, "context_ref": keyed_ref("context", context_id),
        "manifest": encode_context_manifest(admission.context), "message_refs": message_refs, "block_refs": block_refs,
        "admission_ref": keyed_ref("prompt-admission", str(admission.prompt_admission_id)),
    }
    return {**body, "seal": keyed_ref("context-seal", _json(body))}


def verify_context_seal(*, value: object, owner_id: str, context_id: str, messages, blocks):
    """Return structural inclusions only on exact integrity; failures are unbound.

    Do not append a new HumanMessage or trust a new summary/tool result merely
    because this returns a manifest. It authorizes no retained or new text.
    """
    try:
        if not isinstance(value, dict) or set(value) != {"schema", "owner_ref", "context_ref", "manifest", "message_refs", "block_refs", "admission_ref", "seal"}:
            return None
        if value["schema"] != SCHEMA or not owner_id or not context_id:
            return None
        if value["owner_ref"] != keyed_ref("owner", owner_id) or value["context_ref"] != keyed_ref("context", context_id):
            return None
        context = decode_context_manifest(value["manifest"])
        if context is None or context.owner_ref != value["owner_ref"]:
            return None
        message_refs, block_refs = _snapshot_refs(messages, blocks)
        if value["message_refs"] != message_refs or value["block_refs"] != block_refs:
            return None
        body = {key: val for key, val in value.items() if key != "seal"}
        if not isinstance(value["seal"], str) or not hmac.compare_digest(value["seal"], keyed_ref("context-seal", _json(body))):
            return None
        return context
    except Exception:
        return None


def _state_ref(state):
    from langchain_core.messages import BaseMessage
    def normalize(value):
        if isinstance(value, BaseMessage):
            return value.model_dump(mode="json")
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise ValueError("context_state_key_invalid")
            return {key: normalize(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [normalize(item) for item in value]
        if value is None or type(value) in {str, int, float, bool}:
            return value
        raise ValueError("context_state_type_invalid")
    if not isinstance(state, dict):
        raise ValueError("context_state_invalid")
    value = _json(normalize({key: item for key, item in state.items() if key != CHECKPOINT_PROOF_KEY}))
    if len(value.encode()) > MAX_SNAPSHOT_BYTES:
        raise ValueError("context_snapshot_too_large")
    return keyed_ref("checkpoint-state", value)


def seal_checkpoint(*, owner_id, context_id, state, admission, run_id=None, source_dependencies=None):
    """Trusted final-run or owned pre-model producer; ALL persisted state fields.

    Integrity must cover derivatives such as artifact, emotional summaries,
    delegation descriptions and task state, not just the messages sent to a model.
    A pre-model checkpoint proves neither final admission nor model dispatch.
    """
    context_proof = seal_context(owner_id=owner_id, context_id=context_id,
        messages=state.get("messages"), blocks=state.get("system_prompt_blocks", []), admission=admission)
    from uuid import UUID
    run_ref = keyed_ref("run", str(UUID(str(run_id)))) if run_id is not None else None
    body = {"schema": "mem00.checkpoint-provenance.v2", "context_proof": context_proof, "state_ref": _state_ref(state), "run_ref": run_ref}
    if source_dependencies is not None:
        from .source_dependencies import encode_source_dependencies
        body.update(schema="mem00.checkpoint-provenance.v3", source_dependencies=encode_source_dependencies(owner_id=owner_id, values=source_dependencies))
    return {**body, "seal": keyed_ref("checkpoint-seal", _json(body))}


def verify_checkpoint_seal(*, owner_id, context_id, state, run_id=None):
    try:
        proof = state.get(CHECKPOINT_PROOF_KEY)
        fields = {"schema", "context_proof", "state_ref", "run_ref", "seal"}
        if not isinstance(proof, dict) or proof.get("schema") not in {"mem00.checkpoint-provenance.v2", "mem00.checkpoint-provenance.v3"}:
            return None
        if proof["schema"] == "mem00.checkpoint-provenance.v3":
            from .source_dependencies import source_dependencies
            fields.add("source_dependencies")
            source_dependencies(owner_id=owner_id, values=proof.get("source_dependencies"))
        if set(proof) != fields:
            return None
        if run_id is not None:
            from uuid import UUID
            if proof["run_ref"] != keyed_ref("run", str(UUID(str(run_id)))):
                return None
        if proof["state_ref"] != _state_ref(state):
            return None
        body = {key: value for key, value in proof.items() if key != "seal"}
        if not isinstance(proof["seal"], str) or not hmac.compare_digest(proof["seal"], keyed_ref("checkpoint-seal", _json(body))):
            return None
        # SDK state responses serialize BaseMessage instances to model_dump
        # dictionaries. Verify the exact whole-state digest BEFORE decoding;
        # conversion may not hide extra fields or bless a modified payload.
        from langchain_core.messages import BaseMessage, messages_from_dict
        messages = [item if isinstance(item, BaseMessage) else messages_from_dict([{"type": item["type"], "data": item}])[0]
            for item in state.get("messages", [])]
        return verify_context_seal(value=proof["context_proof"], owner_id=owner_id, context_id=context_id,
            messages=messages, blocks=state.get("system_prompt_blocks", []))
    except Exception:
        return None


def verified_checkpoint_sources(*, owner_id, context_id, state, run_id=None):
    """Old seals can prove structure but cannot invent missing source ancestry."""
    from .source_dependencies import source_dependencies
    from .store import MemoryGovernanceUnavailable

    if verify_checkpoint_seal(owner_id=owner_id, context_id=context_id, state=state, run_id=run_id) is None:
        raise MemoryGovernanceUnavailable("memory_checkpoint_sources_unproven")
    proof = state[CHECKPOINT_PROOF_KEY]
    if proof["schema"] != "mem00.checkpoint-provenance.v3":
        raise MemoryGovernanceUnavailable("memory_checkpoint_sources_unproven")
    return source_dependencies(owner_id=owner_id, values=proof["source_dependencies"])
