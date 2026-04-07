---
title: "Sophia live voice SSE bridge: backend-only transport enablement"
date: 2026-04-06
category: integration-issues
module: backend
problem_type: transport_gap
component: voice-sse-bridge
severity: medium
root_cause: missing_browser_facing_transport
resolution_type: backend_enablement
related_components:
  - backend.app.gateway.routers.voice
  - voice.server
  - voice.sophia_llm
  - voice.tests.test_sophia_llm_streaming
  - backend.tests.test_voice_gateway
tags: [sophia, voice, sse, gateway, stream, backend, transport]
---

# Sophia live voice SSE bridge: backend-only transport enablement

## Verdict

The full browser migration to SSE is not 100% backend.

The current frontend voice runtime already consumes live voice events and already owns the browser-side transport choice in [frontend/src/app/hooks/useStreamVoiceSession.ts](../../../frontend/src/app/hooks/useStreamVoiceSession.ts). It also bootstraps voice through Next routes in [frontend/src/app/api/sophia/[userId]/voice/connect/route.ts](../../../frontend/src/app/api/sophia/%5BuserId%5D/voice/connect/route.ts) and [frontend/src/app/api/sophia/[userId]/voice/disconnect/route.ts](../../../frontend/src/app/api/sophia/%5BuserId%5D/voice/disconnect/route.ts).

However, there is a clean backend-only prerequisite ticket that can be handed off independently:

- add an SSE mirror of the live voice events that already exist,
- keep the current Stream custom-event path unchanged,
- expose that mirror through voice service plus gateway,
- and leave browser adoption for a separate frontend ticket.

This document is that backend-only ticket.

## Why This Is Backend-Only

The backend already owns the live voice loop end to end:

- Stream WebRTC transport join is started through [backend/app/gateway/routers/voice.py](../../../backend/app/gateway/routers/voice.py).
- The voice service starts the agent session in [voice/server.py](../../../voice/server.py).
- DeerFlow `runs/stream` ownership remains behind `SophiaLLM` and the backend adapter seam in [voice/sophia_llm.py](../../../voice/sophia_llm.py).
- The live events the browser needs are already emitted from backend runtime code, not synthesized in the frontend.

That means backend can add a second transport for the same event stream without changing STT, TTS, turn ownership, or artifact ownership.

## Verified Current State

### 1. Gateway only exposes connect and disconnect today

In [backend/app/gateway/routers/voice.py](../../../backend/app/gateway/routers/voice.py), the public Sophia voice API currently exposes only:

- `POST /api/sophia/{user_id}/voice/connect`
- `POST /api/sophia/{user_id}/voice/disconnect`

There is no browser-facing SSE route there today.

### 2. Voice service already emits the live event contract

In [voice/server.py](../../../voice/server.py), the runtime wires:

- `llm.attach_call_emitter(agent.send_custom_event)`

That means live events are already forwarded from `SophiaLLM` into Stream custom events.

In [voice/sophia_llm.py](../../../voice/sophia_llm.py), the runtime already emits these event types:

- `sophia.user_transcript`
- `sophia.turn`
- `sophia.transcript`
- `sophia.artifact`
- `sophia.turn_diagnostic`

The emitted payload shape is already normalized as:

```json
{"type":"sophia.transcript","data":{"text":"...","is_final":false}}
```

### 3. Event ordering and payload shape are already tested in voice

[voice/tests/test_sophia_llm_streaming.py](../../../voice/tests/test_sophia_llm_streaming.py) already verifies that:

- transcript events stream before artifact,
- artifact is emitted through the call emitter,
- `user_transcript` and `turn` ordering is stable,
- emitter failure does not break the backend stream.

That gives backend a solid contract to mirror into SSE.

### 4. Existing gateway tests do not cover SSE

[backend/tests/test_voice_gateway.py](../../../backend/tests/test_voice_gateway.py) currently covers:

- `connect`
- `disconnect`
- voice-server dispatch behavior

It does not cover any streaming proxy behavior yet.

### 5. Frontend currently consumes Stream custom events, not SSE

The current consumer in [frontend/src/app/hooks/useStreamVoiceSession.ts](../../../frontend/src/app/hooks/useStreamVoiceSession.ts) listens for:

- `sophia.user_transcript`
- `sophia.turn`
- `sophia.transcript`
- `sophia.artifact`

That confirms two things:

1. the event contract itself already exists and works,
2. switching the browser to SSE later is a separate frontend migration step.

## Problem

Sophia live voice already has the right event contract, but it is trapped behind Stream custom events.

There is no browser-facing SSE transport for those same live events. That blocks an incremental migration path where the browser can consume SSE without taking over live turn ownership.

If the frontend tried to move to SSE today by calling DeerFlow directly or reconstructing the loop in browser code, it would duplicate responsibilities that still belong to backend:

- STT ownership
- `runs/stream` ownership
- authoritative artifact resolution
- TTS ownership
- live event emission timing

## Backend Ticket

Build a backend-side SSE bridge for Sophia live voice that mirrors the existing live event stream without changing the current voice session lifecycle.

## Scope

In scope for this ticket:

- add a per-session in-memory live event bus in the voice service,
- publish the existing normalized live events into that bus,
- expose a voice-service SSE endpoint for a live session,
- expose a gateway SSE proxy endpoint for the same stream,
- clean up subscribers on disconnect, timeout, missing session, and shutdown,
- add backend integration coverage.

Out of scope for this ticket:

