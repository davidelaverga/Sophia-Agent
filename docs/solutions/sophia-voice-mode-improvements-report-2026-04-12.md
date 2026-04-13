# Sophia Voice Mode Improvements Report

Date: 2026-04-12
Branch: `feat/voice-sse-browser-bridge`
Prepared for: Davide

## Executive Summary

This branch materially improves Sophia's live voice experience across four concrete dimensions:

1. Voice event delivery is now browser-first and observable via SSE instead of depending only on Stream custom events.
2. Voice startup is faster because the frontend now prewarms auth, preconnects a reusable voice session, and reuses it on click.
3. Duplicate and fragmented turn behavior is materially more stable because continuation recovery, transcript reconciliation, and turn completion handling were hardened.
4. The remaining latency problem is now much narrower and easier to diagnose: the dominant bottleneck is backend/model time before first meaningful text, not frontend startup, transport, or duplicate-turn handling.

The net effect is that Sophia voice now feels significantly smoother in real usage, while the telemetry is detailed enough to prove where time is still being lost.

## Baseline Before This Work

Before the changes in this branch, Sophia voice had several independent issues that compounded into a slow and unstable experience.

### 1. Event delivery to the browser was fragile

- The frontend primarily depended on Stream custom events for transcripts, artifacts, and turn lifecycle signals.
- There was no dedicated browser-facing SSE bridge for Sophia voice events.
- When custom events were delayed, duplicated, or arrived out of order, the browser had limited ways to distinguish transport problems from STT, backend, or TTS issues.

### 2. Startup cost was too high at click time

- Voice startup paid the full `POST /voice/connect` and session allocation cost when the user pressed the mic button.
- There was no lightweight auth prewarm and no delayed background preconnect of a reusable voice session.
- The Stream client could still inherit stale local device defaults during join.
- Earlier measured click-time startup was roughly in the `~1.9s to 2.0s` range before the warm-start path was hardened.

### 3. Turn handling could duplicate or fragment responses

- Late continuations could trigger a second backend submission instead of being safely merged into the next real submission.
- Non-final but already-stable transcripts were sometimes held behind extra stabilization delay.
- Overlapping user transcript updates could appear in the UI as repeated or residue user messages.
- Browser and runtime behavior made it difficult to separate a true duplicate reply from a transcript growth replay.

### 4. Local hot-path overhead still inflated reply latency

- On the response critical path, Sophia could await non-critical event emission such as `sophia.user_transcript` before the backend request was truly underway.
- Initial turn lifecycle events could still block the first response chunk path before TTS could begin.
- This meant part of `firstTextMs` and `firstAudioMs` was self-inflicted overhead, not model latency.

### 5. Telemetry was not rich enough to isolate the real bottleneck

- We did not have a unified runtime breakdown that cleanly separated startup, microphone, turn segmentation, backend, transport, and TTS.
- Capture analysis could tell when a session completed or failed, but not always why it felt slow.
- Session export and developer-facing live diagnostics were weaker than needed for rapid iteration.

## What Changed

## 1. Browser-Facing SSE Event Bridge

### Problem

The browser needed a first-class Sophia event stream instead of relying only on Stream custom events.

### Implementation

- Added a dedicated in-process broker in `voice/sse_broker.py`.
- Bound the runtime call emitter in `voice/server.py` so every emitted Sophia event is both:
  - sent to Stream custom events for runtime compatibility
  - published into the SSE broker for browser consumption
- Added voice session SSE endpoints in:
  - `voice/server.py`
  - `backend/app/gateway/routers/voice.py`
  - `frontend/src/app/api/sophia/[userId]/voice/events/route.ts`
- Extended `/voice/connect` to return:
  - `thread_id`
  - `stream_url`
- Added explicit voice session close endpoints so browser cleanup can work cleanly, including sendBeacon-style closure.

### Frontend Behavior Change

- `frontend/src/app/hooks/useStreamVoiceSession.ts` now opens an `EventSource` when `stream_url` is present.
- The frontend now prefers `voice-sse` events for:
  - `sophia.transcript`
  - `sophia.user_transcript`
  - `sophia.artifact`
  - `sophia.turn`
  - `sophia.turn_diagnostic`
- Stream custom events remain as a fallback path, not the primary path.

### Impact

- Browser event delivery is more deterministic and easier to reason about.
- Telemetry can now explicitly distinguish `voice-sse` from `stream-custom` traffic.
- The latest live report showed:
  - `transportSource = "sse"`
  - `streamCustom = 0`
  - `sseErrors = 0`

## 2. Faster Voice Startup via Prewarm + Prepared Session Reuse

### Problem

Startup cost was concentrated at click time.

### Implementation

