---
title: "feat: Sophia Gateway API Endpoints"
type: feat
status: active
date: 2026-03-31
---

# feat: Sophia Gateway API Endpoints

## Overview

Add a FastAPI router at `gateway/routers/sophia.py` exposing REST endpoints for memory management, reflect flow, journal, visual artifacts, and session-end trigger. These endpoints bridge the frontend (Luis) and the Sophia backend services (Mem0, offline pipeline, reflection).

## Problem Frame

The Sophia middleware chain and offline pipeline are functional but only accessible via LangGraph's `runs/stream` API and manual Python scripts. The frontend needs REST endpoints to:
- Let users review/approve/discard extracted memories
- Trigger the reflect flow (voice + visual)
- Browse the journal (all memories by category)
- Display visual artifacts (tone trajectory, decisions, commitments)
- Signal session end (trigger offline pipeline from frontend)

## Requirements Trace

- R1. Memory review: list pending memories, approve/edit/discard individually, bulk review
- R2. Reflect flow: accept query + period, return voice_context + visual_parts via Claude Haiku
- R3. Journal: list all memories for a user, filterable by category
- R4. Visual artifacts: weekly tone trajectory, decisions list, commitments list
- R5. Session end trigger: fire offline pipeline from frontend (manual trigger until voice layer auto-fires)
- R6. All endpoints validate user_id via `validate_user_id()` for path traversal protection
- R7. Follow existing gateway router patterns (prefix, tags, Pydantic response models, async)

## Scope Boundaries

- NOT building frontend UI — Luis consumes these endpoints
- NOT implementing auth — matches existing gateway pattern (no auth on any router)
- NOT adding WebSocket/SSE — these are simple REST endpoints
- Visual artifact backends are read-only aggregations from trace files and Mem0 — no new data stores

## Context & Research

### Relevant Code and Patterns

- `backend/app/gateway/routers/memory.py` — existing DeerFlow memory router (pattern to follow)
- `backend/app/gateway/routers/models.py` — clean example of Pydantic response models + async endpoints
- `backend/app/gateway/app.py` — router registration via `app.include_router()`
- `backend/packages/harness/deerflow/sophia/mem0_client.py` — `search_memories()`, `add_memories()`, `invalidate_user_cache()`
- `backend/packages/harness/deerflow/sophia/offline_pipeline.py` — `run_offline_pipeline()`
- `backend/packages/harness/deerflow/sophia/prompts/reflect_prompt.md` — reflect prompt template
- `backend/packages/harness/deerflow/agents/sophia_agent/utils.py` — `validate_user_id()`
- `backend/packages/harness/deerflow/agents/sophia_agent/paths.py` — `USERS_DIR`

### Institutional Learnings

- Mem0 v2 API requires `filters` dict for search, not top-level params (learned during manual testing)
- Memories written with `agent_id="sophia_companion"` may need matching filter to retrieve
- `safe_user_path()` must be used for all filesystem operations involving user_id

## Key Technical Decisions

- **Single router file**: All Sophia endpoints in one `sophia.py` router with prefix `/api/sophia` — matches the spec exactly and keeps Sophia concerns isolated from DeerFlow's existing routers
- **Mem0 SDK for memory operations**: Use `MemoryClient` directly for list/update/delete — the `mem0_client.py` wrapper is for search+write only
- **Reflect uses direct Anthropic SDK**: Same pattern as extraction.py — load template, call Haiku, parse response
- **Visual artifacts read from trace files**: No additional database — aggregate from `users/{user_id}/traces/*.json`
- **Session-end endpoint fires pipeline async**: Use `asyncio.create_task()` to avoid blocking the HTTP response

## Open Questions

### Resolved During Planning

- **Should endpoints require auth?** No — existing gateway has no auth on any router. Auth will be added globally later.
- **Where does the router file go?** `backend/app/gateway/routers/sophia.py` — same directory as all other routers.
- **How to handle Mem0 SDK not installed?** Return 503 with clear error message, same as mem0_client graceful degradation.

### Deferred to Implementation

