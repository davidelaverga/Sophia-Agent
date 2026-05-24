# Phase 12.6D - Gemini Barge-in / Stale Assistant Output Suppression

Date: 2026-05-24
Status: implemented on `fix/gemini-barge-in-stale-output-suppression-12-6d`
Source commit: pending

## 1. Why This Phase Exists

The 12.6C smoke showed Gemini/Sophia continuing, repeating, or leaking old assistant speech after the user started talking over the assistant. The key symptom was not just sparse captions: stale assistant text such as `Done and ready...` continued through later user turns, including a Spanish mode question.

This phase treats that as a realtime transport and ingestion continuity bug. It does not change baked emotional skills, crisis behavior, artifact schema, Builder, memory, provider routing, VAD tuning, or voice prompt files.

## 2. Latest Smoke Summary

The local telemetry export named in the prompt was not present in the worktree, so this reconstruction uses the supplied smoke facts.

Important facts:

- Gemini runtime stayed active while `assistantAudioActive=true` and `userInputActive=true` overlapped for a long stretch.
- Ordered relay backlog reached `maxOrderedRelayQueueDepth=105` and `oldestQueuedAgeMs=109707`.
- Transcript relay latency was extreme: last/max around `109931ms`, p95 around `106203ms`.
- Tool loop state showed `toolResponseCount=0`, `artifactToolCallCount=3`, `toolCancellationCount=2`, and `lastToolPhase=tool_response_send_suppressed`.
- Public assistant transcript kept extending a stale response after the user moved on, including through the Spanish turn.

## 3. Timeline Reconstruction

| Phase | Evidence | Interpretation |
|---|---|---|
| Assistant speaking | Gemini output audio/transcription active | Browser playback and backend relay were still carrying assistant output. |
| User barge-in | User input became active during assistant audio | Playback needed an immediate local fence, not just a later provider boundary. |
| Provider interruption | `serverContent.interrupted` / cancellations observed | Interruption was detected, but old output was not fully fenced across audio, transcript relay, and frontend ingestion. |
| Relay backlog | Queue depth/age and transcript latency exceeded 100s | Old provider output could arrive after newer user turns and still mutate public transcript. |
| Tool loop | Artifact calls cancelled/suppressed | Raw `emit_artifact` calls still were not public artifacts, preserving B4 reconciliation, but unresolved/cancelled tool state needed better diagnostics. |
| Later user turn | Spanish question arrived | Stale assistant transcript must not resurrect after a new user turn. |

## 4. Failure Classification

| Class | Status | Notes |
|---|---|---|
| Provider keeps generating after barge-in | Proven contributor | Gemini can continue emitting output until interruption/turn boundaries settle. |
| Playback flush incomplete | Proven contributor | `stop()` cleared active sources but had no playback generation fence or stale-output diagnostics. |
| Relay backlog leak | Proven contributor | Queue depth and transcript latency allowed old output to reach public surfaces much later. |
| Backend normalizer stale segment acceptance | Proven code gap | A higher source sequence for an interrupted response could still mutate transcript after the boundary. |
| Frontend ingestion stale acceptance | Proven code gap | The guard reset on interruption and remembered only highest source sequence, not interrupted response/segment identity. |
| Tool lifecycle unresolved loop | Contributor to diagnostics | Cancelled/suppressed artifact tool calls needed explicit unknown/unresolved counts; raw tool calls still must not count as public artifacts. |
| Prompt over-speaking | Not changed | This phase did not alter prompt policy; transport fixes were the narrower root-cause response. |

## 5. Fix Implemented

- Browser Gemini connector now tracks playback generations. `flushOutputAudio()` and provider interruption increment the generation, stop active scheduled PCM sources, and report generation-aware diagnostics.
- Browser Gemini connector now keeps a stale-output fence active after barge-in/interruption until a real generation or turn boundary. Stale assistant audio/transcript events are locally suppressed and diagnosed before they can be relayed or scheduled.
- Frontend assistant transcript ingestion now tracks the active response/segment key, interrupted keys, and latest user-input start time. It rejects interrupted segments and queued pre-barge-in transcript fragments instead of clearing the guard during interruption.
- `useStreamVoiceSession` now marks active assistant transcript as interrupted when user input or public user transcript arrives, and starts a new transcript generation on `agent_started`.
- `SophiaEventNormalizer` now closes the active assistant response when user input arrives and rejects later assistant transcript deltas/finals for closed responses, even when source sequence increases. An explicit new `RESPONSE_STARTED` may reopen a reused provider response id.

