# codex-052 — R-018 preflight; held before production changes
Recorded 2026-10-02T22:57:39Z. Requested target: 8dd9915071f2a3e6d32ddd52e6b521cbbe9a92cb; PR #165 remains unmerged.
Verdict: STOP before Step 0; the pinned migration has a confirmed automatic-review P1. No migration or deployment attempted; no validation or retry.
Runbook read initially at 74b8fe857; latest Claude mailbox commit 44f0c0402 replaces the target with bd5f1bb4f6720142532077cdfe8b4e67db701bc8.
The user explicitly pinned 8dd99150. Authorization to substitute bd5f1bb4 has been requested; no substitution made.

## CI and review
8dd99150: Architecture 37073577868 success; Memory Highlights E2E 37073577809 success; Unit Tests 37073577891 failure.
Backend job 111058355599: 7 failed, 7346 passed, 168 skipped, 12 warnings, 435.34s; backend lint passed.
Exactly the known seven failures: two deck-native wrapping/KPI tests and five worker-expiry/backoff tests; no additional failing tests.
Review https://github.com/davidelaverga/Sophia-Agent/pull/165#discussion_r4170436712 (2026-10-02T22:44:42Z) flags new-row chronology at migration lines 116–117.
Synthetic local sequence-planner reproduction: stored sequence 1, omitted recorded anchor 3, new incoming sequence 4 -> assigned sequence 2, crossing the anchor.
This was a local algorithm reproduction, not a production RPC or database test.
Claude confirmed the defect and fixed it in bd5f1bb4 at 22:55:29Z; the thread is resolved because of that later commit, not because 8dd99150 is safe.
bd5f1bb4 latest observed CI: Architecture 37075035649 success; E2E 37075034499 success; Unit Tests 37075034519 in progress.
No completed automatic-review result for bd5f1bb4 observed at this check.

## Step 0 read-only catalog baseline
Function MD5: 9e1d6ab6c1948e736742d6e7e3e4c4b4 (matches R-015).
Signature: public.sophia_replace_session_messages(p_user_id text, p_session_id text, p_expected_revision bigint, p_messages jsonb) RETURNS jsonb.
SECURITY DEFINER=true; owner role=postgres; search_path=public; EXECUTE grants: postgres and service_role only, neither grantable.
Trigger set: six, all enabled O; two internal foreign-key triggers plus four application triggers.
Internal: RI_ConstraintTrigger_c_194593 / 1f4baa92bdd2856a7394dd17fc632842; RI_ConstraintTrigger_c_194594 / 39a63df74f769099b76c68469e7172db.
Application: sophia_memory_source_acceptance_epoch / 00c7f02fb314f3677b25aebef8ae422e; sophia_memory_source_version / b0f588c04f9b9831e3a0888e8ce5a97d.
Application: sophia_voice_lab_message_write_fence / 3b21457871cbb90b2ebc2178e4bd46f4; zz_mem00_source_intake_version / 4298c0c815b4dd63ab7e838b3254b56e.
Trigger hashes are MD5(pg_get_triggerdef). After-apply MD5/signature/grants/triggers: N/A, because apply was held.
Migration rollback remains only the function block and REVOKE/GRANT from 2026_09_29_mem00_recorded_source_anchor.sql; not invoked.

## Production readbacks and validation
/api/app-version HTTP 200: 2f5c5173b442199d26f528d2ec7793b3967144a0; dpl_2vzq5ica6DEii89fcS5P9TPqnydp.
LangGraph /version HTTP 200: 973534efa3ec48a00d919501c6e0088d84e3593a; /ok HTTP 200, ok=true.
New deployment ID: none. Web rollback, if needed after a future deployment, remains a fresh build of 2f5c5173.
Step 2 counts, Q1, receipt/routing/handoff/child/progress timestamps, voice-builder outcomes, voice-audio context-state and refusal reasons: N/A; no validation run.
No gateway, voice, LangGraph, settings, Lab, memory, data or retention changes. No merge.
