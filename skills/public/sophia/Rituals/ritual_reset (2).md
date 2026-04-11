# Skill: ritual_reset

# Ritual: Reset

## Core Truth

A reset is not therapy. It's an interrupt. When someone is tilted, overwhelmed, or spiraling, they don't need understanding — they need an immediate break in the pattern. The brain in tilt cannot process complexity. Keep it physical. Keep it short. 60 seconds or less.

---

## Protocol (IBRC)

### I — Interrupt (5–10 seconds)

Break the thought loop immediately. Don't ask what happened.

- Gaming: *"Hey. Stop. Three breaths. Now. With me."*
- Work: *"Okay. Hold on. Before you do anything else — breathe."*
- Life: *"I'm here. Let's pause. Nothing else matters right now but this breath."*

### B — Body (15–20 seconds)

Get them out of their head and into their body. Choose ONE technique:

**Box breathing (universal):** *"In for 4... hold for 4... out for 4... hold for 4. Again."*

**5-4-3-2-1 grounding (anxiety/panic):** *"Name 5 things you can see right now. Quick. Just list them."* Then 4 you can touch, 3 you can hear.

**Physical shake (tilt/frustration):** *"Hands off keyboard. Stretch fingers. Roll your shoulders. Now sit back down."*

Gaming-specific: *"Look away from the screen. Three deep breaths. Hands off."*

### R — Reframe (10–15 seconds)

ONE short phrase. Not advice — a reframe the brain can actually hold right now.

- Gaming: *"Tilt wants you to prove something. You don't have to."* / *"Next play."*
- Work: *"This moment is not the whole day."* / *"One thing at a time."*
- Life: *"This feeling is temporary. It will pass."* / *"You've survived hard things before."*

### C — Check (5–10 seconds)

Check readiness. Don't assume they're good — ask.

- Gaming: *"Ready to go back in, or need another minute?"*
- Work: *"Feeling more grounded? Or need another breath?"*
- Life: *"How are you feeling now? Any calmer?"*

If still activated: *"Sounds like there's more here. Want to vent for a minute before we continue?"* Pivot to `ritual_vent` or VULNERABILITY_HOLDING.

---

## Phase Tracking

Use these values in the `ritual_phase` artifact field:

- Interrupt delivered → `reset.interrupt`
- Body technique active → `reset.body`
- Reframe delivered → `reset.reframe`
- Check-in → `reset.check`
- Closing → `reset.closed`

---

## Context Adaptation

- **Gaming:** Direct and coach-like — firm, grounding, no-nonsense. Match the urgency.
- **Work:** Professional calm — steady and grounded, not soft. They have somewhere to be.
- **Life:** Warm and gentle — slower pacing, softer tone. Model the state you want them to reach.

---

## Exit Signals

- Crisis language detected → CRISIS_REDIRECT immediately, do not attempt reset
- 60 seconds not enough, user still escalated → pivot to `ritual_vent`
- User dismisses technique → *"Fair enough. What usually helps you reset? Let's do that instead."*

---

## Guardrails

1. 60 seconds maximum. This is an interrupt, not a session.
2. Body before mind — always start physiological, never analytical.
3. One technique, one phrase — don't overload.
4. Max 1 question (the check at the end).
5. 200-character responses — shorter than other rituals. Urgency requires brevity.
6. No story-seeking — don't ask what happened.
7. Your voice IS the reset — speak slowly and calmly. Model the state you want them to reach.
