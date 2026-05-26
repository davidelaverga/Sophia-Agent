# Gemini Co-review Still-frame Input Spike

Date: 2026-05-26
Branch: `spike/gemini-coreview-still-frame-input`
Baseline: `8c10fdc3`
Prior dual-path commit carried forward: `f30a890c` cherry-pick of `eea0d2e1`

## Goal

Prove the next smallest visual-input path for Gemini co-review: encode only the active artifact canvas into a capped still frame and attempt to send that frame through the current Gemini Live WebSocket route, without changing normal voice behavior.

## Provider Reference

The current Google Cloud Gemini Live reference says a WebSocket session can send text, audio, or video to Gemini and receive audio, text, or function call requests. Client messages include `realtimeInput`, and the reference describes that realtime input can carry audio or video. It also documents function call requests and `UsageMetadata` fields including image count, video duration, and audio duration.

Repo reality is narrower:

- Current Sophia browser Gemini path sends `realtimeInput.audio`, `realtimeInput.text`, and `toolResponse`.
- This spike adds an experimental `realtimeInput.mediaChunks[]` still-frame sender behind a separate still-frame flag.
- No real provider run was performed in this spike, so provider acceptance and visual response remain unobserved.

## Feature Flags

- `NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED`: default off.
- `SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED`: remains off; no screen-share path added.
- `SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED`: new backend-side still-frame support flag.
- `NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED`: frontend build/runtime still-frame flag used by the browser adapter.

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

The route can construct and send a `realtimeInput.mediaChunks[]` JSON payload when the still-frame flag is on. This proves browser-side payload construction and WebSocket send mechanics, not provider acceptance.

### 3. If yes, does Gemini react to the visual frame?

Not proven. No live provider manual run was performed, and no provider ack/visual response event exists in the current local tests.

### 4. Can tools still work?

Normal tool setup is unchanged, and the still-frame sender uses the same Live WebSocket session. Existing tool declaration tests still pass. A live provider test is still needed to prove function calling remains reliable after a media chunk.

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

## Go / No-go

Still-frame co-review is a guarded **partial go**:

- Go for artifact-canvas encoding and experimental WebSocket payload construction.
- No-go for claiming provider visual understanding until a real Gemini run confirms frame acceptance and visual response.
- No-go for DOM artifacts until a clean renderer exists.
- No-go for exact text via vision; continue using `read_artifact_text`.

## Recommended Next Test

Run a manual provider smoke test with the still-frame flag enabled:

1. Start normal Gemini voice.
2. Render a synthetic artifact canvas with visible layout and tiny text.
3. Enter Review Together.
4. Send exactly one still frame.
5. Ask what Sophia notices visually.
6. Ask for exact tiny text or a number.
7. Confirm visual answer uses layout only and exact answer uses `read_artifact_text` or refuses honestly.
8. Check `UsageMetadata.image_count`, latency, and tool-call behavior.
9. Confirm telemetry contains only dimensions, byte sizes, statuses, and latency.
