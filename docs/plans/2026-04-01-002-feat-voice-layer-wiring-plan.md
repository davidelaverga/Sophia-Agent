---
title: "feat: Voice layer wiring — backend contract + session lifecycle"
type: feat
status: completed
date: 2026-04-01
---

# feat: Voice Layer Wiring — Backend Contract + Session Lifecycle

## Overview

Wire the Sophia backend to the voice layer (Luis's track). The backend provides three things: (1) the `runs/stream` SSE contract for real-time text + artifact delivery, (2) the session-end trigger via gateway endpoint, and (3) an inactivity watcher that auto-fires the offline pipeline after 10 minutes of silence on text sessions.

The voice layer itself (`voice/server.py`, `sophia_llm.py`, `sophia_tts.py`) is Luis's responsibility. This plan covers only the backend side of the integration.

## Problem Frame

The LangGraph server is running and `sophia_companion` responds correctly via `runs/stream`. The gateway has a `POST /api/sophia/{user_id}/end-session` endpoint. But two things are missing:

1. **No inactivity watcher** — text sessions don't have a WebRTC disconnect signal. The offline pipeline only fires when manually triggered or when the voice layer sends a disconnect. Text sessions need an automatic timeout.
2. **No API contract documentation** — Luis needs a clear, versioned document describing exactly how to consume `runs/stream` events, parse artifacts, and trigger session end.

## Requirements Trace

- R1. Inactivity watcher fires offline pipeline after 10 minutes of no messages on a thread
- R2. Watcher is idempotent — if pipeline already ran for that session, it's a no-op
- R3. Watcher tracks active threads and their last message timestamp
- R4. API contract document describes SSE event format, artifact parsing, and session lifecycle for Luis
- R5. Contract covers all 3 platforms: voice, text, ios_voice

## Scope Boundaries

- NOT building the voice layer (Luis's track: `voice/server.py`, `sophia_llm.py`, `sophia_tts.py`, `sophia_turn.py`)
- NOT building the frontend WebRTC integration
- NOT building Cartesia TTS plugin
- Only backend-side: inactivity watcher + API contract documentation

## Key Technical Decisions

- **Inactivity watcher as a FastAPI background task**: Runs in the gateway lifespan, checks every 60 seconds, fires pipeline for threads idle > 10 minutes
- **Thread tracking via in-memory dict**: `{thread_id: {"user_id": str, "last_active": float}}`. Updated on every `runs/stream` request. Acceptable for single-process deployment; upgrade to Redis if multi-process needed.
- **API contract as a markdown file**: `docs/API_CONTRACTS.md` — not code, not OpenAPI. A human-readable document Luis can reference while building.

## Implementation Units

- [ ] **Unit 1: Inactivity watcher background task**

**Goal:** Auto-fire the offline pipeline when a text session has no messages for 10 minutes.

**Files:**
- Create: `backend/app/gateway/inactivity_watcher.py`
- Modify: `backend/app/gateway/app.py` (start watcher in lifespan)
- Modify: `backend/app/gateway/routers/sophia.py` (update thread activity on session-end)
- Test: `backend/tests/test_inactivity_watcher.py`

**Approach:**
- Module with `start_watcher()` / `stop_watcher()` async functions
- `_active_threads: dict[str, dict]` tracks `{thread_id: {"user_id", "session_id", "last_active", "context_mode"}}`
- `register_activity(thread_id, user_id, session_id, context_mode)` called from gateway when a request arrives
- Background `asyncio.Task` runs every 60 seconds, checks for threads idle > 600 seconds
- For each idle thread: call `run_offline_pipeline()` via `asyncio.to_thread()`, then remove from tracking
- Pipeline's idempotency guard prevents double processing
- `stop_watcher()` cancels the background task gracefully during shutdown

**Test scenarios:**
- Thread inactive for 11 minutes → pipeline fires
- Thread with activity within 10 minutes → no pipeline
- Thread already processed (idempotent) → no duplicate processing
- Watcher starts and stops cleanly with lifespan

**Verification:**
- After 10 minutes of inactivity, trace file and handoff appear for the session

---

- [ ] **Unit 2: Thread activity tracking in gateway**

**Goal:** Update the inactivity watcher's thread tracking when requests come in.

**Dependencies:** Unit 1

**Files:**
- Modify: `backend/app/gateway/routers/sophia.py`

**Approach:**
- Import `register_activity` from `inactivity_watcher`
- In the `end-session` endpoint: remove the thread from active tracking (session explicitly ended)
- Add a lightweight middleware or dependency that calls `register_activity()` on any Sophia-related request (if needed — or document that Luis should call it)

**Verification:**
- Sending a message updates the thread's `last_active` timestamp
- Calling `end-session` removes the thread from tracking

---

- [ ] **Unit 3: API contract document for Luis**

**Goal:** Clear, versioned document describing how to consume the Sophia backend from the voice/frontend layer.

**Files:**
- Create: `docs/API_CONTRACTS.md`

**Approach:**
- Section 1: `runs/stream` SSE event format — exact JSON shapes for text chunks and tool call results
- Section 2: How to parse `emit_artifact` from SSE events — which fields to read, timing (artifact arrives after text)
- Section 3: Voice emotion mapping — `voice_emotion_primary` → Cartesia emotion parameter, `voice_speed` → Cartesia speed values
- Section 4: Configurable parameters — `user_id`, `platform`, `ritual`, `context_mode` — what each does
- Section 5: Session lifecycle — thread creation, multi-turn via same thread, session end via gateway endpoint or inactivity timeout
- Section 6: Platform differences — voice (1-3 sentences) vs text (2-5 sentences) vs ios_voice (same as voice)

**Verification:**
- Luis can follow the document to build `sophia_llm.py` without asking Jorge clarifying questions

## Risks & Dependencies

- **Voice layer not started**: Luis hasn't created `voice/` yet. This plan provides the contract he needs to start. No blocking dependency.
- **Inactivity watcher is in-memory**: Thread tracking resets on server restart. Acceptable for MVP — active sessions will simply not get their pipeline run on restart. The next session's middleware chain will still work (identity file and Mem0 persist).

## Sources & References

- `docs/specs/04_backend_integration.md` section 7 — SophiaLLM plugin, session end detection
- `docs/specs/02_build_plan.md` Week 2 — voice emotion mapping, platform detection
- CLAUDE.md — platform values and effects, voice speed mapping
