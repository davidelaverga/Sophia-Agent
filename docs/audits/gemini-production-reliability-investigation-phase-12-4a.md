# Gemini Production Reliability Investigation Phase 12.4A

Date: 2026-05-20
Status: investigation only, no behavior fixes implemented
Runtime default: `legacy_cascade`
Investigation branch: `audit/gemini-production-reliability-phase-12-4a`
Source branch: `fix/gemini-production-experience-hardening-phase-12-3`

Gemini production promotion remains gated by `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, and `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true`.

## Scope

This phase was intentionally forensic. It did not implement broad fixes, did not alter runtime behavior, did not change tool semantics, and did not touch prompt files.

Allowed work for this phase:

- Preserve branch safety and avoid `main`.
- Inspect production telemetry supplied by the user.
- Inspect local code paths and prior audit documents.
- Verify Gemini protocol assumptions against official Google documentation.
- Produce a root-cause report and define the next implementation phase.
- Update `COMPOUND_LOG.md` and `docs/common-pitfalls.md` with the learning.

## Branch Safety

- Confirmed work started from `fix/gemini-production-experience-hardening-phase-12-3`, not `main`.
- Created and continued on `audit/gemini-production-reliability-phase-12-4a`.
- Preserved existing dirty worktree state. The investigation observed a large pre-existing dirty tree and did not revert or normalize unrelated changes.

## Production Evidence

The latest production Session telemetry showed a split-brain runtime: provider transport was alive, but public Sophia event correctness was broken.

Healthy transport evidence:

- `runtime: gemini_live`
- WSS connected and setup complete.
- Provider relay active.
- Public SSE connected.
- Microphone connected.
- Remote output audio active.
- `providerEventCount: 927`
- `outputAudioEventCount: 620`
- `lastOutputAudioAt` present.

Broken public event evidence:

- Health banner: `Audio detected, transcript missing.`
- `lastUserTranscriptAt: null`
- `lastAssistantTranscriptAt: null`
- `counts.userTranscripts: 0`
- `counts.assistantTranscripts: 0`
- `artifactToolCallCount: 4`
- `artifactCount: 0`
- `builderToolCallCount: 6`
- `builderEvents: 0`
- `toolCallCount: 10`
- `toolResponseCount: 9`
- `toolRejectionCount: 2`
- `toolCancellationCount: 8`
- `lastToolPhase: "tool_call_cancelled"`

No local production report file containing these exact metrics was found in `logs/` or repository documents during the investigation. The user-provided telemetry above is therefore the primary production evidence.

## Official Google Grounding

Official sources checked:

- `https://ai.google.dev/gemini-api/docs/live`
- `https://ai.google.dev/api/live`
- `https://ai.google.dev/gemini-api/docs/live-tools`
- `https://ai.google.dev/gemini-api/docs/live-guide`
- `https://ai.google.dev/gemini-api/docs/live-session`

Verified protocol facts relevant to this incident:

- Live API is a stateful WebSocket protocol. Client messages are `setup`, `clientContent`, `realtimeInput`, or `toolResponse`.
- The first client message is `setup`; clients should wait for `setupComplete` before sending additional messages.
- For native audio output, transcripts require `inputAudioTranscription` and `outputAudioTranscription` in setup.
- `inputTranscription` and `outputTranscription` are independent server-content fields with no guaranteed ordering relative to other server messages.
- `serverContent.interrupted` means a client message/activity interrupted current model generation. Google explicitly says clients playing audio in real time should stop playback and clear queued audio when this arrives.
- `generationComplete` is absent for interrupted turns; interrupted turns go through `interrupted` then `turnComplete`.
- `toolCallCancellation` notifies clients that previously issued tool call ids should not have been executed and should be cancelled. If side effects occurred, clients may attempt to undo them. Google says this occurs when clients interrupt server turns.
- With automatic VAD, if the audio stream is paused for more than about a second, for example because the user switched off the microphone, the client should send `audioStreamEnd` to flush cached audio. The stream can resume later by sending audio again.
- The connection lifetime is around 10 minutes. Session resumption must be explicitly configured if the same Live session should survive connection resets.
- Gemini 3.1 Flash Live Preview has sequential function calling: the model will not start responding until a tool response is sent. The current Sophia builder wrapper can still launch an async backend task quickly, but the Gemini protocol-level function call itself is synchronous.

