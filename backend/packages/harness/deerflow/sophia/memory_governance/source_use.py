"""Current source use is distinct from permission to extract or recall memory.

Only trusted checkpoint ancestry plus a fresh authenticated current action may
select sources. This read check neither changes their original acceptance epoch
nor supplies final model permission; SQL checks the same join at dispatch.
"""

from typing import Literal

from pydantic import Field, field_validator

from .source_dependencies import SourceDependency
from .source_intake import IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable


class SourceUseObservation(IntakeModel):
    schema_name: Literal["mem00.source-use-check.v1"] = Field(alias="schema")
    owner_id: str
    thread_id: UuidText
    current_source_event_id: UuidText
    memory_clear_epoch: int = Field(ge=0)
    source_dependencies: list[SourceDependency] = Field(min_length=1, max_length=128)
    source_use_status: Literal["current"]
    memory_approval: Literal["not_granted"]
    extraction_eligibility: Literal["unchanged"]
    final_dispatch_permission: Literal[False]

    @field_validator("final_dispatch_permission", mode="before")
    @classmethod
    def no_model_permission(cls, value):
        if value is not False:
            raise ValueError("source_use_not_model_permission")
        return value


def check_model_source_use(*, owner_id, current_witness, sources, store):
    try:
        from .identity import assert_not_voice_lab_principal
        assert_not_voice_lab_principal(owner_id)
        observation = SourceUseObservation.model_validate(store.check_model_source_use(
            p_user_id=owner_id, p_current_source=current_witness.model_dump(mode="json", by_alias=True),
            p_sources=[item.model_dump(mode="json", by_alias=True) for item in sources]))
        if (observation.owner_id, observation.thread_id, observation.current_source_event_id, observation.memory_clear_epoch) != (
            owner_id, current_witness.thread_id, current_witness.event_id, current_witness.memory_clear_epoch
        ) or observation.source_dependencies != list(sources):
            raise ValueError("source_use_scope_changed")
        return observation
    except Exception:
        raise MemoryGovernanceUnavailable("recorded_model_sources_unavailable") from None
