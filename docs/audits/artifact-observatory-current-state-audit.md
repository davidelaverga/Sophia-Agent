# Artifact Observatory Current State Audit

## A. Executive Summary

Audit-only validation reached completion after rerunning the frontend Vitest targets with the real `src/__tests__/...` paths. Backend validation, frontend typecheck/lint, corrected frontend unit tests, and root checks passed.

The current branch is validatable, but it is not ready for a direct push to the stream branch because it is diverged from `origin/codex/sophia-stream-canvas-v1` and also contains meaningful uncommitted source changes. The safe next step is to commit the audited observatory/Supabase registry changes on this branch first, then merge or rebase the updated stream branch into this branch for conflict resolution and another validation pass.

## B. Branch/SHA State

- Worktree used: `C:\Users\zerof\Sophia-Agent-X\.worktrees\main-health-pr133-verify`
- Current branch: `codex/artifact-observatory-main-integration`
- Current HEAD: `9e26e1be fix: polish artifact observatory interaction UI`
- Stream branch: `origin/codex/sophia-stream-canvas-v1`
- Stream SHA: `4598fed5`
- `origin/main`: `cd8bc960`
- `origin/main` is already an ancestor of the current branch.
- Staged diff: empty.
- Dirty source files are the known audit subject files. Runtime/user dirt remains under allowed paths such as `users/**`, `backend/users/**`, `.agents/**`, `.codex/**`, and `docs/audits/*.md`.

## C. Comparison With Stream Branch

The current branch and stream branch are diverged.

Local-only commits relative to stream: 10.

- `9e26e1be fix: polish artifact observatory interaction UI`
- `03b8861a feat: add artifact observatory experience`
- `6330f9a2 fix: proxy artifact library delete and preview routes`
- `9bc7c0cc fix: resolve registry artifact bytes from task outputs`
- `5c503e09 fix: remove session action from artifact library`
- `e12b2fc7 fix: make artifact library durable and self-contained`
- `7318d54b fix: open dashboard artifacts in session canvas`
- `27e19610 fix: dedupe artifact registry and repair dashboard actions`
- `b736a147 fix: hide internal artifact wrappers from library`
- `c6511a63 feat: add durable artifact registry MVP`

Stream-only commits relative to this branch: 25.

- `4598fed5 Stabilize PDF annotation preview tests`
- `64e40d2f Improve visual artifact quality pipeline`
- `949e22f1 Harden artifact preview and reply backfill`
- `23b635c8 Honor layout-based PPTX plans`
- `bfe8541d Strip Anthropic cache metadata for builder fallback`
- `64f91aa9 Use reason-specific builder budget messages`
- `36c76f5f Prioritize PDF deck delivery requests`
- `6a5b96ce Improve Sophia artifact quality pipeline`
- `6e6612a4 Stabilize builder artifact quality controls`
- `6c9d0661 fix(companion): standing system-prompt instruction for chunked document reading`
- `3e31db9f fix(builder): bare web-deliverable nouns resolve to html`
- `cdb4e28a fix(companion+builder): document paging contract + conversion-source veto`
- `d86a5bc8 Preserve URL-only builder artifacts`
- `52d1f45c fix(builder): target-format truth - current-turn-first resolution + conflict guard`
- `7738eaa8 Restore legacy builder events compatibility route`
- `7db263ba Stabilize builder artifact quality workflows`
- `8fc512ee fix(canvas): project the refining phase to the web canvas`
- `501ac6ab test(provider-fallback): reset the primary cooldown between tests`
- `e15ca068 fix(privacy): exclude the delegation-ledger keyspace from artifact surfaces`
- `20608c61 feat(delegation): Spec D`
- `8bf65af5 fix(builder): address PR #131 latest review`
- `386f95ec feat(builder): Spec VQ wave`
- `1c587c9e refactor(sentrux): clear architecture-gate regressions vs main`
- `5bfc3ec4 feat(webapp): canvas review overhaul`
- `66dce68c fix(builder): deliverable truth, visual reliability, and enrichment-by-default`

Likely conflict zones include artifact registry/router code, builder event routing, Supabase artifact storage, artifact/dashboard tests, frontend artifact library UI, session artifact/index behavior, Coreview-adjacent artifact surfaces, and builder/fallback quality pipeline work.

