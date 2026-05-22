# Gemini Production Route Integration Audit - Phase 12.0

Date: 2026-05-19
Status: implemented as default-off production-route candidate; validation pending live smoke

## Objective

Begin moving Sophia's live voice runtime toward Gemini Live without removing rollback safety. The production route now has an explicit selector path:

`/voice/connect -> runtime flag -> legacy_cascade OR gemini_live -> production Gemini bootstrap when enabled -> rollback to legacy cascade when disabled`

## Guardrails

- Legacy remains the default when `SOPHIA_VOICE_RUNTIME_MODE` is unset or `legacy_cascade`.
- Gemini production route requires `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true`, and `GOOGLE_API_KEY` or `GEMINI_API_KEY` on the trusted voice service.
- Missing Gemini promotion/config fails closed. The gateway does not silently fall back to Stream after Gemini is explicitly selected.
- Legacy auto-preconnect is marked with `preconnect: true` and rejected for Gemini so a browser Live session is not created before user intent.
- The browser receives only a backend-minted ephemeral Gemini token; provider API keys stay server-side.

## Implementation Summary

- Voice service added `GeminiProductionBrowserSessionManager` in `voice/realtime/gemini_production_session.py`, wrapping the proven Gemini browser dogfood manager behind the new production promotion flag.
- Voice service added `/production/realtime/gemini/browser-sessions`, `/provider-events`, `/sessions/{id}/events`, and disconnect routes.
- Gateway `/api/sophia/{user_id}/voice/connect` now branches on `SOPHIA_VOICE_RUNTIME_MODE`: legacy Stream response by default, Gemini bootstrap only when the production flag is enabled.
- Gateway added authenticated production Gemini relay/events/disconnect routes under `/api/sophia/{user_id}/voice/gemini/*`.
- Next added stable browser aliases under `/api/sophia/voice/gemini/*`.
- Frontend production hook keeps `useStreamVoiceSession` as the public hook but branches after `/voice/connect` returns `runtime: "gemini_live"`, using `connectGeminiBrowserLiveFromBootstrap` for browser-owned Gemini WSS.

## Test Coverage Added

- Voice config: production promotion flag parses and does not promote the runtime by itself.
- Voice service: production Gemini validation requires the promotion flag; production wrapper returns production URL metadata.
- Gateway: legacy default unchanged; Gemini selected without promotion fails closed; Gemini preconnect rejected; promoted Gemini returns production bootstrap and does not dispatch legacy Stream/Vision Agents.
- Frontend API: stable production Gemini relay/events/disconnect aliases proxy through the authenticated user.
- Frontend connector: production bootstrap uses production relay and disconnect aliases.
- Frontend hook: Gemini `/voice/connect` payload skips Stream join and opens the Gemini browser connector.

## Remaining Gaps

- Live production UI smoke still needs to be run with real Gemini credentials.
- Tool live evidence through the production route should prove `emit_artifact` and `start_builder_task` at minimum.
- Mobile/iOS microphone permission and backgrounding behavior remains unproven for the Gemini production candidate.
- Telemetry parity is partial; the normalized `sophia.*` boundary is shared, but Stream-specific readiness/warmup metrics do not map one-to-one.

## Rollback

Set either:

```powershell
$env:SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED = "false"
```

or:

```powershell
$env:SOPHIA_VOICE_RUNTIME_MODE = "legacy_cascade"
```

Then restart the affected services. The production `/voice/connect` route will return the legacy Stream payload again.