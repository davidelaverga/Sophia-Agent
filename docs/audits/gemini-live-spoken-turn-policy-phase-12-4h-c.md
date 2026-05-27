# Phase 12.4H-C - Gemini Live Spoken Turn Policy Overlay

Date: 2026-05-21
Status: implemented; pending live Gemini production Session smoke
Source branch: `audit/gemini-over-continuation-turn-policy-phase-12-4h-b`
Implementation branch: `fix/gemini-live-spoken-turn-policy-phase-12-4h-c`
Runtime targeted: Gemini Live production candidate

## Scope And Safety

This phase implements the narrow prompt-policy fix recommended by the Phase 12.4H-B audit. It does not:

- Edit `skills/public/sophia/soul.md`.
- Rewrite canonical Sophia identity, context, ritual, voice, technique, or builder contract files.
- Remove context or ritual prompts globally.
- Add frontend text suppression.
- Add transcript or audio filters.
- Change Gemini relay, PCM playback, transcript assembly, or tool-loop infrastructure.
- Make Gemini the default runtime.
- Remove or weaken the legacy cascade.

The worktree was already dirty from Phase 1-12.4H-B migration work before this branch. This phase adds a focused Gemini prompt assembly overlay, tests, and docs on top of that existing dirty state.

## Root Cause From 12.4H-B

The 12.4H-B audit concluded that the remaining duplicate-reply class is not primarily frontend rendering, relay ordering, tool continuation, interruption cleanup, greeting duplication, or PCM replay.

The leading cause is prompt/topology mismatch: Gemini Live native audio receives the full canonical Sophia companion prompt and directly owns response timing, spoken output, output transcription, and tool choice. Existing guidance such as `1-3 sentences` and `one question at a time` is present, but it is diffuse inside a larger prompt that also includes emotional depth, context routing, ritual preparation, builder spec gathering, and artifact/session bookkeeping. Gemini therefore sometimes expresses multiple plausible conversational moves in one spoken turn.

The problematic class includes both:

- Hearing-check over-continuation: acknowledgement plus multiple openers.
- Recommendation/focus stacking: several versions of the same clarifier or coaching setup in one reply.

## Overlay Design

The implementation adds `build_gemini_live_spoken_turn_policy_overlay()` in `voice/realtime/sophia_prompt.py` and routes Gemini instruction assembly through `build_gemini_live_realtime_instructions()`.

The base canonical builder, `build_sophia_realtime_instructions()`, remains unchanged and does not include the overlay. Gemini dogfood and production paths now use the Gemini wrapper before `build_gemini_live_setup_config()` places the instructions into `systemInstruction.parts[0].text`.

The overlay is appended after the voice artifact contract in the fully rendered Gemini prompt. That keeps Sophia's identity and structured tool obligations intact while making the final spoken-output contract explicit for the provider that speaks natively.

Policy principles included:

- Speak as live audio and stop cleanly.
- Choose one main conversational intent per assistant turn.
- Answer the user's immediate intent first.
- Ask at most one question total in the spoken reply.
- Do not stack multiple opener questions.
- Do not ask the same clarification in different words.
- Do not shift into coaching or session setup after simple hearing or connection checks.
- For hearing checks, reply briefly, then stop or ask one light next-step prompt.
- For recommendation/focus prompts, either ask one missing-context question or give one concise recommendation.
- For emotional/coaching turns, give one clear point and one optional next step.
- Keep artifact/tool obligations structured and do not narrate artifact fields, session goals, tone estimates, ritual phases, or internal bookkeeping.
- Do not let artifact/tool instructions expand the spoken reply.
- If unsure, be shorter and let the user guide the next step.

The overlay includes two compact examples: a hearing check and a recommendation/focus prompt. They are intentionally short so the prompt does not become another large competing instruction source.

## Why Canonical Prompt Files Were Not Edited

Canonical Sophia files are shared across companion runtimes and encode identity, voice, techniques, builder coordination, context, ritual, and artifact behavior. The observed issue is specific to Gemini Live native audio receiving that full prompt inside a provider-owned realtime speech session.

Editing canonical files would risk weakening Sophia's core identity and changing legacy or non-Gemini behavior. A Gemini-specific overlay is safer because it addresses the migration-specific response-shaping topology without rewriting the source prompts that Sophia relies on elsewhere.

## Test Matrix

Automated coverage added:

