# Sophia OpenAI Browser WebRTC Dogfood - Phase 8A

Date: 2026-05-17
Status: internal dogfood path only. Production voice remains `legacy_cascade`.

## What This Tests

Phase 8A proves the real browser media path for OpenAI Realtime while preserving Sophia's provider-neutral public event boundary:

`Browser microphone/speaker -> OpenAI Realtime WebRTC -> Sophia backend sideband -> OpenAI adapter -> ProviderEvent -> SophiaEventNormalizer -> public sophia.* SSE`

This is not the production `/voice/connect` path. Stream/Vision Agents, Deepgram, Cartesia, SmartTurn, `SophiaLLM`, and `ConversationFlowCoordinator` remain the default browser voice runtime.

## Required Environment

Enable all gates only in a local dogfood shell:

```powershell
$env:SOPHIA_VOICE_RUNTIME_MODE = "openai_realtime"
$env:SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED = "true"
$env:SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED = "true"
$env:SOPHIA_OPENAI_REALTIME_MODEL = "gpt-realtime-2"
$env:OPENAI_API_KEY = "sk-..."
```

Also keep the normal voice service requirements available, especially `STREAM_API_KEY` and `STREAM_API_SECRET`, because the voice server still validates shared runtime settings.

Do not set `OPENAI_API_KEY` in `NEXT_PUBLIC_*` variables, browser code, or frontend env files. The browser receives only the ephemeral `client_secret.value` minted by the backend.

## Start Services

From the repository root:

```powershell
.\scripts\start-all.ps1
```

Or use the workspace task `Start Sophia App` / `Launch Sophia Dev` if that is your normal local path.

## Preferred UI Test Path

For normal product dogfooding, use the internal page instead of replaying the low-level API sequence by hand.

Route:

```text
http://localhost:3000/debug/realtime/openai
```

Recommended flow:

1. Start the app with the OpenAI experimental runtime env enabled.
2. Sign into Sophia in the browser, or use the local dev auth bypass if that is your standard setup.
3. Open `/debug/realtime/openai`.
4. Confirm the preflight card shows an authenticated Sophia user id.
5. Click `Connect`.
6. Grant microphone permission when the browser prompts.
7. Speak a short first turn such as `Hola Sophia, me escuchas?`

Success looks like:

- Connection status reaches `Connected`.
- A dogfood `session_id` is shown on the page.
- An OpenAI `rtc_*` call id is shown after SDP exchange.
- Sideband attach shows `Attached`.
- Public SSE reaches `Connected`.
- The event log shows only `sophia.*` event types.
- Remote audio moves from `Expected` to `Active` once browser playback begins.

The page also surfaces common conflict errors cleanly, including missing experimental-runtime flags or missing `OPENAI_API_KEY` on the trusted backend.

## Degraded Audio-Only Mode

Phase 10.9 deliberately decouples browser WebRTC success from backend sideband success.

If the page reaches all of these conditions:

- browser WebRTC connected
- OpenAI `rtc_*` call id captured
- microphone and remote transport remain live
- backend sideband attach still fails

then the page must stay usable in explicit degraded mode instead of disconnecting the call.

Expected degraded signals on `/debug/realtime/openai`:

- `Connection: Connected`
- `Mode: Degraded audio-only`
- `Sideband attach: Failed`
- `Public SSE: Unavailable`
- a visible `Retry Sideband Attach` action

Meaning:

- You can continue speaking directly with OpenAI Realtime for audio dogfood.
- Sophia backend-controlled observation is not healthy yet.
- Normalized `sophia.*` SSE should not be claimed as healthy while sideband remains detached.

This mode is internal-only diagnostic behavior. It is not a production fallback and it does not mean OpenAI backend control is working.

## Troubleshooting `Failed to fetch`

- Browser OpenAI dogfood requires the frontend `Content-Security-Policy` `connect-src` to allow `https://api.openai.com`, because the SDP offer is posted directly from the browser to `https://api.openai.com/v1/realtime/calls`.
- If `/debug/realtime/openai` shows `Connection error` or `Failed to fetch`, inspect the browser console and Network panel for a CSP block on `POST https://api.openai.com/v1/realtime/calls` before assuming the client-secret mint, provider auth, or sideband attach failed.
- A failed browser connect may still trigger `/voice/dogfood/openai/disconnect` cleanup for the partially started dogfood session. That cleanup should be safe even when sideband attach never completed.

The manual PowerShell and API flow below still matters for lower-level debugging, especially when you need to inspect raw HTTP failures, malformed `Location` headers, sideband attach problems, or SSE behavior outside the page.

