# Coreview Artifact Review Local Smoke

Updated: 2026-06-03

## Branch / Scope

- Branch to use: `codex/sophia-stream-canvas-v1`
- Expected integration SHA after pull: `f56a926c` or the final pushed SHA called out in the handoff.
- Included on this branch: builder PDF output, `ArtifactStage` canvas, markdown preview, PDF renderer, page thumbnails, page navigation, zoom / fit width / fit page / reset view, PDF text extraction, still-frame **Review with Sophia**, page-review voice commands, prompt/tool leakage hardening, and transcript surfacing improvements.
- Not included: OCR, liveframes, dynamic fixture work, broad VAD/arbiter rewrite, provider/VAD changes, or deploy work.

## Local Files / Prereqs

- Local env/config files to have available:
  - `.env`
  - `backend/.env`
  - `voice/.env`
  - `frontend/.env`
  - `frontend/.env.local`
  - `config.yaml`
- Local Python/runtime setup:
  - `voice/.venv` or another local Python env for voice tests/runtime
  - Python 3.12 plus `uv` for backend validation
  - `pnpm` for frontend work
- If a worktree is missing ignored env files, copy them from the main checkout and never commit them.
- `frontend/.env.local` is the preferred place for local frontend-only overrides.

## Env / Flags To Have Available

- Voice / Gemini runtime:
  - `SOPHIA_VOICE_RUNTIME_MODE`
  - `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED`
  - `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED`
  - `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED`
  - `GOOGLE_API_KEY`
  - `GEMINI_API_KEY`
  - `STREAM_API_KEY`
  - `STREAM_API_SECRET`
- Coreview / artifact review:
  - `NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED`
  - `NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED`
  - `SOPHIA_GEMINI_COREVIEW_ENABLED`
  - `SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED`
  - `NEXT_PUBLIC_SOPHIA_GEMINI_FLUID_BASELINE_MODE_ENABLED`
- Frontend auth / bypass:
  - `BETTER_AUTH_SECRET`
  - `BETTER_AUTH_URL`
  - `BETTER_AUTH_DATABASE_URL`
  - `DATABASE_URL`
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `SOPHIA_AUTH_BACKEND_URL`
  - `NEXT_PUBLIC_SOPHIA_AUTH_BACKEND_URL`
  - `NEXT_PUBLIC_SOPHIA_AUTH_BYPASS`
  - `NEXT_PUBLIC_DEV_BYPASS_AUTH`
  - `NEXT_PUBLIC_SOPHIA_USER_ID`
  - `SOPHIA_BACKEND_TOKEN_SECRET`
- Local service URLs:
  - `NEXT_PUBLIC_GATEWAY_URL`
  - `NEXT_PUBLIC_API_URL`
  - `BACKEND_API_URL`
  - `SOPHIA_LANGGRAPH_BASE_URL`
  - `NEXT_PUBLIC_LANGGRAPH_BASE_URL`
  - `NEXT_PUBLIC_APP_URL`
- Builder / research / model providers:
  - `ANTHROPIC_API_KEY`
  - `MEM0_API_KEY`
  - `TAVILY_API_KEY`
  - `OPENAI_API_KEY`
  - `SOPHIA_BUILDER_MODEL`
- Storage / DB:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_KEY`
  - `SUPABASE_BUILDER_BUCKET`

Notes:

- Repo-backed Coreview flags are default-off.
- `NEXT_PUBLIC_SOPHIA_GEMINI_FLUID_BASELINE_MODE_ENABLED` is part of the current local smoke startup recipe, even though this branch does not show a direct code/docs search hit for that exact name.
- Never place `GOOGLE_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_API_KEY` in `NEXT_PUBLIC_*` variables or client-side env files.

## Start Commands

```powershell
cd C:\Users\zerof\Sophia-Agent-X
git fetch origin
git checkout codex/sophia-stream-canvas-v1
git pull
git rev-parse --short HEAD

.\scripts\start-all.ps1 -Stop