## Code Evidence Map

### Browser Gemini Transport

`frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts` owns the browser Live WSS connection. It:

- Opens the Gemini WSS using the ephemeral token returned by backend bootstrap.
- Sends the locked setup payload.
- Waits for `setupComplete` before starting microphone audio.
- Sends PCM16 16 kHz microphone frames through `realtimeInput.audio`.
- Relays provider server messages to the backend asynchronously.
- Sends backend-returned `toolResponse.functionResponses[]` over the existing WSS.
- Counts `toolCall` and `toolCallCancellation` locally before backend relay completion.
- Flushes scheduled output PCM when `serverContent.interrupted` arrives.

Important current behavior: `startMicrophoneAudioPipeline` continues its audio processor until the Gemini connection is closed. Manual mute disables the media track, but the pipeline itself is not stopped and does not send `audioStreamEnd`.

### Frontend Session Hook

`frontend/src/app/hooks/useStreamVoiceSession.ts` owns the production Session hook. It:

- Branches to Gemini when `/voice/connect` returns Gemini production credentials.
- Opens the Gemini connector.
- Opens public SSE for `sophia.*` events.
- Counts provider events and output audio directly from WSS callbacks.
- Counts public transcripts, public artifacts, and public builder events from normalized `sophia.*` events.
- Sets stage to `listening` on Gemini `streaming_audio`, interruption, and `sophia.turn` `agent_ended`.
- `muteMic` disables local tracks and sets `isMuted=true`, but later stage changes can set the UI back to listening without consulting the mute intent.

Important current behavior: transcript telemetry is public-event telemetry. Zero transcript counts mean the active Session telemetry boundary did not receive `sophia.user_transcript` or `sophia.transcript` events.

### Backend Gemini Relay and Normalizer

`voice/realtime/gemini_browser_dogfood.py` receives browser-captured provider events. It:

- Extracts function calls and cancellation ids.
- Stores cancelled ids per session.
- Executes allowed Sophia tools through the backend tool executor.
- Returns Gemini-compatible `client_actions.gemini_tool_response` for the browser to send.
- Pushes the raw provider event into the dogfood session for mapping and public normalization.
- Publishes `sophia.builder_task` only from successful builder lifecycle tool executions that have task records.

`voice/realtime/gemini_live.py` maps Gemini server messages. It:

- Maps `serverContent.inputTranscription` to `USER_TRANSCRIPT_FINAL`.
- Maps `serverContent.outputTranscription` and `modelTurn.parts[].text` to assistant text events.
- Maps `serverContent.interrupted` and `toolCallCancellation` to interruption events.
- Maps `toolCall.functionCalls[].name == emit_artifact` to `ARTIFACT_PAYLOAD` from the tool-call arguments.
- Maps builder tool calls to internal builder candidates until backend execution publishes a trusted public task payload.

`voice/realtime/normalizer.py` maps provider events to public `sophia.*` events. It:

- Emits `sophia.user_transcript` only for final user transcripts with non-empty text.
- Emits `sophia.transcript` for assistant text partial/final events with non-empty text.
- Emits `sophia.artifact` from `ARTIFACT_PAYLOAD`.
- Emits `sophia.builder_task` from `BUILDER_TASK_PAYLOAD`.
- Emits `sophia.turn_diagnostic` for metrics, provider errors, cancellations, and interruptions.

## Root-Cause Findings

### P0: Public Event Boundary Failure Despite Healthy Audio Transport

Severity: critical
Confidence: high for boundary failure, medium for exact layer

The production telemetry proves the Gemini WSS path was alive and delivering audio, while the public Sophia event layer did not deliver transcript, artifact, or builder state.

Evidence:

- `providerEventCount` and `outputAudioEventCount` were high.
- Both transcript counts were zero.
- `artifactToolCallCount` was nonzero, while `artifactCount` was zero.
- `builderToolCallCount` was nonzero, while `builderEvents` was zero.
- Session metrics count transcripts/artifacts/builder events at the normalized public `sophia.*` boundary, not just in React rendering.

Most likely failure class:

