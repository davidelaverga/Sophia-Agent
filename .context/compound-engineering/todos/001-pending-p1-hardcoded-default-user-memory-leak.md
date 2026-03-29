---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, security, correctness]
dependencies: []
---

# Cross-User Memory Leakage via Hardcoded user_id

## Problem Statement

The `retrieve_memories` tool hardcodes `user_id="default_user"` on every invocation, regardless of the actual user. All memory lookups go to the wrong user. In a multi-user deployment, User B receives User A's private emotional memories. This is both a privacy breach and a correctness bug affecting the most sensitive data the system holds.

## Findings

- **Security agent (CRITICAL-1):** Every user who invokes retrieve_memories queries and receives memories belonging to "default_user". No injection mechanism exists.
- **Correctness agent (HIGH):** The Mem0MemoryMiddleware correctly uses user_id passed at construction, but the tool always queries the wrong user.
- **Maintainability agent (HIGH):** LangChain @tool functions do not receive runtime context. The function signature does not accept user_id.
- **Architecture agent (MEDIUM):** Need to use InjectedToolArg, closure, or partial binding at agent construction time.

**Location:** `backend/packages/harness/deerflow/sophia/tools/retrieve_memories.py`, line 31

## Proposed Solutions

### Option A: Closure binding at agent construction (Recommended)
Create retrieve_memories as a closure within make_sophia_agent that captures user_id.
- Pros: Simple, follows same pattern as Mem0MemoryMiddleware
- Cons: Tool is no longer a plain module-level function
- Effort: Small
- Risk: Low

### Option B: InjectedToolArg pattern
Use LangChain's InjectedToolArg to inject user_id from RunnableConfig.
- Pros: Framework-native approach
- Cons: Depends on DeerFlow fork supporting this pattern
- Effort: Small
- Risk: Medium (API compatibility)

## Recommended Action

Option A — closure binding at construction time.

## Technical Details

**Affected files:**
- `backend/packages/harness/deerflow/sophia/tools/retrieve_memories.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`

## Acceptance Criteria

- [ ] retrieve_memories uses the actual user_id from agent config
- [ ] Test verifies correct user_id is passed to search_memories
- [ ] Multi-user scenario does not leak memories across users

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-24 | Identified during code review | 7 agents flagged this independently |

## Resources

- Security agent report: CRITICAL-1
- CLAUDE.md spec: retrieve_memories tool definition
