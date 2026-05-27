# Gemini Co-review Media Transport Spike

Date: 2026-05-26
Branch: `spike/gemini-coreview-media-transport`
Baseline: `8c10fdc3`
Prior spike: `c3d11f93` (`spike/gemini-screenshare-coreview`)

## Decision

Option B is feasible as a product architecture, but continuous media co-review is not implemented by the current repo path.

The current Sophia Gemini voice path remains the browser-owned Gemini Live WebSocket audio/tool relay. It sends microphone PCM and text over JSON messages and handles `toolCall` / `toolResponse`, but it has no implemented `send_frame`, `send_image`, `attach_video_track`, `RTCPeerConnection`, `addTrack`, or `replaceTrack` path for Gemini visual input.

The official Gemini Live API reference documents WebSocket sessions that can exchange text, audio, or video, receive function call requests, use `BidiGenerateContentRealtimeInput.media_chunks[]`, and report `UsageMetadata` including image count, video duration, and audio duration. It also notes that audio inputs/outputs can negatively affect function calling. That makes a media-capable Gemini path plausible, but this repo does not currently contain the adapter needed to prove it end to end.

Recommendation: keep normal voice untouched and proceed with a feature-flagged still-frame/artifact-canvas proof before any continuous video implementation. Continuous media should wait for a real Gemini media adapter or provider path change that can be tested with artifact-scoped frames and tool/sideband behavior.

Follow-up result on `spike/gemini-coreview-still-frame-input-clean`: the fixture still-frame proof passed manual provider smoke at commit `38583674` using the corrected `realtimeInput.video` payload. Sophia could keep talking while the Q3 Launch Review fixture was open, the app showed `Sophia is looking at this artifact`, and Sophia could discuss the artifact contents after one still frame. This proves the guarded fixture path only. Continuous video remains unproven, exact text/numbers still require `read_artifact_text`, and the guarded real-artifact metadata canvas path is implemented locally but still needs its own provider smoke.

## Current Normal Voice Path

Code map:

- `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`
  - opens the Gemini Live WebSocket from the browser.
  - requests `getUserMedia({ audio: true })`.
  - converts WebAudio input to PCM.
  - sends `realtimeInput.audio` JSON messages.
  - sends text as `realtimeInput.text`.
  - reads output audio from `serverContent.modelTurn.parts[].inlineData`.
  - categorizes `toolCall`, `toolCallCancellation`, and `usageMetadata`.
- `voice/realtime/gemini_browser_dogfood.py`
  - owns production browser-session metadata and relayed provider events.
  - does not open a media-capable Gemini session on the backend.
- `voice/realtime/gemini_tool_loop.py`
  - executes approved Sophia backend tools from Gemini `toolCall` events.
  - returns `toolResponse.functionResponses`.
- `voice/realtime/sophia_backend_tools.py`
  - declares `emit_artifact`, builder lifecycle tools, and `retrieve_memories`.

Normal voice has tool support today. It does not have visual input today.

## Candidate Media-capable Path

Candidate provider path:

- Gemini Live WebSocket with `BidiGenerateContentRealtimeInput.media_chunks[]` from the current Google Cloud reference.
- Tool response remains `BidiGenerateContentToolResponse`.
- Usage metadata can potentially report visual cost via `image_count` and `video_duration_seconds`.

Current repo follow-up:

- The post-`38583674` still-frame implementation uses `realtimeInput.video` with `{ mimeType, data }`.
- `media_chunks[]` / `mediaChunks` remains provider-reference context here, not the current repo's still-frame payload shape.

Original transport-spike repo blockers:

- At the original transport-spike baseline, the frontend Gemini path sent only audio/text JSON and had no media encoder.
- Current backend `GeminiLiveProviderSession` exposes `send_audio`, `send_text`, and `send_tool_result`, but no image/frame/video methods.
- No Gemini WebRTC path exists in this repo.
- Installed Vision Agents exposes generic `video_track`, `video_queue`, and `video_forwarder` helpers, but no wired Gemini WebRTC or screen-share mode in this app.
- Artifact rendering is DOM-first; safe visual input needs a canvas source or clean offscreen renderer.

## Dual-path State Machine

The spike adds a typed state machine in `frontend/src/app/lib/co-review-transport.ts`.

States:

- `normal_voice`
- `co_review_starting`
- `co_review_live`
- `co_review_stopping`
- `normal_voice_restored`
- `co_review_error`

Tracked fields:

