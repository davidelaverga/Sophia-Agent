# Server-Side Stream Call Dispatch

**Date:** 2026-03-30
**Status:** Implementation-ready
**Context:** Brainstorm from voice transport migration — the frontend can join Stream calls but no server-side agent participates yet.

---

## Problem

The gateway's `POST /api/sophia/{user_id}/voice/connect` generates a `call_id` and returns Stream credentials to the frontend. The frontend joins the call via Stream SDK. But **nothing tells the Vision Agents voice server to join that call**. The user hears silence.

The voice server (`voice/server.py`) currently launches via `python -m voice.server run --call-id sophia-dev` — a single hardcoded call for dev testing. There is no dynamic dispatch.

## Discovery

The Vision Agents `Runner` already has a **`serve` mode** that starts a FastAPI HTTP server with dynamic call management:

```
POST   /calls/{call_id}/sessions          → spawn agent, join call
DELETE /calls/{call_id}/sessions/{id}      → close session
GET    /calls/{call_id}/sessions/{id}      → session info
GET    /calls/{call_id}/sessions/{id}/metrics → metrics
```

Built-in features: idle timeout (60s), max concurrent sessions, max sessions per call, max session duration. The `AgentLauncher` and `Runner` classes in `voice/server.py` already wire `create_agent` and `join_call` — `serve` mode works out of the box.

## Architecture Alignment

From `01_architecture_overview.md` §4: Voice Layer (Vision Agents) is a **separate process** from the Intelligence Layer (DeerFlow). The gateway acts as the coordination point.

```
Frontend ──POST /voice/connect──► Gateway (8001)
                                    │  1. Generate call_id + Stream token
                                    │  2. POST /calls/{call_id}/sessions → Voice Server (8000)
                                    │  3. Return credentials to frontend
                                    │
Frontend ════ WebRTC (Stream) ════► Voice Server (8000)
                                    │
                                Voice Server ──runs/stream──► LangGraph (2024)
```

## Requirements

### R1: Gateway dispatches to voice server on connect
When a user calls `POST /api/sophia/{user_id}/voice/connect`, the gateway:
1. Generates `call_id` and `token` (existing behavior)
2. Sends `POST http://{VOICE_SERVER_URL}/calls/{call_id}/sessions` to the voice server
3. Stores the returned `session_id` in the response (new field)
4. Returns credentials to frontend only after the voice agent has joined

If the voice server is unreachable → 503 to frontend. No point starting a call with no agent.

### R2: Gateway exposes disconnect endpoint
`POST /api/sophia/{user_id}/voice/disconnect` with `{ call_id, session_id }`.
Forwards `DELETE /calls/{call_id}/sessions/{session_id}` to the voice server.
This is belt-and-suspenders — the Runner's idle timeout (60s) handles forgotten disconnects.

### R3: Voice server URL is an env var
`VOICE_SERVER_URL` defaults to `http://localhost:8000`. Set in `.env` or `config.yaml`.
The gateway reads it at startup. No new Python dependencies (httpx already in backend).

### R4: Voice server launches in serve mode
Change the dev startup from `python -m voice.server run --call-id sophia-dev` to
`python -m voice.server serve --port 8000`. The Runner's built-in FastAPI handles the rest.

### R5: No changes to voice/server.py internals
The existing `create_agent`, `join_call`, and `Runner(AgentLauncher(...)).cli()` all stay as-is.
The `serve` command is already available through `Runner.cli()`.

## Non-Requirements
- No Stream webhooks needed — direct HTTP dispatch is simpler and in our control
- No changes to SophiaLLM, SophiaTTS, or the adapter layer
- No changes to the frontend — it already calls `/voice/connect` and joins with returned credentials
- No authentication on the voice server's session API yet (same-host in dev, add later for prod)

## Files Changed
1. `backend/app/gateway/routers/voice.py` — add dispatch + disconnect endpoint
2. `backend/tests/test_voice_gateway.py` — update tests for dispatch behavior
3. `config.example.yaml` — document VOICE_SERVER_URL
