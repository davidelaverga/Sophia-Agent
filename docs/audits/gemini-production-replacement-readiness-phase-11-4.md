# Gemini Production Replacement Readiness Audit - Phase 11.4

Date: 2026-05-19
Status: production voice remains `legacy_cascade`; Gemini Live remains internal dogfood only.

## Scope

This audit maps the working Gemini browser Live dogfood path against the current production voice cascade. It is intentionally conservative: a successful `/debug/realtime/gemini` smoke proves provider transport and tool-loop behavior on the internal route, not readiness to replace `/voice/connect`.

Phase 11.4 does not flip production defaults and does not route the main voice UX through Gemini Live.

## Current Production Voice Cascade

Production browser voice still enters through `frontend/src/app/hooks/useStreamVoiceSession.ts` and `frontend/src/app/hooks/useStreamVoice.ts`:

- The frontend calls `POST /api/sophia/{user_id}/voice/connect`, receives Stream credentials, joins a Stream Video call, enables the browser microphone through the Stream SDK, binds remote participant audio elements, and opens the returned normalized SSE `streamUrl`.
- The frontend also owns backend warmup, disconnect, `sendBeacon`/keepalive style teardown, Stream custom-event fallback when SSE is unavailable, stage mapping, transcript reconciliation, artifact callbacks, builder-task callbacks, and turn diagnostics.

The gateway path lives in `backend/app/gateway/routers/voice.py`:

- `voice_connect` mints Stream credentials, generates a `sophia-{user}-{uuid}` call id, dispatches the voice server, tracks one active session per user, and returns `stream_url` under `/api/sophia/{user_id}/voice/events`.
- `voice_events` proxies voice-service SSE from `/calls/{call_id}/sessions/{session_id}/events`.
- `voice/warmup` and `voice/disconnect` proxy backend warmup and teardown to the voice service.

The voice service production route lives in `voice/server.py`:

- `POST /calls/{call_id}/sessions` starts a Vision Agents session through `AgentLauncher`, binds platform/context/ritual/session/thread context into `SophiaLLM`, attaches a Stream custom-event + `VoiceEventBroker` emitter, and rejects this route when an experimental realtime runtime is selected.
- `GET /calls/{call_id}/sessions/{session_id}/events` streams the brokered public `sophia.*` SSE envelope.
- Warmup schedules DeerFlow backend warmup through `SophiaLLM` and Cartesia warmup through `SophiaTTS`.
- Close requests tear down the Vision Agents session and close broker subscribers.

The legacy cascade runtime assembled by `create_agent` still owns the live user experience:

- Stream/Vision Agents call and remote audio transport.
- Deepgram STT with SDK turn detection disabled.
- `SophiaTurnDetection` for echo suppression, adaptive silence, short-fragment stabilization, and VAD turn-end behavior.
- `ConversationFlowCoordinator` for cancel-and-merge, late continuation recovery, backend stall handling, acknowledgment speech, and rhythm learning.
- `SophiaLLM` for DeerFlow `/runs/stream` backend requests, artifact validation, builder task event emission, warmup, shadow parity, and turn diagnostic timing.
- `SophiaTTS` for Cartesia voice synthesis, artifact-driven emotion/speed, user emotion hints, first-audio hooks, interrupt handling, and TTS warmup.
- `VoiceEventBroker` for browser-facing SSE fanout and heartbeats.

## Gemini Live Dogfood Proven So Far

The Gemini internal path is separate from production and runs through `/voice/dogfood/gemini/*` proxy routes and `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`.

Proven by code and previous live smoke:

- Backend mints a Gemini Live ephemeral token; the standard Google/Gemini API key stays server-side.
- Browser opens the Gemini Live WebSocket directly, sends locked `setup`, waits for `setupComplete`, streams microphone audio as PCM16 16 kHz, and plays output audio as PCM16 24 kHz.
- Browser-captured Gemini server messages relay to the backend, then flow through `GeminiLiveEventMapper`, `SophiaEventNormalizer`, and public `sophia.*` SSE.
- `emit_artifact` executes through the backend-owned existing Sophia artifact contract and returns an official Live API `toolResponse.functionResponses[]` payload for browser send-back.
- `start_builder_task` launches real `sophia_builder` work through the LangGraph HTTP bridge and stores trusted session-scoped `async_tasks`.
- `check_async_task` can use the real returned task id. Live evidence from the successful Phase 11.3 smoke included task id `019e41f8-51b3-7022-bf06-3ccf7dfe7464`.
- Unknown lifecycle task ids fail closed as recoverable tool execution rejections with `ok:false`, tracked ids, and recovery guidance instead of relay degradation.

Strengthened in Phase 11.4:

- The Gemini debug page now keeps durable tool-loop session state outside the capped diagnostic log, so `Last start task id` and `Tracked task ids` survive later lifecycle diagnostics.
- The page no longer promotes rejected or model-invented lifecycle ids into the trusted tracked-id display.
- Deterministic frontend coverage now exercises `update_async_task`, `list_async_tasks`, and `cancel_async_task` toolResponse send-back over the active Gemini WebSocket.
- Deterministic backend coverage now locks the LangGraph HTTP request shapes for update/list/cancel lifecycle execution.

Not yet live-proven in the same way as start/check:

- `list_async_tasks`, `update_async_task`, and `cancel_async_task` have automated bridge coverage, but still need live operator smoke because fast builder completion can make manual update/cancel windows narrow.
- Production `/voice/connect` route parity has not been implemented.
- Long-session behavior, Gemini `goAway`, session resumption, and context compression are not wired into production lifecycle policy.

## Replacement Gap Table

| Production responsibility | Current owner | Gemini status | Gap before replacement |
|---|---|---|---|
| Authenticated production admission | Gateway `/voice/connect` plus Stream credentials | Dogfood proxy has authenticated Gemini browser-session route | Need a production Gemini connect route/response contract or a versioned runtime selector that the main UX can consume. |
| Browser microphone transport | Stream SDK call join/mic enable | Browser Gemini helper streams PCM16 over Live WSS | Need production hook integration, permission UX, device handling, reconnect policy, and mobile/iOS validation. |
| Remote audio playback | Stream remote participant audio + Cartesia output | Browser Web Audio plays Gemini PCM16 24 kHz | Need product-grade playback queue, interruption/ducking behavior, iOS compatibility, and audio unlock handling. |
| STT and turn authority | Deepgram + SmartTurn + SophiaTurnDetection | Gemini input transcription and provider turn signals | Need parity for silence timing, partial/final user transcript semantics, echo suppression replacement, and frontend stage stability. |
| Cancel-and-merge | ConversationFlowCoordinator + TTS interrupt | Provider-native interruption signals are normalized only in dogfood | Need live interruption policy equivalent to cancel-and-merge or an intentional product change with tests. |
| Backend companion turn | SophiaLLM -> DeerFlow `/runs/stream` | Gemini receives canonical prompt sources and selected tools | Full Sophia middleware chain, Mem0 retrieval/write timing, skill routing, rituals, handoffs, and offline side effects are not running inside Gemini Live. |
| Artifact contract | Backend `emit_artifact` via companion tool | Backend-owned `emit_artifact` execution proven | Need guarantee every production companion turn emits the required artifact through Gemini tool use, not just selected dogfood turns. |
| Builder lifecycle | Deepagents async subagent tools in companion graph | Gemini bridge starts/checks and test-covers update/list/cancel | Need repeated live lifecycle validation and production artifact/download path parity. |
| Warmup | Gateway/voice service backend + Cartesia warmup | Dogfood starts provider session directly | Need Gemini-specific warmup/preconnect strategy and honest frontend readiness states. |
| Teardown | Stream leave, gateway disconnect, voice service close, broker close | Dogfood disconnect closes session and WSS | Need production cleanup, active-session replacement, page unload behavior, provider close semantics, and leak checks. |
| Observability | SSE, Stream custom events, turn diagnostics, capture events | Normalized dogfood SSE and tool-loop diagnostics | Need production telemetry parity, provider metrics mapping, and run-record evidence. |
| Fallback/rollback | Legacy cascade is default | Experimental route is separate | Need feature flag, pilot gating, and an immediate rollback path before any user-facing cutover. |

## Safe Readiness Closures In Phase 11.4

- Fixed stale Gemini debug instrumentation at the root: successful builder task ids are now durable session state, not a derived value from a capped display log.
- Added coverage so later lifecycle calls cannot make the page forget a successful `start_builder_task`.
- Added coverage so rejected lifecycle ids are visible as rejected ids but do not become trusted tracked ids.
- Added deterministic list/update/cancel bridge coverage without claiming new live evidence.
- Documented the production route and lifecycle gaps instead of inferring replacement readiness from the debug page.

## Next Cutover Phase Proposal

Phase 11.5 should be a production-route candidate, still default-off:

1. Add a feature-flagged Gemini production candidate route or response variant that mirrors `/voice/connect` at the gateway boundary without changing `legacy_cascade` default.
2. Build a `useGeminiLiveVoiceSession` hook with the same high-level return surface as `useStreamVoiceSession`, including stage, transcript, artifact, builder-task, warmup, disconnect, and capture events.
3. Run the main voice UI against the Gemini hook under an internal flag, not only the debug page.
4. Prove live `start_builder_task`, `check_async_task`, `list_async_tasks`, `update_async_task`, and `cancel_async_task` from the flagged UI, with explicit notes for fast-completing tasks.
5. Add session lifetime handling for Gemini `goAway`, reconnect/resumption, and close/error reporting.
6. Define rollback: one env/config change returns the production UI to Stream/Vision Agents `legacy_cascade`.

Cutover should remain blocked until production-route parity, live lifecycle evidence, interruption behavior, teardown, and telemetry are proven under the same UX the user will actually use.