- Provider events reached the browser and audio playback worked, but the relay -> backend mapper -> normalizer -> SSE -> Session ingestion chain did not consistently produce or deliver public `sophia.*` events.

What is not yet proven:

- Whether Google did not send transcription fields despite setup.
- Whether the browser failed to relay transcription-bearing events.
- Whether backend normalization dropped transcription-bearing events.
- Whether the voice/gateway/Next SSE chain lost already-normalized events.

Why this matters:

- The production UI can look connected and sound alive while Sophia continuity, transcript, artifact, and builder state are absent. Transport health is insufficient for dogfood readiness.

### P0: Tool Cancellation Race Can Leave Gemini Waiting or Produce Stale Tool Responses

Severity: critical
Confidence: high

Google documents `toolCallCancellation` as a signal that specified tool calls should not be executed and should be cancelled, with possible undo for side effects. It occurs when clients interrupt server turns.

Current code counts cancellation immediately when the browser receives a provider cancellation event. Backend relay cancellation protection, however, only prevents future or not-yet-started executions for ids already in the per-session cancelled set. If the original `toolCall` relay request already began executing a backend tool, a later cancellation does not abort that in-flight execution and does not necessarily suppress the stale `toolResponse` that the browser sends back after the provider cancelled the call.

Evidence:

- Production reported `toolCallCount: 10`, `toolResponseCount: 9`, and `toolCancellationCount: 8`.
- `lastToolPhase` was `tool_call_cancelled`.
- Frontend relay sends returned `toolResponse` actions over WSS without checking a cancellation ledger at send time.
- Backend execution records cancelled ids before execution only for cancellations already known to that relay request.

Likely user-visible effects:

- Sophia may stop responding after interruption-heavy tool turns because Gemini 3.1 function calling is sequential and waits for tool-response resolution.
- Cancelled `emit_artifact` calls may not produce public companion artifacts.
- Builder lifecycle calls may be cancelled or rejected before public builder UI state appears.
- Stale tool responses after cancellation may confuse provider turn state.

### P0: Companion Artifact Gap Is Not a Simple UI Rendering Bug

Severity: critical
Confidence: high

Production showed `artifactToolCallCount: 4` but `artifactCount: 0`.

Current code is supposed to emit `sophia.artifact` from an `emit_artifact` Gemini `toolCall` after the browser relays the provider event to the backend. The backend test suite has coverage for the happy path where an `emit_artifact` tool call produces a public artifact. Therefore, a nonzero artifact tool-call count with zero public artifact count means the failure happened before or at the public event boundary, not merely in the Presence panel renderer.

Plausible exact causes:

- The `emit_artifact` tool-call events were seen by the browser but not successfully relayed to the backend.
- The backend relay/normalizer emitted the artifact before the Session SSE subscriber was attached or during a transient SSE gap, and there is no replay on the Gemini public event stream.
- Tool-call cancellation/interrupt timing caused the relay path to classify the turn as cancelled before public artifact ingestion reached the Session.
- The raw provider event shape differed from covered fixtures and the mapper did not produce `ARTIFACT_PAYLOAD`.

What is not supported by the evidence:

- A claim that the model never attempted `emit_artifact`. It attempted it at least four times.
- A claim that only the artifact panel parser is broken. `artifactCount` is zero at the telemetry boundary.

### P0: Builder Tool Calls Are Not Becoming Visible Builder State

Severity: high
Confidence: high for event gap, medium for exact cause

Production showed `builderToolCallCount: 6` but `builderEvents: 0`, with null builder task id/status.

Current Session UI can render builder tasks and has polling/completion SSE support once it receives a trusted task id. The missing production layer is the transition from Gemini builder lifecycle tool calls to public `sophia.builder_task` state.

Known behavior:

- `start_builder_task` success can publish a `sophia.builder_task` event with task id and status.
- Unknown task ids are treated as recoverable execution rejections and do not publish builder task state.
- Cancelled/rejected executions are skipped by the public builder-task publisher.

Likely causes:

- Gemini called lifecycle tools with invented or stale task ids, producing execution rejections.
- Tool cancellations interrupted builder lifecycle calls before a successful trusted task payload was published.
- A successful public builder task event was emitted but missed by the public SSE Session boundary.

