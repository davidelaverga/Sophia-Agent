---
title: "Sophia session finalization hardening: unify explicit end-session, voice disconnect, and offline memory pipeline"
date: 2026-04-06
category: integration-issues
module: backend
problem_type: integration_issue
component: session-finalization
symptoms:
  - Memories sometimes do not appear after recap even though recap artifacts exist.
  - Voice sessions can terminate transport successfully without reliably triggering recap persistence or Mem0 extraction.
  - The frontend can recover delayed memories, but cannot recover sessions where the offline pipeline never wrote any.
root_cause: integration_gap
resolution_type: backend_hardening
severity: high
related_components:
  - backend.app.gateway.routers.sophia
  - backend.app.gateway.routers.voice
  - backend.app.gateway.inactivity_watcher
  - backend.packages.harness.deerflow.sophia.offline_pipeline
  - backend.packages.harness.deerflow.sophia.extraction
  - voice.adapters.deerflow
tags: [sophia, backend, session-finalization, offline-pipeline, mem0, recap, voice, inactivity]
---

# Sophia session finalization hardening: unify explicit end-session, voice disconnect, and offline memory pipeline

## Problem

The current system has one healthy path for session completion and at least one weak path.

The healthy path is the explicit Sophia `end-session` route. That path persists recap data immediately and then queues the offline pipeline, which is the only place where Mem0 writes happen.

The weak path is transport-level session termination outside explicit `end-session`, especially voice disconnect and potential idle-timeout flows. In those paths, transport can end successfully while recap persistence, handoff generation, identity updates, and Mem0 extraction are not guaranteed to happen through the same finalized backend contract.

This matters because the frontend fix now correctly hydrates memories when they arrive late, but it cannot invent memories that were never extracted or never written by the offline pipeline.

## What We Traced

### Healthy path: explicit end-session

