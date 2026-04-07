---
title: "feat: Voice Emotion Enrichment — Warm Default, User-Side Hints, Emotion-Aware UI"
type: feat
status: active
date: 2026-03-31
origin: 02_build_plan (new).md (Week 2 Luis tasks)
---

# Voice Emotion Enrichment

## Overview

Three improvements to make Sophia's voice and visual presence more emotionally responsive:

1. **Warm default (A):** Replace the flat "default voice" on turn 1 with a warm `content` + `gentle` baseline so Sophia never sounds robotic on her opening line.
2. **User-side emotion hinting (B):** Lightweight keyword analysis of the user's transcript. Send an emotion hint to TTS *before* the backend artifact arrives, so the very first response already matches the user's emotional tone. The backend artifact takes over from turn 2+.
3. **Emotion-aware UI (D):** The Waveform canvas and mic button glow adapt color based on the current emotion from the artifact. Visual reinforcement that Sophia is attuned.

## Problem Frame

Currently, the voice emotion pipeline works end-to-end but the artifact arrives *after* all text tokens. This means:
- Turn 1 of every session always uses "default voice" (no artifact yet)
- The first response to an emotional input sounds flat because the emotion from the previous artifact doesn't match the new context
- The visual UI is always purple regardless of Sophia's emotional state — no visual feedback that she's adapting

## Requirements Trace

- R1. Turn 1 TTS uses a warm default (`content` / `gentle`) instead of Cartesia's bare default
- R2. User transcript keywords produce an emotion hint applied to the *current* turn's TTS
- R3. Backend artifact overrides any hint when available (hint is fallback only)
- R4. Waveform canvas colors shift based on current voice emotion
- R5. Mic button glow adapts to match the emotion color
- R6. No new backend dependencies — all changes in voice server + frontend
- R7. Existing tests continue passing (55/55)

## Scope Boundaries

- **Not changing** the backend middleware chain, emit_artifact schema, or LLM prompt
- **Not adding** Stream custom events from frontend → server (too complex for this scope; would require Vision Agents SDK extension)
- **Not changing** the artifact-arrives-after-text architecture — that's by design per spec
- **Not building** a full NLP sentiment classifier — keyword matching only

## Context & Research

### Relevant Code and Patterns

- `voice/sophia_tts.py` — `_next_artifact`, `_resolve_emotion()`, `_resolve_speed()`, `stream_audio()`, `update_from_artifact()`
- `voice/sophia_llm.py` — `_stream_backend()` receives transcript, calls `tts.update_from_artifact()`
- `AI-companion-mvp-front/src/app/components/ui/Waveform.tsx` — Canvas rendering per state, hardcoded `rgba(139, 92, 246, ...)` purple
- `AI-companion-mvp-front/src/app/components/VoiceMicButton.tsx` — `sophia-purple` / `sophia-glow` gradient per state
- `AI-companion-mvp-front/src/app/components/VoiceFocusView.tsx` — Passes `state` to Waveform
- `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts` — Receives `sophia.artifact` custom events, forwards via `onArtifacts`
- `AI-companion-mvp-front/src/app/stores/presence-store.ts` — 5-state presence (resting, listening, thinking, reflecting, speaking)
- `AI-companion-mvp-front/src/app/globals.css` — `--sophia-purple: #7c5caa`, `--sophia-glow: #9d7cc9`
- `voice/sophia_tts.py` CARTESIA_EMOTIONS frozenset — 60+ valid emotion literals

### Institutional Learnings

- Artifact always arrives after text (by design) — queued for next TTS call
- `_next_artifact` starts as `{}` on session start — no warm default exists
- Waveform uses hardcoded RGBA values, not CSS variables — color changes require passing a color prop
- presence-store has no emotion field — would need a new store or extend existing one

## Key Technical Decisions

- **Warm default via initial `_next_artifact`**: Set `_next_artifact = {"voice_emotion_primary": "content", "voice_speed": "gentle"}` in `__init__` instead of `{}`. This is the minimal change — no new logic, just a non-empty default. *Rationale:* `content` + `gentle` is Sophia's natural resting voice. It's warm but not presumptuous.

- **Emotion hint lives in `SophiaTTS`, not `SophiaLLM`**: The LLM already has the user transcript in `simple_response()`. Pass the transcript to TTS via a new `hint_emotion_from_transcript(text)` method called *before* `stream_audio()`. *Rationale:* Keeps the hinting logic co-located with emotion resolution. LLM doesn't need to understand Cartesia emotions.

