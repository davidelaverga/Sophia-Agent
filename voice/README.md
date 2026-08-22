# Sophia Voice Service

Week 1 voice proof path for Sophia.

It uses Vision Agents for transport, STT, TTS, and Smart Turn, plus a `SophiaLLM` bridge that now runs behind one backend adapter seam:

- `shim`: contract-first local proof that streams assistant text and then emits a synthetic artifact
- `deerflow`: bridge to `sophia_companion` over `runs/stream`

## Prerequisites

- Python 3.12
- A dedicated environment at `voice/.venv`
- Root `.env` or `voice/.env` with at least:
  - `STREAM_API_KEY`
  - `STREAM_API_SECRET`
  - `DEEPGRAM_API_KEY`
  - `CARTESIA_API_KEY`

Optional Sophia-specific settings:

- `SOPHIA_BACKEND_MODE=shim|deerflow`
- `SOPHIA_LANGGRAPH_BASE_URL=http://127.0.0.1:2024`
- `SOPHIA_ASSISTANT_ID=sophia_companion`
- `SOPHIA_DEEPGRAM_MODEL=flux-general-en`
- `SOPHIA_CONTEXT_MODE=life`
- `SOPHIA_RITUAL=prepare|debrief|vent|reset`
- `SOPHIA_VOICE_ID=<cartesia voice id>`
- `SOPHIA_SHIM_RESPONSE_TEXT=<optional proof copy>`
- `SOPHIA_SHIM_CHUNK_DELAY_MS=40`

## Gemini Live production controls

The browser-owned Gemini Live route has independently reversible setup controls:

- `SOPHIA_GEMINI_LIVE_CONTINUITY_ENABLED=false` controls `sessionResumption` only.
- `SOPHIA_GEMINI_LIVE_COMPRESSION_ENABLED=false` controls `contextWindowCompression` only. Compression never inherits the continuity value.
- `SOPHIA_GEMINI_LIVE_GOOGLE_SEARCH_ENABLED=true` controls provider-native Google Search.
- `SOPHIA_GEMINI_LIVE_WEB_FETCH_ENABLED=true` controls both the backend `web_fetch` declaration and its Gemini spoken-policy overlay.

The two web controls default on for backward compatibility. Their four combinations form the web-context 2x2 canary without removing the normal production capability by default.

Ephemeral-token ownership is explicit:

- The token locks stable setup fields such as model, generation config, system instruction, transcription configuration, and context compression.
- The browser owns `sessionResumption`, because the private handle never returns to the backend.
- The browser owns `tools`, because normal voice and co-review deliberately use different declarations after token minting. Gemini 3.1 Live supports Search and function calling on this route; browser-handled co-review functions stay local, and backend-relayed functions still pass the explicit `GEMINI_DOGFOOD_ALLOWED_TOOL_NAMES` allow-list before execution.
- Every token-locked field must remain canonically byte-equivalent between the token body and the connection setup. Tests enforce this while allowing browser-owned fields to differ.

`SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING=true` enables manual voice tracing when the LangSmith credentials and `SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET` are also present. Tracing is strictly fail-open: SDK failures during construction, event/span recording, distributed-header generation, or finalization disable tracing for that session and increment compact diagnostics, but never block voice bootstrap, provider-event application, tool/public delivery, or teardown.

Each trace root records `sophia_gemini_live_effective_setup_v1` in metadata and final results. The privacy-safe fingerprint contains deployment SHA, model/voice, setup field names and ownership, effective/configured flags, provider epoch, and HMAC-SHA256 setup/tool/prompt hashes with character counts. Prompt and tool contents are not exported. The full setup/tools hashes describe the server baseline before browser-owned overrides; the token-setup hash describes the effective locked connection fields. Compression records configuration and setup presence separately from runtime triggering. Gemini Live does not expose an explicit compression-trigger event, so `compression.triggered` remains `null` with an explicit `not_exposed_by_gemini_live_server_events` status instead of guessing.

Focused verification from the repository root:

```bash
voice/.venv/bin/python -m pytest \
  voice/tests/test_gemini_live_provider_adapter.py \
  voice/tests/test_gemini_langsmith_tracing.py \
  voice/tests/test_sophia_prompt.py \
  voice/tests/test_gemini_browser_dogfood.py -q
```

## Install

From the repo root:

```powershell
voice\.venv\Scripts\python.exe -m pip install -r voice\requirements.txt
```

Install the local test dependencies when you want to validate the proof from code:

```powershell
voice\.venv\Scripts\python.exe -m pip install -r voice\requirements-dev.txt
```

## Week 1 Smoke Mode

Use `shim` for the current proof path. It exercises the right contract shape without waiting for a real Sophia backend.

```powershell
$env:SOPHIA_BACKEND_MODE = "shim"
voice\.venv\Scripts\python.exe -m voice.server run --call-id sophia-dev
```

Success looks like this:

- You can speak and Smart Turn closes the turn.
- You hear a spoken reply.
- Logs show `voice.metric metric=first_text_ms ...`.
- Logs show `voice.metric metric=first_audio_ms ...`.
- No `voice.error` stage is emitted.

## DeerFlow Mode

Once `sophia_companion` exists and LangGraph is running, switch modes without changing the rest of the voice service:

```powershell
$env:SOPHIA_BACKEND_MODE = "deerflow"
$env:SOPHIA_LANGGRAPH_BASE_URL = "http://127.0.0.1:2024"
$env:SOPHIA_ASSISTANT_ID = "sophia_companion"
voice\.venv\Scripts\python.exe -m voice.server run --call-id sophia-dev
```

If readiness fails in this mode, startup stops before joining the call.

## Run Local Demo

Run from the repo root so module imports and shared `.env` loading work:

```powershell
voice\.venv\Scripts\python.exe -m voice.server run --call-id sophia-dev
```

This opens the standard Vision Agents demo unless you pass `--no-demo`.

## Serve As Agent HTTP Server

```powershell
voice\.venv\Scripts\python.exe -m voice.server serve --port 8000
```

## Failure Signals

- `voice.error stage=silence-empty-transcript`: turn ended but no usable transcript was produced.
- `voice.error stage=stt`: STT failed before the backend request could start.
- `voice.error stage=backend-ready`: the selected backend was not ready during startup.
- `voice.error stage=backend-request|backend-timeout|backend-stream`: backend request or stream failure.
- `voice.error stage=backend-contract`: streamed text or artifact contract was malformed.
- `voice.error stage=tts`: TTS failed after text generation began.

## Notes

- `server.py` disables Deepgram's built-in turn detection so Smart Turn owns turn boundaries.
- With the current Vision Agents Deepgram plugin, `flux-general-en` is the safe Week 1 baseline for streaming STT.
- `sophia_tts.py` still only queues artifact state for the next turn. Week 2 will make the emotion fields audible.
- The adapter seam is the stable handoff point now. The proof path is `shim`, and the later swap is only a backend mode change.
