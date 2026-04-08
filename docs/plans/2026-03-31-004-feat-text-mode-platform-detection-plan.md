---
title: "feat: Text Mode + Platform Detection"
type: feat
status: active
date: 2026-03-31
origin: docs/brainstorms/2026-03-31-text-mode-platform-detection-requirements.md
---

# feat: Text Mode + Platform Detection

## Overview

Wire the `platform` signal (`"voice"`, `"text"`, `"ios_voice"`) from the frontend through every DeerFlow request path so the backend middleware chain can adapt response length and guidance per platform. Simultaneously polish the text mode UX to feel first-class: no voice UI elements, keyboard-first input, typing indicator, and a visible three-tab mode toggle matching the spec.

## Problem Frame

The backend PlatformContextMiddleware (Jorge's track) sets `state["platform"]` from `configurable`. But the frontend never sends this signal — voice and text conversations produce identical backend behavior. The `usePlatformSignal` hook and partial API wiring were started but not completed, and contain a bug: `"full"` mode maps to `"voice"` instead of `"text"`. The text mode UX also shows voice elements (mic, waveform) that should be hidden. (see origin: docs/brainstorms/2026-03-31-text-mode-platform-detection-requirements.md)

## Requirements Trace

- R1. Derive `platform` from `FocusMode` + native platform detection in every DeerFlow request.
- R2. `"full"` FocusMode maps to `"text"` platform. Values: `"voice"`, `"text"`, `"ios_voice"`.
- R3. Platform flows through both text chat path (`/api/chat`) and voice path (`fetchStreamCredentials`).
- R4. iOS native + voice → `"ios_voice"`.
- R5. Text mode hides voice UI: waveform, mic button, voice status, emotion glow.
- R6. Text mode renders keyboard-first input: auto-focused, Enter-to-send, no mic.
- R7. Typing indicator ("Sophia is typing...") replaces waveform in text mode.
- R8. Text responses render as standard chat bubbles (already works).
- R9. Three-tab toggle: [💬 Message] [🎙️ Live] [⌨️ Text].
- R10. Toggle visible and accessible from session page.
- R11. Mode switching validates via `useModeSwitch()`.
- R12. Voice disconnects on text mode switch (existing — preserve).
- R13. Voice session hook doesn't connect in text mode.

## Scope Boundaries

- Backend PlatformContextMiddleware is Jorge's responsibility — frontend wires the signal only.
- No changes to voice mode UX.
- No "ios_text" platform value.
- No response content validation — we verify the signal arrives, not that output differs.
- Emotion color effects remain in "full" mode; hidden only in pure "text" mode.

## Context & Research

### Relevant Code and Patterns

**Two page surfaces exist:**
- `/session` page (`AI-companion-mvp-front/src/app/session/page.tsx`) — primary, uses `useSessionPageContext` → `chatRequestBody` → `useSessionChatRuntime` → `DefaultChatTransport(body: chatRequestBody)` → `POST /api/chat`. Platform already included in `chatRequestBody` from `usePlatformSignal()`.
- `/chat` page (`AI-companion-mvp-front/src/app/chat/page.tsx`) — legacy, uses `ConversationView` → `useChatAiRuntime` → `DefaultChatTransport({ api: "/api/chat" })` — no body, no platform.

**API route chain (already wired):**
- `chat-request.ts`: `parseAndValidateChatPayload` extracts `platform` from payload → `ValidatedChatRequest.platform`
- `post-handler.ts`: Constructs `backendPayload` with `platform` field
- `backend-client.ts`: `BackendStreamPayload` includes `platform` → sent to backend

**Voice path:**
- `useStreamVoiceSession.ts`: `fetchStreamCredentials(userId, "voice")` — `"voice"` is hardcoded. The function already accepts a `platform` parameter.

**Mode system:**
- `ui-store.ts`: `FocusMode = "full" | "voice" | "text"`, `setMode()`, `isManualOverride`
- `useModeSwitch.ts`: Validation logic for mode transitions
- `ConversationView.tsx`: Conditionally renders VoiceFocusView (voice), VoiceCollapsed + Transcript (text), VoicePanel + content (full)
- `VoiceCollapsed.tsx`: Shown in text mode — but displays mic icon and "switch to voice" CTA
- `VoiceFirstComposer.tsx`: Session page composer — mic-primary, text as expandable secondary

**Partial implementation from prior session (needs validation/fix):**
- `usePlatformSignal.ts`: Bug — `derivePlatform("full", false)` returns `"voice"`, should return `"text"`
- `useSessionPageContext.ts`: Already includes `platform` in `chatRequestBody`

### External References

- Spec: `docs/specs/05_frontend_ux.md` § 3 — Text Mode definition, three-tab toggle mockup
- Architecture: `01_architecture_overview (new).md` § 2 — Platform table (voice 1-3 sentences, text 2-5 sentences)

## Key Technical Decisions

- **`"full"` → `"text"` platform mapping**: The hybrid "full" mode is text-dominant (Composer shown, voice is optional). Backend should treat it as text for response length. (see origin: requirements R2)
- **Single `usePlatformSignal` hook**: Centralized derivation. Both `/session` and `/chat` pages use it. No per-component platform logic.
- **`VoiceFirstComposer` adapts conditionally**: In text mode, renders as text-only input (no mic toggle). No new composer component needed.
- **VoiceCollapsed replaced in text mode**: Instead of showing VoiceCollapsed (which has mic icon), text mode shows a clean typing indicator area when Sophia is responding. When idle, just the toggle is visible.
- **Mode toggle is a new component**: `ModeToggle.tsx` — small, reusable, renders three tabs. Used by both `/session` and `/chat` surfaces.

## Open Questions

### Resolved During Planning

- **Where does the toggle render?** Above the composer area. In session page: part of `VoiceFirstComposer` or adjacent. In chat/ConversationView: above the `AppShell` actionBar or inside the main content area alongside VoiceCollapsed.
- **Does VoiceFirstComposer need a separate text-only mode?** Yes — when `focusMode === "text"`, it should auto-expand the text area, hide the mic button, and auto-focus. This is achievable with a `textOnly` boolean prop.
- **How does the `/chat` page get platform?** Import `usePlatformSignal()` in `useChatAiRuntime.ts` or `ConversationView.tsx` and pass it through the transport body.

### Deferred to Implementation

- Exact styling and animation of the ModeToggle tabs — follow existing sophia-purple/surface patterns.
- Whether `VoiceFirstComposer`'s `isTextExpanded` state should auto-set on mode change or if the prop-based approach is cleaner.

## Implementation Units

- [ ] **Unit 1: Fix usePlatformSignal + session page wiring**

**Goal:** Fix the "full" → "text" mapping bug and validate the /session page platform flow is complete end-to-end.

**Requirements:** R1, R2, R4

**Dependencies:** None

**Files:**
- Modify: `AI-companion-mvp-front/src/app/hooks/usePlatformSignal.ts`
- Modify: `AI-companion-mvp-front/src/app/session/useSessionPageContext.ts` (validate, likely no change needed)
- Test: `AI-companion-mvp-front/tests/hooks/usePlatformSignal.test.ts`

**Approach:**
- In `derivePlatform()`: change the fallback from `return "voice"` to check `uiMode !== "voice" ? "text" : "voice"`. Specifically: `"text"` → `"text"`, `"full"` → `"text"`, `"voice"` + iOS → `"ios_voice"`, `"voice"` + non-iOS → `"voice"`.
- Confirm `useSessionPageContext.ts` already includes `platform` in `chatRequestBody` (it does from prior session).

**Patterns to follow:**
- Existing `usePlatformSignal.ts` structure

**Test scenarios:**
- Happy path: `derivePlatform("text", false)` → `"text"`
- Happy path: `derivePlatform("voice", false)` → `"voice"`
- Happy path: `derivePlatform("full", false)` → `"text"` (the bug fix)
- Happy path: `derivePlatform("voice", true)` → `"ios_voice"`
- Happy path: `derivePlatform("full", true)` → `"text"` (iOS doesn't affect text mode)
- Edge case: `derivePlatform("text", true)` → `"text"` (iOS text stays "text")

**Verification:**
- Unit tests pass for all FocusMode × isNativeIOS combinations.
- `/session` page `chatRequestBody` includes correct `platform` value when mode changes.

---

- [ ] **Unit 2: Wire platform signal to /chat page**

**Goal:** The legacy `/chat` page sends `platform` in every DeerFlow request.

**Requirements:** R1, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `AI-companion-mvp-front/src/app/chat/useChatAiRuntime.ts`
- Modify: `AI-companion-mvp-front/src/app/components/ConversationView.tsx` (if platform needs to be passed as prop or imported directly)

**Approach:**
- In `useChatAiRuntime`, import `usePlatformSignal()` and include `platform` in the `DefaultChatTransport` body.
- The transport body already flows to `POST /api/chat` → `parseAndValidateChatPayload` → `platform` extraction (already wired).
- Also wire platform into chat-store's `streamConversation` path if `/chat` page uses it (it does via `sendMessage` in chat-store).

**Patterns to follow:**
- How `useSessionPageContext.ts` passes `platform` via `chatRequestBody`
- How `useSessionChatRuntime.ts` passes body to `DefaultChatTransport`

**Test scenarios:**
- Integration: Switch to text mode in `/chat` → send message → API route receives `platform: "text"` in payload
- Integration: Switch to voice mode in `/chat` → send message → API route receives `platform: "voice"`
- Edge case: Default mode ("full") → API route receives `platform: "text"`

**Verification:**
- `console.log` or debug log in `post-handler.ts` shows `platform` field on every request from `/chat` page.

---

- [ ] **Unit 3: Wire platform signal to voice path (fetchStreamCredentials)**

**Goal:** Voice session sends `"ios_voice"` instead of hardcoded `"voice"` when on iOS.

**Requirements:** R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts`

**Approach:**
- Import `usePlatformSignal` or use `Capacitor` directly in the `startTalking` callback to derive the platform.
- Since `useStreamVoiceSession` is a hook, it can use `usePlatformSignal()` to get the current platform signal.
- Replace `fetchStreamCredentials(userId, "voice")` with `fetchStreamCredentials(userId, platform)` where `platform` comes from the hook.
- Note: when `startTalking` is called, the mode is already "voice" (the UI switches first), so `usePlatformSignal()` will return either `"voice"` or `"ios_voice"`.

**Patterns to follow:**
- How platform is derived in `usePlatformSignal.ts`

**Test scenarios:**
- Happy path: `startTalking()` on web browser → `fetchStreamCredentials(userId, "voice")` called
- Happy path: `startTalking()` on iOS native → `fetchStreamCredentials(userId, "ios_voice")` called
- Edge case: If mode switches mid-call, platform should reflect the mode at call start time

**Verification:**
- Console log in `fetchStreamCredentials` shows correct platform value.

---

- [ ] **Unit 4: Create ModeToggle component**

**Goal:** A three-tab toggle matching the spec: [💬 Message] [🎙️ Live] [⌨️ Text], wired to FocusMode.

**Requirements:** R9, R10, R11

**Dependencies:** None (can be developed in parallel with Units 1-3)

**Files:**
- Create: `AI-companion-mvp-front/src/app/components/ModeToggle.tsx`
- Test: `AI-companion-mvp-front/tests/components/ModeToggle.test.tsx`

**Approach:**
- Three-tab segmented control component.
- Uses `useModeSwitch()` for validation (disables voice tab when chat is locked, etc.).
- Maps tabs to FocusMode values: Message → "full", Live → "voice", Text → "text".
- Icons: 💬 (`MessageSquare`), 🎙️ (`Mic`), ⌨️ (`Keyboard` from lucide).
- Style: sophia-surface background, sophia-purple active indicator, smooth transition.
- Compact size — fits above or alongside the composer.

**Patterns to follow:**
- Existing sophia design tokens (`bg-sophia-surface`, `text-sophia-purple`, `rounded-xl`)
- `VoiceCollapsed.tsx` for button styling patterns
- `useModeSwitch()` for validation integration

**Test scenarios:**
- Happy path: Render with mode="full" → "Message" tab is active (highlighted)
- Happy path: Click "Live" tab → `setMode("voice")` called
- Happy path: Click "Text" tab → `setMode("text")` called
- Edge case: Voice tab disabled when `canSwitchToVoice.canSwitch === false` → shows tooltip
- Edge case: Active tab click → no-op (doesn't re-trigger mode set)

**Verification:**
- Component renders three tabs with correct labels and icons.
- Active tab visually distinguished.
- Disabled tabs show proper visual feedback and tooltip.

---

- [ ] **Unit 5: Text mode UX in session page**

**Goal:** When `focusMode === "text"` on the session page, hide voice elements, show text-first input, and display typing indicator.

**Requirements:** R5, R6, R7, R10

**Dependencies:** Unit 4 (ModeToggle component)

**Files:**
- Modify: `AI-companion-mvp-front/src/app/session/page.tsx` (integrate ModeToggle)
- Modify: `AI-companion-mvp-front/src/app/components/session/VoiceFirstComposer.tsx` (text-only mode)

**Approach:**
- **Session page**: Place `ModeToggle` above or adjacent to `VoiceFirstComposer`. When mode is "text", the `VoiceFirstComposer` receives a `textOnly` prop.
- **VoiceFirstComposer changes**:
  - New prop: `textOnly?: boolean`
  - When `textOnly === true`: auto-expand text area, hide mic button, auto-focus input, show typing indicator when `isTyping` is true (instead of waveform/mic status).
  - When `textOnly === false` (default): current behavior unchanged.
- The session page already has `VoiceComposerErrorBoundary` wrapping the composer — the toggle goes outside this boundary.
- Typing indicator: simple "Sophia is typing..." text with pulse animation, shown when `isTyping && textOnly`.

**Patterns to follow:**
- `VoiceFirstComposer.tsx` existing conditional rendering patterns
- `VoiceCollapsed.tsx` for sophia styling tokens

**Test scenarios:**
- Happy path: Mode is "text" → mic button hidden, text area auto-expanded, auto-focused
- Happy path: Mode is "text" + Sophia responding → typing indicator shown instead of voice status
- Happy path: Mode is "full" → normal VoiceFirstComposer behavior (mic + text expansion toggle)
- Happy path: ModeToggle visible above composer in all modes
- Edge case: Switch from voice to text → text area auto-focuses, voice UI elements vanish immediately

**Verification:**
- In text mode: no mic button, no voice status labels, typing indicator appears during AI response.
- In full/voice mode: VoiceFirstComposer unchanged from current behavior.
- ModeToggle renders and switches modes.

---

- [ ] **Unit 6: Text mode UX in /chat page (ConversationView)**

**Goal:** Text mode in ConversationView hides VoiceCollapsed banner and shows ModeToggle instead. Voice elements are removed in text mode.

**Requirements:** R5, R7, R9, R10

**Dependencies:** Unit 4 (ModeToggle component)

**Files:**
- Modify: `AI-companion-mvp-front/src/app/components/ConversationView.tsx`

**Approach:**
- In the `"text"` focusMode branch: replace `VoiceCollapsed` with `ModeToggle`. VoiceCollapsed's purpose (switch-to-voice CTA) is subsumed by the toggle.
- In the `"voice"` and `"full"` branches: add `ModeToggle` above the voice components.
- When mode is "text" and Sophia is responding (`isLocked`): show typing indicator ("Sophia is thinking...") in place of VoiceCollapsed/waveform.
- Emotion glow effects (from `useEmotionColor`) — skip injection when `focusMode === "text"`.

**Patterns to follow:**
- Existing conditional rendering in ConversationView per focusMode
- `VoiceCollapsed.tsx` for what gets replaced

**Test scenarios:**
- Happy path: Text mode → VoiceCollapsed not rendered, ModeToggle shown instead
- Happy path: Text mode + assistant streaming → typing indicator visible
- Happy path: Full mode → VoicePanel + ModeToggle both render
- Happy path: Voice mode → VoiceFocusView + ModeToggle render
- Edge case: Mode toggle from voice to text → voice state resets (existing behavior preserved)

**Verification:**
- In text mode: no mic icon, no voice status, no VoiceCollapsed. ModeToggle and Transcript visible.
- ModeToggle switches modes correctly from all three starting positions.

---

- [ ] **Unit 7: End-to-end validation**

**Goal:** Confirm platform signal reaches backend for both text and voice paths, and text mode UX is complete.

**Requirements:** R1–R13 (all)

**Dependencies:** Units 1–6

**Files:**
- No new files — manual testing and console validation

**Approach:**
- Start services via `scripts/start-all.ps1`
- Test text mode: send message → check browser network tab for `platform: "text"` in request body
- Test voice mode: start voice → check `fetchStreamCredentials` log for `platform: "voice"`
- Test mode toggle: all three tabs work, switching is validated
- Test text mode UX: no mic, no waveform, typing indicator visible
- Run TypeScript check: `pnpm typecheck` in frontend

**Test scenarios:**
- Integration: Send text message in "full" mode → network shows `platform: "text"`
- Integration: Send text message in "text" mode → network shows `platform: "text"`
- Integration: Start voice in "voice" mode → voice connect shows `platform: "voice"`
- Visual: Text mode → no mic, no waveform, typing indicator when responding
- Visual: Mode toggle renders three tabs, active tab highlighted
- Build: `pnpm typecheck` passes with zero errors

**Verification:**
- All platform values reach the backend correctly.
- Text mode UX matches spec: no voice elements, keyboard-first, typing indicator.
- Zero TypeScript errors.

## System-Wide Impact

- **Interaction graph:** `usePlatformSignal()` → `useSessionPageContext` / `useChatAiRuntime` → `DefaultChatTransport` → `POST /api/chat` → `backend-client.ts` → DeerFlow backend. Voice path: `usePlatformSignal()` → `useStreamVoiceSession` → `fetchStreamCredentials` → Voice server.
- **Error propagation:** If `usePlatformSignal()` returns wrong value, response length will be wrong but not break anything. Graceful degradation.
- **State lifecycle risks:** Mode changes mid-stream could cause the platform to change for in-flight requests. The `DefaultChatTransport` captures `body` at construction time via `useMemo`, so in-flight requests retain the platform they started with. New requests pick up the new platform.
- **API surface parity:** Both `/session` and `/chat` pages will send platform. Voice path also sends platform.
- **Unchanged invariants:** Backend `PlatformContextMiddleware` is not modified. Voice server `fetchStreamCredentials` endpoint contract is unchanged (already accepts `platform`).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `@capacitor/core` not installed in AI-companion-mvp-front | Already used in `usePlatformSignal.ts` — if import fails, tests will catch it immediately |
| Mode toggle interferes with existing auto-switch logic | Auto-switch only fires when `isManualOverride === false`. Toggle sets `setManualOverride(true)`. No conflict. |
| `usePlatformSignal` in `useStreamVoiceSession` violates Rules of Hooks | Hook is already a component-level hook — adding another hook import is safe. Just ensure it's at top level. |
| Backend PlatformContextMiddleware doesn't exist yet | Frontend wires the signal now. Backend reads it when Jorge implements. No breakage — unused field in configurable is ignored. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-03-31-text-mode-platform-detection-requirements.md](docs/brainstorms/2026-03-31-text-mode-platform-detection-requirements.md)
- **Spec:** [docs/specs/05_frontend_ux.md](docs/specs/05_frontend_ux.md) § 3 — Text Mode
- **Architecture:** [01_architecture_overview (new).md](01_architecture_overview%20(new).md) § 2 — Platform table
- **Build Plan:** [02_build_plan (new).md](02_build_plan%20(new).md) — Week 2 Day 4-5
- Related code: `AI-companion-mvp-front/src/app/hooks/usePlatformSignal.ts`, `useStreamVoiceSession.ts`, `useSessionPageContext.ts`, `useChatAiRuntime.ts`, `ConversationView.tsx`, `VoiceFirstComposer.tsx`