- **Exact Mem0 SDK methods for update/delete**: Need to verify `client.update()` and `client.delete()` signatures at implementation time
- **Visual artifact aggregation logic**: Exact grouping/sorting of trace data deferred to implementation

## Implementation Units

- [ ] **Unit 1: Router scaffold + memory list endpoint**

**Goal:** Create the sophia router with the first endpoint — list pending memories for review.

**Requirements:** R1, R6, R7

**Dependencies:** None

**Files:**
- Create: `backend/app/gateway/routers/sophia.py`
- Modify: `backend/app/gateway/app.py` (add router registration)
- Test: `backend/tests/test_gateway_sophia.py`

**Approach:**
- Router with `prefix="/api/sophia"`, `tags=["sophia"]`
- `GET /{user_id}/memories/recent` with optional `status` query param
- Validate user_id via `validate_user_id()` at endpoint entry, return 400 on invalid
- Use Mem0 `MemoryClient.search()` or `.get_all()` with user_id filter
- Pydantic response model: `MemoryListResponse` with list of `MemoryItem`
- Register router in `app.py` via `app.include_router(sophia.router)`

**Patterns to follow:**
- `backend/app/gateway/routers/memory.py` for router structure
- `backend/app/gateway/routers/models.py` for Pydantic response models

**Test scenarios:**
- Valid user_id returns memory list
- Invalid user_id returns 400
- Empty memory list returns `{"memories": []}`
- Mem0 unavailable returns 503

**Verification:**
- `GET /api/sophia/jorge_test/memories/recent` returns JSON with memory list
- Router appears in OpenAPI docs at `/docs`

---

- [ ] **Unit 2: Memory CRUD endpoints (PUT, DELETE, bulk-review)**

**Goal:** Add endpoints to approve/edit, discard, and bulk-review memories.

**Requirements:** R1, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `backend/app/gateway/routers/sophia.py`
- Test: `backend/tests/test_gateway_sophia.py`

**Approach:**
- `PUT /{user_id}/memories/{memory_id}` — update memory text and/or metadata (status, category)
- `DELETE /{user_id}/memories/{memory_id}` — delete memory from Mem0
- `POST /{user_id}/memories/bulk-review` — accept list of `{id, action: "approve"|"discard"}`, process in batch
- Use Mem0 SDK `client.update()` and `client.delete()` methods
- Invalidate user cache after any write operation

**Test scenarios:**
- PUT updates memory text and returns updated record
- DELETE removes memory and returns 204
- Bulk review processes multiple memories, returns per-item status
- Invalid memory_id returns 404
- Invalid user_id returns 400

**Verification:**
- Memory updated/deleted is reflected in subsequent GET

---

- [ ] **Unit 3: Reflect flow endpoint**

**Goal:** Implement the reflect endpoint that generates voice context and visual parts from user memories.

**Requirements:** R2, R6

**Dependencies:** Unit 1

**Files:**
- Create: `backend/packages/harness/deerflow/sophia/reflection.py`
- Modify: `backend/app/gateway/routers/sophia.py`
- Test: `backend/tests/test_gateway_sophia.py`

**Approach:**
- `POST /{user_id}/reflect` with body `{query: str, period: "this_week"|"this_month"|"overall"}`
- Load `reflect_prompt.md` template, fill with query + period + user memories from Mem0
- Call Claude Haiku to generate response
- Parse response into `{voice_context: str, visual_parts: [...]}`
- `voice_context` is a text summary Sophia can read aloud; `visual_parts` are structured data for the frontend

**Patterns to follow:**
- `backend/packages/harness/deerflow/sophia/extraction.py` for Anthropic SDK call pattern

**Test scenarios:**
- Valid reflect request returns voice_context + visual_parts
- Invalid period value returns 422
- Empty memories returns graceful reflection with limited context
- Anthropic API failure returns 503

**Verification:**
- `POST /api/sophia/jorge_test/reflect` with `{query: "How have I been this week?", period: "this_week"}` returns structured response

---

- [ ] **Unit 4: Journal endpoint**