This is not primarily a storage/download UI failure. Without an initial task id, the existing UI cannot poll task status or subscribe usefully for completion.

### P1: Manual Mic-Off Has No Durable Source of Truth

Severity: high
Confidence: high

Manual mic-off is currently implemented as a local track toggle plus stage change:

- Gemini `muteMic` disables audio tracks and sets `isMuted=true` and `stage=idle`.
- The audio pipeline continues to run.
- The UI button active state is derived from `voiceStatus === 'listening'`, not from `isMuted` or user mic intent.
- Gemini callbacks later set `stage='listening'` on interruption, `streaming_audio`, or `sophia.turn` `agent_ended` without checking `isMuted`.
- The mic button click handler checks `stage === 'listening'` before checking `hasLiveCall && isMuted`, so a muted-but-listening state can call mute again instead of unmute.

Official Google docs add a protocol requirement: when the audio stream is paused because the user switched off the microphone, clients should send `audioStreamEnd` with automatic VAD to flush cached audio. Current manual mute does not send `audioStreamEnd`.

Likely user-visible effects:

- The UI can show the mic as active again after a manual mute.
- The provider may keep receiving silence frames rather than an explicit stream-end signal.
- User intent is recoverable only by indirect stage transitions, which are not a reliable mute authority.

### P1: Transcript Lag and Transcript Disappearance Are Distinct Problems

Severity: medium for lag, critical for disappearance
Confidence: high

The previous phase added Gemini transcript pacing, and official docs confirm `outputTranscription` is independent of audio timing and has no guaranteed ordering. Pacing can explain delayed or chunked visible transcript updates.

Pacing cannot explain the latest production telemetry's zero transcript counts because those counts are captured before visible rendering/pacing decisions. The disappearance problem is therefore upstream of UI pacing: provider transcription emission, relay, normalization, SSE, or Session ingestion.

Next work should keep these diagnoses separate.

### P2: Session Resumption Is Not Yet a Root Cause, But It Is a Reliability Gap

Severity: medium
Confidence: medium

Google documents that Live API connection lifetime is around 10 minutes and session resumption must be configured to survive connection resets. Current setup does not include `sessionResumption` handling in the production Gemini path.

The latest report does not prove a resumption failure, because transport remained connected during the observed issue. However, production hardening should track this separately before longer dogfood sessions are considered reliable.

## Severity and Priority

| Priority | Finding | User impact | Next action |
|---|---|---|---|
| P0 | Public event boundary failure | Audio works but transcript/artifact/builder continuity disappears | Add correlated provider -> relay -> normalizer -> SSE counters and reproduce |
| P0 | Tool cancellation race | Sophia can stall or send stale tool responses after interruption | Add cancellation ledger and cancellation-timing fixture, then suppress stale send-back |
| P0 | Artifact tool calls without public artifacts | Companion turn contract broken | Correlate `emit_artifact` call ids with backend `ARTIFACT_PAYLOAD` and public `sophia.artifact` |
| P0 | Builder tool calls without builder UI state | Builder appears absent or stuck | Correlate lifecycle call ids/status with trusted task id publication |
| P1 | Manual mic-off reactivates visually/protocol-wise | User cannot trust mic state | Introduce durable user mic intent, frame gate, and `audioStreamEnd` on mute |
| P1 | Transcript lag | Text feels delayed even when present | Measure provider transcription timing separately from pacer timing |
| P2 | No session resumption | Longer sessions risk reset/data loss | Track after P0 reliability fixes |

## Reproduction Protocol for Next Phase

Run on the production route candidate, not the debug page:

- Flags: `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true`.
- Entry point: `/session`, normal mic button, `/voice/connect` response-driven Gemini branch.
- Export the Session telemetry/capture after each scenario.

Scenarios:

