# Phase 12.4L - Gemini Spoken Intent And Deictic Policy Hardening

Date: 2026-05-21
Status: implemented; pending live Gemini production Session smoke
Source branch: `voice-transport-migration`
Implementation branch: `fix/gemini-spoken-intent-deictic-policy-phase-12-4l`
Runtime targeted: Gemini Live production candidate only

## Scope And Safety

This phase is prompt-policy only. It does not:

- Tune VAD, `realtimeInputConfig`, automatic activity detection, activity handling, turn coverage, silence thresholds, or generation parameters.
- Change Gemini relay throughput, relay ordering, transcript source-order buffering, or frontend transcript suppression.
- Edit canonical Sophia identity files such as `skills/public/sophia/soul.md`.
- Change tool execution, artifact validation, Builder lifecycle behavior, Builder output storage, or Builder UI.
- Make Gemini the default runtime.

The worktree was already dirty from Phase 1-12.4J migration work before this branch. This phase preserves that state and changes only the Gemini-only overlay, focused tests, and documentation.

## Root Cause

The Phase 12.4J evidence run showed that Gemini Live can still over-express Sophia's rich prompt and bind deictic language too broadly even after the Phase 12.4H-C spoken overlay.

Two examples define the remaining class:

- Hearing check: `Do you hear me clearly?` produced acknowledgement plus gaming/session-prep assumptions and a repeated opener.
- Deictic reflection: after `Quick question before I go` and `reflect briefly on what I just said`, Gemini resolved the antecedent to the broader game recommendation thread instead of the latest meaningful phrase.

This is not primarily a frontend transcript bug, tool bug, interruption bug, relay-order bug, or Builder output bug. The prompt overlay already said one intent and max one question, but it was still too general for native audio: it lacked explicit hearing-check anti-assumption rules, deictic/antecedent rules, filler/setup phrase behavior, and sharper recommendation/focus examples.

## Policy Changes

`voice/realtime/sophia_prompt.py` keeps the existing `<gemini_live_spoken_turn_policy>` overlay and strengthens it with:

- One main conversational intent and at most one spoken question.
- No repeated opener or repeated clarifier.
- Hearing/availability checks get a brief acknowledgement only, optionally followed by one neutral prompt.
- No gaming, work, ritual, lock-in, or session-prep assumption from generic greetings or hearing checks.
- Gaming/session context is used only when the current turn or immediately preceding user context clearly established it.
- Recommendation/focus prompts choose one path: one clarifier if context is missing, or one concise recommendation if context is present.
- Deictic requests such as `what I just said`, `that`, and `what I just told you` resolve to the latest complete user utterance or latest clearly stated phrase.
- Filler/setup phrases such as `quick question before I go`, `um`, `like`, `one more thing`, and `before I leave` are skipped when searching for the meaningful antecedent if the user continues.
- Reflection requests are answered directly and briefly; Gemini should not ask `what do you want me to focus on?` unless the antecedent is genuinely missing.
- Artifact/tool obligations stay structured and must not expand spoken output or narrate artifact bookkeeping.

The base Sophia prompt builder remains unchanged and overlay-free. Gemini dogfood and production setup continue to inject the overlay through `build_gemini_live_realtime_instructions()` into `systemInstruction.parts[0].text`.

## Why Not VAD Yet

Official Gemini Live docs confirm native audio is realtime and incremental: `realtimeInput` can be sent continuously, end-of-turn is derived from activity, and data can be processed before end of turn to optimize fast response starts. The same docs also confirm `realtimeInputConfig` can control automatic activity detection, activity handling, and turn coverage.

This phase intentionally does not change those fields. Phase 12.4J was built to decide whether future bad turns are capture/VAD issues, public continuity issues, interruption/tool-cancellation issues, or policy issues. The latest class still has a prompt-policy component: when input is complete, Gemini needs clearer instructions for hearing checks, antecedents, setup phrases, and recommendation stacking.

## Why Not Relay Work Yet

Phase 12.4G-B already added ordered relay behavior for continuity-critical relayed Gemini messages, and Phase 12.4J added evidence for turn capture. The remaining examples are semantically wrong or over-eager spoken choices, not a proven throughput or ordering regression. Ordered relay throughput work remains a separate Phase 12.4K candidate and should not be mixed with this policy change.

## Tests

Focused tests cover:

- Strengthened hearing-check policy.
- Anti-assumption gaming/session policy.
- Recommendation/focus one-clarifier rule.
- `what I just said` / deictic resolution rule.
- Filler/setup phrase rule.
- Artifact/tool non-verbalization rule.
- Base Sophia prompt remains overlay-free.
- Gemini dogfood setup includes the strengthened overlay.
- Gemini production setup includes the strengthened overlay.
- Checked-in fully rendered Gemini prompt debug output includes the strengthened overlay.

Validation commands for this phase:

```powershell
python -m pytest voice/tests/test_sophia_prompt.py voice/tests/test_gemini_browser_dogfood.py
python -m compileall voice/realtime/sophia_prompt.py voice/tests/test_sophia_prompt.py voice/tests/test_gemini_browser_dogfood.py
python -m ruff check voice/realtime/sophia_prompt.py voice/tests/test_sophia_prompt.py voice/tests/test_gemini_browser_dogfood.py
git diff --check
git status --short -uall
```

## Manual Smoke Plan

Run these in the production Session path with Gemini explicitly selected, then export current-run telemetry.

## Smoke 1 - Hearing check

User:
`Hey Sophia, do you hear me clearly?`

Expected:
- Concise acknowledgement.
- No gaming/session assumption.
- No second opener.

## Smoke 2 - Generic recommendation

User:
`What do you recommend I focus on today?`

Expected:
- One clarifier OR one recommendation.
- Not multiple clarifiers.

## Smoke 3 - Game recommendation

User:
`Do you have any game recommendations?`

Expected:
- One clarifier: `What kind of game are you in the mood for?`
- Or one concise recommendation if enough context exists.

## Smoke 4 - Deictic reflection

User:
`I'm better than this. I'm in control.`

Then:
`Sophia, reflect briefly on what I just said.`

Expected:
- Reflects the mantra.
- Does not ask `what do you want me to focus on?`
- Does not recap the whole game recommendation thread.

## Smoke 5 - Pause-heavy reflection

User:
`Quick question before I go... um... reflect briefly on what I just said.`

Expected:
- Uses latest meaningful user content.
- Does not treat `quick question before I go` as the main intent.

## Smoke 6 - Tool-adjacent reflection

User:
`Sophia, reflect briefly on what I just said.`

Expected:
- Artifact/tool behavior can continue.
- Spoken output remains concise and does not mention artifact bookkeeping.

## Deferred Options

- Phase 12.4K ordered relay throughput, if later evidence shows relay queue/backpressure is affecting turn continuity.
- Gemini VAD or turn tuning, if the next smoke proves prompt policy is insufficient and the Phase 12.4J timeline shows partial/split input before assistant output.
- A more explicit turn-memory or antecedent repair strategy, if provider input and public continuity are complete but Gemini still binds deictic references to the wrong topic.
- Generation parameter tuning, if policy succeeds semantically but spoken turns remain too long.

## Success Criteria

This phase succeeds if Gemini Live receives stricter spoken intent/deictic policy, hearing checks stop triggering gaming/session assumptions, `what I just said` has latest-meaningful-user-content behavior, recommendation prompts stop stacking clarifiers, and tool/artifact obligations remain structured and non-verbalized without changing VAD, relay, tool behavior, or canonical Sophia identity.