# Gemini Voice Mem0 Context Degradation Audit

Date: 2026-05-24
Branch: `audit/gemini-voice-mem0-context`
Status: audit completed; Option C implemented on `fix/gemini-voice-backend-realtime-context`

## Observed Production Symptom

During Gemini Live production browser session creation, `sophia-voice` logged:

```text
gemini_live.memory_context Mem0 search function unavailable
ModuleNotFoundError: No module named 'deerflow.sophia'
gemini_live.memory_context status=empty preferred_name=False identity=False handoff=False memories=0 mem0=unavailable
```

Voice continued to work, but Gemini Live setup degraded to no trusted memory context: no preferred name, no identity excerpt, no handoff excerpt, and no Mem0 snippets.

## Intended Architecture

The checked-in realtime architecture does not intend Gemini Live to clone the full LangGraph companion middleware chain. The intended realtime parity level is selective:

- bounded setup context at session start: preferred name, identity excerpt, latest handoff excerpt, and a few Mem0 snippets;
- on-demand `retrieve_memories(query)` for explicit recall;
- offline/sideband memory writeback, not in-turn writes;
- no full Mem0 dump and no full per-turn middleware execution in the realtime audio path.

This is documented in `docs/architecture/sophia-realtime-runtime-contract.md`, `docs/audits/gemini-memory-parity-artifact-contract-phase-12-4m.md`, and `docs/audits/realtime-memory-tool-availability-phase-12-5b-c.md`.

## Confirmed Code Path

Gemini production session startup calls:

- `voice/realtime/gemini_production_session.py`
- `voice/realtime/gemini_memory_context.py::build_gemini_live_realtime_instructions_with_memory_context`
- `voice/realtime/gemini_memory_context.py::_search_mem0_memories`
- `voice/realtime/gemini_memory_context.py::_mem0_client_module`

`_mem0_client_module()` inserts `backend/packages/harness` into `sys.path` and imports:

```python
deerflow.sophia.mem0_client
```

That is the same canonical Mem0 wrapper used by text/LangGraph code. Text chat reaches it through `Mem0MemoryMiddleware` inside the `sophia_companion` LangGraph process, where the full harness package and Mem0 env are present.

Gemini Live is different: memory setup happens in the `sophia-voice` process before the Gemini setup payload is minted.

## Packaging Findings

Current `voice/Dockerfile` copies only a minimal harness subset:

- `deerflow/__init__.py`
- `deerflow/sophia/__init__.py`
- `deerflow/sophia/tools/__init__.py`
- `deerflow/sophia/tools/emit_artifact_contract.py`
- `deerflow/sophia/tools/builder_lifecycle_contract.py`
- `deerflow/sophia/tools/retrieve_memories_contract.py`

It does not copy:

- `deerflow/sophia/mem0_client.py`
- `deerflow/sophia/review_metadata_store.py`

A Docker-like temp-tree import check confirmed that the packaged contract subset can import `deerflow.sophia` and the tool contracts, but cannot import `deerflow.sophia.mem0_client`.

`voice/requirements.txt` includes `httpx`, which is enough for the Mem0 wrapper's REST fallback, but it does not include the Mem0 SDK. The wrapper was explicitly made tolerant of missing `cachetools` and missing Mem0 SDK if `MEM0_API_KEY` plus `httpx` are available.

## Env And Filesystem Findings

`render.yaml` declares `MEM0_API_KEY` for:

- `sophia-langgraph`
- `sophia-gateway`

It does not declare `MEM0_API_KEY` for:

- `sophia-voice`

Without dashboard inspection, this audit can only confirm that the voice service is not configured with `MEM0_API_KEY` from the checked-in Blueprint. If it is absent in Render, packaging `mem0_client.py` alone would change the failure from `import_error` to `missing_api_key`, not restore memory.

The same production log also showed `identity=False` and `handoff=False`. That is consistent with `voice/realtime/gemini_memory_context.py` reading local `users/{user_id}/identity.md` and `users/{user_id}/handoffs/latest.md` inside the separate `sophia-voice` container. `render.yaml` shows no shared persistent disk or mount for `users/`, and Docker intentionally does not copy runtime `users/**`.

So the degradation is not just a missing Python file. It is a service-boundary issue:

- Mem0 snippets require canonical Mem0 access from the voice process or a backend fetch.
- Identity and handoff require access to the runtime user context owned by the backend/LangGraph side, not the static voice image filesystem.

## Root Cause Candidates

Confirmed:

- `sophia-voice` packages a partial `deerflow.sophia` namespace for dependency-safe tool contracts, but not the canonical Mem0 client.
- `voice/realtime/gemini_memory_context.py` directly imports `deerflow.sophia.mem0_client`; in the current voice image shape, that module path is absent.
- `sophia-voice` does not declare `MEM0_API_KEY` in `render.yaml`.
- `sophia-voice` does not have a shared `users/` runtime filesystem in `render.yaml`, so identity and handoff reads are expected to be empty in production.

Likely but not directly verifiable from this repo:

- The exact production traceback `No module named 'deerflow.sophia'` may have come from an image before the latest dependency-safe contract package was deployed. With the current Dockerfile subset, the expected next import error is `No module named 'deerflow.sophia.mem0_client'`.

## Does Voice Currently Run Without Mem0?

From code evidence, yes: when `_mem0_client_module()` import fails, `_search_mem0_memories()` catches the exception, logs `Mem0 search function unavailable`, returns no snippets, and sets diagnostics to `mem0_status="unavailable"` with `mem0_provider_reason="import_error"`.

Gemini Live session startup continues by design. This is a graceful degradation path, not a fatal voice outage.

## Fix Options

