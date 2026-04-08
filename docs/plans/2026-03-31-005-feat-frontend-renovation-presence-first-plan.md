---
title: "feat: Frontend renovation — presence-first UX"
type: feat
status: active
date: 2026-03-31
origin: docs/brainstorms/2026-03-31-frontend-renovation-requirements.md
---

# Frontend Renovation: Presence-First UX

## Overview

Transform the frontend from a "chat app with voice features" to a presence-first experience where Sophia IS the interface. Four independent, progressively-shippable changes: emotional atmosphere canvas, session chrome fade, dashboard presence redesign, and voice-first mode hierarchy.

## Problem Frame

The current frontend treats voice as one of three equal modes and surrounds the user with persistent chrome (header, timer, settings, sidebars) during active conversation. The build plan and UX spec describe a fundamentally different vision: Sophia is already present when you open the app, the conversation fills the space, and UI gets out of the way during voice. (see origin: `docs/brainstorms/2026-03-31-frontend-renovation-requirements.md`)

## Requirements Trace

- R1–R6: Emotional atmosphere layer (canvas-based gradient from emotion bands)
- R7–R12: Session chrome fade during voice-active states
- R13–R18: Dashboard as Sophia's presence (radial rituals, larger MicCTA, hidden settings)
- R19–R23: Voice-first mode hierarchy (two-state + long-press PTT)
- SC1–SC6: Success criteria (immersive voice, inviting dashboard, no regressions, independent PRs, WCAG AA, reduced-motion)

## Scope Boundaries

- **In scope:** Visual/layout changes to dashboard and session. New canvas atmosphere component. Component modifications to VoiceFirstDashboard, SessionLayout, VoiceFirstComposer, ModeToggle replacement.
- **Out of scope:** Backend changes, voice pipeline, new API endpoints, Journal (Week 3), visual artifacts (Week 4), reflect flow (Week 5), Capacitor iOS (Week 6).
- **Not changing:** Auth flow, consent gate, onboarding, recap page, history page, settings internals, store data models.
- **Not this renovation:** Full /session + /chat route consolidation.

## Context & Research

### Relevant Code and Patterns

- `useEmotionColor.ts` — 5 color bands (WARM/CALM/ENERGETIC/INTENSE/TENDER) with `EmotionColor.rgb` tuples ready for canvas use
- `emotion-store.ts` — Zustand store, `.emotion` updated on artifact arrival
- `presence-store.ts` — States: `resting`, `listening`, `thinking`, `reflecting`, `speaking`. `computeStage()` derives from `isListening`, `isSpeaking`, `metaStage`
- `VoiceFirstDashboard.tsx` — Already has per-context layout configs (`LAYOUT_CONFIGS` for gaming/work/life) with positional styles. Already fetches bootstrap opener via `fetchBootstrapOpener`.
- `dashboard/MicCTA.tsx` — Breathing aura, embrace beams, presence indicator integration. Receives `selectedRitual` and `micState`.
- `dashboard/DashboardCosmicBackground.tsx` — Existing canvas-based cosmic backgrounds per context mode (gaming nebula, work shapes, life bokeh). This is the pattern to follow for atmosphere rendering.
- `SessionLayout.tsx` — Header with back button, preset label, timer, settings. Footer with end-session on mobile. Both use Tailwind transitions.
- `VoiceFirstComposer.tsx` — `textOnly` prop hides mic, `isTextExpanded` state controls text area visibility. `onMicClick` callback.
- `ModeToggle.tsx` — Three-tab toggle (`full`/`voice`/`text`). Uses `useUiStore` for mode and `useModeSwitch` for voice availability.
- `ui-store.ts` — `FocusMode = "full" | "voice" | "text"`, `mode`, `setMode`, `isManualOverride`.
- `globals.css` — CSS variables for light/dark themes, existing atmospheric CSS variables per context mode.
- `tailwind.config.ts` — sophia color namespace mapped to CSS variables, existing animation keyframes (breathe, glowBreathe, ringBreathe).

### Institutional Learnings

