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

Sister guards for SophiaState reducer-gated builder fields
(``builder_web_budget`` / ``builder_allowed_urls`` / ``builder_search_sources``)
will be added in the web-tools restoration PR alongside the actual reducer
implementations.
"""

from __future__ import annotations

import importlib
import inspect
import pkgutil
import typing

import pytest
from langchain.agents import AgentState

from deerflow.agents.sophia_agent import middlewares as _middlewares_pkg

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
