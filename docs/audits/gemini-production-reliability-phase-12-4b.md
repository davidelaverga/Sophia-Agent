# Phase 12.4B - Gemini Production Reliability Instrumentation and Minimal Fixes

Date: 2026-05-20
Status: Implemented, feature-flagged production route preserved

## Scope

Phase 12.4B followed the strict Phase 12.4A order: add correlation instrumentation first, then apply only the minimal fixes supported by the captured failure shape and official Google Live API semantics. It does not rewrite prompts, replace runtime transport, enable Gemini by default, or fake public continuity metrics.

## Instrumentation Added

- Browser provider categories: setup completion, server content, input/output transcription, model-turn audio/text, tool call, tool cancellation, GoAway, session resumption, usage metadata, and provider error.
- Browser relay traces: correlation id, categories, attempt/success/failure counters, HTTP status, duration, response kind, client-action/tool-diagnostic counts, and backend diagnostics snapshots.
- Browser tool-call ledger: received, cancelled, relay started/completed, backend accepted, toolResponse prepared/sent, send suppressed, suppression reason, and final state per function-call id.
- Session telemetry/capture export: `gemini-provider-event-correlation`, `gemini-relay-trace`, and `gemini-tool-call-ledger` capture events are exported without raw audio.
- Backend relay diagnostics: accepted provider events, category counts, extracted function calls, cancellation ids, tool execution phases, mapper output counts, and emitted public `sophia.*` counts.

## Official Google Docs Re-check

Verified against official Google Live API docs and guides:

- `toolCallCancellation` says the specified function-call ids should not have been executed and should be cancelled; side-effect undo can be attempted if applicable.
- Live API function calling is manual; clients must return `toolResponse.functionResponses` with matching ids.
- `serverContent.interrupted` means client playback should stop and clear queued audio.
- With automatic activity detection enabled by default, a paused microphone should send `audioStreamEnd`; audio can resume later by sending another audio message.
- Input and output transcriptions are independent of other server messages and have no guaranteed ordering.

## Minimal Fixes

- Suppressed browser `toolResponse` send-back for any function-call id that the ledger already marked cancelled, with `tool_response_send_suppressed` diagnostics.
- Filtered mixed toolResponse payloads so non-cancelled responses can still be sent while cancelled ids are omitted.
- Tracked backend cancellations before execution and while execution is in flight; completed side effects after cancellation are recorded as `completed_after_cancellation`, but stale client actions are not returned.
- Added durable Gemini manual mute intent in the Session hook; stage callbacks and soft barge-in no longer reactivate listening while muted.
- Added Gemini microphone gating in the browser connector and sends `audioStreamEnd` once when manual mute pauses the automatic-VAD audio stream.

## Evidence Model

Healthy Gemini WSS/audio is no longer enough to call the production path healthy. A valid run should show provider categories flowing into relay traces, backend mapper outputs, and public `sophia.*` emissions. Artifact, builder, and transcript counts remain tied to public normalized events.

## Manual Smoke Plan

Use the existing feature-flagged production route only:

1. Set the four Gemini route flags plus `GOOGLE_API_KEY` or `GEMINI_API_KEY`.
2. Start a normal Session voice turn through `/voice/connect`; do not use `/debug/realtime/gemini` for production evidence.
3. Confirm capture export includes `gemini-provider-event-correlation`, `gemini-relay-trace`, and `gemini-tool-call-ledger` events.
4. Speak once and confirm `sophia.user_transcript` and `sophia.transcript` counts derive from public SSE/capture events.
5. Trigger an artifact turn and confirm `emit_artifact` tool-call ledger id maps to a public `sophia.artifact` event.
6. Trigger a builder request and confirm successful builder lifecycle tool execution maps to a public `sophia.builder_task` event.
7. Interrupt during a tool call and confirm stale toolResponse send-back is suppressed for cancelled ids.
8. Toggle manual mute and confirm outgoing audio frames stop, `audioStreamEnd` is sent, and UI stays non-listening until explicit unmute.

## Validation

- `cd frontend; pnpm exec vitest run src/__tests__/gemini-browser-live-websocket-dogfood.test.ts src/__tests__/lib/voice-runtime-metrics.test.ts src/__tests__/session/VoiceMetricsPanel.test.tsx --reporter=dot`
- `python -m pytest voice/tests/test_gemini_browser_dogfood.py -q`

## Open Gaps

- This phase adds correlation evidence for public transcript/artifact/builder continuity but does not implement broad SSE replay or prompt rewrites.
- Manual production smoke is still required with real Google Live service behavior to determine whether any remaining public continuity gap is relay, mapper, normalizer, SSE ingestion, or model/tool-selection behavior.