"""Tests for PR G Commit 2: hard turn cap + pause/resume.

Covers:
- ``_count_tool_bearing_turns`` / ``build_partial_builder_result`` helpers.
- ``BuilderArtifactMiddleware.before_model`` halts the builder at the cap
  and emits a partial ``builder_result`` with the right shape.
- ``BuilderTaskMiddleware`` renders a ``<resume_from>`` block when
  ``delegation_context["resume_context"]`` is populated.
- ``switch_to_builder._build_resume_context_from_previous_task`` reads the
  prior subagent result and projects it into a resume context.
- ``switch_to_builder._build_partial_pause_command`` returns a ToolMessage
  that names the continuation_task_id and asks the user to continue.
- ``SwitchToBuilderInput`` accepts ``resume_from_task_id``.
"""

from __future__ import annotations

import importlib
from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, HumanMessage

from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba
from deerflow.agents.sophia_agent.middlewares import builder_task as bt

switch_to_builder_module = importlib.import_module(
    "deerflow.sophia.tools.switch_to_builder"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ai_with_tool_call(name: str, args: dict | None = None, *, msg_id: str | None = None) -> AIMessage:
    """Build an AIMessage whose ``tool_calls`` field carries a single call."""
    tool_call = {
        "id": msg_id or f"tool_{name}",
        "name": name,
        "args": args or {},
        "type": "tool_call",
    }
    msg = AIMessage(content="", tool_calls=[tool_call])
    if msg_id:
        msg.id = msg_id
    return msg


def _ai_plain(text: str) -> AIMessage:
    return AIMessage(content=text)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


class TestRecursionHeadroom:
    def test_hard_turn_cap_has_headroom_below_recursion_limit(self):
        """The recursion_limit must be high enough that the partial pause
        can fire before LangGraph's own recursion guard aborts the run.

        Each builder tool turn costs ~2 LangGraph super-steps, so we
        require at least ``2 * HARD_TURN_CAP`` steps, plus a small
        headroom for the final emit_builder_artifact turn.
        """
        # Access via import to avoid circular test-time behaviour.
        import importlib

        builder_agent_mod = importlib.import_module(
            "deerflow.agents.sophia_agent.builder_agent"
        )
        switch_mod = importlib.import_module(
            "deerflow.sophia.tools.switch_to_builder"
        )

        # Inspect the source so we don't need to actually instantiate the
        # builder (which requires Anthropic credentials).
        builder_src = importlib.import_module(
            "deerflow.agents.sophia_agent.builder_agent"
        )
        src_text = builder_agent_mod.__loader__.get_source(builder_agent_mod.__name__)
        assert "agent.recursion_limit = 120" in src_text, (
            "builder_agent recursion_limit must provide headroom above HARD_TURN_CAP"
        )
        assert builder_src is not None  # keep import used

        # The per-delegation config also caps recursion; it must mirror the
        # agent setting.
        switch_src = switch_mod.__loader__.get_source(switch_mod.__name__)
        assert "max_turns=120" in switch_src

        required_min = 2 * ba.HARD_TURN_CAP
        assert 120 >= required_min + 5, (
            f"recursion_limit=120 must leave headroom over 2 * HARD_TURN_CAP={required_min}"
        )


class TestCountToolBearingTurns:
    def test_counts_only_ai_messages_with_tool_calls(self):
        messages = [
            HumanMessage("hello"),
            _ai_with_tool_call("bash"),
            _ai_plain("just text, not a turn"),
            _ai_with_tool_call("write_file"),
            HumanMessage("another user message"),
            _ai_with_tool_call("present_files"),
        ]
        assert ba._count_tool_bearing_turns(messages) == 3

    def test_handles_empty_list(self):
        assert ba._count_tool_bearing_turns([]) == 0


class TestCollectPresentedFiles:
    def test_returns_unique_filepaths_in_order(self):
        messages = [
            _ai_with_tool_call("write_file", {"filepath": "ignored.md"}),
            _ai_with_tool_call(
                "present_files",
                {"filepaths": ["outputs/a.md", "outputs/b.md"]},
            ),
            _ai_with_tool_call(
                "present_files",
                {"filepaths": ["outputs/b.md", "outputs/c.md"]},
            ),
        ]
        assert ba._collect_presented_files(messages) == [
            "outputs/a.md",
            "outputs/b.md",
            "outputs/c.md",
        ]


class TestBuildPartialBuilderResult:
    def test_shape_matches_contract(self):
        messages = [
            HumanMessage("Write a report on X"),
            _ai_with_tool_call("write_file", {"filepath": "outputs/draft.md"}),
            _ai_with_tool_call(
                "present_files",
                {"filepaths": ["outputs/draft.md", "outputs/appendix.md"]},
            ),
            _ai_plain("I have drafted the report but ran out of turns."),
        ]

        partial = ba.build_partial_builder_result(
            messages=messages, turn_cap=40
        )

        assert partial["status"] == "partial"
        assert partial["artifact_title"] == "Partial draft (paused at turn cap)"
        assert partial["artifact_path"] == "outputs/draft.md"
        assert partial["supporting_files"] == ["outputs/appendix.md"]
        assert partial["completed_files"] == [
            "outputs/draft.md",
            "outputs/appendix.md",
        ]
        assert partial["turn_cap"] == 40
        assert partial["turns_used"] == 2  # only tool-bearing turns
        assert partial["confidence"] == 0.5
        # continuation_task_id must be generated and non-empty for resume.
        assert isinstance(partial["continuation_task_id"], str)
        assert partial["continuation_task_id"]
        # Summary uses the most recent AI text when available.
        assert "I have drafted the report" in partial["summary_of_done"]

    def test_empty_messages_still_produces_valid_partial(self):
        partial = ba.build_partial_builder_result(messages=[], turn_cap=10)

        assert partial["status"] == "partial"
        assert partial["artifact_path"] is None
        assert partial["supporting_files"] is None
        assert partial["completed_files"] == []
        assert partial["turns_used"] == 0
        assert partial["turn_cap"] == 10
        assert partial["continuation_task_id"]

    def test_respects_explicit_continuation_task_id(self):
        partial = ba.build_partial_builder_result(
            messages=[],
            turn_cap=5,
            continuation_task_id="cont-xyz",
        )
        assert partial["continuation_task_id"] == "cont-xyz"


# ---------------------------------------------------------------------------
# BuilderArtifactMiddleware.before_model
# ---------------------------------------------------------------------------


class TestBuilderArtifactBeforeModelCap:
    def _runtime(self):
        runtime = MagicMock()
        runtime.context = {}
        return runtime

    def test_below_cap_returns_none(self):
        middleware = ba.BuilderArtifactMiddleware(turn_cap=3)
        messages = [_ai_with_tool_call("bash"), _ai_with_tool_call("bash")]
        state = {"messages": messages}

        assert middleware.before_model(state, self._runtime()) is None

    def test_builder_result_already_set_skips_even_when_over_cap(self):
        middleware = ba.BuilderArtifactMiddleware(turn_cap=2)
        messages = [
            _ai_with_tool_call("bash"),
            _ai_with_tool_call("bash"),
            _ai_with_tool_call("bash"),
        ]
        state = {
            "messages": messages,
            "builder_result": {"status": "completed"},
        }

        assert middleware.before_model(state, self._runtime()) is None

    def test_at_cap_jumps_to_end_with_partial(self):
        middleware = ba.BuilderArtifactMiddleware(turn_cap=2)
        messages = [
            _ai_with_tool_call("bash"),
            _ai_with_tool_call(
                "present_files", {"filepaths": ["outputs/draft.md"]}
            ),
            _ai_plain("Ran out of turns before final packaging."),
        ]
        state = {"messages": messages}

        result = middleware.before_model(state, self._runtime())

        assert result is not None
        assert result["jump_to"] == "end"

        builder_result = result["builder_result"]
        assert builder_result["status"] == "partial"
        assert builder_result["turn_cap"] == 2
        assert builder_result["turns_used"] == 2
        assert builder_result["artifact_path"] == "outputs/draft.md"
        assert builder_result["completed_files"] == ["outputs/draft.md"]
        assert builder_result["continuation_task_id"]

        # The messages update must only contain plain AIMessages so we
        # never leave tool_calls dangling after the jump.
        new_messages = result["messages"]
        assert len(new_messages) == 1
        assert isinstance(new_messages[0], AIMessage)
        assert not getattr(new_messages[0], "tool_calls", None)
        assert "turn cap" in new_messages[0].content.lower()

    def test_at_cap_reuses_delegation_task_id_as_continuation(self):
        """The middleware must thread the outer subagent task_id into the
        partial result so the resume path can look it up in
        ``_retained_background_tasks``. This is the regression guard for
        the original PR G Codex P1 finding.
        """
        middleware = ba.BuilderArtifactMiddleware(turn_cap=1)
        messages = [
            _ai_with_tool_call("bash"),
            _ai_plain("paused"),
        ]
        state = {
            "messages": messages,
            "delegation_context": {
                "task_id": "toolu_original_123",
                "task": "demo",
                "task_type": "document",
            },
        }

        result = middleware.before_model(state, self._runtime())

        assert result is not None
        assert result["builder_result"]["continuation_task_id"] == "toolu_original_123"
        # The surfaced AIMessage also names the continuation id so anything
        # inspecting the message channel can still see it.
        assert "toolu_original_123" in result["messages"][0].content

    def test_at_cap_falls_back_to_uuid_when_no_delegation_task_id(self):
        middleware = ba.BuilderArtifactMiddleware(turn_cap=1)
        messages = [_ai_with_tool_call("bash"), _ai_plain("paused")]

        # No delegation_context in state — e.g. a direct test invocation.
        result = middleware.before_model({"messages": messages}, self._runtime())

        assert result is not None
        continuation = result["builder_result"]["continuation_task_id"]
        assert isinstance(continuation, str) and continuation
        # Should not happen to match our canonical sentinel.
        assert continuation != "toolu_original_123"

    def test_at_cap_ignores_empty_delegation_task_id(self):
        middleware = ba.BuilderArtifactMiddleware(turn_cap=1)
        messages = [_ai_with_tool_call("bash"), _ai_plain("paused")]
        state = {
            "messages": messages,
            "delegation_context": {"task_id": "   "},  # whitespace-only
        }

        result = middleware.before_model(state, self._runtime())

        assert result is not None
        continuation = result["builder_result"]["continuation_task_id"]
        assert isinstance(continuation, str) and continuation
        # Whitespace id must not leak through; fallback uuid must be used.
        assert continuation.strip() == continuation


# ---------------------------------------------------------------------------
# BuilderTaskMiddleware resume_from rendering
# ---------------------------------------------------------------------------


class TestBuilderTaskResumeFromRender:
    def _runtime(self):
        runtime = MagicMock()
        runtime.context = {}
        return runtime

    def test_resume_from_block_rendered_before_tone(self):
        middleware = bt.BuilderTaskMiddleware()
        state = {
            "delegation_context": {
                "task": "Continue the report",
                "task_type": "document",
                "companion_artifact": {
                    "tone_estimate": 2.5,
                    "active_tone_band": "engagement",
                },
                "resume_context": {
                    "previous_task_id": "prev-123",
                    "previous_status": "partial",
                    "completed_files": ["outputs/a.md", "outputs/b.md"],
                    "summary_of_done": "Drafted sections 1 and 2.",
                    "turns_used": 40,
                    "turn_cap": 40,
                },
            },
            "system_prompt_blocks": [],
        }

        update = middleware.before_agent(state, self._runtime())
        assert update is not None
        briefing = update["system_prompt_blocks"][-1]
        assert "<resume_from>" in briefing
        assert "outputs/a.md" in briefing
        assert "outputs/b.md" in briefing
        assert "prev-123" in briefing
        assert "40/40" in briefing
        assert "Drafted sections 1 and 2" in briefing
        # resume_from must appear before tone_guidance so the builder reads
        # it first.
        assert briefing.index("<resume_from>") < briefing.index("<tone_guidance>")

    def test_no_resume_context_omits_block(self):
        middleware = bt.BuilderTaskMiddleware()
        state = {
            "delegation_context": {
                "task": "New build",
                "task_type": "document",
                "companion_artifact": {"tone_estimate": 2.5},
            },
            "system_prompt_blocks": [],
        }

        update = middleware.before_agent(state, self._runtime())
        assert update is not None
        briefing = update["system_prompt_blocks"][-1]
        assert "<resume_from>" not in briefing

    def test_empty_resume_context_omits_block(self):
        middleware = bt.BuilderTaskMiddleware()
        # Neither completed_files nor summary_of_done -> block skipped.
        state = {
            "delegation_context": {
                "task": "New build",
                "task_type": "document",
                "companion_artifact": {"tone_estimate": 2.5},
                "resume_context": {
                    "previous_task_id": "prev-123",
                    "previous_status": "partial",
                },
            },
            "system_prompt_blocks": [],
        }

        update = middleware.before_agent(state, self._runtime())
        assert update is not None
        briefing = update["system_prompt_blocks"][-1]
        assert "<resume_from>" not in briefing


# ---------------------------------------------------------------------------
# switch_to_builder resume plumbing
# ---------------------------------------------------------------------------


class TestSwitchToBuilderResume:
    def test_resume_context_reads_prior_builder_result(self, monkeypatch):
        prev = SimpleNamespace(
            final_state={
                "builder_result": {
                    "status": "partial",
                    "continuation_task_id": "cont-abc",
                    "completed_files": ["outputs/a.md", "outputs/b.md"],
                    "summary_of_done": "Sections 1-2 drafted.",
                    "turns_used": 40,
                    "turn_cap": 40,
                    "artifact_path": "outputs/a.md",
                }
            }
        )
        monkeypatch.setattr(
            switch_to_builder_module,
            "get_background_task_result",
            lambda task_id: prev if task_id == "prev-123" else None,
        )

        context = switch_to_builder_module._build_resume_context_from_previous_task(
            "prev-123"
        )
        assert context is not None
        assert context["previous_task_id"] == "prev-123"
        assert context["previous_status"] == "partial"
        assert context["previous_continuation_task_id"] == "cont-abc"
        assert context["completed_files"] == ["outputs/a.md", "outputs/b.md"]
        assert context["summary_of_done"] == "Sections 1-2 drafted."
        assert context["turns_used"] == 40
        assert context["turn_cap"] == 40
        assert context["previous_artifact_path"] == "outputs/a.md"

    def test_resume_context_handles_missing_completed_files(self, monkeypatch):
        prev = SimpleNamespace(
            final_state={
                "builder_result": {
                    "status": "failed_retryable",
                    "artifact_path": "outputs/draft.md",
                    "supporting_files": ["outputs/notes.md"],
                    "summary_of_done": "Drafted main body.",
                }
            }
        )
        monkeypatch.setattr(
            switch_to_builder_module,
            "get_background_task_result",
            lambda task_id: prev,
        )

        context = switch_to_builder_module._build_resume_context_from_previous_task(
            "prev-x"
        )
        assert context is not None
        # Both artifact_path and supporting_files should be projected in.
        assert context["completed_files"] == [
            "outputs/draft.md",
            "outputs/notes.md",
        ]

    def test_resume_context_returns_none_when_task_missing(self, monkeypatch):
        monkeypatch.setattr(
            switch_to_builder_module,
            "get_background_task_result",
            lambda task_id: None,
        )
        assert (
            switch_to_builder_module._build_resume_context_from_previous_task(
                "nope"
            )
            is None
        )

    def test_resume_context_returns_none_when_nothing_recoverable(self, monkeypatch):
        prev = SimpleNamespace(final_state={"builder_result": {"status": "failed_terminal"}})
        monkeypatch.setattr(
            switch_to_builder_module,
            "get_background_task_result",
            lambda task_id: prev,
        )
        assert (
            switch_to_builder_module._build_resume_context_from_previous_task(
                "empty"
            )
            is None
        )


class TestSwitchToBuilderInputResumeField:
    def test_resume_from_task_id_defaults_to_none(self):
        payload = switch_to_builder_module.SwitchToBuilderInput(
            task="Draft a doc",
            task_type="document",
        )
        assert payload.resume_from_task_id is None

    def test_resume_from_task_id_accepts_string(self):
        payload = switch_to_builder_module.SwitchToBuilderInput(
            task="Draft a doc",
            task_type="document",
            resume_from_task_id="cont-abc",
        )
        assert payload.resume_from_task_id == "cont-abc"


# ---------------------------------------------------------------------------
# Task-type-aware skills injection (Commit 4)
# ---------------------------------------------------------------------------


class TestTaskTypeSkillInjection:
    def _runtime(self):
        runtime = MagicMock()
        runtime.context = {}
        return runtime

    def _middleware(self, tmp_path, mapping):
        # Build a fake skills_root containing SKILL.md files keyed by the
        # provided mapping so the middleware has something to read.
        for skills in mapping.values():
            for skill_name in skills:
                skill_dir = tmp_path / skill_name
                skill_dir.mkdir(parents=True, exist_ok=True)
                (skill_dir / "SKILL.md").write_text(
                    f"# {skill_name}\nContent for {skill_name}\n",
                    encoding="utf-8",
                )
        return bt.BuilderTaskMiddleware(
            skills_root=tmp_path,
            task_type_skills=mapping,
        )

    def test_visual_report_loads_chart_and_data_skills(self, tmp_path):
        middleware = self._middleware(
            tmp_path,
            {"visual_report": ["chart-visualization", "data-analysis"]},
        )
        state = {
            "delegation_context": {
                "task": "Build a report",
                "task_type": "visual_report",
                "companion_artifact": {"tone_estimate": 2.5},
            },
            "system_prompt_blocks": [],
        }

        update = middleware.before_agent(state, self._runtime())
        assert update is not None
        blocks = update["system_prompt_blocks"]

        skill_blocks = [b for b in blocks if b.startswith("<builder_skill")]
        assert len(skill_blocks) == 2
        joined = "\n".join(skill_blocks)
        assert 'name="chart-visualization"' in joined
        assert 'name="data-analysis"' in joined
        assert "Content for chart-visualization" in joined
        assert "Content for data-analysis" in joined

        # Briefing block is appended AFTER the skill blocks so the briefing
        # can reference them without the model scrolling.
        briefing_indices = [
            i for i, block in enumerate(blocks) if block.startswith("<builder_briefing>")
        ]
        skill_indices = [
            i for i, block in enumerate(blocks) if block.startswith("<builder_skill")
        ]
        assert briefing_indices and skill_indices
        assert max(skill_indices) < briefing_indices[0]

    def test_document_task_loads_no_extra_skills(self, tmp_path):
        middleware = self._middleware(
            tmp_path,
            {"document": [], "visual_report": ["chart-visualization"]},
        )
        state = {
            "delegation_context": {
                "task": "Write a plain doc",
                "task_type": "document",
                "companion_artifact": {"tone_estimate": 2.5},
            },
            "system_prompt_blocks": [],
        }

        update = middleware.before_agent(state, self._runtime())
        assert update is not None
        blocks = update["system_prompt_blocks"]
        assert not any(b.startswith("<builder_skill") for b in blocks)

    def test_missing_skill_file_is_skipped_not_fatal(self, tmp_path):
        # Map to a skill that does NOT exist on disk; middleware must not
        # raise and must still render the briefing.
        middleware = bt.BuilderTaskMiddleware(
            skills_root=tmp_path,
            task_type_skills={"frontend": ["nonexistent-skill"]},
        )
        state = {
            "delegation_context": {
                "task": "Build a page",
                "task_type": "frontend",
                "companion_artifact": {"tone_estimate": 2.5},
            },
            "system_prompt_blocks": [],
        }

        update = middleware.before_agent(state, self._runtime())
        assert update is not None
        blocks = update["system_prompt_blocks"]
        assert not any(b.startswith("<builder_skill") for b in blocks)
        assert any(b.startswith("<builder_briefing>") for b in blocks)

    def test_default_task_type_skills_mapping_is_complete(self):
        # Guardrail: the shipping mapping must name every task_type the
        # companion can send except `document` (intentionally empty). If the
        # Literal is extended, this test reminds you to update the mapping.
        expected = {"document", "presentation", "research", "visual_report", "frontend"}
        assert expected.issubset(bt.TASK_TYPE_SKILLS.keys())
        # document is explicitly an empty list, not missing.
        assert bt.TASK_TYPE_SKILLS["document"] == []


class TestBuildPartialPauseCommand:
    def test_message_names_continuation_id_and_asks_to_continue(self):
        builder_result = {
            "status": "partial",
            "continuation_task_id": "cont-abc",
            "completed_files": ["outputs/a.md", "outputs/b.md"],
            "summary_of_done": "Drafted the first two sections.",
            "turns_used": 40,
            "turn_cap": 40,
        }
        command = switch_to_builder_module._build_partial_pause_command(
            task="Write a report",
            task_type="document",
            task_id="toolu_orig",
            thread_id="thread-xyz",
            builder_result=builder_result,
            builder_delivery=None,
            tool_call_id="toolu_orig",
        )

        message = command.update["messages"][0]
        content = message.content
        assert "cont-abc" in content
        # The companion must be told to ask the user about continuing.
        assert "continue" in content.lower()
        assert "40/40" in content
        # The builder_task entry is tagged with the partial status and id.
        bt_entry = command.update["builder_task"]
        assert bt_entry["status"] == "partial"
        assert bt_entry["continuation_task_id"] == "cont-abc"
