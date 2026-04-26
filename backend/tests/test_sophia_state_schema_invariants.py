"""Schema-level guards for Sophia middleware state classes.

Any middleware that extends ``AgentState`` must either inherit ``messages``
unchanged or redeclare it with the ``add_messages`` reducer. Declaring
``messages: NotRequired[list]`` (or any plain ``list`` annotation) silently
downgrades the LangGraph channel to ``LastValue`` via
``langchain.agents.create_agent``'s set-based schema merge, which causes:

1. Every tool-message write to REPLACE the conversation history instead of
   appending to it. The result is that ``runs.wait`` returns a ``messages``
   list containing only the last write — typically the final ``ToolMessage``
   from ``emit_artifact`` — and the AI text response is wiped. The IM
   channel manager extraction sees no AI text and falls back to
   "(No response from agent)" even though the run succeeded. This is the
   regression the schema guard below was added to prevent re-introducing.

2. Parallel tool calls (e.g. two ``web_search`` entries in one AI message,
   or ``emit_artifact`` + ``switch_to_builder`` in the same turn) crash
   with::

       langgraph.errors.InvalidUpdateError: At key 'messages': Can receive
       only one value per step. Use an Annotated key to handle multiple
       values.

The guard runs against every ``AgentState`` subclass discovered under
``deerflow.agents.sophia_agent.middlewares`` so a newly added middleware
picks up the regression test for free.

The second batch of guards (``test_sophia_state_field_has_reducer`` and
``test_middleware_state_does_not_shadow_reducer_gated_builder_fields``)
covers the same class of bug for ``SophiaState`` fields written by parallel
builder tool calls (``builder_web_budget``, ``builder_allowed_urls``,
``builder_search_sources``). Without reducers these fields would 500 on any
builder turn where the model emits more than one ``builder_web_search`` /
``builder_web_fetch`` in a single AI message.
"""

from __future__ import annotations

import importlib
import inspect
import pkgutil
import typing

import pytest
from langchain.agents import AgentState

from deerflow.agents.sophia_agent import middlewares as _middlewares_pkg
from deerflow.agents.sophia_agent.state import (
    SophiaState,
    _merge_builder_web_budget,
    _merge_search_sources,
    _union_string_list,
)

_AGENT_STATE_MESSAGES = typing.get_type_hints(AgentState, include_extras=True)[
    "messages"
]


def _transitively_extends_agent_state(cls: type) -> bool:
    """Return ``True`` when ``cls`` is (possibly transitively) a subclass of
    ``AgentState``. ``AgentState`` is a ``TypedDict`` which means it does
    **not** appear in ``__mro__`` or ``__bases__`` — only in
    ``__orig_bases__``. Walk the origin bases chain so the guard picks up
    future middleware states that choose to subclass another AgentState
    extension rather than AgentState directly.
    """
    queue: list[type] = list(getattr(cls, "__orig_bases__", ()))
    seen: set[int] = set()
    while queue:
        base = queue.pop()
        base_id = id(base)
        if base_id in seen:
            continue
        seen.add(base_id)
        if base is AgentState:
            return True
        queue.extend(getattr(base, "__orig_bases__", ()))
    return False


def _discover_middleware_state_classes() -> list[type]:
    """Import every Sophia middleware submodule and return the classes that
    extend ``AgentState`` (directly or transitively via ``__orig_bases__``).

    Auto-discovery is what makes this suite load-bearing: a newly added
    middleware cannot silently ship a schema that shadows the reducer-gated
    ``messages`` field because its state class is picked up here
    automatically.
    """
    discovered: dict[str, type] = {}
    for module_info in pkgutil.iter_modules(_middlewares_pkg.__path__):
        if module_info.ispkg or module_info.name.startswith("_"):
            continue
        module = importlib.import_module(
            f"{_middlewares_pkg.__name__}.{module_info.name}"
        )
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if obj is AgentState:
                continue
            if obj.__module__ != module.__name__:
                continue
            if not _transitively_extends_agent_state(obj):
                continue
            discovered[f"{obj.__module__}.{obj.__name__}"] = obj
    return list(discovered.values())


_MIDDLEWARE_STATE_CLASSES = _discover_middleware_state_classes()


def test_middleware_state_classes_were_discovered():
    """Sanity check the auto-discovery so the parametrized guards below are
    not silently empty after a refactor. If discovery returns nothing (for
    example because ``__init__.py`` is missing or a module fails to import),
    the parametrized tests below would pass trivially and hide regressions.
    """
    assert _MIDDLEWARE_STATE_CLASSES, (
        "No Sophia middleware state classes discovered; the schema invariant "
        "guards would pass trivially. Check that "
        "``deerflow.agents.sophia_agent.middlewares`` is importable and that "
        "every middleware module defines a state class extending AgentState."
    )
    names = {cls.__name__ for cls in _MIDDLEWARE_STATE_CLASSES}
    # Spot-check the state classes known to be susceptible to schema
    # shadowing. If any of these drop off the list the broader parametrized
    # guards lose their bite — this assertion makes that failure explicit.
    for expected in (
        "BuilderArtifactState",
        "BuilderResearchPolicyState",
        "BuilderSessionState",
        "BuilderTaskState",
        "SessionStateState",
        "TurnCountState",
    ):
        assert expected in names, (
            f"Expected middleware state class `{expected}` is missing from "
            "the auto-discovered list; did the module move or rename?"
        )


