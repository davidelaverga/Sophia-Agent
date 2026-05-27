# Sophia Gemini Browser Live WebSocket Dogfood - Phase 8B

Date: 2026-05-17
Status: dogfood path plus Phase 12.0 default-off production-route candidate. Production voice remains `legacy_cascade` unless all Gemini gates plus `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true` are explicitly set.

## What This Tests

Phase 8B proves the Gemini browser-owned Live WebSocket path while preserving Sophia's provider-neutral public event boundary:

`Browser microphone/speaker -> Gemini Live WebSocket with ephemeral auth token -> browser-captured provider messages -> authenticated backend relay -> Gemini adapter/tool bridge -> ProviderEvent -> SophiaEventNormalizer -> public sophia.* SSE`

This is not the production `/voice/connect` path. Stream/Vision Agents, Deepgram, Cartesia, SmartTurn, `SophiaLLM`, and `ConversationFlowCoordinator` remain the default browser voice runtime.

Unlike Phase 8A OpenAI, this path does not use or claim a backend sideband. The browser owns the Gemini Live WebSocket. The backend mints the ephemeral token and ingests browser-captured server messages for normalized observation. If Gemini emits a Live API `toolCall`, the browser still relays that provider message to the backend; the backend executes the approved existing Sophia tool path and returns a Gemini-compatible `toolResponse` client action for the browser to send over the already-open WSS.

## Phase 11.0-11.3 Sophia Prompt + Existing Tool Coverage

Phase 10.9 proved the first complete Gemini function-calling roundtrip without moving WebSocket ownership into the backend:

`Gemini toolCall -> browser relay -> backend tool executor -> relay client_actions -> browser toolResponse send-back -> Gemini resumes`

Phase 11 changes what is configured inside that proven transport:

- Prompt/instructions: Gemini setup now uses `voice/realtime/sophia_prompt.py`, which assembles from the same canonical Sophia sources used by the companion path: `skills/public/sophia/soul.md`, `voice.md`, `techniques.md`, `AGENTS.md`, platform guidance from `PlatformContextMiddleware`, optional context/ritual files, and the voice artifact contract from `ArtifactMiddleware`.
- Tool surface: Gemini setup exposes existing Sophia backend capabilities only: `emit_artifact`, `start_builder_task`, `check_async_task`, `update_async_task`, `cancel_async_task`, and `list_async_tasks`. Declarations are built from dependency-safe backend contracts, not by importing LangChain/deepagents implementation modules into the voice runtime.
- Backend execution: relayed `emit_artifact` calls validate and execute the backend-owned artifact signal contract. Relayed builder/lifecycle calls execute through a backend-owned LangGraph HTTP bridge that starts/checks/updates/cancels/lists real `sophia_builder` async tasks and stores session-scoped `async_tasks` state on the trusted dogfood backend session.
- Trusted identity: Gemini may include a diagnostic `user_id` argument on `start_builder_task`, but it never overrides the authenticated dogfood session user id.
- Tool-use discipline: fresh build/create/generate/research requests should use `start_builder_task` first. `check_async_task`, `update_async_task`, and `cancel_async_task` may only use real task ids returned by `start_builder_task` or recovered from `list_async_tasks` in the current trusted session. Unknown task ids are rejected as tool execution, but the relay now returns a Gemini-compatible `toolResponse` with `ok:false` and recovery guidance so the model can self-correct.
- Transcript isolation: pseudo-tool syntax such as `try{emit_artifact{...}}`, JSON-ish tool calls, or raw function expressions must not appear in spoken text or public `sophia.transcript`. Structured Gemini `toolCall` remains the only valid tool invocation channel.

The temporary diagnostic probe is no longer part of the real live session tool set. This is still not the full Sophia runtime registry: Mem0 writes, full middleware-driven skill routing, offline pipeline side effects, and production `/voice/connect` routing remain deferred.

Phase 11.1 was triggered by a live `/debug/realtime/gemini` smoke where session creation failed before Gemini auth/session setup because declaration construction imported `deerflow.sophia.tools.emit_artifact`, which imports backend-only `langchain_core`. That failure is local configuration/dependency leakage, not a Gemini provider issue.

## Phase 11.4 Production Readiness Status

