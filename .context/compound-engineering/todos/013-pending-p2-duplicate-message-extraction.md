---
status: pending
priority: p2
issue_id: "013"
tags: [code-review, maintainability]
dependencies: []
---

# Message Content Extraction Duplicated Across 4+ Call Sites

## Problem Statement

The pattern of extracting last message content (getattr + isinstance list check + join) is copy-pasted in crisis_check.py, skill_router.py (twice), and mem0_memory.py. If the content format changes, all 4 sites must be updated independently.

## Findings

- **Maintainability agent (MODERATE):** Shared utility would eliminate duplication

## Acceptance Criteria

- [ ] Shared `extract_last_message_text(messages)` utility function
- [ ] All 4+ call sites use the shared function
