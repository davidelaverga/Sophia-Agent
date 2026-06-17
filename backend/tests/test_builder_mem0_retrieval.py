"""Tests for BuilderMem0RetrievalMiddleware.

Verifies the brief-scoped retrieval injects memories into both
`injected_memory_contents` and `system_prompt_blocks` (so PromptAssembly
sees them at the end of the chain) and degrades gracefully on
timeout / error / no-user-id.
"""

from __future__ import annotations

import pytest

from deerflow.agents.sophia_agent.middlewares.mem0_retrieval import (
    _BUILDER_SEARCH_POOL,
    _MAX_SNIPPET_CHARS,
    BuilderMem0RetrievalMiddleware,
)


def _patch_search(monkeypatch: pytest.MonkeyPatch, behaviour) -> dict:
    """Replace `search_memories` at its source module with a fake.

    Patches ``deerflow.sophia.mem0_client.search_memories`` (the
    definition site) rather than the middleware module — Phase A
    moved the import to lazy (inside ``_safe_search``) so there's no
    longer a module-level ``search_memories`` attribute on
    ``mem0_retrieval`` to monkeypatch.

    `behaviour` is either a list (returned synchronously) or a callable
    `(user_id, query, *_) -> list`. We capture call kwargs in a dict and
    return it for assertions.
    """
    captured: dict = {"calls": []}

    def fake(user_id, query, categories=None, context_mode=None, limit=10):
        captured["calls"].append(
            {
                "user_id": user_id,
                "query": query,
                "categories": categories,
                "context_mode": context_mode,
                "limit": limit,
            }
        )
        if callable(behaviour):
            return behaviour(user_id, query, categories, context_mode, limit)
        return behaviour

    monkeypatch.setattr(
        "deerflow.sophia.mem0_client.search_memories",
        fake,
    )
    return captured


class TestQueryResolution:
    def test_prefers_normalized_brief(self) -> None:
        state = {
            "delegation_context": {
                "normalized_brief": "norm",
                "task_brief": "task",
            },
            "messages": [{"type": "human", "content": "raw"}],
        }
        assert BuilderMem0RetrievalMiddleware._resolve_query(state) == "norm"

    def test_falls_back_to_task_brief(self) -> None:
        state = {
            "delegation_context": {"task_brief": "task"},
            "messages": [{"type": "human", "content": "raw"}],
        }
        assert BuilderMem0RetrievalMiddleware._resolve_query(state) == "task"

    def test_falls_back_to_last_human_message(self) -> None:
        state = {
            "delegation_context": None,
            "messages": [
                {"type": "human", "content": "first"},
                {"type": "ai", "content": "response"},
                {"type": "human", "content": "second"},
            ],
        }
        assert BuilderMem0RetrievalMiddleware._resolve_query(state) == "second"

    def test_returns_none_on_empty(self) -> None:
        assert BuilderMem0RetrievalMiddleware._resolve_query({}) is None


class TestUserIdResolution:
    def test_state_user_id_wins(self) -> None:
        class _R:
            context = {"user_id": "from-context"}
            config = {}

        state = {"user_id": "from-state"}
        assert BuilderMem0RetrievalMiddleware._resolve_user_id(state, _R()) == "from-state"

    def test_falls_back_to_runtime_context(self) -> None:
        class _R:
            context = {"user_id": "from-context"}
            config = {}

        assert BuilderMem0RetrievalMiddleware._resolve_user_id({}, _R()) == "from-context"

    def test_falls_back_to_runtime_configurable(self) -> None:
        class _R:
            context = {}
            config = {"configurable": {"user_id": "from-cfg"}}

        assert BuilderMem0RetrievalMiddleware._resolve_user_id({}, _R()) == "from-cfg"

    def test_returns_none_when_unresolvable(self) -> None:
        class _R:
            context = {}
            config = {}

        assert BuilderMem0RetrievalMiddleware._resolve_user_id({}, _R()) is None


