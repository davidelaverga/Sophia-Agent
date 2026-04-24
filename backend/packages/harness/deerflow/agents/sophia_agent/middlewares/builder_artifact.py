"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).

PR-D (2026-04-24): adds file-existence verification before accepting an
emit_builder_artifact call. When the referenced file is missing on disk
and in Supabase, the emit is rejected via wrap_tool_call with a
Command(goto="model") so the builder gets another turn to retry instead
of completing with a phantom artifact.
"""

import logging
import os
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, hook_config
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage.supabase_mirror import maybe_mirror_file

logger = logging.getLogger(__name__)


_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"


def _extract_output_relative_path(artifact_path: str | None) -> str | None:
    """Return the path relative to ``/mnt/user-data/outputs/`` when applicable."""
    if not isinstance(artifact_path, str) or not artifact_path:
        return None
    normalized = artifact_path.strip()
    if not normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return None
    relative = normalized[len(_OUTPUTS_VIRTUAL_PREFIX):].lstrip("/")
    return relative or None


def _upload_builder_outputs_to_supabase(
    thread_id: str | None,
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> None:
    """Best-effort upload of the builder's outputs to Supabase Storage.

    PR-E (Phase 2.2): delegates to ``maybe_mirror_file`` which uses SHA-256
    hash deduplication. Files that were already mirrored at write time by
    the tool hooks are skipped automatically. Any failure is logged and
    swallowed so builder flow never regresses.
    """
    if not thread_id or not outputs_host_path:
        logger.debug(
            "Skipping Supabase upload; missing thread_id=%s outputs_host_path=%s",
            thread_id,
            outputs_host_path,
        )
        return

    candidates: list[str] = []
    primary = artifact_args.get("artifact_path")
    if isinstance(primary, str):
        candidates.append(primary)
    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str))

    outputs_root = Path(outputs_host_path)
    for candidate in candidates:
        relative = _extract_output_relative_path(candidate)
        if relative is None:
            continue
        host_file = outputs_root / relative
        maybe_mirror_file(str(host_file), thread_id, outputs_host_path)


class BuilderArtifactState(AgentState):
    builder_result: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]


class BuilderArtifactMiddleware(AgentMiddleware[BuilderArtifactState]):
    """Capture emit_builder_artifact tool call from the builder agent."""

    state_schema = BuilderArtifactState

    @staticmethod
    def _tool_names(tool_calls: list[dict[str, Any]]) -> list[str]:
        names: list[str] = []
        for call in tool_calls:
            name = call.get("name")
            if isinstance(name, str) and name:
                names.append(name)
        return names

    @staticmethod
    def _append_turn_summary(state: BuilderArtifactState, summary: dict[str, Any]) -> list[dict]:
        history = list(state.get("builder_tool_turn_summaries", []) or [])
        history.append(summary)
        return history[-12:]

    # Ceiling enforcement — MUST stay in sync with _HARD_CEILING in after_model
    # and with builder_task.py's _HARD_CEILING. When the model is within this
    # many turns of termination, we force Anthropic tool_choice to emit so the
    # model literally cannot call any other tool. Prompt-level escalation is
    # not reliable mid-retry-loop; the API-level constraint is.
    #
    # PR-C F6 (2026-04-24): lowered ceiling 20 → 10. The previous ceiling was
    # set high to give bash room to recover from failing runs, but in practice
    # long-running builds rarely recovered — they just burnt the budget on
    # pathological retries. 10 turns is enough for a clean end-to-end build
    # (write_todos → write_file → bash run → bash verify → emit) plus one or
    # two retry rounds, and it halves the worst-case duration users wait for
    # a stuck build. A soft WARN at turn 6 (``_SOFT_WARN_AT``) gives the model
    # an early signal to start wrapping up before tool_choice forcing kicks in.
    _FORCE_EMIT_REMAINING = 2
    _CEILING_FOR_FORCE = 10
    _SOFT_WARN_AT = 6

    @staticmethod
    def _should_force_emit(state: BuilderArtifactState) -> bool:
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        remaining = BuilderArtifactMiddleware._CEILING_FOR_FORCE - non_artifact_turns
        return remaining <= BuilderArtifactMiddleware._FORCE_EMIT_REMAINING and non_artifact_turns > 0

    @staticmethod
    def _forced_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces emit_builder_artifact."""
        return {"type": "tool", "name": "emit_builder_artifact"}

    @staticmethod
    def _artifact_files_exist(
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> bool:
        """Verify that every file referenced in the emit args exists on disk or in Supabase.

        PR-D (2026-04-24): prevents phantom artifacts where the builder calls
        emit_builder_artifact before the file has actually been written.
        Returns ``True`` only when ALL referenced paths resolve to an existing
        local file OR an existing Supabase object.
        """
        candidates: list[str] = []
        primary = artifact_args.get("artifact_path")
        if isinstance(primary, str) and primary.strip():
            candidates.append(primary.strip())
        supporting = artifact_args.get("supporting_files")
        if isinstance(supporting, list):
            candidates.extend(
                path for path in supporting
                if isinstance(path, str) and path.strip()
            )

        if not candidates:
            # No files referenced — nothing to verify. Accept (builder may be
            # emitting a text-only or conceptual result).
            return True

        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        thread_id = runtime.context.get("thread_id") if runtime.context else None

        for candidate in candidates:
            relative = _extract_output_relative_path(candidate)
            if relative is None:
                # Non-virtual path — we can't verify it against the sandbox
                # outputs dir. Accept it and let downstream consumers decide.
                continue

            # 1. Check local disk
            if outputs_host_path:
                host_file = Path(outputs_host_path) / relative
                if host_file.is_file():
                    continue

            # 2. Check Supabase
            if thread_id and supabase_artifact_store.check_artifact_exists(thread_id, relative):
                continue

            # Neither local nor remote — missing.
            logger.warning(
                "BuilderArtifact: file missing for emit verification: "
                "path=%s local=%s supabase=%s",
                candidate,
                bool(outputs_host_path and (Path(outputs_host_path) / relative).is_file()),
                bool(thread_id and supabase_artifact_store.check_artifact_exists(thread_id, relative)),
            )
            return False

        return True

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        """Force emit_builder_artifact tool_choice when ceiling is imminent."""
        if self._should_force_emit(request.state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=emit_builder_artifact "
                "(non_artifact_turns=%s, ceiling=%s)",
                request.state.get("builder_non_artifact_turns"),
                self._CEILING_FOR_FORCE,
            )
            request = request.override(tool_choice=self._forced_tool_choice())
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        """Async variant — same logic as wrap_model_call."""
        if self._should_force_emit(request.state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=emit_builder_artifact "
                "(non_artifact_turns=%s, ceiling=%s)",
                request.state.get("builder_non_artifact_turns"),
                self._CEILING_FOR_FORCE,
            )
            request = request.override(tool_choice=self._forced_tool_choice())
        return await handler(request)

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        """Intercept emit_builder_artifact to verify the file exists before executing.

        PR-D (2026-04-24): when the referenced file is missing, we bypass the
        normal tool execution (which has ``return_direct=True`` and would end the
        builder graph) and instead return a ``Command(goto=\"model\")`` with an
        error ToolMessage. This lets the model see the rejection and retry.
        """
        if request.tool_call.get("name") != "emit_builder_artifact":
            return handler(request)

        args = request.tool_call.get("args", {})
        if self._artifact_files_exist(args, request.state, request.runtime):
            return handler(request)

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in wrap_tool_call — "
            "artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: emit_builder_artifact rejected — the referenced "
                            f"artifact file ({args.get('artifact_path')}) does not exist "
                            "on disk or in remote storage. Please write the file first, "
                            "then call emit_builder_artifact again."
                        ),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        """Async variant — same logic as wrap_tool_call."""
        if request.tool_call.get("name") != "emit_builder_artifact":
            return await handler(request)

        args = request.tool_call.get("args", {})
        if self._artifact_files_exist(args, request.state, request.runtime):
            return await handler(request)

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in awrap_tool_call — "
            "artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: emit_builder_artifact rejected — the referenced "
                            f"artifact file ({args.get('artifact_path')}) does not exist "
                            "on disk or in remote storage. Please write the file first, "
                            "then call emit_builder_artifact again."
                        ),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    @hook_config(can_jump_to=["end"])
    @override
    def after_model(self, state: BuilderArtifactState, runtime: Runtime) -> dict | None:
        """Capture emit_builder_artifact tool call result from latest messages."""
        _t0 = time.perf_counter()

        # Don't overwrite a previously captured result
        if state.get("builder_result") is not None:
            log_middleware("BuilderArtifact", "already captured, skipping", _t0)
            return None

        messages = state.get("messages", [])

        # Scan messages in reverse for an AI message with tool_calls
        for msg in reversed(messages):
            if getattr(msg, "type", None) != "ai":
                continue

            tool_calls = getattr(msg, "tool_calls", []) or []

            # AI message has tool calls -- look for emit_builder_artifact
            if tool_calls:
                artifact_calls = [tc for tc in tool_calls if tc.get("name") == "emit_builder_artifact"]
                tool_names = self._tool_names(tool_calls)

                if artifact_calls and len(artifact_calls) == len(tool_calls):
                    args = artifact_calls[-1].get("args", {})

                    # PR-D (2026-04-24): verify the referenced file exists before
                    # accepting the emit. If missing, let wrap_tool_call handle the
                    # retry (Command(goto="model")) instead of completing with a
                    # phantom artifact.
                    #
                    # Codex fix (2026-04-24): on rejection we MUST still increment
                    # builder_non_artifact_turns. If the builder is in the forced-emit
                    # window (_should_force_emit is True) and the counter stays
                    # frozen, the model is trapped: tool_choice forces emit →
                    # emit is rejected → tool_choice forces emit again → loop.
                    # Incrementing lets the hard ceiling (10) trigger after a few
                    # retries and terminate the run instead of spinning forever.
                    if not self._artifact_files_exist(args, state, runtime):
                        logger.warning(
                            "BuilderArtifact: emit rejected in after_model — "
                            "artifact_path %s not found on disk or in Supabase. "
                            "Builder will retry via wrap_tool_call.",
                            args.get("artifact_path"),
                        )
                        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                        history = self._append_turn_summary(
                            state,
                            {
                                "turn": non_artifact_turns,
                                "tool_names": tool_names,
                                "has_emit_builder_artifact": True,
                                "emit_rejected": True,
                            },
                        )
                        return {
                            "builder_non_artifact_turns": non_artifact_turns,
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                        }

                    history = self._append_turn_summary(
                        state,
                        {
                            "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                            "tool_names": tool_names,
                            "has_emit_builder_artifact": True,
                        },
                    )
                    thread_data = state.get("thread_data") or {}
                    outputs_host_path = (
                        thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
                    )
                    thread_id = runtime.context.get("thread_id") if runtime.context else None
                    _upload_builder_outputs_to_supabase(
                        thread_id=thread_id,
                        outputs_host_path=outputs_host_path,
                        artifact_args=args,
                    )
                    log_middleware(
                        "BuilderArtifact",
                        f"builder artifact captured: type={args.get('artifact_type')}, "
                        f"confidence={args.get('confidence')}",
                        _t0,
                    )
                    return {
                        "builder_result": args,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_task_started_at_ms": 0,
                        "jump_to": "end",
                    }

                if artifact_calls:
                    log_middleware("BuilderArtifact", "mixed tool calls with builder artifact; loop continues", _t0)
                    return None

                # Has tool calls but none are emit_builder_artifact -- agent loop continues
                non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                # Record task start wall-clock on the first non-emit turn so
                # the ceiling fallback can scan ONLY files produced during
                # this task (prevents promoting a stale file from a prior
                # builder task that ran in the same thread).
                builder_task_started_at_ms = state.get("builder_task_started_at_ms")
                if not isinstance(builder_task_started_at_ms, (int, float)) or builder_task_started_at_ms <= 0:
                    builder_task_started_at_ms = int(time.time() * 1000)
                history = self._append_turn_summary(
                    state,
                    {
                        "turn": non_artifact_turns,
                        "tool_names": tool_names,
                        "has_emit_builder_artifact": False,
                    },
                )
                joined_names = ", ".join(tool_names) if tool_names else "none"

                # PR-C F6 (2026-04-24): soft-warn halfway so the model sees
                # an early wrap-up signal in logs (and future trace events).
                # Emitted exactly once per task, at the ``_SOFT_WARN_AT`` turn.
                if non_artifact_turns == self._SOFT_WARN_AT:
                    logger.warning(
                        "BuilderArtifact: soft ceiling warning at turn=%d "
                        "(hard_ceiling=%d, remaining=%d). Builder should wrap up "
                        "— emit_builder_artifact with what's on disk instead of "
                        "continuing to iterate.",
                        non_artifact_turns,
                        self._CEILING_FOR_FORCE,
                        self._CEILING_FOR_FORCE - non_artifact_turns,
                    )

                # Hard ceiling: force end before hitting the recursion limit.
                # Builds that haven't emitted by this point almost never recover
                # — the budget is better spent recovering whatever file is
                # already on disk than letting bash thrash.
                _HARD_CEILING = self._CEILING_FOR_FORCE
                if non_artifact_turns >= _HARD_CEILING:
                    logger.warning(
                        "BuilderArtifact: hard ceiling reached at turn=%d, tools=%s — forcing end with fallback",
                        non_artifact_turns,
                        joined_names,
                    )
                    # Best-effort: scan the outputs dir for a real binary
                    # deliverable (pdf/pptx/docx/xlsx/png/html/zip) that the
                    # builder already produced but never emitted. If we find
                    # one, promote it to artifact_path so the user gets the
                    # real file instead of "force-stopped" with no download.
                    promoted_path: str | None = None
                    promoted_type = "unknown"
                    try:
                        thread_data_local = state.get("thread_data") or {}
                        outputs_host_path_local = (
                            thread_data_local.get("outputs_path")
                            if isinstance(thread_data_local, dict)
                            else None
                        )
                        if outputs_host_path_local:
                            outputs_root_local = Path(outputs_host_path_local)
                            if outputs_root_local.is_dir():
                                # Preferred extensions, in priority order
                                _PROMOTE_EXTS = (
                                    ".pdf", ".pptx", ".docx", ".xlsx",
                                    ".png", ".jpg", ".jpeg", ".svg",
                                    ".html", ".zip",
                                )
                                candidates = [
                                    p for p in outputs_root_local.rglob("*")
                                    if p.is_file()
                                    and not p.name.startswith("_")
                                    and p.suffix.lower() in _PROMOTE_EXTS
                                ]
                                # Only promote files produced during THIS task.
                                # Subtract a small grace window (5s) to absorb
                                # clock skew between builder and host.
                                if builder_task_started_at_ms:
                                    min_mtime = (builder_task_started_at_ms / 1000.0) - 5.0
                                    candidates = [
                                        p for p in candidates
                                        if p.stat().st_mtime >= min_mtime
                                    ]
                                if candidates:
                                    # Most recently modified wins
                                    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                                    best = candidates[0]
                                    rel = best.relative_to(outputs_root_local).as_posix()
                                    promoted_path = f"/mnt/user-data/outputs/{rel}"
                                    ext = best.suffix.lower().lstrip(".")
                                    promoted_type = ext or "unknown"
                    except Exception as exc:  # noqa: BLE001 — best-effort only
                        logger.warning(
                            "BuilderArtifact: ceiling fallback scan failed error=%s",
                            exc,
                        )

                    if promoted_path:
                        fallback = {
                            "artifact_path": promoted_path,
                            "artifact_type": promoted_type,
                            "artifact_title": "Build task completed (recovered)",
                            "steps_completed": non_artifact_turns,
                            "decisions_made": [],
                            "companion_summary": (
                                "The builder ran long and didn't call emit cleanly, "
                                "but the deliverable is on disk — I'm surfacing it now."
                            ),
                            "companion_tone_hint": "Reassuring — deliverable recovered despite rough run.",
                            "user_next_action": "Open the file and let me know if it lands.",
                            "confidence": 0.5,
                        }
                    else:
                        fallback = {
                            "artifact_path": None,
                            "artifact_type": "unknown",
                            "artifact_title": "Build task force-stopped",
                            "steps_completed": non_artifact_turns,
                            "decisions_made": [],
                            "companion_summary": (
                                f"The builder made {non_artifact_turns} edits but didn't finish cleanly. "
                                "No final deliverable was produced."
                            ),
                            "companion_tone_hint": "Apologetic — builder ran out of budget.",
                            "user_next_action": "Tell me what to try differently and I'll run it again.",
                            "confidence": 0.2,
                        }
                    return {
                        "builder_result": fallback,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_task_started_at_ms": 0,
                        "jump_to": "end",
                    }

                log_middleware(
                    "BuilderArtifact",
                    f"tool calls present but no builder artifact: turn={non_artifact_turns}, tools={joined_names}",
                    _t0,
                )
                return {
                    "builder_non_artifact_turns": non_artifact_turns,
                    "builder_last_tool_names": tool_names,
                    "builder_tool_turn_summaries": history,
                    "builder_task_started_at_ms": builder_task_started_at_ms,
                }

            # AI message with NO tool calls -- agent ending with plain text, create fallback
            fallback = {
                "artifact_path": None,
                "artifact_type": "unknown",
                "artifact_title": "Build task completed",
                "steps_completed": 0,
                "decisions_made": [],
                "companion_summary": "The build task was completed.",
                "companion_tone_hint": "Neutral \u2014 no builder context available.",
                "user_next_action": None,
                "confidence": 0.3,
            }
            history = self._append_turn_summary(
                state,
                {
                    "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                    "tool_names": [],
                    "has_emit_builder_artifact": False,
                    "ended_with_plain_text": True,
                },
            )
            log_middleware("BuilderArtifact", "no builder artifact tool call, using fallback", _t0)
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_last_tool_names": [],
                "builder_tool_turn_summaries": history,
            }

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
