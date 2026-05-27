# Local Runtime Hygiene

Sophia generates useful local state during dogfood and validation runs. That state is evidence while you are debugging, but it should not become routine commit noise.

Run this before committing local work:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-no-runtime-artifacts-staged.ps1
```

The guard checks staged files only. Unstaged runtime files are allowed to remain on disk for review, and the script never deletes or modifies anything.

## Protected Paths

The staged-file guard blocks these paths:

- `users/**`
- `backend/users/**`
- `**/recaps/*.json`
- `**/traces/*.json`
- `**/sessions/*.json`
- `**/transcripts/*.json`
- `logs/**`
- `*.log`
- `.env`
- `.env.*`
- `frontend/.env*`
- `backend/.env*`
- `voice/.env*`
- `voice/.venv/**`
- `frontend/node_modules/**`
- `.worktrees/**`

The root `.gitignore` also ignores new local runtime JSON, local env files, logs, frontend dependencies, voice virtualenvs, and repo-local worktrees. Historical tracked user fixtures stay tracked until they are reviewed separately.

## Coreview Flags

Coreview is default-off. Do not enable these flags in production until the rollout has been reviewed:

- `NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED`
- `NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED`
- `NEXT_PUBLIC_SOPHIA_COREVIEW_FIXTURE_ENABLED`
- `NEXT_PUBLIC_SOPHIA_COREVIEW_REAL_ARTIFACT_ENABLED`
- `NEXT_PUBLIC_SOPHIA_COREVIEW_VIDEO_PROBE_ENABLED`
- `SOPHIA_GEMINI_COREVIEW_ENABLED`
- `SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED`
- `SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED`

Only explicit truthy values enable Coreview behavior: `1`, `true`, `yes`, or `on`. Empty values, missing values, and ordinary false-like values keep the feature off.

Fixture and probe flags are local validation tools and should never be enabled in production:

- `NEXT_PUBLIC_SOPHIA_COREVIEW_FIXTURE_ENABLED`
- `NEXT_PUBLIC_SOPHIA_COREVIEW_VIDEO_PROBE_ENABLED`

Local frontend testing should use `frontend/.env.local`. Do not commit local env files.

## Worktrees

Use worktrees for code isolation only. A fresh worktree is often the right place to validate a branch, but it is not automatically ready for manual UX testing unless its env files, `node_modules`, and Python virtualenvs have been prepared.

Agents should operate in a locked worktree and verify:

- `pwd`
- `git branch --show-current`
- `git rev-parse --short HEAD`
- `git status --short -uall`
- `git diff --cached --name-status`

Do not manually copy patches between worktrees. Move code by commits, cherry-picks, or reviewed patch files so branch history stays auditable.