Phase 11.4 keeps Gemini Live on the internal dogfood route. It closes a debug-page evidence bug and documents what remains before replacing the production legacy cascade.

Live evidence carried forward from the successful Phase 11.3 smoke:

- Gemini Live connected through `/debug/realtime/gemini` with the browser-owned WSS and backend relay.
- `start_builder_task` launched a real builder task and returned task id `019e41f8-51b3-7022-bf06-3ccf7dfe7464`.
- A follow-up lifecycle check used the same real task id instead of inventing a numeric id.

Phase 11.4 fix:

- The page now preserves durable tool-loop session state separately from the capped recent diagnostic log. `Last start task id` and `Tracked task ids` should keep showing the real start id even after later tool calls push the start diagnostic out of the visible log.
- Rejected lifecycle ids remain visible as rejected ids, but they must not become trusted tracked ids unless the backend returns them in `tracked_task_ids` or a trusted task list.

Automated coverage added in this phase:

- Frontend page coverage for the capped-log regression and rejected-id tracking behavior.
- Frontend WebSocket helper coverage for `update_async_task`, `list_async_tasks`, and `cancel_async_task` toolResponse send-back.
- Backend HTTP bridge coverage for update/list/cancel LangGraph request shapes.

What is not yet live-proven:

- `list_async_tasks`, `update_async_task`, and `cancel_async_task` still need manual live dogfood evidence. The deterministic tests prove bridge behavior, not Gemini model choice under real audio conditions.
- Fast-completing builder tasks can make manual update/cancel hard to catch while the task is still running. Use a task that is likely to take longer, then update/cancel immediately after `Last start task id` appears.

Production replacement audit: `docs/audits/gemini-production-replacement-readiness-phase-11-4.md`.

## Phase 12.0 Production Route Candidate Smoke

Phase 12.0 wires Gemini into the real production admission route, but keeps rollback explicit and immediate. The same first-screen voice UI calls `/api/sophia/{user_id}/voice/connect`; the gateway returns either the legacy Stream payload or a Gemini bootstrap based on runtime flags.

Legacy default smoke:

1. Leave `SOPHIA_VOICE_RUNTIME_MODE` unset or set it to `legacy_cascade`.
2. Leave `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=false`.
3. Start the app and use the normal production voice UI, not `/debug/realtime/gemini`.
4. Expected: `/voice/connect` returns `api_key`, `token`, `call_type`, `call_id`, `session_id`, and `stream_url`; the frontend joins Stream; voice server dispatches `/calls/{call_id}/sessions`.

Gemini production candidate smoke:

1. Enable all Gemini gates in the voice-service and gateway environment:

```powershell
$env:SOPHIA_VOICE_RUNTIME_MODE = "gemini_live"
$env:SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED = "true"
$env:SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED = "true"
$env:SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED = "true"
$env:GOOGLE_API_KEY = "..."  # or GEMINI_API_KEY
```

2. Start the app and use the normal production voice UI.
3. Expected: `/voice/connect` returns `runtime: "gemini_live"`, `production_route: true`, an ephemeral-token `setup`, `stream_url: /api/sophia/voice/gemini/events?...`, `provider_event_relay_url: /api/sophia/voice/gemini/relay`, and `disconnect_url: /api/sophia/voice/gemini/disconnect`.
4. Expected frontend behavior: the hook does not join Stream; it opens Gemini Live WSS from the bootstrap, captures microphone audio in the browser, relays server messages through the production relay alias, and consumes normalized `sophia.*` SSE from the production events alias.
5. Tool coverage smoke: ask for a tiny artifact-producing response, then ask Sophia to create a short document. Expected: `emit_artifact` and `start_builder_task` go through the backend relay and the browser sends returned `toolResponse` actions over the active Gemini WSS.

Fail-closed smoke:

- Set `SOPHIA_VOICE_RUNTIME_MODE=gemini_live` but leave `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=false`. Expected: production `/voice/connect` returns an explicit conflict; it must not silently fall back to Stream and it must not create a Gemini session.
- Keep the promotion flag on but remove `GOOGLE_API_KEY` / `GEMINI_API_KEY`. Expected: voice service rejects the Gemini session startup clearly; no browser key exposure occurs.

Rollback smoke:

