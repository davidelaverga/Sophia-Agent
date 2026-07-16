# Campaign DQ-1 Final Report

Campaign status: **`PREMISE_INVALIDATED`**

Closed: 2026-07-16 (US/Pacific)

## Outcome

DQ-1 produced a bounded, privacy-hardened rendered-deck judge and a successful
paid offline PSI calibration, but it did not deploy the production-shadow
candidate. The mandatory predeploy audit disproved the campaign's load-bearing
assumption that the existing builder-event path is durable and replayable.

The candidate can lose an eligible DQ publication after baseline delivery, or
strand an admitted publication before local source inputs become durable. No
current event journal, artifact registry entry, or LangGraph thread record can
reconstruct both the publication identity and all required source inputs. A
deployment could therefore report normal user delivery while silently missing
quality observations, contrary to the 100% canary dispatch and restart-safety
gates.

Per DQ-1 section 22, this evidence requires `PREMISE_INVALIDATED`: write an
architecture amendment and stop rather than force the implementation onto a
false premise. Amendment 001 records the evidence and successor design.

## What was established

- The real production baseline was exercised through `sophia-ei.com`, rendered,
  and correlated before DQ runtime changes. Both Render services remain at
  `f05efb3adce121fb0af009407b7fc53ba6e98312`; no DQ deploy replaced them.
- The v9 offline Sol run classified the supplied PSI anchor
  `needs_revision` with mechanical `passed`, complete 5/5 coverage, exactly two
  generation calls, exact count/generation parity, and `$0.456280` actual cost
  under the `$0.60` ceiling.
- Assessment A now derives context only from the sanitized current request.
  Plan-only semantic/style mutations are proven unable to change the blind
  prompt pipeline or request hash.
- Canonical quality records exclude raw images, raw plans, provider reasoning,
  provider response IDs, signed URLs, and credentials. Ordinary-user scope is
  rejected before source or provider reads.
- The integrated candidate passes the full backend suite (`4162 passed,
  95 skipped`), focused restart/persistence suites, real PostgreSQL integration,
  the prescribed builder/gateway sweep, and Ruff.

These are engineering and calibration results, not production reliability
evidence.

## What was not done

- No DQ migration or environment change was applied to production.
- No DQ candidate SHA was deployed to Render.
- No post-DQ production canary was submitted.
- Therefore no candidate DQ LangSmith trace, stored production quality record,
  or production quality artifact bundle exists.
- Enforcement, automatic repair, Advisor, ordinary-user OpenAI processing, and
  builder/companion model migration remained disabled.

Avoiding a known-invalid deploy is part of the terminal decision, not missing
campaign evidence being represented as success.

## Required next campaign

Authorize a durable builder-completion producer amendment before resuming DQ-1:

1. mirror the current request and required source inputs immutably for eligible
   canaries under shadow authority;
2. write an idempotent producer outbox record before detached delivery;
3. reconcile user delivery and DQ publication as separate effects;
4. persist `shadow_dispatch_unavailable` without changing delivery; and
5. expose static configuration failure at startup and transient DQ failure as
   explicit degraded readiness.

The successor must prove both crash windows, store outage isolation,
exactly-once DQ publication, zero duplicate delivery, and zero non-canary reads
before a production deployment. It must then resume the required real-app,
Render, LangSmith, stored-record, and rendered-artifact loop and collect the
missing strong/exception/human-corpus evidence.

## Rollback and preserved state

Production remains at the frozen rollback SHA
`f05efb3adce121fb0af009407b7fc53ba6e98312`, tagged
`dq1-baseline-f05efb3`. The offline v9 evidence, decisions, experiment ledger,
and amendment are retained without relabeling historical runs.
