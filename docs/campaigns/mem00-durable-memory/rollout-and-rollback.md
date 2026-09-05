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

- **Explicit exception approved after EI-095 on 2026-09-05:** proceed with MEM00 despite the two already-recorded expired VT00 cleanup obligations, accepting potential loss of those pending voice runs as the user requested. Leave voice recovery and records untouched. This supersedes the cleanup-debt deployment block below only for those historical obligations. Continue checking no executing voice run, healthy expected worker and closed voice mutation gates; preserve truthful unconfirmed receipts. It does not waive any MEM00 isolation, provider contract, five-canary or terminal-zero requirement.
- Re-read remote head, deploy IDs/revisions, schema digest/epoch, flags, Mem0 usage/configuration, and LangSmith target before every certification run.
- Query Voice Lab run/lease state immediately before any deployment. If a run is active or cleanup is incomplete, do not deploy.
- Join the lab count to Gateway retention readiness and exact product cleanup receipts. Worker hard retention can delete an expired terminal lab row with `cleanup_complete=false`, leaving only an **unconfirmed** keyed tombstone. Zero lab rows or a provider DELETE 404 cannot clear a still-pending product obligation. Before worker restart, preserve the allowed content-free identity join and establish its retention side effects; never promise evidence preservation based solely on restart being non-destructive at the UI level. See `worker-recovery-20260905.json`.
- Plugin use is not required for this read-only guard. The public `/readyz` response and narrowly scoped, read-only ledger aggregates can supply evidence. A capability envelope with `run_id=null` is not a global count. An expired terminal run with `cleanup_complete=false` still blocks deployment; no live worker/browser lease is not terminal-zero proof. On 2026-09-05 this exact case was measured directly and recorded in `deployment-gate-20260905.json`.
- Use only the synthetic principal and derived provider subject for R3/R5.
- Refuse cross-owner or unresolved destructive targets and enter `SECURITY_HOLD` where the mission requires it.

## Safe rollback

**Deployment gate (2026-09-05): do not use the flag-only shutdown on deployed
`5f7f151`.** EI-081 proved that version reopens legacy search/cache and generic
memory when governed recall is disabled. A local repair, covered by
`tests/test_mem00_recall_rollback.py`, preserves quarantine using canonical
ownership and clears carried companion/Builder memory state. Verify and deploy
that repair before applying the sequence below. The attempted flag edits were
canceled without saving.

1. Close governed runtime recall, producing zero memory.
2. Stop projection claims and fault injection while preserving durable desired-state jobs. Close `GOVERNED_RUNTIME_READ`, `PROVIDER_PROJECTION`, and `FAULT_INJECTION` together; the validated flag contract rejects faults without projection.
3. Keep canonical UI and tombstone fencing active.
4. Drain/cancel only resolved synthetic work and retain content-free receipts.
5. Restore a prior binary only if it refuses every raw legacy memory path under the current epoch. Otherwise leave memory disabled.

The additive schema is not dropped during rollback. Provider deletion is not canonical deletion; a canonical tombstone fences admission before purge. Unknown database/provider state always fails closed.

### Authenticated-owner deployment regression

Before cohort activation, join a fresh ordinary signed-in product request to
its timestamped Gateway route and exact Better Auth owner. Compare that owner
with both `CERTIFICATION_PRINCIPAL` and the single-member `COHORT_PRINCIPALS`,
using fingerprints in evidence; reject guessed UUID aliases. Verify separation
from the preserved VT00 principal and zero candidate/canonical/binding/job/fault
state. Enter controlled form values with select-all/type/blur, verify settled
values, save, reload, and verify persisted values. After serialized exact-SHA
deployment, verify effective runtime fingerprints and the ordinary canonical
Journal before creating a candidate. EI-078/EI-079 show why a UI save click or
an empty legacy response alone does not satisfy this regression.

### Current provider reconciliation gate

