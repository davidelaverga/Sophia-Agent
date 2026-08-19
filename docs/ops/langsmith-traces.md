# LangSmith Trace Access

Sophia builder traces land in the EU LangSmith project named `Sophia`.

## Gemini Live voice traces

Gemini Live production uses a browser-owned provider WebSocket, so Sophia uses
manual LangSmith `RunTree` instrumentation rather than `wrap_gemini_live` (which
requires a Python-owned `client.aio.live.connect` session). Each conversation has
one `gemini_live_conversation` root with `ls_modality=audio`; child spans represent
provider socket events, tool calls, and function responses. Raw provider audio is
excluded from span payloads. When browser capture is available, the combined
conversation recording is attached to the root at disconnect and the SDK is
flushed before shutdown completes.

The voice service keeps this opt-in and feature-gated:

```bash
SOPHIA_VOICE_RUNTIME_MODE=gemini_live
SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true
SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true
SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true
GOOGLE_API_KEY=<runtime-key>
SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING=true
LANGSMITH_TRACING=false
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com
LANGSMITH_WORKSPACE_ID=<workspace-id>
LANGSMITH_PROJECT=Sophia
LANGSMITH_API_KEY=<runtime-key>
```

The browser bootstrap reports `langsmith_trace_id` and
`audio_capture_enabled`. Use the trace ID together with the session/thread ID
from Render logs to verify the root, socket-event children, tool spans, and root
attachment.

Required runtime configuration:

```bash
LANGSMITH_TRACING=false
SOPHIA_BUILDER_LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com
LANGSMITH_WORKSPACE_ID=<workspace-id>
LANGSMITH_PROJECT=Sophia
LANGSMITH_API_KEY=<runtime-key>
```

Optional, useful when exporting by project UUID:

```bash
LANGSMITH_PROJECT_UUID=<project-uuid>
```

For read-only code-agent access, register a LangSmith MCP server such as
`langchain-ai/langsmith-mcp-server` with a read-only API key and the same endpoint/project
configuration. The expected tool flow is:

1. `ls_list_runs` filtered to project `Sophia`, recent builder tags, or a `thread_id`.
2. `ls_read_run` for the root run and important child runs.
3. Cross-reference run metadata with Render/Vercel logs using `thread_id`, `task_id`, and `run_id`.

Local helper fallback:

```bash
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com \
LANGSMITH_WORKSPACE_ID=<workspace-id> \
LANGSMITH_PROJECT=Sophia \
LANGSMITH_API_KEY=<read-only-key> \
langsmith-fetch traces --include-metadata --include-feedback
```

`langsmith-fetch` is deprecated upstream, but it is still useful as a read-only export helper
when MCP tooling is not available. Never commit API keys or signed artifact URLs.
