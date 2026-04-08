---
title: "Sophia voice fragmentation: await TTS interruption and guard short fragments before SmartTurn fires"
date: 2026-04-01
category: integration-issues
module: voice
problem_type: integration_issue
component: assistant
symptoms:
  - Sophia replied to partial thoughts as separate turns during voice sessions.
  - Some mixed or edge-case prompts produced two responses or abrupt follow-up questions like "What happened?"
  - Logs emitted "RuntimeWarning: coroutine 'TTS.interrupt' was never awaited" during cancel-and-merge.
  - New sessions felt progressively rough or terse even though each session started cleanly.
root_cause: async_timing
resolution_type: code_fix
severity: high
related_components:
  - voice.sophia_turn
  - voice.sophia_tts
  - vision_agents smart_turn
tags:
  - voice
  - smartturn
  - cancel-and-merge
  - tts-interrupt
  - fragmented-turns
  - vision-agents
  - cartesia
---

# Sophia voice fragmentation: await TTS interruption and guard short fragments before SmartTurn fires

## Problem

Sophia's live voice conversations could feel choppy even when audio transport and session startup were healthy. Users could pause mid-thought, hear Sophia respond to the fragment, continue talking, and then get either a second response or a confused follow-up because the original thought had been split into multiple turns.

## Symptoms

- Voice sessions sometimes produced a response to only part of the user's thought.
- An edge-case prompt could yield two assistant responses in quick succession.
- Follow-up responses sometimes became oddly terse or context-poor, for example "What happened?"
- Logs showed `RuntimeWarning: coroutine 'TTS.interrupt' was never awaited` during cancel-and-merge.
- The issue looked like a session leak at first, but each new session actually created a fresh LangGraph thread.

## What Didn't Work

- Treating the issue as a thread or connection leak. Log inspection showed each new session had a distinct LangGraph thread, so stale conversation state was not the culprit.
- Assuming short upbeat responses alone indicated degraded model behavior. Some terse replies were actually proportional to the prompt; the real failure mode was fragmented turn submission.
- Relying only on trailing continuation detection. Phrases like `are getting better` or `with my friend` do not end with a conjunction or filler, so they still passed through the short-utterance silence tier and got evaluated too early.

## Solution

Three changes fixed the behavior.

### 1. Await the async TTS interruption inside cancel-and-merge

Before:

```python
async def _execute_cancel_and_merge(self) -> None:
    await self._cancel_llm_task()
    self._interrupt_tts()
    await self._send_acknowledgment(self._pick_acknowledgment())
```

After:

```python
async def _execute_cancel_and_merge(self) -> None:
    try:
        await self._cancel_llm_task()
    except Exception:
        logger.exception("[FLOW] Failed to cancel LLM task — continuing anyway")

    try:
        await self._interrupt_tts()
    except Exception:
        logger.exception("[FLOW] Failed to interrupt TTS — continuing anyway")

    phrase = self._pick_acknowledgment()
    try:
        await self._send_acknowledgment(phrase)
    except Exception:
        logger.exception("[FLOW] Failed to send acknowledgment")
```

The injected callback ultimately calls Vision Agents `TTS.interrupt()`, which is async. Not awaiting it meant cancel-and-merge never actually stopped playback, so the recovery path was effectively broken.

### 2. Skip empty merged transcript resubmissions

```python
merged = self._merge_transcripts(self._base_transcript, latest_transcript)
if not merged.strip():
    logger.debug("[FLOW] Skipping resubmit — merged transcript empty")
    self._base_transcript = ""
    self._current_transcript = ""
    return None
```

This prevents blank follow-up turns from being reinserted into the conversation thread after a cancellation.

### 3. Add fragment-start detection to adaptive silence

SmartTurn is audio-only. It does not know that a short phrase beginning with a function word is likely mid-sentence. Add a transcript-aware fragment check and treat it like a continuation signal.

```python
_FRAGMENT_MAX_WORDS = 5
_FRAGMENT_START_PATTERN = re.compile(
    r"^\s*(?:are|is|was|were|am|have|has|had|do|does|did|will|would|could|"
    r"should|might|can|may|shall|being|getting|going|having|not|never|also|"
    r"still|just|even|than|then|that|which|who|whom|whose|where|when|while|"
    r"in|on|at|with|for|from|about|into|through|over|under|the|a|an)\b",
    re.IGNORECASE,
)

@staticmethod
def _is_fragment(text: str, word_count: int) -> bool:
    if word_count == 0 or word_count > _FRAGMENT_MAX_WORDS:
        return False
    return bool(_FRAGMENT_START_PATTERN.match(text.strip()))

continuation = self._has_continuation_signal(self._current_transcript)
fragment = self._is_fragment(self._current_transcript, word_count)
bonus = self._continuation_bonus_ms if (continuation or fragment) else 0
```

This changes examples like `are getting better` from a 1000ms gate to an 1800ms gate, giving the user more time to finish the sentence before SmartTurn evaluates end-of-turn.

## Why This Works

Vision Agents SmartTurn uses an audio-only pipeline: Silero VAD detects speech and silence, then an ONNX turn-completion model decides whether the user is done. It does not inspect transcript text. That means short fragments can sound complete enough to the model if the silence gate opens too early.

Sophia's custom turn detection layer solves the problem in two places:

- **Before SmartTurn evaluates**: transcript-aware adaptive silence adds time when the partial transcript looks incomplete.
- **After SmartTurn fires too early anyway**: cancel-and-merge interrupts the current response, acknowledges the user, and resubmits the merged transcript once the thought is complete.

Awaiting `TTS.interrupt()` is the critical part that makes the recovery path real. Without it, the cancel path logs a warning but never actually stops playback. The fragment-start heuristic complements SmartTurn rather than replacing it: it only changes when the ML model gets asked to evaluate, not the model's final decision logic.

## Prevention

- Treat any injected callback typed as `Awaitable[...]` as async by default. If it ultimately wraps provider behavior like TTS interruption, `MagicMock()` is the wrong test double; use `AsyncMock()` and assert it is awaited.
- Keep transcript-aware heuristics on top of SmartTurn. The SDK is intentionally audio-only, so linguistic clues like fragment starts and continuation words must be added in Sophia's layer.
- Add regression tests for both behavior classes:
  - `voice/tests/test_conversation_flow.py` for async cancel flow, acknowledgment ordering, and resubmit guards.
  - `voice/tests/test_sophia_turn.py` for fragment-start phrases like `are getting better`, `with my friend`, and `could have been`.
- When a voice regression looks like a session leak, confirm thread IDs first. In this case, unique threads ruled out the wrong hypothesis quickly.
- Watch logs for `never awaited` warnings in voice infrastructure. They are high-signal indicators that recovery or cancellation paths are not actually executing.

## Related Issues

- Low-overlap related docs:
  - [docs/solutions/logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md](docs/solutions/logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md)
  - [docs/solutions/logic-errors/langgraph-middleware-chain-review-pitfalls.md](docs/solutions/logic-errors/langgraph-middleware-chain-review-pitfalls.md)
- Overlap assessment: **Low**. The related docs cover LangGraph state and middleware review pitfalls, not voice turn-boundary recovery or TTS interruption.
- GitHub issue search was skipped because `gh` is not installed in this environment.