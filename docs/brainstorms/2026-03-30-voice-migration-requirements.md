---
date: 2026-03-30
topic: voice-transport-migration
---

# Voice Transport Migration: WebSocket → Stream WebRTC

## Problem Frame

AI-companion-mvp-front contains a custom WebSocket voice system (~40 files) that handles client-side audio capture, PCM streaming, turn detection, and audio playback. The new backend voice pipeline (Vision Agents + Stream WebRTC + DeerFlow) moves all of this server-side — STT, turn detection, TTS, and audio transport are handled by the Voice Layer, not the browser.

The old system is now dead weight: it duplicates responsibilities the server already handles, adds ~30 files of plumbing that must be maintained, and blocks integration with the new pipeline's capabilities (artifact-driven emotion, smart turn detection, platform-adaptive middleware).

This migration rewires AI-companion-mvp-front's voice transport from the old WebSocket protocol to Stream WebRTC, then removes the client-side audio plumbing that the server-side pipeline replaces.

**Who:** Luis (voice + frontend), with backend support from Jorge as needed.
**What changes:** Voice transport layer and everything it obsoletes.
**Why now:** The new pipeline (voice/server.py + adapters) is functional. The old WebSocket system cannot reach it.

## Requirements

**Transport Replacement**

- R1. Replace the WebSocket voice connection with Stream WebRTC client SDK. The frontend joins a Stream room; all audio capture and playback happens via WebRTC, not client-side MediaRecorder/AudioContext.
- R2. Voice sessions must establish through Vision Agents (voice/server.py). The frontend does not connect directly to DeerFlow — the Voice Layer is the intermediary.
- R3. Pass `platform` ("voice" | "ios_voice") in the connection/room metadata so the backend middleware chain receives it via `configurable`.
- R4. Pass `user_id`, `context_mode`, and `ritual` (when active) alongside platform so the full middleware `configurable` is populated.

**Voice State and UI Integration**

- R5. The voice UI (VoicePanel, VoiceFocusView, VoiceCollapsed, VoiceMicButton) must continue to function with the new transport. State signals (connecting, listening, speaking, processing) must map from Stream WebRTC room/participant events, not from WebSocket message parsing.
- R6. VoiceTranscript must display the user's speech-to-text output as finalized per-turn transcripts (not streaming partial results). STT runs server-side (Deepgram via Vision Agents); the transcript arrives as a Stream data event or equivalent, not from a client-side SpeechRecognition API.
- R7. Voice emotion and speed from `emit_artifact` must reach the Voice Layer's SophiaTTS. Since TTS runs server-side, the frontend does not need to process emotion/speed. Displaying emotion state in the UI is not in scope for this migration.

**Artifact Handling**

- R8. `emit_artifact` tool-call data must be received by the frontend for session continuity fields (session_goal, active_goal, next_step, takeaway, tone_estimate, etc.). The artifact arrives after the text stream completes. The frontend reads it from the DeerFlow SSE stream via the Voice Layer's forwarding mechanism or a parallel data channel.
- R9. Existing artifact consumers (ConversationView, voice-store, chat-voice-artifacts) must receive artifact data in the same shape they expect today, or be adapted to the new shape.

**File Retirement**

- R10. All client-side audio capture code (useVoiceRecording, PCM encoding, MediaRecorder wrappers) must be removed. Audio capture is now server-side via WebRTC.
- R11. All client-side audio playback code (useAudioPlayback, AudioContext/Web Audio API PCM streaming) must be removed. Audio playback is now server-side via WebRTC + Cartesia.
- R12. The WebSocket voice protocol (useVoiceWebSocket, voice-websocket-message-parser, voice-loop-websocket, voice-loop-connection, all voice-loop-* message handling helpers) must be removed. **Exception:** onboarding voice files (onboarding/voice.ts, onboarding/ui/useOnboardingVoice.ts) and any WebSocket utilities they depend on are excluded — onboarding voice migration is deferred.
- R13. Retained files (VoicePanel, VoiceFocusView, VoiceCollapsed, VoiceMicButton, voice-store, ConversationView voice integration) must be updated to consume Stream WebRTC events instead of the old VoiceLoopReturn interface.

**Session Integration**

- R14. useSessionVoiceOrchestration and useSessionVoiceBridge must be rewired to the new transport, or replaced with a simpler integration that manages Stream room lifecycle (join on voice start, leave on voice stop/session end).
- R15. Session-level voice hooks that only exist because of WebSocket complexity (useSessionVoiceCommandSystem, useSessionCancelledRetryVoiceReplay) should be evaluated for retirement. If the new transport handles retry/reconnection natively, remove them.

**Mobile (Capacitor)**

- R16. Stream WebRTC must work inside WKWebView (Capacitor iOS). WebRTC is supported since iOS 14.5+. Verify microphone permission grants persist across app restarts (one-time native grant, not per-session Safari prompt).

## Success Criteria

- User speaks → hears Sophia respond, end-to-end through the new pipeline (Vision Agents → DeerFlow → Cartesia TTS → WebRTC playback)
- Voice latency ≤ 3 seconds (TTFT through full pipeline)
- All old WebSocket voice files are deleted — no dead code remains
- Voice UI (panel, focus view, collapsed, mic button, transcript) works identically from the user's perspective
- Artifact data flows to the frontend for session continuity display
- Capacitor iOS: voice works in WKWebView with one-time mic permission
- No regression in text chat functionality

