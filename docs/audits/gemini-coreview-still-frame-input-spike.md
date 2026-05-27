# Gemini Co-review Still-frame Input Spike

Date: 2026-05-26 / 2026-05-27 local
Branch: `spike/gemini-coreview-still-frame-input-clean`
Baseline: `8c10fdc3`
Commit tested: `38583674` (`spike: harden coreview still-frame websocket lifecycle`)
Prior dual-path commit carried forward: `bfaac662`

## Goal

Prove the next smallest visual-input path for Gemini co-review: encode only the active artifact canvas into a capped still frame and attempt to send that frame through the current Gemini Live WebSocket route, without changing normal voice behavior.

## Provider Reference

The current Google Cloud Gemini Live reference says a WebSocket session can send text, audio, or video to Gemini and receive audio, text, or function call requests. Client messages include `realtimeInput`, and the reference describes that realtime input can carry audio or video. It also documents function call requests and `UsageMetadata` fields including image count, video duration, and audio duration.

Repo reality is narrower:

- Current Sophia browser Gemini path sends `realtimeInput.audio`, `realtimeInput.text`, and `toolResponse`.
- This spike adds an experimental `realtimeInput.mediaChunks[]` still-frame sender behind a separate still-frame flag.
- A manual provider smoke after `38583674` confirmed provider-visible still-frame co-review for the fixture path.
- Continuous video/screen-share is still unproven on the current transport.
- Exact words, numbers, table values, labels, citations, and data still require `read_artifact_text` or another trusted sideband text path.

## Feature Flags

- `NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED`: default off.
- `NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED`: default off; frontend build/runtime still-frame flag used by the browser adapter.
- `NEXT_PUBLIC_SOPHIA_COREVIEW_FIXTURE_ENABLED`: default off; fixture launcher is available only when co-review and still-frame are also enabled.
- `SOPHIA_GEMINI_COREVIEW_ENABLED`: default off; backend coreview/read-artifact-text prompt and tool gate.
- `SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED`: default off; backend-side still-frame support flag.
- `SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED`: remains off; no screen-share path added.

The flag helpers only treat explicit truthy values (`1`, `true`, `yes`, `on`) as enabled. No production path is enabled by default.

## What Changed

Frontend artifact frame source:

- `co-review-capture.ts` now supports a `mode: "still_frame"` lookup that returns a canvas element without requiring `canvas.captureStream`.
- Stream mode still requires `captureStream`.
- DOM-only artifacts remain unsupported.
- `getDisplayMedia` is never called.

Frame encoder:

- `co-review-frame.ts` renders the active artifact canvas into a clean new canvas.
- Longest edge is capped to 1024px by default.
- JPEG is the default payload format with compression attempts.
- Default byte cap is 512 KiB.
- Telemetry exposes byte size, dimensions, MIME type, and `rawFrameExcluded`.
- Telemetry never includes base64 or raw image bytes.

Gemini sender:

- `gemini-browser-live-websocket-dogfood.ts` exposes `sendArtifactFrame(frame)` on the existing browser Live connection.
- When the still-frame flag is off, it returns `coreview_still_frame_feature_flag_disabled` and sends nothing.
- When the flag is on, it sends:

```json
{
  "realtimeInput": {
    "mediaChunks": [
      {
        "mimeType": "image/jpeg",
        "data": "<base64 omitted>"
      }
    ]
  }
}
```

State machine:

- `GeminiStillFrameTransport` sends one encoded artifact frame on co-review start.
- Successful WebSocket send enters `co_review_live` with `videoOrFrameMode="still_frame"`.
- `Stop Looking` stops visual source tracks and blocks future sends on that transport instance.

Voice/prompt:

- The co-review prompt explicitly states still-frame co-review is single-frame or low-rate artifact canvas input, not continuous video.
- Exact words, numbers, table values, labels, citations, and data still require `read_artifact_text`.
- `read_artifact_text` remains feature-gated.

## Answers

### 1. Can we encode a clean artifact frame safely?

Yes, for artifact canvases. The encoder creates a new clean canvas and draws only the active artifact canvas into it. It caps dimensions and bytes. DOM-only artifacts still return unsupported.