class TestRetrievalAsync:
    @pytest.mark.anyio
    async def test_happy_path_injects_contents_and_block(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = _patch_search(
            monkeypatch,
            [
                {"id": "m1", "content": "User prefers concise summaries.", "category": "preference"},
                {"id": "m2", "content": "Works in San Francisco.", "category": "preference"},
            ],
        )

        mw = BuilderMem0RetrievalMiddleware()
        state = {
            "user_id": "user-abc",
            "delegation_context": {"normalized_brief": "Compare AR glasses."},
            "messages": [{"type": "human", "content": "Compare AR glasses."}],
        }
        result = await mw.abefore_agent(state, runtime=None)

        assert isinstance(result, dict)
        assert result["injected_memories"] == ["m1", "m2"]
        assert result["injected_memory_contents"] == [
            "User prefers concise summaries.",
            "Works in San Francisco.",
        ]
        # PromptAssembly reads system_prompt_blocks at the end of the chain.
        blocks = result["system_prompt_blocks"]
        assert len(blocks) == 1
        assert "<memory>" in blocks[0]
        assert "User prefers concise summaries." in blocks[0]

        # Ensure search was called with normalized_brief, not raw message.
        assert captured["calls"][0]["query"] == "Compare AR glasses."
        assert captured["calls"][0]["user_id"] == "user-abc"
        # Builder retrieval covers durable build-relevant categories (style
        # preferences + facts + relationships); prior task-history is removed by
        # the content filter, not by excluding whole categories. See
        # fix/builder-memory-contamination + codex review on PR #137.
        assert captured["calls"][0]["categories"] == ["preference", "fact", "relationship"]
        # Over-fetch a pool (Mem0 filters categories after the score-ranked
        # fetch) rather than asking for only top_k. See codex review on PR #137.
        assert captured["calls"][0]["limit"] == _BUILDER_SEARCH_POOL

    @pytest.mark.anyio
    async def test_overfetches_pool_then_trims_to_top_k(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Mem0 returns more preference rows than top_k; the middleware over-fetches
        # a larger pool (so the preference-only filter still has candidates when
        # task-history dominates the top rows) and then trims to top_k for the
        # injected-memory budget. See codex review on PR #137.
        rows = [{"id": f"m{i}", "content": f"pref {i}", "category": "preference"} for i in range(8)]
        captured = _patch_search(monkeypatch, rows)
        mw = BuilderMem0RetrievalMiddleware()  # top_k == 5
        state = {
            "user_id": "user-abc",
            "messages": [{"type": "human", "content": "build a deck about AR"}],
        }
        result = await mw.abefore_agent(state, runtime=None)

        assert captured["calls"][0]["limit"] == _BUILDER_SEARCH_POOL
        assert result["injected_memory_contents"] == [f"pref {i}" for i in range(5)]
        assert result["injected_memories"] == [f"m{i}" for i in range(5)]

    @pytest.mark.anyio
    async def test_task_history_filtered_by_content_durable_facts_kept(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Codex P2 (PR #137): builder retrieval covers durable build-relevant
        # categories (preference/fact/relationship) and filters task-history by
        # CONTENT, not by excluding whole categories — so a direct Builder-as-Main
        # run still sees durable facts ("daughter's name") for "make a card for my
        # daughter", while episodic build-request rows are dropped regardless of
        # the category they were written under (incl. a blank/mislabeled `fact`).
        captured = _patch_search(
            monkeypatch,
            [
                {"id": "m1", "content": "User requested creation of a deck about X", "category": ""},
                {"id": "m2", "content": "User asked Sophia to build a report on Y", "category": "fact"},
                {"id": "m3", "content": "Prefers concise summaries", "category": "preference"},
                {"id": "m4", "content": "Legacy row with no category key at all"},
                {"id": "m5", "content": "User's daughter is named Lucy", "category": "fact"},
                {"id": "m6", "content": "User's co-founder is Jorge", "category": "relationship"},
            ],
        )
        mw = BuilderMem0RetrievalMiddleware()
        state = {"user_id": "u", "messages": [{"type": "human", "content": "make a card for my daughter"}]}
        result = await mw.abefore_agent(state, runtime=None)

        # Durable fact + relationship + preference survive; the task-history rows
        # (blank-category build request, the mislabeled `fact` build request) and
        # the category-less legacy row are all dropped.
        assert result["injected_memory_contents"] == [
            "Prefers concise summaries",
            "User's daughter is named Lucy",
            "User's co-founder is Jorge",
        ]
        assert result["injected_memories"] == ["m3", "m5", "m6"]
        assert captured["calls"][0]["categories"] == ["preference", "fact", "relationship"]

    @pytest.mark.anyio
    async def test_no_user_id_skips(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = _patch_search(monkeypatch, [{"id": "m1", "content": "x"}])
        mw = BuilderMem0RetrievalMiddleware()
        state = {"messages": [{"type": "human", "content": "hi"}]}
        result = await mw.abefore_agent(state, runtime=None)
        assert result is None
        assert captured["calls"] == []

    @pytest.mark.anyio
    async def test_no_query_skips(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = _patch_search(monkeypatch, [])
        mw = BuilderMem0RetrievalMiddleware()
        state = {"user_id": "user-abc", "messages": []}
        result = await mw.abefore_agent(state, runtime=None)
        assert result is None
        assert captured["calls"] == []

    @pytest.mark.anyio
    async def test_empty_results_returns_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_search(monkeypatch, [])
        mw = BuilderMem0RetrievalMiddleware()
        state = {
            "user_id": "user-abc",
            "messages": [{"type": "human", "content": "hi"}],
        }
        assert await mw.abefore_agent(state, runtime=None) is None

    @pytest.mark.anyio
    async def test_timeout_swallowed_returns_none(
        self, monkeypatch: pytest.MonkeyPatch, caplog
    ) -> None:
        # Simulate a slow Mem0 call that exceeds the 0.05s timeout we set.
        import time as _time

        def slow(*_args, **_kwargs):
            _time.sleep(0.5)
            return [{"id": "m1", "content": "x"}]

        monkeypatch.setattr(
            "deerflow.sophia.mem0_client.search_memories",
            slow,
        )
        mw = BuilderMem0RetrievalMiddleware(timeout_seconds=0.1)
        state = {"user_id": "u", "messages": [{"type": "human", "content": "hi"}]}
        result = await mw.abefore_agent(state, runtime=None)
        assert result is None
        # State unchanged
        assert "system_prompt_blocks" not in state

    @pytest.mark.anyio
    async def test_search_error_swallowed_returns_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def boom(*_args, **_kwargs):
            raise RuntimeError("Mem0 down")

        monkeypatch.setattr(
            "deerflow.sophia.mem0_client.search_memories",
            boom,
        )
        mw = BuilderMem0RetrievalMiddleware()
        state = {"user_id": "u", "messages": [{"type": "human", "content": "hi"}]}
        result = await mw.abefore_agent(state, runtime=None)
        assert result is None

    @pytest.mark.anyio
    async def test_existing_contents_merged_and_deduplicated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Companion-path injects 5 snippets via start_builder_task; this
        # middleware adds its own. Overlap should be deduped, ordering
        # preserved (companion-side first).
        _patch_search(
            monkeypatch,
            [
                {"id": "m2", "content": "From Mem0", "category": "preference"},  # new
                {"id": "m1", "content": "Already injected", "category": "preference"},  # duplicate — should be deduped
            ],
        )
        mw = BuilderMem0RetrievalMiddleware()
        state = {
            "user_id": "u",
            "delegation_context": {"normalized_brief": "x"},
            "injected_memory_contents": ["Already injected"],
            "injected_memories": ["existing-id"],
            "messages": [{"type": "human", "content": "x"}],
        }
        result = await mw.abefore_agent(state, runtime=None)
        # "Already injected" stays first (companion order preserved); From Mem0 follows.
        assert result["injected_memory_contents"] == ["Already injected", "From Mem0"]
        # IDs merged: existing first, new appended (deduped)
        assert result["injected_memories"] == ["existing-id", "m2", "m1"]

    @pytest.mark.anyio
    async def test_long_snippet_truncated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        long_text = "x" * (_MAX_SNIPPET_CHARS + 100)
        _patch_search(monkeypatch, [{"id": "m1", "content": long_text, "category": "preference"}])
        mw = BuilderMem0RetrievalMiddleware()
        state = {
            "user_id": "u",
            "messages": [{"type": "human", "content": "y"}],
        }
        result = await mw.abefore_agent(state, runtime=None)
        snippet = result["injected_memory_contents"][0]
        assert len(snippet) <= _MAX_SNIPPET_CHARS
        assert snippet.endswith("…")


class TestSyncPath:
    def test_before_agent_returns_none(self) -> None:
        # Sync path is intentionally a no-op — Builder runs async in prod.
        mw = BuilderMem0RetrievalMiddleware()
        assert mw.before_agent({"user_id": "u"}, runtime=None) is None
