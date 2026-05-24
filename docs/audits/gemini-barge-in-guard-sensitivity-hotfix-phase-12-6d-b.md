# Phase 12.6D-B - Gemini Barge-in Guard Sensitivity Hotfix

Date: 2026-05-24
Status: implemented on `integrate/realtime-voice-main`
Source commit: pending

## 1. Why This Hotfix Exists

Phase 12.6D fixed stale Gemini assistant output leaking across interrupted turns, but the first integrated local smoke exposed a new regression: Sophia audio could be cut off after about one word.

The supplied telemetry report was `sophia-voice-telemetry-report-2026-05-24T03-51-15-905Z.json`. The key signal was that artifact/tool lifecycle had recovered while playback regressed:

- `runtime=gemini_live`
- `outputAudioEventCount=71`
- `modelTurnAudio count=87`
- `outputTranscription count=29`
- `staleAssistantAudioDroppedCount=14/16` depending summary section
- `staleAssistantTranscriptDroppedCount=16`
- `staleAssistantOutputSuppressionCount=30`
- `assistantUserOverlapMs=23583`
- `maxAssistantUserOverlapMs=23583`
- warnings included `stale_assistant_output_suppressed` and `assistant_audio_overlapped_user_input`
- `interruptionCount=3`, `playbackFlushCount=3`
- `toolCallCount=3`, `toolResponseCount=3`, `unresolvedToolCallCount=0`
- `artifactCountMismatch=false`

The interpretation is that tool responses, artifact calls, and B4 artifact reconciliation are healthy. The regression was guard sensitivity: raw mic frames during assistant playback were treated as confirmed barge-in and immediately armed stale-output suppression.

## 2. Root Cause

The browser Gemini connector treated every `input_audio_frame_sent` diagnostic while assistant playback was pending as user barge-in. That did three things too early:

1. Armed `staleOutputSuppressionActive`.
2. Stopped the current Web Audio playback generation.
3. Let assistant/user overlap age remain active until a later boundary or interruption.

The React session hook also interpreted the same raw input-frame diagnostic as user input for assistant transcript interruption. A single residual mic frame could therefore make valid assistant audio and transcript fragments look stale before Gemini had confirmed real interruption, sustained speech, or a new user transcript.

That explains the 23.5s overlap: the local guard started counting at the first raw frame and did not decay the unconfirmed state when frames stopped.

## 3. Runtime Behavior Changed

12.6D-B splits the guard into candidate and confirmed states.

- A raw `input_audio_frame_sent` during assistant playback is now only a barge-in candidate.
- One incidental frame does not stop playback, arm stale suppression, or interrupt the assistant transcript guard.
- Candidate state must be confirmed by one of:
  - provider `serverContent.interrupted`;
  - explicit `flushOutputAudio()` / soft barge-in playback flush;
  - provider input transcription while assistant audio is pending;
  - sustained input audio meeting a short frame/duration threshold.
- Unconfirmed candidates decay when no recent frames arrive.
- Confirmed interruptions still stop playback, increment playback generation, and keep stale-output suppression active for old output.
- Assistant/user overlap measurement closes when playback is flushed so the age cannot run for tens of seconds after audio has stopped.

This preserves the 12.6D stale-output benefit while preventing residual mic frames from cutting off valid assistant speech.

## 4. Diagnostics Added

Input-audio and stale-output diagnostics now distinguish candidate vs confirmed state:

- `userInputActiveAgeMs`
- `bargeInConfirmed`
- `bargeInCandidateFrameCount`
- `suppressionDeferredReason`
- `staleSuppressionArmedAt`
- `staleSuppressionArmedBy`
- `assistantAudioDropReason`
- `inputFrameOnlyNotBargeInCount`

Runtime metrics and telemetry exports surface the same distinction so a future smoke can tell apart harmless mic-frame noise from confirmed barge-in suppression.

## 5. Tests Updated

Focused coverage now includes:

- a single incidental input audio frame during assistant speech does not stop or drop assistant audio;
- sustained input audio confirms barge-in and suppresses stale assistant audio;
- provider interruption still flushes playback and increments generation;
- unconfirmed input-frame candidates decay when frames stop;
- interrupted assistant transcript segments remain rejected;
- artifact tool responses and B4 artifact count reconciliation remain covered by existing focused tests;
- `consult_skill` remains absent in the existing voice prompt/provider tests.

## 6. Non-Goals Preserved

This hotfix does not change skills, prompt behavior, memory, Builder, artifact schema, provider routing, crisis behavior, `users/**`, `backend/users/**`, `voice/sophia_llm.py`, or Vision Agents files.

## 7. Manual Smoke Plan

1. Start a Gemini Live Session and ask for a medium-length spoken answer.
2. Stay silent while the mic is open. Expected: no one-word cutoff; incidental frames may log `suppressionDeferredReason=input_frame_only_not_barge_in` but audio continues.
3. Make a real barge-in mid-answer. Expected: playback stops quickly; `bargeInConfirmed=true`; stale old audio/transcript is suppressed.
4. Ask a follow-up after interruption. Expected: old `Done and ready...` style tails do not mutate the new turn.
5. Ask for an artifact. Expected: tool responses complete, `unresolvedToolCallCount=0`, and `artifactCountMismatch=false`.

## 8. Bottom Line

12.6D-B keeps stale-output suppression but requires confirmed barge-in before dropping Gemini audio. Input audio frames alone are not enough to classify assistant output as stale.