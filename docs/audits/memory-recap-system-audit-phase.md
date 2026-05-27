# Memory Recap System Deep Audit

Date: 2026-05-24
Status: docs-only audit, no implementation
Source branch: `audit/memory-recap-system`

## 1. Scope And Safety Boundary

This audit traced the memory recap system before moving the integrated realtime voice stack to main. It was intentionally read-only until this report and the related documentation notes were written.

Explicitly out of scope for this phase:

- code fixes;
- deployments, pushes, merges, or staging;
- real env files or secrets;
- modifying, deleting, cleaning, restoring, or staging `users/**` or `backend/users/**` runtime state.

No runtime user files were edited by this audit.

## 2. Executive Summary

The recap system has one clear healthy finalization path: the web/session exit flow posts to Sophia `end-session`, the gateway persists a recap envelope, synthesizes enough thread state from messages/artifacts when present, unregisters inactivity tracking, and queues the offline pipeline. That pipeline owns Mem0 extraction, handoff, trace, identity, visual-check, and sparse offline recap fallback work.

The important gap is that voice transport disconnect is not the same thing as session finalization. Stream disconnect, Gemini production disconnect, Gemini dogfood disconnect, and OpenAI dogfood disconnect close provider/runtime sessions and clean active voice tracking; they do not call the Sophia `end-session` finalizer, do not persist recap, and do not directly queue the offline pipeline.

This does not mean every voice user path is broken. The visible Session page end controls and the voice command path (`Sophia, end session`) do call the canonical frontend exit flow. The risk is narrower but real: mic stop, hook cleanup/unmount, transport-only disconnect, previous-session cleanup, dogfood cleanup, and provider disconnect routes are transport lifecycle events, not recap lifecycle events.

The likely explanation for "memories sometimes load and sometimes do not" is a combination of two behaviors:

- normal asynchronous timing: recap navigation can happen before offline extraction/Mem0 review hydration completes;
- finalization path divergence: any flow that only disconnects provider transport can leave the frontend with no queued offline pipeline to wait for.

The likely explanation for "approve/reject/edit feels slow" is mostly product/flow semantics, not raw API slowness. Approve and edit are local decisions until the bottom save action commits them. Discard for non-legacy Mem0 ids writes immediately. Journal fetches once on mount and does not live-invalidate after review.

## 3. Route Map

### Healthy Web Session End Path

1. `frontend/src/app/session/useSessionExitFlow.ts` calls `finalizeSessionEnd()` from both `handleEndSession()` and `handleVoiceEndSession()`.
2. `finalizeSessionEnd()` serializes messages and live recap artifacts, then calls `endSessionAPI(...)`.
3. `frontend/src/app/lib/api/sessions-api.ts` sends `endSession()` to `/api/sophia/end-session`.
4. `frontend/src/app/api/sophia/end-session/route.ts` resolves the authenticated Sophia user, removes client-supplied `user_id`, normalizes `thread_id`, and proxies to `/api/sophia/{user_id}/end-session`.
5. `backend/app/gateway/routers/sophia.py` `end_session()` writes `users/{user}/recaps/{session}.json`, updates the session store when a record exists, unregisters inactivity tracking, and calls `_queue_offline_pipeline(...)`.
6. `backend/packages/harness/deerflow/sophia/offline_pipeline.py` `run_offline_pipeline()` writes trace, extracts memories, writes handoff, writes a sparse recap fallback when needed, updates identity, and records visual-check state.

Confidence: proven by code and existing tests.

### Transport-Only Voice Disconnect Paths

Stream/legacy cascade:

1. `frontend/src/app/hooks/useStreamVoiceSession.ts` `stopTalking()`, `bargeIn()`, `resetVoiceState()`, cleanup, and unused preconnect release call `requestCurrentVoiceDisconnect()` or `requestVoiceDisconnect()`.
2. `requestVoiceDisconnect()` posts to `/api/sophia/{user_id}/voice/disconnect` with `call_id`, voice-agent `session_id`, and sometimes `thread_id`.
3. `backend/app/gateway/routers/voice.py` `voice_disconnect()` calls `_disconnect_voice_session(...)`, removes matching `_active_voice_sessions` state, and logs `voice.disconnect`.
4. `_disconnect_voice_session(...)` sends `DELETE /calls/{call_id}/sessions/{session_id}` to the voice server.

