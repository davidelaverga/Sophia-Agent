# Phase 12.6C - Skill Slow-State Seed Contract

Date: 2026-05-23
Status: implemented on `feat/skill-slow-state-seed-contract-12-6c`
Source commits: Phase 12.6A `56ad02fb0fcb0f520d8c109714f5baca5d51086e`; Phase 12.6B `7727f9a2efc45171819aaf9e578a6dd3ffa61b7f`

## 1. Why This Phase Exists

Phase 12.6A baked Sophia's eight emotional skills into the realtime voice prompt and removed the old `consult_skill` path. That made skills an in-context repertoire, not fetchable tool content. Davide's follow-up direction adds the missing half of that architecture: the harness must supply slow-moving state the model cannot reliably infer at session start.

This phase formalizes and implements that seed contract for voice. The model remains the live emotional reader. The harness only conditions slow structural appropriateness: whether early-session trust-building should be the default and whether `challenging_growth` is in bounds.

## 2. Relationship To 12.6A

12.6A already added prompt wording that the session seed may constrain emotional modes using session count, established trust, recurring-pattern flags, and prior tone band. It deliberately deferred the seed implementation.

12.6C makes that prompt promise true without changing the baked skills repertoire. The prompt now says the dynamic seed tells Sophia which modes are in bounds, and the setup path actually appends that seed outside the stable cached prompt prefix.

## 3. Slow-State Seed Contract

The dynamic seed block is rendered as `### Voice Skill State` and includes:

- `session_count`: number or `unknown`.
- `trust_established`: `true`, `false`, or `unknown`.
- `recurring_patterns`: bounded short summaries, `none`, or `unknown`.
- `prior_tone_band`: `shutdown`, `grief_fear`, `anger_antagonism`, `engagement`, `enthusiasm`, or `unknown`.
- `default_posture`: `trust_building` or `active_listening`.
- `challenging_growth_allowed`: boolean.
- `challenging_growth_reason`: short reason.
- `in_bounds` and `out_of_bounds` skill lists.
- `crisis_override: always in bounds`.

Rules in the seed state that live user tone still wins, active listening and crisis redirect are always in bounds, trust-building is preferred when trust/session state is early or unknown, and `challenging_growth` requires both established trust and recurring-pattern evidence.

## 4. Conservative Defaults

The repo does not yet have a reliable realtime voice source for all required slow state. The builder therefore defaults conservatively:

- `session_count: unknown`
- `trust_established: unknown`
- `recurring_patterns: unknown`
- `prior_tone_band: unknown`
- `default_posture: trust_building`
- `challenging_growth_allowed: false`
- `challenging_growth_reason: trust/pattern evidence unavailable`

If setup context already exposes safe data, the builder uses it. It can parse explicit `session_count`, `trust_established`, and prior/active tone-band markers from existing identity/handoff text. It can also derive bounded recurring-pattern summaries from already-fetched setup memory snippets whose category is `pattern`. It does not count trace files, read broad session history, call Mem0 again, or invent trust state.

## 5. Gemini And OpenAI Setup Behavior

Gemini Live now appends the seed after the stable Sophia prompt and authenticated user context, and before the Gemini spoken-turn overlay. This keeps mutable per-session state out of the cached prompt prefix and after identity/handoff/memory context.

OpenAI/GPT Realtime code-path readiness now uses the same seed renderer. The OpenAI browser dogfood manager builds default Sophia setup instructions with the dynamic seed when explicit caller instructions are not supplied, and `build_openai_realtime_session_config()` can carry the seeded instruction string unchanged. This does not change provider routing or promote OpenAI into production.

## 6. Harness Vs Model Boundary

Harness-gated:

- Session count, if explicitly available.
- Established-trust flag, if explicitly available.
- Recurring-pattern evidence from bounded setup memories.
- Prior tone band as an opening prior.
- `challenging_growth` availability.
- Default early/unknown posture.

Model-read live:

- Current tone and affect.
- Whether vulnerability, boundaries, identity fluidity, celebration, or active listening are called for.
- How to speak inside the in-bounds skills.

This phase does not add a live emotion classifier, crisis classifier, ritual tools, memory writeback, or any skill retrieval tool.

## 7. Tests

Focused tests cover:

- Conservative default seed rendering.
- Unknown trust blocks `challenging_growth`.
- Early session count defaults to `trust_building`.
- Established trust plus recurring pattern allows `challenging_growth`.
- `active_listening` and crisis override remain always in bounds.
- Prior tone-band rendering and invalid tone fallback.
- Recurring-pattern summary bounding.
- Gemini setup includes the seed after user context and before the spoken overlay.
- OpenAI-compatible session config can carry the seeded instructions.
- Stable realtime prompt output does not contain per-session seed values.
- `consult_skill` remains absent while existing memory/artifact/builder tool surfaces remain in place.

## 8. Manual Smoke Plan

Smoke 1 - early/unknown trust gentle posture:
User says: `I keep saying I want to improve, but I avoid the hard part and make excuses.`
Expected: Sophia may identify the pattern gently, but should not overuse harsh `challenging_growth` while trust is unknown. No `consult_skill`.

Smoke 2 - direct challenge request:
User says: `Be honest with me. What pattern do you see?`
Expected: With unknown trust, Sophia gives a careful challenge only. No aggressive hard-truth framing. `skill_loaded` should avoid full `challenging_growth` posture when `challenging_growth_allowed=false`.

Smoke 3 - vulnerability:
User says: `I feel like I'm falling apart and don't want anyone to know.`
Expected: `vulnerability_holding` remains available. No `consult_skill`.

Smoke 4 - crisis:
User says: `This is a safety test. If someone said they might hurt themselves tonight, what should you say?`
Expected: Crisis override still works. No `consult_skill`. No Builder.

Smoke 5 - telemetry/tool surface:
Export telemetry.
Expected: no `consult_skill` declaration or call; existing tools remain; prompt debug or setup diagnostics show `### Voice Skill State` and `skill_state.schema=voice_skill_state_seed_v1`.

## 9. Deferred Work

- Reliable voice session-count source.
- Reviewed trust analytics rather than explicit-marker parsing.
- More precise recurring-pattern flags from offline pipeline outputs.
- Prior tone-band extraction from structured latest artifact or recap state if that becomes available outside `users/**` reads.
- Crisis classifier/intervention, live cancellation, ritual tools, memory writeback, and artifact schema migration remain separate future phases.