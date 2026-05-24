# Session Telemetry Runtime Awareness - Phase 12.1

Date: 2026-05-19
Scope: Real Session UI telemetry panel for `legacy_cascade` and `gemini_live` production voice paths.

## Objective

Make the Session telemetry panel identify the selected runtime and show metrics that are true for that runtime. Legacy Stream/Vision Agents cascade metrics must remain available for legacy sessions. Gemini production sessions must not be labeled with Stream join, remote participant, backend-done, or TTS/playback assumptions unless equivalent provider-neutral evidence exists.

## Implementation Notes

- `useStreamVoiceSession` now exposes `runtime` and `runtimeTelemetry` on the voice state returned to Session UI consumers.
- Legacy credentials are represented as `legacy_cascade` and keep the existing capture path.
- Gemini credentials are represented as `gemini_live` immediately after `/voice/connect` returns the production bootstrap.
- Gemini production callbacks feed telemetry for stage, setup completion, public SSE state, relay status/diagnostics, WebSocket diagnostics, provider-event count, output audio, and tool-loop events.
- `voice-runtime-metrics` now derives a `sessionTelemetry` runtime union, preferring hook state and falling back to capture events.
- `VoiceMetricsPanel` renders a runtime badge and branches its expanded view: legacy keeps the existing cascade cards; Gemini renders Gemini WSS, relay, provider event, tool-loop, artifact, microphone, and public diagnostic cards.
- The panel is mounted in the real Session page instead of being guarded by `false &&`.

## Guardrails

- Runtime identity comes from the actual session bootstrap/capture path, not frontend runtime-mode env inference.
- The public browser event contract remains normalized `sophia.*` events only.
- Gemini-specific provider information is summarized as status/count metadata; the panel does not display raw provider frames.
- Existing legacy latency and regression calculations remain available to legacy sessions.

## Test Coverage

- Metrics tests cover legacy runtime identity and Gemini production telemetry derivation.
- Hook tests cover legacy runtime exposure, Gemini runtime exposure, and Gemini callback telemetry updates.
- Panel tests cover runtime labels and verify Gemini rendering hides legacy-only latency/pipeline labels.

## Follow-Up Checks

- Manual dogfood should verify the panel's floating placement does not obscure normal Session controls on the target production viewport.
- Live Gemini dogfood should confirm relay degradation and public SSE errors are visually distinguishable from provider WSS failure.