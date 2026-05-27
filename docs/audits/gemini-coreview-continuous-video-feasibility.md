# Gemini Coreview Continuous Video Feasibility

Date: 2026-05-27
Branch: `spike/gemini-coreview-still-frame-input-clean`
Starting HEAD: `a68c182f`
Phase: Coreview Continuous Video Feasibility Spike

## Executive decision

True continuous scoped artifact-region video is **not feasible in the current repo stack today**.

The current implementation is a valid bridge: an explicit, artifact-canvas-only still-frame path over Gemini Live `realtimeInput.video`, plus user-triggered `Refresh View`, plus `read_artifact_text` for exact words and numbers. That does not complete the continuous-video spec.

The exact missing piece is a media-track transport: no current Sophia Gemini path can attach a `MediaStreamTrack` from `canvas.captureStream()` to Gemini Live or Vision Agents. The browser Gemini adapter has a JSON WebSocket with audio/text/still-frame sends. It does not expose `RTCPeerConnection`, `addTrack`, `replaceTrack`, or an implemented `attachVideoTrack`. The backend Gemini provider session exposes `send_audio`, `send_text`, and `send_tool_result`, but no `send_video`, `send_frame`, or media-track session.

## What the current stack supports

### Scoped artifact source

Supported locally:

- Artifact visual capture is canvas-only.
- `resolveArtifactVisualSource(..., mode: "stream")` can call `canvas.captureStream(frameRate)`.
- A new dev-only capability probe can verify that a fixture canvas creates a `MediaStream` and yields a video track.
- Existing and new tests confirm no `getDisplayMedia` fallback is used.

Not supported generally:

- DOM artifact capture.
- Window, tab, browser chrome, or document-body capture.
- Continuous video for DOM-first artifacts without a safe canvas renderer.

### Current Gemini browser path

Supported:

- Microphone audio through `realtimeInput.audio`.
- Text through `realtimeInput.text`.
- Tool responses through `toolResponse.functionResponses`.
- Still artifact frames through:

```json
{
  "realtimeInput": {
    "video": {
      "mimeType": "image/jpeg",
      "data": "<base64 omitted>"
    }
  }
}
```

Not supported:

- Passing a live `MediaStreamTrack`.
- `RTCPeerConnection` to Gemini.
- `addTrack` / `replaceTrack`.
- Browser API for `attachVideoTrack(track)` on the Gemini connection.

### Backend Gemini Live provider path

Supported:

- Provider event mapping.
- `send_audio`.
- `send_text`.
- `send_tool_result`.
- Usage metadata mapping for image count, video duration, and audio duration when provider events include those fields.

Not supported:

- Opening a separate media-capable Gemini session from the backend.
- Sending a video track or continuous media chunks.
- Proving tool parity in a second media session.

### Vision Agents path

The repo has the normal Stream/Vision Agents audio session path, but it is not wired as a Coreview video path.

Current repo evidence:

- Frontend depends on `@stream-io/video-react-sdk` for normal live voice.
- `voice/server.py` keeps the Stream/Vision Agents session route on the legacy cascade voice path.
- Repo code does not expose a Vision Agents Coreview helper that accepts an artifact canvas track.
- Prior audits found generic video helpers in the installed package family, but no Sophia-integrated Gemini media session.

Conclusion: Vision Agents is present for voice, not for artifact-region video into Gemini Coreview.

## Dev-only probes added

### Continuous video capability probe

File: `frontend/src/app/lib/co-review-continuous-video-probe.ts`

The probe answers:

1. Can this canvas call `captureStream()`?
2. Does the returned stream include a video track?
3. Does the active transport expose `attachVideoTrack(track)`?
4. If the transport does not exist, what exact unsupported reason should be reported?

Expected current result:

- Canvas stream: yes in browsers/tests where `captureStream` exists.
- Video track: yes when `captureStream` returns a video track.
- Transport attach: no.
- Unsupported reason: `video_track_transport_unavailable`.

This is deliberately not a product feature and does not capture screen/tab/body.

### Repeated-frame probe

Flag: `NEXT_PUBLIC_SOPHIA_COREVIEW_VIDEO_PROBE_ENABLED`

Default: off.

This is **not continuous video**. It is labeled `repeated-frame probe` in code and telemetry-like return data. It sends capped, low-rate still frames through the already-proven `realtimeInput.video` path.

Safety behavior:

