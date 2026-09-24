# codex-011: A-009 Supabase CPU read-only diagnosis

Epoch: voice-next-20260924 · In reply to: claude-017/018 @ `4f8f07af321bc6f31658a5f357dba7fb4317e9c8` · Written 2026-09-24T19:05Z

## Dashboard and current signal

- Sophia Supabase is Pro, **Micro / t4g.micro**, West US. CPU was sustained around 85–95% over the last hour, about 65–70% user and 20% system; 24-hour graph is also high. Seven-day graph suggests onset around Sep 20/21, before today's gateway redeploys at 10:38–11:33Z; chart resolution does not establish an exact onset.
- Unified Postgres logs reported about **359.5k errors in the last hour**, dominated by SQLSTATE `40001` / `memory_extraction_dispatch_ineligible` in `sophia_memory_authorize_extraction_dispatch` (the PL/pgSQL eligibility guard). The dashboard also showed 8.61M Postgres errors / 9.04M total requests over 24h; its aggregates mix log/request categories, so these are dashboard counts, not a verified count of unique client requests.
- At a live sample, `pg_stat_activity` showed 16 active PostgREST sessions waiting on locks inside that authorization RPC, 2 running, 1 LWLock. A follow-up showed short transient wait chains (~10 ms), **zero active queries >1 s**. No evidence for a single long blocker. The extraction queue had 12 `succeeded_zero`, 10 `succeeded_nonzero`, 5 `superseded`, 5 `failed_terminal`, and **no row touched within 1h**, no queued/leased/retry work. This is a failed-authorization storm against stale/ineligible work, not evidence of extraction progress.

## Requested SQL A–E, trimmed

`pg_stat_statements` reset was **2026-04-23 22:16Z**. A/B totals are cumulative since then, so they identify overall consumers, **not the current CPU source by themselves**. Query text below is normalized; no literals or user data.

| A: cumulative execution time | Calls | Total seconds | Share | Likely source |
|---|---:|---:|---:|---|
| PostgREST request-context `set_config` | 413.8M | 12,023.9 | 41.6% | Supabase PostgREST request setup; not a Sophia SQL statement |
| `pg_proc` procedure list | 628.8k | 2,663.2 | 9.2% | Supabase dashboard/metadata catalog introspection; exact issuer unproven |
| `storage.search` | 3.26M | 1,703.9 | 5.9% | Storage API; API logs include Builder artifact listing `/storage/v1/object/list/sophia-builder-artifacts`; caller path may include artifact registry |
| `pg_proc` procedure detail | 628.8k | 1,409.9 | 4.9% | Supabase dashboard/metadata catalog introspection; exact issuer unproven |
| `pg_advisory_xact_lock(hashtextextended(...))` | 29.6k | 1,240.8 | 4.3% | Advisory-lock user unknown; gateway retention/leases are candidates, no attribution |

B by calls: PostgREST context 413.8M; privilege catalog 8.18M; `BEGIN` 3.70M; `COMMIT` 3.69M; another request `set_config` 3.38M; `storage.search` 3.26M; `sophia_memory_contract` 2.32M. Deck-quality shadow/publication claim RPCs each ~1.1M cumulative; their source paths are `backend/app/gateway/workers/deck_quality_dispatcher.py` and `deck_quality_publication_worker.py`. `sophia_memory_authorize_extraction_dispatch` has only 26 **completed successes** in statements stats; failed calls are not represented by that number.

C: PostgREST `::1` backends dominate the active authorization waits; `client_addr` does not identify the external issuer. D: no client query active >1 s in the sample. E: cumulative scan leaders: `sophia_memory_contract` 410.6M seq scans / 1 live row; deck shadow claim receipts 189.0M rows read / 690 live / 126 dead; deck publication claim receipts 178.5M / 665 live / 66 dead; `sophia_memory_user_governance` 103.0M / 1 live / 41 dead. These figures do not establish a missing index or present-hour cause.

## Attribution, mitigation, and remaining work

The failing function's guard is in `backend/migrations/2026_09_09_mem00_c1_extraction_dispatch.sql`; the normal gateway caller chain is `backend/app/gateway/workers/memory_governance.py` → `backend/packages/harness/deerflow/sophia/memory_governance/extraction_service.py` → `extraction_dispatch.py` → `store.py`. The worker polls each second and only calls authorization after claiming an eligible run. No currently eligible extraction row exists. Render gateway logs over the CPU window returned no `MEM00 worker cycle failed`, `memory.governance`, or `memory_extraction` matches. API Gateway path facets show ordinary memory/deck RPCs but no dispatch RPC path despite the Postgres failures; telemetry coverage may differ. **The issuing client is unproven**, and disabling this gateway worker cannot be assumed to stop the storm. Gateway Lab auth and D02 DSNs resolve to this Supabase pooler; the separate Lab worker uses Render Postgres. No evidence implicates either Lab path.

**Proposed single reversible mitigation:** once the issuer of the dispatch calls is identified, pause that issuer's extraction-dispatch loop (not all Supabase traffic), then compare error rate and CPU for five minutes and restore if unchanged. At present, the issuer is not identified, so no production change is justified. **Davide approval: not requested or received; mitigation: not applied.** No schema, data, reset, plan, compute, gateway, or test-run change was made. Next diagnostic is to correlate failing RPC request identifiers with PostgREST/edge access telemetry or issuer-side logs; current SQL/Unified Logs expose only internal `::1` and no external client identity.

A-008 resumes after this handback. Its three implementation PRs and R1/R2/R3 retention obligations remain open; no live provider run or budget reset follows from this diagnosis.
