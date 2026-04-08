---
title: "before_model with RemoveMessage can empty the messages list sent to the LLM"
category: logic-errors
date: 2026-04-05
tags: [langgraph, middleware, before-model, remove-message, anthropic]
components: [PromptAssemblyMiddleware]
severity: P1
---

## Problem

`PromptAssemblyMiddleware` used `before_model` with `RemoveMessage` to clear old `SystemMessage`s before adding the assembled one:

```python
def before_model(self, state, runtime):
    updates = []
    for m in messages:
        if isinstance(m, SystemMessage):
            updates.append(RemoveMessage(id=m.id))
    updates.append(SystemMessage(content=system_content, id=self._SYSTEM_MSG_ID))
    return {"messages": updates}
```

This caused `anthropic.BadRequestError: messages: at least one message is required` — the Anthropic API received an empty messages list.

## Root Cause

The `before_model` return goes through the `add_messages` reducer. The `RemoveMessage` operations may have removed messages with IDs that didn't match (due to auto-generated UUIDs), or the reducer processed the operations in an order that left no valid messages for the API call.

The fundamental issue: `before_model` + `add_messages` reducer is fragile for message manipulation. The `DanglingToolCallMiddleware` docstring confirms this: *"Uses wrap_model_call instead of before_model to ensure patches are inserted at the correct positions, not appended to the end as before_model + add_messages reducer would do."*

## Solution

Switch from `before_model` to `wrap_model_call`, which gives direct control over the `request.messages` sent to the model:

```python
def wrap_model_call(self, request, handler):
    state = request.state
    blocks = state.get("system_prompt_blocks", [])
    system_content = "\n\n---\n\n".join(blocks)

    # Filter out old SystemMessages, prepend the new one
    non_system = [m for m in request.messages if not isinstance(m, SystemMessage)]
    assembled = [SystemMessage(content=system_content)] + non_system

    return handler(request.override(messages=assembled))
```

This bypasses the `add_messages` reducer entirely and guarantees the `HumanMessage` is always preserved.

## Prevention

- **Prefer `wrap_model_call` over `before_model`** when you need to manipulate the messages list. It gives direct, predictable control.
- **Never use `RemoveMessage` in `before_model`** — the interaction with the `add_messages` reducer is hard to predict and test.
- The `ModelRequest.override(messages=...)` pattern is the canonical way to modify messages in the LangGraph middleware system.

## Related

- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/prompt_assembly.py`
- `backend/packages/harness/deerflow/agents/middlewares/dangling_tool_call_middleware.py` (reference pattern)
