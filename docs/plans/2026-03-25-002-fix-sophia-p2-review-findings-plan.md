---
title: "fix: Resolve P2 review findings across Sophia middleware chain"
type: fix
status: active
date: 2026-03-25
---

# fix: Resolve P2 review findings across Sophia middleware chain

## Overview

Three review rounds identified 12 P2 findings across correctness, safety, performance, and code quality. This plan addresses the highest-impact items grouped into 6 implementation units.

## Problem Frame

The Sophia middleware chain is functionally correct for its P1 concerns (fixed in prior commits), but has secondary issues: off-by-one in skill selection, dead code that misleads reviewers, unsafe threading patterns, and safety detection with trivially bypassed substring matching.

## Requirements Trace

- R1. `_select_skill` must use current-turn session data, not stale state
- R2. `ArtifactMiddleware.after_model` must reliably capture artifact data regardless of ToolMessage ordering
- R3. `SophiaSummarizationMiddleware` dead code must be removed
- R4. Mem0 cache must be thread-safe with bounded size
- R5. `MemoryClient` must be cached at module level (not recreated per call)
- R6. Unused constants in `emit_artifact.py` must be removed
- R7. `sessions_total` must increment per-session, not per-turn
- R8. Crisis detection must cover common variations beyond 10 exact substrings

## Scope Boundaries

- NOT fixing: sync Mem0 call (requires async middleware hooks — deferred to integration phase)
- NOT fixing: PromptAssemblyMiddleware + add_messages reducer interaction (needs LangGraph runtime verification)
- NOT fixing: `_PROJECT_ROOT` centralization (low risk, all callers already use `_USERS_DIR`)
- NOT fixing: switch_to_builder stub (will be replaced during builder integration)
- NOT fixing: boundary detection patterns (will be addressed alongside crisis detection in a dedicated safety PR)

## Context & Research

### Relevant Code and Patterns

- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/skill_router.py` — stale state bug, sessions_total bug
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py` — dead ToolMessage branch
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/summarization.py` — entire file is dead code
- `backend/packages/harness/deerflow/sophia/mem0_client.py` — cache + client issues
- `backend/packages/harness/deerflow/sophia/tools/emit_artifact.py` — unused constants
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/crisis_check.py` — substring matching

### Institutional Learnings

- `docs/solutions/logic-errors/langgraph-middleware-chain-review-pitfalls.md` — documents all findings
- `docs/solutions/logic-errors/langgraph-state-reducer-removal-breaks-accumulation.md` — reducer semantics

## Key Technical Decisions

- **Remove SophiaSummarizationMiddleware entirely**: It's 100% dead code. Will be recreated when Unit 14 integration begins.
- **Use `cachetools.TTLCache` for Mem0 cache**: Provides bounded size + TTL + thread-safe with Lock wrapper. Avoids adding a new dependency if `cachetools` is already available; otherwise a simple manual bounded dict suffices.
- **Expand crisis signals to ~30 patterns with text normalization**: Balance between false negatives (safety risk) and false positives (routing normal speech to crisis). Add common abbreviations and indirect expressions while excluding clearly metaphorical usage.
- **Pass `sd` to `_select_skill` as parameter**: Simplest fix — avoids re-reading from state.

## Open Questions

### Resolved During Planning

- **Should sessions_total track actual sessions or turns?** Sessions. Gate increment on `turn_count == 0`. The TRUST_SESSION_THRESHOLD name implies sessions.
- **Should we add `cachetools` as a dependency?** Check if it's already in the dependency tree. If not, a manual bounded dict with Lock is simpler and avoids a new dep.

### Deferred to Implementation

- **Exact expanded crisis signal list**: Research crisis intervention literature during implementation. Start with common variations, abbreviations, and indirect expressions.
- **Whether `cachetools` is already a transitive dependency**: Check `uv pip list` during implementation.

## Implementation Units

- [ ] **Unit 1: Fix stale session data in SkillRouterMiddleware**

**Goal:** `_select_skill` uses current-turn session data for trust and complaint checks

**Requirements:** R1, R7

**Dependencies:** None

**Files:**
- Modify: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/skill_router.py`
- Modify: `backend/tests/test_sophia_middlewares.py`

**Approach:**
- Change `_select_skill(self, state)` signature to `_select_skill(self, state, session_data)`
- Pass the already-updated `sd` dict from `before_agent` instead of re-reading from state
- Gate `sessions_total` increment on `state.get("turn_count", 0) == 0`
- This also makes `last_tone_estimate` correctly read the value stored by the previous turn (which is already in `sd` from the state)

**Patterns to follow:**
- Existing pattern of `sd = dict(state.get("skill_session_data") or _init_session_data())` — keep this, just pass `sd` forward

**Test scenarios:**
- Trust kicks in on the 5th session's first turn (not the 5th message)
- `sessions_total` does NOT increment on turn_count > 0
- `_select_skill` sees the current turn's trust_established value
- Breakthrough detection still works (last_tone_estimate from previous turn)

**Verification:**
- All existing skill router tests pass
- New tests verify per-session increment and current-turn trust check

---

- [ ] **Unit 2: Fix ArtifactMiddleware dead ToolMessage branch**

**Goal:** `after_model` reliably captures artifact data from AIMessage tool_calls

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py`
- Modify: `backend/tests/test_sophia_middlewares.py`

**Approach:**
- Remove the ToolMessage branch (lines 72-79) from the reversed message scan
- The artifact data is only in the AIMessage's `tool_calls` args, not in the ToolMessage response
- The ToolMessage branch was dead code that caused early exit via `break`

**Test scenarios:**
- after_model captures artifact when AIMessage has emit_artifact tool_call
- after_model captures artifact when ToolMessage for emit_artifact precedes AIMessage in reversed scan
- after_model returns None when no emit_artifact tool_call exists
- previous_artifact is correctly rotated from current_artifact