1. Set `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=false` or set `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
2. Restart the affected services.
3. Use the normal production voice UI again.
4. Expected: `/voice/connect` returns the legacy Stream payload and the UI joins Stream as before.

## Required Environment

Enable all gates only in a local dogfood shell:

```powershell
$env:SOPHIA_VOICE_RUNTIME_MODE = "gemini_live"
$env:SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED = "true"
$env:SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED = "true"
$env:SOPHIA_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview"
$env:GOOGLE_API_KEY = "..."  # or GEMINI_API_KEY
```

Also keep the normal voice service shared requirements available, especially `STREAM_API_KEY` and `STREAM_API_SECRET`.

Do not set `GOOGLE_API_KEY` or `GEMINI_API_KEY` in `NEXT_PUBLIC_*` variables, browser code, or frontend env files. The browser receives only the ephemeral auth token minted by the backend.

## Start Services

From the repository root:

```powershell
.\scripts\start-all.ps1
```

Or use the workspace task `Start Sophia App` / `Launch Sophia Dev` if that is your normal local path.

## Preferred UI Test Path

For normal product dogfooding, prefer the internal page instead of replaying the low-level API and WebSocket sequence by hand.

Route:

```text
/debug/realtime/gemini
```

How to use it locally:

1. Start the local services with the Gemini experimental runtime env enabled.
2. Open `http://localhost:3000/debug/realtime/gemini` in the browser.
3. Sign in or enable the local dev auth bypass so the page has a Sophia user id.
4. Click `Connect`.
5. Grant microphone permission when the browser prompts.
6. Wait for the page to show a session id, Gemini WSS progress, and normalized SSE status.

What success looks like:

- `Current status` becomes `Connected`.
- `Setup complete` becomes `Reached`.
- `Gemini WSS` progresses through setup and ends at `Connected`.
- `Backend relay` becomes `Active` once browser-captured server messages are accepted.
- `Public SSE` becomes `Connected`.
- `Tool loop` shows configured tools: `cancel_async_task`, `check_async_task`, `emit_artifact`, `list_async_tasks`, `start_builder_task`, and `update_async_task`.
- The event log fills with `sophia.*` events only.

Phase 10.8 live manual testing reached the first real speech loop on `/debug/realtime/gemini`: setup completed, microphone connected, remote audio became active, Gemini WSS stayed connected, public SSE connected, and normalized events included `sophia.user_transcript`, `sophia.turn` (`user_ended` and `agent_started`), `sophia.transcript`, and provider metric diagnostics. This is live dogfood progress, not production readiness.

The new blocker from that run was playback stability plus relay diagnostics. If output sounds like overlapping or garbled voices, inspect the browser playback path before changing token minting or setup. Gemini Live output audio is raw PCM16 little-endian at 24 kHz, delivered in `serverContent.modelTurn.parts[].inlineData` payloads with `audio/pcm` MIME type. The helper must convert PCM16 samples into Web Audio buffers and schedule chunks sequentially; starting every chunk immediately can stack audio buffers and make one response sound like several voices at once.

Recommended builder task-id chaining smoke from the page:

1. Say: `Sophia, create a short one-page reflection document about staying grounded today.`
  - Expected: Gemini calls `start_builder_task`, the backend returns a real `task_id`, `Tool response sent` shows `Yes`, and `Last start task id` / `Tracked task ids` show that same id.
2. After the tool starts, say: `How is that document going?`
  - Expected: Gemini calls `check_async_task` using the real returned task id. It must not invent a numeric id such as `789654321`.
3. Optional recovery check: say `What tasks are currently active?`
  - Expected: Gemini calls `list_async_tasks`; the returned list can be used to recover ids for later lifecycle calls.
4. Optional update/cancel checks: say `Make it a little warmer` or `Cancel that task.`
  - Expected: `update_async_task` or `cancel_async_task` uses the tracked task id already shown on the page.

Manual lifecycle coverage still needed after Phase 11.4:

