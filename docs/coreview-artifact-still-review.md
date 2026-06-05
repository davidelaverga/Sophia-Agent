# Coreview Artifact Still-Frame Review

Date: 2026-06-02

Coreview artifact review lets Sophia look at one visible artifact after the user explicitly asks. It is an artifact analyzer, not a live vision mode.

## Flags

All flags default to `false`.

```bash
NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED=false
NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED=false
SOPHIA_GEMINI_COREVIEW_ENABLED=false
SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED=false
```

Frontend review controls require both `NEXT_PUBLIC_` flags. The voice/Gemini exact-text tool and prompt overlay require `SOPHIA_GEMINI_COREVIEW_ENABLED`; still-frame support reporting also checks `SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED`.

## Flow

1. A builder artifact or current companion artifact renders a hidden artifact-scoped canvas.
2. The user clicks **Review with Sophia**.
3. The app resolves only the registered artifact canvas and sends one still frame to the active Gemini Live WebSocket.
4. The UI shows Looking, Frame sent, Exact text available, and Visual may be stale.
5. Sophia uses vision only for layout, composition, color, spacing, and rough visual structure.
6. Exact words, numbers, labels, table values, citations, and fine print come from `read_artifact_text` or the trusted text sideband.
7. Stop Looking clears Coreview state and returns to normal voice behavior.

## Non-Goals

- No continuous video or liveframes.
- No screen, browser-tab, desktop, camera, or microphone video capture.
- No OCR reliance for exact text or numbers.
- No Stream/Vision Agents changes.
- No VAD, turn-taking, arbiter, provider routing, or voice runtime migration changes.

## Telemetry

Telemetry must stay safe and compact. Required Coreview fields include:

- `coreviewEnabled`
- `coreviewSessionActive`
- `coreviewArtifactId`
- `visualSourceKind`
- `frameSentCount`
- `initialFrameSent`
- `frameSendFailureCount`
- `lastFrameSendFailureReason`
- `lastFrameDimensions`
- `lastFrameBytes`
- `visualFresh`
- `visualFreshForTurn`
- `exactTextAvailable`
- `exactTextCallCount`
- `exactTextSuccessCount`
- `readArtifactTextCallCount`
- `rawFrameExcluded=true`
- `rawProviderPayloadExcluded=true`
- `rawArtifactTextExcluded=true`

`diagnosticsSummary.coreviewStillFrame` mirrors the same safe still-frame summary in exported voice telemetry reports. Do not include raw frame base64, raw provider payloads, raw artifact text, or raw text-reader queries.

## Smoke Checklist

1. Enable all four flags in the relevant local env files.
2. Start the frontend and Gemini Live voice path.
3. Create or surface a builder artifact, or open a session artifact with takeaway/reflection/memory content.
4. Click **Review with Sophia**.
5. Confirm exactly one `gemini-artifact-frame-send` event for the click.
6. Confirm the UI shows Looking, Frame sent, Exact text available, and Visual may be stale.
7. Ask for an exact number or phrase and confirm Gemini calls `read_artifact_text`.
8. Export voice telemetry and confirm `coreviewStillFrame` is present and raw exclusion booleans are true.