Gemini production:

1. `requestGeminiBootstrapDisconnect()` posts to `/api/sophia/voice/gemini/disconnect` or a returned disconnect URL.
2. The frontend proxy maps that to `/api/sophia/{user_id}/voice/gemini/disconnect`.
3. `backend/app/gateway/routers/voice.py` `gemini_production_disconnect()` calls `_disconnect_gemini_production_session(...)` and clears active Gemini voice state.

Dogfood providers:

1. OpenAI dogfood disconnect proxies to `/dogfood/realtime/openai/browser-sessions/{session_id}`.
2. Gemini dogfood disconnect proxies to `/dogfood/realtime/gemini/browser-sessions/{session_id}`.

These routes do not call `_write_session_recap`, `_queue_offline_pipeline`, or `run_offline_pipeline`. They are transport cleanup routes.

Confidence: proven by code.

### Legacy Session End Path

`backend/app/gateway/routers/sessions.py` `/end` marks the session ended, unregisters inactivity tracking, computes duration, and returns `recap_artifacts=None`. It does not persist the Sophia recap envelope and does not queue the offline pipeline. The main current frontend `endSession()` helper points to `/api/sophia/end-session`, so this is mostly a legacy/compatibility risk.

Confidence: proven by code.

## 4. Data Model And State Ownership

### Recap Envelope

The gateway recap file is stored under `users/{user_id}/recaps/{session_id}.json`. Explicit web end writes a rich envelope when the frontend supplies live artifacts. Offline pipeline writes a sparse envelope only if no recap exists already.

Important current behavior: sparse offline recap writes `recap_artifacts: {}` rather than `null`, so the frontend mapper does not early-return before hydration. That fixes an older class of empty recap failures.

### Pending Review Memories

Offline extraction writes Mem0 memories with metadata including:

- `status: pending_review`
- `category`
- `importance`
- `importance_score`
- `confidence`
- `platform`
- `context_mode`
- optional tone, ritual, target date, and tags

The Mem0 wrapper now handles the known SDK metadata stripping problem by forcing synchronous `client.add(...)`, resolving created memory ids, attempting REST metadata backfill, and writing a local review metadata overlay with `sync_state` of `pending`, `synced`, or `local_only`. The review overlay is then applied in gateway list/journal paths.

This means the previous "Mem0 metadata is dropped forever" diagnosis is no longer current as the primary implementation state. The remaining risk is around provider availability/backfill failure/overlay reconciliation, not a total absence of metadata handling.

### Review Decisions

Frontend recap state is stored in localStorage under `sophia-recap`.

- Approve/edit: local decision only until the user completes the review/save action.
- Discard, non-legacy id: immediate `PUT /api/memories/{memoryId}` with `metadata.status = discarded`, then local removal.
- Discard, legacy/synthetic id: local-only removal.
- Save/complete: `commitMemories()` posts approved/edited decisions to `/api/memory/commit-candidates`; that route updates existing memories to `status: approved` or creates synthetic approved memories.

Journal visibility depends on status. The backend journal endpoint can return all statuses unless asked to filter. The frontend `/api/journal` defaults `savedOnly=true` and filters out `pending_review` and `discarded` when no explicit `status` query is provided.

## 5. Race And Cache Analysis

### Race A: Recap Page Opens Before Extraction Completes

`end-session` returns `202` after queueing the offline pipeline, not after extraction completes. The recap page can navigate while Mem0 candidates are still pending.

Frontend mitigations already exist:

- `markRecentSessionEnd(...)` marks just-ended sessions.
- `useRecapArtifactsLoader` treats recent 404/sparse/empty results as `processing` and retries.
- It hydrates missing memory candidates from `/api/memory/recent?status=pending_review&session_id=...`.
- The recent retry window is bounded and retries are finite.

Remaining user-visible risk: if extraction is slower than the retry window, Mem0 is unavailable, metadata overlay is unresolved, or the session never queued the pipeline, the recap can settle as sparse/empty/unavailable.