### Option A - Package The Canonical Mem0 Client Into Voice

What it would require:

- Copy `deerflow/sophia/mem0_client.py`.
- Also copy `deerflow/sophia/review_metadata_store.py`, because `mem0_client.py` imports it at module load.
- Declare `MEM0_API_KEY` for `sophia-voice` in Render or otherwise provide it.
- Add Docker/static tests and import/status tests.

Pros:

- Smallest path to restore setup-time Mem0 snippets and realtime `retrieve_memories`.
- Reuses canonical search/status behavior and the existing REST fallback through `httpx`.

Risks:

- Puts Mem0 credentials into the voice service.
- Still does not fix identity/handoff context, because those are local `users/` files absent from the voice container.
- `mem0_client.py` imports local review metadata code and starts a warmup thread at import time, which is acceptable but not as dependency-minimal as the current contract-only package.

### Option B - Add A Voice-Native Mem0 Adapter

Pros:

- Could be very small and avoid copying backend modules.

Risks:

- Duplicates canonical memory logic.
- Reintroduces schema/category/status drift.
- Conflicts with the existing decision to share provider-safe Mem0 status/search through the canonical wrapper.

### Option C - Fetch Memory Context Through Gateway/LangGraph

Pros:

- Best architectural fit for production service boundaries.
- Keeps Mem0 credentials and runtime user files on the backend side.
- Can return one bounded, privacy-safe setup-context payload covering Mem0, identity, handoff, and diagnostics.
- Avoids expanding the voice image into a partial backend runtime.

Risks:

- Larger change than packaging.
- Adds a setup-time network call before Gemini token minting.
- Needs authentication/service-to-service rules and focused tests.

### Option D - Keep Memory Optional, Improve Observability Only

Pros:

- Lowest behavior risk.
- Aligns with the current graceful-degradation behavior.

Risks:

- Leaves Gemini Live without one of Sophia's core continuity signals.
- Production could look healthy while silently losing memory/personality context.

## Recommendation

Choose Option C as the safest architectural fix: add a backend-owned, bounded realtime context endpoint (or equivalent LangGraph/gateway helper) that returns the exact setup context Gemini needs. The backend side already owns Mem0 configuration, user identity/handoff files, review metadata overlays, and the canonical memory wrapper.

If a faster interim fix is needed, use a constrained Option A only for Mem0 read availability: package `mem0_client.py` plus `review_metadata_store.py`, add `MEM0_API_KEY` to the voice service, and test that missing SDK uses REST fallback. Treat it as partial because identity and handoff will remain unavailable unless fetched from backend or a shared store.

Do not choose Option B. It duplicates memory logic. Option D is acceptable only as a deliberate product decision to run Gemini Live without continuity, with loud diagnostics.

## Implementation Follow-up

The follow-up fix implements Option C with a backend-owned realtime context path.

- Added `backend/app/gateway/sophia_realtime_context.py`, which assembles a bounded `sophia_realtime_context_v1` payload from backend-owned identity, latest handoff, review-metadata-filtered Mem0 snippets, and safe diagnostics.
- Added the protected `POST /api/sophia/{user_id}/realtime/context` endpoint for explicit backend callers. It uses the existing user-scoped Sophia gateway auth dependency; there is no unauthenticated memory-context route and no new service-token environment variable.
- Updated authenticated gateway voice connect so the production Gemini path builds the same context in-process and passes it to `POST /production/realtime/gemini/browser-sessions` as `realtime_context`.
- Updated `sophia-voice` Gemini production startup so `voice/realtime/gemini_memory_context.py` consumes only that payload. The production setup path no longer imports `deerflow.sophia.mem0_client` and no longer reads local `users/**` files.
- If context fetch fails, gateway sends a degraded payload with `context_fetch_status="error"`, `mem0_status="error"`, `identity_available=false`, `handoff_available=false`, and `memory_count=0`; voice then builds the session with empty context like the previous graceful-degradation path.

Remaining limitations:

- The setup context is still session-start-only for Gemini Live; deeper explicit recall remains the job of the existing `retrieve_memories(query)` tool.
- Direct dogfood/session-manager use without a gateway-provided payload intentionally degrades to empty setup context.
- The endpoint and helper are read-only. Mem0 writes, recap, handoff updates, and identity updates remain offline/backend responsibilities.

## Files Implicated

- `voice/realtime/gemini_memory_context.py`
- `voice/realtime/gemini_production_session.py`
- `voice/realtime/gemini_browser_dogfood.py`
- `voice/realtime/sophia_backend_tools.py`
- `voice/Dockerfile`
- `.dockerignore`
- `voice/requirements.txt`
- `render.yaml`
- `backend/packages/harness/deerflow/sophia/mem0_client.py`
- `backend/packages/harness/deerflow/sophia/review_metadata_store.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_memory.py`
- `backend/packages/harness/deerflow/sophia/tools/retrieve_memories_contract.py`

## Validation Performed

- Mandatory git safety checks confirmed no staged files before branch creation.
- Inspected Gemini memory-context code and voice search results, excluding `.venv`.
- Inspected canonical backend Mem0 client, text companion Mem0 middleware, and realtime memory contract.
- Inspected `voice/Dockerfile`, `.dockerignore`, `voice/requirements.txt`, and `render.yaml`.
- Reviewed recent packaging commit `866fbd10` and its Docker/test changes.
- Ran a Docker-like temp-tree import check proving the current copied contract subset does not include `deerflow.sophia.mem0_client`.

No runtime `users/**`, `backend/users/**`, real env files, `config.yaml`, prompt files, artifacts, Builder code, recap code, gateway routing, frontend UI, or runtime JSON files were modified.