- `list_async_tasks`: after the start id is visible, ask `What builder tasks are currently active?` Expected: the Tool loop panel shows `list_async_tasks`, `Tool response sent: Yes`, and `Tracked task ids` still includes the real builder id.
- `update_async_task`: while the task is still running, ask `Make that document warmer and more concise.` Expected: Gemini uses the same tracked task id and task status returns `running`.
- `cancel_async_task`: while the task is still running, ask `Cancel that task.` Expected: Gemini uses the same tracked task id and task status returns `cancelled`.
- If the task completes before update/cancel can run, record that as a timing limitation, not a failed lifecycle bridge. Retry with a longer task such as a multi-section research brief.

General audio/tool smoke:

- Say `Hola Sophia, me escuchas?`
- Ask for one sentence.
- Interrupt mid-response and watch the turn diagnostics.

Tool-loop success on the page:

- `Last tool call` shows `emit_artifact` or `start_builder_task` with a Gemini function-call id.
- `Backend result` shows `Success: Existing Sophia emit_artifact tool executed.`
- Builder calls show a real backend task id and task status in the Tool loop panel.
- Lifecycle calls show which task id was used. If a lifecycle call uses an unknown id, the Tool loop panel should show `Execution rejected`, the rejected id, the currently tracked ids, and recovery guidance; this is a valid tool execution rejection, not a Gemini WSS or relay transport failure.
- `Tool response sent` shows `Yes` with the same tool name/id.
- The public SSE log may include both `sophia.artifact` and a `sophia.turn_diagnostic` provider metric with `tool_loop_status: completed`.

Log/API success:

- The relay POST for the `toolCall` returns `202 Accepted` with `client_actions[0].type == "gemini_tool_response"`.
- The returned payload is shaped as `{"toolResponse":{"functionResponses":[{"id":"...","name":"emit_artifact","response":{...}}]}}`.
- The browser sends that payload back over the existing Gemini WSS; it does not execute the tool in browser code.

The manual low-level API flow below still exists for deeper debugging of tokens, raw WebSocket behavior, relay payloads, or SSE proxying.

## Manual API Flow

1. Start a Gemini browser dogfood session through the authenticated app proxy:

```powershell
Invoke-WebRequest -Method POST `
  -Uri "http://localhost:3000/api/sophia/<user_id>/voice/dogfood/gemini/browser-session" `
  -ContentType "application/json" `
  -Body '{"session_id":"browser-gemini-manual-1"}'
```

Expected response fields:

- `session_id`
- `runtime: "gemini_live"`
- `transport: "gemini_browser_websocket_ephemeral_token_with_backend_relay"`
- `websocket_url` pointing at `BidiGenerateContentConstrained`
- `websocket_auth: "access_token_query_param"`
- `ephemeral_token.value` containing a Google Live auth token name/value, not the standard API key
- `setup` containing the locked Live setup payload
- `stream_url` under `/api/sophia/<user_id>/voice/dogfood/gemini/events`

2. In browser dogfood code, open Gemini Live directly with the ephemeral token:

```ts
const ws = new WebSocket(`${websocketUrl}?access_token=${encodeURIComponent(ephemeralTokenValue)}`);
```

3. Send `setup` first and wait for `setupComplete` before sending audio:

```ts
ws.send(JSON.stringify({ setup }));
// Wait until the server sends { setupComplete: {} }.
```

4. Stream microphone input to Gemini as raw PCM16 little-endian, 16 kHz, base64 encoded:

```ts
ws.send(JSON.stringify({
  realtimeInput: {
    audio: {
      data: base64Pcm16Audio,
      mimeType: 'audio/pcm;rate=16000',
    },
  },
}));
```

5. Relay each Gemini server message back to Sophia for normalized observation and backend-owned tool execution:

```powershell
Invoke-WebRequest -Method POST `
  -Uri "http://localhost:3000/api/sophia/<user_id>/voice/dogfood/gemini/relay" `
  -ContentType "application/json" `
  -Body '{"session_id":"browser-gemini-manual-1","event":{"serverContent":{"outputTranscription":{"text":"Hi."}}}}'
```

Accepted relay event top-level shapes include `setupComplete`, `serverContent`, `toolCall`, `toolCallCancellation`, `goAway`, `sessionResumptionUpdate`, `usageMetadata`, and `error`. Client input messages such as `realtimeInput` are rejected.

When the relayed event is a valid `toolCall` for an approved existing Sophia tool, the response may include client actions:

