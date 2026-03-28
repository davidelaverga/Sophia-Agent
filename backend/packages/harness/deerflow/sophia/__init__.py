"""Sophia services — offline pipeline, memory, handoffs, identity, and tracing.

Imports are intentionally lazy (not at module level) to avoid triggering
the full DeerFlow agent import chain when only a single service is needed.
Use explicit imports: ``from deerflow.sophia.extraction import extract_session_memories``
"""
