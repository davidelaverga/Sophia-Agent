"""Builder session middleware.

Bridges structured `switch_to_builder` handoff payloads and background
subagent status into companion state fields (`builder_task`, `builder_result`,
`delegation_context`, `active_mode`) so synthesis can happen reliably.
"""

import json
import time
from datetime import datetime
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.subagents.executor import SubagentStatus, cleanup_background_task, get_background_task_result

_NON_TERMINAL_STATUSES = {"queued", "running", "started"}
_TERMINAL_STATUSES = {"completed", "synthesized", "failed", "timed_out"}


class BuilderSessionState(AgentState):
    messages: NotRequired[list]
    active_mode: NotRequired[str]
    builder_task: NotRequired[dict | None]
    builder_result: NotRequired[dict | None]
    delegation_context: NotRequired[dict | None]
    system_prompt_blocks: NotRequired[list[str]]


class BuilderSessionMiddleware(AgentMiddleware[BuilderSessionState]):
    """Track builder task lifecycle and keep companion state synchronized."""

    state_schema = BuilderSessionState

    @staticmethod
    def _iso_or_none(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt else None

    @staticmethod
    def _extract_builder_result(result: Any) -> dict:
        """Extract builder_result from final_state, tool calls, or fallback text."""
        if getattr(result, "final_state", None):
            final_state = result.final_state or {}
            if isinstance(final_state, dict) and final_state.get("builder_result"):
                return final_state["builder_result"]

        for msg_dict in reversed(getattr(result, "ai_messages", []) or []):
            tool_calls = msg_dict.get("tool_calls", []) if isinstance(msg_dict, dict) else []
            for tc in tool_calls:
                if tc.get("name") == "emit_builder_artifact":
                    return tc.get("args", {})

        return {
            "artifact_path": None,
            "artifact_type": "unknown",
            "artifact_title": "Build task completed",
            "steps_completed": 0,
            "decisions_made": [],
            "companion_summary": getattr(result, "result", None) or "The build task was completed.",
            "companion_tone_hint": "Neutral — no builder context available.",
            "user_next_action": None,
            "confidence": 0.3,
        }

    @staticmethod
    def _normalize_tool_message_content(content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            chunks: list[str] = []
            for block in content:
                if isinstance(block, str):
                    chunks.append(block)
                elif isinstance(block, dict) and "text" in block:
                    chunks.append(str(block["text"]))
            return "\n".join(chunks)
        return str(content)

    def _extract_latest_handoff_payload(self, messages: list[Any]) -> dict | None:
        """Return latest `switch_to_builder` JSON payload from tool messages."""
        switch_tool_call_ids: set[str] = set()
        for msg in messages:
            if not isinstance(msg, AIMessage):
                continue
            for tc in getattr(msg, "tool_calls", []) or []:
                if tc.get("name") == "switch_to_builder" and tc.get("id"):
                    switch_tool_call_ids.add(tc["id"])

        for msg in reversed(messages):
            if not isinstance(msg, ToolMessage):
                continue
            msg_name = getattr(msg, "name", None)
            tool_call_id = getattr(msg, "tool_call_id", None)
            if msg_name != "switch_to_builder" and tool_call_id not in switch_tool_call_ids:
                continue

            payload_text = self._normalize_tool_message_content(getattr(msg, "content", ""))
            try:
                payload = json.loads(payload_text)
            except (TypeError, json.JSONDecodeError):
                continue

            if isinstance(payload, dict) and payload.get("type") == "builder_handoff":
                return payload
        return None

    @staticmethod
    def _in_progress_block(task: dict) -> str:
        return (
            "<builder_task_status>\n"
            f"Builder task in progress: task_id={task.get('task_id')} status={task.get('status')}.\n"
            "Do NOT call switch_to_builder again while this task is active.\n"
            "If the user asks for status, briefly acknowledge progress and stay present.\n"
            "</builder_task_status>"
        )

    @staticmethod
    def _failure_block(task: dict) -> str:
        debug = task.get("debug") or {}
        last_tools = ", ".join(debug.get("last_tool_names", [])) if debug.get("last_tool_names") else None
        late_tools = ", ".join(debug.get("late_tool_names", [])) if debug.get("late_tool_names") else None
        late_emit = debug.get("late_has_emit_builder_artifact")
        timed_out_at = debug.get("timed_out_at")

        extra_lines: list[str] = []
        if last_tools:
            extra_lines.append(f"last_tool_calls={last_tools}")
        if late_tools:
            extra_lines.append(f"late_tool_calls_after_timeout={late_tools}")
        if timed_out_at:
            extra_lines.append(f"timed_out_at={timed_out_at}")
        if late_emit:
            extra_lines.append("A late emit_builder_artifact arrived after timeout and was ignored to preserve terminal timeout semantics.")

        suffix = ("\n" + "\n".join(extra_lines)) if extra_lines else ""
        return (
            "<builder_task_status>\n"
            f"Latest builder task ended with status={task.get('status')}.\n"
            f"error={task.get('error') or 'unknown'}\n"
            f"{suffix}\n"
            "Acknowledge the failure once and offer a retry path.\n"
            "Do NOT automatically re-run switch_to_builder without user direction.\n"
            "</builder_task_status>"
        )

    def _status_from_result(self, result: Any) -> str:
        status = getattr(result, "status", None)
        if status == SubagentStatus.PENDING:
            return "queued"
        if status == SubagentStatus.RUNNING:
            return "running"
        if status == SubagentStatus.COMPLETED:
            return "completed"
        if status == SubagentStatus.FAILED:
            return "failed"
        if status == SubagentStatus.TIMED_OUT:
            return "timed_out"
        return "running"

    @staticmethod
    def _summary_tool_names(summary: dict[str, Any] | None) -> list[str]:
        if not isinstance(summary, dict):
            return []
        return [
            str(name).strip()
            for name in (summary.get("tool_names") or [])
            if str(name).strip()
        ][:8]

    def _build_task_debug(self, result: Any) -> dict[str, Any] | None:
        debug: dict[str, Any] = {}

        last_summary = getattr(result, "last_ai_message_summary", None)
        late_summary = getattr(result, "late_ai_message_summary", None)

        last_tools = self._summary_tool_names(last_summary)
        late_tools = self._summary_tool_names(late_summary)

        if last_tools:
            debug["last_tool_names"] = last_tools
        if isinstance(last_summary, dict):
            debug["last_has_emit_builder_artifact"] = bool(last_summary.get("has_emit_builder_artifact"))
        if late_tools:
            debug["late_tool_names"] = late_tools
        if isinstance(late_summary, dict):
            debug["late_has_emit_builder_artifact"] = bool(late_summary.get("has_emit_builder_artifact"))

        timed_out_at = self._iso_or_none(getattr(result, "timed_out_at", None))
        if timed_out_at:
            debug["timed_out_at"] = timed_out_at

        return debug or None

    @override
    def before_agent(self, state: BuilderSessionState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        updates: dict[str, Any] = {}
        blocks = list(state.get("system_prompt_blocks", []))
        messages = state.get("messages", [])

        payload = self._extract_latest_handoff_payload(messages)
        existing_task = state.get("builder_task") or {}

        if payload:
            payload_task = payload.get("builder_task") or {}
            task_id = payload_task.get("task_id") or payload.get("task_id")
            if task_id:
                payload_task = {
                    **payload_task,
                    "task_id": task_id,
                    "status": payload_task.get("status") or payload.get("status", "queued"),
                    "task_type": payload_task.get("task_type") or payload.get("task_type"),
                }

                if existing_task.get("task_id") != task_id:
                    updates["builder_task"] = payload_task
                    updates["builder_result"] = None
                    updates["delegation_context"] = payload.get("delegation_context")
                    existing_task = payload_task
                elif not state.get("delegation_context") and payload.get("delegation_context"):
                    updates["delegation_context"] = payload.get("delegation_context")

            if payload.get("status") == "failed" and not task_id:
                updates["builder_task"] = {
                    "task_id": None,
                    "description": None,
                    "task_type": payload.get("task_type"),
                    "status": "failed",
                    "trace_id": payload.get("trace_id"),
                    "error": payload.get("error") or "Builder handoff failed to start.",
                }
                existing_task = updates["builder_task"]

        current_task = updates.get("builder_task") or existing_task
        current_status = (current_task or {}).get("status")

        if current_task and current_status in _NON_TERMINAL_STATUSES:
            task_id = current_task.get("task_id")
            result = get_background_task_result(task_id) if task_id else None

            if result is None:
                failed_task = {
                    **current_task,
                    "status": "failed",
                    "error": "Builder task state disappeared before completion.",
                }
                updates["builder_task"] = failed_task
                updates["active_mode"] = "companion"
                blocks.append(self._failure_block(failed_task))
            else:
                mapped_status = self._status_from_result(result)
                if mapped_status in {"queued", "running"}:
                    running_task = {**current_task, "status": mapped_status}
                    updates["builder_task"] = running_task
                    updates["active_mode"] = "builder"
                    blocks.append(self._in_progress_block(running_task))
                elif mapped_status == "completed":
                    completed_task = {
                        **current_task,
                        "status": "completed",
                        "completed_at": self._iso_or_none(getattr(result, "completed_at", None)),
                    }
                    debug = self._build_task_debug(result)
                    if debug:
                        completed_task["debug"] = debug
                    updates["builder_task"] = completed_task
                    updates["builder_result"] = self._extract_builder_result(result)
                    updates["active_mode"] = "companion"
                    cleanup_background_task(task_id)
                else:
                    failed_task = {
                        **current_task,
                        "status": mapped_status,
                        "completed_at": self._iso_or_none(getattr(result, "completed_at", None)),
                        "error": getattr(result, "error", None),
                    }
                    debug = self._build_task_debug(result)
                    if debug:
                        failed_task["debug"] = debug
                    updates["builder_task"] = failed_task
                    updates["active_mode"] = "companion"
                    blocks.append(self._failure_block(failed_task))
                    cleanup_background_task(task_id)
        elif current_task and current_status in _TERMINAL_STATUSES:
            updates["active_mode"] = "companion"

        if blocks != list(state.get("system_prompt_blocks", [])):
            updates["system_prompt_blocks"] = blocks

        if not updates:
            log_middleware("BuilderSession", "no builder state change", _t0)
            return None

        next_status = (updates.get("builder_task") or current_task or {}).get("status")
        log_middleware("BuilderSession", f"builder status={next_status}", _t0)
        return updates