- Added a lightweight `GET` auth-prewarm path in `frontend/src/app/api/sophia/[userId]/voice/connect/route.ts`.
- Added delayed background voice preconnect logic in `frontend/src/app/hooks/useStreamVoiceSession.ts`:
  - auth prewarm
  - delayed prepared `POST /voice/connect`
  - reuse of prepared credentials on `startTalking`
  - TTL-based prepared session reuse
  - cleanup of unused prefetched sessions
- Added telemetry markers for the warm path:
  - `preconnect-started`
  - `preconnect-ready`
  - `preconnect-reused`
  - `preconnect-failed`
- Hardened `frontend/src/app/hooks/useStreamVoice.ts` to join with local media defaults disabled first:
  - disable camera before join
  - disable mute-notification noise
  - disable microphone before join
  - enable microphone after join
- Disabled Stream device persistence in the client constructor to avoid stale device state carrying across sessions.

### Impact

Validated live startup improved from roughly `~1984ms` click-time connection cost to approximately:

| Metric | Before | After |
|---|---:|---:|
| `requestToCredentialsMs` | click-time path | `11-13ms` |
| `joinLatencyMs` | ~similar but paid cold | `1030-1048ms` |
| `joinToReadyMs` | previously noisier | `14-15ms` |
| `sessionReadyMs` | ~`1984ms` | `1088-1103ms` |

This removed a large amount of perceived startup drag before the user even reached the first turn.

## 3. Duplicate Reply and Continuation Hardening

### Problem

Late continuations and fragile merge behavior could cause duplicate backend submissions or inconsistent turn state.

### Implementation

- Refactored `voice/conversation_flow.py` so merge recovery is queued for the next real submission instead of manually resubmitting immediately.
- Updated `voice/server.py` to consume queued recovered continuations just before the backend request begins.
- Ensured `agent_ended` is emitted once at actual response completion instead of relying on earlier TTS lifecycle assumptions.
- Updated tests in:
  - `voice/tests/test_conversation_flow.py`
  - `voice/tests/test_voice_artifact_contract.py`

### Impact

- The duplicate-reply class of bug is now fixed at the turn-flow level instead of being masked downstream.
- Continuations are recovered without creating a second independent reply path.

## 4. Faster First Text and First Audio on the Local Runtime Path

### Problem

Part of the remaining reply delay was still caused by local event emission on the hot path.

### Implementation

- Added background event scheduling in `voice/sophia_llm.py` for non-critical call-emitter work.
- `sophia.user_transcript` emission no longer blocks backend request opening.
- The first `user_ended` and `agent_started` event emissions no longer block the first transcript chunk path.
- Background call-event tasks are drained later so event delivery remains reliable without inflating response latency.
- Added direct metrics in `voice/sophia_llm.py` and `voice/turn_diagnostics.py`:
  - `backend_request_start_ms`
  - `backend_first_event_ms`
  - `first_text_ms`
  - `backend_complete_ms`
  - `first_audio_ms`
- Added regression coverage in:
  - `voice/tests/test_sophia_llm_streaming.py`
  - `voice/tests/test_turn_metrics.py`
  - `voice/tests/test_turn_diagnostics.py`

### Additional Streaming Improvement

- Multi-sentence backend text chunks are now split earlier in `voice/sophia_llm.py` so TTS can begin from a stable sentence boundary instead of waiting for the entire backend chunk.

### Impact

This change removed most of the remaining local overhead before DeerFlow and TTS:

| Metric | Before latest hot-path fix | After latest hot-path fix |
|---|---:|---:|
| `backendRequestStartMs` | hundreds of ms, sometimes `~615ms` | best turn `~10ms`, typical low tens of ms |
| `firstTextMs` | ~`3548ms` | `2685ms` |
| `firstAudioMs` | ~`4534ms` | `3702ms` |

The important point is not only the raw reduction. The important point is that the remaining latency is now much more clearly backend/model time rather than browser or runtime plumbing.

## 5. Earlier Artifact Delivery and Better Backend Stream Visibility

### Problem

Artifact availability and backend progress were not surfaced early enough for voice optimization.

### Implementation

- Added DeerFlow timing instrumentation in `voice/adapters/deerflow.py`:
  - `deerflow_stream_open_ms`
  - `deerflow_first_event_ms`
- Changed artifact handling so when a final `values` artifact is available, the adapter emits it immediately and returns instead of waiting for unnecessary trailing stream data.
- Preserved streamed artifact fallback behavior when final values are unavailable.
- Added regression coverage in `voice/tests/test_deerflow_adapter.py`.

### Impact

- Voice settings for the next turn arrive earlier and more predictably.
- We can now distinguish:
  - backend stream open cost
  - first backend event arrival
  - first useful text arrival

This was essential to proving that the remaining bottleneck is upstream of the browser.

## 6. Transcript Reconciliation and UI De-duplication

### Problem

Growing STT transcripts and residue replays could show up as duplicate or overlapping visible user messages.

### Implementation

