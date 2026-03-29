---
status: pending
priority: p1
issue_id: "002"
tags: [code-review, security]
dependencies: []
---

# Path Traversal via Unsanitized user_id

## Problem Statement

The `user_id` from client config is used directly in file path construction with zero validation. A malicious user_id like `"../../etc/passwd"` or `"../../../.env"` would read arbitrary server files, including API keys. File contents are injected into the system prompt, making them visible to the attacker.

## Findings

- **Security agent (CRITICAL-2):** UserIdentityMiddleware and SessionStateMiddleware construct paths from unsanitized user_id. DeerFlow has path traversal protections in sandbox tools, but Sophia middlewares don't use them.

**Locations:**
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/user_identity.py`, line 39
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/session_state.py`, line 52

## Proposed Solutions

### Option A: Validate user_id in make_sophia_agent (Recommended)
Add regex allowlist `^[a-zA-Z0-9_-]{1,64}$` at the entry point before any middleware receives it.
- Pros: Single validation point, catches all downstream usage
- Cons: None
- Effort: Small
- Risk: Low

### Option B: Resolve-then-check in each middleware
After constructing path, verify it resolves within `users/` directory.
- Pros: Defense in depth
- Cons: Duplicated across files
- Effort: Small
- Risk: Low

## Recommended Action

Both — validate at entry point AND resolve-check in middlewares.

## Acceptance Criteria

- [ ] user_id validated with strict regex in make_sophia_agent
- [ ] Path resolution check in user_identity and session_state middlewares
- [ ] Test with malicious user_id values raises appropriate errors

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-24 | Identified during code review | |
