"""Helpers for resolving the active LangChain tool call id.

LangChain's ``InjectedToolCallId`` parameter annotation is meant to receive
the id of the in-flight tool call. However, when a tool is declared with an
explicit empty ``args_schema`` (as ``share_builder_artifact`` is, so its
JSON-schema generation does not trip the Anthropic tool binder), the value
sometimes arrives as an empty string. ``ToolRuntime.tool_call_id`` is the
canonical, always-present source the LangChain runtime exposes — we prefer
that and only fall back to the injected parameter.

A non-empty id is mandatory: LangGraph rejects every ``Command.update`` whose
``ToolMessage`` does not match the originating ``tool_use`` id, so silently
emitting an empty id corrupts the entire turn.
"""

from __future__ import annotations

from typing import Any


def resolve_tool_call_id(
    runtime: Any | None,
    injected_tool_call_id: str | None,
    *,
    tool_name: str,
) -> str:
    """Return the active tool call id, preferring ``runtime.tool_call_id``.

    Args:
        runtime: The ``ToolRuntime`` instance LangChain injected, if any.
        injected_tool_call_id: The value LangChain injected for the
            ``Annotated[str, InjectedToolCallId]`` parameter, which may be an
            empty string when ``args_schema`` masks the standard injection.
        tool_name: Name of the tool, used purely for error messages so a
            failure is easy to attribute in production logs.

    Returns:
        The non-empty tool call id.

    Raises:
        ValueError: If neither source produced a non-empty id. Surfacing this
            as an exception is intentional — it's strictly better than
            returning a corrupt ``Command`` that LangGraph will then reject.
    """
    runtime_id = getattr(runtime, "tool_call_id", None) if runtime is not None else None
    if isinstance(runtime_id, str) and runtime_id.strip():
        return runtime_id

    if isinstance(injected_tool_call_id, str) and injected_tool_call_id.strip():
        return injected_tool_call_id

    raise ValueError(
        f"{tool_name}: no tool_call_id available from runtime or injection — "
        "cannot return a valid Command.update."
    )
