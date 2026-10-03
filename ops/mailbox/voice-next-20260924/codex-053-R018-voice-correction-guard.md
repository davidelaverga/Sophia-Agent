# codex-053 — R-018 deployed; supervised validation pending
2026-10-03 UTC. Davide authorized deploying the latest fixed commit for production testing; PR #165 remains unmerged.
Exact deployed commit: e4d55b3102fd86c15d6fa88c26a6b2cd6f05ddf2; runbook claude-059 read at 057eef413.
Verdict: Step 0 and Step 1 PASS. Step 2 NOT RUN; waiting for Davide's one fresh desktop voice session.

## Review and CI gate
Automatic review: Codex +1 at 2026-10-03T19:09:02Z, after the head commit at 19:01:31Z; all 27 review threads resolved.
Architecture 37146403992 success; Memory Highlights E2E 37146404011 success; Unit Tests 37146403998 failure.
Backend job 111271196096: exactly 7 known failures, 7352 passed, 168 skipped, 12 warnings, 583.43s; backend lint passed.
Failures match the existing two deck-native wrapping/KPI tests and five memory-governance-worker expiry/backoff tests; no additional failures.

## Step 0 — applied once, read back
Read-only shared_sequences preflight: 0; after apply: 0.
Function definition MD5 before: 9e1d6ab6c1948e736742d6e7e3e4c4b4; after: 19f5f62b535ac6eb1c8827f2fffa6fe5.
Applied backend/migrations/2026_10_02_mem00_recorded_source_chronology.sql from exact e4d55b31; successful readback by 20:56:41Z.
Approved file SHA256: da4196f4ca02742d37753e10fab80f823976c9fed5d2cbad7baa6e991b4cd961.
Read-back function body MD5 92f387d59fd5a75538ebdf371818d2c3 equals the approved file's function body.
Signature before/after: public.sophia_replace_session_messages(p_user_id text, p_session_id text, p_expected_revision bigint, p_messages jsonb) RETURNS jsonb.
SECURITY DEFINER=true; owner role=postgres; search_path=public; all unchanged.
EXECUTE grants unchanged: postgres (owner) and service_role, neither grantable; PUBLIC/anon/authenticated not granted.
Trigger set equal before/after, all enabled O; MD5(pg_get_triggerdef) values:
- RI_ConstraintTrigger_c_194593: 1f4baa92bdd2856a7394dd17fc632842; RI_ConstraintTrigger_c_194594: 39a63df74f769099b76c68469e7172db.
- sophia_memory_source_acceptance_epoch: 00c7f02fb314f3677b25aebef8ae422e; sophia_memory_source_version: b0f588c04f9b9831e3a0888e8ce5a97d.
- sophia_voice_lab_message_write_fence: 3b21457871cbb90b2ebc2178e4bd46f4; zz_mem00_source_intake_version: 4298c0c815b4dd63ab7e838b3254b56e.
No production data RPC/test executed; the migration replaces the function only. Rollback prepared, not used: 2026_09_29 function block and its REVOKE/GRANT.

## Step 1 — LangGraph then fresh web build
LangGraph: dep-db0mokugekts73acr2k0, exact-commit manual deploy started 20:57:55Z; duration 6m51s; Render Live.
Configured branch codex/sophia-observability-v1 and Auto-Deploy Off preserved; no Blueprint sync.
A /version request during the in-progress instance transition returned 502; after Render Live, /version and /ok both returned 200 at 21:05:40Z.
Vercel source Preview dpl_6DqUZxFi6Epsh7bYbTLSADpbGtNk was skipped by existing Ignore Build Step; rebuilt once as Production using latest project settings.
Production: dpl_GnKJDi1nqMX8L7PFBt9Y4oDvNPPT, Ready/Current, 1m build; build cache and Ignore Build Step disabled for this deployment only.
At 21:11:37Z: /api/app-version 200, build_id=e4d55b3102fd86c15d6fa88c26a6b2cd6f05ddf2, deployment_id=dpl_GnKJDi1nqMX8L7PFBt9Y4oDvNPPT.
At the same check: LangGraph /version 200, commit_sha=e4d55b3102fd86c15d6fa88c26a6b2cd6f05ddf2; /ok 200, ok=true.
Rollback recorded: LangGraph redeploy 973534ef (prior dep-dave5v3bc2fs73chvgc0); web fresh build 2f5c5173 (prior dpl_2vzq5ica6DEii89fcS5P9TPqnydp).

## Step 2 — pending
Counts/Q1, source/routing/handoff/child/progress timestamps, every voice-builder outcome and voice-audio context-state line, refusal reasons and routed/child task_type: pending; no validation run or retry.
Sophia opened fresh for Davide. No gateway/voice deployment, env/settings edits, Lab, memory or retention action; no merge.
