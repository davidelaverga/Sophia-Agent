# DQ-1 Architecture Amendment 002 — Durable Outbox Reopen

Date: 2026-07-16 (US/Pacific)

Campaign state: `ACTIVE`

Historical state superseded: `PREMISE_INVALIDATED` remains the correct result
for the non-deployed candidate archived by Amendment 001, but it is no longer
the current campaign terminal.

## Authority to reopen

The campaign was explicitly reopened to implement Amendment 001, retain every
locked invariant, deploy only exact-canary shadow behavior, and continue until
an evidence-backed terminal state is reached. This amendment does not relabel
the earlier invalidation or its evidence. It authorizes only the successor
producer architecture described below.

## Replacement producer boundary

For an enabled, exact-canary, successful, non-fallback, mechanically passed
native PPTX build:

1. The existing primary artifact upload uses a public-signable, create-only,
   version- and content-hash-bound key. The ordinary-user upload path and
   upsert behavior remain unchanged.
2. The producer canonically captures the blind brief, creative plan, design
   plan, build record, mechanical record, and locked instrument in a private
   immutable source pack.
3. The source pack is written before a small canonical outbox marker. The
   marker contains identities and immutable path/hash/size references only; it
   contains no PPTX bytes, brief, plans, provider payload, or signed URL.
4. The outbox marker is written before detached terminal delivery begins. A
   canonical durable failure marker is written if the required producer
   boundary cannot be established. Neither result changes delivery status.
5. The gateway lists only the bounded inbox, validates campaign, exact-canary,
   instrument, run identity, and canonical paths before following references,
   then bounded-reads and rehashes both the source pack and accepted PPTX.
6. One atomic database RPC converges request plus source-ready state. The
   gateway then archives the small marker and retires the inbox. Lost responses
   are reconciled by exact replay and row readback; deterministic conflicts are
   durably quarantined without copying a large source pack or PPTX.
7. Producer failure and gateway rejection evidence are flat, bounded, and
   content-free. Any unresolved evidence degrades DQ readiness while the global
   service health contract remains unchanged.

Delivery and DQ reconciliation are independent effects. DQ recovery never
replays terminal delivery.

## Forward-only persistence convergence

The shipped 2026-07-16 migration is immutable. The ordered successor chain is
2026-07-17 atomic publication convergence, 2026-07-18 durable producer-failure
signals, and 2026-07-19 dispatch-intent fencing. Each delta accepts only its
exact known predecessor state, locks the relevant table during convergence,
rejects partial/mixed/unknown catalogs, and independently proves the complete
target catalog before commit. This includes table/type/column/default,
constraint/index/auxiliary-object, routine body/attribute/signature,
owner/ACL, and overload-count fingerprints. The publication delta also
installs the stable source-pack path and atomic request-ready RPC, revalidates
existing v2 rows, and revokes split request/commit RPCs from the runtime role.

## Locked authority

This amendment does not authorize enforcement, artifact mutation, automatic
repair, Advisor, broader sampling, ordinary-user OpenAI processing, or any
builder/companion model migration. Production configuration remains:

```text
enabled=true
mode=shadow
scope=canary
canary_user_ids=<dashboard-managed exact synthetic identity>
mutate_artifact=false
affect_delivery=false
sample_rate=0
```

The pre-existing builder provider and fallback configuration is preserved
exactly. The DQ-only provider credential is separate and is injected only
after exact canary admission. The gateway receives no DQ-specific OpenAI
credential; its pre-campaign environment remains otherwise unchanged.

## Required deployment gates

Before a production canary:

- all focused crash/replay, storage, routing, privacy, graph, PostgreSQL, and
  full-build tests must pass;
- the historical migration must be byte-identical to repository `HEAD`;
- production must have the forward migration, exact canary environment on
  both services, and the DQ-only provider credential on LangGraph only;
- both Render services must deploy the same reviewed SHA with an explicit
  reverse-order rollback path; and
- readiness must show zero unresolved producer failure/rejection evidence.

For every runtime-significant iteration, the fixed canary prompt must be
submitted through the real `sophia-ei.com` application using computer use.
Render logs, LangSmith traces, durable publication/quality rows, and rendered
artifacts must be correlated. Because the producer boundary executes before
the detached delivery thread, zero material user-visible delay, path/status
divergence, or duplicate delivery is a mandatory live canary gate.

## Terminal states

Local correctness or one successful canary is not `ACHIEVED`. The original
campaign gates still require three PSI-style production canaries, a
known-strong canary, a brand-exception canary, twelve independently
human-labeled fixtures, six complete bundles, repeatability, zero critical
false accepts, and the locked reliability/privacy thresholds. If required
credentials, corpus labels, or production authority are unavailable after all
safe in-scope work is exhausted, the campaign must record an explicit external
decision terminal rather than fabricate evidence.
