---
title: "LangGraph Middleware Chain Pitfalls: 16 Issues Found in 51-File Sophia Agent Review"
category: logic-errors
date: 2026-03-24
tags:
  - security
  - code-review
  - middleware
  - langgraph
  - mem0
  - ai-companion
  - path-traversal
  - memory-isolation
  - async-python
  - state-reducers
severity: critical
affected_components:
  - backend/packages/harness/deerflow/agents/sophia_agent/middlewares
  - backend/packages/harness/deerflow/agents/sophia_agent/state.py
  - backend/packages/harness/deerflow/agents/sophia_agent/agent.py
  - backend/packages/harness/deerflow/sophia/mem0_client.py
  - backend/packages/harness/deerflow/sophia/tools
root_cause_type:
  - hardcoded-defaults
  - missing-input-sanitization
  - case-sensitivity
  - reducer-misuse
  - stale-reference
  - wrong-granularity
  - sync-in-async
  - insufficient-coverage
review_stats:
  files_reviewed: 51
  lines_reviewed: 3022
  agents_used: 7
  issues_found: 16
  p1_critical: 5
  p2_important: 8
  p3_nice_to_have: 3
---

# LangGraph Middleware Chain Pitfalls

A 7-agent parallel code review of the Sophia companion agent (14-middleware chain, ~3,000 lines, 51 files) caught 16 issues before merge. This document captures the patterns, root causes, and prevention strategies so they compound into faster future reviews.

## Problem Description

Building a multi-middleware LangGraph agent chain introduces a class of bugs that are invisible in unit tests but catastrophic in production. The Sophia agent — an AI voice companion handling sensitive emotional conversations — had its full middleware chain implementation reviewed by 7 specialized agents (correctness, architecture, performance, security, testing, maintainability, simplicity). The review surfaced 5 critical blockers, 8 important issues, and 3 nice-to-haves.

## Root Cause Analysis

The bugs fall into three families:

**Family 1 — Identity/Security:** Values that should be parameterized are hardcoded or unsanitized. The middleware chain passes `user_id` through multiple layers, but individual components shortcut this with defaults or construct filesystem paths without validation.

**Family 2 — State Accumulation:** LangGraph's reducer model (`Annotated[list, operator.add]`) is powerful but dangerous. Any field with an additive reducer accumulates across every iteration of the agent loop, not just across turns. Reading "before" and "after" values from the same dict yields zero delta.

**Family 3 — Environment Assumptions:** Windows case-insensitivity masks path bugs. Synchronous HTTP calls inside async middleware block the event loop. Module-level mutable dicts work in single-threaded tests but race in production.

## Critical Findings and Fixes

### P1-1: Cross-User Memory Leakage (Hardcoded user_id)

`retrieve_memories` tool used `user_id="default_user"` — all users would share the same memory space, leaking private emotional data.

**Fix:** Bind user_id at agent construction time via closure:

```python
# WRONG
@tool
def retrieve_memories(query: str) -> str:
    return search_memories(user_id="default_user", query=query)  # all users share!

# RIGHT — bound at agent construction
def make_sophia_agent(user_id: str, ...):
    @tool
    def retrieve_memories(query: str) -> str:
        return search_memories(user_id=user_id, query=query)  # captures real user
```

### P1-2: Path Traversal via Unsanitized user_id

Middlewares constructed paths like `_PROJECT_ROOT / "users" / user_id / "identity.md"` with no validation. A `user_id` of `"../../.env"` reads API keys.

**Fix:** Validate at entry + resolve-then-check:

```python
USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

def safe_user_path(base_dir: Path, user_id: str, *segments: str) -> Path:
    if not USER_ID_PATTERN.match(user_id):
        raise ValueError(f"Invalid user_id: {user_id!r}")
    target = (base_dir / user_id / Path(*segments)).resolve()
    if not target.is_relative_to(base_dir.resolve()):
        raise ValueError("Path traversal detected")
    return target
```

### P1-3: Case-Sensitive Path Mismatch

Code used `skills/public/sophia` but directory was `skills/public/Sophia`. Works on Windows, crashes on Linux (deployment target).

**Fix:** Rename directory to lowercase. Always test on case-sensitive filesystem.

### P1-4: State Reducer Causes Prompt Bloat

`system_prompt_blocks: Annotated[list[str], operator.add]` accumulates across every agent loop iteration, doubling the system prompt on each pass.

**Fix:** Remove the additive reducer:

```python
# WRONG — accumulates forever
system_prompt_blocks: Annotated[list[str], operator.add]

# RIGHT — last-write-wins, middleware rebuilds each pass
system_prompt_blocks: list[str]
```

### P1-5: Breakthrough Detection Always Returns Zero

Both `tone` and `prev_tone` read from the same `previous_artifact` dict, so `tone_delta` is always 0. The `celebrating_breakthrough` skill can never trigger.

**Fix:** Store prior tone in session data, compare across turns:

```python
# WRONG — same source, delta always 0
tone = prev.get("tone_estimate", 2.5)
prev_tone = prev.get("tone_estimate", tone)  # same value!

# RIGHT — compare current artifact against stored prior value
prev_tone = session_data.get("last_tone_estimate", 2.5)
curr_tone = current_artifact.get("tone_estimate", 2.5)
tone_delta = curr_tone - prev_tone
session_data["last_tone_estimate"] = curr_tone
```

## Important Findings (P2)

| # | Issue | Pattern | Fix |
|---|-------|---------|-----|
| 6 | sessions_total increments per-turn, not per-session | Wrong granularity | Gate on `turn_count == 0` |
| 7 | Crisis detection uses only 10 exact substrings | Insufficient coverage | Expand to 50+ patterns with normalization |
| 8 | Synchronous Mem0 HTTP call blocks async event loop | Sync-in-async | `run_in_executor()` wrapper |
| 8 | Module-level cache dict unbounded, no thread safety | Global mutable state | `cachetools.TTLCache` + `threading.Lock` |
| 8 | MemoryClient created on every cache miss | No client caching | Module-level singleton |
| 9 | API keys silently accept empty string | Missing validation | Fail fast at startup |
| 10 | 77-line SophiaSummarizationMiddleware is 100% dead code | YAGNI | Delete until needed |
| 12 | ArtifactMiddleware.after_model breaks on tool result messages | Silent failure | Remove tool result branch |
| 13 | Message content extraction duplicated 4x | DRY violation | Shared utility function |

## Key Takeaways

1. **Additive reducers in LangGraph are per-iteration, not per-turn.** Every `Annotated[list, operator.add]` field grows on each agent loop pass. Use additive reducers only for fields that genuinely need accumulation (like `messages`).

2. **"Works on Windows" is not "works."** Case-insensitive filesystems hide path bugs. Always test on Linux.

3. **Follow user_id from entry to exit.** Any component that touches user data must receive `user_id` explicitly — never from a default. One missed binding means cross-user data leakage.

4. **Sanitize at the boundary, verify at the use site.** Regex-validate `user_id` at the API entry point, then resolve-and-check the path before filesystem operations.

5. **Comparing a value to itself always yields zero.** When computing deltas, verify that the "before" and "after" values come from genuinely different sources.

6. **`before_agent` is not `on_session_start`.** In LangGraph, `before_agent` fires on every iteration of the agent loop. Gate session-level logic on `turn_count == 0`.

7. **Sync HTTP in async middleware is a silent scalability killer.** It won't fail with one concurrent user. It will block the event loop under load.

8. **Delete dead code, don't comment it out.** A middleware with constants, helpers, and a method body that returns None looks like it works. Remove it until the feature is actually built.

9. **Module-level mutable state needs a lock.** A plain `dict` cache is a race condition in any concurrent server.

## Prevention: Middleware Chain Review Checklist

Use this checklist for every PR that adds or modifies a middleware:

**State Mutation**
- [ ] Middleware only writes to state fields it owns
- [ ] No middleware reads a field written by a later middleware in the chain
- [ ] List fields with `operator.add` genuinely need accumulation (not last-write-wins)
- [ ] Module-level mutable state has a lock and size limit

**Lifecycle Awareness**
- [ ] Distinguishes "constructed once" vs "called per turn" vs "called per session"
- [ ] Session-level counters gated on `turn_count == 0`
- [ ] `skip_expensive` checked early, no expensive work on crisis path

**Identity and Isolation**
- [ ] Every user-data component receives `user_id` from config — never hardcoded
- [ ] `user_id` validated with strict regex at entry point
- [ ] All file paths resolve within expected directory

**Cross-Platform**
- [ ] All directory/file references use consistent casing
- [ ] CI runs on Linux (case-sensitive filesystem)

**Async Safety**
- [ ] No synchronous HTTP calls in middleware methods
- [ ] All blocking I/O wrapped in `run_in_executor()`

**Safety-Critical**
- [ ] Crisis detection tested with indirect expressions, not just exact matches
- [ ] False negative test suite for safety features
- [ ] Boundary detection covers common attack vectors

## Prevention: CI Additions

| Check | Catches | Effort |
|---|---|---|
| Middleware chain order assertion test | Reordering regressions | Low |
| Path traversal parameterized test suite | user_id injection | Low |
| Filesystem case-sensitivity lint | Windows-only bugs | Low |
| Sync HTTP ban in middleware directory | Event loop blocking | Low |
| Crisis detection MUST_DETECT / MUST_NOT_DETECT matrix | Safety gaps | Medium |
| Linux CI runner | All cross-platform issues | Medium |
| Coverage gate on middleware directory (>90%) | Dead code | Low |

## Cross-References

- **Implementation plan:** `docs/plans/2026-03-24-001-feat-sophia-middleware-chain-plan.md`
- **Architecture spec:** `docs/specs/04_backend_integration.md` (Section 4: middleware chain)
- **Implementation spec:** `docs/specs/06_implementation_spec.md` (Sections 2-3)
- **Memory spec:** `docs/specs/03_memory_system.md` (Mem0 categories, LRU cache)
- **Review todos:** `.context/compound-engineering/todos/001-016`
- **DeerFlow middleware patterns:** `backend/CLAUDE.md` (lead_agent middleware chain)
