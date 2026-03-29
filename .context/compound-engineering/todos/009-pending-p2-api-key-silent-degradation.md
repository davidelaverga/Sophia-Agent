---
status: pending
priority: p2
issue_id: "009"
tags: [code-review, security]
dependencies: []
---

# API Keys Silently Accept Empty String — No Startup Validation

## Problem Statement

`ANTHROPIC_API_KEY` and `MEM0_API_KEY` default to empty string when not set. The agent appears functional while critical subsystems silently fail. The companion responds without memory context, appearing like a new user every session.

## Findings

- **Security agent (HIGH-3):** Silent misconfiguration causes the application to appear functional while memory retrieval is disabled.

**Locations:**
- `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`, line 63
- `backend/packages/harness/deerflow/sophia/mem0_client.py`, line 24

## Acceptance Criteria

- [ ] Missing ANTHROPIC_API_KEY raises clear error at startup
- [ ] Missing MEM0_API_KEY logs prominent warning (not just debug)