- `normalSessionId`
- `coReviewSessionId`
- `artifactId`
- `sessionId`
- `threadId`
- `visualInputStatus`
- `toolAvailability`
- `startedAt`
- `stoppedAt`
- `error`
- `transportKind`
- `videoOrFrameMode`
- latency/cost telemetry fields

Implemented transport:

- `AudioWebSocketUnsupportedTransport`
  - reports `continuousVideoSupported=false`.
  - reports `stillFramesSupported=false`.
  - reports `toolsSupportedInCoReview=false`.
  - transitions to `co_review_error` with `current_gemini_audio_websocket_has_no_artifact_media_input`.

Interface:

- `startCoReview({ sessionId, threadId, artifactId, visualSource })`
- `stopCoReview()`
- optional `sendFrame(frame)`
- optional `attachVideoTrack(track)`
- `status()`
- `supportsTools()`
- `supportsContinuousVideo()`
- `supportsStillFrames()`

## Artifact Visual Source

The spike adds `frontend/src/app/lib/co-review-capture.ts`.

Capture policy:

- Canvas-only.
- Finds canvases marked by artifact-specific data attributes.
- Uses `canvas.captureStream(frameRate)` when available.
- Stops all tracks on exit/error.
- Returns `unsupported` if no artifact canvas exists.
- Returns `unsupported` if only DOM is available.
- Never calls `getDisplayMedia`.
- Never captures whole screen, tab, browser chrome, or document body.

Current app implication:

- The artifact panel is still DOM-first overall.
- A guarded builder-artifact metadata/overview canvas now exists behind `NEXT_PUBLIC_SOPHIA_COREVIEW_REAL_ARTIFACT_ENABLED`.
- Companion takeaway/reflection/memory DOM artifacts still report unsupported until a safe renderer exists.

## Tool Policy

The spike adds `voice/realtime/coreview.py`.

Policy:

- `read_artifact_text` is feature-flagged by `SOPHIA_GEMINI_COREVIEW_ENABLED`.
- Gemini declarations stay unchanged when the flag is off.
- The prompt overlay appears only when the flag is on.
- The stub returns disabled/unimplemented safe status and never includes raw artifact text or raw query text.
- Exact words, numbers, table values, citations, and labels must come from the trusted backend reader, not from screen vision.

If media tools are unavailable:

1. User asks a precise text/data question.
2. App/backend calls trusted `read_artifact_text` sideband using artifact id and thread/session context.
3. Only the answer needed for the co-review response is injected into the response path.
4. Telemetry stores lengths, flags, ids, status, and latency only.

This spike does not fake tool parity for a media path.

## UX Scaffold

The spike adds `frontend/src/app/components/session/CoReviewControls.tsx` and `frontend/src/app/hooks/useArtifactCoReview.ts`.

Rules:

- Entry is feature-flag gated by `NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED`.
- The control exposes `Review Together`.
- The visible indicator appears only in `co_review_live`: `Sophia is looking at this artifact`.
- `Stop Looking` calls the stop lifecycle and returns to normal voice restored state.
- Status labels include:
  - `continuous unsupported`
  - `media session connecting`
  - `media session live`
  - `still-frame mode`
  - `tool unavailable`

The scaffold remains off by default and only reaches the production artifact panel when the guarded fixture or real-artifact flags are enabled.

## Telemetry

Allowed safe telemetry fields:

- `normalVoiceSessionId`
- `coReviewSessionId`
- `transportKind`
- `visualTransportSupported`
- `toolsSupportedInCoReview`
- `coReviewStartLatencyMs`
- `coReviewStopLatencyMs`
- `normalVoicePaused`
- `normalVoiceRestored`
- `sessionHandoffMs`
- `videoOrFrameMode`
- `frameCount`
- `estimatedVisualCost`

Disallowed:

- raw frames
- screenshots
- video/audio files
- raw artifact text
- raw user query text
- provider tokens
- WebSocket credentials

## Key Questions

1. What Gemini Live APIs or Vision Agents APIs are available in this repo for video/media input?
   - Gemini Live code exists, but app adapters expose audio/text/tool methods only. Vision Agents has generic video helpers, not a wired Gemini co-review transport.

2. Does the installed Vision Agents package expose a Gemini WebRTC or screen-share mode?
   - No app-integrated mode was found. The package exposes generic video utilities such as `video_track`, `video_queue`, and `video_forwarder`.

