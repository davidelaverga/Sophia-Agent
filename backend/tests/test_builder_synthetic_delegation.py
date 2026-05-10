"""Tests for BuilderTaskMiddleware's no-companion synthesis branch.

Stage-1 Phase-3: when Builder is invoked directly (no `delegation_context`
on input), `abefore_agent` runs a single Haiku classifier call and
synthesises a `delegation_context` matching the companion-side shape.

We mock `AsyncAnthropic` so these run offline and deterministically.
"""

from __future__ import annotations

import pytest

from deerflow.agents.sophia_agent.middlewares.builder_task import (
    _NORMALIZED_BRIEF_MAX_CHARS,
    _SYNTHETIC_DELEGATION_SOURCE,
    _VALID_BRIEF_TASK_TYPES,
    BuilderTaskMiddleware,
)

# ---------------------------------------------------------------------------
# Test fixtures: a fake Anthropic client returning structured tool-use blocks
# ---------------------------------------------------------------------------


class _FakeBlock:
    def __init__(self, block_type: str, name: str | None = None, input_=None):
        self.type = block_type
        self.name = name
        self.input = input_


class _FakeResponse:
    def __init__(self, blocks):
        self.content = blocks


class _FakeAnthropic:
    def __init__(self, blocks_or_exc):
        self._blocks_or_exc = blocks_or_exc
        self.messages = self  # so `.messages.create(...)` chain works

    async def create(self, **_kwargs):
        if isinstance(self._blocks_or_exc, Exception):
            raise self._blocks_or_exc
        return _FakeResponse(self._blocks_or_exc)


def _patch_anthropic(monkeypatch: pytest.MonkeyPatch, blocks_or_exc) -> None:
    """Monkey-patch the AsyncAnthropic class used inside `_classify_brief`."""

    class _Cls:
        def __init__(self, *_args, **_kwargs):
            self._inner = _FakeAnthropic(blocks_or_exc)

        @property
        def messages(self):
            return self._inner

    import anthropic

    monkeypatch.setattr(anthropic, "AsyncAnthropic", _Cls, raising=True)


# ---------------------------------------------------------------------------
# Synthesis branch
# ---------------------------------------------------------------------------


