# Gemini Turn-Capture Evidence Harness - Phase 12.4J

Date: 2026-05-21
Status: implemented and focused validation passed in this worktree
Scope: Gemini production Session diagnostics only; legacy cascade remains default

## Why This Exists

Phase 12.4I classified the reported bad reflection reply as a turn-capture and antecedent-continuity problem, not just over-continuation. The bad shape was: the user asked Gemini to reflect on `what I just said`, and Gemini answered as if the antecedent was missing.

The missing evidence before this phase was an ordered, current-run view that could answer:

- Did Gemini receive the full pause-heavy user utterance?
- Did provider input transcription split before the antecedent was available?
- Did assistant output begin before the complete user intent arrived?
- Did interruption, `toolCallCancellation`, artifact/tool suppression, manual mute, or `audioStreamEnd` affect the turn?
- Did the public `sophia.user_transcript` event match the provider input transcription that caused the reply?

## What Changed

Frontend export:
- Added `turnCaptureDiagnostics.version = 1` to `frontend/src/app/lib/voice-telemetry-report.ts`.
- Built the section in `frontend/src/app/lib/turn-capture-diagnostics.ts` from the same current-run scoped events already selected for schema v2 telemetry exports.
- Kept the root report version at `2`; the new diagnostics section has its own version.

Browser Gemini connector:
- Added `onInputAudioActivity` to `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`.
- Emits `gemini-input-audio-activity` capture evidence for sampled audio frames, manual mute on/off, input stream pause, and actual `audioStreamEnd` send.
- Frame diagnostics contain only local sequence, audio frame sequence, represented frame count, mic state, estimated PCM16 byte length, frame duration, trigger, and stream-end state.

Session wiring:
- `frontend/src/app/hooks/useStreamVoiceSession.ts` records the new input-audio diagnostics into the existing capture bridge.
- Existing `gemini-stage-changed`, `gemini-provider-event-correlation`, `gemini-output-audio-*`, `gemini-interruption`, `gemini-tool-call-ledger`, and public `sophia.*` capture events are correlated by the export helper.

Public normalizer:
- `voice/realtime/normalizer.py` now includes optional source metadata on public `sophia.user_transcript` payloads when provider input transcription has it: `source_sequence`, `provider_relay_sequence`, `provider_received_at`, and `relay_correlation_id`.
- `voice/realtime/gemini_live.py` already attaches compact source metadata to mapped provider events; Phase 12.4J makes the public user transcript joinable.

## What It Captures

The exported timeline can include these families:

- `user_input_activity`: sampled input audio frames, manual mute on/off, input stream pause, and `audioStreamEnd` send.
- `provider_input_transcription`: Gemini input transcription preview with receive sequence/correlation id.
- `public_user_transcript`: visible `sophia.user_transcript` payload, now joinable to provider input metadata when available.
- `assistant_output`: provider output transcription preview, public assistant transcript, and audio chunk scheduling evidence.
- `turn_boundary`: provider interruption, generation completion, turn completion, public `sophia.turn`, and browser interruption evidence.
- `tool_artifact`: tool-call ledger, provider tool calls/cancellations, public artifacts, artifact cancellation evidence.
- `session_stage`: derived Session stage transitions, public SSE state, microphone state, and remote audio state.
- `public_event`: other public `sophia.*` diagnostic events that matter to turn classification.

The summary includes bounded counters, recent provider/public user transcript previews, latest tool evidence, and final UI state.

## What It Excludes

- Raw microphone/audio bytes and base64 audio payloads.
- Full Gemini provider messages.
- Full prompts, memory payloads, or Sophia skill files.
- Persisted Session history, recap state, broad localStorage/Zustand stores, or unrelated archived conversations.
- VAD changes, prompt behavior changes, tool behavior changes, artifact behavior changes, Builder output UI/storage changes, and runtime default changes.

## How To Read It

For a wrong-intent or antecedent-reference failure, inspect the ordered `turnCaptureDiagnostics.events` first, then use summary counters as an index.

Questions to answer in order:

