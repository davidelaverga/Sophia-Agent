# AGENTS.md — Deprecated Sophia Build Contract Pointer

This file is kept for one release so older deployments that still reference
`AGENTS.md` fail softly instead of losing the build contract.

New prompt injection is role-scoped:

- `coordination_core.md` — shared data contract, roles, lifecycle statuses, and non-crossover invariants.
- `companion_delegation.md` — companion-only routing, acknowledgement, and result-handling rules.
- `builder_obligations.md` — builder-only output, path, finalization, research, and fallback-truth rules.

Do not inject this file into active companion or builder prompts. Update the
role-scoped files and the target workflow cards under `builder_workflows/`
when the runtime contract changes.