- Added transcript reconciliation utility in `frontend/src/app/lib/voice-transcript-reconciliation.ts`.
- Applied reconciliation in:
  - `frontend/src/app/hooks/useStreamVoiceSession.ts`
  - `frontend/src/app/session/useSessionVoiceMessages.ts`
  - `frontend/src/app/session/useSessionMessageViewModel.ts`
- Added regression coverage in:
  - `frontend/src/__tests__/lib/voice-transcript-reconciliation.test.ts`
  - `frontend/src/__tests__/session/useSessionVoiceMessages.test.ts`
  - `frontend/src/__tests__/session/useSessionMessageViewModel.test.ts`

### Impact

- Growing voice transcripts now collapse into the latest coherent visible message.
- Residue replay fragments are ignored instead of creating visual duplicates.
- Once SSE is open, duplicate custom delivery is intentionally ignored.

## 7. Live Developer Telemetry Panel and Exportable Voice Report

### Problem

We needed a fast way to inspect bottlenecks inside the UI and export a reproducible telemetry bundle.

### Implementation

- Added `frontend/src/app/lib/voice-runtime-metrics.ts`.
- Expanded `frontend/src/app/lib/voice-benchmark-analysis.ts` to consume the new telemetry shape and classify bottlenecks.
- Enabled browser capture outside dev-only mode in `frontend/src/app/lib/session-capture.ts`.
- Added a floating/live voice metrics panel in:
  - `frontend/src/app/components/session/VoiceMetricsPanel.tsx`
  - surfaced from `frontend/src/app/session/page.tsx`
  - surfaced from `frontend/src/app/components/VoiceFocusView.tsx`
- Added JSON export/copy actions so each live test session can produce a portable telemetry report.

### Impact

- Developers can now inspect live startup, backend, microphone, transport, and response timings directly in the session UI.
- Telemetry exports now include an explicit bottleneck classification rather than a raw event dump only.

## Validation Performed

### Targeted automated validation

The following voice-focused regression suites were run successfully during this work:

```powershell
.\voice\.venv\Scripts\python.exe -m pytest voice/tests/test_conversation_flow.py voice/tests/test_voice_artifact_contract.py voice/tests/test_sophia_llm_streaming.py voice/tests/test_turn_metrics.py voice/tests/test_turn_diagnostics.py
```

Result:

- `68 passed, 1 warning`
- The warning was non-blocking and came from a legacy `websockets` deprecation path.

Additional targeted validation also passed during implementation, including the intermediate streaming and diagnostics suites.

### Live telemetry validation

Latest exported report after restart:

- `sessionReadyMs = 1103`
- `joinLatencyMs = 1048`
- `backendRequestStartMs = 9.6873`
- `backendFirstEventMs = 2685.0294`
- `firstTextMs = 2685.1735`
- `firstAudioMs = 3701.9996`
- `backendCompleteMs = 7962.9349`
- `requestStartToFirstTextMs = 2675.4862`
- `firstBackendEventToFirstTextMs = 0.1441`
- `textToFirstAudioMs = 1016.8261`
- `transportSource = "sse"`
- `duplicatePhaseCounts = {}`
- `falseUserEndedCount = 1`
- `bottleneckKind = "backend"`
- `healthTitle = "Backend felt slow"`

### Behavioral validation

Subjective user feedback on the latest run:

- "it felt smooth"
- "Still a bit slow but way better than when we started"

That subjective report matches the measured data.

## Current State After This Branch

The branch has moved Sophia voice from a mixed, hard-to-diagnose latency profile to a much cleaner state:

- Startup is healthy.
- Browser event transport is healthy and SSE-backed.
- Duplicate reply behavior is addressed.
- Transcript growth handling is cleaner.
- Local runtime hot-path overhead before backend request is largely removed.
- Telemetry is now detailed enough to prove what still hurts.

## What Is Still Not Solved

The main remaining bottleneck is backend/model time before first meaningful text.

The strongest evidence is:

- `backendRequestStartMs` is now effectively solved.
- `firstBackendEventToFirstTextMs` is effectively negligible in the latest report.
- `requestStartToFirstTextMs` is still `~2675ms`.
- `firstTextToBackendCompleteMs` remains long at roughly `~5278ms`.

This means the next round of optimization should move upstream into DeerFlow / LangGraph / model output timing rather than spending more time on browser transport or frontend startup.

## Recommended Next Step

The next performance pass should focus on reducing backend latency before first useful text, specifically:

1. inspect what DeerFlow is emitting before the first meaningful text chunk
2. determine whether the model is simply slow to produce useful content or whether middleware / graph work delays the first token
3. reduce the long tail from first text to backend complete for long responses

At this point, that is the highest-value remaining optimization target for Sophia voice.

## Commit Scope Note

This report is intended to document the voice-mode improvement work on this branch. Runtime-generated `users/` artifacts and other local noise should not be treated as part of the product change set.