"""Unit tests for ProgressRenderer (Phase 4D v3 streaming)."""

from __future__ import annotations

from app.channels.telegram_progress_renderer import ProgressRenderer, ProgressState


class _Aimsg:
    """AIMessage-like stub with tool_calls field."""

    def __init__(self, tool_calls=None) -> None:
        self.tool_calls = tool_calls or []
        self.content = ""


class TestRendererBasics:
    def test_initial_state_renders_starting_header(self) -> None:
        r = ProgressRenderer()
        body = r.render()
        assert body.startswith("[ Working ]")

    def test_render_is_plain_text_no_markdown(self) -> None:
        """Codex learning #6: no ``parse_mode`` — header uses brackets,
        not asterisks, so tool-arg content with Markdown metacharacters
        doesn't trip Telegram's parser."""
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": "weird_query*with[brackets]"}}
            ])]}
        })
        body = r.render()
        assert "weird_query*with[brackets]" in body
        # Header decoration must be brackets, NOT asterisks
        first_line = body.splitlines()[0]
        assert first_line.startswith("[") and first_line.endswith("]")
        assert not (first_line.startswith("*") and first_line.endswith("*"))


class TestEventDispatch:
    def test_messages_event_transitions_starting_to_researching(self) -> None:
        r = ProgressRenderer()
        assert r.state.current_phase == "starting"
        r.apply("messages", {"any": "payload"})
        assert r.state.current_phase == "researching"

    def test_updates_extracts_web_search(self) -> None:
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": "best EVs"}}
            ])]}
        })
        body = r.render()
        assert "🔍 Searching: best EVs" in body
        assert "[ Researching ]" in body

    def test_updates_extracts_web_fetch_with_shortened_url(self) -> None:
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_fetch", "args": {"url": "https://ev-database.org/cars/2026"}}
            ])]}
        })
        body = r.render()
        assert "🔗 Reading: ev-database.org/cars/2026" in body

    def test_updates_write_file_transitions_to_drafting(self) -> None:
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "write_file", "args": {"path": "/mnt/user-data/outputs/report.md"}}
            ])]}
        })
        body = r.render()
        assert "📝 Drafting" in body
        assert "[ Drafting ]" in body
        assert "report.md" in body

    def test_updates_emit_artifact_transitions_to_finalizing(self) -> None:
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "emit_builder_artifact", "args": {}}
            ])]}
        })
        body = r.render()
        assert "📦 Wrapping up" in body
        assert "[ Finalizing ]" in body

    def test_hidden_tools_not_rendered(self) -> None:
        """ls/read_file/str_replace/todo_* are too noisy for the chat UX."""
        r = ProgressRenderer()
        for name in ("ls", "read_file", "str_replace", "todo_read", "todo_write"):
            r.apply("updates", {
                "agent": {"messages": [_Aimsg([
                    {"name": name, "args": {"path": "x"}}
                ])]}
            })
        # No activity lines added
        body = r.render()
        assert "📂" not in body
        assert "📖" not in body
        assert "✏️" not in body
        # Body is just the initial header + blank
        assert r.state.activity_lines == []

    def test_custom_phase_event(self) -> None:
        r = ProgressRenderer()
        r.apply("custom", {"name": "phase", "phase": "finalizing"})
        assert r.state.current_phase == "finalizing"
        assert "[ Finalizing ]" in r.render()

    def test_unknown_tool_renders_with_generic_emoji(self) -> None:
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "do_some_thing", "args": {}}
            ])]}
        })
        body = r.render()
        assert "🔧" in body


class TestStateChangedSemantics:
    def test_state_changed_reported(self) -> None:
        r = ProgressRenderer()
        result1 = r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": "x"}}
            ])]}
        })
        assert result1.state_changed is True
        # Hidden tool — no state change
        result2 = r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "read_file", "args": {"path": "a"}}
            ])]}
        })
        assert result2.state_changed is False


class TestTerminalRendering:
    def test_mark_done_finalizes(self) -> None:
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": "x"}}
            ])]}
        })
        result = r.mark_done(summary="Found 5 sources.")
        assert result.terminal is True
        body = r.render()
        assert "[ Done ]" in body
        assert "Found 5 sources." in body

    def test_mark_done_without_summary_still_renders(self) -> None:
        r = ProgressRenderer()
        result = r.mark_done()
        assert result.terminal is True
        assert "[ Done ]" in r.render()


class TestLineDeduplication:
    def test_adjacent_identical_lines_collapsed(self) -> None:
        s = ProgressState()
        s.append_activity("🔍 Searching: same query")
        s.append_activity("🔍 Searching: same query")
        assert len(s.activity_lines) == 1

    def test_visible_lines_capped(self) -> None:
        r = ProgressRenderer()
        for i in range(10):
            r.apply("updates", {
                "agent": {"messages": [_Aimsg([
                    {"name": "builder_web_fetch", "args": {"url": f"https://x.example/{i}"}}
                ])]}
            })
        body = r.render()
        lines = [line for line in body.splitlines() if line.startswith("🔗")]
        # Max visible lines is bounded (currently 6)
        assert len(lines) <= 6
        # Most recent visible
        assert any("x.example/9" in line for line in lines)
        # Oldest evicted
        assert not any("x.example/0" in line for line in lines)