- `DashboardCosmicBackground` already renders canvas-based atmospheric effects per context mode — the emotional atmosphere layer follows this exact pattern but driven by emotion band instead of context mode.
- The `LAYOUT_CONFIGS` object in VoiceFirstDashboard already positions ritual cards with absolute positioning per context mode. The radial layout is an evolution of the gaming "orbital" config.
- Bootstrap opener is already fetched and stored in component state — the smart opener preview (R14) just needs rendering, no new API call.
- `usePlatformSignal` derives from `FocusMode` — any mode model change must keep this derivation working (R22).

## Key Technical Decisions

- **Canvas over CSS for atmosphere:** User chose canvas for richer animations. The codebase already has `DashboardCosmicBackground` as a canvas atmospheric rendering pattern — the atmosphere layer follows this exact approach. Canvas also enables future particle/noise effects without CSS complexity.
- **Radial ritual layout:** Rituals position radially around the enlarged MicCTA, evolving the gaming "orbital" `LAYOUT_CONFIGS` pattern to all contexts. On mobile, this compresses to a ring of smaller touch targets.
- **Long-press mic for PTT:** Push-to-talk activates via long-press (300ms threshold) on the session mic button. This replaces the "Message" tab from ModeToggle. The gesture is universal across voice and text modes since the mic button is always present.
- **FocusMode simplification:** Reduce from `"full" | "voice" | "text"` to `"voice" | "text"`. The `"full"` mode (push-to-talk / "Message") becomes a gesture variant of voice. `usePlatformSignal` maps both `"voice"` and long-press-active to platform `"voice"`.
- **Theme-aware fade opacity:** Chrome fades to `opacity: 0.08` (dark theme) / `opacity: 0.12` (light theme) rather than fixed 0.1. These thresholds ensure visibility on both backgrounds while remaining unobtrusive.
- **UI store `chromeFaded` flag:** The chrome fade state is a boolean in `ui-store` derived from presence status, with a kill switch (`disableChromeFade`) for development.

## Open Questions

### Resolved During Planning

- **Ritual layout:** Radial around MicCTA — extends gaming orbital pattern to all contexts.
- **PTT gesture:** Long-press mic (300ms threshold). Release sends. Visual feedback: mic icon fills/pulses during hold.
- **Atmosphere rendering:** Canvas — follows DashboardCosmicBackground pattern.
- **Opacity threshold:** Theme-aware values (0.08 dark / 0.12 light) instead of fixed 0.1.
- **Smart opener data source:** Already fetched via `fetchBootstrapOpener` in VoiceFirstDashboard — no new API needed. Render `bootstrapOpener.opener_text` below MicCTA.

### Deferred to Implementation

- **Canvas performance on low-end devices:** May need a `requestAnimationFrame` throttle or complexity reduction. Test on real devices.
- **Exact radial card positions:** The exact pixel/percentage positions for ritual touch targets in radial layout depend on final MicCTA sizing. Start with gaming orbital positions scaled up.
- **Long-press haptic feedback pattern:** Whether to use single haptic on threshold or progressive vibration during hold — depends on Capacitor haptic API behavior.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌─────────────────────────────────────────────────────────────┐
│  EmotionAtmosphereCanvas (full-viewport, z-0)               │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Reads: useEmotionColor() → rgb tuple                  ││
│  │  Renders: radial gradient wash on <canvas>             ││
│  │  Transitions: lerp between old/new rgb over 1.5s       ││
│  │  Reduced-motion: static fill, no animation loop        ││
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  Dashboard Page (z-10)          Session Page (z-10)         │
│  ┌─────────────────┐            ┌─────────────────────────┐│
│  │ Logo (settings)  │            │ ChromeFadeWrapper        ││
│  │ MicCTA (enlarged)│            │  ┌──────────────────┐   ││
│  │ Radial rituals   │            │  │ header, timer,   │   ││
│  │ Smart opener     │            │  │ settings, rail   │   ││
│  │ Context selector │            │  │ opacity: f(pres) │   ││
│  └─────────────────┘            │  └──────────────────┘   ││
│                                  │ Essential (always vis): ││
│                                  │  breathing dot, exit,   ││
│                                  │  mic/keyboard toggle    ││
│                                  │ VoiceFirstComposer      ││
│                                  │  (long-press = PTT)     ││
│                                  └─────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

**Chrome fade state machine:**
```
presence.status === listening|thinking|reflecting|speaking
  → start 500ms fade timer → chromeFaded = true → opacity tween to min
presence.status === resting
  → chromeFaded = false → opacity tween to 1.0
user tap on empty space
  → chromeFaded = false → opacity tween to 1.0
user tap on faded control
  → trigger control action + chromeFaded = false
```

