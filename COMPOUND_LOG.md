# Sophia — Compound Learning Log
Every merged PR appends an entry here. This file is the team's accumulating institutional memory.
---
## Entry Format
```
## YYYY-MM-DD · [component] · PR #[N]
**Author:** name · **Track:** backend | voice | frontend · **Spec:** docs/specs/0X_name.md

### What Changed
- Bullet list of changes

### What We Learned
- Insights, surprises, gotchas

### CLAUDE.md Updates
- Any additions or corrections made to CLAUDE.md as a result of this PR (or "None")

### Skills Created / Modified
- Skill files added or changed (or "None")

### GEPA Log Entry
- If a prompt file changed: before behavior → after behavior, tone_delta (if measurable), trace pair available (yes/no)
- If no prompt file changed: "N/A"
```
---
## Log
<!-- Append new entries below this line -->

## 2026-04-06 · [memory-review] · PR #[pending]
**Author:** GitHub Copilot · **Track:** backend + frontend · **Spec:** docs/specs/03_memory_system.md, docs/specs/04_backend_integration.md, docs/specs/05_frontend_ux.md

### What Changed
- Hardened the recap memory-review path so frontend fallback data no longer reintroduces approved or discarded memories as pending candidates.
- Reduced unnecessary Mem0 detail hydration for `status=pending_review` by honoring the local review metadata overlay before deciding whether a per-memory fetch is needed.
- Switched dev auth bypass away from the tracked `dev-user` default to avoid booting local sessions on top of seeded runtime artifacts.
- Added backend and frontend regression coverage for the fallback filtering and overlay-driven hydration paths.

### What We Learned
- Mem0 is not a reliable immediate source of truth for review metadata; the local review metadata store has to drive recap moderation semantics.
- Status-filtered review endpoints can silently turn into N+1 Mem0 traffic if overlay state is ignored before hydration.
- A fallback route that broadens its source query must still preserve the original semantic contract; otherwise the UI revives already-reviewed candidates.
- Committing runtime `users/` artifacts makes full-branch IDE review significantly heavier and requires a neutral dev-bypass user default.

### CLAUDE.md Updates
- Added pitfalls covering overlay-first `pending_review` hydration, recap fallback filtering, and neutral dev bypass defaults when runtime user artifacts are tracked.

### Skills Created / Modified
- Added `.claude/skills/sophia/memory-review-overlay/SKILL.md`

### GEPA Log Entry
- N/A