Confidence: proven timing race, likely contributor to intermittent reports.

### Race B: Transport Disconnect Is Mistaken For Session End

The UI has two classes of close operations:

- Session end: calls `finalizeSessionEnd()` and queues recap/pipeline.
- Voice transport cleanup: stops provider sessions, closes SSE/call/WebSocket, and clears voice state.

When the user uses the actual end-session controls or voice command, the path is healthy. When the browser unmounts the hook, a previous voice session is cleaned up, the mic flow calls `stopTalking()`, or a dogfood/production provider disconnect runs without the session exit flow, only transport is closed.

Confidence: proven code divergence; actual production frequency not measured in this audit.

### Cache And Visibility

Mem0 read cache is invalidated after writes in `add_memories()` and memory CRUD paths. The frontend recap store persists local artifacts/decisions, which is good for refresh resilience but can make local UI state appear ahead of backend persistence.

Journal fetches `/api/journal` once on mount with `cache: no-store`; there is no polling, global query invalidation, or post-review refetch signal beyond navigation. If navigation happens before backend commit/update finishes, or if the user is already on Journal, visible updates can lag until remount/reload.

Confidence: proven by code.

## 6. Observability Audit

Good backend logging exists around explicit finalization:

- `session.finalization end_session_request`
- `session.finalization recap_persisted`
- `session.finalization queue_pipeline`
- `session.finalization end_session_queued`
- `session.finalization pipeline_start`
- `session.finalization pipeline_context`
- `session.finalization extraction_start`
- `session.finalization extraction_candidates`
- `session.finalization extraction_memory_written`
- `session.finalization pipeline_extraction_complete`
- `session.finalization pipeline_complete`
- `session.finalization list_memories_request/result`

Voice logging exists around `voice.connect`, `voice.disconnect`, and provider disconnect failures, but those logs do not correlate to recap finalization outcome because disconnect is not currently a finalization path.

Frontend voice has rich `recordSophiaCaptureEvent(...)` telemetry for connect/disconnect, SSE, Gemini relay, barge-in, and tool loops. Recap/Journaling has error logging but less structured success/status telemetry. There is no single visible correlation trail that says: `user clicked end`, `gateway queued pipeline`, `pipeline wrote N memories`, `recap loader hydrated N candidates`, `review committed N memories`, `journal loaded N saved entries`.

Recommended observability target for a future implementation phase: one privacy-safe session-finalization timeline keyed by `session_id`, `thread_id`, trigger source, path, pipeline status, memory count, recap status, and frontend loader outcome. Do not log raw memory text.

## 7. Existing Test Coverage

Strong current coverage:

- Backend offline pipeline orchestration and idempotency in `backend/tests/test_offline_pipeline.py`.
- Explicit Sophia `POST /end-session` queueing and recap persistence in `backend/tests/test_gateway_sophia.py`.
- Inactivity watcher pipeline trigger in `backend/tests/test_inactivity_watcher.py`.
- Mem0 provider/cache/fallback basics in `backend/tests/test_mem0_client.py`.
- Voice gateway disconnect transport cleanup in `backend/tests/test_voice_gateway.py`.
- Frontend recap retry/hydration behavior in `frontend/src/__tests__/recap/useRecapArtifactsLoader.test.tsx`.
- Frontend recap store and session exit flow coverage in `frontend/src/__tests__/stores/recap-store.test.ts` and `frontend/src/__tests__/session/useSessionExitFlow.test.ts`.
- Frontend memory recent filtering/cross-session isolation in `frontend/src/__tests__/api/memory-recent.route.test.ts`.

Critical gaps:

- No test proves voice provider disconnect triggers recap persistence or offline pipeline queueing.
- Current voice disconnect tests assert transport cleanup, which matches the code, but they do not cover memory recap finalization.
- No end-to-end integration test covers voice session end -> offline pipeline -> Mem0 pending_review -> recap hydration -> user review -> Journal saved entry.
- No test asserts the intended contract for transport-only cleanup versus session finalization, so future changes can accidentally keep treating provider disconnect as sufficient.

