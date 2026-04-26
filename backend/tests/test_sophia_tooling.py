"""Resilience tests for ``deerflow.agents.sophia_agent.tooling``.

The codex bot review on PR #81 caught that ``load_sophia_web_tools()``
unconditionally called ``get_app_config()``, which raises
``FileNotFoundError`` whenever ``config.yaml`` is not present in the
current or parent directory. That made ``make_sophia_agent`` unusable in
config-less contexts (test fixtures, fresh checkouts, embedded
deployments). The loader must fail open with ``[]`` instead.

These tests lock that contract so the regression cannot return: a
broken or missing config disables the native web tools but never blocks
agent construction. The companion still functions; it just delegates web
research to Builder via ``switch_to_builder`` as it did before B1.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from deerflow.agents.sophia_agent import tooling


@pytest.fixture
def silence_logger(caplog):
    """Capture the warning/info logs emitted by the loader so test output stays clean."""
    caplog.set_level("DEBUG", logger=tooling.logger.name)
    return caplog


def test_load_sophia_web_tools_returns_empty_when_config_yaml_missing(
    monkeypatch, silence_logger
):
    """The single regression captured by the codex bot review: when no
    ``config.yaml`` is present, ``get_app_config()`` raises
    ``FileNotFoundError``. The loader must catch it and return ``[]``
    instead of bubbling up and breaking ``make_sophia_agent``."""

    def _raise_no_config():
        raise FileNotFoundError(
            "`config.yaml` file not found at the current directory nor its parent directory"
        )

    monkeypatch.setattr(tooling, "get_app_config", _raise_no_config)

    result = tooling.load_sophia_web_tools()

    assert result == []
    assert any(
        "no config.yaml found" in record.message
        for record in silence_logger.records
        if record.levelname == "INFO"
    )


def test_load_sophia_web_tools_returns_empty_when_config_load_raises_unexpected(
    monkeypatch, silence_logger
):
    """For any non-FileNotFoundError exception from ``get_app_config()``
    (corrupt yaml, pydantic validation failure, etc.), the loader must
    still fail open. Loud WARNING — silent dropping would mask real bugs
    — but the agent still constructs."""

    def _raise_unexpected():
        raise RuntimeError("simulated config corruption")

    monkeypatch.setattr(tooling, "get_app_config", _raise_unexpected)

    result = tooling.load_sophia_web_tools()

    assert result == []
    assert any(
        "failed to load app config" in record.message
        for record in silence_logger.records
        if record.levelname == "WARNING"
    )


def test_load_sophia_web_tools_returns_empty_when_no_tools_block(monkeypatch):
    """A config that simply has no ``tools:`` block (``config.tools`` is
    ``None`` or missing). The loader must treat it as "no providers
    configured" rather than crashing trying to iterate ``None``."""
    monkeypatch.setattr(
        tooling, "get_app_config", lambda: SimpleNamespace(tools=None)
    )

    assert tooling.load_sophia_web_tools() == []


def test_load_sophia_web_tools_returns_empty_when_tools_block_is_empty(monkeypatch):
    """A ``tools: []`` block. Same as above — empty result, no crash."""
    monkeypatch.setattr(
        tooling, "get_app_config", lambda: SimpleNamespace(tools=[])
    )

    assert tooling.load_sophia_web_tools() == []


def test_load_sophia_web_tools_skips_tools_that_fail_to_resolve(
    monkeypatch, silence_logger
):
    """If one provider's ``use:`` path is broken (missing dependency,
    typo, …) the loader must keep going for the other providers instead
    of returning ``[]`` for everything. Per-tool isolation."""
    healthy_tool = MagicMock(spec=[])
    healthy_tool.name = "web_fetch"

    web_search_cfg = SimpleNamespace(
        name="web_search", use="deerflow.does.not.exist:missing_attr"
    )
    web_fetch_cfg = SimpleNamespace(
        name="web_fetch", use="deerflow.community.jina_ai.tools:web_fetch_tool"
    )

    def _resolver(path: str, base):
        if path.startswith("deerflow.does.not.exist"):
            raise ImportError(path)
        return healthy_tool

    monkeypatch.setattr(
        tooling,
        "get_app_config",
        lambda: SimpleNamespace(tools=[web_search_cfg, web_fetch_cfg]),
    )
    monkeypatch.setattr(tooling, "resolve_variable", _resolver)

    result = tooling.load_sophia_web_tools()

    assert result == [healthy_tool]
    assert any(
        "failed to resolve web_search" in record.message
        for record in silence_logger.records
        if record.levelname == "WARNING"
    )


def test_load_sophia_web_tools_ignores_unrelated_tool_configs(monkeypatch):
    """Only ``web_search`` and ``web_fetch`` providers are wired into the
    Sophia companion (per ``_SOPHIA_WEB_TOOL_NAMES``). Other tool configs
    in ``config.tools`` (DeerFlow's lead_agent uses many) must be
    quietly skipped — not loaded into Sophia's tool list."""
    web_search = MagicMock(spec=[])
    web_search.name = "web_search"

    monkeypatch.setattr(
        tooling,
        "get_app_config",
        lambda: SimpleNamespace(
            tools=[
                SimpleNamespace(name="web_search", use="anything"),
                SimpleNamespace(name="image_search", use="anything"),
                SimpleNamespace(name="firecrawl", use="anything"),
            ]
        ),
    )
    monkeypatch.setattr(tooling, "resolve_variable", lambda path, base: web_search)

    result = tooling.load_sophia_web_tools()

    # Only web_search loads; image_search and firecrawl are correctly ignored.
    assert result == [web_search]


def test_load_sophia_web_tools_dedups_duplicate_provider_entries(monkeypatch):
    """If ``config.tools`` lists ``web_search`` twice (e.g. a misconfigured
    yaml merge), only the first occurrence loads."""
    instance_a = MagicMock(spec=[])
    instance_a.name = "web_search"
    instance_b = MagicMock(spec=[])
    instance_b.name = "web_search"

    call_count = {"n": 0}

    def _resolver(path, base):
        call_count["n"] += 1
        return instance_a if call_count["n"] == 1 else instance_b

    monkeypatch.setattr(
        tooling,
        "get_app_config",
        lambda: SimpleNamespace(
            tools=[
                SimpleNamespace(name="web_search", use="path.a"),
                SimpleNamespace(name="web_search", use="path.b"),
            ]
        ),
    )
    monkeypatch.setattr(tooling, "resolve_variable", _resolver)

    result = tooling.load_sophia_web_tools()

    assert result == [instance_a], "second web_search entry must be ignored"