SH-001 is resolved on running Gateway/LangGraph `3c3a636`: both report replacement
reference fingerprint `sha256:70c4ec6052335991` through the allowlisted diagnostic.
DP-007 proves the Gateway replacement Mem0 key deletes its exact synthetic row
(HTTP 200, paginated zero). It also exposes list metadata stringification; fix
the adapter using exact-ID typed readback and repeat full R3 before activation.
Do not replace another key or alter provider settings to address this mismatch.

Historical credential hold (superseded):

**Superseded by SH-001 on 2026-09-05:** the user approved the new key and Gateway
now runs fingerprint `sha256:8388812563a212e0`; LangGraph's key is unchanged.
No new provider fixture/delete proof ran. The agent's prefix-selected runtime
diagnostic exposed the separate reference HMAC secret. Both repaired services
are now closed for runtime recall/projection/fault injection, with canonical
review and tombstones preserved. HMAC rotation approval is pending. Use only
the allowlisted `deerflow.sophia.memory_governance.runtime_pin` module once
deployed; never dump `SOPHIA_MEMORY_*` values. Retain old content-free evidence
and record the reference-key transition instead of rewriting historical refs.

Historical provider-key failure:

DP-005 passed with key fingerprint `sha256:a489adc448f942ed`; DP-006 measured
the currently deployed key `sha256:109d881133f29ed5` and exact SDK deletion
failed. Its one isolated synthetic fixture was deleted in the dashboard and
paginated SDK enumeration returned zero. The earlier R3 success is therefore
not current authorization evidence. No more provider fixtures may be created
until the credential binding is repaired under the requested same-project
key-only approval, followed by a fresh complete hosted proof. Do not alter
SDK/API/project/configuration/plan/billing to work around the failure.

## Historical grouped action proposed for approval

The first migration/deployment and initial replacement-key actions below were
subsequently approved and executed. They are retained as historical scope, not
as a fresh approval request; the current additional key request is above.

- Diagnostic target: existing Mem0 organization/project only. Create one unmistakably synthetic row and test the current documented `DELETE /v1/batch/` `memory_ids` payload from the deployed Gateway shell. Delete only that row and prove pagination-complete zero. If the API still denies deletion, stop projection and do not create additional provider rows.
- Conditional credential action: only if the documented-payload diagnostic fails and the user authorizes it, create one new API key in the same existing Mem0 organization/project, replace only the Gateway's `MEM0_API_KEY`, and rerun the full R3 contract. This changes no SDK/API version, endpoint, project, configuration, algorithm toggle, plan, or billing. Preserve the prior key for immediate rollback until the replacement is proven; do not revoke it in this action.
- Production target after R3 passes: Supabase project `vlxnwmyvhchwbousrdzc`; existing Gateway, LangGraph, Voice, and frontend services only.
- Database action: apply exactly `backend/migrations/2026_09_02_mem00_durable_memory_governance.sql` (SHA-256 recorded in `forensic-pin.md`) once; the migration is idempotent and additive, seeds epoch 1 in `disabled` mode, and grants no browser access.
- Application action: deploy one frozen MEM00 candidate to the participating existing services with every `SOPHIA_MEMORY_*` feature flag false and without changing existing Mem0 configuration.
- Reversibility: restore the prior Mem0 key if the conditional credential probe fails; close all new flags and stop workers immediately; retain tables/jobs/receipts. Do not drop schema or purge provider data as rollback.
- Cost/risk: no new paid service and no planned plan/billing change. Primary risks are schema/RPC incompatibility, mixed deployed revisions, or accidental flag activation; the dark-deploy validation explicitly checks each.
- Validation: complete R3 deletion/terminal-zero proof first; then schema digest/epoch/role checks, exact deploy SHA/health, flag snapshot, no provider request delta attributable to MEM00, no real-user behavior change, zero active Voice Lab run, and zero-tolerance counters at zero.