| Test | Purpose |
|---|---|
| `voice/tests/test_sophia_prompt.py::test_gemini_live_prompt_includes_spoken_turn_policy_overlay` | Gemini Live rendered prompt includes the overlay with context/ritual sources intact. |
| `voice/tests/test_sophia_prompt.py::test_base_sophia_realtime_prompt_does_not_include_gemini_overlay` | Base canonical prompt path remains overlay-free. |
| `voice/tests/test_sophia_prompt.py::test_gemini_live_spoken_turn_policy_contains_required_rules` | Overlay contains one-intent, max-one-question, hearing-check, recommendation/focus, artifact/tool, and bookkeeping rules. |
| `voice/tests/test_sophia_prompt.py::test_gemini_live_setup_contains_overlay_after_artifact_contract` | Fully rendered Gemini setup `systemInstruction` includes the overlay after the artifact contract. |
| `voice/tests/test_sophia_prompt.py::test_gemini_live_instruction_sources_append_overlay_source` | Gemini prompt source list records the overlay source after canonical sources. |
| `voice/tests/test_gemini_browser_dogfood.py` prompt assertions | Dogfood and production Gemini browser sessions mint setup payloads with the overlay. |

Validation commands for this phase:

```powershell
python -m pytest voice/tests/test_sophia_prompt.py voice/tests/test_gemini_browser_dogfood.py voice/tests/test_gemini_live_provider_adapter.py
python -m compileall voice/realtime/sophia_prompt.py voice/realtime/dogfood_session.py voice/realtime/gemini_production_session.py scripts/render_gemini_live_prompt.py voice/tests/test_sophia_prompt.py voice/tests/test_gemini_browser_dogfood.py
python -m ruff check voice/realtime/sophia_prompt.py voice/realtime/dogfood_session.py voice/realtime/gemini_production_session.py scripts/render_gemini_live_prompt.py voice/tests/test_sophia_prompt.py voice/tests/test_gemini_browser_dogfood.py voice/tests/test_gemini_live_provider_adapter.py
git diff --check
git status --short -uall
```

Observed validation results:

- Focused pytest: `51 passed`.
- Compileall on touched Python files: passed.
- Focused Ruff on touched Python files and the existing Gemini adapter test file: passed.
- `git diff --check`: passed.
- `git status --short -uall`: still dirty, with broad pre-existing Phase 1-12.4H-B migration work plus this phase's overlay files.

## Manual Smoke Plan

Run these in the normal production Session UI with Gemini selected through the existing explicit gates. Capture current-run telemetry after each run.

### 1. Hearing Check

User:

```text
Hi Sophia, can you hear me clearly?
```

Expected:

- One concise acknowledgement.
- At most one light next question.
- No second opener.
- No stacked `what are you heading into right now?` after another opener.

### 2. Simple Greeting

User:

```text
Hey Sophia.
```

Expected:

- Brief greeting.
- One opener only.
- No repeated greeting in different words.

### 3. Recommendation

User:

```text
What do you recommend I focus on today?
```

Expected:

- One clarifier or one concise recommendation.
- Not several clarifiers.
- No context classifier plus ritual focus question plus broad planning prompt in the same reply.

### 4. Gaming Context

User:

```text
I'm about to play ranked. What should I focus on?
```

Expected:

- One focused recommendation or one focused question.
- No stacked ritual/context questions.
- No `what game`, `what focus`, and `what planned` all in one reply.

### 5. Calm Under Pressure

User:

```text
Staying calm under pressure.
```

Expected:

- One coaching point.
- One optional next step.
- No repeated reframing of the same point.

### 6. Tool-Adjacent Reflection

User:

```text
Sophia, reflect briefly on what I just said.
```

Expected:

- Structured tool/artifact behavior continues.
- Spoken reply remains concise.
- No artifact/session bookkeeping spoken aloud.

## Deferred Options

Do not tune these in this phase. Revisit only after the manual smoke matrix shows what remains:

- VAD and turn-coverage tuning.
- `maxOutputTokens` or response-length controls.
- Temperature/top-p changes.
- First-turn UI presentation changes.
- Gemini-specific context prompt slimming.
- Intent classifier/router before Gemini setup or response.

## Success Criteria

This phase succeeds if Gemini Live receives the explicit spoken-turn overlay, hearing checks and recommendation/focus turns stop expressing multiple candidate intents, canonical Sophia prompt files remain intact, and legacy/non-Gemini prompt paths are not silently modified.
