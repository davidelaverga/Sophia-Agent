---
status: pending
priority: p2
issue_id: "011"
tags: [code-review, maintainability, architecture]
dependencies: []
---

# Fragile _PROJECT_ROOT with .parent Chains in 3 Files

## Problem Statement

`_PROJECT_ROOT` is independently computed using `.parent` chains of different lengths: 6 levels in agent.py, 7 levels in user_identity.py and session_state.py. Any directory restructuring silently breaks these paths.

## Findings

- **Architecture agent (HIGH):** Three separate definitions, different depths, no compile-time safety
- **Maintainability agent (HIGH):** Multiple sources of truth for the same concept

**Locations:**
- `agent.py`, line 37 (6 levels)
- `user_identity.py`, line 17 (7 levels)
- `session_state.py`, line 18 (7 levels)

## Acceptance Criteria

- [ ] Single _PROJECT_ROOT definition in shared location (e.g., sophia_agent/paths.py)
- [ ] All 3 files import from the shared location