**Mode model simplification:**
```
Before: FocusMode = "full" | "voice" | "text"
After:  FocusMode = "voice" | "text"

Voice mode: mic active, streaming conversation
Text mode:  keyboard icon tap → full composer, mic hidden
PTT mode:   long-press mic in voice mode → record → release → send
            (not a separate FocusMode, just a gesture within "voice")
```

## Implementation Units

### Phase 1: Emotional Atmosphere Layer

- [ ] **Unit 1: EmotionAtmosphereCanvas component**

**Goal:** Create a full-viewport canvas component that renders emotion-driven gradient washes behind all content.

**Requirements:** R1, R2, R3, R4, R5, R6, SC5, SC6

**Dependencies:** None — standalone component, existing hooks

**Files:**
- Create: `AI-companion-mvp-front/src/app/components/EmotionAtmosphereCanvas.tsx`
- Modify: `AI-companion-mvp-front/src/app/globals.css` (WCAG contrast helpers if needed)
- Test: `AI-companion-mvp-front/tests/unit/emotion-atmosphere-canvas.test.tsx`

**Approach:**
- Follow `DashboardCosmicBackground` canvas rendering pattern — `useRef<HTMLCanvasElement>`, `requestAnimationFrame` loop, resize observer
- Read `useEmotionColor()` for current `rgb` tuple. Default to WARM `[124, 92, 170]` when no emotion
- Render as radial gradient: center bright (low alpha ~0.15), edges fade to transparent. Two-tone: primary color center + complementary edge wash
- Color transitions: lerp from previous RGB to new RGB over ~1.5 seconds using frame interpolation
- `prefers-reduced-motion`: skip animation loop, render single static fill on mount and on emotion change
- Position: `fixed inset-0 z-0 pointer-events-none`
- Dashboard variant (R5): accept `lastSessionEmotion` prop, fade to WARM after 5min idle via `setTimeout`

**Patterns to follow:**
- `DashboardCosmicBackground.tsx` — canvas setup, resize handling, animation loop structure
- `useEmotionColor.ts` — color band consumption pattern

**Test scenarios:**
- Happy path: Component renders a canvas element at full viewport with pointer-events-none
- Happy path: When emotion store has "happy", canvas draws with ENERGETIC rgb values
- Happy path: When emotion changes from "calm" to "angry", colors smoothly transition (verify lerp is called over multiple frames)
- Edge case: When emotion is null, renders WARM default gradient
- Edge case: When `prefers-reduced-motion` is active, no animation frame loop runs — colors update via single draw calls
- Integration: When emotion-store updates (simulating artifact arrival), the canvas re-renders with new colors within 2 seconds
- Happy path: Canvas resizes correctly when window resizes (resize observer fires redraw)

**Verification:**
- Canvas mounts and renders gradient using emotion store color
- Color transitions animate smoothly between emotion changes
- WCAG AA contrast maintained for text overlaid on gradient (manual visual check)
- No animation loop when reduced-motion preference is set

---

- [ ] **Unit 2: Integrate atmosphere into dashboard and session pages**

**Goal:** Mount EmotionAtmosphereCanvas on both the dashboard and session pages, replacing the existing `bg-sophia-bg` static background.

**Requirements:** R1, R3, R5, SC1

**Dependencies:** Unit 1

**Files:**
- Modify: `AI-companion-mvp-front/src/app/components/VoiceFirstDashboard.tsx`
- Modify: `AI-companion-mvp-front/src/app/session/page.tsx`
- Test: `AI-companion-mvp-front/tests/unit/atmosphere-integration.test.tsx`

**Approach:**
- Dashboard: Add `<EmotionAtmosphereCanvas lastSessionEmotion={bootstrapOpener?.last_emotion} />` as first child inside the root div. Keep `DashboardCosmicBackground` layered on top (z-5) since it provides context-mode-specific effects
- Session: Add `<EmotionAtmosphereCanvas />` inside SessionLayout's root div, before the header. It reads live emotion from the store during active sessions
- Both pages: change root div from `bg-sophia-bg` to `bg-transparent` to let the canvas show through, while keeping `bg-sophia-bg` as a fallback body color

