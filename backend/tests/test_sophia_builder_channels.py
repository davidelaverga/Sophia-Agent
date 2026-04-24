"""Runtime channel-level guards for the Sophia builder graph.

The type-hint guards in ``tests/test_sophia_state_schema_invariants.py`` catch
shadowed field redeclarations on individual middleware state schemas. This
test closes the loop by building the real builder graph (via
``_create_builder_agent``) and asserting the compiled ``builder_web_budget``
/ ``builder_allowed_urls`` / ``builder_search_sources`` channels are
``BinaryOperatorAggregate`` (i.e. reducer-backed) rather than ``LastValue``.

Historically the failure mode was that the schema looked correct on paper
(``SophiaState`` carried ``Annotated[..., reducer]``) but
``langchain.agents.create_agent`` merged middleware state schemas through a
``set`` iteration whose order depends on ``type.__hash__``. If a middleware
state redeclared the same field as a plain ``NotRequired[...]``, it could
silently overwrite the reducer annotation, leaving the compiled channel as
a ``LastValue``. This test reproduces the compile-time merge and catches a
regression at the same layer production runs hit.
"""

from __future__ import annotations

import importlib

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langgraph.channels.binop import BinaryOperatorAggregate

from deerflow.agents.sophia_agent.state import (
    _merge_builder_web_budget,
    _merge_search_sources,
    _union_string_list,
)

_REDUCER_GATED_FIELDS = (
    ("builder_web_budget", _merge_builder_web_budget, BinaryOperatorAggregate),
    ("builder_allowed_urls", _union_string_list, BinaryOperatorAggregate),
    ("builder_search_sources", _merge_search_sources, BinaryOperatorAggregate),
)


@pytest.fixture
def _fake_builder(monkeypatch):
    """Build the real Sophia builder graph with every external dependency
    stubbed out so the test only observes the graph's compiled channel map.

    The fake chat model raises ``NotImplementedError`` from ``bind_tools`` —
    ``create_agent`` only calls ``bind_tools`` at run time, not during graph
    construction, so that is fine here. We never invoke the graph.
    """
    builder_module = importlib.import_module(
        "deerflow.agents.sophia_agent.builder_agent"
    )

    fake_model_factory = lambda **_kwargs: FakeMessagesListChatModel(  # noqa: E731
        responses=[AIMessage(content="noop")]
    )
    monkeypatch.setattr(builder_module, "ChatAnthropic", fake_model_factory)

    return builder_module._create_builder_agent(
        user_id="schema_invariants_user",
        model_name="claude-sonnet-4-6",
    )


@pytest.mark.parametrize(
    ("field_name", "reducer", "expected_channel_type"),
    _REDUCER_GATED_FIELDS,
)
def test_builder_graph_channel_is_reducer_backed(
    _fake_builder, field_name, reducer, expected_channel_type
):
    """The compiled builder graph must expose reducer-backed channels for
    every field written by parallel ``builder_web_*`` tool calls.

    If any of these channels is a ``LastValue``, parallel
    ``builder_web_search`` / ``builder_web_fetch`` tool calls in one AI
    message crash the run with ``INVALID_CONCURRENT_GRAPH_UPDATE``. This
    assertion reproduces the full ``langchain.agents.create_agent`` schema
    merge at test time, so a shadowed redeclaration in any middleware state
    is caught before it reaches production.
    """
    channels = _fake_builder.builder.channels
    channel = channels.get(field_name)
    assert channel is not None, (
        f"Builder graph missing channel `{field_name}`; the SophiaState "
        "declaration was likely dropped during a schema change."
    )
    assert isinstance(channel, expected_channel_type), (
        f"Builder graph channel `{field_name}` is "
        f"{type(channel).__name__}, expected {expected_channel_type.__name__}. "
        "Most likely a middleware state_schema redeclared this field without "
        "its reducer and the non-deterministic `create_agent` schema merge "
        "picked that plain declaration. Run "
        "``pytest tests/test_sophia_state_schema_invariants.py`` for the "
        "type-hint-level diagnostic."
    )
    assert channel.operator is reducer, (
        f"Builder graph channel `{field_name}` is reducer-backed but uses "
        f"the wrong operator: got {channel.operator!r}, expected {reducer!r}. "
        "Check that SophiaState still uses the reducer defined in "
        "``deerflow.agents.sophia_agent.state``."
    )
