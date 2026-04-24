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
warnings.filterwarnings(
    "ignore",
    message=r".*PydanticSerializationUnexpectedValue.*context.*",
    category=UserWarning,
)
