# DQ-1 Architecture Amendment 001 — Durable Builder-Event Premise

Date: 2026-07-16 (US/Pacific)

Campaign terminal: `PREMISE_INVALIDATED`

Production action: none; do not deploy the DQ-1 candidate

## Premise that failed

DQ-1 section 8.3 requires the quality trigger to use the existing durable
builder-event path. The implementation campaign treated that path as an
authoritative, replayable producer boundary from which every eligible canary
could be reconciled into exactly one durable shadow publication.

Repository inspection disproved that premise:

- the LangGraph completion publisher runs terminal delivery in a daemon thread
  with process-local deduplication;
- the gateway builder-events worker is explicitly in-memory only;
- baseline delivery receives its successful response before DQ preparation and
  admission begin;
- DQ admission uses bounded process-local retries and drops the request after
  exhaustion;
- the creative plan, design plan, build record, and sanitized current request
  are captured and uploaded only after the DQ admission acknowledgement; and
- an admitted `awaiting_inputs` row can be expired, but no durable source can
  reconstruct its missing source pack.

The artifact registry cannot repair the gap because it retains the accepted
PPTX identity, not all source-pack inputs. Best-effort LangGraph thread-state
updates are not an indexed outbox. Build-foundation shadow mode keeps source
files local; its current durable source upload is coupled to forbidden enforce
mode.

## Unrecoverable windows

Two independent process-death windows therefore remain:

1. after baseline delivery succeeds and before DQ admission, no publication
   row exists to reconcile; and
2. after DQ admission succeeds and before source-pack upload/commit, the row is
   permanently missing the local-only inputs needed to run.

Longer retries, a second POST, or an all-thread LangGraph scan cannot close
either window. The candidate consequently cannot prove the required 100%
eligible-canary dispatch rate or restart safety.

## Why deployment is forbidden

Deploying would make the campaign appear operational while silently losing or
stranding eligible canary observations on process death. That would violate the
durability target, the `shadow_dispatch_unavailable` acceptance rule, and the
campaign's evidence-driven terminal contract. No migration, environment
change, Render deployment, or production canary was therefore performed from
the candidate tree.

The production rollback remains the unchanged gateway and LangGraph SHA
`f05efb3adce121fb0af009407b7fc53ba6e98312`, tagged
`dq1-baseline-f05efb3`.

## Required replacement architecture

A successor campaign must explicitly approve and implement a durable producer
boundary before reviving DQ-1 production shadow:

1. Add canary-only `mirror_sources` behavior under shadow authority. Persist
   the sanitized current request plus creative, design, and build inputs as an
   immutable, manifest-last source bundle without enabling foundation
   enforcement.
2. Before detached delivery begins, write an idempotent durable
   `artifact.accepted`/`build.terminal` outbox record containing only safe
   identities and the source-bundle path and hash.
3. Reconcile delivery and DQ admission as independent effects. DQ recovery must
   never replay user delivery.
4. Persist `shadow_dispatch_unavailable` when DQ persistence is unavailable,
   while leaving artifact status and delivery unchanged.
5. Fail static DQ route/instrument configuration at startup. Expose transient
   DQ store/dispatcher failure as explicit degraded DQ readiness rather than a
   globally healthy service with a silently absent worker.

Required restart tests must cover death on both sides of admission, storage
outage isolation, exactly-once source/run/graph publication, zero duplicate
delivery, and zero non-canary source or provider reads.

This is a load-bearing architecture amendment, not a patch to the current
second-POST protocol. Per DQ-1 section 22, the campaign stops at
`PREMISE_INVALIDATED`; continuation requires a newly authorized or amended
campaign grounded on this durable producer design.
