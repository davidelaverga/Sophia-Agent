---
title: "LangGraph Checkpointer Accumulates List Fields Across Turns — First Middleware Must Reset"
category: logic-errors
date: 2026-04-01
tags:
  - langgraph
  - state-management
  - checkpointer
  - middleware
  - performance
severity: critical
affected_components:
  - backend/packages/harness/deerflow/agents/sophia_agent/middlewares/file_injection.py
root_cause_type: state-persistence
---

# LangGraph Checkpointer Accumulates List Fields Across Turns

## Problem

After 5+ turns in a conversation, the LLM stopped calling `emit_artifact`. Input tokens grew ~9K per turn (9K → 18K → 27K → 45K → ...) until Claude Haiku ran out of output budget and silently skipped the tool call. The system prompt was being duplicated on every turn.

## Root Cause

The LangGraph checkpointer persists ALL state fields between turns — including `system_prompt_blocks`. Each middleware's `before_agent` hook reads the existing blocks from state (which now includes ALL blocks from the previous turn) and extends them with the current turn's blocks. After N turns, every block appears N times in the system prompt.

This is a different bug from the "within-a-single-pass" accumulation issue (solved by having each middleware extend from state). The checkpointer introduces a SECOND accumulation layer: blocks persist across turns, not just across middlewares within one turn.

## Solution

The **first middleware** in the chain that writes to `system_prompt_blocks` must start with a **fresh list**, not extend from state. All subsequent middlewares continue to extend.

```python
# FileInjectionMiddleware — FIRST to write blocks
# Starts fresh to prevent cross-turn accumulation via checkpointer
return {"system_prompt_blocks": blocks}  # NOT list(state.get(...)) + blocks

# All other middlewares — extend from state (accumulates within current turn only)
existing = list(state.get("system_prompt_blocks", []))
existing.append(my_content)
return {"system_prompt_blocks": existing}
```

## Prevention

- **When using LangGraph with a checkpointer, any list field that should reset per-turn must be explicitly cleared** at the start of the middleware chain. The checkpointer doesn't distinguish between "state I want to persist" (messages, artifacts) and "state I want to rebuild" (system prompt blocks).
- **Monitor `input_tokens` across multi-turn conversations.** If tokens grow linearly with turn count, a list field is accumulating via the checkpointer.
- **The first writer resets; all others extend.** This pattern works for any middleware chain with list accumulation.

## Cross-References

- `docs/solutions/logic-errors/langgraph-middleware-dict-merge-drops-list-fields.md` — The within-pass fix (each middleware must extend) that created this cross-turn bug
- `docs/solutions/logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md` — Why operator.add can't solve this
