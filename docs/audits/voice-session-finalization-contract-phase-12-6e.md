# Phase 12.6E - Voice Session Finalization Contract

Date: 2026-05-24
Status: implemented, not deployed
Source branch: `audit/memory-recap-system`

## Scope

This phase implements the smallest safe fix after the Memory Recap System Deep Audit. It does not change Mem0 provider behavior, memory extraction logic, Journal storage, artifact schema, prompt/skill behavior, provider routing defaults, or runtime user data.

No real env files, `users/**`, or `backend/users/**` runtime artifacts are part of this contract change.

## Chosen Option

Chosen implementation: Option C, frontend canonicalization plus backend idempotency.

Intentional voice session end now routes through the existing canonical Sophia end-session finalizer, then performs voice transport cleanup. Backend voice disconnect routes remain cleanup-only by default.

This is safer than adding automatic finalization to transport disconnect because cleanup/unmount, previous-session replacement, provider failure, and mic stop can all be technical lifecycle events rather than user intent to end the companion session.

## Contract

- Intentional session end must call the canonical Sophia end-session finalizer (`/api/sophia/end-session` -> `/api/sophia/{user_id}/end-session`).
- Voice transport disconnect is not session finalization.
- Mic stop, temporary disconnect, hook cleanup/unmount, unused preconnect cleanup, and provider teardown must not create recaps automatically.
- Spoken commands such as `Sophia, end session` must use the intentional session end path.
- Visible Session page End controls must use the intentional session end path.
- After canonical finalization is attempted, intentional voice end may clean up the voice transport.
- Duplicate canonical finalization calls must not enqueue duplicate offline pipeline work once a recap envelope already exists.

## Implementation Notes

Frontend:

- `useStreamVoiceSession` now exposes `stopVoiceTransport()` as an explicit cleanup-only alias for the transport teardown path.
- `useSessionExitFlow` accepts optional `stopVoiceTransport` and calls it after `endSessionAPI(...)` has been attempted.
- `useSessionExitOrchestration` passes the optional cleanup callback through to the exit flow.
- The Session page passes `voiceState.stopVoiceTransport`, so header End and spoken end-session command finalize first and then close voice transport.
- Recent recap navigation marker behavior is unchanged: `markRecentSessionEnd(sessionId)` is set when emergence completes and recap navigation starts.

Backend:

- Sophia `end_session` checks for an existing recap envelope before writing and queueing.
- If a recap already exists, the route updates the session store to ended when needed, unregisters inactivity tracking, returns a normal `pipeline_queued` response shape, and suppresses duplicate offline queueing.
- Voice disconnect routes still only close provider/runtime sessions and active voice tracking.

Privacy-safe diagnostics added/kept:

- `voiceDisconnectKind=intentional_end_cleanup` on frontend cleanup failure logs.
- `sessionIdPresent` and `threadIdPresent` booleans instead of raw text.
- Backend duplicate finalization log carries `duplicateFinalizationSuppressed=True` and `recapPipelineQueued=False`.
- Backend queue log carries `recapPipelineQueued=True`.

## Explicit Non-Goals

- This phase does not make every transport disconnect finalize memory recap.
- This phase does not change approve/edit local-save semantics.
- This phase does not add Journal live refresh or query invalidation.
- This phase does not add a full recap observability timeline.
- This phase does not broaden memory extraction, Mem0 writes, provider routing, or artifact schemas.

## Expected Runtime Behavior

Intentional voice end:

1. User clicks the Session End control or says `Sophia, end session`.
2. Frontend calls the canonical Sophia end-session API with session/thread ids, messages, and live artifacts when present.
3. Gateway persists or reuses the recap envelope and queues the offline pipeline once.
4. Frontend performs voice transport cleanup.
5. Recap navigation uses the existing recent-session processing/retry loader path.

Technical transport cleanup:

1. Hook cleanup, mic stop, barge-in transport teardown, provider disconnect, dogfood disconnect, or previous-session cleanup calls voice disconnect.
2. Gateway/voice server closes runtime resources.
3. No recap is created and no offline pipeline is queued by that cleanup alone.

## Tests Added Or Updated

- Frontend exit flow test: intentional voice end calls canonical finalizer before voice transport cleanup and marks the recent recap hint on recap navigation.
- Frontend voice hook test: `stopVoiceTransport()` uses the voice disconnect route and does not call `/api/sophia/end-session`.
- Backend Sophia route test: duplicate end-session requests reuse the existing recap and queue offline pipeline once.
- Backend voice gateway test: `/voice/disconnect` remains cleanup-only by default.

## Remaining Follow-Ups

- Align approve/edit recap decisions with clearer local-save semantics.
- Add Journal live refresh or post-review invalidation.
- Add a privacy-safe recap observability timeline from frontend trigger through pipeline, review, and Journal load.