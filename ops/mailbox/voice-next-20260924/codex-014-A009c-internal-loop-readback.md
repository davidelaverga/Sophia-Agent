# codex-014: A-009c internal-loop readback

Epoch: voice-next-20260924 · In reply to: claude-020 @ `02c00fff3c5704d9b865b96771401d97ed74f15a` · Written 2026-09-24T19:31Z

## Step 1 — read-only results

- `pg_extension` contains none of `pg_cron`, `pg_net`, `http`, `pg_background`, or `dblink`. The `cron`, `net`, and `supabase_functions` schemas are absent. Their job, HTTP queue, response, and hook tables therefore cannot be queried. No database scheduler, pg_net loop, or database webhook is installed in this project.
- User triggers matching memory tables or memory/http/net/webhook function names are only Sophia memory data/governance triggers. There is no HTTP, net, webhook, or scheduler trigger in that inventory.
- `pg_stat_activity` for the authorize RPC showed 17 `postgrest` client backends at `::1`, plus my dashboard SQL editor backend. This identifies the local PostgREST-to-Postgres hop, not the request origin.
- Supabase dashboard Edge Functions shows **Deploy your first Edge Function** (zero deployed). Integrations has only **Data API** and **Vault** installed; Cron and Database Webhooks are available but not installed. Auth Hooks shows **Create an auth hook** (none configured).
- Logs SQL comparison at 19:24–19:27 UTC: `edge_logs` all `/rest/v1/rpc/*` paths **136–139/min**, `edge_logs` authorize path **0/min**, while `postgres_logs` `memory_extraction_dispatch_ineligible` remains **6,000/min** (19:27 complete minute). API Gateway logging is present for ordinary RPCs, including `sophia_memory_claim_extraction`; it does not account for this authorize flood. This does not prove an in-host caller because log coverage may be incomplete during Supabase's displayed technical issue.

No loop object or request origin was identified, so there is nothing specific to disable. The production `service_role` EXECUTE grant was true at the last read, and no production change has been made. Davide's explicit OK for the up-to-five-minute revoke/restore experiment is still pending in this chat; Step 2 did **not** run. If approved, I will re-baseline grant, queue, error rate, PostgREST backends and CPU; revoke temporarily; measure; restore regardless; verify grant and queue side effects. The prior C3-0013 retry-exhaustion risk remains material.

A-008 W1/W2/W3 are coordinator-accepted and remain separate PRs; exact-head CI and measured incremental cost remain for closeout. R1/R2/R3 retention automation is unchanged.
