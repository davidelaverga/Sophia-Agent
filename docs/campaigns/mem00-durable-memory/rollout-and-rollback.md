# MEM00 rollout and rollback runbook

## Gate order

1. R0 forensic pin: complete, subject to an action-time refresh before every external run.
2. R1 local containment: implemented; deterministic, architecture, redaction, identity, consumer, and fault tests must remain green.
3. R2 disposable durability: additive migration applies twice and the transaction contract covers owner scoping, idempotency, extraction atomicity, expiry, edit/forget/restore/tombstone, role grants, collision hold, lease fencing, and late completion.
4. R3 synthetic Mem0 contract proof: partially complete and still closed. Direct write, stable ID/search, metadata, pagination, repeated reconciliation, owner isolation, dashboard cleanup, and terminal zero are proven. The deployed credential returned HTTP 403 for exact-ID and pinned-SDK batch deletion. Before R3 can pass, remeasure the current documented batch payload as a bounded same-project diagnostic; if deletion remains denied, use only an explicitly authorized same-project replacement credential and repeat the complete proof. Every created provider row must be enumerated with pagination and deleted, followed by enumeration-to-zero and retained content-free receipts.
5. R4 dark production: requires the user's single explicit approval for the first production schema migration and compatible application deployment. All MEM00 flags remain false.
6. R5 synthetic cohort: flags may be enabled only for the named synthetic certification principal. Run MEM-P01 through MEM-P08 and join product rows, provider bindings, logs/metrics, LangSmith, and UI.
7. R6 legacy inventory/import: inventory is read-only. Any real-user import/backfill or irreversible purge requires separately applicable explicit approval; ambiguity is quarantined.
8. R7 governed cutover: a real-user cohort requires explicit approval. Extraction/read activation is atomic; no mixed old/new authority is allowed.
9. R8 exact-head certification: freeze one immutable candidate/config/schema, run full CI, then five consecutive complete deployed canaries. Any failure resets only the clean-run count.

## Action-time guards

- Re-read remote head, deploy IDs/revisions, schema digest/epoch, flags, Mem0 usage/configuration, and LangSmith target before every certification run.
- Query Voice Lab run/lease state immediately before any deployment. If a run is active or cleanup is incomplete, do not deploy.
- Use only the synthetic principal and derived provider subject for R3/R5.
- Refuse cross-owner or unresolved destructive targets and enter `SECURITY_HOLD` where the mission requires it.

## Safe rollback

1. Close governed runtime recall, producing zero memory.
2. Stop projection claims while preserving durable desired-state jobs.
3. Keep canonical UI and tombstone fencing active.
4. Drain/cancel only resolved synthetic work and retain content-free receipts.
5. Restore a prior binary only if it refuses every raw legacy memory path under the current epoch. Otherwise leave memory disabled.

The additive schema is not dropped during rollback. Provider deletion is not canonical deletion; a canonical tombstone fences admission before purge. Unknown database/provider state always fails closed.

## Grouped action proposed for the user's one explicit approval (not yet authorized)

- Diagnostic target: existing Mem0 organization/project only. Create one unmistakably synthetic row and test the current documented `DELETE /v1/batch/` `memory_ids` payload from the deployed Gateway shell. Delete only that row and prove pagination-complete zero. If the API still denies deletion, stop projection and do not create additional provider rows.
- Conditional credential action: only if the documented-payload diagnostic fails and the user authorizes it, create one new API key in the same existing Mem0 organization/project, replace only the Gateway's `MEM0_API_KEY`, and rerun the full R3 contract. This changes no SDK/API version, endpoint, project, configuration, algorithm toggle, plan, or billing. Preserve the prior key for immediate rollback until the replacement is proven; do not revoke it in this action.
- Production target after R3 passes: Supabase project `vlxnwmyvhchwbousrdzc`; existing Gateway, LangGraph, Voice, and frontend services only.
- Database action: apply exactly `backend/migrations/2026_09_02_mem00_durable_memory_governance.sql` (SHA-256 recorded in `forensic-pin.md`) once; the migration is idempotent and additive, seeds epoch 1 in `disabled` mode, and grants no browser access.
- Application action: deploy one frozen MEM00 candidate to the participating existing services with every `SOPHIA_MEMORY_*` feature flag false and without changing existing Mem0 configuration.
- Reversibility: restore the prior Mem0 key if the conditional credential probe fails; close all new flags and stop workers immediately; retain tables/jobs/receipts. Do not drop schema or purge provider data as rollback.
- Cost/risk: no new paid service and no planned plan/billing change. Primary risks are schema/RPC incompatibility, mixed deployed revisions, or accidental flag activation; the dark-deploy validation explicitly checks each.
- Validation: complete R3 deletion/terminal-zero proof first; then schema digest/epoch/role checks, exact deploy SHA/health, flag snapshot, no provider request delta attributable to MEM00, no real-user behavior change, zero active Voice Lab run, and zero-tolerance counters at zero.
