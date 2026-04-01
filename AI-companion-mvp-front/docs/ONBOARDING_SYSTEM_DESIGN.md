# Sophia — Onboarding System Design

> A guided, voice-assisted onboarding experience that feels like Sophia herself welcoming the user into the product.

---

## Table of Contents

1. [Part 1 — Onboarding Architecture](#part-1--onboarding-architecture)
2. [Part 2 — First-Run Onboarding Flow](#part-2--first-run-onboarding-flow)
3. [Part 3 — Progressive Onboarding](#part-3--progressive-onboarding)
4. [Part 4 — Personalization](#part-4--personalization)
5. [Part 5 — Visual Polish](#part-5--visual-polish)
6. [Part 6 — Edge Cases](#part-6--edge-cases)
7. [Part 7 — Implementation Plan](#part-7--implementation-plan)

---

## Part 1 — Onboarding Architecture

### Design Philosophy

The existing `OnboardingFlow` is a full-screen modal with 4 generic steps (welcome, voice, text, privacy). It teaches *input methods* but never shows the user the actual product. The new system replaces this with a **route-aware, spotlight-driven guided tour** where Sophia walks the user through the real interface — pointing at real elements, on real screens, with her real voice.

The core principle: **the UI is the tutorial**. No separate tutorial screens. The user sees the actual dashboard, session, and recap — with Sophia highlighting what matters.

---

### Onboarding State — Where It Lives

**Store: `useOnboardingStore` (Zustand + persist)**

The existing store is replaced with a richer model:

```
OnboardingState {
  // First-run guided tour
  firstRun: {
    status: "not_started" | "in_progress" | "skipped" | "completed"
    currentStepId: string | null
    completedSteps: string[]
    skippedAt: string | null       // ISO timestamp
    completedAt: string | null     // ISO timestamp
  }

  // Progressive (contextual) tips
  contextualTips: {
    [tipId: string]: {
      seen: boolean
      seenAt: string | null        // ISO timestamp
      dismissed: boolean
    }
  }

  // User preferences
  preferences: {
    voiceOverEnabled: boolean      // default: true
    reducedMotion: boolean         // respects prefers-reduced-motion
  }

  // Actions
  startOnboarding: () => void
  advanceStep: () => void
  goToStep: (stepId: string) => void
  skipOnboarding: () => void
  completeOnboarding: () => void
  markTipSeen: (tipId: string) => void
  dismissTip: (tipId: string) => void
  resetOnboarding: () => void     // for replay from settings
  setVoiceOverEnabled: (v: boolean) => void
}
```

**Persistence:** Zustand `persist` middleware with `localStorage` key `"sophia-onboarding-v2"`. This survives refresh and stays device-local. Cross-device sync is intentionally not supported for onboarding — if a user switches devices, they get a fresh tour (see Part 6).

**Migration:** The existing `"sophia-onboarding"` key is read once. If `hasCompletedOnboarding === true`, the new store initializes with `firstRun.status = "completed"` and all contextual tips unmarked (so the user still gets progressive tips on features they haven't seen). The old key is then deleted.

---

### Step Configuration

Steps are defined as a static configuration array, not hardcoded into components. This makes the flow editable, reorderable, and testable.

```
OnboardingStepConfig {
  id: string                      // unique key, e.g. "dashboard-mic"
  phase: "first-run" | "contextual"
  route: string                   // route where this step activates, e.g. "/"
  
  // Spotlight targeting
  target: {
    selector: string              // CSS selector, e.g. "[data-onboarding='mic-cta']"
    padding: number               // px padding around element (default: 12)
    shape: "circle" | "rounded-rect"
  } | null                        // null = no spotlight (full-screen message)

  // Content
  content: {
    title: string                 // short heading
    body: string                  // 1-2 sentences max
    voiceLine: string | null      // TTS text, shorter than body
    position: "top" | "bottom" | "left" | "right" | "center"
  }

  // Behavior
  advanceOn: "click-next" | "interact-target" | "auto-delay"
  autoDelayMs?: number            // for "auto-delay" advance
  canGoBack: boolean
  
  // Prerequisite (for progressive tips)
  trigger?: {
    type: "element-visible" | "store-value" | "event"
    config: Record<string, any>
  }
}
```

**`data-onboarding` attributes:** Every targetable UI element receives a `data-onboarding` attribute. This is the contract between the component tree and the onboarding engine. It decouples step targeting from component internals (class names, DOM structure).

Elements that need attributes:
- `data-onboarding="mic-cta"` → MicCTA button
- `data-onboarding="ritual-card-prepare"` → first ritual card
- `data-onboarding="ritual-grid"` → the ritual card container
- `data-onboarding="context-switcher"` → Gaming/Work/Life tabs (if visible)
- `data-onboarding="artifacts-panel"` → artifacts sidebar in session
- `data-onboarding="memory-card"` → first memory candidate in recap
- `data-onboarding="recap-summary"` → recap summary section

---

### Spotlight Targeting Across Routes

The onboarding engine is a **top-level provider** rendered in `AppShell`, above all page content but below modals.

**Route-awareness works as follows:**

1. The `OnboardingOrchestrator` component reads the current step config.
2. It compares `step.route` against `usePathname()`.
3. If the user is on the correct route → it renders the spotlight overlay and tooltip.
4. If the user is NOT on the correct route → two behaviors:
   - If the step's route is navigable (e.g., `/` → user is already there), it renders a "navigate" nudge.
   - If the step requires a context that doesn't exist yet (e.g., a session in progress), the step is deferred and the engine advances to the next eligible step.

**Element resolution:**
- `document.querySelector(step.target.selector)` runs after a short delay (100ms) to allow render.
- If the element is not found after 3 attempts (100ms apart), the step is auto-skipped with a console warning. This prevents the tour from getting stuck.
- `ResizeObserver` and `MutationObserver` track the target element for position changes (responsive layout, scroll).

**Scroll handling:**
- If the target element is off-screen, `scrollIntoView({ behavior: 'smooth', block: 'center' })` is called before the spotlight appears.

---

### Persistence & Progress

| Scenario | Behavior |
|----------|----------|
| User completes all steps | `firstRun.status = "completed"`, timestamp saved |
| User taps "Skip" | `firstRun.status = "skipped"`, timestamp saved |
| User refreshes mid-tour | Store is persisted. On next load, the engine resumes at `currentStepId` |
| User clears localStorage | Treated as a new user. Onboarding starts from scratch |
| User replays from Settings | `resetOnboarding()` resets `firstRun` to `"not_started"` |

---

### Skip & Replay

**Skip:** Available at every step via a subtle "Skip tour" link in the tooltip footer. Tapping it triggers `skipOnboarding()` which sets status to `"skipped"` and fades out the overlay. A toast appears: *"You can replay the tour anytime from Settings."*

**Replay:** In the Settings page, a row labeled *"Replay Sophia's tour"* calls `resetOnboarding()` and navigates to `/`. The engine detects `status === "not_started"` and begins.

---

## Part 2 — First-Run Onboarding Flow

### Flow Sequence

After the user passes AuthGate → ConsentGate, the onboarding begins. The existing `OnboardingFlow` modal is retired. Instead, the user lands directly on the dashboard with the guided tour overlaid.

The sequence is 7 steps. Total time: ~60 seconds.

---

### Step 1 — Welcome

| Property | Value |
|----------|-------|
| **id** | `welcome` |
| **route** | `/` |
| **target** | `null` (full-screen) |
| **position** | `center` |

**Visual:** The dashboard renders behind a frosted dark overlay (no spotlight cutout). Centered on screen: Sophia's wordmark or a minimal logo mark, followed by the text.

**Text:**
> Welcome, {name}.
>
> I'm Sophia — your space to think, decompress, and grow.
> Let me show you around. It'll take a minute.

**Voice-over:**
> "Welcome, {name}. Let me show you around."

**Advance:** "Continue" button. No back button on this step.

**Design note:** The tone is warm but not effusive. No "Hey there! 🎉". This is Linear-level restraint — a calm sentence, a clear promise of brevity.

---

### Step 2 — The Microphone

| Property | Value |
|----------|-------|
| **id** | `dashboard-mic` |
| **route** | `/` |
| **target** | `{ selector: "[data-onboarding='mic-cta']", shape: "circle", padding: 16 }` |
| **position** | `bottom` |

**Text:**
> This is the microphone.
>
> Tap it to start a session with me. You can talk or type — voice is always first.

**Voice-over:**
> "Tap the mic to start a session."

**Advance:** "Next" button.

**Design note:** The spotlight circles the breathing mic organism. The aura animation continues inside the cutout — the element stays alive. The tooltip appears below the mic, centered.

---

### Step 3 — Rituals

| Property | Value |
|----------|-------|
| **id** | `dashboard-rituals` |
| **route** | `/` |
| **target** | `{ selector: "[data-onboarding='ritual-grid']", shape: "rounded-rect", padding: 20 }` |
| **position** | `top` (mobile) / `right` (desktop, if orbital layout) |

**Text:**
> These are rituals.
>
> Each one sets the tone for our conversation — Prepare focuses you before something important, Debrief helps you reflect, Reset clears your head, and Vent gives you space to let it out.
>
> If you tap the mic without choosing one, we'll have an open conversation.

**Voice-over:**
> "Pick a ritual to set the tone — or just tap the mic for an open conversation."

**Advance:** "Next" button.

**Design note:** The spotlight covers all four ritual cards as a group, not individually. This prevents the step from feeling like a drill-down. One glance, one concept. The tooltip explicitly addresses the "no ritual = open session" mental model — this is the key UX insight from the product brief.

---

### Step 4 — The Session

| Property | Value |
|----------|-------|
| **id** | `session-concept` |
| **route** | `/` |
| **target** | `null` (full-screen) |
| **position** | `center` |

**Visual:** Full-screen overlay with a subtle illustration or screenshot mockup of the session screen (a static visual, not a navigation). The illustration shows a voice waveform + a message bubble + the artifacts panel faintly visible.

**Text:**
> When a session starts, we talk.
>
> I listen, respond, and sometimes surface observations called artifacts — small insights that emerge from our conversation.

**Voice-over:**
> "In a session, we talk. I'll surface insights as we go."

**Advance:** "Next" button.

**Design note:** This step does NOT navigate to `/session` because there's no active session. Instead, it uses a conceptual illustration. This avoids the technical problem of needing a real session and keeps the onboarding self-contained on the dashboard route.

---

### Step 5 — Artifacts

| Property | Value |
|----------|-------|
| **id** | `artifacts-concept` |
| **route** | `/` |
| **target** | `null` (full-screen) |
| **position** | `center` |

**Visual:** A stylized card showing an example artifact — a "takeaway" with a short sentence, rendered in the product's actual artifact card style. Floating beside it, a faint memory candidate card and a reflection prompt.

**Text:**
> Artifacts are what I notice during our conversation.
>
> They can be takeaways, things worth remembering, or questions to sit with.

**Voice-over:**
> "Artifacts capture what matters in our conversations."

**Advance:** "Next" button.

**Design note:** Showing a *rendered example* of a real artifact card (with the actual component styles) makes this feel native rather than tutorial-like. The example content should be generic but realistic: *"You tend to underestimate how much preparation helps."*

---

### Step 6 — Memory

| Property | Value |
|----------|-------|
| **id** | `memory-concept` |
| **route** | `/` |
| **target** | `null` (full-screen) |
| **position** | `center` |

**Visual:** A stylized memory candidate card with approve/reject buttons visible, rendered in the recap's actual orbit style but static. A small "Sophia remembers..." header above it.

**Text:**
> Sometimes I'll suggest things worth remembering about you.
>
> You're always in control — you approve or reject every memory before it's saved.

**Voice-over:**
> "You decide what I remember. Always."

**Advance:** "Next" button.

**Design note:** The voice line is deliberately short and direct. Memory is a trust-sensitive concept. The tone is "you're in charge", not "we collect data". The approve/reject UI preview builds confidence that this isn't opaque.

---

### Step 7 — Ready

| Property | Value |
|----------|-------|
| **id** | `ready` |
| **route** | `/` |
| **target** | `{ selector: "[data-onboarding='mic-cta']", shape: "circle", padding: 16 }` |
| **position** | `top` |

**Text:**
> That's it.
>
> Whenever you're ready, tap the mic.

**Voice-over:**
> "Whenever you're ready."

**Advance:** "Start" button or direct tap on the mic. Both dismiss the onboarding and complete it.

**Design note:** The spotlight returns to the mic. This creates a bookend — the tour began by pointing at the mic and ends by inviting the user to use it. The "Start" button uses the Sophia purple accent. The overlay fades out over 500ms. The dashboard is now fully interactive.

---

### Step Summary

| # | Step ID | Route | Target | Voice-over |
|---|---------|-------|--------|------------|
| 1 | `welcome` | `/` | none | "Welcome, {name}. Let me show you around." |
| 2 | `dashboard-mic` | `/` | mic-cta | "Tap the mic to start a session." |
| 3 | `dashboard-rituals` | `/` | ritual-grid | "Pick a ritual to set the tone — or just tap the mic for an open conversation." |
| 4 | `session-concept` | `/` | none | "In a session, we talk. I'll surface insights as we go." |
| 5 | `artifacts-concept` | `/` | none | "Artifacts capture what matters in our conversations." |
| 6 | `memory-concept` | `/` | none | "You decide what I remember. Always." |
| 7 | `ready` | `/` | mic-cta | "Whenever you're ready." |

All 7 steps live on the `/` route. No navigation required during first-run onboarding. This is a deliberate decision — cross-route onboarding introduces fragility (what if the user closes the session? what if the route transition is slow?). The conceptual steps (4, 5, 6) use visual previews instead.

---

## Part 3 — Progressive Onboarding

Progressive tips activate **after** first-run onboarding is complete (or skipped). They teach features in context, at the moment of relevance.

### Contextual Tip Design

Each tip is a **single tooltip** that appears near a relevant element, with:
- A short message (1-2 sentences)
- A "Got it" dismiss button
- Optional voice-over (only for high-value tips)
- No spotlight overlay (too disruptive for in-context tips)
- A subtle entrance animation (fade + slide from the edge nearest the target)

Tips appear **once per trigger**. After dismissal, they are marked as `seen` in the store and never appear again.

---

### Tip Catalog

#### Tip: First Artifacts Appear

| Property | Value |
|----------|-------|
| **id** | `tip-first-artifacts` |
| **trigger** | Artifacts panel receives its first artifact during a session |
| **route** | `/session` |
| **target** | `[data-onboarding="artifacts-panel"]` |
| **delay** | 2000ms after artifact renders (let the user notice it first) |

**Text:**
> Here are your first artifacts — observations from our conversation. They'll stay here until the session ends.

**Voice-over:** None. The user is in a conversation; interrupting with TTS would be jarring.

---

#### Tip: First Memory Candidate (Recap)

| Property | Value |
|----------|-------|
| **id** | `tip-first-memory-candidate` |
| **trigger** | User reaches recap page with at least one memory candidate |
| **route** | `/recap/[sessionId]` |
| **target** | `[data-onboarding="memory-card"]` |
| **delay** | 1500ms after recap renders |

**Text:**
> This is a memory candidate. Tap to approve it — or dismiss it. You're always in control.

**Voice-over:**
> "You decide what stays."

---

#### Tip: First Recap

| Property | Value |
|----------|-------|
| **id** | `tip-first-recap` |
| **trigger** | User reaches recap for the first time ever |
| **route** | `/recap` or `/recap/[sessionId]` |
| **target** | `[data-onboarding="recap-summary"]` |
| **delay** | 1000ms |

**Text:**
> This is your session recap. It captures the key moments from our conversation.

**Voice-over:**
> "Here's what we covered."

---

#### Tip: First Interruption Card

| Property | Value |
|----------|-------|
| **id** | `tip-first-interruption` |
| **trigger** | An interruption/nudge card appears for the first time in session |
| **route** | `/session` |
| **target** | The interruption card element |
| **delay** | 1000ms |

**Text:**
> Sometimes I'll offer a gentle nudge or suggestion. You can always continue the conversation naturally.

**Voice-over:** None.

---

#### Tip: First Ritual Suggestion (Suggested by Sophia)

| Property | Value |
|----------|-------|
| **id** | `tip-first-ritual-suggestion` |
| **trigger** | A ritual card shows the "Suggested by Sophia" badge |
| **route** | `/` |
| **target** | The ritual card with `isSuggested` |
| **delay** | 800ms |

**Text:**
> I suggested this ritual based on your recent sessions. You can always choose a different one.

**Voice-over:** None.

---

#### Tip: First Memory Highlight (Bootstrap Greeting)

| Property | Value |
|----------|-------|
| **id** | `tip-first-bootstrap-memory` |
| **trigger** | BootstrapGreeting renders with memory highlight cards |
| **route** | `/session` |
| **target** | `[data-onboarding="memory-highlight"]` |
| **delay** | 2000ms (after greeting animation completes) |

**Text:**
> These are things I remember from past sessions. They help me be more relevant.

**Voice-over:** None.

---

### Progressive Tip Triggering Mechanism

Tips are triggered by an `OnboardingTipGuard` component that wraps (or is placed near) the relevant UI element. This component:

1. Reads the tip config for its `tipId`.
2. Checks `contextualTips[tipId].seen` in the store. If seen → renders nothing.
3. Checks the trigger condition (element visible, store value, etc.).
4. When triggered, waits the configured delay.
5. Renders the tooltip with AnimatePresence.
6. On "Got it" → calls `markTipSeen(tipId)`.

This approach is **declarative** and **co-located** — the tip lives near the component it describes, not in a distant orchestrator. This makes it maintainable and testable.

---

## Part 4 — Personalization

### Name Injection

The user's display name is already resolved in `useAuthTokenStore` via Discord metadata, with the priority: `full_name > name > preferred_username > email`.

Onboarding steps access the name through a simple utility:

```
getDisplayName(): string
  → reads useAuthTokenStore.getState().userInfo
  → extracts first name (split on space, take [0])
  → falls back to "there" if unavailable
```

**Usage in steps:**
- Welcome: "Welcome, {firstName}."
- Voice lines: "Welcome, {firstName}. Let me show you around."

**Usage in progressive tips:**
- Memory tip: "Sophia may remember patterns that help you, {firstName}."

**Voice-over personalization:** The TTS engine receives the personalized string. Since the voice lines are synthesized at runtime (not pre-recorded), the name is naturally included.

### Personalization Constraints

- Only the **first name** is used in onboarding (feels personal without being formal).
- If the name is unavailable, the greeting becomes "Welcome." — never "Welcome, null." or "Welcome, undefined."
- The name is read from the store at render time, not baked into the step config. This ensures it's always current.

---

## Part 5 — Visual Polish

### Spotlight Implementation

The spotlight is a **full-viewport SVG overlay** with a mask cutout. This approach (vs. CSS box-shadow or backdrop tricks) provides:

- Pixel-perfect cutouts for any shape (circle, rounded rect)
- Smooth animation of cutout position/size via CSS transitions on SVG attributes
- No interference with the target element's interactivity (the cutout is a real hole)

**Structure:**

```
<svg> (fixed, full viewport, z-index: 60, pointer-events: none)
  <defs>
    <mask id="spotlight-mask">
      <rect fill="white" width="100%" height="100%"/>  <!-- everything visible -->
      <rect/circle fill="black" [animated position]/>   <!-- cutout hole -->
    </mask>
  </defs>
  <rect fill="rgba(0,0,0,0.7)" mask="url(#spotlight-mask)" width="100%" height="100%"/>
</svg>
```

The **cutout element** (black shape in the mask) is positioned using `getBoundingClientRect()` of the target element, updated on resize/scroll.

**Interaction pass-through:** The SVG overlay has `pointer-events: none`. The tooltip itself has `pointer-events: auto`. The target element remains interactive (for the final "tap the mic" step).

---

### Blur Overlay

Behind the dark overlay, a `backdrop-filter: blur(8px)` is applied to the overlay rect. This softens the background UI, making the spotlight cutout feel like a window into clarity.

**Performance note:** `backdrop-filter` can cause jank on low-end devices. The `reducedMotion` preference disables blur and uses a solid semi-transparent overlay instead.

**The blur value:** 8px is enough to defocus UI elements without making them unrecognizable. The user should still see the ghost of the dashboard behind the overlay — it builds spatial awareness.

---

### Tooltip Style

The tooltip is a floating card rendered via absolute positioning relative to the viewport (not the target element — this avoids scroll/overflow issues).

**Visual properties:**

| Property | Value |
|----------|-------|
| Background | `rgba(15, 10, 25, 0.92)` — near-black with a hint of Sophia's purple |
| Border | `1px solid rgba(124, 92, 170, 0.2)` — subtle Sophia purple edge |
| Border radius | `16px` |
| Box shadow | `0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(124, 92, 170, 0.08)` |
| Padding | `24px 28px` |
| Max width | `360px` |
| Font — title | 16px, weight 500, `sophia-text` color (off-white) |
| Font — body | 14px, weight 400, `sophia-text2` color (muted) |
| Font — voice label | 12px, weight 400, italic, `sophia-purple` color |

**Arrow/pointer:** A small CSS triangle (8px) pointing toward the target element, matching the tooltip background. Its position adjusts based on the `position` config (top/bottom/left/right).

**Step indicator:** A row of small dots at the bottom of the tooltip (inside, not below). The current step is filled with Sophia purple; others are `rgba(255,255,255,0.2)`. Only shown during first-run onboarding (not progressive tips).

**Buttons:**
- "Next" / "Continue" / "Start" — pill-shaped, Sophia purple background, white text, 36px height.
- "Back" — text-only, muted color, left-aligned.
- "Skip tour" — text-only, smallest size (12px), bottom-right, very subtle. Present at every step but never prominent.

---

### Animation Timing

All animations follow a **calm, unhurried** cadence. No bouncy springs. No playful overshoots.

| Animation | Duration | Easing | Notes |
|-----------|----------|--------|-------|
| Overlay fade in | 400ms | `ease-out` | On first step mount |
| Overlay fade out | 500ms | `ease-in-out` | On tour complete/skip |
| Spotlight cutout move | 500ms | `cubic-bezier(0.4, 0, 0.2, 1)` | When transitioning between steps with different targets |
| Spotlight cutout appear | 350ms | `ease-out` | Scale from 0 to final size |
| Tooltip enter | 350ms | `ease-out` | Fade + translate 12px from direction |
| Tooltip exit | 250ms | `ease-in` | Fade out + translate 8px toward direction |
| Step dot transition | 200ms | `ease-in-out` | Color fill |
| Button hover | 150ms | `ease` | Background lightens |

**Reduced motion:** When `prefers-reduced-motion: reduce` or `preferences.reducedMotion` is true, all animations are replaced with instant opacity changes (0 → 1 in 0ms). The experience works, but without motion.

---

### Transitions Between Steps

When the user taps "Next":

1. The **tooltip** fades out (250ms).
2. *(If the next step has a different target)* the **spotlight cutout** animates to the new position (500ms).
3. *(If the next step has no target)* the **spotlight cutout** scales down to 0 and the overlay becomes uniform (400ms).
4. *(If going from no-target to a target)* the overlay remains uniform, then the cutout scales up at the new position (350ms).
5. The **new tooltip** fades in at its new position (350ms).

Steps 2 and 5 overlap slightly — the tooltip starts fading in 100ms before the spotlight animation completes. This creates a feeling of continuous flow rather than sequential blocks.

---

### Color & Atmosphere

The onboarding overlay should feel like an extension of Sophia's cosmic theme:

- The dark overlay uses the same deep indigo-black as the session background.
- The tooltip's subtle purple border connects it to the Sophia brand color.
- When the spotlight reveals the mic or ritual cards, their existing animations (breathing aura, floating cards) continue — the UI feels alive inside the cutout.
- No new colors are introduced. Everything uses the existing design token palette.

---

## Part 6 — Edge Cases

### The user skips onboarding

- `firstRun.status` is set to `"skipped"`.
- The overlay fades out immediately (500ms).
- A toast appears: *"You can replay the tour from Settings."* (auto-dismiss after 4 seconds).
- Progressive contextual tips are **still active**. Skipping the tour doesn't disable feature discovery. The user will still see tips when they encounter artifacts, memory, or recap for the first time.

### The user refreshes mid-onboarding

- The store is persisted. `currentStepId` tracks where they were.
- On reload, after AuthGate + ConsentGate pass, the onboarding engine resumes at the persisted step.
- The overlay and tooltip appear after a 300ms delay (allowing the page to render and the target element to mount).
- If the target element for the current step no longer exists (e.g., layout changed), the engine attempts the next step.

### The user enters directly into a session (deep link or URL)

- If `firstRun.status === "not_started"`, the engine checks the current route.
- If the user is on `/session` and the current step requires `/`, the onboarding is **deferred** — a subtle banner appears at the top: *"Sophia has a quick tour for you when you're back on the dashboard."*
- When the user returns to `/`, the onboarding begins.
- If the user entered via `/session` because they have an active session (e.g., from a previous device), breaking the session to show onboarding would be intrusive. Defer always.

### The user changes device

- Onboarding state is `localStorage`-only, not synced to the backend.
- On a new device, `firstRun.status` will be `"not_started"`.
- **This is acceptable and even desirable.** The user might benefit from seeing the tour on a new form factor (phone vs. desktop). The tour is under 60 seconds — replaying it is low cost.
- If backend sync is ever desired, a `PATCH /user/preferences` endpoint can be added later, and the store can hydrate from it on first load. But this is not MVP.

### Mobile layout shifts element positions

- The spotlight system uses **live `getBoundingClientRect()`** reads, not cached positions.
- A `ResizeObserver` on the target element re-calculates position on layout changes.
- On orientation change, the engine re-reads positions after a 200ms debounce (to allow CSS transitions to settle).
- Tooltip position is **collision-aware**: if the tooltip would overflow the viewport, it flips to the opposite side or centers on screen. This is calculated per-step based on available space.
- On very small viewports (< 360px width), the tooltip renders as a **bottom sheet** instead of a floating card. Same content, but docked to the bottom of the screen with the spotlight above. This avoids cramped floating tooltips on small phones.

### The user has `prefers-reduced-motion`

- All animations are disabled (opacity transitions only).
- Blur is disabled (solid overlay).
- Voice-over still plays (it's not motion).
- The `reducedMotion` preference is auto-detected and stored in `preferences.reducedMotion`.

### The user is offline

- Onboarding is fully client-side. No API calls needed.
- Voice-over requires TTS which may need network (depending on implementation — see Part 7). If offline, voice lines are silently skipped. The text is always visible.

---

## Part 7 — Implementation Plan

This is the roadmap a frontend engineer should follow. No code — just the work breakdown, sequenced by dependency.

---

### Phase 1 — Onboarding Engine (Foundation)

**Goal:** Build the core orchestration layer that powers both first-run and progressive onboarding.

**Work items:**

1. **Migrate `useOnboardingStore`**
   - Design and implement the new store schema (replacing the existing v1 store).
   - Add migration logic: read `sophia-onboarding` v1 key, map `hasCompletedOnboarding` to `firstRun.status`, delete old key.
   - All new state fields: `firstRun`, `contextualTips`, `preferences`, and actions.

2. **Define step configuration**
   - Create `onboardingSteps.ts` — the static array of `OnboardingStepConfig` objects for all 7 first-run steps.
   - Create `contextualTips.ts` — the static array of progressive tip configs.
   - Both files are pure data — no components, no side effects.

3. **Build `OnboardingOrchestrator` component**
   - Top-level component mounted in `AppShell` (replaces the existing lazy-loaded `OnboardingFlow`).
   - Reads `firstRun.status` and `currentStepId` from store.
   - Resolves the current step config.
   - Checks route match via `usePathname()`.
   - Manages step transitions (advance, back, skip).
   - Renders `SpotlightOverlay` + `OnboardingTooltip` as children.

4. **Add `data-onboarding` attributes**
   - Add attributes to `MicCTA`, `RitualCard`, ritual grid container, artifacts panel, recap elements, memory cards.
   - These are trivial additions — just a `data-onboarding="xxx"` prop on the outer element.

---

### Phase 2 — Spotlight System

**Goal:** Build the visual overlay that highlights elements.

**Work items:**

1. **Build `SpotlightOverlay` component**
   - Full-viewport SVG with mask-based cutout.
   - Accepts `target: { rect, shape, padding }` or `null` (no cutout).
   - Animates cutout position/size on target change.
   - Handles `backdrop-filter: blur()` on the overlay.
   - Applies `pointer-events: none` on SVG, with `pointer-events: auto` on tooltip.

2. **Build `useTargetRect` hook**
   - Accepts a CSS selector string.
   - Returns a live `DOMRect` (or null if element not found).
   - Uses `ResizeObserver` + `MutationObserver` for updates.
   - Debounces updates at 16ms (one frame).
   - Handles element not found (3 retries at 100ms).

3. **Handle reduced motion**
   - Detect `prefers-reduced-motion` via `matchMedia`.
   - Store in `preferences.reducedMotion`.
   - Disable blur, replace animations with instant opacity.

---

### Phase 3 — Tooltip Component

**Goal:** Build the floating tooltip that displays step content.

**Work items:**

1. **Build `OnboardingTooltip` component**
   - Renders the card with title, body, buttons, step dots.
   - Positioned relative to viewport using `position: fixed`.
   - Accepts `position`, `targetRect`, and collision-avoids viewport edges.
   - Arrow pointer toward target.
   - AnimatePresence for enter/exit transitions.

2. **Build tooltip positioning logic**
   - Calculate placement based on `position` preference + available space.
   - Flip to opposite side if overflowing.
   - Fall back to bottom-sheet on viewport < 360px wide.

3. **Build step navigation UI**
   - "Next" / "Continue" / "Start" primary button (label varies by step — defined in config).
   - "Back" text button (hidden on first step).
   - "Skip tour" subtle link.
   - Step dots (current step highlighted).

---

### Phase 4 — First-Run Flow Integration

**Goal:** Wire the engine into the app lifecycle and test the 7-step flow.

**Work items:**

1. **Update `AppShell`**
   - Remove the old `OnboardingFlow` lazy import.
   - Mount `OnboardingOrchestrator` after ConsentGate resolves.
   - The orchestrator self-manages visibility based on store state.

2. **Build conceptual step visuals (steps 4, 5, 6)**
   - Create lightweight illustration components for session, artifacts, and memory concepts.
   - These render inside the tooltip area (or as a centered card within the overlay).
   - They reuse existing component styles (artifact card, memory card) but with static/mock data.

3. **End-to-end testing**
   - Playwright test: full onboarding flow from auth to completion.
   - Test skip behavior.
   - Test refresh mid-tour.
   - Test reduced motion.
   - Test mobile viewport (bottom-sheet tooltip).

---

### Phase 5 — Voice-Over Integration

**Goal:** Add Sophia's voice to onboarding steps.

**Work items:**

1. **Choose TTS approach**
   - **Option A — Backend TTS:** Send voice line text to the existing voice WebSocket endpoint. This uses the same Sophia voice model. Advantage: consistent voice. Disadvantage: requires network + WebSocket setup.
   - **Option B — Web Speech API:** Use `SpeechSynthesis` with a suitable voice. Advantage: fully client-side, instant, offline-capable. Disadvantage: voice doesn't match Sophia's session voice.
   - **Recommended: Option A** with Option B as fallback. The onboarding should sound like Sophia. If the WebSocket isn't available (offline, error), skip voice silently.

2. **Build `useOnboardingVoice` hook**
   - Accepts a voice line string and a `play` trigger.
   - Sends the text to the TTS endpoint.
   - Plays the returned audio.
   - Exposes `isPlaying` state (for visual sync — e.g., a subtle waveform or speaker icon in the tooltip).
   - Respects `preferences.voiceOverEnabled`.

3. **Add voice toggle**
   - A small speaker icon in the tooltip header. Tap to mute/unmute voice for the rest of the tour.
   - Persisted in `preferences.voiceOverEnabled`.

4. **Voice timing**
   - Voice starts 200ms after the tooltip fully enters.
   - If the user taps "Next" while voice is playing, the audio stops immediately (no overlap).
   - Voice lines are short (under 4 seconds each). If TTS takes longer than 5 seconds to start, skip it.

---

### Phase 6 — Progressive Tips

**Goal:** Implement contextual discovery tips for in-product features.

**Work items:**

1. **Build `OnboardingTipGuard` component**
   - A wrapper or sibling component placed near the UI element it describes.
   - Reads tip config, checks store, evaluates trigger condition.
   - Renders a lightweight tooltip (no spotlight overlay — just the floating card).
   - "Got it" button dismisses and marks as seen.

2. **Integrate tips into existing components**
   - Add `OnboardingTipGuard` inside or next to:
     - Artifacts panel (session page)
     - Memory candidate cards (recap page)
     - Recap summary section (recap page)
     - Interruption card (session page)
     - Suggested ritual card (dashboard)
     - Memory highlights (session bootstrap greeting)

3. **Trigger evaluation**
   - `element-visible`: Uses `IntersectionObserver` on the target element.
   - `store-value`: Subscribes to a Zustand store selector.
   - `event`: Listens for a custom event dispatched by the feature component.

---

### Phase 7 — Analytics & Observability

**Goal:** Track onboarding effectiveness.

**Work items:**

1. **Define analytics events**

   | Event | Payload | Trigger |
   |-------|---------|---------|
   | `onboarding.started` | `{ timestamp }` | First step renders |
   | `onboarding.step_viewed` | `{ stepId, stepIndex, durationMs }` | Each step mount (duration = time on previous step) |
   | `onboarding.step_back` | `{ fromStep, toStep }` | Back button |
   | `onboarding.skipped` | `{ atStep, stepIndex }` | Skip button |
   | `onboarding.completed` | `{ totalDurationMs, stepsViewed }` | Final step complete |
   | `onboarding.voice_toggled` | `{ enabled }` | Voice toggle |
   | `onboarding.tip_shown` | `{ tipId }` | Progressive tip renders |
   | `onboarding.tip_dismissed` | `{ tipId, durationMs }` | Tip "Got it" button |
   | `onboarding.replayed` | `{ previousCompletionDate }` | Replay from settings |

2. **Emit events through the existing analytics pipeline**
   - The app has consent-gated analytics via `useConsentStore.canSaveMemories()`. Onboarding events follow the same gate.
   - Events are fire-and-forget — they don't block UI transitions.

3. **Observability dashboard** (future)
   - Funnel: started → completed vs. started → skipped.
   - Drop-off by step (which step do users skip at most?).
   - Average onboarding duration.
   - Progressive tip engagement rate.

---

### Phase 8 — Settings Integration & Polish

**Goal:** Final integration and polish.

**Work items:**

1. **Add "Replay tour" to Settings page**
   - Single row with a replay icon and label.
   - Calls `resetOnboarding()` and `router.push("/")`.

2. **Accessibility audit**
   - Focus management: trap focus in tooltip, return focus on dismiss.
   - Screen reader: `aria-label` on overlay, `role="dialog"` on tooltip, `aria-live` for step changes.
   - Keyboard: Escape to skip, Enter/Space for next, Tab to navigate buttons.

3. **Performance audit**
   - Ensure spotlight SVG doesn't cause paint thrashing.
   - Verify `backdrop-filter` performance on target devices (especially Android).
   - Lazy-load conceptual step illustrations.
   - Total bundle size added by onboarding: target < 15KB gzipped.

4. **QA matrix**

   | Scenario | Expected |
   |----------|----------|
   | New user, desktop, Chrome | Full flow with voice |
   | New user, mobile, Safari | Full flow, bottom-sheet tooltips on small screens |
   | Returning user (v1 completed) | No first-run, progressive tips active |
   | Skip at step 3 | Toast shown, tips still active |
   | Refresh at step 5 | Resumes at step 5 |
   | Offline | Full flow, voice silently skipped |
   | Reduced motion | No animations, no blur |
   | Replay from settings | Full flow from step 1 |
   | Direct URL to /session | Onboarding deferred to dashboard return |
   | Capacitor (iOS/Android) | Same behavior, haptic feedback on step transitions |

---

## Appendix — UX References

| Product | What to learn from it |
|---------|----------------------|
| **Arc Browser** | The "welcome to Arc" guided tour spotlights real UI elements with a dark overlay and minimal text. Steps feel like a conversation, not a manual. |
| **Linear** | Onboarding is near-invisible — the product teaches itself through progressive disclosure. Tooltips appear only when you encounter a feature for the first time. No forced tour. |
| **Notion** | The first-run experience is a single page of templates, not a tutorial. Context-sensitive tooltips appear on hover near complex features. Very low friction. |
| **Apple (iOS setup)** | Each screen has one concept, one illustration, one action. Calm pacing. No "step 3 of 12" anxiety. The progress indicator is subtle. |
| **Slack** | Slackbot sends messages that teach features. Sophia's voice-over serves a similar role — the product's own entity guides you, not a generic system. |

The through-line across all these references: **restraint**. The best onboarding is the one the user barely notices because the product feels intuitive. Sophia's tour should leave the user thinking "that was easy" — not "that was thorough."

---

## Appendix — Component Tree (for reference)

```
AppShell
├── AuthGate
├── ConsentGate
├── OnboardingOrchestrator          ← NEW (replaces OnboardingFlow)
│   ├── SpotlightOverlay            ← NEW
│   │   └── SVG mask + blur overlay
│   └── OnboardingTooltip           ← NEW
│       ├── Step content (title, body, voice icon)
│       ├── Step dots
│       └── Navigation buttons
├── Header
├── Page Content
│   ├── VoiceFirstDashboard
│   │   ├── MicCTA [data-onboarding="mic-cta"]
│   │   ├── RitualCard [data-onboarding="ritual-card-*"]
│   │   └── ritual grid [data-onboarding="ritual-grid"]
│   ├── SessionPage
│   │   ├── ArtifactsPanel [data-onboarding="artifacts-panel"]
│   │   ├── BootstrapGreeting
│   │   │   └── MemoryHighlightCard [data-onboarding="memory-highlight"]
│   │   └── OnboardingTipGuard (per feature) ← NEW
│   └── RecapPage
│       ├── RecapSummary [data-onboarding="recap-summary"]
│       ├── RecapMemoryOrbit [data-onboarding="memory-card"]
│       └── OnboardingTipGuard (per feature) ← NEW
└── UsageLimitModal
```

---

*This document is the source of truth for the Sophia onboarding system. Implementation should follow the phases in Part 7 sequentially. No code should be written before this design is reviewed and approved.*
