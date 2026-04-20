"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).

Before-model: enforces a hard turn cap so long-running builder sessions
pause with a partial result instead of running away. The companion then
asks the user whether to resume via ``switch_to_builder(resume_from_task_id=...)``.
"""

import logging
import time
import uuid
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)

# Hard turn cap for a single builder delegation. If the builder hits this
# without emitting emit_builder_artifact, we synthesize a partial result and
# jump to the end of the graph so the companion can surface a continuation
# prompt to the user. Kept intentionally generous — short enough to bound
# runaway loops, long enough that normal multi-file builds never trip it.
HARD_TURN_CAP = 40

# Builder status taxonomy (mirrored in ``sophia.tools.switch_to_builder``).
# Centralised here to avoid an import cycle between the middleware and the
# companion-facing tool.
_PARTIAL_STATUS = "partial"


class BuilderArtifactState(AgentState):
    # NOTE: Do not redeclare ``messages`` here. ``AgentState`` already declares
    # ``messages`` with the ``add_messages`` reducer so parallel tool calls
    # (e.g. two ``web_search`` entries in one AI message) can each append a
    # ``ToolMessage`` within the same super-step. Shadowing it with a plain
    # ``list`` annotation downgrades the channel to ``LastValue`` and causes
    # ``InvalidUpdateError: At key 'messages': Can receive only one value per step``.
    builder_result: NotRequired[dict | None]


def _count_tool_bearing_turns(messages: list) -> int:
    """Count AI messages that carried tool calls.

    Each such message represents one builder “turn” — the model made a
    decision and dispatched tools. Messages without tool calls (final text
    answers) are not counted.
    """
    turns = 0
    for msg in messages:
        if getattr(msg, "type", None) != "ai":
            continue
        if getattr(msg, "tool_calls", None):
            turns += 1
    return turns


def _collect_presented_files(messages: list) -> list[str]:
    """Return unique ``present_files`` filepaths discovered in message history.

    Order is preserved so ``artifact_path`` reliably points at the first
    presented file.
    """
    files: list[str] = []
    seen: set[str] = set()
    for msg in messages:
        if getattr(msg, "type", None) != "ai":
            continue
        tool_calls = getattr(msg, "tool_calls", None) or []
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            if tc.get("name") != "present_files":
                continue
            args = tc.get("args", {})
            if not isinstance(args, dict):
                continue
            filepaths = args.get("filepaths", [])
            if not isinstance(filepaths, list):
                continue
            for path in filepaths:
                if isinstance(path, str) and path and path not in seen:
                    seen.add(path)
                    files.append(path)
    return files


def _infer_artifact_type_from_path(path: str | None) -> str:
    if not path:
        return "unknown"
    suffix = Path(path).suffix.lower()
    if suffix in {".ppt", ".pptx", ".key"}:
        return "presentation"
    if suffix in {".html", ".htm"}:
        return "webpage"
    if suffix in {".csv", ".json", ".xlsx"}:
        return "data_analysis"
    if suffix in {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs"}:
        return "code"
    return "document"


def _most_recent_ai_text(messages: list) -> str:
    """Best-effort summary text from the most recent AI message.

    The builder may have emitted reasoning or progress notes even if it
    never reached emit_builder_artifact. We surface that as the partial
    summary_of_done so the companion has something concrete to relay.
    """
    for msg in reversed(messages):
        if getattr(msg, "type", None) != "ai":
            continue
        content = getattr(msg, "content", None)
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict):
                    text = block.get("text")
                    if isinstance(text, str):
                        parts.append(text)
            combined = "\n".join(p for p in parts if p.strip())
            if combined.strip():
                return combined.strip()
    return ""


def build_partial_builder_result(
    *,
    messages: list,
    turn_cap: int = HARD_TURN_CAP,
    turns_used: int | None = None,
    continuation_task_id: str | None = None,
) -> dict:
    """Assemble the canonical partial builder_result payload.

    Exposed as a module-level helper so ``switch_to_builder`` and tests can
    reuse the exact same shape.
    """
    presented_files = _collect_presented_files(messages)
    artifact_path = presented_files[0] if presented_files else None
    supporting_files = presented_files[1:] or None
    summary = _most_recent_ai_text(messages) or (
        "Builder paused at the turn cap before emitting a final artifact. "
        "Work-in-progress files are listed in completed_files."
    )
    return {
        "status": _PARTIAL_STATUS,
        "artifact_type": _infer_artifact_type_from_path(artifact_path),
        "artifact_title": "Partial draft (paused at turn cap)",
        "artifact_path": artifact_path,
        "supporting_files": supporting_files,
        "turns_used": turns_used if turns_used is not None else _count_tool_bearing_turns(messages),
        "turn_cap": turn_cap,
        "completed_files": presented_files,
        "summary_of_done": summary,
        "continuation_task_id": continuation_task_id or str(uuid.uuid4())[:12],
        "confidence": 0.5,
        "companion_summary": summary,
        "companion_tone_hint": (
            "Tell the user this is a partial draft paused at the turn cap; "
            "offer to resume with the continuation_task_id or stop here."
        ),
        "user_next_action": "confirm_resume_or_stop",
    }


class BuilderArtifactMiddleware(AgentMiddleware[BuilderArtifactState]):
    """Capture emit_builder_artifact tool call from the builder agent.

    Also enforces the hard turn cap via ``before_model``: if the builder has
    hit ``HARD_TURN_CAP`` tool-bearing turns without emitting a final
    artifact, we synthesise a partial ``builder_result`` and jump to end so
    the companion can prompt the user to continue or stop.
    """

    state_schema = BuilderArtifactState

    def __init__(self, *, turn_cap: int = HARD_TURN_CAP) -> None:
        super().__init__()
        self.turn_cap = turn_cap

    @hook_config(can_jump_to=["end"])
    @override
    def before_model(self, state: BuilderArtifactState, runtime: Runtime) -> dict | None:
        """Halt the builder loop if it is about to exceed the turn cap."""
        if state.get("builder_result") is not None:
            # Artifact already captured — nothing to enforce.
            return None

        messages = state.get("messages", [])
        turns_used = _count_tool_bearing_turns(messages)
        if turns_used < self.turn_cap:
            return None

        partial = build_partial_builder_result(
            messages=messages,
            turn_cap=self.turn_cap,
            turns_used=turns_used,
        )
        logger.warning(
            "[BuilderArtifact] HARD_TURN_CAP hit: turns_used=%d cap=%d continuation_task_id=%s "
            "artifact_path=%s completed_files=%d",
            turns_used,
            self.turn_cap,
            partial["continuation_task_id"],
            partial["artifact_path"],
            len(partial["completed_files"]),
        )
        # Inject a plain AIMessage so the agent's messages channel stays
        # valid (no dangling tool_calls) after we jump to end.
        cap_notice = AIMessage(
            content=(
                f"Reached the builder turn cap ({self.turn_cap}). Pausing with "
                f"a partial draft (continuation_task_id={partial['continuation_task_id']})."
            )
        )
        return {
            "jump_to": "end",
            "builder_result": partial,
            "messages": [cap_notice],
        }

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

            tool_calls = getattr(msg, "tool_calls", [])

            # AI message has tool calls -- look for emit_builder_artifact
            if tool_calls:
                tool_names = [
                    tc.get("name")
                    for tc in tool_calls
                    if isinstance(tc, dict) and isinstance(tc.get("name"), str)
                ]
                for tc in tool_calls:
                    if tc.get("name") == "emit_builder_artifact":
                        args = tc.get("args", {})
                        log_middleware(
                            "BuilderArtifact",
                            f"builder artifact captured: type={args.get('artifact_type')}, "
                            f"confidence={args.get('confidence')}",
                            _t0,
                        )
                        return {"builder_result": args}

                # Has tool calls but none are emit_builder_artifact -- agent loop continues
                tool_summary = ", ".join(tool_names[:4]) if tool_names else "unknown"
                log_middleware(
                    "BuilderArtifact",
                    f"tool calls present but no builder artifact (loop continues; tools={tool_summary})",
                    _t0,
                )
                return None

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
            log_middleware("BuilderArtifact", "no builder artifact tool call, using fallback", _t0)
            return {"builder_result": fallback}

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
