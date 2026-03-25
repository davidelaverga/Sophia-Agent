---
status: pending
priority: p1
issue_id: "004"
tags: [code-review, architecture, correctness]
dependencies: []
---

# system_prompt_blocks Reducer Causes Prompt Bloat Across Agent Loops

## Problem Statement

`SophiaState.system_prompt_blocks` uses `Annotated[list[str], operator.add]` reducer. LangGraph accumulates via concatenation — if the agent loops (tool call then model call), every middleware fires `before_agent` again, doubling the prompt blocks. PromptAssemblyMiddleware reads from this ever-growing list. This causes prompt bloat that grows with each loop iteration.

## Findings

- **Architecture agent (HIGH):** The accumulating reducer will cause duplicate system prompts on multi-step agent loops. The integration test masks this by manually extending lists.

**Location:** `backend/packages/harness/deerflow/agents/sophia_agent/state.py`, line 48

## Proposed Solutions

### Option A: Remove operator.add reducer (Recommended)
Change to plain `list[str]` field with last-write-wins semantics. Each middleware pass produces a fresh list.
- Pros: No accumulation bug, simple
- Cons: Middlewares need to build from scratch each pass (they already do)
- Effort: Small
- Risk: Low

### Option B: Clear blocks in PromptAssemblyMiddleware
Reset system_prompt_blocks after assembly.
- Pros: Explicit cleanup
- Cons: Fights the reducer semantics
- Effort: Small
- Risk: Medium

## Recommended Action

Option A — remove the operator.add reducer.

## Acceptance Criteria

- [ ] system_prompt_blocks does not accumulate across agent loop iterations
- [ ] Test verifies prompt size is stable across multi-step agent loops
