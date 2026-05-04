"""LangChain async callback handler that translates builder run lifecycle
events into ``ProgressEvent``s for the Sophia dual-bot architecture.

Phase 2 of the spec: the handler attaches to the builder's run config and
fires events on chain start / end / error and on tool start. Phase 3 will
hook the resulting events to a Telegram delivery sink.

Design notes
------------
* Read-only — never mutates agent state.
* Root chain identification uses ``parent_run_id is None``. This is the
  cross-version stable signal LangChain provides for "this is the
  top-level run, not an internal sub-chain".
* All emitter calls are wrapped in ``try/except`` so a failure in
  progress-event tracking can never crash a real builder run.
* The handler is stateful (tracks ``draft_emitted`` so DRAFTING fires at
  most once per run). Instances are not reusable across runs.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler

from deerflow.sophia.builder_progress import (
    ProgressEmitter,
    ProgressEventType,
    Surface,
    format_completed_summary,
    format_drafting_summary,
    format_error_summary,
    format_finding_summary,
    format_started_summary,
    is_draft_tool,
    is_search_tool,
)

logger = logging.getLogger(__name__)


def _safe_tool_name(serialized: Any) -> str | None:
    if isinstance(serialized, dict):
        name = serialized.get("name")
        if isinstance(name, str) and name:
            return name
    return None


class ProgressCallbackHandler(AsyncCallbackHandler):
    """Async LangChain callback that emits ``ProgressEvent``s for a builder run.

    Args:
        emitter: A configured ``ProgressEmitter`` scoped to one builder run.
        task_subject: Optional human-readable subject of the task — used in
            the STARTED summary template (e.g. "AR glasses launching in 2026").
    """

    def __init__(self, emitter: ProgressEmitter, *, task_subject: str | None = None) -> None:
        super().__init__()
        self._emitter = emitter
        self._task_subject = task_subject
        self._started_emitted = False
        self._draft_emitted = False
        self._completed_emitted = False

    # ------------------------------------------------------------------
    # Chain lifecycle
    # ------------------------------------------------------------------

    async def on_chain_start(
        self,
        serialized: dict[str, Any] | None,
        inputs: dict[str, Any] | None,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **_: Any,
    ) -> None:
        if parent_run_id is not None or self._started_emitted:
            return
        self._started_emitted = True
        try:
            self._emitter.emit(
                ProgressEventType.STARTED,
                format_started_summary(self._task_subject),
                surface=Surface.WORKER,
                metadata={"run_id": str(run_id)},
            )
        except Exception:  # pragma: no cover - never crash a builder
            logger.warning("ProgressCallbackHandler.on_chain_start emit failed", exc_info=True)

    async def on_chain_end(
        self,
        outputs: dict[str, Any] | Any,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **_: Any,
    ) -> None:
        if parent_run_id is not None or self._completed_emitted:
            return
        self._completed_emitted = True
        try:
            self._emitter.emit(
                ProgressEventType.COMPLETED,
                format_completed_summary(),
                surface=Surface.WORKER,
                metadata={"run_id": str(run_id)},
            )
        except Exception:  # pragma: no cover
            logger.warning("ProgressCallbackHandler.on_chain_end emit failed", exc_info=True)

    async def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **_: Any,
    ) -> None:
        if parent_run_id is not None or self._completed_emitted:
            return
        self._completed_emitted = True
        try:
            self._emitter.emit(
                ProgressEventType.ERROR,
                format_error_summary(str(error)),
                detail=type(error).__name__,
                surface=Surface.WORKER,
                metadata={"run_id": str(run_id)},
            )
        except Exception:  # pragma: no cover
            logger.warning("ProgressCallbackHandler.on_chain_error emit failed", exc_info=True)

    # ------------------------------------------------------------------
    # Tool lifecycle
    # ------------------------------------------------------------------

    async def on_tool_start(
        self,
        serialized: dict[str, Any] | None,
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        inputs: dict[str, Any] | None = None,
        **_: Any,
    ) -> None:
        tool_name = _safe_tool_name(serialized)
        if tool_name is None:
            return

        try:
            if is_draft_tool(tool_name) and not self._draft_emitted:
                self._draft_emitted = True
                self._emitter.emit(
                    ProgressEventType.DRAFTING,
                    format_drafting_summary(),
                    surface=Surface.WORKER,
                    metadata={"tool": tool_name, "run_id": str(run_id)},
                )
                return

            if is_search_tool(tool_name):
                self._emitter.emit(
                    ProgressEventType.FINDING,
                    format_finding_summary(tool_name),
                    surface=Surface.WORKER,
                    metadata={"tool": tool_name, "run_id": str(run_id)},
                )
        except Exception:  # pragma: no cover
            logger.warning("ProgressCallbackHandler.on_tool_start emit failed", exc_info=True)


__all__ = ["ProgressCallbackHandler"]
