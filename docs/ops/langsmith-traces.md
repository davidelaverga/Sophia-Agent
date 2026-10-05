# LangSmith Trace Access

Sophia builder traces land in the EU LangSmith project named `Sophia`.

## Content policy (who is traced, and how much)

| Run | Ordinary owner | Memory-governed (MEM00) owner |
|---|---|---|
| Companion graph | not traced (by design) | not traced |
| Builder graph | full trace (`SOPHIA_BUILDER_LANGSMITH_TRACING=true`) | excluded by default; structure-only when `SOPHIA_GOVERNED_STRUCTURAL_TRACING=true` |
| Gemini Live voice | structure-only | structure-only |
| Memory structural export | content-free events (`SOPHIA_MEMORY_LANGSMITH_EXPORT`) | same |

- **Structure-only** means run names, run types, timings, status, allowlisted
  codes and token counts. It never includes inputs, outputs, prompts, tool
  arguments or results, error text (exception class names only) or
  non-allowlisted metadata or tags. Governed Builder runs carry
  `sophia_trace_mode=governed_structural`.
- **Redaction lives in the client.** The governed Builder uses a redacting
  LangSmith client (`deerflow/sophia/governed_tracing.py`). Inside its scope,
  ambient tracing is disabled, so even `LANGSMITH_TRACING=true` or a
  distributed `langsmith-trace` parent cannot post an unredacted run for a
  governed graph.
- **An excluded governed Builder** stamps `langsmith_trace_status=trace_unavailable`
  and `langsmith_trace_unavailable_reason=memory_governance_policy` on its
  artifact and logs `builder_langsmith_excluded` once per process. A missing
  Builder trace for a governed owner is expected, not a fault.
- **Voice is never told** an owner's governance state, so it is structure-only
  for every session. Content (transcripts, tool payloads, error text, the
  recording) needs `SOPHIA_GEMINI_LIVE_LANGSMITH_CONTENT=true` AND an
  authoritative non-governed owner from the caller. No caller provides that
  today.
- **Do not set `LANGSMITH_TRACING=true`** to "turn traces on". It does not
  attach the Builder tracer. It attaches an explicit model tracer on the
  default client and widens what ordinary runs send.

## Diagnosing missing traces

Every check below prints codes and booleans only.

- **Startup.** sophia-langgraph logs one `[tracing]` line: the Builder flag,
  the key kind (`service`/`personal`/`other`, by prefix), whether
  `LANGSMITH_WORKSPACE_ID` and `LANGSMITH_PROJECT_UUID` are present, whether
  `LANGSMITH_API_KEY` equals `LANGCHAIN_API_KEY`, the memory export flag, the
  governed structural flag, the SDK version and the endpoint host. sophia-voice
  logs one `gemini.langsmith.startup` line.
- **Preflight.** When Builder tracing or the memory export is on,
  sophia-langgraph runs one `langsmith_preflight` per process (daemon thread,
  5 s cap, fails open). It logs the `/info` status, the project read status
  with and without `X-Tenant-Id`, `project_found` and `tenant_match`.
- **Ingest rejections.** The SDK posts runs on a background thread, so a
  rejected batch never raises in our code. Both services register a
  `tracing_error_callback`:
  - sophia-langgraph logs a rate-limited `langsmith_ingest_rejected`
    (`http_status`, `error_code`, `error_class`, `endpoint_host`,
    `workspace_header`).
  - sophia-voice logs `gemini.langsmith.ingest_rejected` once per state change.
    While the state is `rejected`, voice posts only the root run, and the
    browser bootstrap reports `langsmith_trace_unavailable_reason=langsmith_ingest_rejected`.
  - The SDK's own "Failed to multipart ingest" lines are sampled (first, then
    every 50th) with the body removed.
- **Memory export failures.** `memory_langsmith_export status=unavailable` now
  carries `error_class`, `http_status`, `error_code`, `endpoint_host`,
  `workspace_header_present`, `elapsed_ms` and `event_name`.
- **Reading a status:** 401 or 403 in both header modes means the key is
  invalid, expired or for the wrong region. 403 only with `X-Tenant-Id` means
  the workspace does not match. 200 with `tenant_match=true` but rejected
  ingest means the key's role or scope cannot write.

## Gemini Live voice traces

Gemini Live production uses a browser-owned provider WebSocket, so Sophia uses
manual LangSmith `RunTree` instrumentation rather than `wrap_gemini_live` (which
requires a Python-owned `client.aio.live.connect` session). Each conversation has
one `gemini_live_conversation` root with `ls_modality=audio`; child spans represent
provider socket events, tool calls, and function responses. Spans are
structure-only (see the content policy above): raw provider audio, transcripts,
tool payloads and error text are excluded, and the conversation recording is
not attached. Session close patches the root and returns; the SDK flush runs in
the background with a 2 s cap and again at shutdown.

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