class TestSyntheticDelegation:
    @pytest.mark.anyio
    async def test_existing_delegation_context_bypasses_classifier(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Companion path: delegation_context is already populated. The
        # async hook should NOT call Haiku; it just delegates to sync render.
        called: dict = {"count": 0}

        async def fake_classify(self, _brief):
            called["count"] += 1
            return {"task_type": "other", "demo_mode": False, "normalized_brief": ""}

        monkeypatch.setattr(BuilderTaskMiddleware, "_classify_brief", fake_classify)

        mw = BuilderTaskMiddleware()
        state = {
            "messages": [{"type": "human", "content": "hi"}],
            "delegation_context": {
                "task_type": "research",
                "task_brief": "Research X",
                "companion_artifact": {"tone_estimate": 2.5},
            },
        }
        result = await mw.abefore_agent(state, runtime=None)
        assert called["count"] == 0  # classifier never invoked
        # before_agent returns a system_prompt_blocks update; ensure that
        # the sync render ran.
        assert isinstance(result, dict)
        assert "system_prompt_blocks" in result

    @pytest.mark.anyio
    async def test_missing_delegation_synthesises_via_haiku(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
        _patch_anthropic(
            monkeypatch,
            [
                _FakeBlock(
                    "tool_use",
                    name="classify_brief",
                    input_={
                        "task_type": "research",
                        "demo_mode": False,
                        "normalized_brief": "Compare AR glasses launching in 2026.",
                    },
                )
            ],
        )

        mw = BuilderTaskMiddleware()
        state = {
            "messages": [
                {"type": "human", "content": "compare the AR glasses launching in 2026"},
            ],
        }
        result = await mw.abefore_agent(state, runtime=None)

        assert isinstance(result, dict)
        delegation = result.get("delegation_context")
        assert isinstance(delegation, dict)
        assert delegation["task_type"] == "research"
        assert delegation["demo_mode"] is False
        assert delegation["normalized_brief"] == "Compare AR glasses launching in 2026."
        # D3 marker: parent_thread_id None ⇔ Builder-as-Main mode.
        assert delegation["parent_thread_id"] is None
        assert delegation["source"] == _SYNTHETIC_DELEGATION_SOURCE
        # Synced into state too so downstream middlewares see it.
        assert state["delegation_context"] is delegation
        # Sync render was called and added a briefing block.
        assert "system_prompt_blocks" in result
        assert any("<builder_briefing>" in b for b in result["system_prompt_blocks"])

    @pytest.mark.anyio
    async def test_demo_mode_classification(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
        _patch_anthropic(
            monkeypatch,
            [
                _FakeBlock(
                    "tool_use",
                    name="classify_brief",
                    input_={
                        "task_type": "other",
                        "demo_mode": True,
                        "normalized_brief": "User is testing the Builder.",
                    },
                )
            ],
        )
        mw = BuilderTaskMiddleware()
        state = {"messages": [{"type": "human", "content": "test"}]}
        result = await mw.abefore_agent(state, runtime=None)
        assert result["delegation_context"]["demo_mode"] is True


# ---------------------------------------------------------------------------
# Classifier fallback
# ---------------------------------------------------------------------------


class TestClassifierFallback:
    @pytest.mark.anyio
    async def test_no_api_key_falls_back_to_user_brief(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        mw = BuilderTaskMiddleware()
        out = await mw._classify_brief("research electric cars")
        assert out["task_type"] == "other"
        assert out["demo_mode"] is False
        assert out["normalized_brief"] == "research electric cars"

    @pytest.mark.anyio
    async def test_anthropic_call_failure_falls_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
        _patch_anthropic(monkeypatch, RuntimeError("API down"))
        mw = BuilderTaskMiddleware()
        out = await mw._classify_brief("write me a brief")
        assert out["task_type"] == "other"
        assert out["normalized_brief"] == "write me a brief"

    @pytest.mark.anyio
    async def test_no_tool_use_block_falls_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Anthropic returns text only — no tool_use block. Should fallback.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
        _patch_anthropic(monkeypatch, [_FakeBlock("text")])
        mw = BuilderTaskMiddleware()
        out = await mw._classify_brief("hello")
        assert out["task_type"] == "other"


class TestValidation:
    def test_invalid_task_type_normalised_to_other(self) -> None:
        out = BuilderTaskMiddleware._validate_classification(
            {"task_type": "invented_type", "demo_mode": False, "normalized_brief": "x"},
            "x",
        )
        assert out["task_type"] == "other"

    def test_each_valid_task_type_passes_through(self) -> None:
        for tt in _VALID_BRIEF_TASK_TYPES:
            out = BuilderTaskMiddleware._validate_classification(
                {"task_type": tt, "demo_mode": False, "normalized_brief": "y"}, "y",
            )
            assert out["task_type"] == tt

    def test_missing_normalized_brief_uses_user_brief(self) -> None:
        out = BuilderTaskMiddleware._validate_classification(
            {"task_type": "writing", "demo_mode": False, "normalized_brief": ""},
            "fallback brief",
        )
        assert out["normalized_brief"] == "fallback brief"

    def test_normalized_brief_truncated_to_max_chars(self) -> None:
        long_brief = "x" * (_NORMALIZED_BRIEF_MAX_CHARS + 100)
        out = BuilderTaskMiddleware._validate_classification(
            {"task_type": "other", "demo_mode": False, "normalized_brief": long_brief},
            "u",
        )
        assert len(out["normalized_brief"]) <= _NORMALIZED_BRIEF_MAX_CHARS

    def test_demo_mode_coerced_to_bool(self) -> None:
        out = BuilderTaskMiddleware._validate_classification(
            {"task_type": "other", "demo_mode": "truthy", "normalized_brief": "y"},
            "y",
        )
        assert out["demo_mode"] is True


class TestLastHumanTextExtraction:
    def test_extracts_dict_human(self) -> None:
        state = {"messages": [{"type": "human", "content": "hi"}]}
        assert BuilderTaskMiddleware._extract_last_human_text(state) == "hi"

    def test_skips_ai_messages(self) -> None:
        state = {
            "messages": [
                {"type": "human", "content": "first"},
                {"type": "ai", "content": "response"},
                {"type": "human", "content": "second"},
            ]
        }
        assert BuilderTaskMiddleware._extract_last_human_text(state) == "second"

    def test_handles_content_blocks_list(self) -> None:
        state = {
            "messages": [
                {"type": "human", "content": [{"type": "text", "text": "block "}, "trail"]},
            ]
        }
        assert BuilderTaskMiddleware._extract_last_human_text(state) == "block trail"

    def test_returns_none_on_empty_messages(self) -> None:
        assert BuilderTaskMiddleware._extract_last_human_text({"messages": []}) is None
