"""Unit tests for WorkshopMessageRenderer projection rules (spec §13.1)."""

from __future__ import annotations

from app.channels.telegram_workshop_renderer import WorkshopMessageRenderer
from app.gateway.builder_events.types import (
    CompletedEvent,
    CustomEvent,
    SubagentEvent,
    ToolCallEvent,
)

_BASE_FIELDS = dict(
    task_id="t",
    thread_id="th",
    user_id="u",
    channel_origin="telegram",
    timestamp_ms=1,
    sequence=1,
)


def _tool(name: str, args: dict | None = None, *, status: str = "started", seq: int = 1) -> ToolCallEvent:
    fields = {**_BASE_FIELDS, "sequence": seq}
    return ToolCallEvent(
        **fields,
        tool_call_id=f"call_{seq}",
        tool_name=name,
        args=args or {},
        status=status,
    )


def test_search_renders_researching_phase() -> None:
    renderer = WorkshopMessageRenderer()
    renderer.apply(_tool("builder_web_search", {"query": "best EVs Europe"}, seq=1))
    body = renderer.render()
    assert "Researching" in body
    assert "🔍 Searching: best EVs Europe" in body


def test_web_fetch_renders_reading() -> None:
    renderer = WorkshopMessageRenderer()
    renderer.apply(_tool("builder_web_fetch", {"url": "https://ev-database.org/"}, seq=1))
    body = renderer.render()
    assert "🔗 Reading: ev-database.org" in body


def test_markdown_write_transitions_to_drafting() -> None:
    renderer = WorkshopMessageRenderer()
    renderer.apply(_tool("write_file", {"path": "/mnt/outputs/report.md"}, seq=1))
    body = renderer.render()
    assert "Drafting" in body
    assert "📝 Drafting" in body


def test_emit_artifact_transitions_to_finalizing() -> None:
    renderer = WorkshopMessageRenderer()
    renderer.apply(_tool("emit_builder_artifact", {}, seq=1))
    body = renderer.render()
    assert "Finalizing" in body
    assert "📦 Wrapping up" in body


def test_hidden_tools_not_rendered() -> None:
    renderer = WorkshopMessageRenderer()
    for hidden in ("read_file", "ls", "todo_read", "todo_write", "str_replace"):
        renderer.apply(_tool(hidden, {}, seq=1))
    body = renderer.render()
    assert "🔍" not in body  # nothing rendered
    assert "🔗" not in body
    assert renderer.state.activity_lines == []


def test_subagent_spawn_renders_starting() -> None:
    renderer = WorkshopMessageRenderer()
    renderer.apply(
        SubagentEvent(
            **_BASE_FIELDS,
            subagent_id="sa1",
            subagent_type="sophia_builder",
            status="spawned",
        )
    )
    body = renderer.render()
    assert "🛠 Starting work" in body


def test_custom_phase_event() -> None:
    renderer = WorkshopMessageRenderer()
    renderer.apply(
        CustomEvent(
            **_BASE_FIELDS,
            name="phase",
            payload={"phase": "finalizing"},
        )
    )
    body = renderer.render()
    assert "Finalizing" in body
    assert "🪡 Finalizing" in body


def test_completed_terminal_renders_done_and_summary() -> None:
    renderer = WorkshopMessageRenderer()
    result = renderer.apply(
        CompletedEvent(
            **_BASE_FIELDS,
            status="completed",
            companion_summary="Top family EVs: ID.Buzz, EX90, EV9.",
        )
    )
    assert result.terminal is True
    body = renderer.render()
    assert "Done" in body
    assert "✓ Done." in body
    assert "ID.Buzz" in body


def test_completed_failed_renders_snag_message() -> None:
    renderer = WorkshopMessageRenderer()
    renderer.apply(
        CompletedEvent(
            **_BASE_FIELDS,
            status="failed",
            error="boom",
        )
    )
    body = renderer.render()
    assert "Hit a snag" in body
    assert "boom" in body


def test_visible_activity_lines_capped_to_last_five() -> None:
    renderer = WorkshopMessageRenderer()
    for i in range(8):
        renderer.apply(_tool("builder_web_fetch", {"url": f"https://x.example/{i}"}, seq=i + 1))
    body = renderer.render()
    # We render at most 5 visible lines + header + summary
    lines = [line for line in body.splitlines() if line.strip().startswith("🔗")]
    assert len(lines) == 5
    # The newest line (7) is visible; the oldest (0) is not
    assert any("x.example/7" in line for line in lines)
    assert not any("x.example/0" in line for line in lines)


def test_dedup_adjacent_identical_lines() -> None:
    renderer = WorkshopMessageRenderer()
    renderer.apply(_tool("builder_web_fetch", {"url": "https://x"}, seq=1))
    renderer.apply(_tool("builder_web_fetch", {"url": "https://x"}, seq=2))
    body = renderer.render()
    occurrences = [line for line in body.splitlines() if "x" in line and line.strip().startswith("🔗")]
    assert len(occurrences) == 1


def test_state_changed_reported() -> None:
    renderer = WorkshopMessageRenderer()
    result1 = renderer.apply(_tool("builder_web_search", {"query": "x"}, seq=1))
    assert result1.state_changed
    result2 = renderer.apply(_tool("read_file", {"path": "a"}, seq=2))  # hidden
    assert not result2.state_changed


def test_render_is_plain_text_not_markdown() -> None:
    """Phase 2 regression: the renderer must produce plain text — never
    Markdown-formatted output. User / tool args splice in unescaped
    content with Markdown metacharacters (URLs with underscores, file
    paths with brackets, shell commands with backticks etc.); a single
    such char in a Markdown-mode message would trip Telegram's
    'can't parse entities' rejection on edit, and the streaming workshop
    reply would stop updating mid-task.

    The header is decorated with brackets — not single-asterisk bold —
    precisely so the renderer's output is parse-mode-free.
    """
    renderer = WorkshopMessageRenderer()
    # Mix in queries / URLs / commands that contain Markdown metachars
    renderer.apply(_tool("builder_web_search", {"query": "best_EVs*Europe_2026"}, seq=1))
    renderer.apply(_tool("builder_web_fetch", {"url": "https://ev_database.org/cars[2]"}, seq=2))
    renderer.apply(_tool("bash", {"command": "ls -la *.md"}, seq=3))
    body = renderer.render()

    # Header must be bracket-decorated, NOT asterisk-bolded.
    first_line = body.splitlines()[0]
    assert first_line.startswith("[") and first_line.endswith("]")
    # Single-asterisk header markers are exactly what we're trying to
    # avoid — fail loudly if anyone reintroduces them.
    assert not (first_line.startswith("*") and first_line.endswith("*"))
    # The user content with metachars must round-trip verbatim — no
    # escaping, but also no missing characters.
    assert "best_EVs*Europe_2026" in body
    assert "ev_database.org/cars[2]" in body
    assert "ls -la *.md" in body
