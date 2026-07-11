from __future__ import annotations

from typing import Any, TypeVar

import anyio
from pydantic import BaseModel

from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.models.factory import create_chat_model
from deerflow.sophia.build_runtime.deadline import BuildDeadlineExceeded, ExecutionEnvelope

T = TypeVar("T", bound=BaseModel)


class StructuredModelInvoker:
    async def invoke(
        self,
        *,
        plan: ResolvedModelPlan,
        schema: type[T],
        messages: list[Any],
        envelope: ExecutionEnvelope,
    ) -> T:
        remaining = envelope.remaining_seconds(reserve_terminal=True)
        if remaining <= 0:
            raise BuildDeadlineExceeded(stage="structured_model_invocation", deadline_epoch_ms=envelope.deadline_epoch_ms)
        model = create_chat_model(plan.deployment_name, **plan.model_overrides)
        structured = model.with_structured_output(schema)
        try:
            with anyio.fail_after(remaining):
                result = await structured.ainvoke(messages)
        except TimeoutError as exc:
            raise BuildDeadlineExceeded(stage="structured_model_invocation", deadline_epoch_ms=envelope.deadline_epoch_ms) from exc
        return result if isinstance(result, schema) else schema.model_validate(result)