## Current Sideband Isolation Procedure

Phase 10.3 keeps this as a diagnostic isolation step, not a runtime redesign. The official OpenAI WebRTC and server-side controls docs describe this sequence:

- Browser posts SDP to `https://api.openai.com/v1/realtime/calls`.
- The SDP response includes a `Location` header such as `/v1/realtime/calls/rtc_...`.
- The backend extracts the `rtc_*` call id from that header.
- A trusted server opens `wss://api.openai.com/v1/realtime?call_id=rtc_...` with the standard `OPENAI_API_KEY`.

When `/debug/realtime/openai` reaches WebRTC readiness but sideband attach still returns 404, capture these fields from the page's Transport details and from `logs/voice.log`:

- `requested_model`
- `sdp_status`
- `raw_location`
- `extracted_call_id`
- `location_matches_documented_shape`
- `call_id_matches_documented_shape`
- `unexpected_location_variant`
- `webrtc_readiness`
- sideband failure `status`, `request_id`, `elapsed_ms`, and `url`

Do not redact the short-lived `rtc_*` id in local dogfood notes. Do not log or paste `OPENAI_API_KEY` or ephemeral client-secret values.

After capturing the call id, run the isolated conformance probe from the repo root in the same voice Python environment:

```powershell
$env:OPENAI_API_KEY = "sk-..."
python -m voice.realtime.openai_sideband_probe rtc_... --timeout-seconds 10
```

The probe does not start Sophia, does not open SSE, and does not alter production runtime behavior. It attempts only the documented sideband URL with the documented server-side `Authorization` header and prints JSON with `ok`, `status_code`, `request_id`, `elapsed_ms`, and the exact URL attempted.

Interpretation:

- Probe works, page sideband fails: the provider accepts the call id, so inspect the dogfood integration path around headers, cancellation, session ownership, or attach sequencing before changing architecture.
- Probe also fails with 404, and the captured `Location` shape is documented: treat it as provider/account/model/session-class evidence. Preserve the `request_id` and test the baseline model before more local retry timing work.
- Probe works for `gpt-realtime` but fails for `gpt-realtime-2`: treat that as a model/version conformance difference until OpenAI confirms otherwise.
- Probe fails for both models with documented `rtc_*` locations: treat it as provider-level, account-level, or session-class behavior rather than a Sophia UI timing problem.

## Live Sideband Retry While The Call Is Still Alive

Phase 10.9 adds the internal manual retry path that matters more than the isolated post-teardown probe.

Use this when the page shows degraded audio-only mode:

1. Keep the browser session open. Do not disconnect.
2. Confirm the page still shows the original `rtc_*` call id.
3. Wait either immediately, a few seconds, or one spoken turn.
4. Click `Retry Sideband Attach`.
5. Observe whether the page changes from degraded audio-only mode to `Attached`, without recreating the browser call.

The retry reuses the existing backend sideband route against the active session. It must not create a new browser session, re-run SDP exchange, or destroy the live WebRTC connection first.

Capture this evidence on every live retry attempt:

- `requested_model`
- `raw_location`
- `extracted_call_id`
- current WebRTC readiness snapshot
- whether remote audio has become active
- `session_alive_ms` at the moment of retry
- provider request id
- provider HTTP status if present
- exact sideband error detail shown by the page and `logs/voice.log`

Interpretation for the next manual run:

- Live retry succeeds on the same `rtc_*`: the provider can attach to an active call. Inspect the original attach timing/path instead of blaming provider incompatibility.
- Live retry still returns 404 on the same still-open `rtc_*`: that is much stronger provider/account/model/session-class evidence than a post-teardown probe.
- Live retry succeeds only for `gpt-realtime`: treat model/version conformance as the leading hypothesis.
- Live retry fails after remote audio is active and after multiple seconds alive: stop spending time on generic readiness-delay tuning.

To compare the baseline documented model without changing tracked config, temporarily set the env var before restarting the local app:

```powershell
$env:SOPHIA_OPENAI_REALTIME_MODEL = "gpt-realtime"
.\scripts\start-all.ps1
```

Run `/debug/realtime/openai`, capture the same fields, run the probe against that run's new `rtc_*` id, then restore:

```powershell
$env:SOPHIA_OPENAI_REALTIME_MODEL = "gpt-realtime-2"
```

## Manual API Flow

1. Start an OpenAI browser dogfood session through the authenticated app proxy:

```powershell
Invoke-WebRequest -Method POST `
  -Uri "http://localhost:3000/api/sophia/<user_id>/voice/dogfood/openai/browser-session" `
  -ContentType "application/json" `
  -Body '{"session_id":"browser-openai-manual-1"}'
```

Expected response fields:

- `session_id`
- `runtime: "openai_realtime"`
- `transport: "openai_browser_webrtc_with_server_sideband"`
- `client_secret.value` beginning with an OpenAI ephemeral token value
- `webrtc_call_url: "https://api.openai.com/v1/realtime/calls"`
- `stream_url` under `/api/sophia/<user_id>/voice/dogfood/openai/events`

2. In browser dogfood code, create an `RTCPeerConnection`, attach microphone tracks, create an SDP offer, and post the offer directly to OpenAI:

```ts
await fetch('https://api.openai.com/v1/realtime/calls', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${clientSecretValue}`,
    'Content-Type': 'application/sdp',
  },
  body: offer.sdp,
});
```

The response body is the SDP answer. The response `Location` header must contain `/v1/realtime/calls/{call_id}`, where `{call_id}` starts with `rtc_`.

3. Attach the backend sideband using the `rtc_*` call id or raw `Location` header:

```powershell
Invoke-WebRequest -Method POST `
  -Uri "http://localhost:3000/api/sophia/<user_id>/voice/dogfood/openai/sideband" `
  -ContentType "application/json" `
  -Body '{"session_id":"browser-openai-manual-1","call_id":"rtc_..."}'
```

Expected response fields:

- `attached: true`
- `call_id: "rtc_..."`
- `public_event_boundary: "SophiaEventNormalizer"`
- `stream_url` for normalized SSE

4. Open the returned SSE URL:

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/sophia/<user_id>/voice/dogfood/openai/events?session_id=browser-openai-manual-1" `
  -Headers @{ Accept = "text/event-stream" }
```

Expected success signals while speaking in the browser session:

- SSE event names start with `sophia.` only.
- Assistant lifecycle arrives as `sophia.turn` with `agent_started` / `agent_ended`.
- Assistant text arrives as `sophia.transcript`.
- Structured companion artifacts arrive as `sophia.artifact` if OpenAI emits the `emit_artifact` tool call.
- No raw provider event names such as `response.output_audio_transcript.delta` appear in public SSE payloads.

5. Close the dogfood session:

```powershell
Invoke-WebRequest -Method POST `
  -Uri "http://localhost:3000/api/sophia/<user_id>/voice/dogfood/openai/disconnect" `
  -ContentType "application/json" `
  -Body '{"session_id":"browser-openai-manual-1"}'
```

## Frontend Helper

The contained connector lives at `frontend/src/app/lib/openai-browser-webrtc-dogfood.ts`.

It performs the safe sequence:

1. `POST /api/sophia/{user_id}/voice/dogfood/openai/browser-session`
2. `navigator.mediaDevices.getUserMedia({ audio: true })`
3. `RTCPeerConnection.createOffer()`
4. `POST https://api.openai.com/v1/realtime/calls` with the ephemeral token only
5. Extract `rtc_*` from the `Location` header
6. Set the SDP answer as the remote description
7. Wait for browser WebRTC readiness evidence
8. `POST /api/sophia/{user_id}/voice/dogfood/openai/sideband` with the raw call diagnostics
9. Return the normalized `streamUrl`

## Failure Cases That Are Expected

- Default env (`SOPHIA_VOICE_RUNTIME_MODE` unset or `legacy_cascade`) returns conflict for browser dogfood session start.
- Missing `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true` fails before any OpenAI client secret is minted.
- Missing `SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED=true` fails before any OpenAI client secret is minted.
- Missing backend `OPENAI_API_KEY` fails before any browser token is returned.
- Missing or invalid `rtc_*` call id fails sideband attach.
- A WebRTC connection alone is not success; the backend sideband must attach and the SSE stream must emit normalized `sophia.*` events.

## Regression Checks

Run the focused checks before handing off Phase 8A work:

```powershell
cd voice
python -m pytest tests/test_openai_browser_dogfood.py tests/test_realtime_dogfood_session.py tests/test_openai_realtime_provider_adapter.py tests/test_server_readiness.py -q
python -m compileall -q realtime
```

```powershell
cd frontend
pnpm vitest run src/__tests__/debug/openai-realtime-dogfood-page.test.tsx src/__tests__/openai-browser-webrtc-dogfood.test.ts src/__tests__/api/voice-session-proxy.route.test.ts
pnpm typecheck
```

The broader frontend lint/typecheck and backend lint/test suites are still recommended before PR review.
