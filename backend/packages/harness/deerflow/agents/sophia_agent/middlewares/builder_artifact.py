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
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, NotRequired, override

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
    # PR-B (2026-04-28): bumped ceiling 20 → 30 after run ``c130c516`` (PDF
    # with diagrams) hit the 20-turn cap mid-progress: write→bash→fix cycles
    # for binary deliverables legitimately need 12-15 turns of build pipeline
    # plus initial planning + final emit. At 20 the model ran out of budget
    # while still iterating productively, then got trapped in 3 wasted forced-
    # write turns (LLM emitted near-empty content because the recovery path
    # for binary tasks is bash, not write_file). Soft warn rescaled to 18
    # (60%) and force-emit at remaining<=3 (turn 27+). Wall-clock force-emit
    # at 70% of per-run timeout (1260s of 1800s) is the backstop for runaway
    # text deliverables — those rarely need 30 turns.
    #
    # PR-A history (2026-04-27): bumped 10 → 20 after a research-heavy task
    # in log ``019dcfbf-f219-7d83-86a4-ffb161ebddf7`` proved 10 too tight.
    # PR-C F6 history (2026-04-24): lowered 20 → 10 because the original
    # ceiling let pathological retries burn the budget. PR-A fixes those
    # retries at the source (two-stage forced-emit + empty-path rejection)
    # so the larger budget no longer enables runaway retry loops.
    _FORCE_EMIT_REMAINING = 3
    _CEILING_FOR_FORCE = 30
    _SOFT_WARN_AT = 18
    # Wall-clock fraction of the per-run timeout at which we activate
    # force-emit even if the turn-count ceiling hasn't been hit. Each
    # write_file LLM call costs ~95s on long-form deliverables; with
    # _resolve_builder_limits returning timeout=1800s, 0.70 leaves ~540s of
    # slack — enough for one final write + emit + network buffer.
    _FORCE_EMIT_WALL_CLOCK_FRACTION = 0.70

    @staticmethod
    def _should_force_emit(state: BuilderArtifactState) -> bool:
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        remaining = BuilderArtifactMiddleware._CEILING_FOR_FORCE - non_artifact_turns
        return remaining <= BuilderArtifactMiddleware._FORCE_EMIT_REMAINING and non_artifact_turns > 0

    @staticmethod
    def _should_force_emit_by_clock(state: BuilderArtifactState, runtime: Runtime | None = None) -> bool:
        """Return True when the wall-clock budget has crossed the force-emit fraction.

        Reads ``builder_timeout_seconds`` and ``builder_task_kickoff_ms`` from
        ``state`` (populated via ``SubagentExecutor``'s ``extra_configurable``
        plumbing in ``switch_to_builder``). Uses ``builder_task_started_at_ms``
        from state when present, falling back to ``builder_task_kickoff_ms``
        (set at queue time) so the very first turn — before ``after_model``
        has had a chance to record ``builder_task_started_at_ms`` — still
        gets the right answer.

        ``runtime`` is accepted for parity with other middleware methods and
        kept as a fallback signal source, but the canonical path is state-only:
        ``executor.py`` already merges ``extra_configurable`` into initial
        state, matching how ``delegation_context`` flows.

        Returns False (today's behavior, turn-count-only) when neither timestamp
        is set or when ``builder_timeout_seconds`` is missing/non-positive. This
        keeps the gate backward-compatible for any caller that doesn't opt in.
        """
        raw_timeout = state.get("builder_timeout_seconds")
        timeout_s = 0
        if isinstance(raw_timeout, (int, float)) and raw_timeout > 0:
            timeout_s = int(raw_timeout)
        if timeout_s <= 0:
            return False

        started_ms = state.get("builder_task_started_at_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            started_ms = state.get("builder_task_kickoff_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            return False

        elapsed_ms = max(0, int(time.time() * 1000) - int(started_ms))
        return elapsed_ms / (timeout_s * 1000) >= BuilderArtifactMiddleware._FORCE_EMIT_WALL_CLOCK_FRACTION

    @staticmethod
    def _forced_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces emit_builder_artifact."""
        return {"type": "tool", "name": "emit_builder_artifact"}

    @staticmethod
    def _forced_write_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces write_file.

        PR-A: used in the two-stage forced-emit path when the model is in the
        forced-emit window but hasn't written any deliverable yet. Forcing
        emit at that point traps the model — it can only call emit, the
        emit gets rejected (no file exists), and the loop spins. By forcing
        write_file for one turn first, we guarantee the model has at least
        one chance to land a file before tool_choice locks to emit.
        """
        return {"type": "tool", "name": "write_file"}

    @staticmethod
    def _forced_bash_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces bash.

        PR-B (2026-04-28): used by the three-stage forced-emit path when a
        generator script (``_generate_*.py``) exists in outputs/ but no
        user-facing binary (pdf/pptx/png/...) has been produced yet. For
        binary deliverables the recovery action is *running* the generator,
        not writing yet another generator. Forcing write_file in that state
        — as PR-A did — traps the model: each forced write produces another
        ``_generate_*.py`` (which ``_has_output_file`` filters out), so the
        gate stays False and the loop spins. Forcing bash gives the model a
        deterministic chance to produce the binary by running what it
        already has on disk. If bash also fails to produce output, the
        hard-ceiling fallback promotes the generator script with
        ``confidence=0.4`` so the user still gets something.
        """
        return {"type": "tool", "name": "bash"}

    @staticmethod
    def _has_output_file(state: BuilderArtifactState) -> bool:
        """Return True if any user-facing file exists in the sandbox outputs dir.

        PR-A: used by ``wrap_model_call`` to decide whether the forced-emit
        window should immediately force ``tool_choice=emit_builder_artifact``
        or first force ``tool_choice=write_file`` to give a not-yet-written
        deliverable a chance to land.

        Files whose name starts with ``_`` (e.g. generator scripts named
        ``_generate_foo.py``) or ``.`` (hidden files) are excluded — those
        aren't user-facing deliverables.
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        if not isinstance(outputs_host_path, str) or not outputs_host_path:
            # No outputs dir configured — assume the model hasn't written
            # anything. Returning False routes through the safer path
            # (force write_file first) instead of forcing a phantom emit.
            return False

        builder_task_started_at_ms = state.get("builder_task_started_at_ms")
        min_mtime: float | None = None
        if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
            # Ignore stale artifacts from prior builder tasks in the same thread.
            # Keep the same 5s grace used by hard-ceiling promotion.
            min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return False
            for entry in outputs_root.rglob("*"):
                if not entry.is_file():
                    continue
                if entry.name.startswith("_") or entry.name.startswith("."):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                return True
        except OSError:
            # Filesystem error (permissions, race) — fall through to True
            # so the existing forced-emit path proceeds. Better to risk one
            # phantom emit than to accidentally trap the model in write_file
            # forcing on every turn when something is genuinely wrong with
            # the sandbox.
            logger.debug(
                "BuilderArtifact._has_output_file: scan failed for outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            return True
        return False

    @staticmethod
    def _has_generator_script(state: BuilderArtifactState) -> bool:
        """Return True if a builder-produced ``_generate_*.py`` script exists.

        PR-B (2026-04-28): companion to ``_has_output_file`` for the three-
        stage forced-emit path. The builder prompt instructs binary tasks
        to write ``_generate_<name>.py`` then bash-run it. When no binary
        deliverable has landed yet but a generator script has, the recovery
        action is running the script (force ``bash``), not writing yet
        another script (force ``write_file``).

        Same staleness filtering as ``_has_output_file``: ignores generators
        from prior builder tasks via ``builder_task_started_at_ms``.
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        if not isinstance(outputs_host_path, str) or not outputs_host_path:
            return False

        builder_task_started_at_ms = state.get("builder_task_started_at_ms")
        min_mtime: float | None = None
        if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
            min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return False
            for entry in outputs_root.rglob("*"):
                if not entry.is_file():
                    continue
                # Match generator scripts produced by the builder per the
                # binary-deliverable prompt (``_generate_<name>.py``).
                if not (entry.name.startswith("_generate") and entry.suffix.lower() == ".py"):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                return True
        except OSError:
            logger.debug(
                "BuilderArtifact._has_generator_script: scan failed for outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            # Conservative on error: report no generator so the existing
            # write_file forcing path proceeds.
            return False
        return False

    @classmethod
    def _artifact_files_exist(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> bool:
        """Verify that every file referenced in the emit args exists on disk or in Supabase.

        PR-D (2026-04-24): prevents phantom artifacts where the builder calls
        emit_builder_artifact before the file has actually been written.
        Returns ``True`` only when ALL referenced paths resolve to an existing
        local file OR an existing Supabase object.

        PR-A (2026-04-27): tightened the empty-candidates fast-path. When the
        model is in the forced-emit window (``_should_force_emit`` is True),
        an empty ``artifact_path`` is treated as ESCAPE-HATCH-INVALID: it
        almost always means the model gave up under tool_choice pressure
        and is emitting nothing. We reject so the hard-ceiling fallback
        path (which scans outputs/ and produces a deterministic
        confidence=0.5 promotion or confidence=0.2 apology) can take over.
        Outside the forced-emit window the old behaviour applies — text-only
        / conceptual artifacts are still accepted.
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
            # Reject empty artifact_path under EITHER turn-count pressure
            # (existing) OR wall-clock pressure (new). Both indicate the
            # model is emitting under tool_choice pressure with no real
            # deliverable to point at — let the hard-ceiling fallback
            # promote a real file or surface a deterministic apology.
            if cls._should_force_emit(state) or cls._should_force_emit_by_clock(state, runtime):
                logger.warning(
                    "BuilderArtifact: rejecting empty artifact_path during "
                    "forced-emit (non_artifact_turns=%s) — letting hard "
                    "ceiling fallback promote a real file or surface a "
                    "deterministic apology instead of a phantom emit.",
                    state.get("builder_non_artifact_turns"),
                )
                return False
            # No files referenced AND not under forced-emit pressure —
            # accept (builder may be emitting a text-only or conceptual
            # result).
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

    def _force_choice_for_state(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        """Three-stage forced-tool-choice (PR-A + PR-B) with wall-clock awareness.

        Activates when EITHER the turn-count ceiling is imminent
        (``_should_force_emit``) OR the wall-clock fraction of the per-run
        timeout has been crossed (``_should_force_emit_by_clock``). The
        stage selection within the force window is what changed in PR-B
        for binary deliverables that have written a generator but failed
        to produce the final binary.

        Returns the Anthropic ``tool_choice`` payload appropriate for the
        current state:

        - ``None`` when forcing isn't required yet.
        - ``{"type": "tool", "name": "emit_builder_artifact"}`` when a
          user-facing binary already exists on disk — proceed with emit.
        - ``{"type": "tool", "name": "bash"}`` (PR-B) when no binary exists
          but a ``_generate_*.py`` does — recovery for binary deliverables
          is to RUN the generator, not write yet another one. After this
          forced bash either produces a binary (next turn flips to emit)
          or doesn't (hard-ceiling fallback promotes the script itself).
        - ``{"type": "tool", "name": "write_file"}`` when neither a binary
          nor a generator exists — the model has produced nothing on disk
          and needs to land at least one file before emit is forced.
        """
        turn_force = self._should_force_emit(state)
        clock_force = self._should_force_emit_by_clock(state, runtime)
        if not (turn_force or clock_force):
            return None
        force_reason = "turns" if turn_force and not clock_force else (
            "wall_clock" if clock_force and not turn_force else "turns+wall_clock"
        )
        non_artifact_turns = state.get("builder_non_artifact_turns")

        # Stage 1: a real user-facing binary is on disk → force emit.
        if self._has_output_file(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=emit_builder_artifact "
                "(non_artifact_turns=%s, ceiling=%s, reason=%s)",
                non_artifact_turns,
                self._CEILING_FOR_FORCE,
                force_reason,
            )
            return self._forced_tool_choice()

        # Stage 2 (PR-B): a generator script exists but no binary yet →
        # force bash so the model runs what it has, instead of writing
        # another generator that gets filtered out by _has_output_file.
        if self._has_generator_script(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=bash before emit "
                "(non_artifact_turns=%s, ceiling=%s, reason=%s, generator "
                "script on disk but no binary — three-stage force gives the "
                "model a chance to RUN the generator instead of writing yet "
                "another one)",
                non_artifact_turns,
                self._CEILING_FOR_FORCE,
                force_reason,
            )
            return self._forced_bash_tool_choice()

        # Stage 3: nothing on disk at all → force write_file (PR-A).
        logger.warning(
            "BuilderArtifact: forcing tool_choice=write_file before emit "
            "(non_artifact_turns=%s, ceiling=%s, reason=%s, no output file yet — "
            "force prevents phantom-emit loop)",
            non_artifact_turns,
            self._CEILING_FOR_FORCE,
            force_reason,
        )
        return self._forced_write_tool_choice()

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        """Force tool_choice when ceiling is imminent (two-stage)."""
        choice = self._force_choice_for_state(request.state, request.runtime)
        if choice is not None:
            request = request.override(tool_choice=choice)
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        """Async variant — same two-stage logic as wrap_model_call."""
        choice = self._force_choice_for_state(request.state, request.runtime)
        if choice is not None:
            request = request.override(tool_choice=choice)
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

                    # PR-B (2026-04-28): if no preferred binary was promoted,
                    # fall back to a builder-produced generator script
                    # (``_generate_*.py``). This guarantees binary-deliverable
                    # tasks that hit the ceiling mid-debugging hand the user
                    # SOMETHING runnable instead of a confidence=0.2 apology
                    # with no path. Run ``c130c516`` (PDF with diagrams) was
                    # the motivating case: 17 turns of write→bash cycles,
                    # forced into 3 wasted forced-write turns, ended with a
                    # bare apology even though a working generator script was
                    # on disk.
                    promoted_generator_path: str | None = None
                    if promoted_path is None:
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
                                    gen_candidates = [
                                        p for p in outputs_root_local.rglob("*")
                                        if p.is_file()
                                        and p.name.startswith("_generate")
                                        and p.suffix.lower() == ".py"
                                    ]
                                    if builder_task_started_at_ms:
                                        min_mtime = (builder_task_started_at_ms / 1000.0) - 5.0
                                        gen_candidates = [
                                            p for p in gen_candidates
                                            if p.stat().st_mtime >= min_mtime
                                        ]
                                    if gen_candidates:
                                        gen_candidates.sort(
                                            key=lambda p: p.stat().st_mtime, reverse=True
                                        )
                                        best = gen_candidates[0]
                                        rel = best.relative_to(outputs_root_local).as_posix()
                                        promoted_generator_path = f"/mnt/user-data/outputs/{rel}"
                                        logger.warning(
                                            "BuilderArtifact: ceiling fallback promoting "
                                            "generator script %s (no binary deliverable found)",
                                            promoted_generator_path,
                                        )
                        except Exception as exc:  # noqa: BLE001
                            logger.warning(
                                "BuilderArtifact: generator-script fallback scan failed error=%s",
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
                    elif promoted_generator_path:
                        fallback = {
                            "artifact_path": promoted_generator_path,
                            "artifact_type": "code",
                            "artifact_title": "Build task partial (generator script only)",
                            "steps_completed": non_artifact_turns,
                            "decisions_made": [],
                            "companion_summary": (
                                "I built the generator script but couldn't produce the final "
                                "binary cleanly — sharing the script so you have something to "
                                "work with."
                            ),
                            "companion_tone_hint": (
                                "Honest and constructive — partial deliverable; offer to debug "
                                "if the user shares the error from running it."
                            ),
                            "user_next_action": (
                                "Try running `python <path>` yourself, or send me the error "
                                "and I'll fix it."
                            ),
                            "confidence": 0.4,
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
