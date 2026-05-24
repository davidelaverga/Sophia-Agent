# Phase 12.6D-C - Intent-Gated Gemini Barge-in Confirmation

Date: 2026-05-24
Status: implemented on `integrate/realtime-voice-main`
Source commit: pending

## 1. Why This Phase Exists

Phase 12.6D fixed stale assistant repetition after interruption, but it allowed stale-output suppression to become too aggressive. Phase 12.6D-B split candidate and confirmed barge-in state, yet the follow-up local smoke still cut Sophia off after one word or very early in the answer.

The new telemetry report was `sophia-voice-telemetry-report-2026-05-24T05-04-34-187Z.json`. Gemini produced a full answer (`modelTurnAudio=200`, `outputTranscription=74`), but the browser guard dropped most valid output (`staleAssistantAudioDroppedCount=148`, `staleAssistantTranscriptDroppedCount=59`, `staleAssistantOutputSuppressionCount=207`). The key red flag was `inputFrameOnlyNotBargeInCount=0` while `bargeInCandidateFrameCount=25` and `staleSuppressionArmedAt=2026-05-24T05:04:31.020Z`, meaning raw mic frames were still escalating into confirmed suppression.

## 2. Root Cause

12.6D-B still confirmed barge-in from raw `input_audio_frame_sent` count plus represented audio duration. Those diagnostics prove microphone frames were sent; they do not prove a new user intent. Once frame count crossed the local threshold, the browser armed `barge_in_generation_active`, stopped or fenced the current playback generation, and suppressed later Gemini audio/transcript chunks even though Gemini was still producing the valid current answer.

Provider `inputTranscription` was also too blunt: any input transcription while assistant audio was pending could confirm and flush playback, without checking whether the text was non-empty, newer than the current assistant response start, or likely echo/noise.

## 3. Runtime Behavior Changed

- Raw `input_audio_frame_sent` during assistant playback is candidate/residual mic activity only.
- Raw frame count and represented duration no longer confirm barge-in by themselves.
- Raw frames do not increment playback generation, arm stale suppression, drop assistant audio/transcript, or interrupt assistant transcript state.
- Confirmed barge-in now requires one of: Gemini `serverContent.interrupted`, explicit local/manual playback flush, or conservative provider `inputTranscription` with real text after assistant output has begun.
- Provider `inputTranscription` confirmation does not flush already scheduled audio. It fences future old-generation chunks while allowing already valid pre-fence output to continue unless Gemini also sends interruption.
- Provider interruption remains strong: playback flushes immediately, stale suppression stays active, and interrupted response ids remain stale.

## 4. Diagnostics Added

New and updated browser/runtime/report diagnostics:

- `bargeInConfirmationSource`: `none`, `provider_interruption`, `provider_input_transcription`, `manual_interrupt`, or `sustained_speech`.
- `bargeInConfirmationReason`.
- `candidateFramesDidNotConfirmCount`.
- `candidateExpiredCount`.
- `suppressionBlockedBecauseNoIntentCount`.
- `staleSuppressionArmedBy`, which must never be raw input audio.
- `rawAssistantUserOverlapMs` / `maxRawAssistantUserOverlapMs`.
- `confirmedAssistantUserOverlapMs` / `maxConfirmedAssistantUserOverlapMs`.

`assistantUserOverlapMs` remains backward-compatible and now follows raw overlap in the frontend metrics. Confirmed barge-in overlap is reported separately so future smokes can show high raw mic overlap with low confirmed-intent overlap.

## 5. Tests Updated

Focused coverage now verifies:

- one raw input audio frame during assistant playback does not confirm barge-in;
- multiple raw input frames without provider text/interruption do not confirm barge-in;
- assistant audio after raw frames is still scheduled;
- provider interruption confirms and suppresses old output;
- provider input transcription confirms only after real text and does not flush already scheduled audio;
- `inputFrameOnlyNotBargeInCount`, candidate no-confirm counters, and source diagnostics are surfaced;
- raw assistant/user overlap can be high while confirmed overlap remains low;
- transcript stale guard keeps valid assistant transcript when no intent was confirmed;
- artifact/tool lifecycle diagnostics remain covered by existing focused tests.

## 6. Non-Goals Preserved

No skills or prompt behavior changed. This phase does not change memory, Builder, artifact schema, provider routing, crisis behavior, `users/**`, `backend/users/**`, `voice/sophia_llm.py`, or Vision Agents files.

## 7. Manual Smoke Plan

1. Start Gemini Live and ask for a medium-length answer.
2. Stay silent while the mic is open. Expected: raw frames may raise candidate counters, but audio continues and `bargeInConfirmationSource=none`.
3. Speak a clear new phrase over Sophia. Expected: provider input transcription can confirm intent after the assistant response has begun; already scheduled audio is not retroactively flushed unless Gemini interrupts.
4. Trigger a real provider interruption. Expected: playback flushes, old output is suppressed, and `bargeInConfirmationSource=provider_interruption`.
5. Ask for an artifact. Expected: `unresolvedToolCallCount=0`, `artifactCountMismatch=false`, and no `consult_skill` tool surface.

## 8. Bottom Line

12.6D-C changes the guard from activity-gated to intent-gated. Mic frames are not user intent; only provider interruption, explicit manual interruption, or conservative provider input transcription can make assistant output stale.