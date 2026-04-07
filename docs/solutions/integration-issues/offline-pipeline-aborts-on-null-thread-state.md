---
title: "Offline pipeline aborts on null thread_state — all finalization paths broken"
category: integration-issues
date: 2026-04-07
tags: [sophia, offline-pipeline, voice, session-finalization, mem0, langgraph]
components: [offline_pipeline, voice_disconnect, inactivity_watcher, end_session]
severity: P1
---

## Problem

Voice sessions that end through transport disconnect lose all post-session processing: no memory extraction, no handoff, no smart opener, no trace. But the bug is broader — **all three finalization paths** (end-session, inactivity watcher, voice disconnect) pass `thread_state=None` to `run_offline_pipeline`, which immediately aborts:

```python
if thread_state is None:
    return {"status": "error", "reason": "no_thread_state"}
```

Every caller has comments like `"pipeline will need to fetch it"` or `"pipeline handles missing state"` — but the pipeline never fetched it.

## Root Cause

Two compounding failures:

1. **No caller provides `thread_state`** — sophia.py end-session, inactivity watcher, and voice disconnect all pass `None`.
2. **Pipeline aborts instead of fetching** — the guard returns error immediately without attempting to retrieve state from LangGraph.

Additionally, voice disconnect didn't call the pipeline at all — it only sent DELETE to the voice server.

## Solution

### Change 1: Self-fetching pipeline

When `thread_state=None`, fetch from `GET /threads/{thread_id}/state` on the LangGraph server:

```python
def _fetch_thread_state(thread_id: str) -> dict | None:
    url = f"{_LANGGRAPH_URL}/threads/{thread_id}/state"
    resp = httpx.get(url, timeout=10.0)
    resp.raise_for_status()
    data = resp.json()
    values = data.get("values", data)
    if not values.get("messages"):
        return None
    return values
```

**Critical detail**: On fetch failure, `_processed_sessions.discard(session_id)` must be called before returning error — otherwise the session is permanently poisoned and can never be retried.

### Change 2: Voice disconnect wiring

Created `backend/app/gateway/routers/voice.py` with connect/disconnect endpoints. Disconnect handler: unregisters from inactivity tracker, queues pipeline as background task, closes voice transport.

`VoiceDisconnectRequest` requires `thread_id` (with `min_length=1` validation) — the frontend already has it from the connect response.

## Prevention

- When a pipeline depends on data it doesn't own, always include a fetch fallback — don't assume callers will provide it.
- When an idempotency guard (`_processed_sessions`) adds an ID early, ensure the ID is removed on any abort path that should allow retry.
- When adding new transport disconnect handlers (voice, WebSocket, etc.), always wire them to the same finalization pipeline the other paths use.

## Related

- `docs/solutions/integration-issues/langgraph-subagent-executor-state-propagation.md`
- `docs/solutions/integration-issues/langgraph-middleware-runtime-has-no-config.md`
- `backend/packages/harness/deerflow/sophia/offline_pipeline.py`
- `backend/app/gateway/routers/voice.py`