@pytest.mark.parametrize(
    "state_cls",
    _MIDDLEWARE_STATE_CLASSES,
    ids=lambda cls: cls.__name__,
)
def test_state_class_does_not_downgrade_messages_channel(state_cls):
    """Sophia middleware state classes must preserve the AgentState messages reducer.

    ``langchain.agents.create_agent`` merges middleware state schemas via a
    ``set``-based iteration that last-wins on repeated fields. A middleware
    state that redeclares ``messages: NotRequired[list]`` wipes the
    ``add_messages`` reducer inherited from ``AgentState``, downgrades the
    LangGraph channel to ``LastValue``, and breaks both the IM-channel
    response extraction (every tool write replaces the conversation history,
    so ``runs.wait`` returns only the final ``emit_artifact`` ToolMessage and
    the channel manager ships "(No response from agent)") and parallel tool
    dispatch (which crashes with ``InvalidUpdateError``).
    """
    hints = typing.get_type_hints(state_cls, include_extras=True)
    messages = hints.get("messages")
    assert messages is not None, (
        f"{state_cls.__name__} must inherit or redeclare the `messages` field"
    )
    assert messages == _AGENT_STATE_MESSAGES, (
        f"{state_cls.__name__} shadowed `messages` without the add_messages reducer; "
        "IM channels will see empty AI text in runs.wait results AND parallel "
        "tool calls will crash with InvalidUpdateError. Remove the override so "
        "AgentState's Annotated[list, add_messages] survives, or redeclare it "
        "explicitly with the same reducer."
    )


# ---------------------------------------------------------------------------
# Reducer-gated SophiaState builder fields. Any plain redeclaration on a
# middleware state class (or a missing reducer on SophiaState itself) breaks
# parallel ``builder_web_search`` / ``builder_web_fetch`` tool calls with
# ``INVALID_CONCURRENT_GRAPH_UPDATE``.
# ---------------------------------------------------------------------------


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


_REDUCER_GATED_BUILDER_FIELDS: tuple[tuple[str, object], ...] = (
    ("builder_web_budget", _merge_builder_web_budget),
    ("builder_allowed_urls", _union_string_list),
    ("builder_search_sources", _merge_search_sources),
)


