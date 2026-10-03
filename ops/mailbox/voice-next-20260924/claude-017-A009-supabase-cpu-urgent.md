# claude-017: A-009 (URGENT, takes priority over A-008): find what is driving Supabase to 90% CPU

Epoch: voice-next-20260924 · Assignment: A-009 · Written 2026-09-24T19:10Z
**Authority:** Davide, 2026-09-24. "My supabase is reporting 90% cpu usage… hand over some tasks to codex. He has access to my supabase."

Pause A-008. Resume it after the A-009 handback.

## Scope
- **Read-only diagnosis** of the Sophia Supabase project, using your authenticated dashboard and SQL access.
- **Mitigation:** only after you have evidence, and only with **Davide's explicit OK in your chat.** He is online now.
  - It must be one reversible step, for example a feature flag that disables a background worker, or cancelling (not terminating) a clearly runaway query.
  - No schema changes, no data deletion, no `pg_stat_statements_reset`, no plan or compute changes without his OK.
- **Public-repo hygiene still applies:** normalized query text only; no literals, user data, emails, keys or connection strings.

## What I found in code (deployed gateway `6f15f5e2`), to test, not conclusions
1. **MEM00 memory-governance worker** (`backend/app/gateway/workers/memory_governance.py`), running in the gateway against `SupabaseMemoryGovernanceStore` (`backend/packages/harness/deerflow/sophia/memory_governance/store.py`).
   - **Polls every 1 s.** Each pass runs `extraction.run_once` and `projection.run_once`: `claim_extraction`, `claim_projection`, `list_candidates` and related.
   - **Re-loops immediately, with no sleep, whenever `worked` is true.** A row that keeps "working" without ever finishing would make this a tight loop.
   - **Also runs `recover_finalized_sessions` once at every process start.** The gateway was redeployed several times today (gate open/close around 10:38–11:33Z).
   - **Also runs `expire_candidates(limit=500)` hourly.**
2. **Gateway Voice Lab stores and retention.**
   - `voice_lab_retention` runs every 60 s with an advisory lease.
   - The stores are `SOPHIA_VOICE_LAB_AUTH_DATABASE_URL` and `SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL`. Check whether they point at this Supabase.
3. **Other Supabase users:**
   - the session store and the artifact registry (both in `supabase` mode);
   - Storage: the upload mirror and Builder artifacts;
   - Better Auth, if it is hosted there;
   - Supabase's own services (PostgREST, Auth, Realtime).
4. **Excluded:** the Lab worker's 250 ms loop uses Render `sophia-voice-lab-postgres`, not Supabase. Exclude it unless its DSN proves otherwise.

## Collect (read-only)
1. **Dashboard:**
   - the CPU chart: when it started, and whether it is sustained or spiky;
   - the compute size;
   - the Query Performance report, if available.
2. **SQL.** Use `extensions.pg_stat_statements` if the unqualified name does not resolve.
   ```sql
   -- A. top by total time
   select round(total_exec_time::numeric/1000,1) total_s, calls, round(mean_exec_time::numeric,2) mean_ms,
     round((100*total_exec_time/sum(total_exec_time) over ())::numeric,1) pct, rows,
     left(regexp_replace(query,'\s+',' ','g'),220) query
   from pg_stat_statements order by total_exec_time desc limit 15;
   -- B. top by calls (polling loops)
   select calls, round(mean_exec_time::numeric,2) mean_ms, round(total_exec_time::numeric/1000,1) total_s,
     left(regexp_replace(query,'\s+',' ','g'),220) query
   from pg_stat_statements order by calls desc limit 15;
   -- C. connections by client right now
   select usename, application_name, client_addr, state, count(*) conns,
     max(now()-query_start) filter (where state='active') longest_active
   from pg_stat_activity where backend_type='client backend' group by 1,2,3,4 order by conns desc;
   -- D. active queries running longer than 1 s
   select pid, usename, application_name, now()-query_start runtime, wait_event_type, wait_event,
     left(regexp_replace(query,'\s+',' ','g'),220) query
   from pg_stat_activity where state='active' and backend_type='client backend'
     and now()-query_start > interval '1 second' order by runtime desc limit 20;
   -- E. sequential-scan heavy tables and dead tuples
   select schemaname, relname, seq_scan, seq_tup_read, idx_scan, n_live_tup, n_dead_tup, last_autovacuum
   from pg_stat_user_tables order by seq_tup_read desc limit 15;
   ```
3. **Gateway (Render) logs over the CPU window.** Look for the frequency of:
   - `MEM00 worker cycle failed`, `memory.governance expiry_failed`, `recovery_failed`;
   - Voice Lab retention errors;
   - any request storm.
4. **Correlate** the CPU start time with today's gateway deploy times.

## Handback (`codex-011`, under 80 lines)
- The CPU timeline and compute size.
- Tables A–E (trimmed), with the **likely source code path** for each of the top 5 statements.
- Your diagnosis, with its evidence.
- The single proposed mitigation, and whether Davide approved and applied it, with readback.
- Anything left open.

Then ring the doorbell on #154. **A-008 resumes afterwards.** Retention mechanisms are unchanged.
