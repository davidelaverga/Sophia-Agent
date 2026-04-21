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

The second batch of tests guards the same class of bug for SophiaState
fields written by parallel builder tool calls (``builder_web_budget``,
``builder_allowed_urls``, ``builder_search_sources``). Without reducers
those fields would 500 on any builder turn where the model emits more than
one ``builder_web_search`` / ``builder_web_fetch`` in a single AI message.
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
from deerflow.agents.sophia_agent.state import (
    SophiaState,
    _merge_builder_web_budget,
    _merge_search_sources,
    _union_string_list,
)

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


def _extract_reducers_from_annotation(annotation: object) -> list[object]:
    """Walk through ``NotRequired[...]`` / ``Annotated[...]`` wrappers and
    collect any callable metadata. The schema guard below accepts the reducer
    at any depth so callers can freely choose between
    ``NotRequired[Annotated[T, reducer]]`` and ``Annotated[NotRequired[T], reducer]``
    without the test needing a matching shape.
    """
    reducers: list[object] = []
    queue: list[object] = [annotation]
    seen: set[int] = set()
    while queue:
        current = queue.pop(0)
        current_id = id(current)
        if current_id in seen:
            continue
        seen.add(current_id)
        metadata = getattr(current, "__metadata__", ())
        reducers.extend(item for item in metadata if callable(item))
        for arg in typing.get_args(current):
            if arg is not None and arg is not current:
                queue.append(arg)
    return reducers


@pytest.mark.parametrize(
    ("field_name", "expected_reducer"),
    [
        ("builder_web_budget", _merge_builder_web_budget),
        ("builder_allowed_urls", _union_string_list),
        ("builder_search_sources", _merge_search_sources),
    ],
)
def test_sophia_state_field_has_reducer(field_name, expected_reducer):
    """SophiaState fields written by parallel builder tool calls must carry a reducer.

    The guarded builder web tools (``builder_web_search``, ``builder_web_fetch``)
    all return ``Command(update={...})`` payloads that write these fields.
    When the builder model emits parallel tool calls, LangGraph applies
    both updates in the same super-step; without a reducer the LastValue
    channel rejects the concurrent write with
    ``INVALID_CONCURRENT_GRAPH_UPDATE``. This test ensures the reducers stay
    wired to the schema — a future merge cannot silently drop them.
    """
    hints = typing.get_type_hints(SophiaState, include_extras=True)
    annotation = hints.get(field_name)
    assert annotation is not None, (
        f"SophiaState is missing the `{field_name}` field; the schema guard "
        "cannot run without it."
    )
    reducers = _extract_reducers_from_annotation(annotation)
    assert expected_reducer in reducers, (
        f"SophiaState.{field_name} lost its reducer; parallel builder tool "
        "calls will crash with INVALID_CONCURRENT_GRAPH_UPDATE. Restore the "
        "`Annotated[..., reducer]` annotation (see state.py)."
    )


# ---------------------------------------------------------------------------
# Direct unit tests for the reducer helpers (exercise associativity + edge
# cases that the schema guard above does not cover).
# ---------------------------------------------------------------------------


def test_merge_builder_web_budget_takes_max_of_counters_and_last_wins_for_limits():
    current = {"search_calls": 5, "search_limit": 10, "fetch_calls": 2}
    update = {"search_calls": 6, "search_limit": 10, "fetch_calls": 3}
    merged = _merge_builder_web_budget(current, update)
    # Counter keys take max per-key (safe undercount on parallel bursts).
    assert merged["search_calls"] == 6
    assert merged["fetch_calls"] == 3
    # Limit keys are static config — last-wins is fine.
    assert merged["search_limit"] == 10


def test_merge_builder_web_budget_handles_none_inputs():
    assert _merge_builder_web_budget(None, None) == {}
    assert _merge_builder_web_budget(None, {"search_calls": 1}) == {"search_calls": 1}
    assert _merge_builder_web_budget({"fetch_calls": 2}, None) == {"fetch_calls": 2}


def test_merge_builder_web_budget_is_associative():
    # LangGraph applies concurrent updates sequentially via reducer(a, b)
    # then reducer(result, c); associativity keeps counters stable regardless
    # of dispatch order.
    base = {"search_calls": 5}
    update_a = {"search_calls": 6}
    update_b = {"search_calls": 6}
    left = _merge_builder_web_budget(_merge_builder_web_budget(base, update_a), update_b)
    right = _merge_builder_web_budget(base, _merge_builder_web_budget(update_a, update_b))
    assert left == right == {"search_calls": 6}


def test_union_string_list_preserves_order_and_dedups():
    assert _union_string_list(["a", "b"], ["b", "c"]) == ["a", "b", "c"]
    assert _union_string_list(None, ["a"]) == ["a"]
    assert _union_string_list(["a"], None) == ["a"]
    assert _union_string_list(None, None) == []
    # Non-string entries are filtered out defensively.
    assert _union_string_list(["a", 123], ["b", None]) == ["a", "b"]


def test_merge_search_sources_keys_off_url_and_latest_wins_on_collision():
    current = [{"url": "https://a", "title": "old"}]
    update = [
        {"url": "https://a", "title": "new"},
        {"url": "https://b", "title": "second"},
    ]
    merged = _merge_search_sources(current, update)
    assert {s["url"]: s["title"] for s in merged} == {
        "https://a": "new",
        "https://b": "second",
    }
    # Empty / None / malformed inputs must not crash.
    assert _merge_search_sources(None, None) == []
    assert _merge_search_sources([{"url": ""}, "not-a-dict"], [{}]) == []