**Patterns to follow:**
- How `DashboardCosmicBackground` is already mounted in VoiceFirstDashboard

**Test scenarios:**
- Happy path: Dashboard page renders EmotionAtmosphereCanvas component
- Happy path: Session page renders EmotionAtmosphereCanvas component
- Integration: On dashboard, when no prior session emotion exists, canvas shows WARM
- Integration: On session page, emotion store changes propagate to canvas

**Verification:**
- Both pages show gradient background instead of flat color
- Dashboard uses last-session emotion fading to WARM
- Session page reflects live emotion changes

---

### Phase 2: Session Chrome Fade

- [ ] **Unit 3: Chrome fade UI store state and hook**

**Goal:** Add chrome fade state management to the UI store, driven by presence status, with a development kill switch.

**Requirements:** R7, R10, R11, R12

**Dependencies:** None — uses existing presence store

**Files:**
- Modify: `AI-companion-mvp-front/src/app/stores/ui-store.ts`
- Create: `AI-companion-mvp-front/src/app/hooks/useChromeFade.ts`
- Test: `AI-companion-mvp-front/tests/unit/chrome-fade.test.tsx`

**Approach:**
- Add to `ui-store`: `chromeFaded: boolean`, `disableChromeFade: boolean` (kill switch), `setChromeFaded`, `setDisableChromeFade`
- `useChromeFade` hook: subscribes to `usePresenceStore` status. When status is `listening`/`thinking`/`reflecting`/`speaking`, sets `chromeFaded = true` after 500ms delay. When status returns to `resting`, sets `chromeFaded = false`. Respects kill switch and text mode (`mode === "text"` → never fade)
- Returns `{ chromeFaded, chromeOpacity }` where `chromeOpacity` is the computed theme-aware value (0.08 dark / 0.12 light, or 1.0 when not faded)
- The 500ms delay uses a ref-based timer to prevent flicker on rapid state transitions

**Patterns to follow:**
- `usePresenceStore` subscription pattern with `computeStage`
- Existing timer patterns in presence-store (`reflectingGateMs`, `settleTimer`)

**Test scenarios:**
- Happy path: When presence enters "listening", chromeFaded becomes true after 500ms
- Happy path: When presence returns to "resting", chromeFaded becomes false immediately
- Edge case: Rapid listening→resting→listening within 500ms does not cause flicker (timer is reset)
- Edge case: When kill switch `disableChromeFade` is true, chromeFaded stays false regardless of presence
- Edge case: In text mode (`mode === "text"`), chromeFaded stays false
- Happy path: chromeOpacity returns theme-appropriate values (0.08/0.12 when faded, 1.0 when not)

**Verification:**
- Hook correctly derives fade state from presence
- Kill switch prevents all fading
- Text mode never triggers fade

---

- [ ] **Unit 4: Apply chrome fade to SessionLayout**

**Goal:** Wrap non-essential session chrome in opacity transitions driven by the chrome fade hook.

**Requirements:** R7, R8, R9, R10, SC1

**Dependencies:** Unit 3

**Files:**
- Modify: `AI-companion-mvp-front/src/app/components/SessionLayout.tsx`
- Test: `AI-companion-mvp-front/tests/unit/session-chrome-fade.test.tsx`

**Approach:**
- Import `useChromeFade` hook
- Wrap header, footer, and settings/theme buttons in a container with `style={{ opacity: chromeOpacity }}` and `transition-opacity duration-500`
- Keep these elements always visible (essential per R9): PresenceIndicator (breathing dot), back/exit button, mode toggle icon
- Faded elements remain in the DOM and tappable (R8). Add `onClick` handler on a transparent overlay that sets `chromeFaded = false` on tap of empty space (R10)
- When a faded control is tapped, it fires its action normally — the click event propagates through the low-opacity element. A `pointerdown` listener on the SessionLayout root checks if the target is a faded interactive element and unfades chrome alongside the action

**Patterns to follow:**
- Existing opacity transitions in SessionLayout (header `translate-y-0` entrance animation)
- PresenceIndicator component for the "breathing dot" essential element

