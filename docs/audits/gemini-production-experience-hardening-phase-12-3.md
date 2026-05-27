# Gemini Production Experience Hardening Phase 12.3

Date: 2026-05-20
Status: implemented, focused validation pending
Runtime default: `legacy_cascade`
Gemini promotion remains gated by `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, and `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true`.

## Production Run Findings

The first real production Session UI run showed four user-visible gaps:

- Barge-in did not visibly stop Sophia's outgoing audio.
- Assistant transcript text lagged behind spoken audio and appeared as word-by-word churn.
- Builder work was not visibly represented in the real Session UI.
- Artifacts still needed truthful diagnosis because telemetry showed `artifactCount: 0` even though companion turns require `emit_artifact`.

## Official Gemini Grounding

Google Live API behavior for this phase:

- Native interruption comes from activity/VAD; there is no OpenAI-style `response.cancel` for normal automatic activity detection.
- `serverContent.interrupted` means user/client activity interrupted the current model generation.
- Clients playing audio in real time should stop playback and empty the playback queue when `serverContent.interrupted` arrives.
- `outputTranscription` is independent of audio playback timing and should not be treated as a frame-accurate subtitle stream.

## Implemented Changes

### Interruption and Playback

`frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts` now detects `serverContent.interrupted`, stops all scheduled PCM output sources, clears the playback state, skips output-audio scheduling for that event, and reports an interruption diagnostic.

`frontend/src/app/hooks/useStreamVoiceSession.ts` consumes that diagnostic, records `gemini-interruption`, increments interruption/audio-flush telemetry, clears stale partial text, and returns the Session/presence state to listening.

### Transcript Pacing

`frontend/src/app/hooks/voice-session-event-ingestion.ts` now exposes a Gemini-only transcript pacer. The production hook applies it only while a Gemini connection is active. Legacy transcript behavior remains immediate.

The pacer suppresses very small partials, emits when text reaches a natural chunk or enough time/characters have passed, and always flushes final transcripts exactly through the existing final transcript path.

### Builder Surfacing

`voice/realtime/gemini_browser_dogfood.py` now maps successful Gemini builder lifecycle tool executions into BuilderTaskV1-compatible payloads and publishes them through `ProviderEvent.builder_task_payload(...)`.

`voice/realtime/dogfood_session.py` exposes `publish_provider_event(...)` so backend-owned tool execution can still pass through `SophiaEventNormalizer` rather than emitting public `sophia.*` manually.

The real Session UI already rendered builder state; the missing piece was the public `sophia.builder_task` event bridge.

### Artifact Truthfulness and Metrics

`artifactCount` remains the count of public `sophia.artifact` events. This stays truthful: `artifactCount: 0` means no public companion artifact reached the Session event boundary.

Gemini telemetry now separates:

- `artifactToolCallCount`: Gemini requested `emit_artifact`.
- `builderToolCallCount`: Gemini requested a builder lifecycle tool.
- `toolRejectionCount`: backend execution rejection only.
- `toolCancellationCount`: provider `toolCallCancellation` only.
- `interruptionCount` and `playbackFlushCount`: local interruption/playback evidence.

This makes the live artifact failure diagnosable:

- `artifactToolCallCount = 0` and `artifactCount = 0`: model did not call `emit_artifact`.
- `artifactToolCallCount > 0` and `artifactCount = 0`: relay/normalizer/public ingestion bug.
- `artifactCount > 0` but UI missing artifact: frontend parser/rendering bug.

## Files Changed

- `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`
- `frontend/src/app/hooks/useStreamVoiceSession.ts`
- `frontend/src/app/hooks/voice-session-event-ingestion.ts`
- `frontend/src/app/lib/voice-types.ts`
- `frontend/src/app/lib/voice-runtime-metrics.ts`
- `voice/realtime/dogfood_session.py`
- `voice/realtime/gemini_browser_dogfood.py`
- Focused frontend and Python tests under `frontend/src/__tests__` and `voice/tests`

## Validation Plan

Focused tests:

- `pnpm vitest run src/__tests__/gemini-browser-live-websocket-dogfood.test.ts src/__tests__/hooks/voice-session-event-ingestion.test.ts src/__tests__/lib/voice-runtime-metrics.test.ts`
- `python -m pytest voice/tests/test_gemini_browser_dogfood.py`

Broader checks when time allows:

- `cd frontend && pnpm typecheck`
- `cd frontend && pnpm lint`
- `cd backend && make lint && make test`

## Residual Risk

A live production smoke is still needed to confirm provider timing under real microphone/audio conditions. The code now handles the documented interruption signal and exposes the counters needed to distinguish model behavior from relay, normalizer, and UI rendering failures.
