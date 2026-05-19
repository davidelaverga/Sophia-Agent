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

    def test_bash_tool_calls_are_hidden_from_activity_stream(self) -> None:
        """Phase 4N regression lock: ``bash`` joins the hidden set.

        Before this change, every bash call surfaced as ``⚙️ Running: …``
        in the placeholder — verification commands (``wc -l``, ``ls``,
        ``cat``), small inline-Python operations, and (less often)
        legitimate generator-script execution. User feedback after the
        Phase 4M deploy: the ``Running`` lines clutter the placeholder
        and don't add signal the user cares about; the deliverable is
        the produced file, not the shell command that produced it.

        Acceptance: a bash tool_call MUST produce zero activity lines
        and zero ``⚙️`` glyphs in the rendered body. ``state_changed``
        will correctly be ``False`` (same pattern as the other
        hidden tools) so the registry's per-task edit dispatch
        short-circuits on a bash-only batch.
        """
        r = ProgressRenderer()
        result = r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "bash", "args": {"command": "wc -l /mnt/user-data/outputs/report.md"}},
            ])]},
        })
        body = r.render()
        assert "⚙️" not in body, "bash gear glyph must not appear in rendered placeholder"
        assert "Running" not in body, "bash 'Running' verb must not appear in rendered placeholder"
        assert r.state.activity_lines == [], "bash must not add an activity line"
        # Existing hidden-tool semantics: no activity line added → no
        # state mutation → no edit fired downstream.
        assert result.state_changed is False

    def test_bash_hidden_does_not_filter_other_tools_in_same_batch(self) -> None:
        """Sanity companion: a batch that contains BOTH a hidden bash
        call AND a visible tool (e.g. builder_web_search) still renders
        the visible tool. The filter is per-tool, not a blanket
        'any bash in the batch hides everything' rule.
        """
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "bash", "args": {"command": "ls /mnt/user-data/outputs"}},
                {"name": "builder_web_search", "args": {"query": "claude subagents"}},
            ])]},
        })
        body = r.render()
        # Search still rendered.
        assert "🔍 Searching: claude subagents" in body
        # Bash still hidden.
        assert "⚙️" not in body
        assert "Running" not in body

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

    def test_mark_done_clears_activity_history(self) -> None:
        """Phase 4N: when the build reaches ``[ Done ]``, the accumulated
        live-progress activity lines (🔍 Searching, 🔗 Reading, 📝
        Drafting) are CLEARED so the final placeholder renders as a
        clean header (+ optional summary). The intermediate activity is
        live-streaming signal only — once the build is complete the
        deliverable is what matters, and it arrives as a separate
        Telegram message via ``_on_builder_completion``.

        Previously shipped at ``f04767b6``, rolled back at ``b9eeb7c3``
        as part of Phase 4K's diagnostic backout. Re-introduced in
        isolation now that the underlying builder regression
        (Phase 4M's bash-heredoc loop) is fixed and the rollback's
        precaution is no longer needed.
        """
        r = ProgressRenderer()
        # Build a typical drafting history.
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": "claude subagents"}},
            ])]},
        })
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_fetch", "args": {"url": "https://example.com/page"}},
            ])]},
        })
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "write_file", "args": {"path": "/mnt/user-data/outputs/report.md"}},
            ])]},
        })
        # Sanity: pre-mark_done the history IS populated.
        pre_body = r.render()
        assert "🔍 Searching" in pre_body
        assert "🔗 Reading" in pre_body
        assert "📝 Drafting" in pre_body

        result = r.mark_done(summary="Build complete.")
        assert result.terminal is True

        body = r.render()
        assert "[ Done ]" in body
        assert "Build complete." in body
        # Activity lines MUST be cleared.
        assert "🔍 Searching" not in body
        assert "🔗 Reading" not in body
        assert "📝 Drafting" not in body
        assert r.state.activity_lines == []

    def test_mark_done_without_summary_clears_activity_history(self) -> None:
        """Even with no summary, ``mark_done`` clears history — the
        final body is just ``[ Done ]`` on its own. Locks the
        no-summary case separately so a future change can't
        accidentally bind the clear behaviour to summary-present.
        """
        r = ProgressRenderer()
        r.apply("updates", {
            "agent": {"messages": [_Aimsg([
                {"name": "builder_web_search", "args": {"query": "x"}},
            ])]},
        })
        assert r.state.activity_lines  # populated before mark_done

        r.mark_done()  # no summary

        body = r.render()
        assert "[ Done ]" in body
        assert "🔍 Searching" not in body
        assert r.state.activity_lines == []

    def test_mark_stalled_renders_still_working_and_is_not_terminal(self) -> None:
        """Phase 4F: per-event / total timeout MUST NOT pretend the
        build is done. The build may still be running — the streaming
        UX merely lost the live signal. ``terminal=False`` lets a later
        legitimate completion still overwrite it; the artifact-delivery
        path is independent and may still deliver.
        """
        r = ProgressRenderer()
        result = r.mark_stalled(reason="no events for 120s")
        assert result.terminal is False
        body = r.render()
        assert "[ Still working ]" in body
        assert "no events for 120s" in body
        # Crucially: NOT "[ Done ]".
        assert "[ Done ]" not in body

    def test_mark_stopped_renders_stopped_header_and_is_terminal(self) -> None:
        """Phase 4F: ``cancelled`` / ``error`` are terminal — the subscriber
        won't push more edits — but they MUST NOT claim Done. The artifact
        delivery path is still independent and may still deliver."""
        r = ProgressRenderer()
        result = r.mark_stopped(reason="cancelled")
        assert result.terminal is True
        body = r.render()
        assert "[ Stopped ]" in body
        assert "cancelled" in body
        assert "[ Done ]" not in body


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