## D. Uncommitted Source Changes

The current uncommitted source changes are not represented in commits yet.

- `backend/app/gateway/artifact_registry.py`: production code. Adds Supabase-backed and hybrid registry implementations, configuration errors, store errors, registry factory selection, production guard against local-only metadata storage, `upsert_record`, and shared filtering/deduping behavior across local/Supabase/hybrid stores.
- `backend/app/gateway/routers/artifacts.py`: production code. Switches to the registry factory and adds a Supabase object-storage serving path for artifact content/download based on safe `storage_object_path`.
- `backend/app/gateway/routers/builder_events.py`: production code. Switches builder terminal artifact upsert from direct local registry to the registry factory.
- `backend/packages/harness/deerflow/sophia/storage/supabase_artifact_store.py`: production code. Adds safe full-object-path normalization plus upload/download/exists helpers for durable artifact objects.
- `backend/migrations/2026_06_12_artifact_registry_records.sql`: migration. Creates the `artifact_registry_records` metadata table and indexes.
- `backend/scripts/migrate_artifact_registry_to_supabase.py`: migration script. Dry-run by default; can migrate local registry JSON metadata and upload or reuse artifact bytes in Supabase Storage.
- `backend/tests/test_artifact_registry.py`: tests. Adds Supabase registry persistence, dedupe, wrapper hiding, migration, content endpoint, unsafe object path, and metadata-only assertions.
- `backend/tests/test_supabase_artifact_store.py`: tests. Adds explicit object path upload/download/traversal coverage.
- `frontend/src/app/artifacts/page.tsx`: production UI. Removes dashboard nav rail/mobile nav from `/artifacts`, making the observatory a self-contained full-screen surface.
- `frontend/src/app/components/dashboard/ArtifactLibraryPanel.tsx`: production UI. Polishes observatory/island/dome canvas visuals while keeping inline artifact open, download, and delete actions.
- `frontend/src/app/components/dashboard/artifact-observatory-renderer.ts`: production UI renderer. Adds WebGL/scene punch, observatory/island material detail, scale changes, lighting accents, and terrain detail.
- `docs/prototypes/artifacts/01-artifact-observatory.html` and `02-artifact-observatory-v2.html`: prototype documents. Preserve earlier visual exploration.

## E. Artifact Registry Current Behavior

The current branch has a metadata-only artifact registry model with raw content and signed URL exclusion enforced by validation. Local development still supports JSON-backed persistence under the backend user artifact registry path. The dirty changes add Supabase and hybrid backends via `SOPHIA_ARTIFACT_REGISTRY_STORE=local|supabase|hybrid`.

In production-like runtimes, the registry factory defaults toward Supabase and rejects local-only registry use unless explicitly allowed. Supabase rows are user-scoped by `user_id` and persisted through PostgREST using service-role backend access. Artifact bytes remain outside metadata rows and are resolved through authorized backend routes.

Read-time filtering still hides old wrapper/support/internal records and records with `is_library_visible=false` or `deleted_at`. Visible list dedupe still collapses Builder and Backfill duplicates by canonical artifact identity and prefers stronger sources such as Builder over Backfill.

## F. Dashboard Artifact Observatory Behavior

`/artifacts` is now a self-contained Artifact Observatory rather than a generic dashboard list. The page renders the artifact library without the dashboard navbar. Opening an artifact happens inline inside `/artifacts` through artifact ID endpoints, not through `/session`.

The frontend uses:

- `GET /api/artifacts` for list/search/filter.
- `POST /api/artifacts/{artifact_id}/open` for marking/opening.
- `GET /api/artifacts/{artifact_id}/content` for inline preview.
- `GET /api/artifacts/{artifact_id}/download` for download.
- `DELETE /api/artifacts/{artifact_id}` for soft-hide/delete.

The Session Canvas action is not rendered from the artifact library. The session tray remains separate and still has its own `View in canvas` flow.

## G. Supabase Registry/Migration Changes

The new migration creates `public.artifact_registry_records` with metadata fields for user/session/thread/task/run IDs, artifact identity/version, renderer/type/source, local/storage paths, object storage status, visibility, soft delete, open counts, timestamps, and a `record_payload` JSONB copy.

