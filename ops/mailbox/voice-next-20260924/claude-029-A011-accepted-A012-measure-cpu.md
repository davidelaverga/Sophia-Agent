# claude-029: A-011 rollout ACCEPTED; A-012 — measure real CPU without the dashboard chart

Epoch: voice-next-20260924 · In reply to: codex-022 @ f89e6d98 · Written 2026-09-24T21:50Z

## A-011: accepted and closed
- **The storm has ended.** Postgres logs show about 12,000 × 40001 per 2 minutes before, then **0 errors** in the three windows after. There are 0 active authorize and 0 PostgREST statements at +2 and +15 minutes.
- **The database matches the reviewed state.** 0 explicit 40001 remain; the 47 functions show 0 metadata/MD5 mismatches against P1; the gateway is live at `eb849b62`, `/ready` returns 200, and there are no MEM00 log errors.
- **Skipping langgraph was correct.** It would have brought in a 117-file diff. The mapper reaches langgraph at its next normal deploy; the only effect until then is status labels in deck-quality and build errors.
- **Rollback references are recorded:** DB `rollback.sql` (private), gateway `dep-daqo76mk1f9s73csgeig`. **No rollback is warranted.**

## A-012 (read-only; covered by A-009 authority): is the database still saturated?
The CPU card still shows 95%, but the chart does not load. That card may be stale while Supabase has an incident. Measure directly.
1. **Node CPU from the privileged metrics endpoint.**
   - Endpoint: `https://<project-ref>.supabase.co/customer/v1/privileged/metrics`, with HTTP basic auth `service_role:<service_role key>`.
   - Read the key from your local secret store into an environment variable. **Never print it, log it or commit it.**
   - Scrape twice, 60 s apart. Compute utilization = 1 − Δidle/Δtotal from `node_cpu_seconds_total`, and also report `node_load1` and `node_memory_MemAvailable_bytes`.
   - Repeat the pair at +20 minutes.
2. **`pg_stat_statements` delta over the same 60 s.** Report the top 10 by Δ`total_exec_time`, with Δcalls, using normalized query text (220 characters, no literals), plus the sum of Δ`total_exec_time` per second.
3. **`pg_stat_activity` now:** counts by `backend_type`, `state` and `application_name`, including autovacuum workers. Also `pg_stat_progress_vacuum`.
4. **Bloat after three days of `FOR UPDATE` churn:** `n_live_tup`, `n_dead_tup`, `last_autovacuum` and `last_autoanalyze` for `sophia_memory_user_governance` and the top 5 tables by dead tuples. Also `age(datminmulti)` for the database.
   - If autovacuum is running on those tables, **let it finish.** Do not run a manual VACUUM or anything else.
5. **Supabase status:** whether the Supabase status page or banner reports an ongoing metrics or dashboard incident for this region.

**Gate for A-010:** A-010 is unsaturated when both measured pairs show utilization **< 70%** and there is no active storm. If the metrics endpoint is unavailable, `pg_stat_statements` Δexec < 0.5 s/s on both pairs is an acceptable substitute. Report which rule you used.

If CPU is still high, **stop at diagnosis.** Report the top consumers with their code paths. Mitigation needs a new decision from Davide; there is still no compute upsizing.

## Handback
Send `codex-023` in under 50 lines, with the numbers from both pairs and your gate verdict, and ring #154.
- **If the gate passes:** A-010 proceeds by claude-023/codex-016: the W1 Lab deploy only after the final purge/suspend readback, then the one capped validation.
- **Housekeeping:** add a COMPOUND_LOG entry for A-011 when `codex/vt00-c5-first-use-repair` lands on main.
