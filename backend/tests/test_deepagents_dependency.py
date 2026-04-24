"""Dependency contract tests for Deep Agents v0.5 (PR-G, Phase 3.1)."""

from __future__ import annotations

from importlib.metadata import version


def _version_tuple(package_version: str) -> tuple[int, int, int]:
    parts = package_version.split(".")
    return tuple(int(part) for part in parts[:3])


def test_deepagents_v05_async_subagent_api_available() -> None:
    """PR-G: deepagents v0.5 exposes AsyncSubAgent for PR-H async builder wiring."""
    import deepagents
    from deepagents import AsyncSubAgent, create_deep_agent

    installed = _version_tuple(version("deepagents"))
    assert (0, 5, 0) <= installed < (0, 6, 0)
    assert deepagents.AsyncSubAgent is AsyncSubAgent
    assert callable(create_deep_agent)

    spec = AsyncSubAgent(
        name="sophia_builder",
        description="Runs long builder tasks in the background.",
        graph_id="sophia_builder",
    )
    assert spec == {
        "name": "sophia_builder",
        "description": "Runs long builder tasks in the background.",
        "graph_id": "sophia_builder",
    }
