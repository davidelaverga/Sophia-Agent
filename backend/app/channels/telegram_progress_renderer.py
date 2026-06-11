"""Progress renderer — maps langgraph v3 stream events to plain text.

The streaming subscriber reads ``StreamPart(event, data, id)`` chunks
from ``client.runs.join_stream`` and asks this renderer to project each
chunk into a placeholder-message body. Plain text only (no Markdown
parse_mode) — see learning #6 from the v3 migration plan: user content
in tool args regularly contains characters Telegram's Markdown parser
chokes on (``_`` in URLs, ``*`` in commands, ``[]`` in file paths).
Bracket-decorated headers give visual hierarchy without parse_mode.

Spec reference: ``learnings 6, 12, 19, 20`` in the plan file.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


_MAX_VISIBLE_ACTIVITY_LINES = 6
_ACTIVITY_LINE_MAX_CHARS = 80
_TELEGRAM_MESSAGE_LIMIT = 4096

# Tool-name → activity line emoji + verb. Unknown tools render with a
# generic 🔧 prefix so the placeholder still shows *something* useful.
_TOOL_LABELS: dict[str, tuple[str, str]] = {
    "builder_web_search": ("🔍", "Searching"),
    "builder_web_fetch": ("🔗", "Reading"),
    "web_search": ("🔍", "Searching"),
    "web_fetch": ("🔗", "Reading"),
    "tavily_search": ("🔍", "Searching"),
    "jina_fetch": ("🔗", "Reading"),
    "write_file": ("📝", "Drafting"),
    "str_replace": ("✏️", "Editing"),
    "bash": ("⚙️", "Running"),
    "ls": ("📂", "Listing"),
    "read_file": ("📖", "Reading"),
    "emit_builder_artifact": ("📦", "Wrapping up"),
}

# Tool names that are too noisy to render as activity lines (low-signal
# internals like file-tree listing, tiny edits inside a write loop).
#
# Phase 4N (2026-05-19): ``bash`` added to the hidden set. User
# feedback after the Phase 4M deploy: the ``⚙️ Running: …`` lines
# (verification commands like ``wc -l`` / ``ls``, intermediate
# Python operations) clutter the placeholder during drafting.
# Trade-off accepted by the user: binary-deliverable workflows that
# bash-run a generator script (chart-visualization, ppt-generation
# skills) will show a blank stream during the ~30-60s the script
# runs. The deliverable still arrives via the independent
# ``_on_builder_completion`` path. If the trade-off becomes
# noticeable, swap this blanket entry for a command-pattern
# heuristic (hide only heredocs / ``python -c`` / ``echo > …``).
_HIDDEN_TOOLS: frozenset[str] = frozenset({
    "ls",
    "read_file",
    "str_replace",
    "todo_read",
    "todo_write",
    "bash",
})

_PHASE_LABELS: dict[str, str] = {
    "starting": "Working",
    "researching": "Researching",
    "drafting": "Drafting",
    "finalizing": "Finalizing",
    # VQ-10: the build-to-condition loop is polishing the deliverable.
    "refining": "Refining",
    "done": "Done",
    # Phase 4F: non-terminal degraded states so the placeholder
    # honestly reflects "we couldn't observe the run" or
    # "subscriber gave up but the build may still be going".
    "stalled": "Still working",
    "stopped": "Stopped",
}


def _shorten(value: str, limit: int) -> str:
    if not value:
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
class ProgressState:
    """Mutable state the renderer maintains across stream events."""

    activity_lines: list[str] = field(default_factory=list)
    current_phase: str = "starting"
    summary_text: str = ""
    terminal: bool = False

    def append_activity(self, line: str) -> None:
        line = _shorten(line, _ACTIVITY_LINE_MAX_CHARS)
        if not line:
            return
        # Collapse adjacent duplicates — successive identical tool calls
        # don't deserve separate lines.
        if self.activity_lines and self.activity_lines[-1] == line:
            return
        self.activity_lines.append(line)

    def render(self) -> str:
        header_raw = _PHASE_LABELS.get(self.current_phase, self.current_phase.capitalize() or "Working")
        header = f"[ {header_raw} ]"
        visible = self.activity_lines[-_MAX_VISIBLE_ACTIVITY_LINES:]
        parts = [header, ""]
        if visible:
            parts.extend(visible)
        if self.summary_text:
            parts.extend(["", _shorten(self.summary_text, 600)])
        body = "\n".join(parts).strip()
        if len(body) > _TELEGRAM_MESSAGE_LIMIT:
            body = body[: _TELEGRAM_MESSAGE_LIMIT - 1] + "…"
        return body


@dataclass(slots=True)
class RenderResult:
    """Outcome of applying one stream event."""

    state_changed: bool
    terminal: bool


class ProgressRenderer:
    """Apply ``StreamPart`` events to a ``ProgressState``.

    Stateless beyond its ``state`` instance — call ``apply`` for each
    incoming chunk and use ``render()`` to get the placeholder body.
    """

    def __init__(self) -> None:
        self.state = ProgressState()

    # -- public API ----------------------------------------------------------

    def apply(self, event_name: str, data: Any) -> RenderResult:
        """Project one ``StreamPart`` into state mutations.

        ``event_name`` is ``StreamPart.event`` (the stream-mode string
        ``messages`` / ``updates`` / ``custom`` etc.); ``data`` is the
        mode-specific payload (``StreamPart.data``).
        """
        before = self._snapshot()
        try:
            self._dispatch(event_name, data)
        except Exception:
            logger.warning("ProgressRenderer.apply raised for event=%s", event_name, exc_info=True)
        terminal = self.state.terminal
        return RenderResult(state_changed=self._snapshot() != before, terminal=terminal)

    def render(self) -> str:
        return self.state.render()

    # -- dispatch ------------------------------------------------------------

    def _dispatch(self, event_name: str, data: Any) -> None:
        if event_name in ("messages", "messages-tuple"):
            self._on_messages(data)
        elif event_name == "updates":
            self._on_updates(data)
        elif event_name == "custom":
            self._on_custom(data)
        elif event_name in ("values", "checkpoints", "tasks", "debug"):
            # Too noisy to render per-chunk; the per-event aggregate
            # already arrives via updates/messages.
            return
        else:
            logger.debug("ProgressRenderer: ignoring unknown event=%s", event_name)

    def _on_messages(self, data: Any) -> None:
        """``messages`` mode: per-message AI text deltas. We don't render
        the model's free-text into the activity log — the text goes into
        the final artifact, not the chat. Setting current_phase to
        ``researching`` once we see any AI output is enough to nudge the
        header off the initial ``Working`` state.
        """
        if self.state.current_phase == "starting":
            self.state.current_phase = "researching"

    def _on_updates(self, data: Any) -> None:
        """``updates`` mode: ``{node_name: {state_deltas}}``. We mine the
        ``messages`` channel of each node for tool calls and render
        activity lines.
        """
        if not isinstance(data, dict):
            return
        for _node_name, node_state in data.items():
            if not isinstance(node_state, dict):
                continue
            messages = node_state.get("messages")
            if not isinstance(messages, list):
                continue
            for msg in messages:
                for call in _extract_tool_calls(msg):
                    self._on_tool_call(call)

    def _on_custom(self, data: Any) -> None:
        """``custom`` mode: deepagents-side phase / metadata signals."""
        if not isinstance(data, dict):
            return
        name = data.get("name") or data.get("event")
        if name == "phase":
            phase = data.get("phase") or (data.get("payload") or {}).get("phase")
            if isinstance(phase, str) and phase:
                self.state.current_phase = phase

    def _on_tool_call(self, call: dict[str, Any]) -> None:
        tool_name = str(call.get("name") or call.get("tool_name") or "").strip()
        if not tool_name or tool_name in _HIDDEN_TOOLS:
            return
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        emoji, verb = _TOOL_LABELS.get(tool_name, ("🔧", tool_name.replace("_", " ")))
        detail = self._format_tool_detail(tool_name, args)
        if detail:
            self.state.append_activity(f"{emoji} {verb}: {detail}")
        else:
            self.state.append_activity(f"{emoji} {verb}")
        if tool_name in ("builder_web_search", "builder_web_fetch", "web_search", "web_fetch", "tavily_search"):
            if self.state.current_phase in ("starting", "researching"):
                self.state.current_phase = "researching"
        elif tool_name == "write_file":
            self.state.current_phase = "drafting"
        elif tool_name == "emit_builder_artifact":
            self.state.current_phase = "finalizing"

    def _format_tool_detail(self, tool_name: str, args: dict[str, Any]) -> str:
        if tool_name in ("builder_web_search", "web_search", "tavily_search"):
            return _shorten(self._stringify(args.get("query")), 60)
        if tool_name in ("builder_web_fetch", "web_fetch", "jina_fetch"):
            return _shorten_url(self._stringify(args.get("url")))
        if tool_name == "write_file":
            return _shorten_path(self._stringify(args.get("path") or args.get("file_path")))
        if tool_name == "bash":
            return _shorten(self._stringify(args.get("command")), 60)
        return ""

    # -- helpers -------------------------------------------------------------

    @staticmethod
    def _stringify(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return str(value)

    def _snapshot(self) -> tuple[Any, ...]:
        return (
            tuple(self.state.activity_lines),
            self.state.current_phase,
            self.state.summary_text,
            self.state.terminal,
        )

    def mark_done(self, summary: str = "") -> RenderResult:
        """Caller signals the run has ended successfully (natural stream end).

        The stream itself doesn't carry a "terminal" event the renderer
        can rely on — the SDK iterator just stops. The subscriber's
        loop calls this method when the iteration ends, with the
        builder's summary (or empty) as the final body line.

        Phase 4N (2026-05-19): clears accumulated activity history so
        the final placeholder renders as a clean ``[ Done ]`` (+
        optional summary). The intermediate tool-call lines are
        live-progress signal only — once the build is complete the
        deliverable is what matters, and the artifact arrives as a
        separate Telegram message via ``_on_builder_completion``.
        Previously shipped at ``f04767b6``, rolled back at
        ``b9eeb7c3`` as part of Phase 4K's full backout. Re-introduced
        in isolation now that the underlying builder regression
        (Phase 4M's bash-heredoc loop) is fixed.

        Scoped to ``mark_done`` only — ``mark_stalled`` (per-event
        timeout) and ``mark_stopped`` (error / cancel) preserve
        history because in those degraded states the history is the
        user's last honest signal about what the build was doing
        when the stream stopped.
        """
        before = self._snapshot()
        self.state.current_phase = "done"
        self.state.terminal = True
        self.state.activity_lines = []
        if summary:
            self.state.summary_text = _shorten(summary, 600)
        return RenderResult(state_changed=self._snapshot() != before, terminal=True)

    def mark_stalled(self, reason: str = "") -> RenderResult:
        """Subscriber signals the stream went silent but the run may still be live.

        Phase 4F: per-event / total timeouts must NOT push ``[ Done ]``
        because the builder may still be working — the artifact
        delivery path (`_on_builder_completion`) is independent. The
        placeholder ends on ``[ Still working — <reason> ]`` so the
        user knows the live progress is gone but the deliverable may
        still arrive.
        """
        before = self._snapshot()
        self.state.current_phase = "stalled"
        # NOT terminal — keep ``self.state.terminal`` False so any later
        # legitimate stream-completion event can still finalize.
        if reason:
            self.state.summary_text = _shorten(f"({reason})", 600)
        return RenderResult(state_changed=self._snapshot() != before, terminal=False)

    def mark_stopped(self, reason: str = "") -> RenderResult:
        """Subscriber signals a hard exit (error / cancel) — terminal.

        Unlike ``mark_stalled`` this DOES set ``terminal=True`` because
        the subscriber will not push further edits. The artifact path
        is still independent and may still deliver.
        """
        before = self._snapshot()
        self.state.current_phase = "stopped"
        self.state.terminal = True
        if reason:
            self.state.summary_text = _shorten(f"({reason})", 600)
        return RenderResult(state_changed=self._snapshot() != before, terminal=True)


def _extract_tool_calls(message: Any) -> list[dict[str, Any]]:
    """Pull a list of tool-call dicts off an AIMessage-like value."""
    tool_calls = getattr(message, "tool_calls", None)
    if tool_calls is None and isinstance(message, dict):
        tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list):
        return []
    return [tc for tc in tool_calls if isinstance(tc, dict)]


def _shorten_path(path: str) -> str:
    if not path:
        return ""
    parts = path.rsplit("/", 1)
    return parts[-1] or path


__all__ = ["ProgressRenderer", "ProgressState", "RenderResult"]
