---
date: 2026-03-31
topic: frontend-renovation-presence-first
---

# Frontend Renovation: Presence-First UX

## Problem Frame

The current frontend was built as a "chat app with voice features." The build plan and UX spec (05_frontend_ux.md) describe a fundamentally different vision: Sophia IS the interface — you open the app and she's already present, she speaks first, the conversation fills the space, and the app gets out of the way during voice.

Three specific misalignments between vision and current reality:

1. **Dashboard is a launcher, not a presence.** 4 ritual cards, context tabs, history drawer, settings icon, theme toggle, founding supporter badge — it reads as "configure your session" rather than "Sophia is here."
2. **Session page is a chat app with panels.** Header bar, artifacts sidebar/drawer, companion rail, mode toggle, session timer — even during active voice, the user is surrounded by chrome. The moment is crowded.
3. **Voice, text, and message are treated as equals.** A three-tab ModeToggle gives each mode equal weight. The spec explicitly says voice is the primary differentiator. Text is first-class but not co-equal.

This renovation is **progressive** — 4 targeted changes that each land independently without blocking Weeks 3–6 deliverables (Journal, visual artifacts, reflect flow, Capacitor iOS).

## Requirements

**Emotional Atmosphere Layer**

- R1. The session background renders a full-viewport gradient wash derived from `useEmotionColor`'s current color band (WARM / CALM / ENERGETIC / INTENSE / TENDER).
- R2. When the emotion band changes (artifact updates between turns), the gradient transitions smoothly over 1–2 seconds. No jarring color jumps.
- R3. The default state (no artifact yet / between sessions) uses WARM — Sophia's signature purple palette.
- R4. The atmosphere layer renders behind all content and does not interfere with text readability. Use low-opacity washes and ensure WCAG AA contrast for all text over the gradient.
- R5. On the dashboard, the atmosphere reflects the last-session emotion if available, fading to WARM after 5+ minutes of inactivity or on first launch.
- R6. The atmosphere must respect `prefers-reduced-motion` — users with this preference see a static tint, no transitions.

**Session Chrome Fade**

- R7. During active voice states (presence status: `listening`, `thinking`, `speaking`), the session page progressively fades non-essential chrome: header bar, artifacts rail trigger, companion rail, session timer, and mode-access elements.
- R8. The fade is a smooth opacity transition (300–500ms). Chrome reaches near-invisible but remains tappable (opacity ~0.1, not `display: none`) so accidental taps don't break layout.
- R9. Essential elements remain visible during voice: a minimal Sophia presence indicator (breathing dot or waveform), an exit/back gesture target, a mute/end-session affordance, and the mode-switch affordance (mic/keyboard icon from R20).
- R10. Chrome returns to full opacity when voice enters `ready` or `idle` state, or when the user taps empty space (not a UI control). Tapping a faded control triggers both its action and unfades chrome.
- R11. In text mode, chrome remains at full opacity — fading only applies to voice-active states.
- R12. The fade behavior has a kill switch (UI store flag) so it can be disabled during development and testing.

**Dashboard as Sophia's Presence**

- R13. The dashboard centers on Sophia's presence: the breathing MicCTA organism fills the visual focus (larger than current). Ritual options appear as conversation starters below or around it, not as a card grid.
- R14. If a smart opener preview exists (from the last session handoff), it appears as a subtle line near the mic: a hint of what Sophia will say when the user taps. Example: "Ready to talk about the pitch?"
- R15. Settings, history, and account access are hidden behind a dedicated Sophia logo element (distinct from the MicCTA). Tapping this logo opens a compact side sheet or bottom drawer with: settings link, history link, theme toggle, and account info.
- R16. The context mode selector (gaming/work/life) remains accessible but secondary — positioned below the rituals, not as a prominent tab bar.
- R17. On first launch (no prior sessions), the dashboard shows the MicCTA breathing with a warm welcome state. No smart opener, no last-session emotion.
- R18. Active session detection: if a session is already active, the dashboard shows a "resume" affordance rather than the ritual selection flow.

**Voice-First Mode Hierarchy**

