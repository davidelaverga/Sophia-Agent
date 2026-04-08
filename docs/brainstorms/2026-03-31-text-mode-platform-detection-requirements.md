---
date: 2026-03-31
topic: text-mode-platform-detection
---

# Text Mode + Platform Detection

## Problem Frame
Sophia's backend middleware chain adapts response style based on a `platform` signal (`"voice"`, `"text"`, `"ios_voice"`). The frontend already has a three-mode focus system (`"full"`, `"voice"`, `"text"`), auto-switching between modes, and a voice fallback path — but it never sends the `platform` signal to the backend. The result: voice and text conversations produce identical response lengths and guidance, despite the spec defining different behavior per platform.

Text mode also needs UX polish to feel like a first-class experience rather than a degraded voice path.

## Requirements

**Platform Signal Wiring**
- R1. Derive `platform` from `FocusMode` + native platform detection and include it in every DeerFlow request (`configurable.platform`).
- R2. Platform values: `"voice"` (web voice), `"text"` (web text), `"ios_voice"` (iOS native voice). The `"full"` FocusMode maps to `"text"` (it's a hybrid mode with text as default).
- R3. The platform signal must flow through both the text chat path (`POST /api/chat` → backend-client → DeerFlow) and the voice path (`fetchStreamCredentials` → voice server).
- R4. On iOS (Capacitor native), voice mode sends `"ios_voice"` instead of `"voice"`.

**Text Mode UX**
- R5. When FocusMode is `"text"`, hide voice-specific UI: waveform, mic button, voice status indicators, emotion glow effects.
- R6. Show a keyboard-first text input: auto-focused, Enter-to-send, no mic toggle. The existing `VoiceFirstComposer` text expansion should become the primary input in text mode.
- R7. Show a typing indicator ("Sophia is typing...") instead of waveform animation when Sophia is responding in text mode.
- R8. Sophia's responses in text mode render as standard chat message bubbles (existing message rendering — no change needed, this already works).

**Mode Toggle UI**
- R9. The mode toggle should present three options matching the spec: `[💬 Message]` (full mode), `[🎙️ Live]` (voice mode), `[⌨️ Text]` (text mode).
- R10. The toggle must be visible and accessible from the session page. Placement: in the composer area or near the session header.
- R11. Mode switching validates against `useModeSwitch()` — cannot switch to voice while chat is locked, cannot switch modes while voice is actively recording/playing.

**Voice Session in Text Mode**
- R12. When switching from voice to text mode, the active voice session is disconnected (existing behavior in `ConversationView.tsx` — preserve, don't break).
- R13. When in text mode, the voice session hook should not attempt to connect or maintain a connection.

## Success Criteria
- Same message sent in voice mode vs text mode reaches the backend with different `platform` values (`"voice"` vs `"text"`).
- Backend logs confirm `platform` appears in the DeerFlow `configurable` on every request.
- Text mode UI shows no voice elements (mic, waveform, voice status).
- Mode toggle is visible and all three modes are selectable.
- On iOS (if testable), voice mode sends `"ios_voice"`.

## Scope Boundaries
- Backend `PlatformContextMiddleware` is Jorge's responsibility — we wire the signal, he reads it. We do not build or modify backend middleware.
- Response length differences are a backend concern. We verify the signal arrives; we don't validate response content differs.
- No changes to the voice mode UX — it already works.
- No "ios_text" platform value — iOS text falls back to `"text"` (spec only defines three values).
- Emotion color effects (`useEmotionColor`) remain active in `"full"` mode since it's a hybrid. Only hidden in pure `"text"` mode.

## Key Decisions
- `"full"` FocusMode → `"text"` platform: The hybrid "full" mode is text-dominant (voice is optional overlay). The backend should receive `"text"` for response length guidance.
- Three-tab toggle matches spec UI: `[💬 Message] [🎙️ Live] [⌨️ Text]` — this maps to `"full"`, `"voice"`, `"text"` FocusModes respectively.
- Voice disconnect on text mode: Already implemented, just preserve the behavior.
- `usePlatformSignal` hook (partially created): Keep as the single derivation point for platform signal. Update to handle `"full"` → `"text"` mapping.

## Dependencies / Assumptions
- `@capacitor/core` is already installed for iOS native detection.
- Backend will read `configurable.platform` when `PlatformContextMiddleware` is built (Jorge's track). We wire the signal now so it's ready.
- The existing `chatRequestBody` in session page context supports adding platform (partially wired from prior session — needs validation).

## Outstanding Questions

### Deferred to Planning
- [Affects R3][Needs research] How does the voice path (`useStreamVoiceSession` → `fetchStreamCredentials`) currently pass configurable params? Need to verify the voice path can carry `platform`.
- [Affects R6][Technical] Should the `VoiceFirstComposer` component receive a `textOnly` prop to render differently, or should text mode use a different composer component entirely?
- [Affects R9][Technical] Where exactly should the three-tab toggle render? The spec shows it in the composer area, but the current `VoiceFirstComposer` is a unified component. Need to check existing mode toggle patterns.

## Next Steps
→ `/ce-plan` for structured implementation planning
