# Builder Changes Made Today

Date: 2026-04-23

## Summary

Today's builder work was mainly about making the frontend side of the builder flow less fragile when auth state drifts and making the builder artifact/session slice stricter and easier to validate.

There were also backend builder hardening changes in the local worktree. Those backend changes were not part of PR #63 because that PR was opened from the committed branch diff against `voice-transport-migration`, while the backend builder changes are currently local/uncommitted work.

## What changed

### 1. Builder task polling now uses the hardened Sophia proxy helper

We updated the builder active-task route to stop using ad-hoc auth wiring and instead go through the shared Sophia proxy helper.

- Route: `frontend/src/app/api/sophia/tasks/active/route.ts`
- Helper path: `resolveSophiaUserId()` + `fetchSophiaApi()`

Why this matters:

- The route now inherits the standard auth-header logic.
- It retries once after `refreshUserScopedAuthHeader()` on `401` or `403`.
- This removes one of the easiest ways for the builder UI to look stuck when Better Auth is still valid but the backend token is stale.

In practice, this makes builder status polling more resilient and keeps the session UI from desynchronizing as easily.

### 2. We added route coverage around the builder task proxy

We added direct tests around the builder task status path so the auth-refresh behavior is covered instead of being implicit.

- Test: `frontend/src/__tests__/api/sophia-tasks-active.route.test.ts`

Why this matters:

- It locks in the shared-helper behavior for builder polling.
- It reduces the chance of silently reintroducing the old broken auth path.

### 3. We fixed builder artifact fixture drift against the real contract

One of the builder session tests was using a fixture that no longer matched the runtime artifact contract.

- Test: `frontend/src/__tests__/session/useSessionRouteExperience.test.ts`
- Fix: added the required `decisionsMade: []` field to the builder artifact fixture

Why this matters:

- The fixture now matches `BuilderArtifactV1` again.
- Typecheck stops failing on a fake mismatch.
- Future builder artifact regressions are more likely to be real signal instead of fixture noise.

### 4. We cleaned the session route builder slice so it is easier to trust

We cleaned builder-related dead state and warning noise in the session orchestration layer.

- Hook: `frontend/src/app/session/useSessionRouteExperience.ts`
- Related maintenance: `frontend/tests/e2e/builder-live-status.spec.ts`

Why this matters:

- Less unused builder state means less ambiguity in the session flow.
- Lint noise was reduced, which makes real builder issues easier to see.
- The live-status path remains covered and easier to maintain.

### 5. We revalidated the builder/frontend path cleanly

After the fixes and cleanup, the frontend checks passed cleanly:

- `pnpm lint`
- `pnpm typecheck`
- `BETTER_AUTH_SECRET=... pnpm build`

Why this matters:

- The builder-related changes are not just theoretical.
- The session/builder slices compile, lint, and build in the current workspace state.

## Backend builder changes also present today

### 6. The backend artifact middleware got stricter and more recovery-oriented

- File: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py`

What changed:

- Promotes internal helper outputs to the real public deliverable when possible.
- Tries to materialize a missing primary artifact by re-running generator scripts.
- Strips internal helper files from `supporting_files` and from Supabase uploads.
- Validates exact PDF page-count requirements with `pypdf`.
- Rejects bad `emit_builder_artifact` calls when the PDF page count is wrong and forces a repair cycle.
- Recovers a recent public artifact even when the builder ends in plain text without calling `emit_builder_artifact` correctly.

Why this matters:

- The builder is less likely to finish with a useless internal script path.
- Exact-page PDF tasks fail safer instead of silently shipping the wrong file.
- Plain-text completions can still surface the real artifact if it already exists on disk.

### 7. The backend task briefing got more opinionated for fragile binary flows

- File: `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py`

What changed:

- Uses a tighter hard ceiling for exact-page PDF tasks.
- Explicitly forbids helper-module patterns that create `__pycache__` and `.pyc` noise.
- Tells the builder not to include internal generator scripts in `supporting_files`.
- Adds explicit repair guidance after a rejected PDF emit.
- Pushes exact-page PDF tasks toward deterministic page-explicit layouts.

Why this matters:

- The builder gets a clearer contract for binary deliverables.
- Retry loops become more disciplined.
- The prompt better steers the model away from artifact shapes the frontend should never expose.

### 8. Builder handoff/session handling was tightened

- Files:
	- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_session.py`
	- `backend/packages/harness/deerflow/sophia/tools/switch_to_builder.py`

What changed:

- `switch_to_builder` now uses `return_direct=True`.
- The handoff can update `builder_task`, clear stale `builder_result`, and switch `active_mode` in the same turn.
- Builder session middleware interrupts the tool-call result with `goto=END` so the handoff turn closes cleanly.
- Builder agent creation is passed lazily through an agent factory instead of being eagerly prebuilt.

Why this matters:

- The UI can see the newly queued builder task immediately instead of waiting for a later adoption pass.
- It reduces stale builder state after a new handoff.
- Lazy construction is safer for loop-bound async resources.

### 9. The backend executor got more resilient for background builder work

- File: `backend/packages/harness/deerflow/subagents/executor.py`

What changed:

- Adds a persistent worker-loop runner, especially to stabilize Windows execution.
- Retries snapshot-file replacement on temporary `PermissionError`/sharing-violation cases.
- Includes `thread_id` in background task payloads.
- Can read the latest task snapshot by `thread_id`.
- Supports a lazy `agent_factory` path in `SubagentExecutor`.

Why this matters:

- Background builder status persistence is less brittle.
- Windows event-loop churn is reduced.
- Task recovery and task lookup become more reliable.

## Net effect on builder reliability

The main reliability gain is that builder polling is now aligned with the shared Sophia auth-refresh path instead of relying on a more fragile per-route implementation. The secondary gain is contract correctness: the builder artifact test data now matches the real runtime shape, and the session route code is cleaner to validate and maintain.

At backend level, the local worktree changes harden three failure points: bad builder emits, stale or delayed handoff state, and fragile background-task execution/snapshots.

## Files most directly involved

- `frontend/src/app/api/sophia/tasks/active/route.ts`
- `frontend/src/__tests__/api/sophia-tasks-active.route.test.ts`
- `frontend/src/app/session/useSessionRouteExperience.ts`
- `frontend/src/__tests__/session/useSessionRouteExperience.test.ts`
- `frontend/tests/e2e/builder-live-status.spec.ts`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_session.py`
- `backend/packages/harness/deerflow/sophia/tools/switch_to_builder.py`
- `backend/packages/harness/deerflow/subagents/executor.py`