1. Frontend session exit calls Sophia end-session through [frontend/src/app/api/sophia/end-session/route.ts](../../../frontend/src/app/api/sophia/end-session/route.ts).
2. Backend receives that request in [backend/app/gateway/routers/sophia.py](../../../backend/app/gateway/routers/sophia.py#L671).
3. Backend persists recap immediately.
4. Backend unregisters the thread from idle tracking.
5. Backend queues the offline pipeline via [_queue_offline_pipeline](../../../backend/app/gateway/routers/sophia.py#L310).
6. The offline pipeline runs in [backend/packages/harness/deerflow/sophia/offline_pipeline.py](../../../backend/packages/harness/deerflow/sophia/offline_pipeline.py#L39).
7. Memory extraction runs in [backend/packages/harness/deerflow/sophia/extraction.py](../../../backend/packages/harness/deerflow/sophia/extraction.py#L61) and writes `pending_review` memories to Mem0.

This is the path the frontend now assumes when it retries recap loading and hydrates missing memory candidates from `memories/recent`.

### Weak path: voice disconnect

1. Frontend voice disconnect hits [frontend/src/app/api/sophia/[userId]/voice/disconnect/route.ts](../../../frontend/src/app/api/sophia/%5BuserId%5D/voice/disconnect/route.ts).
2. Backend voice disconnect is handled in [backend/app/gateway/routers/voice.py](../../../backend/app/gateway/routers/voice.py#L234).
3. That route asks the voice server to close the agent session.
4. The voice route does not persist recap.
5. The voice route does not queue the Sophia offline pipeline.
6. The voice server closes the call/session, but this by itself does not guarantee the recap + Mem0 pipeline path used by explicit `end-session`.

### Weak path: inactivity watcher

The intended fallback is the inactivity watcher in [backend/app/gateway/inactivity_watcher.py](../../../backend/app/gateway/inactivity_watcher.py#L28), but there are two structural problems.

Problem 1: we did not find production call sites for `register_activity(...)`; the only references outside the watcher itself are tests.

Problem 2: even if the watcher fires, it currently calls the offline pipeline with `thread_state=None`. The pipeline explicitly aborts in [backend/packages/harness/deerflow/sophia/offline_pipeline.py](../../../backend/packages/harness/deerflow/sophia/offline_pipeline.py#L74) and returns `reason = "no_thread_state"`.

That means the timeout fallback is currently not a trustworthy recovery path for memories.

## Why The Frontend Could Still Look Broken

The frontend previously had a recap hydration blind spot and that part has already been fixed. The recap page now retries and hydrates missing memory candidates from the recent memory queue when recap artifacts exist but memories arrive later.

However, that frontend fix only helps when:

- recap persistence happened,
- the offline pipeline actually ran,
- and Mem0 already contains the extracted memories.

If backend finalization never queued the pipeline, or the timeout path aborted before extraction, the frontend can only show recap with no memory candidates because there are no memories to fetch.

## Root Cause

Session finalization is not hardened behind one backend contract.

Today, the system mixes at least three different kinds of session closure:

- explicit Sophia end-session,
- voice transport disconnect,
- inactivity timeout.

Only one of those paths clearly guarantees:

- recap persistence,
- queueing the offline pipeline,
- passing enough session state for extraction,
- and therefore writing memories to Mem0.

The others rely on side effects or fallbacks that are either incomplete or not wired in production.

There is also a second, more concrete retrieval defect now confirmed in a live run: the Mem0 wrapper currently drops `metadata` on write, so memories can be created successfully but still fail the `status=pending_review` filter used by the review endpoint.

## Live Verification Evidence

We instrumented the live backend and ran a real `end-session` request against the gateway on 2026-04-06.

Session used for trace:

- `user_id = trace_live_backend`
- `session_id = sess-live-1775509510`
- explicit `POST /api/sophia/trace_live_backend/end-session`

The live logs confirmed the following chain end to end:

1. `end_session_request`
2. `recap_persisted`
3. `queue_pipeline`
4. `pipeline_start`
5. `extraction_start`
6. Anthropic extraction call succeeded
7. Mem0 write calls succeeded
8. `pipeline_complete`

The live run wrote memories successfully, but the filtered review endpoint still returned zero:

- `GET /api/sophia/trace_live_backend/memories/recent?status=pending_review` returned `count = 0`
- `GET /api/sophia/trace_live_backend/memories/recent` returned persisted memories
- `GET /api/memory/recent?...` on the frontend route returned memories with `fallbackApplied = true`

That means two things are true at once:

- the offline pipeline did run and write memories,
- the canonical review filter is not seeing them under `pending_review`

The strongest current explanation is in [backend/packages/harness/deerflow/sophia/mem0_client.py](../../../backend/packages/harness/deerflow/sophia/mem0_client.py). `extract_session_memories(...)` builds metadata including `status = "pending_review"`, but `add_memories(...)` intentionally calls `client.add(...)` without forwarding metadata.

So the current live behavior is:

- extraction succeeds,
- memories exist,
- metadata is lost at write time,
- review filtering breaks,
- frontend fallback partially masks the issue by re-querying unfiltered memories and scoping them by session/time.

## Risks

### 1. Lost memories after apparently successful sessions

The user can finish a session, see the UI close normally, and still never get memory candidates because the pipeline never ran or aborted before extraction.

### 2. Recap and memory divergence

Recap can exist because the recap file is persisted earlier, while Mem0 remains empty for that session. That creates a misleading state where the session looks complete but downstream memory review is absent.

### 3. Voice is less reliable than text for continuity

Text currently tends to go through the explicit end-session path. Voice can terminate through transport-level disconnect without the same guarantees. That creates cross-platform continuity drift.

### 4. Identity/handoff drift

If the offline pipeline does not run, the failure is not only about memories. The same pipeline also owns:

- handoff generation,
- smart opener generation,
- identity refresh,
- trace writing,
- visual artifact follow-up.

### 5. False confidence from frontend retries

The frontend now handles delayed availability correctly, which can hide the deeper backend issue during manual testing. A session that fails entirely at extraction time still presents as "loading" or "ready but sparse" instead of obviously broken.

### 6. Review workflow is logically broken even when extraction succeeds

Because the current live write path appears to drop metadata, `pending_review` review endpoints can return empty results even when memories were actually created. This breaks the intended moderation/review contract and makes the frontend fallback look like the source of truth when it is really compensating for backend write semantics.

## What Needs To Be Done

## 1. Introduce one canonical backend finalization path

Create a single backend finalization service or function that all session endings must call.

That canonical path must always do the following in one place:

- resolve the canonical `user_id`, `session_id`, and `thread_id`,
- persist recap payload,
- capture or reconstruct enough thread/session state for offline processing,
- unregister the thread from idle tracking,
- queue the offline pipeline,
- guarantee idempotency for repeated triggers.

The current logic in [backend/app/gateway/routers/sophia.py](../../../backend/app/gateway/routers/sophia.py#L671) is the closest thing to that and should become the shared source of truth rather than one route-specific implementation.

## 2. Make voice disconnect go through the same finalizer

`voice_disconnect` in [backend/app/gateway/routers/voice.py](../../../backend/app/gateway/routers/voice.py#L234) should not only close the transport session.

It should either:

- invoke the canonical session finalizer directly, or
- trigger an internal backend operation that is equivalent to the Sophia `end-session` flow.

Closing the voice agent alone is not sufficient because transport shutdown is not the same thing as session finalization.

## 3. Stop calling the offline pipeline with missing state

The timeout fallback currently cannot be trusted because `run_offline_pipeline(..., thread_state=None)` aborts early in [backend/packages/harness/deerflow/sophia/offline_pipeline.py](../../../backend/packages/harness/deerflow/sophia/offline_pipeline.py#L74).

The backend needs one of these approaches:

- store enough session/thread state incrementally so timeout finalization can reuse it,
- or fetch the current LangGraph thread state before queueing the pipeline,
- or persist a session-finalization snapshot during activity so the watcher can use it.

Any timeout-triggered finalization that cannot supply extraction state is not a real fallback.

## 4. Actually wire production activity registration

If the inactivity watcher is intended to matter, `register_activity(...)` in [backend/app/gateway/inactivity_watcher.py](../../../backend/app/gateway/inactivity_watcher.py#L28) must be called from real production request paths.

At minimum that likely means:

- text/chat request handling,
- voice turn submission path,
- and any other Sophia entrypoint that should keep a session alive.

If the team does not want idle finalization as a real feature, then the watcher should be demoted or removed instead of existing as a misleading pseudo-fallback.

## 5. Preserve session identity consistently across voice and text

The finalizer should not rely on whichever layer happens to know the identifiers first.

It should define a canonical mapping for:

- `session_id`,
- `thread_id`,
- `user_id`,
- `started_at`,
- `context_mode`,
- `ritual`,
- platform.

Voice currently creates/reuses thread IDs in [voice/adapters/deerflow.py](../../../voice/adapters/deerflow.py#L301), while session exit flows use a separately propagated session identity. That relationship needs to be authoritative and queryable from backend finalization code.

## 6. Add observability for pipeline entry and outcome

We need logs and/or metrics that answer these questions per session:

- Was finalization requested?
- Which path triggered it: explicit end-session, voice disconnect, or timeout?
- Was recap persisted?
- Was the offline pipeline queued?
- Did extraction run?
- How many memories were written?
- Did the pipeline abort because thread state was missing?

Without this, memory failures will continue to look like intermittent frontend issues.

## 7. Fix Mem0 metadata persistence on write

The live run strongly suggests that `add_memories(...)` in [backend/packages/harness/deerflow/sophia/mem0_client.py](../../../backend/packages/harness/deerflow/sophia/mem0_client.py) is the reason `pending_review` lookups are empty.

Today the wrapper explicitly omits metadata when calling `client.add(...)`. That may have been a workaround for an older Mem0 behavior, but in the current system it breaks the review contract because the extraction pipeline is relying on metadata for:

- `status = pending_review`
- category
- importance
- tone metadata
- ritual phase
- other downstream filtering and ranking

Backend needs to either:

- restore metadata writes correctly with the current Mem0 API shape, or
- perform a follow-up update after creation so memories land with the required metadata before review/list queries run.

Until that is fixed, `GET /memories/recent?status=pending_review` is not a trustworthy indicator of whether extraction succeeded.

## Recommended Test Coverage

Add or extend backend tests for the following.

### 1. Explicit end-session remains the golden path

- recap persisted
- offline pipeline queued
- thread unregistered
- full response returned

### 2. Voice disconnect finalizes the session, not only transport

- closing a voice session eventually results in recap persistence and pipeline queueing
- repeated disconnect/finalize calls remain idempotent

### 3. Timeout fallback is real, not nominal

- production path registers activity
- idle watcher fires after timeout
- finalizer receives usable session/thread state
- extraction runs instead of aborting with `no_thread_state`

### 4. Duplicate triggers are safe

- explicit end-session followed by voice disconnect
- explicit end-session followed by timeout
- voice disconnect followed by timeout

All of those should finalize once and not produce duplicate memories.

## Suggested Implementation Shape

The cleanest approach is probably:

1. Extract current end-session logic from [backend/app/gateway/routers/sophia.py](../../../backend/app/gateway/routers/sophia.py#L671) into a shared finalization service.
2. Make the existing Sophia end-session route call that service.
3. Make voice disconnect call that same service when the backend can determine the session is truly ending.
4. Make inactivity timeout call that same service, not `run_offline_pipeline` directly.
5. Ensure the service can resolve or reconstruct `thread_state` before queueing the pipeline.

That keeps one contract for all downstream side effects instead of trying to keep multiple route-specific implementations in sync.

## Immediate Priority

If backend only fixes one thing first, it should be this:

Ensure that every real session-ending path converges on the same finalization contract that persists recap and queues the offline pipeline with valid state.

That is the minimal condition required for recap, memory candidates, handoffs, identity refresh, and trace continuity to be trustworthy across text and voice.

## Related Context

- Frontend has already been hardened to hydrate delayed memory candidates from the recap page, so some late-memory race conditions are now masked correctly.
- This document is specifically about the remaining backend gap: sessions that appear complete but never produce extractable memories because finalization did not reach the canonical offline path.