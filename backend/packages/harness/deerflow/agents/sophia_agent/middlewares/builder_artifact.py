"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).
"""

import logging
import time
from pathlib import Path
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import hook_config
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.storage import supabase_artifact_store

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

    Silently no-ops when Supabase is not configured, when thread_id or the
    outputs host path are missing, or when individual files cannot be read.
    Any failure is logged and swallowed so builder flow never regresses.
    """
    if not supabase_artifact_store.is_configured():
        return
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
        try:
            content = host_file.read_bytes()
        except FileNotFoundError:
            logger.warning(
                "Supabase upload skipped; local file missing thread_id=%s path=%s",
                thread_id,
                host_file,
            )
            continue
        except OSError as exc:
            logger.warning(
                "Supabase upload skipped; read error thread_id=%s path=%s error=%s",
                thread_id,
                host_file,
                exc,
            )
            continue

        try:
            supabase_artifact_store.upload_artifact(
                thread_id=thread_id,
                filename=relative,
                content=content,
            )
        except Exception as exc:  # noqa: BLE001 — best-effort upload
            logger.warning(
                "Supabase upload failed; continuing without remote copy thread_id=%s path=%s error=%s",
                thread_id,
                relative,
                exc,
            )


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
                        "jump_to": "end",
                    }

                if artifact_calls:
                    log_middleware("BuilderArtifact", "mixed tool calls with builder artifact; loop continues", _t0)
                    return None

                # Has tool calls but none are emit_builder_artifact -- agent loop continues
                non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                history = self._append_turn_summary(
                    state,
                    {
                        "turn": non_artifact_turns,
                        "tool_names": tool_names,
                        "has_emit_builder_artifact": False,
                    },
                )
                joined_names = ", ".join(tool_names) if tool_names else "none"

                # Hard ceiling: force end before hitting the recursion limit
                _HARD_CEILING = 12
                if non_artifact_turns >= _HARD_CEILING:
                    logger.warning(
                        "BuilderArtifact: hard ceiling reached at turn=%d, tools=%s — forcing end with fallback",
                        non_artifact_turns,
                        joined_names,
                    )
                    fallback = {
                        "artifact_path": None,
                        "artifact_type": "unknown",
                        "artifact_title": "Build task force-stopped",
                        "steps_completed": non_artifact_turns,
                        "decisions_made": [],
                        "companion_summary": (
                            f"The builder made {non_artifact_turns} edits but didn't finish cleanly. "
                            "The work-in-progress files may still be useful."
                        ),
                        "companion_tone_hint": "Apologetic — builder ran out of budget.",
                        "user_next_action": "Check the output files and let me know what to fix.",
                        "confidence": 0.2,
                    }
                    return {
                        "builder_result": fallback,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
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
