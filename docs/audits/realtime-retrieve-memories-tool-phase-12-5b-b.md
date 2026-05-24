# Phase 12.5B-B - Realtime retrieve_memories Tool Contract

Date: 2026-05-21
Status: implemented narrow realtime memory-tool slice
Working branch: `fix/realtime-retrieve-memories-tool-phase-12-5b-b`
Source branch: `audit/sophia-voice-spec-alignment-phase-12-5b-a`

## Why This Phase Exists

Phase 12.5B-A concluded that native realtime Sophia should use a stable prompt, bounded session seed, provider conversation state, narrow function tools, on-demand memory, and offline writeback. This phase implements the first narrow slice of that direction: a provider-agnostic realtime `retrieve_memories(query)` contract.

This phase does not implement `consult_skill`, ritual retrieval, web tools, sideband memory writeback, conversation checkpointer replacement, artifact schema migration, builder trace storage, VAD or turn-detection changes, default Gemini/GPT routing changes, or prompt rewrites.

## Existing retrieve_memories Audit

- Location: `backend/packages/harness/deerflow/sophia/tools/retrieve_memories.py`.
- Previous schema: LangChain `StructuredTool` with model-facing `query` and optional `categories`.
- Dependencies: imported LangChain and Pydantic in the tool wrapper, so it was not suitable for realtime provider declaration imports.
- Identity: `make_retrieve_memories_tool(user_id)` captured trusted `user_id` by closure. The model never supplied `user_id` in the text companion path.
- Mem0 call: lazy-imported `deerflow.sophia.mem0_client.search_memories(user_id, query, categories)`.
- Result count: returned up to 15 bullet lines from the search result list, although the default Mem0 search limit was 10 unless callers provided more.
- Categories: optional model-facing text-companion filter, passed to `search_memories`; not appropriate for realtime voice.
- Output: plain text bullet strings, not structured.
- Unavailable/error handling: exceptions returned `Memory retrieval temporarily unavailable.`; empty results returned `No relevant memories found.`
- Text companion dependency: existing tests and companion construction expect the LangChain tool factory and `query + categories` schema to continue working.

## Shared Core Design

Added `backend/packages/harness/deerflow/sophia/tools/retrieve_memories_contract.py` as the dependency-safe contract/core. It imports Pydantic but no LangChain, provider SDK, deepagents, or LangGraph runtime modules.

The core exposes:

- `RealtimeRetrieveMemoriesInput` with only `query`.
- `retrieve_memories_for_realtime(user_id, query, ...)` for provider execution.
- `retrieve_memories_for_text_companion(user_id, query, categories, ...)` for the existing LangChain wrapper.
- Gemini/OpenAI declaration constants and descriptions through the contract module.

Realtime sanitization and bounds:

- Query is whitespace-normalized and capped at 240 characters.
- Empty or null-like queries return `invalid_query` without calling Mem0.
- Voice results cap at 5 memories.
- Each realtime memory text snippet caps at 280 characters.
- Null-like memory values are ignored.
- Memory IDs and provider internals are not exposed in realtime results.
- Categories remain internal implementation options and are not present in the realtime schema.

## Realtime Query-Only Contract

Tool name: `retrieve_memories`

Model-facing input:

```json
{
  "query": "What memory/context should Sophia retrieve?"
}
```

Not model-facing:

- `user_id`
- `categories`
- raw filters
- memory provider configuration
- privacy or diagnostic flags

When to call:

- The user asks what Sophia remembers.
- The user asks whether Sophia remembers a prior event or pattern.
- The user references prior context not present in the current session.
- Sophia needs deeper continuity to answer accurately.

When not to call:

- Every turn.
- Simple greetings or hearing checks.
- Facts already present in the current conversation.
- Fishing for private information unnecessarily.
- As a substitute for a clarifying question.

## Result Shape

Success:

```json
{
  "ok": true,
  "status": "success",
  "query": "gaming pressure calm cue",
  "count": 1,
  "memories": [
    {
      "text": "Luis uses the cue 'I'm in control' to stay calm during gaming pressure.",
      "category": "preference",
      "source": "long_term_memory"
    }
  ],
  "guidance": "Use these memories only if relevant to the user's current request. Do not recite them unnecessarily. If the result is missing context, ask the user directly rather than guessing."
}
```

No results:

```json
{
  "ok": true,
  "status": "no_results",
  "count": 0,
  "memories": [],
  "message": "No relevant stored memories were found. Ask the user directly if the missing context matters."
}
```

Unavailable/error:

```json
{
  "ok": false,
  "status": "unavailable",
  "count": 0,
  "memories": [],
  "message": "Memory retrieval is unavailable right now. Continue using the current conversation context."
}
```

## Text Companion Compatibility

The existing LangChain tool factory remains in place. `make_retrieve_memories_tool(user_id)` still binds `user_id` by closure and exposes `query` plus optional `categories` to the text companion. It now calls the shared core internally and keeps plain bullet-list output for successful text companion calls.

## Gemini Integration

Gemini Live now declares `retrieve_memories` through `voice/realtime/sophia_backend_tools.py` from the dependency-safe contract. It is included in the existing Gemini dogfood/production setup tool declarations because those paths already call `gemini_dogfood_tool_declarations()` when constructing setup.

Gemini tool execution is handled in `voice/realtime/gemini_tool_loop.py`:

- Trusted `user_id` comes from the dogfood/production session object.
- Any model-supplied `user_id`, `categories`, filters, or provider controls are ignored and recorded only as redacted arg names.
- Tool responses are Gemini-compatible `toolResponse.functionResponses` payloads.
- Mem0 unavailable/no-results/error states return graceful tool results instead of crashing the relay.

## GPT Realtime Compatibility

This phase does not wire `retrieve_memories` into the OpenAI/GPT production or dogfood route because there is no complete OpenAI tool-execution bridge equivalent to Gemini's backend relay yet.

It does add a tested OpenAI-compatible declaration conversion in `voice/realtime/sophia_backend_tools.py` via `openai_retrieve_memories_function_declaration()`. The next GPT phase should register that declaration in the OpenAI tool registry and execute it through trusted sideband/session context before advertising it to a real session.

## Security And Privacy Boundaries

- `user_id` is never accepted from the model-facing realtime schema.
- Trusted identity is supplied by the authenticated runtime/session only.
- Realtime schema has no `categories`, filters, provider config, or privacy flags.
- Memory text appears only in the actual tool result, where the model needs it.
- Telemetry diagnostics include status, count, latency, query length, result categories, result text lengths, provider status, cache status, and ignored arg names.
- Telemetry diagnostics do not include raw memory text, raw Mem0 payloads, raw user profile, secrets, or model-supplied user ids.
- Realtime calls disable Mem0 content-preview logging through a new `log_content_previews=False` path.

## Tests

Added/updated focused tests for:

- Empty/null-like query returning `invalid_query`.
- Query sanitization and length cap.
- Voice result count and memory text caps.
- Model-friendly `no_results`, `unavailable`, and `error` responses.
- Null-like memory values ignored.
- Internal categories usable but absent from realtime schema.
- Diagnostics not duplicating raw memory text.
- Text companion `retrieve_memories` wrapper still using bound `user_id` and categories.
- Gemini setup declaration includes query-only `retrieve_memories`.
- Gemini execution uses trusted session `user_id` and ignores model-supplied identity/category args.
- Gemini diagnostics include status/count/latency/category/lengths without raw memory text.
- OpenAI function schema conversion remains query-only.

## Manual Smoke Plan

Smoke 1 - Name, should not need tool:
User: "Sophia, what is my name?"
Expected: answer from setup context when present; no memory tool call unless genuinely needed.

Smoke 2 - Explicit memory recall:
User: "Sophia, what do you remember about me?"
Expected: Gemini calls `retrieve_memories`; answer uses at most a few relevant memories and does not dump everything.

Smoke 3 - Specific memory query:
User: "Do you remember what I use to stay calm when I'm gaming?"
Expected: likely tool call; result includes the cue if stored; answer is concise and natural.

Smoke 4 - Missing memory:
User: "Do you remember my favorite childhood movie?"
Expected: `no_results`; Sophia does not hallucinate and can ask the user.

Smoke 5 - Privacy diagnostics:
Export telemetry. Expected: status/count/latency/categories/lengths and trusted identity source only; no duplicated raw memory text in diagnostics.

## Deferred Work

- `consult_skill`
- ritual retrieval
- sideband memory writeback
- artifact 15-field migration
- builder per-step trace storage
- GPT production/dogfood execution wiring
- web/time/wait tools
- provider routing/default changes