**Verification:**
- Artifact capture works regardless of message ordering in the list

---

- [ ] **Unit 3: Remove SophiaSummarizationMiddleware + unused emit_artifact constants**

**Goal:** Remove dead code that misleads reviewers

**Requirements:** R3, R6

**Dependencies:** None

**Files:**
- Delete: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/summarization.py`
- Modify: `backend/packages/harness/deerflow/agents/sophia_agent/agent.py` (remove import + chain entry)
- Modify: `backend/packages/harness/deerflow/sophia/tools/emit_artifact.py` (remove TONE_BANDS, SKILLS, VOICE_SPEEDS)

**Approach:**
- Delete the entire `summarization.py` file — all its code is unreachable
- Remove `SophiaSummarizationMiddleware` from the middleware list in `agent.py`
- Add a comment in `agent.py` noting summarization will hook into DeerFlow's built-in middleware during integration
- Remove the 3 unused list constants from `emit_artifact.py`

**Test scenarios:**
- Agent factory creates successfully without summarization middleware
- All existing tests pass (none test summarization since it's a no-op)

**Verification:**
- `summarization.py` no longer exists
- `agent.py` middleware list has 16 items instead of 17
- `emit_artifact.py` has no unused module-level constants

---

- [ ] **Unit 4: Thread-safe bounded Mem0 cache + client singleton**

**Goal:** Mem0 cache is thread-safe with bounded size; MemoryClient is cached

**Requirements:** R4, R5

**Dependencies:** None

**Files:**
- Modify: `backend/packages/harness/deerflow/sophia/mem0_client.py`
- Create: `backend/tests/test_mem0_client.py`

**Approach:**
- Replace module-level `_cache` dict with a bounded TTL cache (manual implementation with Lock if `cachetools` is not available)
- Add `threading.Lock` around cache reads/writes
- Cache the `MemoryClient` instance at module level (create once, reuse)
- Add `maxsize` parameter (256 entries) to prevent unbounded growth
- Move the deferred import of `MemoryClient` to module level with a lazy initialization pattern

**Patterns to follow:**
- The existing `_cache` TTL logic — preserve the 60-second TTL and invalidation API

**Test scenarios:**
- Cache hit returns same results within TTL
- Cache miss triggers API call
- Cache expires after TTL
- `invalidate_user_cache` clears matching entries
- Cache does not grow beyond maxsize
- MemoryClient is created only once
- search_memories returns [] when MEM0_API_KEY is unset
- Both dict-with-results and raw-list response formats are normalized

**Verification:**
- All cache tests pass
- No module-level mutable dict without Lock protection

---

- [ ] **Unit 5: Expand crisis detection signals**

**Goal:** Crisis detection catches common variations beyond exact substrings

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/crisis_check.py`
- Modify: `backend/tests/test_sophia_middlewares.py`

**Approach:**
- Expand `CRISIS_SIGNALS` from 10 to ~30 patterns covering: common abbreviations ("kms", "ctb"), indirect expressions ("don't want to be alive", "better off dead", "no reason to live", "everyone would be better off without me"), and mild variations ("wanna die", "end my life")
- Add text normalization before matching: collapse repeated characters, strip non-alphanumeric (except spaces), lowercase
- Keep the existing exact-match approach but with normalized text — avoid a full classifier at this stage
- Do NOT add patterns that would false-positive on metaphorical usage ("killing it", "dying of laughter")

**Execution note:** Research crisis intervention phrasing during implementation to ensure coverage of clinically documented expressions.

**Test scenarios:**
- All original 10 signals still detected
- Common abbreviations detected ("kms", "ctb")
- Indirect expressions detected ("don't want to be alive", "better off dead")
- Metaphorical usage NOT detected ("killing it", "dying of laughter", "this traffic is killing me")
- Text normalization handles: extra spaces, mixed case, repeated characters ("I wannna dieee")
- Embedded in longer text: "honestly I just want to die sometimes" → detected

**Verification:**
- All crisis detection tests pass including new parameterized matrix
- No false positives on the must-not-detect list
- All must-detect patterns caught

---

- [ ] **Unit 6: Move deferred import in Mem0MemoryMiddleware to module level**

**Goal:** Clean up deferred import pattern

**Requirements:** Code quality

**Dependencies:** Unit 4 (mem0_client changes should land first)

**Files:**
- Modify: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_memory.py`

**Approach:**
- Move `from deerflow.sophia.mem0_client import search_memories` from inside `before_agent` to module-level import
- Verify no circular import exists (unlikely given the dependency direction)

**Test scenarios:**
- Module imports successfully
- Existing Mem0 middleware tests pass

**Verification:**
- No `import` statement inside method bodies in `mem0_memory.py`

## Risks & Dependencies

- **Crisis signal expansion requires care**: Over-expanding could route normal emotional language through the crisis path (which skips expensive middlewares). The must-not-detect test list is critical.
- **Cache threading changes**: Lock contention under high load could slow requests. The Lock is held only for dict operations (microseconds), so this is negligible.
- **Removing summarization middleware**: If DeerFlow's built-in `SummarizationMiddleware` is somehow invoked for Sophia graphs, the slot is gone. But Sophia uses `create_agent()` not the lead_agent factory, so DeerFlow's middleware is not injected.

## Sources & References

- Review findings: `docs/solutions/logic-errors/langgraph-middleware-chain-review-pitfalls.md`
- Prior P1 fix plan: `docs/plans/2026-03-24-002-fix-sophia-p1-critical-review-findings-plan.md`
- Related code: `backend/packages/harness/deerflow/agents/sophia_agent/`
