"""Dependency contract tests for Deep Agents (v0.6 migration — Phase 4).

The pin window is ``>=0.6.0,<0.7.0``. The 0.6 release adds typed event
projections (``stream.subagents``) that the new builder progress
subscriber consumes directly — see ``app/channels/telegram_progress_subscriber.py``
in the v3 migration PR.
"""

from __future__ import annotations

from importlib.metadata import version


def _version_tuple(package_version: str) -> tuple[int, int, int]:
    parts = package_version.split(".")
    return tuple(int(part) for part in parts[:3])


def test_deepagents_v06_async_subagent_api_available() -> None:
    """deepagents v0.6 still exposes AsyncSubAgent + create_deep_agent.

    The 0.5 → 0.6 transition kept these symbols stable. The new
    streaming surface (``stream.subagents``) is additive; the
    AsyncSubAgent / create_deep_agent API the rest of the codebase
    leans on stays compatible.
    """
    import deepagents
    from deepagents import AsyncSubAgent, create_deep_agent

    installed = _version_tuple(version("deepagents"))
    assert (0, 6, 0) <= installed < (0, 7, 0)
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