**Test scenarios:**
- Happy path: When chromeFaded is true, header opacity transitions to near-zero
- Happy path: When chromeFaded is false, header returns to full opacity
- Happy path: Essential elements (back button, presence dot) remain at full opacity during fade
- Edge case: Tapping empty space when faded unfades chrome
- Edge case: Tapping a faded settings button both opens settings AND unfades chrome
- Edge case: Footer (mobile end-session) also fades with the same opacity
- Integration: Presence entering "listening" triggers chrome fade after 500ms; returning to "resting" restores chrome

**Verification:**
- During a voice-active state, session screen shows minimal chrome — just presence dot, exit, and mode icon
- All faded elements remain interactive
- Tap-to-unfade works on empty space

---

### Phase 3: Dashboard as Sophia's Presence

- [ ] **Unit 5: Radial ritual layout and enlarged MicCTA**

**Goal:** Replace the context-mode-specific card grid with a radial layout centered on an enlarged MicCTA, with rituals as conversation starters positioned around it.

**Requirements:** R13, R16, R17, SC2

**Dependencies:** None — modifies existing dashboard components

**Files:**
- Modify: `AI-companion-mvp-front/src/app/components/VoiceFirstDashboard.tsx` (LAYOUT_CONFIGS, JSX structure)
- Modify: `AI-companion-mvp-front/src/app/components/dashboard/MicCTA.tsx` (larger sizing)
- Modify: `AI-companion-mvp-front/src/app/components/dashboard/RitualCard.tsx` (compact radial variant)
- Test: `AI-companion-mvp-front/tests/unit/dashboard-radial-layout.test.tsx`

**Approach:**
- Replace the three `LAYOUT_CONFIGS` (gaming/work/life) with a single radial config. Cards position at compass points (top-left, top-right, bottom-left, bottom-right) around the MicCTA using absolute positioning with `transform: translate(...)` from center
- MicCTA: increase base size from current (approximately 80×80px button area) to ~120×120px. The breathing aura scales proportionally
- RitualCard: add a `compact` variant prop. In radial mode, cards render as smaller rounded elements with icon + short label (e.g., "How'd it go?") — not full card with description
- Context mode selector (R16): move from tab bar position to below the ritual ring, as a subtle text-based selector
- First launch (R17): when `!hasBootstrap && !bootstrapOpener`, show MicCTA with warm breathing state, no rituals selected, no smart opener
- On mobile (<640px): radial positions compress inward, cards become touch-pill-sized

**Patterns to follow:**
- Gaming `LAYOUT_CONFIGS` orbital pattern — absolute positioning with CSS transitions
- MicCTA's existing breathing aura animation (`glowBreathe`, `ringBreathe` keyframes)

**Test scenarios:**
- Happy path: All 4 ritual cards render in radial positions around the MicCTA
- Happy path: MicCTA renders at enlarged size (120px area)
- Happy path: Tapping a ritual card selects it (existing `handleRitualSelect` behavior preserved)
- Edge case: On mobile viewport (<640px), layout compresses without overlapping
- Edge case: First launch with no prior sessions shows warm MicCTA with no smart opener
- Integration: Context mode change updates ritual labels but layout positions remain stable

**Verification:**
- Dashboard centers on the MicCTA with rituals orbiting it
- Visual hierarchy reads as "Sophia is present" rather than "configure your session"
- Context selector is visible but secondary

---

- [ ] **Unit 6: Smart opener preview and settings drawer**

**Goal:** Show the smart opener preview below MicCTA and move settings/history/theme behind a logo tap that opens a drawer.

**Requirements:** R14, R15, R18, SC2

**Dependencies:** Unit 5

**Files:**
- Modify: `AI-companion-mvp-front/src/app/components/VoiceFirstDashboard.tsx` (smart opener display, settings drawer trigger)
- Create: `AI-companion-mvp-front/src/app/components/dashboard/SettingsDrawer.tsx`
- Test: `AI-companion-mvp-front/tests/unit/dashboard-settings-drawer.test.tsx`

**Approach:**
- Smart opener (R14): render `bootstrapOpener.opener_text` as a subtle, faded line below the MicCTA. Only show when `hasMeaningfulBootstrapOpener` is true (already computed in VoiceFirstDashboard). Style: `text-sophia-text2/60 text-sm italic`
- Settings drawer (R15): add a Sophia logo element (small, top-left or top-right corner). On tap, open a bottom-sheet drawer containing: settings link, history link, theme toggle, account info. Use the existing `MobileBottomSheet` pattern from `DashboardSidebar`
- Remove from main dashboard view: theme toggle icon, settings icon, history floating button. These all move into the drawer
- Active session (R18): the `ResumeBanner` already handles this. Ensure it renders prominently above the MicCTA area with a "Resume" CTA

