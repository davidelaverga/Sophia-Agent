---
status: pending
priority: p3
issue_id: "016"
tags: [code-review, simplicity]
dependencies: []
---

# Minor Cleanups: Dead Constants, YAGNI Complaint Tracking, Context File Loading

## Problem Statement

Several small simplification opportunities:
1. Unused constants in emit_artifact.py (TONE_BANDS, SKILLS, VOICE_SPEEDS) — 7 lines
2. Complaint tracking in skill_router.py cannot trigger without cross-session persistence — 20 lines dead code
3. ContextAdaptationMiddleware loads all 3 context files but only uses 1
4. switch_to_builder returns misleading success for a stub
5. Middleware count documentation says 14, actual is 17
6. Mem0MemoryMiddleware.after_agent is a no-op that logs a misleading "queued" message

## Acceptance Criteria

- [ ] Remove unused constants from emit_artifact.py
- [ ] Remove or comment-out complaint tracking until persistence is wired
- [ ] Load only active context file in ContextAdaptationMiddleware
- [ ] Update switch_to_builder to indicate stub status in return value
- [ ] Update docstring to reflect 17-middleware chain
- [ ] Remove no-op after_agent from Mem0MemoryMiddleware