- R19. Voice (Live) is the default mode. When a user starts a session, they enter voice mode unless they explicitly choose text.
- R20. Text mode is accessible via a compact keyboard icon at the bottom of the session screen — not a co-equal tab. Tapping it transitions to text input with full composer. Tapping the mic icon returns to voice.
- R21. The three-tab ModeToggle component (`ModeToggle.tsx`) is replaced with a two-state indicator: voice-active or text-active. The "Message" (push-to-talk) mode is accessible as a long-press or secondary gesture on the mic button — not a separate tab.
- R22. Platform signal derivation (`usePlatformSignal`) continues to work correctly: voice → "voice", text → "text", iOS voice → "ios_voice". The UI hierarchy change does not affect backend platform routing.
- R23. Mode memory persists within a session: if the user switches to text mid-session, they stay in text until they tap mic. Between sessions, mode resets to voice.

## Success Criteria

- SC1. During a voice session, the user sees Sophia's presence and the emotional atmosphere — not an app with panels and headers. Screens feel "full" of the moment.
- SC2. A new user opening the dashboard for the first time feels Sophia is present and inviting, not that they're configuring an app.
- SC3. Existing features (session lifecycle, artifacts, memory candidates, recap) continue working. No functional regressions.
- SC4. All 4 changes can land independently as separate PRs without blocking each other or Weeks 3–6 features.
- SC5. WCAG AA contrast is maintained across all emotion atmosphere color states.
- SC6. `prefers-reduced-motion` is respected throughout.

## Scope Boundaries

- **In scope:** Visual and layout changes to dashboard and session pages. Existing component modifications (VoiceFirstDashboard, SessionLayout, VoiceFirstComposer, ModeToggle). New atmosphere layer component.
- **Out of scope:** Backend changes, voice pipeline changes, new API endpoints, Journal (Week 3), visual artifacts (Week 4), reflect flow (Week 5), Capacitor iOS (Week 6).
- **Not changing:** Authentication flow, consent gate, onboarding system, recap page, history page, settings page internals, chat store / session store data models.
- **Not this renovation:** Full route consolidation (merging /session and /chat into one surface). That would be a future structural change after the progressive renovation proves the direction.

## Key Decisions

- **Progressive over rewrite:** Each change is standalone and independently shippable. This avoids blocking Weeks 3–6 deliverables and reduces risk.
- **Chrome fades, not hides:** `opacity: ~0.1` rather than `display: none` so layout stability is preserved and edge-case taps still work.
- **Avatar opens settings drawer:** Settings/history/account move behind Sophia's logo tap. This is a significant navigation change from the current always-visible header.
- **Push-to-talk as gesture, not tab:** "Message mode" moves from a co-equal tab to a long-press variant on the mic button. This simplifies the mode model from three states to two visible states + one gesture.

## Dependencies / Assumptions

- `useEmotionColor` hook and emotion store already exist and are reliable — verified in codebase scan.
- `usePresenceStore` already tracks `listening`, `speaking`, `thinking`, `ready` states — verified.
- The VoiceFirstDashboard component is self-contained enough to modify without affecting session runtime.
- Week 3 Journal will be a new route (`/journal`) that links from the settings/history drawer, not from the dashboard directly.

## Outstanding Questions

### Deferred to Planning
- [Affects R8][Technical] What is the optimal opacity threshold for faded chrome — does 0.1 work on all backgrounds, or does it need to vary per theme?
- [Affects R13][Needs research] How should ritual "conversation starters" be laid out around the MicCTA — radial, vertical list, or horizontal scroll?
- [Affects R14][Technical] How does the smart opener preview get surfaced on the dashboard before the session starts — does it require a new fetch, or is it already in the session handoff data?
- [Affects R21][Needs research] What's the best gesture for push-to-talk — long-press mic, swipe-up on mic, or a small secondary button?
- [Affects R1][Technical] Should the atmosphere gradient be CSS-based (faster, simpler) or canvas-based (more dynamic, richer animations)?

## Next Steps

→ `/ce-plan` for structured implementation planning