**Goal:** List all memories for a user, filterable by category.

**Requirements:** R3, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `backend/app/gateway/routers/sophia.py`
- Test: `backend/tests/test_gateway_sophia.py`

**Approach:**
- `GET /{user_id}/journal` with optional `category` query param
- Use Mem0 SDK to list all memories for user, optionally filtered by category
- Return chronologically ordered list with category, content, metadata, timestamps
- Pydantic response model: `JournalResponse` with list of `JournalEntry`

**Test scenarios:**
- Returns all memories when no category filter
- Category filter returns only matching memories
- Empty journal returns `{"entries": []}`
- Invalid category returns 422

**Verification:**
- `GET /api/sophia/jorge_test/journal` returns all memories
- `GET /api/sophia/jorge_test/journal?category=relationship` returns filtered list

---

- [ ] **Unit 5: Visual artifact endpoints**

**Goal:** Expose aggregated visual data from trace files for the frontend dashboard.

**Requirements:** R4, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `backend/app/gateway/routers/sophia.py`
- Test: `backend/tests/test_gateway_sophia.py`

**Approach:**
- `GET /{user_id}/visual/weekly` — aggregate tone_estimate values from trace files for the past 7 days, return as time series
- `GET /{user_id}/visual/decisions` — search Mem0 for memories in "decision" category
- `GET /{user_id}/visual/commitments` — search Mem0 for memories in "commitment" category
- Weekly reads from `users/{user_id}/traces/*.json` via `safe_user_path()`
- Decisions and commitments are simple Mem0 category-filtered searches

**Test scenarios:**
- Weekly with trace files returns tone time series data
- Weekly with no traces returns empty series
- Decisions/commitments return category-filtered memories
- Invalid user_id returns 400

**Verification:**
- `GET /api/sophia/jorge_test/visual/weekly` returns `{data_points: [{date, avg_tone, session_count}]}`

---

- [ ] **Unit 6: Session-end trigger endpoint**

**Goal:** Allow the frontend to manually trigger the offline pipeline when a session ends.

**Requirements:** R5, R6

**Dependencies:** Unit 1, offline pipeline (already implemented)

**Files:**
- Modify: `backend/app/gateway/routers/sophia.py`
- Test: `backend/tests/test_gateway_sophia.py`

**Approach:**
- `POST /{user_id}/end-session` with body `{session_id: str, thread_id: str}`
- Validate user_id
- Fire `run_offline_pipeline()` as an async background task (don't block the HTTP response)
- Return immediately with `{"status": "pipeline_queued", "session_id": "..."}`
- The pipeline's own idempotency guard prevents double processing

**Test scenarios:**
- Valid request returns 202 with pipeline_queued status
- Invalid user_id returns 400
- Missing session_id returns 422
- Duplicate session_id (idempotent) still returns 202 (pipeline handles dedup internally)

**Verification:**
- `POST /api/sophia/jorge_test/end-session` triggers pipeline and returns immediately
- Trace file and handoff file appear after pipeline completes

## System-Wide Impact

- **Interaction graph:** Gateway app.py registers the new router. No other routers affected.
- **Error propagation:** Mem0 SDK errors → 503. Validation errors → 400/422. Not-found → 404. All via HTTPException.
- **State lifecycle risks:** Session-end fires pipeline async — if server restarts mid-pipeline, the session won't be reprocessed (idempotency set is in-memory). Acceptable for MVP.
- **API surface parity:** These endpoints match the spec exactly (CLAUDE.md lines 353-366).

## Risks & Dependencies

- **Mem0 SDK update/delete methods**: Need to verify the exact SDK API at implementation time. If methods differ, may need raw HTTP calls.
- **Trace file volume**: Weekly visual endpoint reads all trace files for the past 7 days. For high-volume users this could be slow. Acceptable for MVP; can add caching later.

## Sources & References

- CLAUDE.md lines 353-366 — endpoint spec
- `docs/specs/04_backend_integration.md` section 9 — gateway API details
- `backend/app/gateway/routers/` — existing router patterns