## 6. Diagnostics Added

- Gemini output audio diagnostics include `playbackGeneration` and `dropReason`.
- New `gemini-stale-output-suppressed` capture events report stale audio/transcript output type, reason, response id, provider sequence, relay correlation id, playback generation, and interrupted response ids.
- Runtime telemetry now reports stale assistant audio drops, stale assistant transcript drops, total stale-output suppressions, playback generation, interrupted response ids, assistant/user overlap duration, unresolved tool count, unknown artifact tool count, and oldest unresolved tool age.
- Telemetry report diagnostics include `geminiStaleOutput` warnings for stale output suppression, transcript relay backlog, assistant/user overlap, and unresolved Gemini tool calls.
- Turn-capture diagnostics now count stale assistant audio/transcript drops and expose max assistant/user overlap duration in assistant transcript evidence.

## 7. Tests

Focused tests added or updated:

- `frontend/src/__tests__/gemini-browser-live-websocket-dogfood.test.ts`
- `frontend/src/__tests__/hooks/voice-session-event-ingestion.test.ts`
- `frontend/src/__tests__/lib/voice-runtime-metrics.test.ts`
- `frontend/src/__tests__/lib/voice-telemetry-report.test.ts`
- `voice/tests/test_realtime_normalizer.py`

Validated focused slices:

- `pnpm vitest run src/__tests__/gemini-browser-live-websocket-dogfood.test.ts src/__tests__/hooks/voice-session-event-ingestion.test.ts src/__tests__/lib/voice-runtime-metrics.test.ts src/__tests__/lib/voice-telemetry-report.test.ts` - `60 passed`.
- `python -m pytest voice/tests/test_gemini_browser_dogfood.py voice/tests/test_gemini_live_provider_adapter.py voice/tests/test_realtime_normalizer.py voice/tests/test_sophia_prompt.py voice/tests/test_openai_browser_dogfood.py -q` - `101 passed`, with existing optional dependency/deprecation warnings.

## 8. Manual Smoke Plan

1. Start a Gemini Live Session and ask for a medium-length answer.
2. Speak over Sophia mid-answer. Expected: browser playback stops immediately; `gemini-interruption` and/or `gemini-stale-output-suppressed` appear; stale assistant transcript does not continue after the user's turn.
3. Ask a language switch question such as `¿Puedes responder en español?`. Expected: the old assistant response does not resurrect; the new response answers the Spanish turn.
4. Ask for a reflection artifact. Expected: public artifact count still comes from `sophia.artifact`, not raw `emit_artifact` calls; cancelled/suppressed tool calls show in diagnostics only.
5. Export telemetry. Expected: `diagnosticsSummary.geminiStaleOutput` flags any stale drops/backlog/overlap, and B4 artifact reconciliation remains stable.

## 9. Deferred Work

- Broaden Gemini stale-output dogfood to repeated manual runs before changing prompt stop policy or VAD/activity settings.
- Add provider-visible response/generation ids if Gemini exposes a stronger stable identity in future Live messages.
- Consider preserving interrupted assistant caption fragments as cancelled caption segments, separate from the live partial line.
- Investigate relay backlog reduction separately. This phase prevents stale leakage; it does not optimize relay throughput.

## 10. Bottom Line

Phase 12.6D adds stale-output fences at the three places that can leak old assistant behavior: browser PCM playback, public transcript ingestion, and backend normalization. It preserves the 12.6A/12.6C skill architecture and B4 artifact reconciliation while making future barge-in smokes diagnosable instead of ambiguous.

## 11. Phase 12.6D-B Sensitivity Hotfix

