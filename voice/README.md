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