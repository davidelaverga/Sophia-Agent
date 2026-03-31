---
title: "Mem0 SDK update() Uses 'text' Parameter, Not 'data' — And Requires At Least One Field"
category: integration-issues
date: 2026-03-31
tags:
  - mem0
  - api-integration
  - sdk
  - silent-failure
severity: high
affected_components:
  - backend/app/gateway/routers/sophia.py
root_cause_type: api-mismatch
---

# Mem0 SDK update() Uses 'text' Parameter, Not 'data'

## Problem

Gateway endpoints for updating and bulk-approving memories silently failed. The `update_memory` endpoint passed `data=body.text` and the `bulk_review` endpoint passed `data=None` to `client.update()`. Both raised `TypeError` (unknown keyword argument) caught by the generic `except Exception`, returning 503 or recording `status: "error"` — but the endpoint returned 200 OK with error details buried in the response body.

## Root Cause

The Mem0 `MemoryClient.update()` method signature is `update(self, memory_id, text=None, metadata=None, timestamp=None)`. It does NOT accept a `data` parameter. Additionally, it raises `ValueError` if all three optional params are `None` — so a no-op "approve" call that passes nothing will also fail.

## Solution

```python
# WRONG — raises TypeError
client.update(memory_id=id, data="new text")
client.update(memory_id=id, data=None)  # approve = no-op? → ValueError

# RIGHT — use 'text' parameter
client.update(memory_id=id, text="new text")

# RIGHT — approve means updating status metadata
client.update(memory_id=id, metadata={"status": "approved"})
```

## Prevention

- **Check SDK method signatures before using them.** Run `help(client.update)` or read the source. Don't assume parameter names match your mental model.
- **Never catch broad `Exception` without logging the type.** The `TypeError` from wrong keyword args was indistinguishable from a network error in the logs.
- **Define what "approve" means before implementing it.** A no-op is not a valid SDK call — if approve means "keep this memory," decide whether that's a metadata status change or literally doing nothing (skip the call).
