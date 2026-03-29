---
title: "fix: Restore operator.add reducer on system_prompt_blocks"
type: fix
status: completed
date: 2026-03-25
---

# fix: Restore operator.add reducer on system_prompt_blocks

## Overview

The P1-4 fix from commit `1102f01` incorrectly removed `operator.add` from `system_prompt_blocks` in `SophiaState`. This causes LangGraph to use LastValue channel semantics, meaning only the last middleware's blocks survive — silently dropping soul.md, voice.md, techniques.md, tone guidance, and all other prompt blocks. The reducer must be restored.

## Problem Frame

A re-review (correctness reviewer) confirmed:
1. `before_agent` runs **once per invocation** — tool loops go to `before_model`, not back to `before_agent`
2. Therefore `operator.add` does NOT cause unbounded growth across agent loop iterations
3. Without the reducer, LangGraph's `LastValue` channel replaces blocks on each middleware update
4. The integration test masks this because it manually uses `list.extend()`, not LangGraph's state merging

See: `docs/solutions/logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md`

## Requirements Trace

- R1. All middleware system prompt blocks must accumulate within a single `before_agent` pass
- R2. The test for `system_prompt_blocks` must assert the reducer IS present (not absent)
- R3. Comments must document why `operator.add` is safe (before_agent lifecycle)

## Scope Boundaries

- Only `state.py` and `test_sophia_state.py` change
- No middleware logic changes
- No changes to PromptAssemblyMiddleware

## Key Technical Decisions

- **Restore `Annotated[list[str], operator.add]`**: This is the correct LangGraph pattern for multi-node accumulation. The original bloat concern was based on a false assumption about `before_agent` re-running in the agent loop.
- **Add explanatory comment**: Document why it's safe, referencing the lifecycle fact, so a future reviewer doesn't repeat the same mistake.

## Implementation Units

- [x] **Unit 1: Restore reducer and fix test**

**Goal:** Restore `operator.add` on `system_prompt_blocks` and update the test to assert it IS present.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `backend/packages/harness/deerflow/agents/sophia_agent/state.py`
- Modify: `backend/tests/test_sophia_state.py`

**Approach:**
- Restore `import operator` in state.py
- Change `system_prompt_blocks: NotRequired[list[str]]` back to `system_prompt_blocks: Annotated[list[str], operator.add]`
- Add comment explaining why operator.add is safe (before_agent runs once per invocation)
- Revert the test from asserting NO metadata to asserting operator.add IS in metadata
- Keep the test name descriptive of what it actually verifies

**Patterns to follow:**
- `messages: Annotated[list[BaseMessage], add_messages]` in `AgentState` — same pattern, different reducer

**Test scenarios:**
- `system_prompt_blocks` has `__metadata__` attribute (is Annotated)
- `__metadata__[0]` is `operator.add`

**Verification:**
- `test_sophia_state.py` passes
- All existing middleware and integration tests still pass (no behavioral change for tests since they use manual extend)

## Risks & Dependencies

- **Low risk:** This is a revert to the original correct behavior, not new functionality
- The integration test's manual `extend()` pattern still works with `operator.add` — they're compatible

## Sources & References

- Learning doc: `docs/solutions/logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md`
- Original (retracted) finding: P1-4 in `docs/solutions/logic-errors/langgraph-middleware-chain-review-pitfalls.md`
- Re-review correctness finding confirming `before_agent` runs once per invocation