```json
{
  "accepted": true,
  "client_actions": [
    {
      "type": "gemini_tool_response",
      "payload": {
        "toolResponse": {
          "functionResponses": [
            {
              "id": "artifact-call-1",
              "name": "emit_artifact",
              "response": {
                "ok": true,
                "backend_tool_result": "Artifact recorded.",
                "artifact_recorded": true
              }
            }
          ]
        }
      }
    }
  ]
}
```

The browser must send the `payload` exactly as the next Gemini client message. The backend response is an instruction to the browser, not a public SSE event by itself.

For builder launch calls, the function response uses the same Live API envelope and includes a real task id that is also shown in the debug page:

```json
{
  "toolResponse": {
    "functionResponses": [
      {
        "id": "builder-call-1",
        "name": "start_builder_task",
        "response": {
          "ok": true,
          "task_id": "<builder_thread_id>",
          "status": "running",
          "result_summary": "Launched builder task. task_id: <builder_thread_id>."
        }
      }
    ]
  }
}
```

6. Open the returned SSE URL:

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/sophia/<user_id>/voice/dogfood/gemini/events?session_id=browser-gemini-manual-1" `
  -Headers @{ Accept = "text/event-stream" }
```

Expected success signals while speaking in the browser session:

- SSE event names start with `sophia.` only.
- Assistant lifecycle arrives as `sophia.turn` with `agent_started` / `agent_ended`.
- Assistant text arrives as `sophia.transcript`.
- Structured companion artifacts arrive as `sophia.artifact` if Gemini emits the `emit_artifact` tool call.
- `toolCallCancellation` maps to a normalized interruption diagnostic.
- No raw provider names such as `serverContent` or `toolCallCancellation` appear in public SSE event names.

7. Close the dogfood session:

```powershell
Invoke-WebRequest -Method POST `
  -Uri "http://localhost:3000/api/sophia/<user_id>/voice/dogfood/gemini/disconnect" `
  -ContentType "application/json" `
  -Body '{"session_id":"browser-gemini-manual-1"}'
```

## Frontend Helper

The contained connector lives at `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`.

It performs the safe sequence:

1. `POST /api/sophia/{user_id}/voice/dogfood/gemini/browser-session`
2. `navigator.mediaDevices.getUserMedia({ audio: true })`
3. Open Gemini Live WSS with the ephemeral token in `access_token`
4. Send `setup` as the first client message
5. Wait for `setupComplete`
6. Stream mic audio as base64 PCM16 16 kHz
7. Relay server messages through `/api/sophia/{user_id}/voice/dogfood/gemini/relay`
8. Send backend-returned `gemini_tool_response` client actions over the existing Gemini WebSocket
9. Surface backend tool diagnostics, including builder task id/status when present
10. Best-effort play Gemini PCM16 24 kHz output audio through browser `AudioContext`
11. Return the normalized `streamUrl`

## Failure Cases That Are Expected

- Default env (`SOPHIA_VOICE_RUNTIME_MODE` unset or `legacy_cascade`) returns conflict for browser dogfood session start.
- Missing `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true` fails before any Gemini auth token is minted.
- Missing `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true` fails before any Gemini auth token is minted.
- Missing backend `GOOGLE_API_KEY` / `GEMINI_API_KEY` fails before any browser token is returned.
- Sending `realtimeInput` to the relay fails; mic audio goes only to Gemini over WSS.
- Sending audio before `setupComplete` is a connector bug.
- A WebSocket connection alone is not success; the relay and normalized SSE stream must emit `sophia.*` events.

## Troubleshooting