1. Is there a provider `inputTranscription` preview for the full user utterance before assistant output begins?
2. Does the public `sophia.user_transcript` share `source_sequence` or `relay_correlation_id` with that provider input transcription?
3. Did `assistant_output`, `generationComplete`, or `turnComplete` occur before the public user transcript or before the full provider input preview?
4. Did `interrupted`, `toolCallCancellation`, a cancelled `emit_artifact`, or a suppressed tool response occur near the reply?
5. Did `manual_mute_on`, `input_audio_stream_paused`, or `input_audio_stream_end_sent` occur at the failure boundary?
6. Did derived Session stage transitions show the UI moving to speaking/thinking/listening at the expected time?

Interpretation examples:

- Full provider input preview is missing or split before assistant output: suspect Gemini activity detection/turn segmentation.
- Full provider input preview exists before assistant output, but public user transcript is missing: suspect mapper, normalizer, SSE, or Session ingestion.
- Public user transcript exists but has no matching source metadata: inspect provider relay source metadata propagation.
- Tool cancellation appears before artifact/tool evidence: inspect the ledger before assuming an artifact contract miss.
- `audioStreamEnd` appears near the failure: inspect manual mute or stream-pause timing before tuning VAD.

## Official Docs Check

Phase 12.4J did not change Gemini setup. The current setup still omits `realtimeInputConfig`, so Gemini Live uses provider defaults for automatic activity detection, interruption handling, and turn coverage.

Semantics verified from Google Gemini Live documentation during the Phase 12.4I/12.4J audit:

- `BidiGenerateContentSetup.realtimeInputConfig` contains `automaticActivityDetection`, `activityHandling`, and `turnCoverage`.
- Automatic activity detection is enabled by default when unset.
- Default `activityHandling` is `START_OF_ACTIVITY_INTERRUPTS`; `NO_INTERRUPTION` also exists.
- `BidiGenerateContentRealtimeInput` is continuous and concurrent; modality ordering is not deterministic.
- `audioStreamEnd` is the documented marker when the mic/audio stream ends or pauses under automatic activity detection.
- `serverContent.interrupted` means current generation was interrupted; clients should stop and clear playback.
- `inputTranscription` and `outputTranscription` are independent and unordered relative to other server messages.
- `toolCallCancellation` cancels previous tool call ids that should not be executed or should be suppressed if already in flight.
- Gemini 3.1 Flash Live function calling is sequential; async function calling is not supported for that model.

## Manual Smoke Plan

Run these on the production Session path with Gemini explicitly selected, then export the voice telemetry JSON immediately after each run:

- Antecedent reference: say a short statement, pause, then `Quick question before I go. Um, reflect briefly on what I just said.`
- Pause-heavy compound turn: `I think I am in control... but I keep checking... reflect briefly.`
- Manual mute boundary: start a compound utterance, mute, unmute, finish the thought.
- Interruption: begin speaking while Gemini is answering, then inspect `interrupted`, playback flush, and tool cancellation evidence.
- Tool/artifact turn: ask for a normal companion response that should call `emit_artifact`; inspect artifact tool ledger and public artifact evidence.

Decision rule: do not tune VAD or change prompts until at least one bad or borderline run shows whether the failure is provider input capture, public event continuity, assistant output timing, tool/artifact cancellation, or manual stream boundary.

## Validation

Focused tests for this phase:

- `frontend/src/__tests__/lib/voice-telemetry-report.test.ts`
- `frontend/src/__tests__/gemini-browser-live-websocket-dogfood.test.ts`
- `voice/tests/test_gemini_live_provider_adapter.py`
- `voice/tests/test_realtime_normalizer.py`

Validation run:

- Frontend focused Vitest: passed, 2 files / 30 tests.
- Python focused pytest: passed, 33 tests.
- Frontend `pnpm typecheck`: passed.
- Frontend `pnpm lint`: passed with existing warnings in unrelated files.
- Python compileall on edited realtime files: passed.
- Python ruff on edited realtime files/tests: passed.
- `git diff --check`: passed; repository reported CRLF warnings only.

## Next Decision Points

- If evidence shows partial or split provider input transcription before assistant output, consider a dedicated Gemini `realtimeInputConfig` tuning phase.
- If evidence shows provider input is complete but public user transcript is late/missing, debug mapper/normalizer/SSE continuity before VAD.
- If evidence shows artifact/tool cancellation at the boundary, refine cancellation diagnostics or suppression handling before blaming spoken policy.
- If evidence shows complete input and clean public continuity but the reply still binds the wrong antecedent, then consider a Gemini-specific antecedent-resolution prompt or turn memory strategy.