- **Hint is overridden by artifact**: `_resolve_emotion()` checks `_next_artifact` first: if it has a valid emotion from a real artifact (has `tone_estimate`), use it. If not, check a `_hint_emotion` field. *Rationale:* Backend artifact is always more accurate than keyword matching. Hint is a bridge for turn 1 and cold starts only.

- **Keyword map, not ML**: A static dict of ~30 keyword patterns → emotion+speed. Fast, predictable, no dependencies. *Rationale:* This runs on every turn before TTS. Must be <1ms. A keyword dict is sufficient for the "get it roughly right" goal.

- **Emotion color via a new `useEmotionColor` hook**: Reads the latest artifact from recap-store, maps `voice_emotion_primary` → a CSS color object `{primary, glow, rgb}`. Components consume this hook. *Rationale:* Keeps color logic centralized. The Waveform already accepts render-time values — we pass color through props.

- **5 emotion color bands, not 60**: Map 60+ Cartesia emotions to 5 visual bands: warm (default), calm, energetic, intense, tender. *Rationale:* Subtle color shifts across 60 emotions would be imperceptible. 5 bands give clear visual differentiation.

## Open Questions

### Resolved During Planning

- **Q: Should the frontend send hints to the voice server?** No. The voice server already receives the transcript in `SophiaLLM.simple_response()`. The hint analysis runs server-side in `SophiaTTS`. No bidirectional communication needed.
- **Q: Should hints persist across turns?** No. `_hint_emotion` is cleared after each `stream_audio()` call. The artifact takes over from turn 2+.

### Deferred to Implementation

- **Exact keyword list**: The initial ~30 keywords will be tuned after observing real sessions. Start with high-signal words.
- **Color values for 5 emotion bands**: Will be tuned visually during implementation. Start with reasonable defaults.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Turn flow with improvements:

User speaks: "I'm so fed up. My manager threw me under the bus."
  ↓
SophiaLLM.simple_response(text="I'm so fed up...")
  ↓
tts.hint_emotion_from_transcript("I'm so fed up...")  ← NEW (B)
  → keyword "fed up" matches → _hint_emotion = "determined", _hint_speed = 1.0
  ↓
Backend streams text → TTS.stream_audio(chunk)
  → _resolve_emotion():
      1. Check _next_artifact for real artifact emotion → empty (turn 1) or stale
      2. Fall back to _hint_emotion → "determined" ← USED
  → Cartesia generates with emotion=determined speed=normal
  ↓
Artifact arrives → update_from_artifact() → _next_artifact populated
  → clears _hint_emotion (artifact wins from now on)
  ↓
Frontend receives sophia.artifact custom event
  → useEmotionColor() → maps "determined" → "intense" band → orange-ish glow
  → Waveform + MicButton update color
```

```
Emotion color bands (visual):

