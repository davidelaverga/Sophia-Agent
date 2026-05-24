# Phase 12.6D-D - Gemini Barge-in Transcript Handoff

Date: 2026-05-24
Status: implemented on `integrate/realtime-voice-main`
Source commit: pending

## 1. Why This Phase Exists

Phase 12.6D-C stopped the over-aggressive cutoff bug by requiring real intent before stale-output suppression. The next manual smoke showed a narrower remaining failure: when the user barged in and Gemini emitted a real `serverContent.inputTranscription`, the browser and backend could observe the text, but the current Gemini conversation did not reliably answer that new turn unless the user repeated it.

The goal here is not to restart the legacy text companion cascade. Gemini Live remains the native provider path. The captured provider input transcription is promoted into the same browser-owned Gemini Live WebSocket as a text turn, while stale assistant tails remain fenced.

## 2. Root Cause

The stack already had most of the public observability path:

- Gemini browser relay classified `inputTranscription` as critical and relayed it.
- `voice/realtime/gemini_live.py` mapped it to `USER_TRANSCRIPT_FINAL`.
- `SophiaEventNormalizer` emitted `sophia.user_transcript` and `sophia.turn` `user_ended`.
- `useStreamVoiceSession` consumed public `sophia.user_transcript` as a visible user turn.

The missing piece was provider-visible handoff. Public `sophia.*` events update UI and diagnostics; they are not automatically model-visible context in Gemini Live. After a confirmed barge-in, the browser needed to take the provider's own finalized input transcription and send it back through the active Gemini Live conversation exactly once.

The gateway also dropped browser relay ordering metadata before forwarding to the voice runtime. That weakened backend source-order handling for exactly the events used to prove transcript continuity.

## 3. Runtime Behavior Changed

- Confirmed barge-in `inputTranscription` with non-empty text is captured as a handoff candidate.
- The browser promotes the captured text into the current visible user turn immediately.
- The browser sends `{ realtimeInput: { text } }` over the existing Gemini Live WebSocket so Gemini can answer without requiring a repeated utterance.
- Promotion is deduped by normalized text and by the current barge-in fence, so repeated provider frames do not create duplicate user turns.
- Later public `sophia.user_transcript` echoes for the same promoted text are ignored once and consumed as duplicates, preventing visible double insertion.
- Raw input audio frames without provider transcription do not fabricate a handoff.
- Stale assistant audio/transcript suppression remains active for old assistant tails and is not relaxed by this phase.
- Gateway Gemini relay routes now preserve browser source metadata: provider receive sequence, relay sequence, provider receive timestamp, relay correlation id, primary category, and categories.

## 4. Diagnostics Added

New browser/session/report diagnostics include:

- `bargeInTranscriptCapturedCount`
- `bargeInTranscriptPromotedCount`
- `bargeInTranscriptPromotionLatencyMs`
- `bargeInTranscriptIgnoredCount`
- `bargeInTranscriptDuplicateSuppressedCount`
- `lastBargeInTranscriptPreview`
- `bargeInNewTurnDispatchCount`
- `bargeInNewTurnDispatchBlockedReason`

Turn-capture diagnostics now count barge-in transcript capture, promotion, and new-turn dispatch separately from generic provider input transcription and public user transcript counts. This distinguishes three cases:

- interrupted but no provider input transcript;
- provider input transcript observed but not promoted;
- provider input transcript promoted and dispatched as a Gemini turn.

## 5. Tests Updated

Focused coverage now verifies:

- provider input transcription after confirmed barge-in is promoted to a native Gemini text turn;
- duplicate provider transcription frames are suppressed;
- raw microphone frames do not create fake transcript handoffs;
- local promoted user turns suppress later duplicate public echoes;
- metrics, telemetry exports, turn-capture diagnostics, and the visible metrics panel include handoff counters;
- gateway dogfood and production Gemini relay routes preserve browser source metadata;
- the Gemini tool surface remains existing-tool-only and does not add `consult_skill`.

## 6. Non-Goals Preserved

This phase does not change prompts, skills, crisis behavior, memory behavior, Builder behavior, artifact schema, VAD/activity settings, provider routing defaults, `voice/sophia_llm.py`, `users/**`, `backend/users/**`, or the legacy Stream/Vision Agents cascade.

## 7. Manual Smoke Plan

1. Start a Gemini Live Session and ask for a medium-length answer.
2. Barge in with a clear phrase while Sophia is speaking.
3. Expected: telemetry shows `bargeInTranscriptCapturedCount=1`, `bargeInTranscriptPromotedCount=1`, and `bargeInNewTurnDispatchCount=1`.
4. Expected: the visible user turn appears once, even if public `sophia.user_transcript` later echoes the same provider text.
5. Expected: Gemini answers the interrupted phrase without requiring the user to repeat it.
6. Expected: old assistant tails remain suppressed and do not overwrite the new user turn.

## 8. Bottom Line

12.6D-D closes the handoff gap: a confirmed Gemini barge-in transcript is now both UI-visible and provider-visible, while duplicate and stale assistant-output guards remain in place.