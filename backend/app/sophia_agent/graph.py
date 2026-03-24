"""Sophia companion graph — registered in langgraph.json as sophia_companion.

Entry point for LangGraph server. Follows the DeerFlow pattern:
single agent node with middleware chain.
"""

from __future__ import annotations

from langgraph.graph import END, StateGraph

from app.sophia_agent.agent import make_sophia_agent
from app.sophia_agent.state import SophiaState


def build_graph():
    """Build and compile the Sophia companion StateGraph."""
    builder = StateGraph(SophiaState)
    builder.add_node("agent", make_sophia_agent)
    builder.set_entry_point("agent")
    builder.add_edge("agent", END)
    return builder.compile()


graph = build_graph()