### 2. Can the current Gemini WebSocket route send image/media chunks?

The route can construct and send a `realtimeInput.mediaChunks[]` JSON payload when the still-frame flag is on. Local tests prove browser-side payload construction and WebSocket send mechanics. The manual provider smoke proved the fixture path is provider-visible at least once.

### 3. If yes, does Gemini react to the visual frame?

Yes for the guarded fixture path. In the manual provider smoke, Sophia entered the looking state, stayed voice-responsive, and could recognize/discuss the visible Q3 Launch Review fixture contents after the still frame was sent.

This does not prove continuous video, whole-screen capture, multiple-frame reliability, or real artifact rendering.

### 4. Can tools still work?

Normal tool setup is unchanged, and the still-frame sender uses the same Live WebSocket session. Existing tool declaration tests still pass. The manual smoke proved voice remained responsive after the media chunk. Exact text/data tool integration and broader tool-call reliability after media still need dedicated coverage.

### 5. What latency/cost does one frame or 1 FPS stills add?

The spike measures:

- `frameSendLatencyMs`
- `frameBytes`
- `frameDimensions`
- `frameSentCount`
- `providerAcceptedFrame`
- `visualResponseObserved`
- `toolCallStillWorks`

No real provider billing was measured. Once a live run is available, `UsageMetadata.image_count` and related fields should be sampled.

### 6. Does small text require `read_artifact_text` as expected?

Yes by policy. Visual frames are for layout/composition/color/rough structure only. Exact text/data still goes through the trusted backend text reader or sideband plan.

## Privacy Confirmation

- No whole-screen capture.
- No whole-tab capture.
- No browser chrome capture.
- No document body capture.
- No `getDisplayMedia`.
- No raw frames or screenshots committed.
- No raw artifact text telemetry.
- Feature flags default off.
- Co-review is explicit and indicator-gated.
- Stop Looking disables future frame sends.

## Manual provider smoke — PASS

Date: 2026-05-26 / 2026-05-27 local

Branch: `spike/gemini-coreview-still-frame-input-clean`

Commit tested: `38583674`

Result:

- The Coreview fixture launched successfully.
- The Q3 Launch Review fixture artifact was visible.
- `Review Together` entered the looking state and displayed `Sophia is looking at this artifact`.
- Still-frame mode was active.
- The user could keep speaking with Sophia while the fixture artifact was open.
- Sophia recognized and discussed the artifact contents.
- No screen-share prompt appeared.
- No whole-screen capture was used.
- No raw frame telemetry was added.

Interpretation:

- Still-frame artifact co-review is viable as a guarded proof of concept.
- The fixture path is proven for at least one provider-visible still frame.
- Continuous live video/screen-share remains unproven and is still a no-go on the current transport.
- Real artifact integration still needs a clean artifact canvas/offscreen renderer path.
- Exact text and numeric answers still require `read_artifact_text` or an equivalent trusted sideband text path.

Remaining unknowns:

- Provider usage metadata / `image_count` visibility.
- Latency and cost envelope.
- Reliability across multiple frames.
- Behavior with real artifacts rather than the fixture.
- Exact text/data tool integration.
- Production UX polish.
- Separate session vs. piggyback decision for longer reviews.

## Go / No-go

Still-frame co-review is a guarded proof-of-concept **go** for the fixture path:

- Go for artifact-canvas encoding and experimental WebSocket payload construction.
- Go for provider-visible fixture co-review behind flags.
- No-go for continuous live video/screen-share on the current transport.
- No-go for real artifacts until a clean artifact canvas/offscreen renderer exists.
- No-go for exact text via vision; continue using `read_artifact_text`.

## Next Recommended Implementation

1. Keep normal voice path unchanged.
2. Keep still-frame co-review behind flags.
3. Replace the fixture source with a real artifact canvas/offscreen renderer.
4. Add resend-frame triggers on user action: `refresh view`, scroll/zoom, or review-step changes.
5. Wire trusted `read_artifact_text` for exact words and numbers.
6. Add telemetry for `image_count` / `usageMetadata` if the provider emits it.
7. Add a production UX review: entry, looking indicator, Stop Looking, and privacy language.
8. Only later revisit continuous media/video.
