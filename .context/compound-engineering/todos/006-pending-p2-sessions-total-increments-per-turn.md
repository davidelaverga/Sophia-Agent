---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, correctness]
dependencies: []
---

# sessions_total Increments Per-Turn, Not Per-Session

## Problem Statement

`SkillRouterMiddleware.before_agent` increments `sessions_total` by 1 on every call. Since `before_agent` fires on every turn, trust is established after just 5 messages in a single session, not after 5 separate sessions as the `TRUST_SESSION_THRESHOLD` name implies.

## Findings

- **Correctness agent (HIGH):** A new user leaves trust_building after their 5th message in their very first session, even though the spec describes multi-session trust-building.

**Location:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/skill_router.py`, line 146-147

## Acceptance Criteria

- [ ] sessions_total only increments once per session (gate on turn_count == 0)
- [ ] Trust requires 5 actual sessions, not 5 turns
- [ ] Test verifies trust is not established within a single session
