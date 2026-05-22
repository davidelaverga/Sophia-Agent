# Phase 12.4F - Gemini Output Transcript Assembly Correctness

Date: 2026-05-20
Status: implemented, targeted validation passed
Scope: assistant transcript accumulation, duplicated/overlapped phrase prevention, and turn-boundary buffer hygiene for the Gemini production route.

## Constraints

- Do not broaden into Builder output access.
- Do not make Gemini the default runtime.
- Do not rewrite Sophia's prompt.
- Do not revisit relay-backpressure work except for tiny adjacent transcript correctness.

Gemini still requires the explicit production gates: `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true`, and backend Google/Gemini credentials.

## Observed Symptom

Control conversation:

- Assistant opening: `I'm here with you. What's on your mind?`
- User: `Hi Sophia, can you hear me clearly?`
- Malformed assistant transcript: `hearYeah, I you. What's good? Anything you're getting ready for?Yeah, I can hear What are you fine. you getting ready for?`

The failure shape points to backend transcript assembly corruption: joined word boundaries, duplicated phrases, and revised partials pasted beside older partials.

## Breakpoint Map

The production Gemini assistant transcript path is:

`serverContent.outputTranscription -> browser relay -> GeminiLiveEventMapper -> ProviderEvent.ASSISTANT_TEXT_DELTA -> SophiaEventNormalizer -> sophia.transcript -> useStreamVoiceSession -> voice-session-event-ingestion -> Session assistant message bridge`

The browser connector relays `outputTranscription` messages but does not assemble assistant transcript text. The frontend ingestion path already treats public `sophia.transcript.data.text` as a replaceable snapshot: partials update `partialReply`, Gemini partials may be paced, finals flush exact text, and `appendVoiceAssistantMessage` replaces the active voice assistant message.

The backend/public boundary was the bug source. Gemini output transcription text was mapped with `is_delta: true`; `SophiaEventNormalizer` therefore appended every incoming chunk by default. Google documents `outputAudioTranscription` / `serverContent.outputTranscription` as model output transcription and notes transcription can be sent independently from other server messages, but the docs do not guarantee that `text` is an append-only delta.

## Contract Decision

Public `sophia.transcript` remains a frontend snapshot contract:

- `data.text` is the full current assistant transcript for the active response/segment at that moment.
- `is_final: false` is a replaceable partial snapshot.
- `is_final: true` replaces/finalizes the last partial.
- UI reducers must replace active assistant text, not append public transcript payloads together.

Provider-specific ambiguity is resolved before public emission. Segment ids used to isolate Gemini tool-adjacent continuations are internal normalizer metadata and are not part of the public payload.

## Fix

- `voice/realtime/gemini_live.py` now marks Gemini `output_transcription` assistant text events with `transcript_assembly: "auto"`, `is_delta: false`, and an internal segment id.
- Plain Gemini `serverContent.modelTurn.parts[].text` remains a normal explicit-delta path.
- `SophiaEventNormalizer` now supports auto assembly for unknown transcript chunk semantics:
  - replace when the incoming chunk is a cumulative superset,
  - keep existing text when the incoming chunk is a duplicate/subset,
  - merge suffix/prefix overlap,
  - replace likely revised snapshots,
  - append true fragments with safe whitespace boundaries.
- Interruption and cancellation clear assistant transcript buffers for the active response.
- Response end clears the active segment pointer.
- Tool-call-adjacent Gemini continuations advance the internal segment so post-tool transcript text does not inherit pre-tool partial state.

## Fixtures

Backend fixtures cover:

- Fragment appends with whitespace-safe boundaries, preventing `hearYeah` and `you.What's` joins.
- Cumulative snapshots, preventing repeated `Yeah, I hearYeah...` style growth.
- Revised snapshots, replacing `Yeah, I hear you.` with `Yeah, I can hear you fine.`.
- Tool-call continuation segmentation, keeping `Let me check that.` separate from `Here's what I found.`.
- Interruption reset, so a new response after interruption does not inherit stale partial text.
- Browser relay propagation through the existing Gemini adapter and normalizer path.

Frontend fixtures cover:

- Public assistant partials as replaceable snapshots in `voice-session-event-ingestion`.
- Session voice assistant messages replacing the active assistant message instead of appending cumulative snapshots.
- Existing Gemini pacing behavior, including exact final flush.

## Validation

Passed:

- `$env:PYTHONPATH = $PWD; pytest voice/tests/test_gemini_live_provider_adapter.py voice/tests/test_realtime_normalizer.py voice/tests/test_gemini_browser_dogfood.py voice/tests/test_realtime_dogfood_session.py -q` -> 58 passed, 5 warnings.
- `cd frontend; pnpm vitest run src/__tests__/hooks/voice-session-event-ingestion.test.ts src/__tests__/session/useSessionVoiceMessages.test.ts src/__tests__/gemini-browser-live-websocket-dogfood.test.ts src/__tests__/lib/voice-runtime-metrics.test.ts` -> 42 passed.

Additional validation still recommended before merge:

- `cd frontend; pnpm typecheck`
- `cd frontend; pnpm lint`
- Python compile/lint checks for touched voice files.
- `git diff --check`

## Manual Smoke Checklist

1. Start the app with Gemini production gates enabled.
2. In `/session`, start a Gemini voice turn and ask: `Hi Sophia, can you hear me clearly?`
3. Verify the visible assistant transcript has clean word boundaries and does not duplicate or interleave old phrases.
4. Interrupt Sophia mid-answer and verify the next assistant answer does not inherit stale transcript text.
5. Trigger a tool-adjacent companion turn and verify post-tool speech does not merge with pre-tool transcript text.
6. Export voice telemetry and verify public transcript counts still come from actual `sophia.transcript` events.

## Caveats

The auto assembler is conservative. If Gemini sends two unrelated fragments in the same response segment with no overlap and no revision signature, the normalizer appends them with a safe boundary. Segment advancement is currently tied to observed text before a tool call; if a future provider flow emits multiple post-tool text segments without a tool boundary, additional provider-specific segment evidence may be needed.