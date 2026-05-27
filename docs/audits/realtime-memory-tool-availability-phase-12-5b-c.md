# Phase 12.5B-C - Realtime Memory Tool Availability

Date: 2026-05-22
Status: implemented provider-safe realtime read path after first live smoke
Working branch: `fix/realtime-memory-tool-availability-phase-12-5b-c`

## Why This Phase Exists

The first live Gemini smoke proved the realtime tool loop could call `retrieve_memories(query)`, but the tool returned:

```json
{
  "status": "unavailable",
  "provider_status": "unavailable",
  "count": 0
}
```

That failure shape was too broad. It did not tell whether Mem0 was missing configuration, missing dependencies, returning no matches, or throwing during search.

This phase keeps the Phase 12.5B-B query-only contract and fixes the provider path underneath it. It does not add `consult_skill`, ritual tools, web tools, sideband writeback, artifact schema changes, VAD changes, default routing changes, or Builder storage/UI changes.

## Root Cause

The backend/LangGraph process could reach Mem0, but the voice realtime process had a different dependency and env surface.

Live/forensic findings:

- Backend logs showed Mem0 client initialization and search HTTP 200 responses.
- Voice logs had no Mem0/retrieve/provider status entries.
- The voice runtime could not import the backend Mem0 wrapper because `cachetools` was imported at module load.
- The voice runtime also lacked the `mem0` SDK package.
- Preferred-name setup context could still appear to work from `users/{user_id}/identity.md` or handoff files, so "Sophia knows my name" did not prove Mem0 was reachable.

## Implementation

`backend/packages/harness/deerflow/sophia/mem0_client.py` now has a provider-safe read path:

- The module is importable without `cachetools`; a small TTL fallback preserves bounded cache behavior in slim runtimes.
- The normal backend path still uses `mem0.MemoryClient` when the SDK is installed.
- If `MEM0_API_KEY` is present but the SDK is missing, realtime read search can fall back to Mem0 REST search through `httpx`.
- `MEM0_BASE_URL` is honored for SDK and REST paths when present.
- `memory_provider_status()` exposes safe reason codes without secrets or memory text.
- `search_memories_with_diagnostics()` returns results plus provider/cache diagnostics.
- Existing `search_memories()` remains list-returning for compatibility.

`backend/packages/harness/deerflow/sophia/tools/retrieve_memories_contract.py` now distinguishes:

- `success`: provider reachable and at least one bounded memory snippet returned.
- `no_results`: provider reachable, search succeeded, zero relevant memories.
- `unavailable`: provider not configured/unimportable/unavailable or trusted user id invalid.
- `error`: provider was considered reachable but search execution failed.
- `invalid_query`: query was empty/null-like, so provider was not called.

Realtime responses now include `provider_status` and `provider_reason` at top level and in diagnostics. Common reason codes include `missing_api_key`, `missing_mem0_sdk`, `rest_fallback`, `sdk_client`, `cache_hit`, `invalid_user`, `empty_query`, and `provider_exception`.

`voice/config.py` now loads `backend/.env` after voice/root env files with `override=False`, so local voice smoke runs can see the same `MEM0_API_KEY` source as backend services without overwriting voice-specific values.

`voice/realtime/gemini_memory_context.py` now uses the same shared provider status/search helper as the realtime tool. Setup memory context still falls back to identity/handoff files, but diagnostics now include the safe Mem0 provider reason so file-based continuity is not confused with Mem0 availability.

## Model Behavior

The realtime `retrieve_memories` declaration remains query-only. The description now explicitly nudges recall calls for prompts like:

- "What do you remember about me?"
- "Do you remember when...?"
- "What did we talk about last time?"
- "Have I told you about...?"
- "What do you know about my thesis/project/workout/gaming calm cue?"

It also tells the model not to call the tool for simple greetings, generic advice, facts already in the current conversation, or "what is my name?" when setup context already contains the preferred name.

## Privacy Diagnostics

Gemini tool diagnostics now include:

- status, count, latency, query length, result categories, result text lengths
- provider status, provider reason, provider transport
- cache status when available
- trusted user id source as `authenticated_session_context`
- ignored model argument names such as `user_id`, `categories`, `filters`, and `memory_provider`
- `raw_memory_text_excluded: true`

Diagnostics still do not include raw memory text, raw Mem0 payloads, secrets, raw provider config, or model-supplied user ids. Memory text is present only in the actual tool response sent back to the model.

## Validation

Focused validation run:

```bash
cd backend
uv run pytest tests/test_retrieve_memories_contract.py tests/test_mem0_client.py -q
```

Result: `43 passed`.

```bash
python -m pytest voice/tests/test_gemini_browser_dogfood.py voice/tests/test_sophia_prompt.py voice/tests/test_openai_realtime_provider_adapter.py -q
```

Result: `47 passed`.

## Smoke Expectations

Follow-up note: Phase 12.5B-C fixed provider availability and status precision. Phase 12.5B-D handles the separate model behavior issue: repeated specific recall routing and epistemic honesty after `no_results`, hints, guesses, or user-provided corrections.

- If `MEM0_API_KEY` is absent, realtime returns `status=unavailable` with `provider_reason=missing_api_key`.
- If the SDK is absent but `MEM0_API_KEY` and `httpx` are available, realtime search uses REST fallback and reports `provider_reason=rest_fallback`.
- If Mem0 search succeeds with no matches, realtime returns `status=no_results`, not `unavailable`.
- If search raises after provider availability, realtime returns `status=error` with `provider_reason=provider_exception`.
- If the model supplies `user_id`, categories, filters, or provider controls, those values are ignored and only the argument names appear in redacted diagnostics.