- If `POST /dogfood/realtime/gemini/browser-sessions` succeeds but the next relay request fails with `Gemini browser relay event cannot be empty`, inspect the browser helper first. That symptom means the frontend forwarded an empty or non-provider WebSocket frame instead of a real Gemini Live server message.
- Empty strings, `{}`, semantically empty envelopes such as `{"serverContent": {}}`, and browser lifecycle events are not valid relay material. Only documented Gemini Live server messages such as `setupComplete`, meaningful `serverContent`, `toolCall`, `toolCallCancellation`, `goAway`, `sessionResumptionUpdate`, `usageMetadata`, and `error` should be posted to the backend relay.
- If token minting and `POST /dogfood/realtime/gemini/browser-sessions` both succeed but `/debug/realtime/gemini` stays on `Waiting for setupComplete`, inspect whether the browser helper is parsing and preserving the valid zero-field provider event `{"setupComplete": {}}`. `setupComplete` is meaningful even though its nested object has no fields; filtering it as semantically empty will leave the UI in setup pending and prevent the backend relay from observing the handshake.
- If the page shows `Backend relay: Degraded`, treat it as an observability relay failure, not proof that Gemini WSS or remote audio died. Capture the relay diagnostic panel: target path, provider message type, whether an HTTP response existed, status code if present, error text, consecutive failure count, Gemini WSS state, public SSE state, and request body byte count.
- If `Last tool call` appears but `Tool response sent` stays empty, inspect the relay POST response for `client_actions`. A missing action means backend execution did not return a tool response instruction; a send failure means the browser could not write the returned payload to the still-open Gemini WSS.
- If builder tools are configured but `Task id` remains empty after a `start_builder_task` call, inspect the backend relay response first. Gemini setup must not advertise builder/lifecycle names unless the relay can execute them and return a `task_id` in the same phase.
- If the page shows `Task id` or `Tracked task ids` but `Last start task id` says no successful start, inspect the debug page state before assuming the backend failed. The start id must be stored as durable session state, not derived only from the capped recent diagnostic log.
- If `check_async_task`, `update_async_task`, or `cancel_async_task` is called with an unknown task id, the backend should fail closed and return a tool response with `ok:false`, `error_type: "unknown_task_id"`, `tracked_task_ids`, and `recovery_guidance`. The model should then call `start_builder_task` for a fresh build or `list_async_tasks` to recover a real id.
- If pseudo-tool syntax appears in assistant text, classify it as a transcript/tool isolation bug. Structured `toolCall` payloads are allowed; raw text shaped like `try{emit_artifact{...}}`, JSON-ish tool calls, or `start_builder_task{...}` must not be spoken or emitted as `sophia.transcript`.
- If a tool call includes a `user_id` argument, treat it as diagnostic-only. The trusted identity is the authenticated dogfood session user id captured when the browser session started.
- If `POST /dogfood/realtime/gemini/browser-sessions` returns a 500 or configuration error before any Gemini auth token is minted, inspect Gemini tool declaration construction before debugging provider auth. The voice layer must consume the lightweight `emit_artifact_contract` declaration source and must not import LangChain-dependent backend tool implementation modules just to build setup tools.
- If `Tool response sent` shows a failure while Gemini WSS remains open, treat it as a tool-loop failure, not provider transport death. Capture the tool-loop panel and continue observing WSS/SSE state.
- `Failed to fetch` on the relay usually means the browser did not receive an HTTP response for that relay POST. It can happen after prior successful `202 Accepted` relays. Check whether the diagnostic message type is audio-bearing `serverContent.modelTurn.inlineData.audio`, whether the Gemini WSS remains open, and whether public SSE remains connected before declaring the provider session dead.
- `Backend relay: Terminal failure` means the helper saw persistent relay failures or the Gemini WebSocket was no longer open when relay failed. Capture the same diagnostic panel plus the last Gemini WSS diagnostic: close code, close reason, `wasClean`, and whether relay failures happened before close.
- Normal provider relay POSTs should not use fetch `keepalive`; reserve keepalive for disconnect/teardown. Streaming provider messages can include audio payloads, and ongoing relay calls need normal browser fetch semantics with visible diagnostics.

## Regression Checks

Run the focused checks before handing off Phase 8B work:

```powershell
cd voice
python -m pytest tests/test_gemini_browser_dogfood.py tests/test_realtime_dogfood_session.py tests/test_gemini_live_provider_adapter.py tests/test_server_readiness.py -q
python -m compileall -q realtime
```

```powershell
cd frontend
pnpm vitest run src/__tests__/gemini-browser-live-websocket-dogfood.test.ts src/__tests__/debug/gemini-realtime-dogfood-page.test.tsx src/__tests__/api/voice-session-proxy.route.test.ts
pnpm typecheck
```

```powershell
cd backend
uv run pytest tests/test_voice_gateway.py -q
```

The broader frontend lint/typecheck and backend lint/test suites are still recommended before PR review.