$env:SOPHIA_VOICE_RUNTIME_MODE="gemini_live"
$env:SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED="true"
$env:SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED="true"
$env:SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED="true"
$env:NEXT_PUBLIC_SOPHIA_GEMINI_FLUID_BASELINE_MODE_ENABLED="true"
$env:NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED="true"
$env:NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED="true"
$env:SOPHIA_GEMINI_COREVIEW_ENABLED="true"
$env:SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED="true"

.\scripts\start-all.ps1
```

## Health Checks

```powershell
Invoke-WebRequest http://localhost:2024 -UseBasicParsing
Invoke-WebRequest http://localhost:8001/health -UseBasicParsing
Invoke-WebRequest http://localhost:8000/health -UseBasicParsing
Invoke-WebRequest http://localhost:3000/session -UseBasicParsing
```

## Smoke Flow

1. Open `http://localhost:3000/session`.
2. Generate a simple 4-page PDF artifact in the session.
3. Open the artifact in the canvas.
4. Confirm the PDF stage shows 4 thumbnails.
5. Navigate between pages with the stage controls.
6. Exercise `Zoom in`, `Zoom out`, `Fit width`, `Fit page`, and `Reset view`.
7. Start voice if needed, then click **Review with Sophia**.
8. Confirm the UI shows `Sophia is looking at this artifact` and `Frame sent`.
9. Say `go to page two` and confirm the page changes without closing the mic.
10. Say `zoom in` and confirm the zoom changes while review stays active.
11. Change page or zoom manually and confirm the stale / refresh behavior appears.
12. Use **Refresh View** and confirm the review returns to the current visible state.
13. Export voice telemetry at the end of the run.

## Good Telemetry Signs

- `diagnosticsSummary.coreviewStillFrame.coreviewEnabled=true`
- `diagnosticsSummary.coreviewStillFrame.frameSentCount > 0` after review starts
- `metrics.counts.artifactSelectedStageCount > 0`
- `metrics.counts.artifactRuntimeIngestCount > 0`
- `captureBundle.events` includes artifact-view events showing `artifactRendererKind="pdf"` and `artifactPageCount=4`
- `diagnosticsSummary.coreviewStillFrame.pdfTextExtractionStatus="success"`
- `diagnosticsSummary.coreviewStillFrame.rawFrameExcluded=true`
- `diagnosticsSummary.coreviewStillFrame.rawProviderPayloadExcluded=true`
- `diagnosticsSummary.coreviewStillFrame.rawArtifactTextExcluded=true`
- `diagnosticsSummary.artifactReview.emitArtifactToolCallCount=0` for normal review questions

## Known Current Limitations

- No OCR yet.
- No liveframes yet.
- No broad VAD/arbiter rewrite yet.
- Keyboard/pinch support is still basic.
- PDF visual design is still simple.
- Deploy work is not done.

## Troubleshooting

- Voice not ready: check `STREAM_API_KEY`, `STREAM_API_SECRET`, and `GOOGLE_API_KEY` / `GEMINI_API_KEY`.
- Auth gate blocks `/session`: check frontend auth vars, especially `BETTER_AUTH_*`, `SOPHIA_AUTH_BACKEND_URL`, `NEXT_PUBLIC_SOPHIA_AUTH_BACKEND_URL`, `NEXT_PUBLIC_SOPHIA_AUTH_BYPASS`, `NEXT_PUBLIC_DEV_BYPASS_AUTH`, and `NEXT_PUBLIC_SOPHIA_USER_ID`.
- **Review with Sophia** is disabled: confirm the Coreview flags are enabled and Gemini voice is connected.
- PDF does not render: try **Open in new tab** first to verify the artifact route, then check the PDF renderer/frontend logs.
- Sophia cannot hear or cannot act on page commands: export telemetry and inspect transcript/provider counters plus Coreview command fields.
- Missing env files in a worktree: copy the ignored env files from the main checkout and do not commit them.
