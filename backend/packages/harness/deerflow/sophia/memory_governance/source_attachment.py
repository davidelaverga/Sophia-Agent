"""Typed upload/action ancestry. Association is never a model dispatch permit."""

from typing import Annotated, Literal

from pydantic import BeforeValidator, Field, model_validator

from .source_input_provenance import SourceInputWitness
from .source_intake import ActionKey, HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceConflict, MemoryGovernanceUnavailable


def _no_permission(value):
    if value is not False:
        raise ValueError("source_attachment_permission_invalid")
    return value


NoAttachmentPermission = Annotated[Literal[False], BeforeValidator(_no_permission)]


class AttachmentRequest(IntakeModel):
    schema_name: Literal["mem00.source-attachment-request.v1"] = Field(alias="schema")
    command_key: ActionKey
    upload_id: UuidText
    intent_event_id: UuidText
    blob_ref: str = Field(pattern=r"^hmac-sha256:source-upload-blob:[a-f0-9]{64}$")
    source_witness: SourceInputWitness


class SourceAttachment(IntakeModel):
    schema_name: Literal["mem00.source-attachment.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    session_id: UuidText
    thread_id: UuidText
    memory_clear_epoch: int = Field(ge=0)
    event_id: UuidText
    upload_id: UuidText
    request: AttachmentRequest
    observation_event_id: UuidText
    content_ref: str = Field(pattern=r"^hmac-sha256:source-upload-content:[a-f0-9]{64}$")
    metadata_ref: str = Field(pattern=r"^hmac-sha256:source-upload-metadata:[a-f0-9]{64}$")
    registered_at: str
    historical_result_only: HistoricalOnly
    model_reuse_permission: NoAttachmentPermission
    memory_approval: Literal["not_granted"]

    @model_validator(mode="after")
    def exact_scope(self):
        source = self.request.source_witness
        if (self.owner_id, self.session_id, self.thread_id, self.memory_clear_epoch, self.upload_id) != (source.owner_id, source.session_id, source.thread_id, source.memory_clear_epoch, self.request.upload_id) or type(
            self.model_reuse_permission
        ) is not bool:
            raise ValueError("source_attachment_scope_invalid")
        return self


class SourceAttachmentCheck(IntakeModel):
    schema_name: Literal["mem00.source-attachment-check.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    attachment: SourceAttachment
    current_source: SourceInputWitness | None
    allow_ended: bool
    memory_clear_epoch: int = Field(ge=0)
    checked_at: str
    source_status: Literal["current"]
    final_dispatch_permission: NoAttachmentPermission
    memory_approval: Literal["not_granted"]


def check_source_attachment(*, owner_id, attachment, current_source, allow_ended, store):
    try:
        source = SourceAttachment.model_validate(attachment.model_dump(mode="python", by_alias=True, warnings=False))
        current = None if current_source is None else SourceInputWitness.model_validate(current_source.model_dump(mode="python", by_alias=True, warnings=False))
        if source.owner_id != owner_id or type(allow_ended) is not bool or (current is not None and current.owner_id != owner_id):
            raise ValueError("owner")
        raw = store.check_source_attachment(
            p_user_id=owner_id, p_attachment=source.model_dump(mode="json", by_alias=True), p_current_source=current.model_dump(mode="json", by_alias=True) if current is not None else None, p_allow_ended=allow_ended
        )
        result = SourceAttachmentCheck.model_validate(raw)
        expected_epoch = current.memory_clear_epoch if current is not None else source.memory_clear_epoch
        if (result.owner_id, result.attachment, result.current_source, result.allow_ended, result.memory_clear_epoch) != (owner_id, source, current, allow_ended, expected_epoch) or result.final_dispatch_permission is not False:
            raise ValueError("reply")
        return result
    except Exception:
        raise MemoryGovernanceUnavailable("source_attachment_current_unproven") from None


class SourceAttachmentService:
    def __init__(self, *, owner_id, store):
        from .identity import assert_not_voice_lab_principal

        assert_not_voice_lab_principal(owner_id)
        if not isinstance(owner_id, str) or not owner_id or owner_id != owner_id.strip():
            raise ValueError("source_attachment_owner_invalid")
        self.owner, self.store = owner_id, store

    def register(self, request):
        try:
            original = AttachmentRequest.model_validate(request.model_dump(mode="python", by_alias=True, warnings=False) if isinstance(request, AttachmentRequest) else request)
            if original.source_witness.owner_id != self.owner:
                raise ValueError("owner")
            result = SourceAttachment.model_validate(self.store.register_source_attachment(p_user_id=self.owner, p_request=original.model_dump(mode="json", by_alias=True)))
            if result.owner_id != self.owner or result.request != original:
                raise ValueError("reply")
            return result
        except MemoryGovernanceConflict:
            raise
        except Exception:
            raise MemoryGovernanceUnavailable("source_attachment_registration_unavailable") from None