The integrated-branch smoke after 12.6D showed that stale-output suppression was too aggressive. The supplied telemetry for `sophia-voice-telemetry-report-2026-05-24T03-51-15-905Z.json` had healthy tool/artifact lifecycle (`toolCallCount=3`, `toolResponseCount=3`, `unresolvedToolCallCount=0`, `artifactCountMismatch=false`) but unhealthy playback (`assistantUserOverlapMs=23583`, `maxAssistantUserOverlapMs=23583`, and `staleAssistantOutputSuppressionCount=30`).

12.6D-B keeps the stale repetition fix but changes the local browser guard so raw `input_audio_frame_sent` diagnostics are only candidates. A single residual mic frame during assistant playback no longer stops PCM playback, arms stale-output suppression, or interrupts the assistant transcript guard. Suppression is armed only after provider interruption, explicit playback flush, provider input transcription, or sustained input audio over a short confirmation threshold.

New diagnostics distinguish candidate vs confirmed state: `userInputActiveAgeMs`, `bargeInConfirmed`, `bargeInCandidateFrameCount`, `suppressionDeferredReason`, `staleSuppressionArmedAt`, `staleSuppressionArmedBy`, `assistantAudioDropReason`, and `inputFrameOnlyNotBargeInCount`. Unconfirmed candidates decay when frames stop, and assistant/user overlap closes once playback is flushed so it cannot keep aging after audio has stopped.

Full hotfix report: `docs/audits/gemini-barge-in-guard-sensitivity-hotfix-phase-12-6d-b.md`.

## 12. Phase 12.6D-C Intent-Gated Confirmation

The follow-up integrated smoke after 12.6D-B still cut Sophia off after one word. Gemini produced a full answer (`modelTurnAudio=200`, `outputTranscription=74`), but the browser stale-output guard suppressed valid chunks (`staleAssistantAudioDroppedCount=148`, `staleAssistantTranscriptDroppedCount=59`, `staleAssistantOutputSuppressionCount=207`). `inputFrameOnlyNotBargeInCount=0` showed that incidental frames were not staying benign.

12.6D-C keeps the stale repetition fix but removes raw-frame confirmation. `input_audio_frame_sent` can update candidate counters and raw mic overlap, but it cannot increment playback generation, arm stale suppression, drop assistant output, or interrupt transcript state. Confirmation now requires provider interruption, explicit manual/local interrupt, or conservative provider input transcription with real text after assistant output has begun. Provider input transcription fences future old-generation chunks without retroactively flushing already scheduled audio; provider interruption remains the strong immediate flush path.

New diagnostics include `bargeInConfirmationSource`, `bargeInConfirmationReason`, `candidateFramesDidNotConfirmCount`, `candidateExpiredCount`, `suppressionBlockedBecauseNoIntentCount`, `staleSuppressionArmedBy`, `rawAssistantUserOverlapMs`, and `confirmedAssistantUserOverlapMs`.

Full follow-up report: `docs/audits/gemini-barge-in-intent-gated-confirmation-phase-12-6d-c.md`.

## 13. Phase 12.6D-D Transcript Handoff

The next integrated smoke showed that 12.6D-C fixed cutoff/over-suppression but left a provider-visible turn handoff gap. Gemini could emit real `serverContent.inputTranscription` for the barge-in and the UI could eventually receive `sophia.user_transcript`, but the native Gemini conversation did not reliably answer that text unless the user repeated it.

12.6D-D promotes confirmed, non-empty barge-in input transcription into the current user turn and dispatches the same text over the active Gemini Live WebSocket as a native text turn. It dedupes repeated provider frames and later public `sophia.user_transcript` echoes, preserves stale assistant tail suppression, and keeps raw mic frames from creating fake handoffs.

New diagnostics include barge-in transcript captured/promoted/ignored/duplicate counts, promotion latency, new-turn dispatch count, and dispatch blocked reason. Gateway relay routes now forward browser source-order metadata to the voice runtime.

Full follow-up report: `docs/audits/gemini-barge-in-transcript-handoff-phase-12-6d-d.md`.