The migration script reads local `backend/users/*/artifacts/registry.json`, validates records as `ArtifactRecord`, computes durable object paths under `artifacts/{user_id}/{session_or_thread}/{artifact_id}/{filename}`, uploads local bytes when available, can reuse legacy Supabase bytes, and preserves metadata-only guarantees.

The Supabase storage adapter now supports explicit safe object paths. It rejects traversal, absolute paths, Windows drive paths, and blank paths before upload/download/existence checks.

## H. Protected Behavior Status

Confirmed present by static audit:

- `CompanionProviderFallbackMiddleware`.
- `BuilderProviderFallbackMiddleware`.
- Companion and Builder OpenAI fallback env controls.
- Companion conversational light path and primary-provider cooldown.
- Builder OpenAI `tool_choice` normalization.
- LLM error handling order tests that allow provider fallback first.
- Assistant reply dedupe and blank filtering.
- Artifact registry model and local/Supabase/hybrid stores.
- Artifact APIs for list, get, upsert, open, content, download, and soft delete.
- Wrapper/support/internal filtering and Builder vs Backfill dedupe.
- Dashboard `/artifacts` UI and inline viewer.
- Download/delete actions.
- `SessionArtifactTrayLauncher`.
- `session-artifact-index` register/open/backfill flow.
- Builder terminal artifact registry upsert.
- Builder failure diagnostics and Coreview-related artifact surfaces remain present.

## I. Validation Results

Backend validation passed:

- `uvx ruff check .`: passed.
- `uv run pytest tests/test_artifact_registry.py -q`: 29 passed.
- `uv run pytest tests/test_artifacts_router.py -q`: 39 passed.
- `uv run pytest tests/test_builder_artifact_completion_emit.py -q`: 38 passed.
- `uv run pytest tests/test_builder_canvas_routes.py -q`: 21 passed.
- `uv run pytest tests/test_companion_provider_fallback.py -q`: 46 passed, with one non-fatal unclosed SSL socket `ResourceWarning`.
- `uv run pytest tests/test_builder_provider_fallback.py -q`: 16 passed.
- `uv run pytest tests/test_supabase_artifact_store.py -q`: 15 passed.

Frontend validation passed:

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 57 warnings and 0 errors. Warnings were in existing areas such as import ordering and unnecessary test assertions.
- `pnpm vitest run src/__tests__/components/ArtifactLibraryPanel.test.tsx src/__tests__/lib/artifact-registry.test.ts src/__tests__/lib/session-artifact-index.test.ts src/__tests__/components/session/SessionArtifactTrayLauncher.test.tsx src/__tests__/lib/assistant-message-dedupe.test.ts`: 5 files passed, 56 tests passed.

Root checks passed:

- `git diff --check`: exit 0. Reported only CRLF-to-LF warnings under allowed `users/**` files.
- `git diff --cached --check`: passed.
- `.\scripts\check-no-runtime-artifacts-staged.ps1`: passed with no staged files.

## J. Risks

- The branch is diverged from stream. Directly pushing this branch to the stream branch would overwrite or bypass 25 stream-only commits unless integrated deliberately.
- Several stream-only commits touch artifact quality, PDF/PPTX behavior, builder routing, fallback, and canvas surfaces, which overlap conceptually with this branch.
- Uncommitted source changes are substantial. Integration should start by committing the audited state on this branch so conflicts and regressions can be tracked cleanly.
- Supabase metadata/storage persistence requires the migration to be applied and production env vars to be configured. The audit did not run live Supabase writes.
- The migration script is new and tested in focused unit coverage, but it should still be run dry-run first in any real environment.
- Sentrux structural gate was not part of this continuation validation and remains a separate integration concern.

## K. Recommended Next Action

Commit the audited uncommitted observatory/Supabase registry changes on `codex/artifact-observatory-main-integration`. After that, merge or rebase `origin/codex/sophia-stream-canvas-v1` into this branch, resolve conflicts locally, and rerun the backend/frontend/root validation before any push to stream.

READY_TO_COMMIT_OBSERVATORY_CHANGES

## L. Safety Confirmation

This audit did not merge, push, commit, stage, reset, stash, clean, discard, deploy, or modify production source behavior beyond creating this requested audit document. No secrets, env values, tokens, or signed URLs were printed.
