"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).
"""

import logging
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, hook_config
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.storage import gateway_mirror, supabase_artifact_store

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


def _replicate_builder_outputs(
    thread_id: str | None,
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> dict[str, Any]:
    """Best-effort replication of builder outputs to Gateway disk + Supabase.

    Returns a diagnostics dict with ``{"mirror": "ok|skipped|failed",
    "supabase": "ok|skipped|failed"}`` for each file processed.
    Failures are logged and swallowed so builder flow never regresses.
    """
    diagnostics: dict[str, str] = {"mirror": "skipped", "supabase": "skipped"}
    if not thread_id or not outputs_host_path:
        logger.debug(
            "Skipping builder output replication; missing thread_id=%s outputs_host_path=%s",
            thread_id,
            outputs_host_path,
        )
        return diagnostics

    candidates: list[str] = []
    primary = artifact_args.get("artifact_path")
    if isinstance(primary, str):
        candidates.append(primary)
    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str))

    outputs_root = Path(outputs_host_path)
    any_mirror_ok = False
    any_mirror_failed = False
    any_supabase_ok = False
    any_supabase_failed = False

    for candidate in candidates:
        relative = _extract_output_relative_path(candidate)
        if relative is None:
            continue
        host_file = outputs_root / relative
        try:
            content = host_file.read_bytes()
        except FileNotFoundError:
            logger.warning(
                "Builder replication skipped; local file missing thread_id=%s path=%s",
                thread_id,
                host_file,
            )
            continue
        except OSError as exc:
            logger.warning(
                "Builder replication skipped; read error thread_id=%s path=%s error=%s",
                thread_id,
                host_file,
                exc,
            )
            continue

        # Primary: push to Gateway's internal replicate endpoint
        if gateway_mirror.is_configured():
            try:
                if gateway_mirror.mirror_artifact(
                    thread_id=thread_id,
                    virtual_path=candidate,
                    content=content,
                ):
                    any_mirror_ok = True
                else:
                    any_mirror_failed = True
            except Exception:  # noqa: BLE001 — best-effort
                any_mirror_failed = True
                logger.warning(
                    "Gateway mirror failed for thread_id=%s path=%s",
                    thread_id,
                    relative,
                    exc_info=True,
                )

        # Fallback / DR: Supabase
        if supabase_artifact_store.is_configured():
            try:
                result = supabase_artifact_store.upload_artifact(
                    thread_id=thread_id,
                    filename=relative,
                    content=content,
                )
                if result is not None:
                    any_supabase_ok = True
                else:
                    any_supabase_failed = True
            except Exception as exc:  # noqa: BLE001 — best-effort upload
                any_supabase_failed = True
                logger.warning(
                    "Supabase upload failed; continuing without remote copy thread_id=%s path=%s error=%s",
                    thread_id,
                    relative,
                    exc,
                )

    if any_mirror_ok:
        diagnostics["mirror"] = "ok"
    elif any_mirror_failed:
        diagnostics["mirror"] = "failed"
    if any_supabase_ok:
        diagnostics["supabase"] = "ok"
    elif any_supabase_failed:
        diagnostics["supabase"] = "failed"
    return diagnostics


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
    _FORCE_EMIT_REMAINING = 2
    _CEILING_FOR_FORCE = 20

    @staticmethod
    def _should_force_emit(state: BuilderArtifactState) -> bool:
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        remaining = BuilderArtifactMiddleware._CEILING_FOR_FORCE - non_artifact_turns
        return remaining <= BuilderArtifactMiddleware._FORCE_EMIT_REMAINING and non_artifact_turns > 0

    @staticmethod
    def _forced_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces emit_builder_artifact."""
        return {"type": "tool", "name": "emit_builder_artifact"}

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
                    replication = _replicate_builder_outputs(
                        thread_id=thread_id,
                        outputs_host_path=outputs_host_path,
                        artifact_args=args,
                    )
                    args["replication"] = replication
                    log_middleware(
                        "BuilderArtifact",
                        f"builder artifact captured: type={args.get('artifact_type')}, "
                        f"confidence={args.get('confidence')} mirror={replication.get('mirror')} supabase={replication.get('supabase')}",
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

                # Hard ceiling: force end before hitting the recursion limit.
                # Binary deliverables (PDF/PPTX/DOCX) frequently need:
                #   1. write_todos
                #   2. write_file (generator script)
                #   3. bash (run) — may fail and need retries
                #   4. bash (verify / ls)
                #   5. emit_builder_artifact
                # On a tricky script, retries can eat 6-8 turns easily.
                # 20 gives bash room to recover; below that we were force-stopping
                # on healthy builds that just had one or two failed runs.
                _HARD_CEILING = 20
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
                        # Best-effort replicate the promoted file to the Gateway
                        # disk so the user can download it even on a force-stop.
                        thread_data_local = state.get("thread_data") or {}
                        outputs_host_path_local = (
                            thread_data_local.get("outputs_path")
                            if isinstance(thread_data_local, dict)
                            else None
                        )
                        thread_id_local = runtime.context.get("thread_id") if runtime.context else None
                        replication = _replicate_builder_outputs(
                            thread_id=thread_id_local,
                            outputs_host_path=outputs_host_path_local,
                            artifact_args=fallback,
                        )
                        fallback["replication"] = replication
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
