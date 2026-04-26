"""Deerflow package initialization.

Runs before any deerflow submodule (including the LangGraph entry points
referenced by ``langgraph.json``: ``deerflow.agents:make_sophia_agent``,
``deerflow.agents:make_lead_agent``, ``deerflow.agents.sophia_agent.builder_agent:make_sophia_builder``).

Used here to install runtime-wide warning filters that must be in place
before langchain / langgraph emit their repeating diagnostic warnings.
The gateway process installs the same filter in ``app.gateway.app``; this
file is the equivalent hook for the LangGraph process.
"""

from __future__ import annotations

import warnings

# LangChain's tool runtime wrapper emits ``PydanticSerializationUnexpectedValue``
# on the ``context`` RunnableConfig field every time a tool is invoked with
# a non-None context dict (``{'thread_id': ..., 'sandbox_id': 'local'}``).
# The warning is harmless — the field is serialised correctly with
# ``exclude=None`` elsewhere — but it fires on EVERY tool call (often
# >50 per builder run) and drowns real log signal. We suppress it narrowly:
# only messages matching the ``context`` field pattern are ignored; unrelated
# Pydantic warnings stay visible.
def _install_pydantic_context_warning_filter() -> None:
    """Register the LangChain ``context`` field noise filter, idempotent.

    Called once at import time so production processes (LangGraph) inherit
    the filter. Re-callable from tests so the assertion in
    ``test_deerflow_pydantic_warning_filter`` survives pytest's per-test
    ``catch_warnings()`` reset (when ``deerflow`` was already cached in
    ``sys.modules`` from an earlier test, the import-time side effect
    happens inside a different ``catch_warnings`` window and is no longer
    visible by the time this test asserts).
    """
    warnings.filterwarnings(
        "ignore",
        message=r".*PydanticSerializationUnexpectedValue.*context.*",
        category=UserWarning,
    )


_install_pydantic_context_warning_filter()
