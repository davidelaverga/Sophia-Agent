---
title: "SubagentExecutor drops final_state when propagating results from background execution"
category: integration-issues
date: 2026-04-05
tags: [langgraph, subagent, executor, state-propagation, builder-handoff]
components: [SubagentExecutor, switch_to_builder]
severity: P1
---

## Problem

When using `SubagentExecutor.execute_async()` to run a subagent in a background thread, the executor's callback copies `status`, `result`, `error`, `completed_at`, and `ai_messages` from the execution result to the shared `_background_tasks` dict — but **does not copy `final_state`**.

This means the caller polling via `get_background_task_result(task_id)` always sees `result.final_state == None`, even though the agent completed successfully and `_aexecute` stored `final_state` in the local result object.

### Symptom

The primary extraction path in `switch_to_builder` — reading `result.final_state["builder_result"]` — silently fell through to the fallback path (scanning `ai_messages` for tool calls). This worked by accident when the LLM called `emit_builder_artifact`, but would fail if the middleware captured the result in state without a corresponding tool call in `ai_messages`.

## Root Cause

In `executor.py`, the `run_task` callback inside `execute_async` manually copies fields:

```python
with _background_tasks_lock:
    _background_tasks[task_id].status = exec_result.status
    _background_tasks[task_id].result = exec_result.result
    _background_tasks[task_id].error = exec_result.error
    _background_tasks[task_id].completed_at = datetime.now()
    _background_tasks[task_id].ai_messages = exec_result.ai_messages
    # MISSING: _background_tasks[task_id].final_state = exec_result.final_state
```

The `final_state` field was added to `SubagentResult` but the propagation in `execute_async`'s callback was not updated.

## Solution

Add the missing field copy:

```python
_background_tasks[task_id].final_state = exec_result.final_state
```

## Prevention

- When adding new fields to a dataclass that's used in a producer-consumer pattern (here: `_aexecute` produces, `run_task` callback consumes), **grep for all copy/propagation sites** and update them.
- Consider using `dataclasses.replace()` or direct assignment of the entire result object instead of field-by-field copying, to prevent future omissions.
- Add an integration test that exercises the `execute_async` -> polling -> field extraction path end-to-end.

## Related

- `backend/packages/harness/deerflow/subagents/executor.py` (lines 423-429)
- `backend/packages/harness/deerflow/sophia/tools/switch_to_builder.py` (`_extract_builder_result`)