**Patterns to follow:**
- `MobileBottomSheet` from `DashboardSidebar.tsx` — drawer animation, focus trap, backdrop
- `ThemeToggle` component — reuse inside the drawer

**Test scenarios:**
- Happy path: When bootstrap opener exists and is meaningful, preview text renders below MicCTA
- Happy path: When no opener exists, no preview text renders
- Happy path: Tapping logo opens settings drawer with settings link, history link, theme toggle
- Happy path: Tapping drawer backdrop closes it
- Edge case: When active session exists, resume banner shows with "Resume" affordance
- Edge case: Generic openers (in `GENERIC_BOOTSTRAP_OPENERS` set) are not shown as preview
- Integration: Clicking settings link in drawer navigates to /settings

**Verification:**
- Smart opener appears as a subtle hint of what Sophia will say
- Settings/history/theme are accessible but hidden behind a single tap
- Dashboard surface is visually clean — no scattered icons

---

### Phase 4: Voice-First Mode Hierarchy

- [ ] **Unit 7: Simplify FocusMode to two states**

**Goal:** Replace the three-state FocusMode with a two-state model (voice/text) and update all consumers.

**Requirements:** R19, R22, R23

**Dependencies:** None — store and type change, then consumer updates

**Files:**
- Modify: `AI-companion-mvp-front/src/app/stores/ui-store.ts` (FocusMode type)
- Modify: `AI-companion-mvp-front/src/app/hooks/usePlatformSignal.ts` (derivePlatform update)
- Modify: `AI-companion-mvp-front/src/app/hooks/useModeSwitch.ts` (remove "full" handling)
- Modify: `AI-companion-mvp-front/src/app/components/ConversationView.tsx` (remove "full" case)
- Modify: `AI-companion-mvp-front/src/app/session/page.tsx` (remove "full" handling)
- Test: `AI-companion-mvp-front/tests/unit/focus-mode-simplification.test.tsx`

**Approach:**
- Change `FocusMode = "full" | "voice" | "text"` to `FocusMode = "voice" | "text"`
- Default mode changes from `"full"` to `"voice"` (R19)
- `usePlatformSignal.derivePlatform`: remove the `"full"` case. `"voice"` → `"voice"`, `"text"` → `"text"`, iOS native → `"ios_voice"`
- All places that check `mode === "full"` → check `mode === "voice"` instead
- Session mode resets to `"voice"` on new session start but persists within a session (R23). Add `useEffect` on session ID change to reset mode
- TypeScript compiler will surface all remaining `"full"` references

**Patterns to follow:**
- Existing `usePlatformSignal.derivePlatform` exhaustive switch pattern

**Test scenarios:**
- Happy path: Default mode is "voice" (not "full")
- Happy path: derivePlatform("voice", false) returns "voice"
- Happy path: derivePlatform("text", false) returns "text"
- Happy path: derivePlatform("voice", true) returns "ios_voice"
- Edge case: No TypeScript errors after removing "full" — all consumers compile
- Edge case: Mode resets to "voice" when session ID changes
- Integration: Platform signal correctly reflects two-state mode in chat request body

**Verification:**
- `FocusMode` has exactly two values
- `usePlatformSignal` produces correct platform strings
- No TypeScript errors across the frontend
- Mode persists within a session, resets between sessions

---

- [ ] **Unit 8: Replace ModeToggle with voice/text toggle and long-press PTT**

**Goal:** Replace the three-tab ModeToggle with a compact mic/keyboard icon pair, and add long-press-to-talk gesture on the session mic button.

**Requirements:** R20, R21, R23, SC1

**Dependencies:** Unit 7

**Files:**
- Modify: `AI-companion-mvp-front/src/app/components/ModeToggle.tsx` (rewrite to two-state)
- Modify: `AI-companion-mvp-front/src/app/components/session/VoiceFirstComposer.tsx` (long-press gesture)
- Create: `AI-companion-mvp-front/src/app/hooks/useLongPress.ts`
- Test: `AI-companion-mvp-front/tests/unit/mode-toggle-v2.test.tsx`
- Test: `AI-companion-mvp-front/tests/unit/long-press-ptt.test.tsx`

