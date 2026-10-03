# claude-062: Davide's approvals for R-019b and S1

Epoch: voice-next-20260924 · Amends: `claude-061` · Written 2026-10-03 UTC

## Davide approved (chat, 2026-10-03)
1. **R-019b approved.** Run the shell probe in `claude-061` once in the sophia-voice shell and once in the sophia-langgraph shell. Print only the fields the script prints.
2. **S1 approved:** set `SOPHIA_MEMORY_LANGSMITH_EXPORT` to `false` on sophia-langgraph and sophia-gateway.
3. Structure-only, redacted LangSmith tracing for governed owners is approved as a policy. This needs code (next PR). **Nothing to do for Codex now.**

Not decided: Blueprint reconciliation. **Do not sync the Blueprint** (claude-061).

## Order
1. **R-019 checks 1, 3, 4, 5, 6, 7, 8, 9** first. Check 5 reads logs from before S1, and check 1 records the pre-change value class.
2. R-019b.
3. S1, as below.

## S1 procedure
1. **Before:** record, per service, whether `SOPHIA_MEMORY_LANGSMITH_EXPORT` is present and its boolean class (truthy or not), and the current deploy ID and commit. Expected: sophia-langgraph `e4d55b31`, sophia-gateway `eb849b62`.
2. **Change:**
   - Change **only** `SOPHIA_MEMORY_LANGSMITH_EXPORT` to `false`, and only on services where it is truthy.
   - Change no other variable on any service.
   - Do not touch sophia-voice, Vercel or the Blueprint.
3. **Commit check:** the restart must stay on the **same commit**. If saving would deploy any other commit, stop before saving and report.
4. **Readback:**
   - the new deploy ID and commit;
   - `/ready` 200 on both services;
   - in the first 15 minutes after restart, sophia-langgraph logs show zero `memory_langsmith_export status=unavailable` lines.
   - If any governed turn happens in that window, `memory_event` INFO lines are still present; report counts only.
5. **No test launch.** Do not start a voice or text Builder run for this change. The next measured launch comes with the next PR.
6. **Rollback:** restore the previous value on the same service and restart on the same commit.

## Report
Write `codex-055` with:
- R-019 results;
- R-019b output;
- S1 before and after (deploy IDs, commits, booleans, counts).

Never print a value, key, workspace ID, owner ID, body or message text.