| Band       | Emotions mapped                                      | Primary color |
|------------|------------------------------------------------------|---------------|
| warm       | content, peaceful, grateful, calm (default)          | #7c5caa (purple - current) |
| calm       | sympathetic, serene, trust, affectionate, gentle     | #5c8aaa (blue-teal) |
| energetic  | excited, enthusiastic, happy, elated, triumphant     | #aa8a5c (gold-amber) |
| intense    | determined, angry, frustrated, confident, proud      | #aa5c5c (warm-red) |
| tender     | sad, hurt, nostalgic, wistful, apologetic            | #8a5caa (soft-violet) |
```

## Implementation Units

- [ ] **Unit 1: Warm Default for Turn 1**

**Goal:** Sophia's first TTS call uses `content` + `gentle` instead of bare Cartesia defaults.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `voice/sophia_tts.py`
- Test: `voice/tests/test_sophia_tts.py`

**Approach:**
- Change `self._next_artifact: dict[str, Any] = {}` to a warm default dict with `voice_emotion_primary: "content"` and `voice_speed: "gentle"`
- Add a flag `_has_real_artifact: bool = False` set to `True` in `update_from_artifact()`
- `_resolve_emotion()` and `_resolve_speed()` already read from `_next_artifact` — no change needed there

**Patterns to follow:**
- Existing `update_from_artifact()` pattern for setting `_next_artifact`

**Test scenarios:**
- Happy path: New SophiaTTS instance → `_resolve_emotion()` returns `"content"`, `_resolve_speed()` returns `0.9`
- Happy path: After `update_from_artifact()` with real data → warm default is replaced, emotion comes from artifact
- Edge case: `update_from_artifact({})` with empty dict → warm default still used (no valid emotion in empty artifact)

**Verification:**
- First TTS call in a session logs `[SOPHIA-VOICE] She used 'content' emotion at 'gentle' speed` instead of `No artifact queued`

---

- [ ] **Unit 2: Emotion Hinting from User Transcript**

**Goal:** Before TTS generates speech, analyze the user's words for emotional keywords and set a hint emotion that `_resolve_emotion()` uses as fallback.

**Requirements:** R2, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `voice/sophia_tts.py`
- Modify: `voice/sophia_llm.py`
- Test: `voice/tests/test_sophia_tts.py`

**Approach:**
- Add `_hint_emotion: str | None` and `_hint_speed: float | None` fields to SophiaTTS
- Add `hint_emotion_from_transcript(text: str) -> None` method: scans text against a keyword→emotion dict, sets `_hint_emotion` and `_hint_speed`
- Keyword dict: ~30 high-signal keyword patterns mapped to Cartesia emotions + speed labels. Keywords grouped by emotional signal (anger, grief, excitement, fear, etc.)
- Modify `_resolve_emotion()` priority: (1) real artifact emotion, (2) `_hint_emotion`, (3) warm default
- Clear `_hint_emotion` after each `stream_audio()` call (one-shot)
- In `SophiaLLM.simple_response()`, call `self._tts_ref.hint_emotion_from_transcript(text)` before the backend stream starts
- Artifact `update_from_artifact()` always clears `_hint_emotion` (artifact wins)

**Patterns to follow:**
- Existing `_resolve_emotion()` fallback chain (primary → secondary)
- Existing `_resolve_speed()` label→float mapping via SPEED_MAP

**Test scenarios:**
- Happy path: Transcript with "fed up" → `_hint_emotion` = `"determined"`, `_hint_speed` = `1.0`
- Happy path: Transcript with "scared" → `_hint_emotion` = `"sympathetic"`, `_hint_speed` = `0.9`
- Happy path: Transcript with "amazing news" → `_hint_emotion` = `"excited"`, `_hint_speed` = `1.05`
- Happy path: No keywords match → `_hint_emotion` stays `None`, warm default used
- Integration: `_resolve_emotion()` with both hint and artifact → artifact wins
- Integration: `_resolve_emotion()` with hint but no artifact → hint used
- Edge case: After `stream_audio()` completes, `_hint_emotion` is cleared
- Edge case: `update_from_artifact()` clears any pending hint
- Edge case: Multiple keywords match → first match wins (scan order is stable)
- Edge case: Keywords are case-insensitive

**Verification:**
- Log shows emotion from hint on turn 1 when keyword matches
- Log shows emotion from artifact on turn 2+ (hint overridden)

---

- [ ] **Unit 3: Emotion Color Hook**

**Goal:** A React hook that maps the current voice emotion to a color band for UI components.

**Requirements:** R4, R5

**Dependencies:** None (can be built in parallel with Units 1-2)

**Files:**
- Create: `AI-companion-mvp-front/src/app/hooks/useEmotionColor.ts`
- Test: `AI-companion-mvp-front/tests/hooks/useEmotionColor.test.ts`

**Approach:**
- Define 5 color bands: warm (default purple), calm (blue-teal), energetic (gold-amber), intense (warm-red), tender (soft-violet)
- Each band provides: `{primary: string, glow: string, rgb: string}` (rgb for canvas RGBA values)
- Map all 60+ Cartesia emotions to one of 5 bands via a static lookup
- Hook reads from recap-store to get the latest artifact's `voice_emotion_primary`
- Returns the current color band object
- Falls back to "warm" band when no artifact or unrecognized emotion

**Patterns to follow:**
- Existing hook patterns in `AI-companion-mvp-front/src/app/hooks/`
- recap-store read pattern from ConversationView

**Test scenarios:**
- Happy path: Emotion `"excited"` → energetic band colors
- Happy path: Emotion `"sympathetic"` → calm band colors
- Happy path: Emotion `"determined"` → intense band colors
- Happy path: Emotion `"sad"` → tender band colors
- Happy path: No artifact → warm (default) band
- Edge case: Unrecognized emotion string → warm band fallback
- Edge case: Emotion is `null` or `undefined` → warm band fallback

**Verification:**
- Hook returns correct color objects for each emotion band category

---

- [ ] **Unit 4: Waveform Emotion Colors**

**Goal:** The Waveform canvas uses emotion-driven colors instead of hardcoded purple RGBA values.

**Requirements:** R4

**Dependencies:** Unit 3

**Files:**
- Modify: `AI-companion-mvp-front/src/app/components/ui/Waveform.tsx`
- Modify: `AI-companion-mvp-front/src/app/components/VoiceFocusView.tsx`

**Approach:**
- Add an optional `emotionColor` prop to Waveform: `{primary: string, glow: string, rgb: string}`
- Replace all hardcoded `rgba(139, 92, 246, ...)` with values derived from `emotionColor.rgb` + dynamic alpha
- Default to current purple when no `emotionColor` prop is provided
- In VoiceFocusView, consume `useEmotionColor()` and pass to Waveform
- Use CSS `transition` or canvas interpolation for smooth color transitions between emotions

**Patterns to follow:**
- Existing Waveform props pattern (`stream`, `state`, `height`, `className`)
- Existing color variable pattern in globals.css

**Test scenarios:**
- Happy path: VoiceFocusView renders Waveform with emotion color from artifact
- Happy path: Color changes when new artifact arrives with different emotion
- Edge case: No emotion available → default purple used (backward compatible)
- Edge case: Waveform used elsewhere without emotion prop → works as before

**Verification:**
- Visual: Waveform glows gold during celebration, blue-teal during vulnerability, warm-red during anger

---

- [ ] **Unit 5: Mic Button Emotion Glow**

**Goal:** The mic button glow adapts to the current emotion band color.

**Requirements:** R5

**Dependencies:** Unit 3

**Files:**
- Modify: `AI-companion-mvp-front/src/app/components/VoiceMicButton.tsx`
- Modify: `AI-companion-mvp-front/src/app/components/VoiceFocusView.tsx` (pass emotion color)

**Approach:**
- Accept an optional `emotionColor` prop in VoiceMicButton
- When listening: replace `shadow-sophia-purple/40` with dynamic shadow using `emotionColor.primary`
- When idle: replace gradient `from-sophia-purple to-sophia-glow/60` with emotion-derived gradient
- Use inline `style` for dynamic color (Tailwind can't do runtime values) with CSS custom properties
- Fall back to sophia-purple/sophia-glow when no emotion color provided

**Patterns to follow:**
- Existing VoiceMicButton state-based styling switch
- Inline style fallback pattern already used in the codebase

**Test scenarios:**
- Happy path: Listening state with energetic emotion → gold glow shadow
- Happy path: No emotion → default purple (backward compatible)
- Edge case: Theme switch (dark mode) → emotion colors adapt appropriately

**Verification:**
- Visual: Mic button glow matches Waveform color for each emotion band

## System-Wide Impact

- **Interaction graph:** SophiaTTS warm default and hint system are purely internal to the voice server. Emotion color hook is purely frontend. No cross-layer coupling added.
- **Error propagation:** Hint failure (no keyword match) gracefully falls back to warm default. Color hook failure falls back to current purple.
- **State lifecycle risks:** `_hint_emotion` is cleared after each `stream_audio()` call — no stale hint risk. Color hook reads from recap-store which already persists across re-renders.
- **API surface parity:** No API changes. Artifact schema unchanged.
- **Unchanged invariants:** Backend middleware chain, emit_artifact tool schema, Stream custom event protocol, and all existing voice server behavior are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Keyword matching too aggressive (maps casual words to strong emotions) | Start conservative — only high-signal phrases like "fed up", "scared", "amazing". Expand after observation. |
| Cartesia emotion+speed combo sounds wrong for some hint-word matches | Hint is a 1-turn bridge. Backend artifact corrects from turn 2+. Tune keywords empirically. |
| Canvas color transition looks jarring on emotion change | Use linear interpolation between current and target color over ~500ms |
| Existing tests break from warm default change | Update affected tests to expect `"content"` instead of `None` for default emotion |

## Sources & References

- Origin: `02_build_plan (new).md` — Week 2 Luis tasks, Day 1-3 Voice Emotion Mapping, Day 4-5 Text Mode + Platform Detection
- Related plan: `docs/plans/2026-03-31-001-feat-voice-emotion-mapping-plan.md`
- Cartesia sonic-3 generation_config: `CARTESIA_EMOTIONS` frozenset in `voice/sophia_tts.py`
- CLAUDE.md: emit_artifact 13 required fields, voice_emotion_primary/secondary, voice_speed
