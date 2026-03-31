---
title: "LangGraph Middleware Returns Use Dict Merge — List Fields Must Be Explicitly Extended"
category: logic-errors
date: 2026-03-28
tags:
  - langgraph
  - middleware
  - state-management
  - silent-failure
severity: critical
affected_components:
  - backend/packages/harness/deerflow/agents/sophia_agent/middlewares/
root_cause_type: framework-assumption
---

# LangGraph Middleware Returns Use Dict Merge — List Fields Must Be Explicitly Extended

## Problem

After building a 14-middleware chain where each middleware returns `{"system_prompt_blocks": ["my_block"]}`, only the last middleware's block survived in the system prompt. The system prompt had 1 entry (artifact_instructions.md) instead of 11. Input tokens dropped from ~9,000 to ~4,400. Soul.md, voice.md, techniques.md, tone guidance, context, skill — all silently dropped.

The `Annotated[list[str], operator.add]` reducer on `SophiaState.system_prompt_blocks` was present and correct, but had no effect at runtime.

## Root Cause

**The LangGraph middleware framework does NOT use state channel reducers for middleware return values.** When a middleware's `before_agent` hook returns `{"system_prompt_blocks": ["block"]}`, the framework merges it into state via simple `dict.update()` — last-write-wins. The `operator.add` annotation on the state schema only affects graph node transitions (which middlewares are not).

This means:
- Middleware 1 returns `{"system_prompt_blocks": ["soul.md content"]}` → state has 1 block
- Middleware 2 returns `{"system_prompt_blocks": ["voice.md content"]}` → state has 1 block (soul.md replaced)
- ...
- Middleware 14 returns `{"system_prompt_blocks": ["artifact_instructions"]}` → state has 1 block

Only the last middleware's contribution survives.

## Solution

Each middleware must **read the existing blocks from state and extend them** before returning:

```python
# WRONG — returns fresh list, previous blocks lost
return {"system_prompt_blocks": [my_content]}

# RIGHT — extends existing blocks
existing = list(state.get("system_prompt_blocks", []))
existing.append(my_content)
return {"system_prompt_blocks": existing}
```

Applied to all 10 middlewares that write to `system_prompt_blocks`.

## Why This Was Hard to Catch

1. **Tests masked it.** Integration tests simulated the middleware chain with manual `list.extend()`, which has accumulation semantics. The real framework doesn't.
2. **The reducer annotation was present.** `Annotated[list[str], operator.add]` on the state schema looks like it should handle accumulation. Developers reasonably assume the framework uses it.
3. **Non-list fields worked fine.** Scalar fields like `active_skill`, `tone_estimate`, `platform` merged correctly — only list fields had the problem because last-write-wins is correct for scalars but destructive for lists.

## Prevention

- **Never assume a state reducer applies to middleware returns.** In LangGraph, reducers apply to graph node transitions. Middleware hooks are NOT graph nodes — they're sequential functions within a single node.
- **Test with the actual LangGraph runtime**, not manual dict simulation. The integration test helper must use `state[key] = value` (last-write-wins), not `state[key].extend(value)`.
- **When a list field in state should accumulate across multiple middleware hooks**, each hook must read-then-extend. There is no framework-level alternative.

## Cross-References

- `docs/solutions/logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md` — Related: removing `operator.add` was also wrong, but for a different reason (it changes channel semantics for graph nodes)
- The `operator.add` annotation is kept on `SophiaState` for documentation purposes and because it IS correct for graph-level state transitions — just not for middleware returns
