# claude-055: R-015, deploy the admission fix (PR #165), after Davide approves

Epoch: voice-next-20260924 · Depends on: PR #165 merged into `codex/frontend-prod-083d4cb0` · Written 2026-09-29

## Scope
Deploy exactly these three things, in this order. Nothing else is in scope:
1. Supabase migration `backend/migrations/2026_09_29_mem00_recorded_source_anchor.sql`.
2. `sophia-langgraph` at the PR #165 merge commit.
3. Web (Vercel) at the same commit.

**The gateway stays on `eb849b62`.** It needs no change.

**Do not:**
- change settings, timeouts, providers or Lab flags;
- delete or repair any data;
- touch threads `01a0e865…` and `01a0ea63…`.

Their recorded rows were already rewritten, so they stay refused by design.

**Never print secrets or message content.**

## Step 1: migration (Supabase)
1. **Record the current state.** For `public.sophia_replace_session_messages(text,text,bigint,jsonb)`:
   - the `md5(pg_get_functiondef(...))`;
   - the owner;
   - `proacl`.

   Also record the non-internal trigger names on `public.sophia_session_messages`.
2. **Apply the file as-is.** It is already a single `BEGIN … COMMIT` transaction.
3. **Read back:**
   - The replace function's definition contains `recorded_ids`. Its owner and `proacl` are unchanged: EXECUTE for `service_role` only.
   - `public.sophia_memory_lookup_source_action_by_message(text,text,text)` exists. `has_function_privilege` is true for `service_role` and false for `anon` and `authenticated`.
   - The trigger names on `sophia_session_messages` are **identical** to before. The migration adds no trigger, and the Voice Lab ledger pins this set.
4. **Rollback, if anything fails or reads back wrong:**
   - Re-apply `2026_08_22_fc01_m01_c2_reject_stale_session_snapshots.sql`.
   - `DROP FUNCTION public.sophia_memory_lookup_source_action_by_message(text,text,text)`.

   The migration changes no rows.

## Step 2: LangGraph
1. Deploy `sophia-langgraph` at the merge commit.
2. Pin the branch, with autodeploy off and no Blueprint sync, as before.
3. Check `/ready` returns 200.
4. Record the previous deploy ID for rollback.

## Step 3: web
1. Build fresh at the merge commit. **Never an instant rollback** of an older deployment.
2. Record the previous deployment ID (`dpl_HQFC81…`).

## Step 4: validation (one pass only; stop on the first failure)
1. **Voice request.** In a new private voice session, make one explicit small request, for example: "Please research X and write me a short Markdown report."
   - Expected: the companion run is admitted, and `start_builder_task` creates a task and a child run.
   - The progress panel shows running events, and a Markdown artifact completes.
2. **Correction.** Give one spoken correction. Expected: it goes through the update path and a new Builder run starts.
3. **Receipt check.** Run the `claude-053` Q1 query against the new session's thread.
   - Expected: every receipt shows `version_equal=true` and `sequence_equal=true`.
4. **Refusal logs.** Check the LangGraph logs from this session for any `memory_admission_denied` line.
   - If one appears, report its `stage`, `denial_reason` and `error_type`, then stop. Do not retry.
5. **Typed control.** In the same session, send one ordinary typed message. It should still work.

## Report
Commit `codex-049-R015-admission-fix-deploy.md` with:
- the before/after function hashes;
- the trigger lists;
- the grants;
- the deploy IDs (previous and new);
- the Step 4 results and the Q1 output.
