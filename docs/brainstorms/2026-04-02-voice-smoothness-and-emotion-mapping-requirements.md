---
date: 2026-04-02
topic: voice-smoothness-and-emotion-mapping
---

# Voice Smoothness And Emotion Mapping Calibration

## Problem Frame

Artifact transport now works on successful live voice turns, but live voice still feels unreliable and emotionally inconsistent. The latest WAV-driven benchmark shows the dominant failure is turn finalization, not artifact rendering: most clips never reach a full response, so mapping quality is being judged on a system that often never closes the user's turn cleanly.

Sophia therefore has two linked problems:

- the conversation often does not close into a response quickly or reliably enough
- when a response does happen, the chosen voice emotion can still feel off, especially on grief and excitement cases

We need a requirement set that makes smoothness and mapping quality measurable, prioritizes the highest-leverage fixes, and prevents prompt-only tuning from masking runtime problems.

## Current Baseline

Benchmark source: five recent WAV-driven captures in `AI-companion-mvp-front/test-results/session-captures`.

- Join latency: median `2267ms`, mean `2921ms`, min `2131ms`, max `5721ms`.
- Completion rate: `1/5` clips completed with an agent response and artifact (`20%`).
- False turn-end pressure: median `6` `user_ended` events before first agent response, mean `8.2`, worst case `19`.
- Turn-close delay: the only successful clip responded `19538ms` after first `user_ended`; failed clips stayed unresolved for `37268ms` to `39961ms` before capture end.
- Mapping readout from the current three mapping clips:
  - grief: miss, no usable response
  - excitement: partial miss, no usable response
  - mixed: best result, successful response and usable artifact

Interpretation: connection time is borderline acceptable, but smoothness and completion are not. Mapping cannot be treated as solved, or even fairly judged, until turn closure is much more reliable.

## Approach Options

### Recommended: Turn Stability First, Then Constrained Mapping Calibration

Treat turn finalization as the first blocker. Once the benchmark reliably completes, calibrate emotion choice against a smaller, more reliable spoken-emotion set and measure mapping by emotion family fit rather than exact literal labels.

Pros:
- attacks the failure dominating current user experience
- produces cleaner evidence for later mapping changes
- avoids shipping prompt tweaks that look better only because the run happened to complete

Cons:
- does not produce an immediate improvement to emotion nuance on already-successful clips
- requires stronger instrumentation before prompt tuning starts

### Faster But Weaker: Prompt-Only Mapping Retune

Retune artifact instructions and tone guidance first so the model chooses calmer, clearer voice emotions without adding new runtime logic.

Pros:
- lowest implementation cost
- may improve the successful mixed-emotion path quickly

Cons:
- does not solve the `4/5` runs that never complete
- produces noisy evidence because mapping quality is still confounded by turn-finalization failures
- risks overfitting to phrasing rather than real conversational behavior

### Higher-Upside Follow-On: Runtime Emotion Arbitration Layer

After the turn path is stable, add a small arbitration layer that compares user transcript cues, response intent, and emitted artifact emotion fields before final TTS delivery.

Pros:
- creates a safety net for mixed or low-confidence emotional reads
- gives the team a place to downgrade overly intense or mismatched emotion choices

Cons:
- adds logic and carrying cost in the live path
- should not be introduced until the benchmark is stable enough to show whether it helps

## Requirements

**Measurement And Reporting**

- R1. Maintain a controlled live-voice benchmark suite that includes at least the current five cases: pause mid-thought, correction, grief, excitement, and mixed emotion.
- R2. Every benchmark run must produce per-clip metrics for `join_latency_ms`, first `user_ended`, first `agent_started`, `turn_close_ms`, `false_user_ended_count`, response completion, and artifact receipt.
- R3. Smoothness must be reported with three canonical raw numbers, not prose alone: `completion_rate`, `median_turn_close_ms`, and `median_false_user_ended_count`.
- R4. Mapping quality must be reported separately from smoothness using `emotion_family_hit_rate` and `tone_band_hit_rate` on completed clips.
- R5. Each benchmark report must distinguish between four failure classes: no turn closure, wrong response intent, wrong emitted artifact, and wrong spoken delivery.

