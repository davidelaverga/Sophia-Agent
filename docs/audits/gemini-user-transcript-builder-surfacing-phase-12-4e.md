# Phase 12.4E - Gemini User Transcript Continuity And Builder State Surfacing

Date: 2026-05-20
Status: implemented, targeted validation passed
Scope: user transcript continuity, builder state surfacing, and truthful telemetry classification for the Gemini production route.

## Constraints

- Do not broaden scope.
- Do not rewrite prompts.
- Do not revisit solved relay-throughput work except for adjacent correctness.
- Do not make Gemini the default production runtime.

Gemini still requires the explicit production gates: `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true`, and backend Google/Gemini credentials.

## Control Evidence

The user-provided telemetry facts from `sophia-voice-telemetry-report-2026-05-20T04-43-50-974Z.json` were treated as the control source:

- `runtime = gemini_live`
- `inputTranscription.count = 12`
- `counts.userTranscripts = 0`
- `lastUserTranscriptAt = null`
- `lastTurn.lastUserTranscript = null`
- `builderToolCallCount = 3`
- Gemini tool ledger included `start_builder_task` and `check_async_task`
- `counts.builderEvents = 0`

The exact JSON file was not present in the local workspace, Downloads, Desktop, or Documents, so this audit records the prompt-supplied facts instead of quoting local file contents.

## Breakpoints

### User transcript

The nominal path already existed:

`Gemini WSS inputTranscription -> browser relay -> GeminiLiveEventMapper -> ProviderEvent.USER_TRANSCRIPT_FINAL -> SophiaEventNormalizer -> sophia.user_transcript -> Session hook -> telemetry counts`

Two narrow gaps explained the control evidence:

- The browser and backend categorizer can count `inputTranscription` by key presence even when the mapper does not extract text. The mapper previously accepted only mapping payloads with `text`; Phase 12.4E accepts `text`, `transcript`, and string transcription values.
- `RealtimeDogfoodSession` retained normalized public payload history but `subscribe()` only delivered future events. Gemini production starts WSS/microphone work before the React EventSource is necessarily attached, and reconnects can also miss already-emitted durable state. Phase 12.4E replays only `sophia.user_transcript` and `sophia.builder_task` to late subscribers.

### Builder state

Successful Gemini builder lifecycle execution already produced trusted task ids in backend responses, and Phase 12.3 had the public publisher path:

`Gemini toolCall -> backend lifecycle executor -> builder task payload -> ProviderEvent.BUILDER_TASK_PAYLOAD -> SophiaEventNormalizer -> sophia.builder_task -> Session builder UI/telemetry`

The missing state was not a React card issue by default. The Session UI parses and renders `sophia.builder_task` payloads; the observed zero `builderEvents` means no public builder task event reached current-run Session capture. Durable replay now covers late subscribers for trusted builder lifecycle state. Builder artifact storage and downloads were not changed.

### Telemetry diagnosis

The previous health heuristic classified local microphone audio plus zero public transcripts as a microphone bottleneck. That is still true for legacy/no-provider-transcript runs. For Gemini, provider `inputTranscription > 0` with `sophia.user_transcript = 0` is now classified as a public continuity/transport gap. Counts remain actual public event counts; no optimistic public counters were added.

## Files Changed

- `voice/realtime/gemini_live.py` - accepts Gemini input transcription aliases and string payloads.
- `voice/realtime/dogfood_session.py` - replays durable public state events to late subscribers.
- `frontend/src/app/lib/voice-runtime-metrics.ts` - distinguishes provider/public transcript gaps from microphone capture failures.
- `voice/tests/test_gemini_live_provider_adapter.py` - transcript shape coverage.
- `voice/tests/test_realtime_dogfood_session.py` - late subscriber user transcript replay coverage.
- `voice/tests/test_gemini_browser_dogfood.py` - late subscriber builder task replay coverage.
- `frontend/src/__tests__/lib/voice-runtime-metrics.test.ts` - Gemini provider/public continuity diagnosis coverage.
- Runtime docs, common pitfalls, compound log, and this audit.

## Validation

Passed:

- `$env:PYTHONPATH = (Get-Location).Path; pytest voice/tests/test_gemini_live_provider_adapter.py voice/tests/test_realtime_dogfood_session.py voice/tests/test_gemini_browser_dogfood.py`
- `cd frontend; pnpm vitest run src/__tests__/lib/voice-runtime-metrics.test.ts src/__tests__/session/stream-contract-adapters.test.ts`
- `cd frontend; pnpm typecheck`
- `cd frontend; pnpm lint` with existing warnings only
- `$env:PYTHONPATH = (Get-Location).Path; python -m compileall -q voice/realtime/gemini_live.py voice/realtime/dogfood_session.py`

Not completed:

- `frontend/src/__tests__/hooks/useStreamVoiceSession.test.ts` could not be used as validation locally because Vitest hit `JS heap out of memory` even when run by test name with increased heap. No hook test addition was kept from this phase.

## Manual Smoke Checklist

1. Start the app with the Gemini production gates enabled.
2. In `/session`, start a Gemini voice turn and speak one short utterance.
3. Export voice telemetry and verify `sessionTelemetry.gemini.providerCategoryCounts.inputTranscription.count > 0` and `counts.userTranscripts > 0`.
4. Verify `lastTurn.lastUserTranscript` and `lastTurn.lastUserTranscriptAt` are non-null.
5. Ask Sophia to start a small builder task, then ask for status.
6. Verify the Session builder notice appears and telemetry has `counts.builderEvents > 0` with a non-null builder task id/phase.
7. Confirm the report still says `runtime = gemini_live` only under explicit gates; default production remains legacy cascade.

## Next Phase Suggestion

Phase 12.4F should be a live dogfood verification phase, not another code-broadening phase: capture one fresh current-run telemetry export after this fix and compare provider category counts, backend mapper output counts, public `sophia.user_transcript`, public `sophia.builder_task`, and Session UI state from the same run.