## Scope Boundaries

- **Text chat rewiring to DeerFlow `runs/stream`** — deferred. Text chat continues using its current backend connection.
- **Onboarding voice (useOnboardingVoice, onboarding/voice.ts)** — deferred. The onboarding voice-over system keeps its current WebSocket integration for now.
- **Voice Layer backend changes** — out of scope. voice/server.py, sophia_llm.py, sophia_tts.py, and adapters/ are already functional. This migration is frontend-only.
- **New voice UI features** — out of scope. No new components, screens, or interactions. Existing UI components are preserved and rewired.
- **VoiceFirstDashboard / VoiceFirstComposer** — in scope for rewiring. They consume voice state, not WebSocket internals directly.

## Key Decisions

- **Layer-by-layer migration** over big-bang or parallel: Replace transport first (WebSocket → Stream WebRTC), then simplify the UI layer by removing obsolete files. This reduces blast radius and lets each layer be tested independently.
- **Server-side audio** over client-side: The new pipeline handles STT, turn detection, TTS, and audio transport server-side. The frontend's role shrinks to joining a WebRTC room and rendering UI state — ~30 files of client-side audio plumbing become unnecessary.
- **Preserve voice-store** (adapted): voice-store.ts serves voice message history and UI state used by ConversationView and InputModeIndicator. It should be adapted to the new event source, not deleted.
- **Preserve Waveform component**: ui/Waveform.tsx is a reusable visualization component not tied to the old protocol. Keep it.

## Dependencies / Assumptions

- Vision Agents voice/server.py is operational and accepts Stream WebRTC connections
- Stream React SDK is available and compatible with Next.js 14 + React 18
- DeerFlowBackendAdapter (voice/adapters/deerflow.py) is functional for `runs/stream`
- Cartesia emotion/speed mapping in SophiaTTS works (tested separately in Week 2 per build plan)
- Stream account credentials are configured

## Outstanding Questions

### Resolve Before Planning

_(None — all product decisions resolved.)_

### Deferred to Planning

- [Affects R5, R13][Needs research] What Stream React SDK components/hooks map to VoiceLoopReturn state signals (connecting, listening, speaking, processing)?
- [Affects R8][Needs research] How does artifact data from `emit_artifact` reach the frontend? Options: Stream data channel, separate SSE endpoint, or embedded in WebRTC data events. Investigate Vision Agents' forwarding mechanism.
- [Affects R14][Technical] Can useSessionVoiceOrchestration be replaced by a single `useStreamRoom` hook that manages join/leave lifecycle, or does session-level orchestration logic need to survive?
- [Affects R15][Technical] Which session voice hooks (command system, retry replay, reflection voice flow) are pure WebSocket workarounds vs. genuine session logic that must persist?
- [Affects R16][Needs research] Verify Stream WebRTC SDK behavior inside Capacitor WKWebView — any known issues with audio session management or permission persistence?

## File Inventory

### Retire (transport + client-side audio — ~30 files)

**hooks/voice/ (WebSocket + audio plumbing):**
useVoiceWebSocket, useVoiceRecording, useAudioPlayback, voice-utils, voice-websocket-message-parser, voice-loop-connection, voice-loop-cleanup, voice-loop-command, voice-loop-error, voice-loop-failure, voice-loop-message, voice-loop-preflight, voice-loop-presence, voice-loop-response, voice-loop-start, voice-loop-stop, voice-loop-thinking, voice-loop-timeout, voice-loop-transition, voice-loop-turn-finalization, voice-loop-usage, voice-loop-websocket, voice-loop-state-adapter, useVoiceLoopWsHandlers, useVoiceLoopStartTalking, useVoiceLoopStopTalking, useVoiceLoopRetryLastVoiceTurn, useVoiceLoopSpeakText

**hooks/:**
useVoiceLoop (main orchestrator — replaced by Stream room hook)

**lib/:**
microphone-permissions.ts (WebRTC handles permissions natively), microphone-debug.ts

### Adapt (rewire to new transport — ~15 files)

**Voice components:**
VoicePanel, VoiceFocusView, VoiceCollapsed, VoiceMicButton, VoiceTranscript, VoiceRecorder

**Session integration:**
useSessionVoiceOrchestration, useSessionVoiceBridge, useSessionVoiceMessages

**Stores:**
voice-store.ts

**Chat integration:**
chat-voice-artifacts.ts, ConversationView.tsx, MessageBubble.tsx

**hooks/:**
useVoiceStateMachine (may simplify significantly), useVoiceToggle, useVoiceState

### Keep Unchanged

- VoiceFirstDashboard, VoiceFirstComposer (voice-state consumers — in scope for rewiring since they consume voice state, not WebSocket internals)
- ui/Waveform.tsx (reusable, not protocol-specific)
- InputModeIndicator.tsx (reads voice-store, adapts automatically)

### Out of Scope (deferred)

- onboarding/voice.ts, onboarding/ui/useOnboardingVoice.ts
- Text chat hooks and components

## Next Steps

→ `/ce-plan` for structured implementation planning
