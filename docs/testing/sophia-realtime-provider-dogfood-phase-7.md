# Sophia Realtime Provider Dogfood Phase 7

Date: 2026-05-17
Status: Internal provider event-pump dogfood path; browser audio remains legacy-cascade only

## Scope

Phase 7 creates an internal dogfood path for `SOPHIA_VOICE_RUNTIME_MODE=openai_realtime` and `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`. It does not make either provider the default, and it does not route the existing browser microphone path through OpenAI WebRTC or Gemini Live WebSocket.

The dogfood path is intentionally narrow:

- Build the selected `RealtimeProviderSession` through the Phase 6 factory.
- Configure OpenAI/Gemini sessions with provider-specific setup helpers.
- Accept internal raw provider events/messages into the adapter.
- Stream only normalized `sophia.*` SSE payloads through `SophiaRealtimeTurnRuntime.public_events()`.
- Keep `/calls/{call_id}/sessions` legacy-only so experimental modes cannot silently fall back to Deepgram -> DeerFlow -> Cartesia.

## Required Configuration

OpenAI:

```bash
SOPHIA_VOICE_RUNTIME_MODE=openai_realtime
SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true
SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED=true
OPENAI_API_KEY=...
```

Gemini:

```bash
SOPHIA_VOICE_RUNTIME_MODE=gemini_live
SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true
SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true
GOOGLE_API_KEY=...   # or GEMINI_API_KEY=...
```

The normal Stream credentials are still required by the existing voice service settings. The dogfood path itself does not claim full Stream/browser media integration.

## Internal Endpoints

The voice server exposes these direct internal endpoints:

| Endpoint | Notes |
|---|---|
| `POST /dogfood/realtime/sessions` | Starts a dogfood session for the selected experimental runtime. |
| `POST /dogfood/realtime/sessions/{session_id}/input/text` | Sends text into the provider session. |
| `POST /dogfood/realtime/sessions/{session_id}/provider-events` | Ingests a raw provider event/message from a harness or recording. |
| `GET /dogfood/realtime/sessions/{session_id}/events` | Streams normalized `sophia.*` SSE events only. |
| `DELETE /dogfood/realtime/sessions/{session_id}` | Closes the session. |

The provider-event ingress endpoint is not a browser contract. It exists so internal harnesses can feed real or recorded provider messages into the adapter while the public stream remains provider-neutral.

## Validation Commands

Focused Phase 7 validation:

```bash
python -m pytest voice/tests/test_realtime_dogfood_session.py voice/tests/test_config.py voice/tests/test_server_readiness.py -q
```

Recommended realtime regression set:

```bash
python -m pytest voice/tests/test_realtime_runtime_selection.py voice/tests/test_realtime_runtime_factory.py voice/tests/test_openai_realtime_provider_adapter.py voice/tests/test_gemini_live_provider_adapter.py voice/tests/test_realtime_normalizer.py voice/tests/test_realtime_legacy_cascade_bridge.py voice/tests/test_realtime_shadow_parity.py voice/tests/test_realtime_dogfood_session.py voice/tests/test_config.py voice/tests/test_server_readiness.py -q
```

## What Not To Claim

- Do not call this production readiness for OpenAI or Gemini voice.
- Do not say browser microphone audio reaches OpenAI/Gemini yet.
- Do not expose raw provider event names to frontend consumers.
- Do not bypass `ProviderEvent` or `SophiaEventNormalizer` for the dogfood SSE stream.