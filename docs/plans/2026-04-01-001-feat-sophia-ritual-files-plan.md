---
title: "feat: Create 4 Sophia ritual protocol files"
type: feat
status: active
date: 2026-04-01
---

# feat: Create 4 Sophia Ritual Protocol Files

## Overview

Create the 4 ritual markdown files (prepare, debrief, vent, reset) in `skills/public/sophia/rituals/`. These are skill-like protocol files that `RitualMiddleware` injects into the system prompt when a ritual is active. Each defines a multi-step conversational protocol with phase transitions.

## Problem Frame

The `RitualMiddleware` is implemented and working — it reads from `rituals_dir / f"{ritual}.md"` and injects the content. But the directory is empty. When a user selects a ritual via `configurable.ritual`, the middleware logs a warning and injects nothing. The rituals are core to Sophia's session structure per the spec.

## Requirements Trace

- R1. Each ritual file follows the same format as existing skill files (title, when loaded, core, protocol steps, rules, exit conditions)
- R2. Each ritual defines named phases that map to `ritual_phase` in state (e.g., `prepare.step1_intention`)
- R3. Rituals guide the LLM through a structured multi-turn protocol, not a single-turn instruction
- R4. Each ritual has clear entry conditions, phase transitions, and exit to freeform
- R5. Token budget: ~600 tokens per ritual file (per CLAUDE.md prompt budget)

## Scope Boundaries

- Content files only — no code changes needed (RitualMiddleware already handles loading)
- No tests needed — these are static markdown files read by existing middleware
- No changes to the middleware chain or state schema

## Key Technical Decisions

- **Follow existing skill file format**: Same structure as `active_listening.md`, `vulnerability_holding.md` etc. — `# Skill: Name` header, protocol steps, rules, exit conditions
- **Use `# Ritual: Name` header**: Distinguish from skills so the LLM knows it's a structured protocol, not a reactive skill
- **Phase naming convention**: `{ritual_name}.step{N}_{description}` — matches what `RitualMiddleware` initializes as `{ritual}.intro`

## Implementation Units

- [ ] **Unit 1: Create prepare.md**

**Goal:** The pre-event ritual — helps the user prepare mentally and practically for something important (presentation, interview, difficult conversation).

**Files:**
- Create: `skills/public/sophia/rituals/prepare.md`

**Approach:**
- 4 phases: `prepare.step1_intention` → `prepare.step2_fears` → `prepare.step3_strengths` → `prepare.step4_ready`
- Step 1: What's the event? What outcome do you want?
- Step 2: What are you afraid of? Name the worst case.
- Step 3: What have you already done to prepare? What strengths do you bring?
- Step 4: Consolidate — you're ready. What's one thing to remember walking in?
- Tone: grounded confidence, practical warmth
- Exit: naturally transitions to freeform after step 4, or user redirects

---

- [ ] **Unit 2: Create debrief.md**

**Goal:** The post-event ritual — helps the user process what happened after something significant.

**Files:**
- Create: `skills/public/sophia/rituals/debrief.md`

**Approach:**
- 4 phases: `debrief.step1_what_happened` → `debrief.step2_what_worked` → `debrief.step3_what_didnt` → `debrief.step4_takeaway`
- Step 1: Walk me through what happened. Facts first, feelings after.
- Step 2: What went well? What did you do right?
- Step 3: What would you do differently? (Not "what went wrong" — reframe as growth)
- Step 4: One takeaway to carry forward.
- Tone: curious, celebratory where earned, honest about gaps

---

- [ ] **Unit 3: Create vent.md**

**Goal:** Safe space to release pressure — no problem-solving, no advice, just being heard.

**Files:**
- Create: `skills/public/sophia/rituals/vent.md`

**Approach:**
- 3 phases: `vent.phase1_let_it_out` → `vent.phase2_hold_space` → `vent.phase3_land`
- Phase 1: Let them talk. Mirror, label, validate energy. Don't redirect. Don't solve.
- Phase 2: Hold space. When the heat starts breaking, reflect back what you heard.
- Phase 3: When they're ready (they'll signal it), ask: "What do you want to do with this?"
- Critical rule: NO advice during phases 1-2. Only in phase 3, and only if invited.
- Tone: match their energy without amplifying, gradually ground

---

- [ ] **Unit 4: Create reset.md**

**Goal:** Quick emotional reset — when the user is overwhelmed, spiraling, or needs to come back to center.

**Files:**
- Create: `skills/public/sophia/rituals/reset.md`

**Approach:**
- 3 phases: `reset.interrupt` → `reset.ground` → `reset.reorient`
- Interrupt: Break the spiral. Short, direct. "Stop. Breathe. What's the one thing?"
- Ground: Sensory grounding or naming what's real right now. Not cognitive — physical.
- Reorient: "What's the next small thing you can actually do?" One action, not a plan.
- Tone: calm authority, not gentle — gentle reads as weak during a spiral. Think lifeguard energy.
- Shortest ritual — can complete in 3-5 turns

## Risks & Dependencies

- **Token budget**: Each file must stay under ~600 tokens. The existing skill files are ~400-650 tokens. Keep rituals concise.
- **Phase tracking**: `RitualMiddleware` sets initial phase to `{ritual}.intro`. The ritual file should instruct the LLM to advance `ritual_phase` in the artifact as it moves through steps.

## Sources & References

- CLAUDE.md: ritual_phase format, Mem0 category selection rules for rituals
- `docs/specs/04_backend_integration.md`: middleware chain, ritual state fields
- Existing skill files: `skills/public/sophia/skills/active_listening.md` — format reference
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/ritual.py` — middleware that reads these files
