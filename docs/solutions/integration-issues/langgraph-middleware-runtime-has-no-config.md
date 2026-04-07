---
title: "LangGraph middleware Runtime object has no config attribute — use state for data passing"
category: integration-issues
date: 2026-04-05
tags: [langgraph, middleware, runtime, state, delegation-context]
components: [BuilderTaskMiddleware, SubagentExecutor]
severity: P2
---

## Problem

When implementing `BuilderTaskMiddleware`, the initial approach tried to read `delegation_context` from `runtime.config["configurable"]` — the same pattern used by LangChain tool runtimes (`ToolRuntime`). This crashed at runtime:

```
AttributeError: 'Runtime' object has no attribute 'config'
```

### Key Distinction

- **Tool runtime** (`ToolRuntime`): Has `.state`, `.context`, `.config`
- **Middleware runtime** (`Runtime` from `langgraph.runtime`): Has `.context` only — no `.config`, no `.state` as a method

## Root Cause

The LangGraph middleware `Runtime` object is a minimal interface with only `runtime.context` (a dict). It does NOT carry `RunnableConfig`. The `configurable` dict from `run_config` flows through a different path and is not accessible from within middleware `before_agent` hooks.

## Solution

Pass data through the **initial state** instead of `configurable`. In `SubagentExecutor`:

```python
# In _build_initial_state():
if self.extra_configurable:
    state.update(self.extra_configurable)  # Merges into initial state
```

Then in the middleware, read from state:

```python
def before_agent(self, state, runtime):
    delegation_context = state.get("delegation_context") or {}
```

## Prevention

- **Rule of thumb**: In LangGraph middlewares, only `runtime.context` is available. For any other data, pass it through state.
- **In tools**: `ToolRuntime` has `.config`, `.context`, and `.state` — but even here, `runtime.context` may be `None` for subagent-spawned tools.
- Always test middleware code in the actual LangGraph execution context, not just unit tests with mocked runtimes.

## Related

- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py`
- `backend/packages/harness/deerflow/subagents/executor.py`
- `docs/solutions/logic-errors/langgraph-middleware-dict-merge-drops-list-fields.md`
