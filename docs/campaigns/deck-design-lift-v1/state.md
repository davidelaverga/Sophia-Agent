# DQ-2 Campaign State

Updated: 2026-07-18T02:32:51Z

## CURRENT DEPLOYED SHA

- gateway: `f54f2c617f764676c9d23dc5383933147fcc68cf`
- LangGraph: `f54f2c617f764676c9d23dc5383933147fcc68cf`
- frontend: `7092042b13f3edc40468fd614685d7ede3b21f2a`

## CURRENT BEST RESULT

Production DQ-1 persistence, publication, producer-failure signaling, and dispatch are migrated and ready on PostgreSQL 17. Gateway and LangGraph are healthy on the same exact commit, and LangGraph has successfully submitted metadata to the LangSmith EU endpoint with builder tracing enabled. No fresh DQ-2 before/after artifact exists yet.

## CURRENT BOTTLENECK

The durable DQ-2 mutation and invoke-once boundaries are now implemented and locally proven. The highest-leverage blocker is completing the production evidence, repair-authoring, candidate-compilation, and graph adapters without weakening the frozen transaction or blind-judgment contracts.

## ACTIVE HYPOTHESIS

If production adapters reconstruct only hash-verified manifest-addressed sources and DQ-1 evidence, then the proven restart-safe controller can author exactly one candidate, obtain a fresh blind quality run, and commit only a deterministic approved improvement.

## CHANGE MADE

- Reset the Supabase database credential and updated both Render services with the authenticated pooled PostgreSQL 17 DSN.
- Made DQ-1 migrations `2026_07_17` through `2026_07_19` fail closed on PostgreSQL 15, 16, and 17 catalog/ACL fingerprints, then applied all three successfully in production.
- Deployed Gateway (`dep-d9dcske1a83c739aqnhg`) and LangGraph (`dep-d9dctqgk1i2s73er9vtg`) from the exact same full SHA.
- Verified Gateway DQ-1 persistence, publication, dispatcher, and producer-failure readiness and LangGraph `/ok` = 200.
- Verified the signed Gateway probe and LangSmith EU metadata submission without exposing credential values.
- Added a DQ-2 startup gate that requires identical DQ-1/DQ-2 canary scopes, manifest enforcement, mutation enablement, locked judge/repair routes, durable objects, and a live mutation RPC probe.
- Added the service-role-only DQ-2 transaction schema, frozen identity/path fences, lease recovery, and one atomic manifest-head/registry/outbox/mutation commit RPC.
- Added the restart-safe one-repair runtime, strict repair route admission, stateless structured repair invoker, and durable intent/result invoke-once fence.
- Locked the DQ-2 migration to SHA-256 `90fc8815aa630b74b16303a17cf2a712b2eca8e767573bd2f48b458a2017ace5`.

## LOCAL VERIFICATION

- PostgreSQL 17 real-database DQ-1 suite: `48 passed`.
- PostgreSQL 16 real-database DQ-1 suite: `48 passed`.
- Frozen DQ-2 migration apply/replay and full lifecycle/ACL matrix passed on PostgreSQL `16.14` and `17.10` with all seven exact RPC signatures.
- DQ-2 migration runner: `34 passed`; combined DQ-1/DQ-2 migration runners: `64 passed`.
- DQ-2 transaction/config/invoker/runtime/policy checkpoint: `123 passed`; invoke-once focused sweep: `86 passed`.
- Ruff check and format checks passed for the frozen migration, transaction, runtime, invoker, and invoke-once files.
- All backend tests used `PYTHONPATH=. uv run pytest` from `backend/`.

## PRODUCTION RESULT

Infrastructure checkpoint passed. Production migrations `2026_07_17`, `2026_07_18`, and `2026_07_19` succeeded; both services are live on `f54f2c61...`; Gateway reports DQ-1 ready; LangGraph is healthy and connected to LangSmith EU. A fresh DQ-2 task has intentionally not been submitted because mutation authority remains disabled.

## KNOWN RULED-OUT CAUSES

- Supabase password/DSN failure.
- PostgreSQL 17 catalog fingerprint incompatibility in the locked DQ-1 chain.
- Render authentication or same-SHA deployment failure.
- LangSmith authentication or EU workspace/project mismatch.
- Gateway/LangGraph signed-canary authority mismatch.

## NEXT ACTION

Finish and test the production evidence/repair/materialization/graph adapters, apply the locked migration, enable only the exact production canary, deploy one SHA to both services, and then submit the fixed PSI brief through the real app.

## ROLLBACK SHA

`f05efb3adce121fb0af009407b7fc53ba6e98312` (`dq1-baseline-f05efb3`)
