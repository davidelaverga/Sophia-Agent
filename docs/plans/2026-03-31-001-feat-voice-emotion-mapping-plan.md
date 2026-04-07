---
title: "feat: Voice Emotion Mapping — Apply artifact emotion/speed to Cartesia TTS"
type: feat
status: active
date: 2026-03-31
---

# feat: Voice Emotion Mapping — Apply artifact emotion/speed to Cartesia TTS

## Overview

SophiaTTS currently stores the artifact via `update_from_artifact()` but never applies the emotion or speed values when synthesizing speech. Every turn sounds identical regardless of emotional context. This plan adds emotion and speed injection to the Cartesia `generate()` call using sonic-3's `generation_config` parameter, plus a fallback mechanism when the primary emotion doesn't produce natural speech.

## Problem Frame

Sophia's companion agent already selects per-turn voice emotion (`voice_emotion_primary`, `voice_emotion_secondary`) and speed (`voice_speed`) via the `emit_artifact` tool. The DeerFlow adapter parses these correctly, and `SophiaLLM` queues them on `SophiaTTS._next_artifact`. But the parent `CartesiaTTS.stream_audio()` ignores this data — it passes only `voice={"id": ..., "mode": "id"}` to `client.tts.generate()` with no `generation_config`. The result: Sophia sounds flat and monotone regardless of emotional context.

Week 2 Build Plan (Luis, Day 1–3) requires: override `stream_audio()` to read the queued artifact and pass emotion + speed to Cartesia's sonic-3 `generation_config`.

## Requirements Trace

