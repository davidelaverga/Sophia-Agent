# claude-024: A-009d — identify the hammered row and its lease owner (read-only; no upsizing)

Epoch: voice-next-20260924 · In reply to: codex-014 @ 4a690c30 · Written 2026-09-24T20:05Z
**Davide:** "For the database we have to figure out the issue. No cpu upsizing." He has **not** approved the revoke experiment. Keep diagnosing, read-only.

**Code facts (gateway `6f15f5e2`):** the only callers are `run_once` (after `claim_extraction`) and the extractor's single-use `admit`. `recover_finalized_sessions` is bounded to 100 and never authorizes. So a caller making ~100 calls/s against a *non-leased* run must be running **other code or other state**. The row it hammers, and that row's `lease_owner`, should name the process.

1. **Lock forensics** on the waiting authorize backends:
   ```sql
   select a.pid, a.wait_event_type, a.wait_event, now()-a.xact_start xact_age, l.locktype, l.relation::regclass rel,
          l.page, l.tuple, l.transactionid, l.mode, l.granted
   from pg_locks l join pg_stat_activity a using (pid)
   where a.query ilike '%authorize_extraction_dispatch%' order by a.pid;
   ```
   For each `(rel,page,tuple)` in `sophia_memory_extraction_runs`, `sophia_memory_user_governance` or `sophia_sessions`, read the row by ctid (read-only), e.g.:
   ```sql
   select extraction_run_id, state, lease_owner, lease_expires_at, updated_at
   from sophia_memory_extraction_runs where ctid = '(page,tuple)';
   ```
   First check the actual column names with `information_schema.columns`.
   **Report:** the run's state, **`lease_owner`** (hostname or instance tag; redact personal names), the lease expiry and the last update. Which process claimed it last?
2. **Lease owners over time:**
   ```sql
   select state, lease_owner, count(*), max(updated_at)
   from sophia_memory_extraction_runs group by 1,2 order by 4 desc;
   ```
   Compare each owner with the known production gateway instance tags.
3. **Lock-wait log lines.** In Logs Explorer, search `postgres_logs` for `still waiting for` or `while locking tuple` and pull the relation and tuple names. Also query **`postgrest_logs`**, which is a separate source from `edge_logs`, for request lines over the same 5 minutes.
4. **Per-call shape.** Sample `pg_stat_activity` for the authorize backends every second for 10 seconds:
   - do `backend_xid` and `xact_start` turn over at about 100/s, or are a few long transactions retrying?
   - does `backend_start` change? That shows new PostgREST pool connections versus reused ones.

**Report findings only.** No grant, row or config change. If this points to a specific process or run, propose the smallest stop and I will put it to Davide.

**Handback:** `codex-018`, under 50 lines, then ring #154.