**Approach:**
- ModeToggle → `ModeIndicator`: renders as a small icon pair at the bottom of the session screen. Active mode is highlighted. Mic icon for voice, keyboard icon for text. Single-tap to switch
- `useLongPress` hook: detects 300ms press-and-hold on a target element. Returns `{ isLongPressing, longPressHandlers }`. Handles both touch and pointer events. Cancels on move (>10px threshold)
- VoiceFirstComposer: integrate `useLongPress` on the mic button. When long-press detected:
  1. Haptic feedback
  2. Visual feedback (mic icon fills/pulses, "Recording..." label)
  3. Start recording (call `onMicClick` equivalent)
  4. On release: stop recording, send
- Short tap on mic: existing behavior (toggle voice session on/off)
- The PTT visual state is local to VoiceFirstComposer — not a FocusMode change

**Patterns to follow:**
- VoiceFirstComposer's existing touch handling (`touchStartYRef` for swipe detection)
- MicCTA's breathing animation for long-press visual feedback

**Test scenarios:**
- Happy path: ModeIndicator renders mic and keyboard icons, active mode highlighted
- Happy path: Tapping keyboard icon switches to text mode
- Happy path: Tapping mic icon switches back to voice mode
- Happy path: Long-press (300ms+) on mic activates PTT recording state
- Happy path: Releasing after long-press stops recording
- Edge case: Short tap (<300ms) does not trigger PTT — fires normal mic click
- Edge case: Moving finger >10px during press cancels long-press detection
- Edge case: In text mode, mic button appears but long-press still works (switches to voice + PTT)
- Integration: Mode switch updates platform signal correctly

**Verification:**
- ModeToggle replaced with compact two-icon indicator
- Long-press on mic enables push-to-talk with visual/haptic feedback
- Short tap preserves existing mic toggle behavior
- "Message" tab no longer exists in the UI

## System-Wide Impact

- **Interaction graph:** EmotionAtmosphereCanvas reads emotion-store (unchanged write path from artifact ingestion). Chrome fade reads presence-store (unchanged write path from voice events). Mode simplification affects usePlatformSignal → chat request body → backend platform routing.
- **Error propagation:** Canvas rendering errors should be caught with try/catch in the animation loop — never crash the page. Chrome fade uses CSS opacity — no error surface.
- **State lifecycle risks:** FocusMode change from `"full"` default to `"voice"` has no persistence risk — `ui-store` is not persisted (verified: no `persist` middleware). Mode resets on page load, so no migration needed.
- **API surface parity:** `usePlatformSignal` must continue producing the same three platform strings (`"voice"`, `"text"`, `"ios_voice"`). The backend platform routing is unchanged.
- **Integration coverage:** Chrome fade + presence store interaction needs integration testing. Mode simplification + platform signal needs integration testing.
- **Unchanged invariants:** Backend API contracts, store data models, artifact ingestion pipeline, voice WebRTC flow, session lifecycle, authentication flow.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Canvas performance on low-end mobile | Follow DashboardCosmicBackground pattern which already runs on mobile. Add `requestAnimationFrame` throttle. Test on real devices before merging |
| Radial layout tight on small screens (<400px) | Compress radius and reduce card sizes. Test on xs breakpoint (400px) |
| FocusMode default change | ui-store is not persisted (verified). No migration needed — mode resets to "voice" on every page load |
| Long-press conflicts with existing touch gestures | useLongPress cancels cleanly on move. Test alongside swipe-to-expand text area |
| Settings drawer hides navigation | Drawer is one tap away. Settings/history are low-frequency actions. If user testing shows discoverability issues, add a subtle icon hint |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-03-31-frontend-renovation-requirements.md](docs/brainstorms/2026-03-31-frontend-renovation-requirements.md)
- Related code: `AI-companion-mvp-front/src/app/components/dashboard/DashboardCosmicBackground.tsx`
- Related code: `AI-companion-mvp-front/src/app/hooks/useEmotionColor.ts`
- Related code: `AI-companion-mvp-front/src/app/stores/presence-store.ts`
- Build plan: `02_build_plan (new).md` — Week 2 frontend renovation alignment
- UX spec: `docs/specs/05_frontend_ux.md` — vision reference
