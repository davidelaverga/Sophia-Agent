---
title: "feat: Implement Sophia 7-step offline pipeline"
type: feat
status: active
date: 2026-03-27
---

# feat: Implement Sophia 7-step offline pipeline

## Overview

Implement the 7-step offline pipeline that fires when a Sophia session ends (WebRTC disconnect or 10-minute inactivity). The pipeline extracts memories, generates smart openers, writes handoffs, logs traces, and conditionally updates the user identity file — all using Claude Haiku for LLM steps. This is the bridge between sessions: what makes Sophia remember, learn, and arrive prepared.

## Problem Frame

The middleware chain is live and working end-to-end. Sophia can converse with emotional attunement, skill routing, tone tracking, and artifact emission. But when a session ends, nothing is preserved. The next session starts cold — no memory extraction, no handoff context, no smart opener. The offline pipeline is what closes this loop: it processes the completed session asynchronously and prepares the ground for the next one.

## Requirements Trace

- R1. Pipeline fires on session end (WebRTC disconnect or 10-min inactivity) and processes the completed session
- R2. Pipeline is idempotent — safe to run twice on the same session via `processed_sessions` deduplication
- R3. Smart opener generated from session context + Mem0 memories, stored in handoff frontmatter
- R4. Handoff written to `users/{user_id}/handoffs/latest.md` — always overwritten, never accumulated
- R5. Mem0 extraction writes memories with `status: "pending_review"` and full metadata (tone_estimate, importance, platform, context_mode)
- R6. Cache invalidated after Mem0 writes via `invalidate_user_cache(user_id)`
- R7. Trace file written per-session to `users/{user_id}/traces/{session_id}.json` with per-turn records
- R8. Identity file updated conditionally (every 10 sessions OR on structural memory change)
- R9. All LLM calls use Claude Haiku (`claude-haiku-4-5-20251001`)
- R10. All file paths use `safe_user_path()` for traversal protection
- R11. Pipeline prompt templates live in `sophia/prompts/`, never in `skills/public/sophia/`

## Scope Boundaries

- **In scope:** Steps 1-3, 5-7 of the offline pipeline (smart opener, handoff, extraction, traces, identity update, visual artifact check)
- **Out of scope:** Step 4 (in-app notification) — requires frontend notification infrastructure not yet built. Log the notification intent instead.
- **Out of scope:** GEPA (`gepa.py`, `bootstrap.py`) — Week 6+ per spec
- **Out of scope:** Gateway endpoints (`/api/sophia/{user_id}/...`) — separate plan
- **Out of scope:** Reflect flow (`reflection.py`) — depends on gateway endpoints
- **Deferred:** `golden_turns.py` — trace logging captures the data, golden turn selection is GEPA preparation (Week 6+)

## Context & Research

### Relevant Code and Patterns

- `deerflow/agents/memory/queue.py` — Debounced queue with per-thread dedup, `threading.Timer`, global singleton via `get_memory_queue()`. Reference pattern for session-end triggering.
- `deerflow/agents/memory/updater.py` — LLM-based extraction with atomic file I/O (temp file + rename), JSON parse with markdown stripping. Reference for extraction.py.
- `deerflow/sophia/mem0_client.py` — Thread-safe TTLCache + singleton client. Already has `search_memories()` and `invalidate_user_cache()`. Needs `add_memories()` for extraction writes.
- `deerflow/agents/sophia_agent/paths.py` — Centralized `PROJECT_ROOT`, `SKILLS_PATH`, `USERS_DIR`.
- `deerflow/agents/sophia_agent/utils.py` — `safe_user_path()`, `validate_user_id()`, `extract_last_message_text()`.
- `deerflow/agents/sophia_agent/middlewares/session_state.py` — Already reads handoffs and injects smart openers. The pipeline writes what this middleware reads.
- `deerflow/agents/sophia_agent/middlewares/artifact.py` — Captures `current_artifact` and `previous_artifact` per turn. Source for trace data.