No tests were run during this docs-only audit.

## 8. Findings By Severity

### High: Voice Transport Disconnect Does Not Finalize Memory Recap

Evidence: `useStreamVoiceSession` provider cleanup calls voice disconnect endpoints; gateway voice disconnect routes only close provider sessions and active voice tracking. The explicit Sophia `end-session` route is the only inspected route that writes rich recap and queues the offline pipeline immediately.

Impact: sessions that end through transport cleanup alone can have no recap envelope, no Mem0 extraction, no handoff, and no identity update until or unless another fallback finalizes them.

Confidence: proven.

### Medium: Recap Hydration Is Intentionally Eventually Consistent

Evidence: `end-session` queues the pipeline asynchronously and returns `202`; frontend loader retries/hydrates pending memories from `/api/memory/recent` after navigation.

Impact: even healthy sessions can show temporary sparse/processing states. If extraction exceeds the retry window, the UI can look like memory failed even though the backend may finish later.

Confidence: proven, likely contributor.

### Medium: Review Actions Have Split Persistence Semantics

Evidence: approve/edit are local until save; discard is immediate for non-legacy ids; Journal loads once on mount.

Impact: users can read "Memory saved" toast after approve/edit even though backend persistence has not happened yet. Journal may not reflect changes until save completes and navigation/remount occurs.

Confidence: proven.

### Low: Backend Journal Requires Explicit Status Discipline

Evidence: backend `/journal` returns all hydrated memories unless `status` is passed; frontend `/api/journal` hides pending/discarded by default.

Impact: direct backend consumers can show review-state memories if they bypass the frontend filter.

Confidence: proven, low risk for current web Journal.

## 9. Disproven Or Updated Prior Suspicions

- Disproven: all voice end paths bypass finalization. The Session page end controls and the spoken "Sophia, end session" command both reach `finalizeSessionEnd()`.
- Updated: the older metadata-loss diagnosis is not the current primary implementation state. `mem0_client.add_memories()` now performs metadata backfill plus local overlay persistence.
- Updated: sparse offline recap envelopes now use `{}` for `recap_artifacts`, not `null`, so the frontend hydration path can run.

## 10. Recommendations For A Later Fix Phase

No fixes were implemented here.

1. Define the session-finalization contract explicitly: either provider disconnect must call the canonical Sophia finalizer, or it must be documented and tested as transport-only with another guaranteed close path.
2. If provider disconnect should finalize sessions, add the missing identity mapping from voice-agent `session_id`/Gemini runtime `session_id` back to companion `session_id`, `thread_id`, started time, context mode, and platform.
3. Add tests for the chosen contract: explicit end-session, voice command end-session, Stream disconnect, Gemini production disconnect, dogfood disconnect, inactivity fallback, and duplicate/idempotent close attempts.
4. Add privacy-safe finalization telemetry that joins frontend end action, gateway queue, pipeline outcome, memory count, recap loader hydration, review commit, and Journal load.
5. Align recap UI copy/toast semantics with persistence truth: approve/edit are review decisions until final save, while discard is immediate for real Mem0 ids.

## 11. Bottom Line

The memory recap system is not broadly broken, but its lifecycle boundary is too easy to confuse. The canonical `end-session` path is healthy and well-instrumented. Transport disconnect is a different thing. Until those two concepts are unified or tested as deliberately separate, realtime voice migration can still produce sessions that sound finished while memory recap work never starts.

## 12. Phase 12.6E Follow-Up

The smallest safe fix phase has now codified the intended boundary rather than making all disconnects finalize sessions.

- Intentional voice end from Session controls or the spoken end-session command goes through the canonical Sophia `end-session` finalizer.
- Voice transport cleanup is explicit via `stopVoiceTransport()` and remains cleanup-only.
- Backend voice disconnect routes still do not create recap envelopes or queue the offline pipeline by default.
- Sophia `end-session` suppresses duplicate offline queueing once a recap envelope already exists.
- The recap loader's recent-session processing/retry behavior remains the expected navigation race mitigation.

Deferred from 12.6E: approve/edit local-save semantics, Journal live refresh, and a full privacy-safe recap observability timeline.