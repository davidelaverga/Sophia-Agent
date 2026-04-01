---
date: 2026-03-31
topic: conversational-flow-quality
---

# Conversational Flow Quality — Adaptive Turn Detection + Cancel-and-Merge

## Problem Frame

Sophia's voice conversations feel choppy despite being bidirectional. When a user pauses mid-thought (to breathe, think, or transition between clauses), the turn detection system interprets the silence as "done speaking" and fires a turn end. Sophia then responds to half the thought. When the user continues, their words are treated as a new turn, producing a second fragmented response.

The result: a back-and-forth ping-pong instead of the natural conversational flow an emotional companion requires. This is the single biggest barrier to Sophia feeling like a real conversation partner rather than a voice command interface.

**Current state:** `SophiaTurnDetection` fires on 1200ms of silence, regardless of utterance length, linguistic context, or individual speech patterns. Once fired, the transcript goes directly to the LLM with no recovery path.

**Constraint:** Maintain the <3s voice latency target (speech end → hear Sophia). Solutions must be smarter, not slower.

## Requirements

**Layer 1: Adaptive Silence Threshold**

- R1. Silence threshold scales with transcript word count:
  - 1–3 words → 1000ms (short confirmations, fast response)
  - 4–10 words → 1500ms (moderate utterances, slight buffer)
  - 11+ words → 2000ms (complex thoughts, allow natural pauses)
- R2. Continuation signal detection: if the trailing 1–3 words of the current transcript match known continuation patterns, extend silence threshold by 800ms on top of the word-count base. Continuation signals include:
  - Conjunctions: "and", "but", "because", "so", "or", "although", "though"
  - Fillers: "um", "uh", "like", "you know", "I mean", "basically", "actually"
  - Incomplete clauses: "I was", "I think", "it's like", "the thing is"
  - Trailing prepositions/articles: "to", "for", "with", "the", "a"
- R3. Adaptive threshold does not exceed 2800ms ceiling (prevents excessively long waits).
- R4. All threshold adjustments are logged at DEBUG level with the computed values and reason.

**Layer 2: Cancel-and-Merge Recovery**

- R5. When `SophiaLLM` begins streaming a response, a 600ms "fragile window" opens. During this window, the system monitors for new user speech.
- R6. "New speech detected" is defined as: Deepgram emits a new interim transcript with ≥2 words that differ from the previous turn's content.
- R7. When new speech is detected during the fragile window:
  1. Cancel the in-flight LLM stream (abort the async task)
  2. Cancel TTS playback (stop Cartesia synthesis/output)
  3. Emit a brief acknowledgment phrase via TTS (see R9)
  4. Wait for the user to finish (next SmartTurn fire, using adaptive thresholds from Layer 1)
  5. Submit the merged transcript (original + continuation) as a single turn to the LLM
- R8. When no new speech is detected by the end of the fragile window, the response continues uninterrupted with zero latency impact.
- R9. Acknowledgment phrases rotate from a pool to avoid repetition:
  - "Go on."
  - "Mm-hmm."
  - "Sorry, continue."
  - "I'm listening."
  - "Take your time."
  Pool size is configurable. Selection avoids repeating the same phrase twice consecutively.
- R10. The merged transcript is submitted as a single message. The LLM does not see the aborted partial response — it treats it as a fresh turn with the complete user thought.
- R11. If Sophia had already spoken words before the cancel, those words are discarded from conversational context (the LLM does not need to account for them).
- R12. Cancel-and-merge activates at most once per user turn. If the user continues after already triggering one merge, subsequent pauses are handled by Layer 1 adaptive thresholds only (no infinite cancel loops).

**Layer 3: Personal Rhythm Learning**

- R13. Track per-user speech metrics across sessions:
  - Average pause duration within turns (silence gaps that did NOT end up being turn-ends)
  - Average word count per turn
  - Frequency of multi-clause utterances (turns with 20+ words)
  - Cancel-and-merge trigger frequency (how often Layer 2 fires for this user)
- R14. After ≥5 sessions, use learned metrics to adjust the adaptive silence baseline:
  - Users with longer average pauses get a higher base threshold
  - Users with high cancel-merge frequency get a higher base threshold
  - Users with consistently short, snappy turns get a lower base threshold
- R15. Rhythm data is stored per user. Storage mechanism: lightweight file-based store under `users/{user_id}/rhythm.json`, not Mem0 (this is operational data, not memory).
- R16. Rhythm adjustments are bounded: minimum base 800ms, maximum base 2400ms. Learned values cannot exceed these bounds.
- R17. Default behavior for new users (no rhythm data yet): use the word-count heuristic from R1 as-is. No special "cold start" phase needed.

## Success Criteria

- SC1. A user can speak a 30-second multi-clause thought with 2-3 natural pauses and Sophia waits for the complete thought before responding.
- SC2. A user saying "yes" or "I'm fine" gets a response within the existing <3s latency target.
- SC3. When Sophia does misfire (starts responding too early), she acknowledges it verbally and resets gracefully — the user does not need to repeat themselves.
- SC4. After 5+ sessions, Sophia's turn detection feels noticeably more tuned to the individual user's speaking style.
- SC5. No regression in echo suppression behavior (existing SophiaTurnDetection echo guard remains functional).

## Scope Boundaries

**In scope:**
- Modifications to `SophiaTurnDetection` (adaptive thresholds, continuation guard)
- New coordination logic in `SophiaLLM` (cancel-and-merge, fragile window)
- Acknowledgment phrase pool and TTS integration
- Per-user rhythm file (`users/{user_id}/rhythm.json`)
- Rhythm learning from session metrics
- All associated tests

**Out of scope:**
- Changes to Deepgram STT configuration (endpointing params) — may be explored later as complementary
- Changes to the backend middleware chain or prompt content
- Semantic completeness detection via LLM (too slow for real-time)
- Barge-in behavior changes (user interrupting Sophia is a separate concern)
- Cross-language support for continuation signals (English-only for now)

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where does adaptive logic live? | `SophiaTurnDetection` | Closest to the audio pipeline, can modify silence window before turn fires |
| Cancel mechanism | Async task cancellation + TTS stop | Cleanest — LLM sees a fresh request with full context |
| Acknowledgment delivery | TTS synthesis of short phrases | More natural than pre-recorded clips, uses existing TTS pipeline |
| Rhythm storage | File-based (`rhythm.json`), not Mem0 | This is operational tuning data, not user memory. Different lifecycle. |
| Cancel-and-merge limit | Once per turn | Prevents infinite cancel loops on very fragmented speech |
| Cancel leaves LLM unaware | Yes — clean slate resubmit | Simpler than injecting context about what was already said |

## Dependencies

- `SophiaTurnDetection` must have access to the current interim transcript from Deepgram (for continuation signal detection and word count)
- `SophiaLLM` needs a mechanism to cancel in-flight `_stream_backend()` calls
- TTS must support mid-playback cancellation (check Cartesia SDK / Vision Agents for stop/flush API)
- Deepgram interim transcript events must be accessible in the cancel-and-merge monitoring path

## Outstanding Questions

- Q1. Does Vision Agents / Cartesia SDK expose a "stop playback" or "flush" API for cancelling mid-sentence TTS? If not, what's the fallback?
- Q2. Does Deepgram's interim transcript event fire quickly enough (within the 600ms fragile window) to detect new speech reliably?
- Q3. Should the acknowledgment phrase pool be voice-emotion-aware? (e.g., "take your time" only in low-tone-band contexts, "go on" in engagement band)
