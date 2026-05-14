"""WorkshopMessageRenderer — project BuilderEvents into a Telegram message body.

The renderer maintains an internal model of the in-flight workshop
streaming message and applies the projection rules from spec §13.1.
Sinks call :meth:`apply` for each event; the renderer returns a
``MessageRenderResult`` indicating whether a flush is recommended.

The renderer is pure — it does not call the Telegram API. The workshop
handler owns the streaming-text client and decides when to flush
(rate-limited to 750ms per spec §13.4).

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §13.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.gateway.builder_events.types import BuilderEvent

_PHASE_HEADERS: dict[str, str] = {
    "starting": "Working",
    "researching": "Researching",
    "drafting": "Drafting",
    "finalizing": "Finalizing",
    "done": "Done",
    "failed": "Hit a snag",
    "timed_out": "Took too long",
    "cancelled": "Cancelled",
}

_MAX_VISIBLE_ACTIVITY_LINES = 5
_ACTIVITY_LINE_MAX_CHARS = 80
_MAX_SUMMARY_CHARS = 600
_TELEGRAM_MESSAGE_LIMIT = 4096


def _shorten(value: str, limit: int) -> str:
    if value is None:
        return ""
    value = value.strip()
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)] + "…"


def _shorten_url(url: str, limit: int = 60) -> str:
    if not isinstance(url, str):
        return ""
    cleaned = url
    for prefix in ("https://", "http://"):
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix):]
            break
    if cleaned.endswith("/"):
        cleaned = cleaned[:-1]
    return _shorten(cleaned, limit)


@dataclass(slots=True)
class WorkshopMessageState:
    """Internal model of the streaming message."""

    activity_lines: list[str] = field(default_factory=list)
    current_phase: str = "starting"
    summary_text: str = ""
    terminal: bool = False

    def append_activity(self, line: str) -> None:
        line = _shorten(line, _ACTIVITY_LINE_MAX_CHARS)
        if not line:
            return
        # Avoid stacking identical adjacent lines (e.g. multiple read_file
        # calls collapse into a single "🔗 Reading: …" earlier — but we
        # still want this safety net).
        if self.activity_lines and self.activity_lines[-1] == line:
            return
        self.activity_lines.append(line)

    def render(self) -> str:
        header = _PHASE_HEADERS.get(self.current_phase, self.current_phase.capitalize() or "Working")
        visible = self.activity_lines[-_MAX_VISIBLE_ACTIVITY_LINES:]
        body_parts = [f"*{header}*", ""]
        if visible:
            body_parts.extend(visible)
        if self.summary_text:
            body_parts.extend(["", _shorten(self.summary_text, _MAX_SUMMARY_CHARS)])
        rendered = "\n".join(body_parts).strip()
        if len(rendered) > _TELEGRAM_MESSAGE_LIMIT:
            rendered = rendered[: _TELEGRAM_MESSAGE_LIMIT - 1] + "…"
        return rendered


@dataclass(slots=True)
class MessageRenderResult:
    """Outcome of applying one event."""

    state_changed: bool
    terminal: bool


class WorkshopMessageRenderer:
    """Apply BuilderEvents to ``WorkshopMessageState`` per spec §13.1."""

    # Tool calls that are hidden from the activity log (still consumed by
    # other sinks). See spec §13.2.
    HIDDEN_TOOLS = frozenset({"read_file", "ls", "todo_read", "todo_write", "str_replace"})

    def __init__(self) -> None:
        self.state = WorkshopMessageState()

    def apply(self, event: BuilderEvent) -> MessageRenderResult:
        before = self._snapshot()
        if event.type == "completed":
            self._apply_completed(event)
            self.state.terminal = True
            return MessageRenderResult(state_changed=self._snapshot() != before, terminal=True)
        if event.type == "tool_call":
            self._apply_tool_call(event)
        elif event.type == "subagent":
            self._apply_subagent(event)
        elif event.type == "custom":
            self._apply_custom(event)
        # message_delta is intentionally ignored — text goes into the
        # artifact, not the streaming activity log.
        return MessageRenderResult(
            state_changed=self._snapshot() != before,
            terminal=False,
        )

    def render(self) -> str:
        return self.state.render()

    # -- per-type handlers ---------------------------------------------------

    def _apply_tool_call(self, event: BuilderEvent) -> None:
        tool_name = getattr(event, "tool_name", "")
        if tool_name in self.HIDDEN_TOOLS:
            return
        if getattr(event, "status", "") != "started":
            # Phase 1 renders only started — completed/failed are noise.
            return
        args = getattr(event, "args", {}) or {}
        handler = self._TOOL_HANDLERS.get(tool_name)
        if handler is None:
            self.state.append_activity(f"🔧 {tool_name.replace('_', ' ')}")
            return
        handler(self, args)

    def _on_tool_web_search(self, args: dict[str, Any]) -> None:
        query = self._stringify(args.get("query"))
        self.state.current_phase = "researching"
        self.state.append_activity(f"🔍 Searching: {query}")

    def _on_tool_web_fetch(self, args: dict[str, Any]) -> None:
        url = self._stringify(args.get("url"))
        self.state.current_phase = "researching"
        self.state.append_activity(f"🔗 Reading: {_shorten_url(url)}")

    def _on_tool_write_file(self, args: dict[str, Any]) -> None:
        path = self._stringify(args.get("path") or args.get("file_path"))
        if path.endswith(".md"):
            self.state.current_phase = "drafting"
            self.state.append_activity("📝 Drafting…")
        else:
            self.state.append_activity(f"💾 Writing: {self._shorten_path(path)}")

    def _on_tool_bash(self, args: dict[str, Any]) -> None:
        command = self._stringify(args.get("command"))
        if command:
            self.state.append_activity(f"⚙️ Running: {_shorten(command, 60)}")

    def _on_tool_emit_artifact(self, args: dict[str, Any]) -> None:  # noqa: ARG002
        self.state.current_phase = "finalizing"
        self.state.append_activity("📦 Wrapping up…")

    def _apply_subagent(self, event: BuilderEvent) -> None:
        status = getattr(event, "status", "")
        subagent_type = getattr(event, "subagent_type", "")
        # Phase 1 renders only the main builder spawn. Spec §13.2 defers
        # nested-subagent rendering.
        if status == "spawned" and subagent_type in ("", "main", "sophia_builder"):
            self.state.append_activity("🛠 Starting work…")

    def _apply_custom(self, event: BuilderEvent) -> None:
        name = getattr(event, "name", "")
        payload = getattr(event, "payload", {}) or {}
        if name == "phase":
            phase = payload.get("phase") or payload.get("value")
            if isinstance(phase, str) and phase:
                self.state.current_phase = phase
                if phase == "finalizing":
                    self.state.append_activity("🪡 Finalizing…")

    def _apply_completed(self, event: BuilderEvent) -> None:
        status = getattr(event, "status", "completed")
        summary = getattr(event, "companion_summary", None) or ""
        error = getattr(event, "error", None) or ""
        if status == "completed":
            self.state.current_phase = "done"
            self.state.append_activity("✓ Done.")
            self.state.summary_text = _shorten(summary, _MAX_SUMMARY_CHARS) or self.state.summary_text
        elif status == "failed":
            self.state.current_phase = "failed"
            self.state.summary_text = _shorten(error, _MAX_SUMMARY_CHARS) or "Hit a snag. Sophia will follow up."
        elif status == "timed_out":
            self.state.current_phase = "timed_out"
            self.state.summary_text = "Took too long. Sophia will follow up."
        elif status == "cancelled":
            self.state.current_phase = "cancelled"
            self.state.summary_text = "Cancelled."

    # -- helpers -------------------------------------------------------------

    def _snapshot(self) -> tuple[Any, ...]:
        return (
            tuple(self.state.activity_lines),
            self.state.current_phase,
            self.state.summary_text,
            self.state.terminal,
        )

    @staticmethod
    def _stringify(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return str(value)

    @staticmethod
    def _shorten_path(path: str) -> str:
        if not path:
            return ""
        parts = path.rsplit("/", 1)
        return parts[-1] or path


# Dispatch table bound after class body so the bound-method references resolve.
WorkshopMessageRenderer._TOOL_HANDLERS = {  # type: ignore[attr-defined]
    "builder_web_search": WorkshopMessageRenderer._on_tool_web_search,
    "builder_web_fetch": WorkshopMessageRenderer._on_tool_web_fetch,
    "write_file": WorkshopMessageRenderer._on_tool_write_file,
    "bash": WorkshopMessageRenderer._on_tool_bash,
    "emit_builder_artifact": WorkshopMessageRenderer._on_tool_emit_artifact,
}


__all__ = ["MessageRenderResult", "WorkshopMessageRenderer", "WorkshopMessageState"]