1. Transcript boundary: speak two short utterances, wait for two assistant replies, then verify provider event counts, `inputTranscription`/`outputTranscription` provider-category counts, public transcript counts, and final visible messages.
2. Artifact boundary: ask a normal companion question and wait for turn completion. Verify every `emit_artifact` tool-call id maps to backend artifact provider events and public `sophia.artifact`.
3. Cancellation boundary: start a tool-heavy or builder turn, interrupt during the tool call, and verify no cancelled id is executed or sent back after cancellation.
4. Builder boundary: ask for a small builder deliverable. Verify `start_builder_task` success produces a trusted task id, public `sophia.builder_task`, UI running card, status polling, terminal completion, and downloadable artifact if produced.
5. Manual mute: start voice, click mic off while listening, wait through an assistant turn and interruption, and verify UI remains muted, no microphone frames are sent while muted, `audioStreamEnd` is sent once, and explicit unmute resumes audio.

## Exact Next Implementation Phase

Next phase: **Phase 12.4B Gemini Production Reliability Instrumentation and Minimal Fixes**.

Phase 12.4B should be split into two ordered parts.

### 12.4B-1: Evidence Capture First

Implement diagnostic instrumentation only, with no broad behavior changes:

- Add per-session provider event category counters in the browser: `setupComplete`, `serverContent`, `inputTranscription`, `outputTranscription`, `modelTurnAudio`, `modelTurnText`, `toolCall`, `toolCallCancellation`, `goAway`, `sessionResumptionUpdate`, and `usageMetadata`.
- Add relay attempt/success/failure/duration counters by provider event category. Include response HTTP status and whether relay response carried `client_actions` or `tool_diagnostics`.
- Add backend relay counters per session: raw provider events accepted, function calls extracted by id/name, cancellations seen by id, tool execution started/finished/rejected/skipped, provider events pushed to the mapper, provider event types emitted, and public `sophia.*` event types emitted.
- Add a short-lived diagnostic endpoint or export blob for a single active Gemini session that contains counters and correlation ids without raw transcript text or raw audio.
- Add tool-call correlation in frontend capture: for each id, record `received_at`, `name`, `cancelled_at`, `relay_completed_at`, `backend_accepted_at`, `tool_response_sent_at`, and `send_suppressed_at` if applicable.
- Add focused fixtures for `toolCall` followed by immediate `toolCallCancellation`, including `emit_artifact` and `start_builder_task` cases.

Exit criteria for 12.4B-1:

- A reproduced production run can identify whether transcript/artifact/builder loss occurs at provider emission, browser relay, backend normalization, gateway/Next SSE, or Session ingestion.
- Tool cancellation timelines can prove whether stale `toolResponse` send-back occurs after cancellation.

### 12.4B-2: Minimal Targeted Fixes

Implement only fixes supported by 12.4B-1 evidence:

- Add a cancellation-aware send-back guard so the browser does not send `toolResponse` for ids cancelled before relay completion.
- Add backend in-flight cancellation handling or side-effect compensation for builder launches when cancellation arrives after execution starts.
- Ensure `emit_artifact` public event generation is not blocked behind slow tool execution and is observable at the public `sophia.artifact` boundary.
- Add small replay or late-subscription recovery for the Gemini public SSE stream if evidence shows events are emitted before the Session subscriber receives them.
- Make manual mic mute a durable user intent: stage changes must not visually reactivate the mic while muted, audio frames must be gated while muted, and automatic-VAD sessions should send `audioStreamEnd` on mute.
- Publish builder task state only from trusted backend lifecycle state, but guarantee a successful `start_builder_task` produces a public `sophia.builder_task` event visible to the Session UI.

Explicit non-goals for Phase 12.4B:

- No prompt rewrite.
- No broad frontend Session redesign.
- No replacement of Gemini Live with another provider.
- No builder storage/download overhaul unless the reproduced evidence reaches that layer.
- No changes to `soul.md` or the companion prompt architecture.

## Final Assessment

The latest production issue is not one bug. It is a reliability break at the seam between a healthy browser-owned Gemini audio transport and Sophia's public continuity contract.

The urgent work is not to tune UI text or rebuild the voice stack. The urgent work is to add correlation across four boundaries that are currently only loosely connected in telemetry:

1. Gemini provider event received in browser.
2. Provider event relayed and accepted by backend.
3. Provider event mapped/normalized into `sophia.*`.
4. Public event ingested by the Session runtime.

Once those counters identify the failing layer, the next fixes should stay small and targeted: cancellation-aware tool send-back, reliable public artifact/builder publication, and a durable manual mic-off contract.