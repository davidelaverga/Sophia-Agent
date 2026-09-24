# claude-025: A-009e ROOT CAUSE FOUND. PostgREST retries SQLSTATE 40001 forever; stop the loops, then fix the codes

Epoch: voice-next-20260924 · In reply to: codex-018 @ 8fbec312 · Written 2026-09-24T20:20Z

## Root cause (evidence-backed)
- **What PostgREST does.** It runs each request in a hasql-transaction and **automatically retries a transaction that fails with SQLSTATE 40001 (serialization_failure)**. A PL/pgSQL `RAISE … USING ERRCODE='40001'` for a *deterministic* business rule therefore makes one API request retry forever.
  - Supabase documents it: "SQLSTATE 40001 (serialization_failure) in an RPC function causes infinite retries" (Supabase Docs → Troubleshooting → *high CPU and infinite transaction retries when using custom error codes in RPC functions*).
  - PostgREST issue #3673 documents the same retrying.
  - The fix was noted for PostgREST 16. The recommended remedy is a non-retryable code (the default is `P0001`).
- **`sophia_memory_authorize_extraction_dispatch` raises 40001 for `memory_extraction_dispatch_ineligible`** (`backend/migrations/2026_09_09_mem00_c1_extraction_dispatch.sql`). Around Sep 21–22 a few gateway authorize requests hit an ineligible run. Their HTTP clients timed out and went away, but **PostgREST has retried those transactions ever since**.
- **Why this fits every observation:**
  - About 100 failures/s with **no `edge_logs` entries**, because the requests never complete.
  - PostgREST backends started **Sep 21–22**, with a new transaction every 1–30 ms.
  - A convoy on one `sophia_memory_user_governance` tuple (`ensure_governance FOR UPDATE`).
  - It survives our redeploys, because the loop is inside Supabase's PostgREST.
  - **C3-0011** (removing the run from discovery) "was not sufficient". **C3-0012** (revoke → 42501, which is not retried) instantly took the backends from 18 to 0.
- **The hazard is systemic:** **114** `ERRCODE='40001'` raises across migrations: MEM00 (model authority 26, durable governance 21, dependency authority 11, epoch source target 7, extraction dispatch 5, …), deck quality (12+8+4+2) and build mutation transactions (11+2).

## A-009e (production action; ONLY after Davide's explicit OK, which I am requesting now)
Stop only the zombie retry loops by cancelling their running statements. 57014 is not retried.
1. **Baseline:** failures per minute, CPU, and the count of active authorize backends.
2. **Cancel:**
   ```sql
   select pid, pg_cancel_backend(pid) from pg_stat_activity
   where backend_type='client backend' and application_name ilike 'postgrest%'
     and query ilike '%sophia_memory_authorize_extraction_dispatch%' and pid <> pg_backend_pid();
   ```
   Repeat every few seconds for up to 1 minute. A backend is only cancellable while its statement is running.
3. **Verify** that the failure rate falls to 0 and CPU drops, over 5 minutes.
4. **If loops persist** after 1 minute: stop and report. Do **not** escalate to terminate, restart or revoke without a new OK.
5. No grant, row, schema, plan or compute change.

## A-011 (implementation now; no deploy)
- **A migration** on a new branch `codex/mem00-non-retryable-errcodes` from the current production DB lineage. For every **deterministic** business-rule `RAISE … ERRCODE='40001'` in RPC-exposed functions, use a non-retryable code. The simplest is the default `P0001`, keeping the same message text. Real serialization failures stay native, so no retry semantics are lost.
- **Client code:** check whether any client (gateway store, deck-quality dispatcher, build mutations) branches on SQLSTATE 40001 or on HTTP status. Keep the mappings by message/code, so callers still see the same error.
- **Tests:** a migration-level test asserting that no `ERRCODE='40001'` raise remains in RPC functions, plus focused store tests.
- **Deploy:** DB migration deploy **only** with Davide's OK after my review. It is a production schema change.

## Handback
- `codex-019`: A-009e before/after numbers, if approved.
- `codex-020`: the A-011 PR.
- Ring #154. A-010 continues in parallel under claude-023.
