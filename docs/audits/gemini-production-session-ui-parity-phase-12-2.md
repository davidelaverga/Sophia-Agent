# Gemini Production Session UI Parity - Phase 12.2

Date: 2026-05-20
Status: implemented, focused frontend validation passed

## Scope

Phase 12.2 keeps the Gemini production transport from Phase 12.0 and the runtime telemetry from Phase 12.1 intact. The target is product UI parity inside the real `/session` route:

```text
Gemini production voice session
-> normalized sophia.* events
-> Session transcript updates correctly
-> Session artifact surface updates correctly
-> legacy cascade remains rollback-safe
```

This phase does not redesign Gemini Live, OpenAI sideband, provider relay, or backend normalization.

## Audit Findings

### Transcript Root Cause

Gemini and legacy both publish assistant transcripts through normalized `sophia.transcript` events. `SophiaEventNormalizer` emits cumulative assistant partials with `is_final: false` and final text with `is_final: true`.

The real Session UI does not render `useStreamVoiceSession.partialReply` as the primary product transcript. The conversation pane and voice captions render from Session `messages`, and the Session bridge appends assistant messages only when `onAssistantResponse` fires.

Before Phase 12.2, `useStreamVoiceSession` handled partial assistant transcripts by setting only `partialReply`. That meant Gemini partials reached hook-local state and telemetry, but not the real Session transcript/caption state. Final transcripts did enter the message path, so the bug showed up as missing progressive assistant transcript rendering rather than a transport or SSE subscription failure.

Phase 12.2 routes every non-empty assistant transcript update through a small shared ingestion helper. Partial updates still set `partialReply`; final updates still set `finalReply`, clear `partialReply`, and append to the voice store exactly once. Both partial and final updates now call the Session assistant-response bridge. `appendVoiceAssistantMessage` already replaces the last voice assistant message when text grows, so progressive Gemini partials update one visible assistant message instead of creating duplicates.

### Artifact Root Cause

Gemini and legacy normalized companion artifacts are supposed to arrive as public `sophia.artifact` envelopes with artifact data in `data`. The companion artifact is not the same as a builder-produced document artifact.

The Session artifact surface expects canonical `RitualArtifacts`-style top-level fields such as `takeaway`, `reflection`, `reflection_candidate`, and `memory_candidates`. Text stream artifacts already pass through `parseArtifactsPayload` before `mergeRitualArtifacts`.

Before Phase 12.2, live voice artifacts bypassed that parser and were passed raw into `ingestArtifacts`. A perfectly top-level artifact could work, but any production envelope drift such as `{ artifact: { takeaway: ... } }`, `{ payload: { ... } }`, or an accidental double `{ data: { ... } }` envelope would silently merge into no visible companion artifact content. This was a UI-boundary normalization gap, not a Gemini relay failure.

Phase 12.2 sends live voice artifacts through `parseArtifactsPayload` before ingestion and teaches the parser to unwrap nested `artifact`, `payload`, or `data` objects when no canonical top-level artifact fields are present. Builder document artifact extraction remains separate via `builder_result` / `builder_artifact` / `builderArtifact`.

## Files Changed

- `frontend/src/app/hooks/voice-session-event-ingestion.ts` adds pure transcript parsing/application helpers.
- `frontend/src/app/hooks/useStreamVoiceSession.ts` uses the helper for normalized assistant transcript events.
- `frontend/src/app/session/stream-contract-adapters.ts` unwraps nested live companion artifact envelopes.
- `frontend/src/app/companion-runtime/voice-runtime.ts` routes live voice artifacts through `parseArtifactsPayload` before ingestion.
- Focused tests cover transcript helper behavior, voice assistant message replacement, artifact parser unwrapping, and the architecture-level live voice artifact contract.

## Validation

Passed:

```bash
cd frontend
pnpm vitest run src/__tests__/hooks/voice-session-event-ingestion.test.ts src/__tests__/session/stream-contract-adapters.test.ts src/__tests__/session/useSessionVoiceMessages.test.ts src/__tests__/architecture/live-voice-artifact-contract.test.ts
```

Result: 19 tests passed across 4 files.

Known local validation limitation:

```bash
cd frontend
pnpm vitest run src/__tests__/hooks/useStreamVoiceSession.test.ts
```

This existing heavyweight hook test file still fails locally with JavaScript heap out of memory, including with an 8 GB heap and a single worker. Phase 12.2 therefore adds focused pure-helper coverage for the transcript bridge instead of relying on that file for this narrow behavior.

## Manual Smoke Plan

1. Gemini production transcript smoke:
   - Enable Gemini production gates.
   - Start voice from the real `/session` route.
   - Confirm assistant partial text appears progressively in the Session transcript/caption surface and final text does not duplicate a second assistant bubble.

2. Gemini companion artifact smoke:
   - Use a turn that produces `emit_artifact`.
   - Confirm `sophia.artifact` updates the existing companion artifact surface with visible takeaway/reflection content.
   - Confirm runtime telemetry still reports Gemini artifact/tool-loop evidence.

3. Gemini builder artifact distinction:
   - Launch a builder task from voice.
   - Confirm builder document artifacts still render through the builder artifact path, not as companion ritual artifacts.

4. Legacy rollback smoke:
   - Disable `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED` or select `legacy_cascade`.
   - Confirm Stream/Vision Agents voice still starts, normalized transcript events still render, and legacy artifact rendering is unchanged.
