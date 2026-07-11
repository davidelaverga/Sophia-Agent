from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

import anyio
from pydantic import BaseModel, ConfigDict

BoundaryAction = Literal["continue", "pause", "terminate"]


class BuildHookExecutionError(RuntimeError):
    pass


class BuildBoundaryDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    action: BoundaryAction = "continue"
    reason: str | None = None
    resume_schema_version: str | None = None


HookCallable = Callable[[dict[str, Any]], Awaitable[BuildBoundaryDecision | None]]


@dataclass(frozen=True, slots=True)
class NamedBuildHook:
    hook_id: str
    callback: HookCallable
    timeout_seconds: float = 2.0


@dataclass(frozen=True, slots=True)
class BuildLifecycleHooks:
    before_summarization: tuple[NamedBuildHook, ...] = ()
    at_safe_boundary: tuple[NamedBuildHook, ...] = ()
    before_terminal: tuple[NamedBuildHook, ...] = ()
    after_manifest_commit: tuple[NamedBuildHook, ...] = ()
    after_artifact_acceptance: tuple[NamedBuildHook, ...] = ()

    async def run_safe_boundary(self, state: dict[str, Any]) -> BuildBoundaryDecision:
        for hook in self.at_safe_boundary:
            try:
                with anyio.fail_after(hook.timeout_seconds):
                    decision = await hook.callback(state)
            except Exception as exc:
                raise BuildHookExecutionError(f"build lifecycle hook failed: {hook.hook_id}") from exc
            if decision is not None and decision.action != "continue":
                return decision
        return BuildBoundaryDecision()