- changing the frontend consumer to use SSE,
- removing Stream custom events,
- moving STT or TTS to the browser,
- direct browser ownership of DeerFlow `runs/stream`,
- any large voice UI refactor,
- any Next.js same-origin proxy route under `frontend/src/app/api/.../voice/events`.

## Required Behavior

### Preserve ownership

The voice service must remain the single owner of:

- STT
- turn detection
- backend `runs/stream`
- artifact finalization
- TTS
- event production

### Add dual delivery

The same live event emitted today as a Stream custom event must also be published into an SSE bus.

Do not remove or weaken the current Stream custom-event path in this ticket.

### Preserve event schema

The SSE payload must preserve the current logical contract:

```json
{"type":"sophia.artifact","data":{...}}
```

If SSE frames also include `event: sophia.artifact`, that is acceptable. The authoritative payload remains the JSON `type/data` envelope.

### Preserve lifecycle contract

Do not change:

- `POST /api/sophia/{user_id}/voice/connect`
- `POST /api/sophia/{user_id}/voice/disconnect`

This ticket adds transport, not a new voice session lifecycle.

## Proposed Backend Design

### Unit 1. Per-session live event bus in voice service

Introduce an in-memory publisher-subscriber bus keyed by at least:

- `call_id`
- `session_id`

The bus should carry already-normalized live events, not raw DeerFlow chunks.

Responsibilities:

- allow one or more subscribers per live session,
- queue normalized events safely,
- support heartbeats,
- terminate cleanly when the session ends.

### Unit 2. Fan out the existing event contract

At the point where [voice/sophia_llm.py](../../../voice/sophia_llm.py) emits:

- `sophia.user_transcript`
- `sophia.turn`
- `sophia.transcript`
- `sophia.artifact`
- optionally `sophia.turn_diagnostic`

publish the same payload into the SSE bus in addition to the existing `agent.send_custom_event` emission.

### Unit 3. Voice-service SSE endpoint

Add a browser-consumable route in the voice service:

- `GET /calls/{call_id}/sessions/{session_id}/events`

Requirements:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- no buffering
- periodic heartbeat frames
- clean shutdown when the session ends or the client disconnects
- validate `call_id/session_id` before subscribing

### Unit 4. Gateway SSE proxy

Add a route in [backend/app/gateway/routers/voice.py](../../../backend/app/gateway/routers/voice.py):

- `GET /api/sophia/{user_id}/voice/events?call_id=...&session_id=...`

Responsibilities:

- proxy the upstream voice-service SSE stream,
- preserve `text/event-stream`,
- disable buffering,
- release the upstream subscriber when the client disconnects,
- keep Sophia's public gateway surface consistent.

### Unit 5. Cleanup hardening

Subscribers must be removed when:

- browser disconnects,
- `voice/disconnect` is called,
- session expires or is closed upstream,
- agent crashes,
- server shuts down.

This is the main implementation risk.

## Acceptance Criteria

1. Backend still supports the current `connect` and `disconnect` routes with no request or response schema changes.
2. Live Stream custom events keep working exactly as before.
3. Voice service exposes `GET /calls/{call_id}/sessions/{session_id}/events` as `text/event-stream`.
4. Gateway exposes `GET /api/sophia/{user_id}/voice/events?call_id=...&session_id=...` as `text/event-stream`.
5. A normal turn can be observed through SSE with this event order:
   - `sophia.user_transcript`
   - `sophia.turn` `user_ended` when applicable
   - `sophia.turn` `agent_started`
   - one or more `sophia.transcript`
   - `sophia.artifact`
   - optional `sophia.turn_diagnostic`
6. SSE payloads preserve the existing `type/data` envelope used by the Stream custom-event path.
7. Disconnecting the SSE client releases the corresponding backend subscriber.
8. Calling `voice/disconnect` releases any SSE subscribers bound to that session.
9. Requesting SSE for a missing or closed session returns a clean error and does not allocate a dangling subscriber.

## Test Coverage Required

### Voice service

Add tests for:

- publish and subscribe flow for supported event types,
- normal event ordering for one assistant turn,
- heartbeat behavior,
- cleanup after client disconnect,
- cleanup after session shutdown,
- missing session handling.

### Gateway

Add tests for:

- SSE proxy header preservation,
- payload passthrough,
- disconnect propagation upstream,
- missing upstream session behavior,
- no-buffering response behavior.

## Notes For Triage

This is a valid backend-only ticket because it creates backend transport infrastructure without requiring browser adoption in the same change.

It is not the whole SSE migration.

The follow-up work that remains outside this ticket is:

- frontend same-origin proxy route if the web app continues to avoid direct gateway streaming,
- frontend consumer migration from Stream custom events to SSE,
- later retirement of custom-event consumption if the team chooses to do that.

## Recommended Ticket Title

`feat(backend): bridge browser-facing SSE for Sophia live voice events`

## Recommended Ticket Body

Implement a backend-only SSE bridge for Sophia live voice.

Current state:

- gateway exposes only `POST /voice/connect` and `POST /voice/disconnect`,
- voice runtime already emits normalized live events through `SophiaLLM -> agent.send_custom_event`,
- frontend currently consumes those custom events.

Requested change:

- add a per-session SSE event bus in `voice`,
- mirror the existing live event contract into that bus,
- add `GET /calls/{call_id}/sessions/{session_id}/events` in `voice`,
- add `GET /api/sophia/{user_id}/voice/events?call_id=...&session_id=...` in gateway,
- preserve current custom-event behavior,
- add cleanup and integration tests.

Non-goals:

- no frontend SSE consumer change,
- no STT/TTS ownership changes,
- no direct browser `runs/stream` ownership.