- R1. Override `stream_audio()` to inject `generation_config` with emotion and speed from the queued artifact
- R2. Map `voice_speed` labels (slow/gentle/normal/engaged/energetic) to Cartesia float values (0.8/0.9/1.0/1.05/1.15)
- R3. Pass `voice_emotion_primary` directly as Cartesia `emotion` (values already match Cartesia's literal vocabulary)
- R4. Implement fallback: if primary emotion is not in Cartesia's known set, use `voice_emotion_secondary`
- R5. First turn (no artifact yet) uses neutral defaults — no emotion override, normal speed
- R6. Artifact applies to the NEXT TTS call (artifact arrives after text stream)
- R7. Log applied emotion/speed for every synthesis call for trace debugging

## Scope Boundaries

- No changes to `SophiaLLM`, `DeerFlow adapter`, or artifact parsing — those are complete
- No changes to `voice/server.py` agent creation
- No Cartesia voice embedding changes — emotion is controlled via `generation_config` only
- No `voice_emotion_secondary` blending/mixing — it is a pure fallback, not a weighted combination
- Text mode and platform detection are a separate deliverable (Week 2 Day 4–5)

## Context & Research

### Relevant Code and Patterns

- `voice/sophia_tts.py` — Current SophiaTTS: stores `_next_artifact` dict, has `update_from_artifact()`, but no `stream_audio()` override
- `vision_agents.plugins.cartesia.TTS` — Parent class: `stream_audio()` calls `client.tts.generate()` with `model_id`, `transcript`, `output_format`, `voice` only
- `cartesia.types.generation_config_param.GenerationConfigParam` — TypedDict with `emotion` (str/Literal[60+ values]), `speed` (float 0.6–1.5), `volume` (float 0.5–2.0)
- `cartesia.types.model_speed.ModelSpeed` — Top-level `speed` param is `Literal["slow", "normal", "fast"]` (legacy, NOT what we use — we use `generation_config.speed` for sonic-3)
- `voice/tests/test_sophia_llm_streaming.py` — Existing test patterns with `FakeTTS`, `FakeAdapter`, `_valid_artifact()` fixture
- `voice/tests/conftest.py` — `make_settings()` factory with all VoiceSettings fields
- `skills/public/sophia/artifact_instructions.md` — Defines allowed emotion vocabulary and speed labels

### Cartesia sonic-3 API

The `generation_config` parameter is sonic-3 specific. From the SDK docstring:
> "Configure the various attributes of the generated speech. These are only for `sonic-3` and have no effect on earlier models."

The emotion field accepts any of 60+ literal strings. The artifact instruction prompts the LLM to choose from this exact same vocabulary, so **no translation layer is needed** — `voice_emotion_primary` values map 1:1 to Cartesia emotion literals.

The speed field is a float (0.6–1.5), not the top-level `ModelSpeed` enum ("slow"/"normal"/"fast"). The CLAUDE.md spec defines the label→float mapping.

## Key Technical Decisions

- **Direct passthrough for emotion (no translation layer):** The artifact's `voice_emotion_primary` values are drawn from the same Cartesia vocabulary. Passing them directly avoids a brittle mapping table and ensures the full 60+ emotion range is available. If a value doesn't match, the fallback to `voice_emotion_secondary` handles it.

- **`generation_config` over top-level `speed`:** The top-level `speed` parameter is `Literal["slow", "normal", "fast"]` — too coarse. `generation_config.speed` accepts float 0.6–1.5, which matches our 5-level label mapping exactly.

- **Fallback logic location in `stream_audio()`:** Validation happens at synthesis time in `stream_audio()`, not in `update_from_artifact()`. This keeps the artifact storage pure and lets the TTS decide what's safe to send to Cartesia.

- **No `volume` override:** The spec doesn't mention volume control. Default Cartesia volume (1.0) is used.

## Open Questions

### Resolved During Planning

- **Q: Does Cartesia reject unknown emotion strings?** Resolution: The SDK types define `emotion` as `Union[str, Literal[...]]`, so any string is accepted by the SDK. Cartesia's API behavior for unknown strings is undocumented but likely falls back to neutral. Our fallback mechanism handles this regardless.

- **Q: Should we use the top-level `speed` or `generation_config.speed`?** Resolution: `generation_config.speed` — it's the sonic-3 path and accepts float values matching our label map.

### Deferred to Implementation

- **Cartesia error behavior for edge-case emotions:** Some emotions may not sound natural with all voices. If users report odd-sounding turns, we may need to build a voice-specific allow-list. For now, the fallback from primary→secondary is sufficient.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌─────────────────────────────────────────────────────────┐
│                    SophiaTTS                             │
│                                                         │
│  update_from_artifact(artifact)                         │
│      └─ stores full artifact in _next_artifact          │
│                                                         │
│  stream_audio(text)                                     │
│      ├─ read _next_artifact                             │
│      ├─ extract emotion_primary, emotion_secondary      │
│      ├─ extract voice_speed label → float via SPEED_MAP │
│      ├─ validate emotion against CARTESIA_EMOTIONS set  │
│      │   └─ if primary not in set → use secondary       │
│      │   └─ if secondary not in set → use None (no      │
│      │       emotion override)                          │
│      ├─ build generation_config = {emotion, speed}      │
│      │   (omit keys that are None)                      │
│      ├─ build output_format (same as parent)            │
│      ├─ call client.tts.generate(                       │
│      │     model_id, transcript, output_format,         │
│      │     voice, generation_config)                    │
│      ├─ log: applied emotion + speed                    │
│      └─ return PcmData from response                    │
│                                                         │
│  SPEED_MAP = {                                          │
│    "slow": 0.8, "gentle": 0.9, "normal": 1.0,          │
│    "engaged": 1.05, "energetic": 1.15                   │
│  }                                                      │
│                                                         │
│  CARTESIA_EMOTIONS = frozenset of 60+ valid literals    │
│    (sourced from GenerationConfigParam type definition)  │
└─────────────────────────────────────────────────────────┘
```

## Implementation Units

- [x] **Unit 1: Override `stream_audio()` with emotion/speed injection**

**Goal:** Make SophiaTTS apply the queued artifact's emotion and speed when synthesizing speech via Cartesia sonic-3's `generation_config`.

**Requirements:** R1, R2, R3, R4, R5, R6, R7

**Dependencies:** None — builds on existing `_next_artifact` storage

**Files:**
- Modify: `voice/sophia_tts.py`
- Test: `voice/tests/test_sophia_tts.py` (create)

**Approach:**
- Add `SPEED_MAP` dict at module level mapping the 5 label strings to floats
- Add `CARTESIA_EMOTIONS` frozenset with all 60+ valid Cartesia emotion literals (sourced from the SDK's `GenerationConfigParam` type definition)
- Override `stream_audio(self, text, *_, **__)` to:
  1. Build `output_format` dict (same as parent: raw/pcm_s16le/sample_rate)
  2. Build `voice_param` dict (same as parent: id/mode)
  3. Read `_next_artifact` for emotion/speed fields
  4. Resolve emotion: if `voice_emotion_primary` is in `CARTESIA_EMOTIONS`, use it; else try `voice_emotion_secondary`; else `None`
  5. Resolve speed: look up `voice_speed` in `SPEED_MAP`; default to `None` if missing/unknown
  6. Build `generation_config` dict with non-None emotion and speed values
  7. Call `self.client.tts.generate()` with all params including `generation_config` (only if non-empty)
  8. Log the applied emotion and speed at info level
  9. Return `PcmData.from_response()` (same as parent)
- Do NOT clear `_next_artifact` after use — it persists until the next artifact arrives (consecutive turns before a new artifact should reuse the last emotion)

**Patterns to follow:**
- Parent `CartesiaTTS.stream_audio()` for the generate call structure
- `GenerationConfigParam` TypedDict for the `generation_config` shape
- Existing logging pattern in `update_from_artifact()` (`logger.info` with key=value format)

**Test scenarios:**
- Happy path: artifact with valid primary emotion ("sympathetic") and speed ("gentle") → `generation_config` includes `emotion="sympathetic"` and `speed=0.9`
- Happy path: artifact with primary emotion from primary set ("calm") → emotion passed directly
- Happy path: each speed label maps correctly — slow→0.8, gentle→0.9, normal→1.0, engaged→1.05, energetic→1.15
- Edge case: no artifact queued (first turn) → `generation_config` is not included or is empty (no emotion/speed override)
- Edge case: artifact with unknown primary emotion, valid secondary → fallback to secondary
- Edge case: artifact with unknown primary AND unknown secondary → no emotion in generation_config
- Edge case: artifact with valid emotion but missing speed field → emotion applied, speed omitted
- Edge case: artifact with unknown speed label → speed omitted, emotion still applied
- Edge case: artifact persists across turns — calling `stream_audio()` twice without new `update_from_artifact()` reuses same emotion/speed
- Integration: `update_from_artifact()` queues values → next `stream_audio()` reads them (end-to-end flow within SophiaTTS)

**Verification:**
- All tests pass
- `stream_audio()` calls `client.tts.generate()` with `generation_config` when artifact has valid emotion/speed
- `stream_audio()` calls `client.tts.generate()` without `generation_config` when no artifact or no valid values
- Log output shows applied emotion and speed for every synthesis call

---

- [ ] **Unit 2: Manual voice quality validation**

**Goal:** Verify that different emotions produce audibly different speech and that the speed mapping sounds natural.

**Requirements:** R1, R3 (qualitative validation)

**Dependencies:** Unit 1

**Files:**
- None (manual testing)

**Approach:**
- Start the voice server with the updated `sophia_tts.py`
- Have conversations that naturally elicit different emotions from Sophia
- Verify: "sympathetic" during vulnerability sounds warm, "excited" during celebration sounds energetic, "calm" during silence-holding sounds unhurried
- Verify speed: "slow" is noticeably slower, "energetic" is noticeably faster than "normal"
- Test the fallback: if heard a "flat" response, check logs for emotion fallback

**Test scenarios:**
- Qualitative: vulnerability topic → sympathetic emotion audible
- Qualitative: celebration topic → excited emotion audible
- Qualitative: reflective question → contemplative emotion audible
- Qualitative: speed variation is perceptible across gentle/normal/engaged

**Verification:**
- Voice sounds emotionally different across contexts in real conversation
- Logs show emotion/speed being applied per turn
- No Cartesia API errors in voice server logs

## System-Wide Impact

- **Interaction graph:** `SophiaTTS.stream_audio()` is called by the Vision Agents framework whenever TTS is needed. The override adds `generation_config` to the Cartesia API call but does not change the method signature, return type, or event flow.
- **Error propagation:** If Cartesia rejects a `generation_config` value, the existing `TTSErrorEvent` handler in SophiaTTS catches it and calls `_error_callback`. No new error handling needed.
- **State lifecycle risks:** `_next_artifact` is never cleared — it persists until replaced. This is intentional: consecutive turns before a new artifact reuse the last emotion. No stale-state risk since artifacts are always complete (13 fields).
- **API surface parity:** No other interfaces consume emotion/speed — this is voice-only.
- **Integration coverage:** The SophiaLLM → SophiaTTS integration (artifact queuing → synthesis) is already tested in `test_sophia_llm_streaming.py`. Unit 1 adds tests for the SophiaTTS-internal flow (artifact reading → Cartesia API call).
- **Unchanged invariants:** `update_from_artifact()`, `note_response_started()`, `clear_response_context()`, `attach_runtime_hooks()` — all unchanged. Event handlers unchanged. Server creation unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Some Cartesia emotions may sound unnatural with the specific Sophia voice ID | Fallback to `voice_emotion_secondary` (always from the primary set of 6 reliable emotions). Can add voice-specific allow-list later if needed. |
| Cartesia API could reject unknown emotion strings | SDK accepts `Union[str, Literal[...]]` — any string passes. API likely falls back to neutral. Fallback mechanism handles this regardless. |
| Speed values outside 0.6–1.5 range | Our map only produces values 0.8–1.15, safely within range. |

## Sources & References

- Related code: `voice/sophia_tts.py`, `vision_agents.plugins.cartesia.TTS`
- SDK types: `cartesia.types.generation_config_param.GenerationConfigParam`
- Spec: `CLAUDE.md` — artifact schema, speed mapping table, voice emotion vocabulary
- Skill file: `skills/public/sophia/artifact_instructions.md` — emotion selection guide
- Build plan: `02_build_plan (new).md` — Week 2 Luis Day 1–3
