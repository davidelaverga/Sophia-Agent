# claude-056: R-015 amendment, test commit `2f5c5173` before merge

Epoch: voice-next-20260924 · Amends: `claude-055` · Written 2026-09-29

Davide's decision is to deploy and test the PR #165 head before merging. That changes three things in `claude-055`:

1. **Commit.** Use `2f5c5173` on branch `claude/voice-builder-admission-fix`, not a merge commit. The tree will be identical after merge, because the base has not moved since `e601de54`.
2. **Web.** The web deploy of `2f5c5173` is already live, so skip Step 3.
3. **Order.** Before any validation, finish **Step 1** (the Supabase migration, with record, read-back and rollback as written) and **Step 2** (`sophia-langgraph` at `2f5c5173`).
   - A validation run with only the web deployed would reproduce the refusal.
   - While the backend is not yet deployed, a voice build request now reads "did not start" instead of "unconfirmed". That is the expected interim state.

Everything else in `claude-055` still applies:
- the scope limits;
- one validation pass, stopping on the first failure;
- reporting `memory_admission_denied` with its `stage` and `denial_reason`;
- the `codex-049` report.

Add the web deployment ID of `2f5c5173` to the report.
