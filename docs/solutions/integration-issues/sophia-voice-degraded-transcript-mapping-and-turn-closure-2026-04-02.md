---
title: "Sophia voice live mapping: normalize degraded STT transcripts and close turns without TTS lifecycle events"
date: 2026-04-02
category: integration-issues
module: voice
problem_type: integration_issue
component: assistant
symptoms:
  - Degraded celebratory live transcripts were not normalized back to celebratory artifacts.
  - Degraded grief live transcripts lost the explicit loss clause and drifted to clarification-oriented artifacts.
  - Some completed live runs emitted transcript plus artifact but no TTS lifecycle events, so the benchmark marked them as no_turn_closure.
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - voice.voice_delivery_profile
  - voice.sophia_llm
  - voice.turn_diagnostics
  - ai-companion-mvp-front live benchmark harness
tags: [voice, stt-degradation, emotion-mapping, turn-closure, benchmark, artifact-normalization]
---

# Sophia voice live mapping: normalize degraded STT transcripts and close turns without TTS lifecycle events

## Problem

Sophia's live voice benchmark had reached the point where transport and mapping failures could alternate across runs. Some live calls completed but mapped the user's emotional state incorrectly because STT dropped decisive transcript prefixes, while other runs produced transcript plus artifact but still got classified as `no_turn_closure` because turn completion depended too heavily on TTS lifecycle callbacks.

## Symptoms

- `map_02_excitement` could regress to reflective or engagement artifacts when STT produced variants such as `today ... still can believe it`, `and believe it, it actually happened`, or similarly degraded disbelief phrases.
- `map_01_grief` could regress to clarification-oriented handling when STT dropped `I lost someone` and mostly preserved `important to me ... don't know how to make sense of it`.
- Some live runs produced final transcript text and a valid artifact, but no `agent_started` or completion diagnostic, so the benchmark still reported `no_turn_closure`.
- The same codebase could show green mapping in a targeted rerun and then fail a full suite on lifecycle events, or vice versa.

## What Didn't Work

- Matching only clean user phrases such as `I got the job` or `I lost someone really important to me`.
- Assuming the backend artifact or assistant wording would recover the correct family when STT had already removed the decisive user-language cue.
- Treating TTS lifecycle callbacks as the only trustworthy assistant-turn boundary once text and artifact had already streamed successfully.
- Looking at only one metric family at a time. Transport could be green while mapping regressed, and mapping could be green while closure still failed.

## Solution

The fix hardened both transcript semantics and turn lifecycle accounting.

### 1. Expand degraded celebratory and grief transcript detection

`voice/voice_delivery_profile.py` now recognizes noisy live STT residue instead of depending on perfect phrasing.

```python
_USER_CELEBRATORY_PATTERNS = [
    re.compile(
        r"\b(still )?can(?:not|'?t)? believe it\b.*\b(it actually happened|actually happened|it happened)\b",
        re.I,
    ),
    re.compile(r"\bbelieve it\b.*\b(it actually happened|actually happened|it happened)\b", re.I),
    re.compile(r"\btoday\b.*\b(?:still )?can(?:not|'?t)? believe it\b", re.I),
]

_USER_SUPPORTIVE_PATTERNS = [
    re.compile(r"\bimportant to me\b.*\bdon'?t know (?:how )?to make sense (?:of|with) it\b", re.I),
]
```

That lets artifact normalization recover the intended delivery family even when STT drops `can't`, `today`, or the explicit loss clause.

### 2. Treat first streamed text as assistant turn start

`voice/sophia_llm.py` now emits `agent_started` on the first streamed text chunk rather than relying only on TTS synthesis start.

```python
if first_token_ms is None:
    first_token_ms = (time.perf_counter() - request_started) * 1000
    self.note_first_text_emitted(request.user_id)
    await self.emit_turn_event("agent_started", request.user_id)
```

This keeps the benchmark and frontend aligned with what the user can already observe: the assistant has started responding.

### 3. Finalize completed turns when final text and artifact arrive, even if TTS hooks do not

`voice/turn_diagnostics.py` and `voice/sophia_llm.py` now record final text emission and allow completion fallback when the assistant clearly finished logically but TTS lifecycle events never arrived.

```python
def can_finalize(self, user_id: str) -> bool:
    ...
    if current.completed_audio_cycles >= current.agent_cycle_count:
        return True

    return (
        current.agent_started_emitted
        and current.final_text_emitted
        and current.first_audio_ms is None
    )
```

```python
self.note_backend_completed(request.user_id)
await self._emit_transcript_event("".join(text_parts), is_final=True)
self.note_final_text_emitted(request.user_id)
```

That converts `transcript + artifact but no TTS lifecycle` from a false transport failure into a completed turn.

### 4. Add regression coverage for the real live variants

Focused tests now cover:

- degraded excitement variants such as `and believe it, it actually happened.`
- degraded grief variants such as `important to me. I still don't know to make sense with it.`
- assistant completion when text and artifact arrive without TTS lifecycle hooks

## Why This Works

The mapping failures came from transcript degradation, not only from backend prompting. Once STT removed the key user-language cue, the artifact normalizer had no basis for promoting the response back to the intended family. Expanding the transcript classifier fixes that at the shared semantic layer, which benefits both artifact normalization and delivery selection.

The closure failures came from treating audio telemetry as the only completion source. In practice, a turn is already complete for the benchmark once final text and artifact have arrived. The lifecycle fallback makes turn diagnostics robust to missing TTS callbacks without weakening the normal audio-cycle path.

The final verified live run demonstrated that both sides were needed together. The benchmark at [AI-companion-mvp-front/test-results/voice-benchmarks/2026-04-02T21-11-37-005Z](../../../AI-companion-mvp-front/test-results/voice-benchmarks/2026-04-02T21-11-37-005Z/benchmark-report.json) finished at `5/5` completion, `emotion_family_hit_rate = 1`, `tone_band_hit_rate = 1`, and `median_false_user_ended_count = 1`.

## Prevention

- Keep STT-degraded transcript variants in regression tests alongside clean canonical utterances. Benchmark-clean phrasing is not enough.
- Validate live voice changes against both mapping metrics and lifecycle metrics. Either side can regress independently.
- Treat missing TTS lifecycle hooks as recoverable telemetry loss when final text plus artifact already prove logical completion.
- Put transcript normalization in the shared classifier layer instead of scattering one-off recovery rules across benchmark code or artifact post-processing.
- Restart the live voice server after runtime changes before trusting benchmark results. Live captures are invalid if they hit stale code.

## Related Issues

- Related but distinct: [docs/solutions/integration-issues/sophia-voice-fragmented-turns-2026-04-01.md](sophia-voice-fragmented-turns-2026-04-01.md)
- Background docs with low overlap:
  - [docs/solutions/logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md](../logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md)
  - [docs/solutions/logic-errors/langgraph-middleware-chain-review-pitfalls.md](../logic-errors/langgraph-middleware-chain-review-pitfalls.md)
- Follow-up refresh candidate: narrow the framing in the older fragmented-turns doc so its earlier claim about "degraded-seeming upbeat behavior" is clearly scoped to that incident rather than all live-voice regressions.