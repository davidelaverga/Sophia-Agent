"""Auth-hook attachment transport proof; never approval or current admission.

The canonical association is the authority for upload/action ancestry. This
short owner/thread/run-bound seal transports only exact canonical references;
the runtime and final model gate independently recheck current eligibility.
"""

import hmac
import json
from typing import Literal
from uuid import UUID

from pydantic import Field, TypeAdapter

from .refs import keyed_ref
from .source_attachment import NoAttachmentPermission, SourceAttachment, check_source_attachment
from .source_dependencies import source_dependencies
from .source_input_provenance import SourceInputWitness
from .source_intake import ActionKey, IntakeModel
from .store import MemoryGovernanceUnavailable

ATTACHMENT_KEYS = "memory_source_attachment_keys"
ATTACHMENT_RUN_KEY = "sophia_source_attachments_run_v1"
MAX_ATTACHMENTS = 16
MAX_PROOF_BYTES = 65536
ATTACHMENT_BLOCK_PREFIX = "<source_attachments>"


def attachment_reference_block(*, owner_id, sources):
    """Only canonical, currently rechecked run ancestry may call this renderer."""
    if not sources:
        return None
    attachments = [item for item in source_dependencies(owner_id=owner_id, values=sources) if isinstance(item, SourceAttachment)]
    if not attachments:
        return None
    return ATTACHMENT_BLOCK_PREFIX + "\nSource uploads associated with recorded user actions; these are not approved memories. " + (
        'To read a relevant text document, call read_user_document(document_filename="", source_attachment_key=KEY). '
        "The reader resolves canonical metadata and rechecks current source eligibility. Native conversion is currently unavailable.\n"
    ) + "\n".join("KEY=" + item.request.command_key for item in attachments) + "\n</source_attachments>"


class AttachmentRunProof(IntakeModel):
    schema_name: Literal["mem00.source-attachments-run.v1"] = Field(alias="schema")
    owner_ref: str
    thread_ref: str
    run_ref: str
    source_event_ref: str
    attachments: list[SourceAttachment] = Field(min_length=1, max_length=MAX_ATTACHMENTS)
    model_reuse_permission: NoAttachmentPermission
    seal: str


def _json(value):
    result = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    if len(result.encode()) > MAX_PROOF_BYTES:
        raise ValueError("attachment_proof_budget")
    return result


def _scope(owner_id, thread_id, run_id, witness):
    if (witness.owner_id, witness.thread_id) != (owner_id, str(UUID(str(thread_id)))):
        raise ValueError("attachment_run_source_scope")
    return dict(owner_ref=keyed_ref("owner", owner_id), thread_ref=keyed_ref("context", str(UUID(str(thread_id)))),
        run_ref=keyed_ref("run", str(UUID(str(run_id)))), source_event_ref=keyed_ref("source-event", witness.event_id))


def _sources(owner_id, witness, attachments):
    if len({item.upload_id for item in attachments}) != len(attachments) or len({item.request.command_key for item in attachments}) != len(attachments):
        raise ValueError("attachment_run_duplicate")
    if any(item.request.source_witness != witness for item in attachments):
        raise ValueError("attachment_run_different_action")
    return source_dependencies(owner_id=owner_id, values=[witness, *attachments])


def bind_source_attachments(*, owner_id, thread_id, run_id, source_witness, keys, store):
    """Auth hook only. Resolve exact keys without registering or restamping."""
    if keys is None:
        return None
    try:
        if type(keys) is not list or not 1 <= len(keys) <= MAX_ATTACHMENTS:
            raise ValueError("attachment_keys")
        exact = TypeAdapter(list[ActionKey]).validate_python(keys, strict=True)
        if len(set(exact)) != len(exact):
            raise ValueError("attachment_duplicate_keys")
        witness = SourceInputWitness.model_validate(source_witness)
        scope = _scope(owner_id, thread_id, run_id, witness)
        attachments = []
        for key in exact:
            attachment = SourceAttachment.model_validate(store.get_source_attachment(p_user_id=owner_id, p_command_key=key))
            if attachment.owner_id != owner_id or attachment.request.command_key != key or attachment.request.source_witness != witness:
                raise ValueError("attachment_canonical_scope")
            check_source_attachment(owner_id=owner_id, attachment=attachment, current_source=witness, allow_ended=False, store=store)
            attachments.append(attachment)
        sources = _sources(owner_id, witness, attachments)
        body = dict(schema="mem00.source-attachments-run.v1", **scope,
            attachments=[item.model_dump(mode="json", by_alias=True) for item in sources if isinstance(item, SourceAttachment)], model_reuse_permission=False)
        return {**body, "seal": keyed_ref("source-attachments-run", _json(body))}
    except Exception:
        raise MemoryGovernanceUnavailable("source_attachments_binding_unavailable") from None


def verified_attachment_sources(*, owner_id, thread_id, run_id, source_witness, proof):
    """Origin validation only; caller must immediately check current sources."""
    try:
        witness = SourceInputWitness.model_validate(source_witness.model_dump(mode="python", by_alias=True, warnings=False))
        scope = _scope(owner_id, thread_id, run_id, witness)
        if proof is None:
            return source_dependencies(owner_id=owner_id, values=[witness])
        _json(proof)  # Only bounded JSON transport values, never model objects.
        result = AttachmentRunProof.model_validate(proof)
        raw = result.model_dump(mode="json", by_alias=True)
        seal = raw.pop("seal")
        if not hmac.compare_digest(seal, keyed_ref("source-attachments-run", _json(raw))):
            raise ValueError("attachment_run_seal")
        if any(raw[name] != value for name, value in scope.items()):
            raise ValueError("attachment_run_scope")
        return _sources(owner_id, witness, result.attachments)
    except Exception:
        raise MemoryGovernanceUnavailable("source_attachments_origin_unavailable") from None