3. Is there an example in dependencies/docs/tests for adding a video track?
   - Generic `aiortc.VideoStreamTrack` helpers exist in Vision Agents. No Gemini-specific add-track example is wired into Sophia.

4. Can the current backend voice service start a media-capable Gemini session separate from the browser WebSocket path?
   - Not currently. Backend production Gemini session routes observe browser-relayed provider events and do not mint/start a separate media session.

5. Does the media-capable path support tools/function calls?
   - Official Gemini Live reference supports tool calls in sessions. Tool parity for a separate Sophia media path remains unproven because no media path exists in repo code.

6. If media path does not support tools, can `read_artifact_text` be done sideband through app events?
   - Yes as an architecture. This spike adds the feature-flagged tool contract/stub and documents the sideband plan. The trusted artifact reader is not wired yet.

7. Can normal voice session stay alive while co-review media session runs?
   - Unknown until a real second session exists. The state machine tracks `normalVoicePaused` and `normalVoiceRestored`.

8. Or must normal voice pause/close while co-review is active?
   - Unknown. The safest first implementation should pause/mute one audio path if duplicate microphones or duplicate audio output appear.

9. How does audio input/output route in the media-capable path?
   - Not implemented. Current audio routes through the browser WebSocket normal voice path only.

10. Does co-review session need a separate voice connection UI state?
    - Yes. The state machine has `co_review_starting`, `co_review_live`, `co_review_stopping`, and `co_review_error`.

11. Can user transition back to normal voice without duplicate greeting?
    - Architecturally yes if session/thread context is preserved and normal voice is restored rather than restarted as a new Sophia session. Not proven manually.

12. Can session/thread context be transferred safely?
    - The state machine carries `sessionId` and `threadId`. Prompt/tool side must use trusted backend context and avoid copying raw artifact text into telemetry.

13. Can current artifacts be re-rendered into a clean canvas source?
    - Not generally today. DOM-first artifacts need a canvas renderer or safe still-frame renderer.

14. Can visual input be sent as video track, image frame chunks, periodic stills, or not at all?
    - Original transport-spike app: not at all. Provider reference context: media chunks/video under realtime input. Follow-up still-frame implementation: `realtimeInput.video` from an artifact canvas/fixture.

15. What provider billing/usage metadata is available for visual input?
    - Official Gemini Live `UsageMetadata` includes `image_count`, `video_duration_seconds`, and `audio_duration_seconds`.

16. What telemetry can capture cost/latency without raw frames?
    - The safe fields listed above, plus provider usage counters if/when exposed by the session.

17. What exact blockers remain?
   - No Gemini media adapter in repo, no safe renderer for current DOM-only artifacts, tool parity unproven for a second media session, audio routing not proven, and no manual provider test yet for the guarded real-artifact canvas path.

## Privacy Confirmation

- No whole-screen capture.
- No whole-tab capture.
- No browser chrome capture.
- No screenshots/video/audio frames stored.
- No raw artifact text in telemetry.
- No provider tokens in telemetry.
- Co-review is explicit and feature-flagged.
- Looking indicator is required during live co-review.
- Exit stops visual input tracks.
- Feature flags default off.

## Test Coverage Added

Frontend:

- Feature flag off hides co-review entry.
- State machine starts in `normal_voice`.
- Starting co-review enters `co_review_starting`.
- Unsupported transport enters `co_review_error`.
- Stopping returns to `normal_voice_restored`.
- Looking indicator only appears during `co_review_live`.
- Capture never falls back to whole-screen `getDisplayMedia`.
- Safe telemetry excludes raw frame/text fields.

Voice/backend:

- `read_artifact_text` remains feature-flagged.
- Co-review prompt appears only when enabled.
- Normal voice declarations unchanged when flag off.
- Detection reports unsupported safely.
- Tool parity status is reported.

## Recommendation

Do not proceed directly to continuous media co-review. Use the passed still-frame fixture proof plus the guarded real-artifact metadata canvas as the local implementation path:

1. Keep normal voice unchanged.
2. Keep co-review/still-frame/fixture flags default off.
3. Run a manual provider smoke on the guarded real-artifact path.
4. Encode a single frame or explicit user-triggered refresh frames through the current `realtimeInput.video` still-frame payload.
5. Route exact data questions through the trusted `read_artifact_text` sideband.
6. Measure setup latency, stop latency, usage metadata, image count, and tool-call behavior.

Still do not proceed to continuous media/video until the provider transport and production UX can be tested cleanly.