**Turn Stability First**

- R6. Turn-finalization reliability is the first priority. Mapping work is not considered successful if benchmark completion remains below `80%` or median `false_user_ended_count` remains above `1`.
- R7. A single user utterance must not emit repeated unresolved `user_ended` storms before either a recovery action or a final agent response.
- R8. Failed turn-close attempts must expose one explicit reason category so the team can tell whether the fault came from silence timing, continuation handling, echo suppression, transcript gaps, or backend stall.
- R9. Pause-heavy and correction-heavy benchmark clips must complete without leaving the user in `20s+` limbo.

**Emotion Mapping Calibration**

- R10. Emotion mapping evaluation must score family fit of the spoken response, not exact literal equality of Cartesia emotion labels.
- R11. The live voice path should optimize for a smaller, reliable spoken-emotion set and only use more specific literals when evidence shows they improve delivery rather than just semantic precision.
- R12. Emotion choice must combine at least three signals: user words, assistant response intent, and companion context such as tone band, ritual, or skill.
- R13. When those signals disagree or confidence is low, Sophia should fall back to the safer companion delivery instead of an intense or mismatched performance.
- R14. Mapping changes must be evaluated only on turns that complete cleanly enough to hear the full response.

**Calibration Workflow**

- R15. Expand the benchmark suite beyond the initial five clips to cover all five tone bands plus common conversational failure modes such as pause, correction, fragment, and interruption.
- R16. Each calibration pass must record the expected emotional target, actual emitted artifact fields, observed spoken delivery, and whether mismatch came from no response, wrong intent, wrong artifact, or wrong TTS rendering.
- R17. Prompt-only tuning must not ship without a benchmark rerun against the current suite.
- R18. Any single-number smoothness score is secondary. The canonical release gates remain the raw completion, turn-close, and false-turn metrics.

## Success Criteria

- SC1. On the current five-clip suite, at least `4/5` clips complete with a full response and artifact.
- SC2. Median join latency stays at or below `2500ms` on the warmed benchmark, and any outlier above `4500ms` is rare and explicitly labeled.
- SC3. Median `turn_close_ms` is at or below `4000ms` on completed clips, with no completed benchmark clip exceeding `6000ms`.
- SC4. Median `false_user_ended_count` before first agent response is at or below `1`, and worst case is at or below `2`.
- SC5. Emotion-family hit rate reaches at least `80%`, and tone-band hit rate reaches at least `90%`, on completed mapping clips.
- SC6. The grief, excitement, and mixed benchmark clips all produce judgeable, complete responses.

## Scope Boundaries

- In scope: turn-close metrics, recovery telemetry, benchmark labeling, prompt and rubric tightening, and a limited runtime arbitration layer if later needed.
- Out of scope: changing `soul.md`, replacing the current voice provider stack before the benchmark is stable, redesigning the artifact UI, or changing the memory architecture.
- Out of scope: GEPA-style prompt optimization before the live benchmark can reliably complete.

## Key Decisions

- Fix turn closure before deep mapping retuning. Current evidence says smoothness is the dominant blocker.
- Treat raw metrics as canonical. Any smoothness index is secondary and must not replace the raw numbers.
- Judge mapping by emotion family and delivery fit, not literal string matching.
- Prefer a smaller reliable spoken-emotion palette over semantically richer but acoustically weaker labels.

## Dependencies / Assumptions

- The live artifact transport path is now functioning on successful turns, so future failures should not default to frontend blame.
- The current TTS path already supports artifact-driven emotion with transcript-hint fallback.
- Existing turn-flow work provides a starting point, but it does not yet meet the measured completion and smoothness bar.

## Outstanding Questions

### Resolve Before Planning

None.

### Deferred To Planning

- [Affects R8][Technical] Which close-out reason codes should be emitted, and at which layers, so turn failures become diagnosable without adding noisy logs?
- [Affects R11][Technical] Should the smaller live emotion palette be enforced in prompt instructions, runtime validation, or both?
- [Affects R18][Technical] Is a secondary single-number smoothness score useful for dashboards, or do the three canonical raw metrics already provide enough operational clarity?

## Next Steps

→ /ce-plan for structured implementation planning