# Gemini Screen-Share Co-Review Spike

Date: 2026-05-26
Branch: `spike/gemini-screenshare-coreview`
Base: `origin/main` at `8c10fdc3`
Spec: inline "Sophia - Gemini Screen-Share Voice Co-Review Spec v1.0" plus repo specs in `docs/specs/`

## Scope

This spike scaffolds the smallest safe proof surface for Gemini artifact co-review. It is feature-flagged off by default, does not deploy, does not touch Mem0/session continuity/recap/extraction, and does not capture the full screen, tab, browser chrome, or unrelated UI.

Feature flags:

- Frontend: `NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED=false`
- Backend/server: `SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED=false`

## Provider Path Discovered

The current Gemini voice route is browser-owned Gemini Live WebSocket with backend relay support:

- Frontend session startup: `frontend/src/app/hooks/useStreamVoiceSession.ts`
- Browser Gemini adapter: `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`
- Frontend relay route: `frontend/src/app/api/sophia/voice/gemini/relay/route.ts`
- Backend voice connect route: `backend/app/gateway/routers/voice.py`
- Production session bootstrap: `voice/realtime/gemini_production_session.py`
- Gemini setup/tool loop: `voice/realtime/dogfood_session.py`, `voice/realtime/gemini_tool_loop.py`

Microphone audio is captured with `getUserMedia({ audio: true })`, converted through WebAudio into PCM, and sent as `realtimeInput.audio` JSON over WebSocket. There is no current `RTCPeerConnection`, `addTrack`, `replaceTrack`, or video-track adapter in the browser path.

## Continuous Video Track Result

Continuous video tracks are not supported by the current voice substrate.

The frontend scaffold can capture a real artifact canvas with `canvas.captureStream()` when a canvas renderer exists. The current bloomed artifact panel is DOM-based, so the scaffold reports `unsupported` for DOM capture instead of using `getDisplayMedia` or whole-tab capture.

Recommendation: no continuous default until the Gemini browser adapter gets an explicit visual input path, likely either provider-supported `realtimeInput` image/video chunks or a different media transport. For the next feasibility pass, use a clean still-frame path that renders the artifact region into a canvas and sends discrete frames, never a desktop/tab capture.

## Capture Method

Implemented proof order:

1. Direct artifact `canvas.captureStream()`
2. Nested artifact canvas `captureStream()`
3. DOM artifact fallback returns `unsupported` with safe reason `dom_region_capture_requires_clean_canvas_rerender`

Not implemented:

- Whole-screen capture
- Whole-tab capture
- Browser chrome capture
- Durable screenshots, frames, videos, or audio dumps

## UX Scaffold

Frontend files:

- `frontend/src/app/lib/co-review-flags.ts`
- `frontend/src/app/lib/co-review-capture.ts`
- `frontend/src/app/hooks/useArtifactCoReview.ts`
- `frontend/src/app/components/session/CoReviewControls.tsx`
- `frontend/src/app/components/session/PresenceArtifactPanel.tsx`

Behavior:

- `Review together` is shown only when the frontend flag is true.
- State machine: `inactive`, `starting`, `live`, `stopping`, `error`.
- State is scoped by `artifactId` and `sessionId`.
- Live indicator text is persistent: `Sophia is looking at this artifact`.
- Exit uses `Stop looking`, stops tracks, clears state, and hides the indicator.
- Reduced motion still has the text indicator.

## Backend Tool Scaffold

Backend/voice files:

- `voice/realtime/coreview.py`
- `voice/realtime/sophia_backend_tools.py`
- `voice/realtime/gemini_tool_loop.py`
- `voice/realtime/sophia_prompt.py`
- `voice/realtime/gemini_memory_context.py`

Tool:

```json
{
  "name": "read_artifact_text",
  "args": { "artifact_id": "opaque trusted artifact id" }
}
```

The tool is declared only when `SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED=true`. The default backend is a safe unavailable stub. Tests use a scoped in-memory fixture backend keyed by trusted `user_id`, `session_id`, and `artifact_id`.

Tool success shape:

```json
{
  "ok": true,
  "artifact_id": "artifact-1",
  "text": "exact text",
  "source": "artifact_store",
  "truncated": false,
  "char_count": 123
}
```

Tool error shape:

```json
{
  "ok": false,
  "artifact_id": "artifact-1",
  "status": "not_found",
  "safe_reason": "artifact_not_found"
}
```

Diagnostics redact raw artifact text and keep only status, source, char count, truncation, artifact id, and safe reason.

## Co-Review Prompt Block

When the backend flag is true, Gemini receives a small policy block:

- Use shared view for layout, color, composition, spacing, visual hierarchy, chart shape, and spatial references.
- Call `read_artifact_text` for exact words, copy, numbers, table values, dates, labels, or metrics.
- Do not claim to read fine print or exact data from the video feed alone.

Normal voice mode is unchanged when the flag is off.

## Telemetry

Frontend safe telemetry fields:

- `coReviewEnabled`
- `coReviewState`
- `artifactId`
- `sessionId`
- `shareStartedAt`
- `shareDurationMs`
- `captureMethod`
- `frameRate`
- `resolution`
- `videoTrackAttached`
- `videoTrackAttachError`
- `voiceLatencyBefore`
- `voiceLatencyAfter`
- `droppedFrameEstimate`
- `modeExitReason`

No frames, screenshots, videos, data URLs, or raw artifact text are stored.

## Latency And Cost Measurement Plan

Current scaffold records local share timing and track metadata. It cannot measure true Gemini visual-input cost because the current transport has no video attachment path.

Next measurement once a visual path exists:

- Capture voice turn latency before co-review.
- Capture voice turn latency during co-review.
- Record resolution, frame rate, dropped-frame estimate, and share duration.
- Estimate cost per minute from provider visual input pricing for the chosen transport and observed frame rate/resolution.

## Small Text Reliability

The spike treats small-text reading from video as unreliable by design. Exact words, labels, numbers, dates, table cells, and metrics require `read_artifact_text`. The synthetic/manual test should include a large heading, tiny fine print, and a small table number; the expected behavior is a tool call or an honest refusal when the text tool is unavailable.

## Go/No-Go

- Continuous default: no-go on current browser WebSocket audio-only substrate.
- Discrete still-frame fallback: recommended next spike if provider image/video chunk input can be wired safely.
- No-go until provider path changes: yes for continuous video-track sharing.

## Open Questions

- Which Gemini Live input format should carry scoped visual frames in this browser WebSocket route?
- Can the artifact renderer produce a clean canvas representation without pulling in private surrounding DOM?
- Should artifact ids be minted server-side for co-review instead of derived from thread/path context?
- Where should true cost telemetry live once visual input is active?
- Should webapp progress/placeholder UI provide the co-review affordance only on builder outputs, or also on session recap artifacts?
