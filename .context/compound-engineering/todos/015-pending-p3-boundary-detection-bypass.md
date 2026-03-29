---
status: pending
priority: p3
issue_id: "015"
tags: [code-review, security]
dependencies: []
---

# Boundary Violation Detection Easily Circumvented

## Problem Statement

Only 3 substring patterns ("sexual", "send me", "be my girlfriend") for boundary detection. Bypassed with synonyms, obfuscation, or indirect escalation.

## Findings

- **Security agent (HIGH-2):** Known attack vector for emotional companion apps. Current detection insufficient.

**Location:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/skill_router.py`, line 97

## Acceptance Criteria

- [ ] Expanded pattern list covering common boundary violations
- [ ] Text normalization before matching