- Hidden/no-op unless the dev flag is explicitly enabled.
- Hard cap of 5 repeated frames.
- Minimum interval clamped to 1000 ms.
- Stops on encode error, send error, socket close, closed preflight, or `AbortSignal`.
- `Stop Looking` aborts an active probe through the still-frame transport.
- Result metadata records frame counts, frame bytes, dimensions, send latency, close/error reason, and usage duration/count fields only.
- No raw frame/base64/video/audio is stored.

## Feasibility answers

### 1. Can we create a MediaStream/video track from only the artifact canvas/region?

Yes, when the artifact region is a canvas with `captureStream()` support.

This works for fixture/guarded canvas artifacts. It does not solve DOM-first artifacts. Those still need a safe renderer that produces an artifact-scoped canvas.

### 2. Can the current Gemini Live / Vision Agents path accept that video track?

No.

The current Gemini browser connection is a WebSocket JSON adapter. It can send audio/text/still video payloads, but it has no live track attach API. The current Vision Agents integration is the normal voice route and is not wired to feed a canvas video track into Gemini Coreview.

Exact missing transport:

- No Gemini `RTCPeerConnection` path.
- No `addTrack` / `replaceTrack`.
- No implemented `attachVideoTrack(track)`.
- No backend `send_video` / media-track session.
- No separate media session with proven Sophia tool parity.

### 3. Can low-rate repeated `realtimeInput.video` frames approximate video?

Partially, as an interim probe only.

Low-rate repeated still frames can approximate "Sophia sees the changing artifact" for coarse layout/color/composition changes, especially if the artifact is mostly static and user-triggered updates are enough. It is not equivalent to continuous video:

- Motion and intermediate changes can be missed.
- Provider billing may count repeated image/video inputs.
- Small text remains unreliable and must use `read_artifact_text`.
- More frames increase close/error risk on the current WebSocket path.
- Tool behavior after repeated media needs live provider observation.

The safest product-facing bridge remains explicit `Refresh View`; a default-off repeated-frame probe can collect cost/latency/close data before any auto-refresh UX is considered.

### 4. What transport changes are required for true continuous video?

One of these is required:

1. A Gemini media session that accepts a browser `MediaStreamTrack` from `canvas.captureStream()` and preserves tool calls or sideband text access.
2. A WebRTC/SFU route where the artifact canvas track can be added/replaced without whole-screen capture.
3. A backend media bridge that receives artifact-scoped frames/tracks from the app and forwards them to Gemini as a documented continuous video stream.

Minimum contract for any real implementation:

- Source must be artifact canvas/region only.
- No `getDisplayMedia`.
- No full DOM/window/tab capture.
- Persistent "Sophia is looking" indicator.
- Exit stops track/frame sending immediately.
- Exact text remains sideband via `read_artifact_text`.
- Safe cost/latency telemetry only.
- Proven function-call or sideband parity during media input.

### 5. Cost, latency, and privacy implications

Cost:

- Continuous video would likely be duration-based or frame-count sensitive.
- Repeated still frames should be treated as paid visual inputs until provider billing is measured.
- Current telemetry can capture image count and video/audio duration fields if provider usage metadata arrives, but no dollar estimate is configured.

Latency:

- `canvas.captureStream()` itself is local and cheap.
- Still-frame encoding adds encode time and payload transfer.
- Repeated frames add periodic encode/send work and can compete with the same browser WebSocket used for voice.
- A separate media session may add setup latency but would isolate visual transport from normal voice.

Privacy:

- Current implementation maintains the right boundary: artifact canvas only.
- No whole-screen/tab capture.
- No DOM/window/document body capture.
- No raw frame/base64/video storage.
- The visible looking indicator and `Stop Looking` behavior remain mandatory.

## Go / no-go

Continuous video now: **No-go.**

Separate media session needed: **Yes, for true continuous video unless Gemini adds a usable track attach path to the existing browser WebSocket adapter.**

Stay with Refresh View / low-rate frames: **Go.**

Recommended path:

1. Keep the current still-frame and `Refresh View` bridge.
2. Keep `read_artifact_text` as the exact data path.
3. Use the dev-only capability probe to document browser canvas-stream support.
4. Use the default-off repeated-frame probe only for controlled local/provider measurement.
5. Build a separate media-track session only after the transport can prove artifact-scoped video, stop semantics, cost telemetry, and tool/sideband parity.

## Tests added

- Fixture canvas can produce a stream/video track when `captureStream` is mocked.
- Unsupported when `captureStream` is unavailable.
- No `getDisplayMedia` is called by the probe path.
- Video track transport reports `video_track_transport_unavailable` in the current stack.
- Repeated-frame probe is hidden/no-op unless enabled.
- Repeated-frame probe respects the five-frame cap.
- `Stop Looking` cancels an active repeated-frame probe.
