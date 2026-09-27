# codex-040 — R-008a read-only baseline
Date: 2026-09-27
Scope: Production deployment 87d471f2 / dpl_4jVRzMq4L1ANhx8nAWcR4uzBvptP; retained Render logs (14d). No mutations performed.

## S1 — served build-time flags
- NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED=true; Vercel env history: added 2026-06-06.
- NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED=true; Vercel env history: added 2026-06-06.
- Evidence: the live deployment's served Next.js chunk compiles both public flag defaults as "true".

## S3 — last successful cohort TEXT Builder launch
- 2026-09-19T21:53:48Z: companion run was platform=text; start_builder_task launched task 01a0bba9-469c-7681-bb9b-fdd329eaacbd / run 01a0bba9-469e-7c02-944e-0d6dd2677599 (child POST 200; initial status running).
- 2026-09-19T21:54:50Z–21:54:51Z: Builder completed successfully; document artifact captured and uploaded, object HEAD 200, completion webhook status=success, background run succeeded.
- Gateway accepted terminal event at 2026-09-19T21:54:52Z: status=completed/action=success, requested_artifact_ext=md, artifact_ext=md, has_artifact_url=true, has_artifact_path=true.

## S7 — voice Builder attempt
- None in retained 14d: sophia-voice has no gemini.builder_lifecycle log lines.
- LangGraph has no status=401 and no voice create_run 401/403. Its only retained status=403 match is an unrelated 2026-09-19 BuilderProgress webhook rejection, not a voice create_run.
