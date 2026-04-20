"""Schema-level guards for Sophia middleware state classes.

Any middleware that extends ``AgentState`` must either inherit ``messages``
unchanged or redeclare it with the ``add_messages`` reducer. Declaring
``messages: NotRequired[list]`` (or similar without a reducer) silently
downgrades the LangGraph channel to ``LastValue`` and causes parallel tool
calls to crash with::

    langgraph.errors.InvalidUpdateError: At key 'messages': Can receive only
    one value per step. Use an Annotated key to handle multiple values.

These tests catch that regression at import time so a future middleware
cannot silently reintroduce the bug.
"""

from __future__ import annotations

import typing

import pytest
from langchain.agents import AgentState

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactState,
)
from deerflow.agents.sophia_agent.middlewares.session_state import SessionStateState
from deerflow.agents.sophia_agent.middlewares.turn_count import TurnCountState

_AGENT_STATE_MESSAGES = typing.get_type_hints(AgentState, include_extras=True)[
    "messages"
]


@pytest.mark.parametrize(
    "state_cls",
    [
        BuilderArtifactState,
        SessionStateState,
        TurnCountState,
    ],
    ids=lambda cls: cls.__name__,
)
def test_state_class_does_not_downgrade_messages_channel(state_cls):
    """Sophia middleware state classes must preserve the AgentState messages reducer."""
    hints = typing.get_type_hints(state_cls, include_extras=True)
    messages = hints.get("messages")
    assert messages is not None, (
        f"{state_cls.__name__} must inherit or redeclare the `messages` field"
    )
    assert messages == _AGENT_STATE_MESSAGES, (
        f"{state_cls.__name__} shadowed `messages` without the add_messages reducer; "
        "parallel tool calls will crash with InvalidUpdateError at runtime. "
        "Remove the override so AgentState's Annotated[list, add_messages] survives, "
        "or redeclare it explicitly with the same reducer."
    )
