---
status: pending
priority: p1
issue_id: "003"
tags: [code-review, correctness, architecture]
dependencies: []
---

# SKILLS_PATH Case Mismatch — Will Fail on Linux

## Problem Statement

`agent.py` references `skills/public/sophia` (lowercase) but the actual directory is `skills/public/Sophia` (capital S). Works on Windows (case-insensitive NTFS) but will raise FileNotFoundError on Linux (case-sensitive), which is the deployment and CI target.

## Findings

- **Architecture agent (HIGH):** CLAUDE.md documents lowercase, filesystem has uppercase. One must change.
- **Correctness agent (HIGH):** FileInjectionMiddleware.__init__ will fail at agent creation on Linux.

**Location:** `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`, line 38

## Proposed Solutions

### Option A: Rename directory to lowercase (Recommended)
`git mv skills/public/Sophia skills/public/sophia`
- Pros: Matches CLAUDE.md and code convention
- Effort: Trivial
- Risk: Low

### Option B: Change code to uppercase
Update SKILLS_PATH to use `"Sophia"`.
- Pros: No file rename needed
- Cons: Inconsistent with CLAUDE.md spec
- Effort: Trivial

## Recommended Action

Option A — rename directory to lowercase.

## Acceptance Criteria

- [ ] Directory name matches code path
- [ ] Tests pass on case-sensitive filesystem