@pytest.mark.parametrize(
    ("field_name", "expected_reducer"),
    _REDUCER_GATED_BUILDER_FIELDS,
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


@pytest.mark.parametrize(
    ("state_cls", "field_name", "expected_reducer"),
    [
        (state_cls, field_name, expected_reducer)
        for state_cls in _MIDDLEWARE_STATE_CLASSES
        for field_name, expected_reducer in _REDUCER_GATED_BUILDER_FIELDS
    ],
    ids=lambda value: getattr(value, "__name__", str(value)),
)
def test_middleware_state_does_not_shadow_reducer_gated_builder_fields(
    state_cls, field_name, expected_reducer
):
    """Middleware states must not redeclare reducer-gated builder fields as plain ``NotRequired[...]``.

    ``langchain.agents.create_agent`` collects every ``middleware.state_schema``
    plus the explicit ``state_schema=`` into a ``set`` and merges them with a
    last-wins loop. If a middleware redeclares ``builder_web_budget`` (or any
    other reducer-gated field) without carrying the reducer metadata, that
    plain declaration can overwrite the ``Annotated[..., reducer]`` coming
    from ``SophiaState``. The LangGraph channel then becomes a ``LastValue``
    and parallel ``builder_web_search`` / ``builder_web_fetch`` tool calls
    crash with ``INVALID_CONCURRENT_GRAPH_UPDATE`` at runtime.

    Because set iteration order is non-deterministic across processes, the
    bug reproduces intermittently in production — exactly why we need a
    type-level guard here.
    """
    hints = typing.get_type_hints(state_cls, include_extras=True)
    annotation = hints.get(field_name)
    if annotation is None:
        # The middleware does not touch this field — nothing to shadow.
        pytest.skip(
            f"{state_cls.__name__} does not declare `{field_name}`; no shadow risk."
        )
    reducers = _extract_reducers_from_annotation(annotation)
    assert expected_reducer in reducers, (
        f"{state_cls.__name__}.{field_name} is declared without the "
        f"`{expected_reducer.__name__}` reducer. That shadows the reducer-"
        f"annotated field on SophiaState when create_agent merges state "
        "schemas, downgrades the runtime channel to LastValue, and causes "
        "INVALID_CONCURRENT_GRAPH_UPDATE on parallel builder tool calls. "
        "Drop the redeclaration so the SophiaState annotation survives, or "
        "carry the reducer through explicitly."
    )


# ---------------------------------------------------------------------------
# Direct unit tests for the reducer helpers (associativity + edge cases the
# schema guards above do not cover).
# ---------------------------------------------------------------------------


def test_merge_builder_web_budget_sums_call_deltas_and_last_wins_for_limits():
    """``*_calls`` keys are SUMMED (delta semantics) — concurrent +1 writes
    from parallel ``builder_web_search`` / ``builder_web_fetch`` tool
    invocations all add up. ``*_limit`` keys are static config; last-wins
    is correct because the middleware seeds them once and tools never
    rewrite them."""
    # Tools write per-invocation deltas like ``{"search_calls": 1}``, NOT
    # the whole budget dict. The reducer combines them into the running
    # state.
    current = {"search_calls": 5, "search_limit": 10, "fetch_calls": 2}
    delta = {"search_calls": 1, "fetch_calls": 1}
    merged = _merge_builder_web_budget(current, delta)
    assert merged["search_calls"] == 6  # 5 + 1
    assert merged["fetch_calls"] == 3  # 2 + 1
    # Static limit preserved (not in delta, so not touched).
    assert merged["search_limit"] == 10


def test_merge_builder_web_budget_static_limits_use_last_wins():
    """If the limit is rewritten (e.g., by an init-once middleware reseed
    on a fresh thread), the new value wins. Last-wins for non-``*_calls``
    keys stays compatible with delta semantics for counters because limits
    are never summed."""
    current = {"search_limit": 5, "search_calls": 3}
    update = {"search_limit": 10}
    merged = _merge_builder_web_budget(current, update)
    assert merged["search_limit"] == 10  # last-wins
    assert merged["search_calls"] == 3  # untouched (not in update)


def test_merge_builder_web_budget_handles_none_inputs():
    assert _merge_builder_web_budget(None, None) == {}
    assert _merge_builder_web_budget(None, {"search_calls": 1}) == {"search_calls": 1}
    assert _merge_builder_web_budget({"fetch_calls": 2}, None) == {"fetch_calls": 2}


def test_merge_builder_web_budget_empty_delta_is_noop():
    """``_budget_guard`` returns an empty delta on the budget-exhausted error
    path. Passing it through the reducer must be a no-op (preserve current
    state exactly)."""
    current = {"search_calls": 5, "search_limit": 10}
    merged = _merge_builder_web_budget(current, {})
    assert merged == current


def test_merge_builder_web_budget_is_associative_under_sum_semantics():
    """LangGraph applies concurrent updates sequentially via reducer(a, b)
    then reducer(result, c); associativity keeps counters stable regardless
    of dispatch order."""
    base = {"search_calls": 5}
    delta_a = {"search_calls": 1}
    delta_b = {"search_calls": 1}
    left = _merge_builder_web_budget(
        _merge_builder_web_budget(base, delta_a), delta_b
    )
    right = _merge_builder_web_budget(
        base, _merge_builder_web_budget(delta_a, delta_b)
    )
    # Both orderings yield 5 + 1 + 1 = 7. The two deltas merged together
    # via the reducer also sum (1 + 1 = 2), so the right side computes
    # 5 + 2 = 7. Associativity holds.
    assert left == right == {"search_calls": 7}


def test_merge_builder_web_budget_parallel_burst_does_not_lose_increments():
    """REGRESSION (codex bot review on PR #81): the prior ``max``-based
    reducer collapsed concurrent ``+1`` writes from parallel tool calls
    into a single increment, under-reporting usage and letting requests
    exceed the configured per-task budget. This test simulates a 4-way
    parallel burst — each call writes the same delta and they MUST all
    accumulate."""
    state_before = {"search_calls": 0, "search_limit": 10}
    # 4 parallel ``builder_web_search`` invocations in the same super-step.
    # Each tool writes a +1 delta independently.
    burst = [{"search_calls": 1} for _ in range(4)]

    state = state_before
    for delta in burst:
        state = _merge_builder_web_budget(state, delta)

    # All four increments survive — the prior max-based reducer would have
    # left this at 1 (max(0, 1) once, then max(1, 1) three times).
    assert state["search_calls"] == 4
    assert state["search_limit"] == 10  # static limit preserved


def test_merge_builder_web_budget_distinct_counter_keys_accumulate_independently():
    """A single delta can carry both ``search_calls`` and ``fetch_calls``
    (or any future ``*_calls`` key). They sum independently."""
    state = {"search_calls": 2, "fetch_calls": 7, "search_limit": 5}
    state = _merge_builder_web_budget(state, {"search_calls": 1})
    state = _merge_builder_web_budget(state, {"fetch_calls": 1})
    state = _merge_builder_web_budget(state, {"search_calls": 1, "fetch_calls": 2})
    assert state["search_calls"] == 4  # 2 + 1 + 1
    assert state["fetch_calls"] == 10  # 7 + 1 + 2
    assert state["search_limit"] == 5  # untouched


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