### Institutional Learnings

- **LangGraph reducer semantics** (docs/solutions/logic-errors): `operator.add` is required for multi-node accumulation. Test against actual LangGraph runtime, not manual dict simulation.
- **Sync-in-async** (docs/solutions/logic-errors): Wrap synchronous Mem0 HTTP calls in `run_in_executor()`. Same applies to all pipeline LLM calls if pipeline runs in async context.
- **Session-level gating** (docs/solutions/logic-errors): Use explicit `turn_count == 0` or `processed_sessions` checks — don't rely on middleware lifecycle assumptions.
- **Path traversal**: All user file operations must use `safe_user_path()`.

### Existing Prompt Templates

4 of 5 templates already exist and are production-quality:
- `prompts/mem0_extraction.md` — 9-category extraction with importance scoring ✅
- `prompts/session_state_assembly.md` — Handoff generation with YAML frontmatter ✅ (note: still has `{mem0_cross_platform_memories}` placeholder — keep for now, it's valid per spec 03 section 8.1)
- `prompts/identity_file_update.md` — 6-section identity with behavioral rules ✅
- `prompts/reflect_prompt.md` — Reflect flow ✅ (out of scope for this plan)
- `prompts/smart_opener_assembly.md` — **MISSING** — must create (no `{cross_platform_memories}` per CLAUDE.md v7.0)

## Key Technical Decisions

- **Use direct `anthropic.Anthropic` SDK for pipeline LLM calls**: Pipeline steps are fire-and-forget with a fixed model (Haiku). Direct SDK is simpler than `ChatAnthropic` and avoids LangChain overhead. Add `anthropic` to pyproject.toml deps (the `langchain-anthropic` package already pulls it in, but make it explicit).
- **Pipeline runs synchronously in a background thread**: Triggered by voice layer disconnect callback or inactivity timer. Wrapping in `asyncio.run_in_executor()` from the async LangGraph context. Internal pipeline steps are synchronous — simpler error handling, no async/await complexity.
- **Session transcript retrieved via LangGraph SDK**: Use `langgraph_sdk.Client().threads.get_state(thread_id)` to get the full state including messages, artifacts, and session data. This is how the voice layer will call it.
- **Idempotency via module-level `processed_sessions: set[str]`**: Simple, sufficient for single-process. If multi-process is needed later, upgrade to file-based marker.
- **Atomic file writes for handoffs and identity**: Temp file + rename pattern from DeerFlow's `updater.py`. Prevents partial writes on crash.

## Open Questions

### Resolved During Planning

- **How does the pipeline get triggered?** Via `run_offline_pipeline(user_id, session_id, thread_id)` called from the voice layer's disconnect handler or inactivity timer. The pipeline itself doesn't manage triggers.
- **What model for pipeline LLM calls?** Claude Haiku per spec. All steps use the same model.
- **Where does session count live?** Count trace files in `users/{user_id}/traces/` — each session produces exactly one trace file. No separate counter needed.

### Deferred to Implementation

- **Exact Mem0 SDK `client.add()` behavior**: The add API may return memory IDs or not. Handle both cases gracefully.
- **Smart opener quality**: The prompt template will be refined based on real outputs. Start with spec's example prompt.
- **Visual artifact check (Step 7)**: Log the intent; actual visual generation depends on frontend infrastructure.

## Implementation Units

- [ ] **Unit 1: Add Mem0 write capability to mem0_client.py**

**Goal:** Enable the offline pipeline to write memories to Mem0 (currently only reads exist).

**Requirements:** R5, R6

**Dependencies:** None

**Files:**
- Modify: `backend/packages/harness/deerflow/sophia/mem0_client.py`
- Test: `backend/tests/test_mem0_client.py`

**Approach:**
- Add `add_memories(user_id, messages, session_id, metadata)` function
- Use the Mem0 SDK `client.add()` with `agent_id="sophia_companion"`, full metadata dict
- Thread-safe: acquire lock, call SDK, invalidate cache, release lock
- Graceful fallback: return empty list if Mem0 unavailable
- Follow the existing `search_memories` pattern (singleton client, try/except, logging)

**Patterns to follow:**
- `search_memories()` in the same file — same error handling, same client access pattern

**Test scenarios:**
- Successful add returns memory IDs
- Add with Mem0 unavailable returns empty list gracefully
- Cache is invalidated after successful add
- Metadata (tone_estimate, importance, platform, status) is passed through

**Verification:**
- `add_memories()` callable from extraction.py with correct signature

---

- [ ] **Unit 2: Create smart_opener_assembly.md prompt template**

**Goal:** The only missing prompt template. Generates a single warm opening sentence for the next session.

**Requirements:** R3, R11

**Dependencies:** None

**Files:**
- Create: `backend/packages/harness/deerflow/sophia/prompts/smart_opener_assembly.md`

**Approach:**
- Follow the smart opener spec in `docs/specs/03_memory_system.md` section 7.2
- Input placeholders: `{session_summary}`, `{recent_memories}`, `{last_handoff}`, `{days_since_last_session}`
- Output: a single sentence, no quotes, no preamble
- Must NOT reference `{cross_platform_memories}` per CLAUDE.md v7.0
- Include good/bad opener examples from the spec

**Test scenarios:**
- Template renders with all placeholders filled
- Template renders with optional placeholders empty (graceful)

**Verification:**
- File exists at the correct path, parseable as markdown with placeholder syntax

---

- [ ] **Unit 3: Implement trace_logger.py**

**Goal:** Write per-turn trace records for a completed session. Traces are the ground truth for GEPA and tone analysis.

**Requirements:** R7, R10

**Dependencies:** None

**Files:**
- Create: `backend/packages/harness/deerflow/sophia/trace_logger.py`
- Test: `backend/tests/test_trace_logger.py`

**Approach:**
- `write_session_trace(user_id, session_id, messages, artifacts)` → writes JSON file
- Path: `users/{user_id}/traces/{session_id}.json` via `safe_user_path()`
- Extract per-turn records by iterating messages and matching `emit_artifact` tool calls
- Each trace record follows the schema from CLAUDE.md: turn_id, timestamp, tone_before/after/delta, is_golden_turn (delta >= 0.5), voice_emotion, skill_loaded, etc.
- Atomic write: temp file + rename
- Create parent directories if missing

**Patterns to follow:**
- `deerflow/agents/memory/updater.py` — atomic file I/O pattern
- Trace schema from CLAUDE.md

**Test scenarios:**
- Happy path: messages with 3 emit_artifact calls → 3 trace records
- Golden turn detection: tone_delta >= 0.5 → `is_golden_turn: true`
- Missing artifacts: turns without emit_artifact → skip or record with defaults
- Path traversal: invalid user_id rejected
- Idempotent: writing same trace twice produces identical file

**Verification:**
- JSON file at expected path, parseable, matches trace schema

---

- [ ] **Unit 4: Implement extraction.py**

**Goal:** Extract memories from a completed session transcript using Claude Haiku + the mem0_extraction.md prompt template.

**Requirements:** R5, R6, R9

**Dependencies:** Unit 1 (add_memories)

**Files:**
- Create: `backend/packages/harness/deerflow/sophia/extraction.py`
- Test: `backend/tests/test_extraction.py`

**Approach:**
- `extract_session_memories(user_id, session_id, messages, session_metadata)` → list of memory dicts
- Load `mem0_extraction.md` template, fill placeholders with session transcript + metadata
- Call Claude Haiku via direct Anthropic SDK
- Parse JSON response (strip markdown code blocks if present)
- For each extracted memory: call `add_memories()` with category, importance, metadata including `status: "pending_review"`
- Return list of written memory records for trace logging

**Patterns to follow:**
- `deerflow/agents/memory/updater.py` — JSON parse with markdown stripping
- `mem0_extraction.md` template — 9-category schema

**Test scenarios:**
- Mock Anthropic SDK response with 3 memories → 3 Mem0 writes
- Malformed JSON response → graceful fallback (log error, return empty list)
- Empty transcript → skip extraction, return empty list
- All metadata fields passed through to Mem0

**Verification:**
- Memories written to Mem0 with correct metadata. Cache invalidated.

---

- [ ] **Unit 5: Implement handoffs.py + smart_opener.py**

**Goal:** Generate the session handoff document and smart opener for the next session.

**Requirements:** R3, R4, R9, R10

**Dependencies:** Unit 2 (prompt template), Unit 4 (extraction provides memory context)

**Files:**
- Create: `backend/packages/harness/deerflow/sophia/handoffs.py`
- Create: `backend/packages/harness/deerflow/sophia/smart_opener.py`
- Test: `backend/tests/test_handoffs.py`

**Approach:**
- `generate_handoff(user_id, session_id, messages, artifacts, extracted_memories)` → writes handoff file
  - Load `session_state_assembly.md` template, fill with session summary
  - Call Claude Haiku to generate handoff markdown
  - Write to `users/{user_id}/handoffs/latest.md` via `safe_user_path()`, atomic write
- `generate_smart_opener(user_id, session_summary, recent_memories, last_handoff)` → opener string
  - Load `smart_opener_assembly.md` template
  - Call Claude Haiku
  - Return single sentence (strip quotes/preamble)
- Smart opener is embedded in handoff YAML frontmatter: `smart_opener: "..."`
- Handoff always overwrites — never accumulated

**Patterns to follow:**
- `session_state.py` middleware — reads what handoffs.py writes (YAML frontmatter regex)
- `deerflow/agents/memory/updater.py` — atomic file writes

**Test scenarios:**
- Handoff file written with correct YAML frontmatter including smart_opener field
- SessionStateMiddleware can parse the generated handoff (round-trip test)
- Missing user directory → created automatically
- Empty session → minimal handoff with generic opener

**Verification:**
- `SessionStateMiddleware.before_agent()` successfully reads the generated handoff and injects the smart opener

---

- [ ] **Unit 6: Implement identity.py**

**Goal:** Conditionally update the user identity file based on session count and structural memory changes.

**Requirements:** R8, R9, R10

**Dependencies:** Unit 3 (trace files for session counting), Unit 4 (extraction for structural memories)

**Files:**
- Create: `backend/packages/harness/deerflow/sophia/identity.py`
- Test: `backend/tests/test_identity.py`

**Approach:**
- `maybe_update_identity(user_id, extracted_memories, force=False)` → bool (whether updated)
- Count sessions by counting trace files in `users/{user_id}/traces/`
- Trigger conditions: `sessions_since_update >= 10` OR any extracted memory with `importance == "structural"` OR `force=True`
- Load `identity_file_update.md` template, fill with current identity + recent memories
- Call Claude Haiku to generate updated identity markdown
- Write to `users/{user_id}/identity.md` via `safe_user_path()`, atomic write
- Track last update session count (store in identity file frontmatter or a marker file)

**Test scenarios:**
- 10 trace files exist → update triggered
- Structural memory extracted → update triggered regardless of count
- 5 trace files, no structural memory → no update
- Missing identity file → create from scratch
- Identity file content follows the 6-section schema from the template

**Verification:**
- `UserIdentityMiddleware.before_agent()` successfully reads the generated identity file

---

- [ ] **Unit 7: Implement offline_pipeline.py (orchestrator)**

**Goal:** Wire all steps together into the main `run_offline_pipeline()` function that processes a completed session.

**Requirements:** R1, R2, all others transitively

**Dependencies:** Units 1-6

**Files:**
- Create: `backend/packages/harness/deerflow/sophia/offline_pipeline.py`
- Test: `backend/tests/test_offline_pipeline.py`

**Approach:**
- `run_offline_pipeline(user_id, session_id, thread_id)` — main entry point
- Module-level `_processed_sessions: set[str]` for idempotency
- Retrieve session state via LangGraph SDK or checkpointer
- Execute steps in order: trace → extraction → smart opener → handoff → identity → visual check
- Each step wrapped in try/except — failure in one step doesn't block others (log and continue)
- Step 4 (notification): log intent only ("Memory candidates ready for review")
- Step 7 (visual check): log intent only ("Visual artifact check: {sessions_this_week} sessions this week")
- Return a summary dict with step results for the caller

**Patterns to follow:**
- `deerflow/agents/memory/queue.py` — background processing pattern
- Spec pseudocode in `docs/specs/06_implementation_spec.md` section 5

**Test scenarios:**
- Happy path: all 7 steps execute, summary shows success
- Idempotent: second call with same session_id is no-op
- Step failure isolation: extraction fails → handoff still generates
- Missing thread state → graceful abort with error message
- Invalid user_id → rejected at entry via `validate_user_id()`

**Verification:**
- After pipeline runs: trace file exists, handoff exists with smart opener, Mem0 memories written, identity updated if conditions met
- Second run is no-op (idempotent)

## System-Wide Impact

- **Interaction graph:** Pipeline is called by the voice layer's disconnect handler. It reads thread state (LangGraph), writes to Mem0 (external API), and writes files that the middleware chain reads on next session start (handoffs, identity).
- **Error propagation:** Each pipeline step is independent — failure in one must not block others. Log errors, continue to next step. Return summary to caller.
- **State lifecycle risks:** Handoff is always overwritten (not accumulated). Identity file is conditionally overwritten. Trace files are append-only (one per session). Mem0 writes are additive. No deletion risk.
- **API surface parity:** The pipeline writes files that `SessionStateMiddleware` and `UserIdentityMiddleware` already read — round-trip compatibility is essential.
- **Integration coverage:** Unit tests can verify each step in isolation. Integration test should verify the full pipeline writes files that the middleware chain successfully reads on the next session.

## Risks & Dependencies

- **Mem0 SDK `client.add()` API**: We haven't called write operations yet. The exact response format and error cases need to be discovered during implementation.
- **LangGraph thread state retrieval**: Getting the full conversation transcript from a thread_id. Need to verify the LangGraph SDK or checkpointer provides this.
- **Claude Haiku prompt quality**: The extraction and smart opener prompts may need iteration based on real outputs. The templates exist but haven't been tested with real sessions.
- **File I/O concurrency**: If two sessions end simultaneously for the same user, both pipelines could write to the same handoff/identity file. The atomic write pattern (temp + rename) prevents corruption but the last writer wins. Acceptable for MVP.

## Documentation / Operational Notes

- Update CLAUDE.md if any pipeline behavior differs from the spec
- The `processed_sessions` set is in-memory only — if the LangGraph server restarts, sessions could be re-processed. This is safe because the pipeline is idempotent (overwrites produce the same result).
- Monitor Mem0 API latency during extraction — this is the slowest pipeline step

## Sources & References

- Spec: `docs/specs/03_memory_system.md` — Pipeline steps, smart opener, handoff schema, identity triggers
- Spec: `docs/specs/04_backend_integration.md` — Session end detection, pipeline integration points
- Spec: `docs/specs/06_implementation_spec.md` section 5 — Pipeline pseudocode
- Learning: `docs/solutions/logic-errors/langgraph-middleware-chain-review-pitfalls.md` — Async safety, path traversal, session gating
- Pattern: `deerflow/agents/memory/queue.py` — Background processing
- Pattern: `deerflow/agents/memory/updater.py` — LLM extraction + atomic file I/O
