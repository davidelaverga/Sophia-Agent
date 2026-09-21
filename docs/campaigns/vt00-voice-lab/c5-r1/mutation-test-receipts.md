# VT00-C5-R1 mutation and test receipts

Actions below are local unless explicitly identified as publication or public read-only.

- Created a detached isolated worktree from C3 `5f4ed1cb`, then fast-forwarded to
  `46cd2302` and `2e949238` as MEM00 published its repair and handover. Preserved
  the new Voice changes and both original worktrees. No shared deployment.
- Bootstrapped `backend/` with `uv sync --group dev`: Python 3.12.14,
  langgraph-api 0.8.1, langgraph-runtime-inmem 0.28.0, SDK 0.3.9, httpx 0.28.1.
- Causal red: after correcting the disposable retention clock fixture, the real
  authenticated `sessions/start` path failed in `OwnerScopedAuth` with
  `LangGraphServiceAuthError: langgraph_service_auth_denied`. No constructed
  receiving AuthContext was used. Original signing prohibition is unchanged.
- Added exact reserved-thread transport authentication and receiving policy;
  wired session creation, failed-start discard and all three overdue fence callers.
- Fixed test-only seams: per-request task isolation for the installed runtime's
  request-local auth context; included the runtime's empty `crons` storage.
- `PYTHONPATH=. uv run pytest` for session auth runtime, ordinary session signing,
  session routes, recovery, service-auth, service-lane and installed-lane tests:
  **162 passed**. Raw receipt: `evidence/focused-tests.txt`.
- Exact-authority negative cases plus capability, process-termination and retention
  reaper tests: **173 passed**. Raw receipt: `evidence/lifecycle-tests.txt`.
- Repository-required nine-file Gateway/Builder sweep plus installed framework
  auth regressions: **320 passed**, including ordinary synthetic finalization,
  repeat end/idempotency, wrong-run and failed lifecycle persistence. Raw receipt:
  `evidence/gateway-tests.txt`. No full destructive-fault campaign was run.
- Expanded installed-policy negatives use an authentic still-reserved credential
  while changing thread, principal, graph or obligation: each returns 403.
  Rechecked runtime/authority files: **12 passed**, `evidence/auth-tests.txt`.
  The three disjoint suites cover 655 tests; the 12-test recheck overlaps them.
- Final review reserved opaque fence metadata against ordinary owner writes and
  bound the discard caller identity to the configured Lab principal. Rechecked
  affected auth/runtime suites: **60 passed**, `evidence/final-auth-tests.txt`.
- Targeted `uv run ruff check` on all six changed/new Python files: passed.
  Nine existing Pydantic schema-name warnings remain; no dependency changes.

These tests exercise disposable stores, real installed auth and runtime filters.
They are not hosted SQL qualification, a live plugin journey, provider closure
proof, or a readiness verdict. No schema or cleanup-ledger function changed.

- Publication: committed code and receipts as `d12c0b4b4917d8c3b3da27808f1026ee1152103a`,
  pushed `codex/vt00-c5-authenticated-session` through the existing authorized SSH
  identity, and created draft [PR #149](https://github.com/davidelaverga/Sophia-Agent/pull/149)
  against `codex/mem00-c3-first-use`. Attached the PR to the current Codex task.
  Removed duplicate `.log` copies; retained the identical `.txt` evidence.

- GitHub candidate checks: combined commit statuses empty; Unit Tests run
  `35613143170` and Architecture gate run `35613142610` both concluded `skipped`
  on the draft PR. These are not additional passing test evidence.
