# codex-056 — PR #166/#167 review, integration and production release
UTC date: 2026-10-05; local release date: 2026-10-06. Davide authorized Codex remediation, repeated automatic review, reconciliation, merge into the production branch and deployment.
Target branch: `codex/frontend-prod-083d4cb0`; no merge into main.
PR #167 merge: `ea6dbc06eb6efd91c4776975f0b1cd3f6a14c9fc`; reviewed head `2a6ed90dd717fb1a102937955af1a65387a73599`.
PR #166 merge / release SHA: `c392c3d7fbf2cb8cbdb00fabcf265315a5758d8a`; reviewed combined head `315873ca0b5318392142005fc6962a0f3ec6d89d`.
The final merge tree equals the reviewed/tested combined head exactly; both reviewed PR heads are ancestors.

## Review remediation
P1 arbitrary boolean content: preserved Claude `6200e925`; added nested and recorder-path regressions.
Architecture regression: Codex `056e36d8` preserves decisions, validators and lazy SDK loading; gate unchanged, god files 27→27 and complex functions 720→720.
P2 unauthenticated diagnostics: acquire joins after auth/authority/ownership; UUID/null only; arbitrary action keys remain unchanged in the request.
P2 effective structural mode: errors and Builder lifecycle summaries remain content-free even when the content gate is open.
P2 session export: diagnostic joins are bounded by the latest session/microphone start; no known boundary means no joins. Lifetime drop counters remain lifetime totals.
P2 raw audio: preserved Claude `2d78e1c8` and its tests; combined with real SDK transport regression enabling content/audio flags in structural mode. Full mode is the positive control.
All four inline review threads resolved. Final automatic review completed without findings on `315873ca`: PR #166 comment `6003981618` (2026-10-05T22:02:58Z).

## Verification
Final-head backend CI job `111997169023`: 7437 passed, 168 skipped, 2 known deck-native failures; lint passed. Same two failures on PR #167, unrelated to these changes.
Known failures: `test_deck_native_lint_fix_rolls_back_seam_that_would_wrap_text`; `test_deck_native_lint_fix_repairs_canary_headline_and_kpi_overflow`.
Final-head architecture CI `37379381142` and Memory Highlights E2E `37379381155`: success.
Local combined backend focus: 302 passed. Affected frontend: 157 passed; typecheck and changed-file lint clean. Latest voice focus: 76 passed; changed-file Ruff clean.
Regression tests reproduced review gaps before fixes, including actual SDK multipart bytes; no secrets or content included here.

## Production readbacks
| Service | New deployment | Served SHA / health | Prior rollback target |
|---|---|---|---|
| gateway | `dep-db220p4s728c73apgie0` | `c392c3d7` / ready, version 200 | `dep-darb8bo93c1s73etl630` / `eb849b62` |
| LangGraph | `dep-db2224btqb8s73bp3alg` | `c392c3d7` / ok, version 200 | `dep-db0mokugekts73acr2k0` / `e4d55b31` |
| voice | `dep-db2254mk1f9s738qok2g` | `c392c3d7` / ready, version 200 | `dep-dass0759fdbs73eqoodg` / `6f6545d6` |
| Vercel | `dpl_Kky8ZEpuUGupKiJBshGqXXdVcTAL` | `c392c3d7` / app-version 200 | `dpl_GnKJDi1nqMX8L7PFBt9Y4oDvNPPT` / `e4d55b31` |
Render: gateway → LangGraph → voice, each healthy before the next; specific-commit deploys. Final configured branch `codex/sophia-observability-v1` / autodeploy Off on all three; no Blueprint sync.
Vercel: fresh Git production build of release SHA/current env; deployment-only ignored-build override. Project settings and production env equal before/after.
Gateway and voice Lab=false/kill=true verified. Signed frontend auth:readiness unavailable: protected grant/config cannot be read, and no credential was changed to obtain it.
No settings/env/key changes, migrations, manual data/memory/retention operations or Lab actions. A-014b automation untouched.
LangSmith credential/permission 403 remains a separate issue; this release fixes policy, failure visibility, launch diagnostics and recap polling, not credentials or the latency itself.
Supervised product validation remains for Davide: fresh voice Builder request/steer, resulting artifact and end-session recap. No new product session or billable Builder test was initiated.
