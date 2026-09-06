# MEM00_FIVE_ITERATIONS_REACHED — CONTINUE

Recorded 2026-09-06. Clean complete production canaries remain zero.

| Attempt | Candidate | Failure cluster and current result |
| --- | --- | --- |
| EI-102 | a017e58d5aad3b60c4be9fb3a434be2035417293 | Hosted metadata search validation; adapter repaired and hosted proof passed on22f4126. |
| EI-103 | a017e58 plus exporter/search delta | Cross-component command selection; correct declared environments pass. |
| EI-104 | same a017 delta; frontend unchanged | One PDF layout test timing failure; full bounded rerun passed without assertion/timeout edits. Scheduling causality remains unproven. |
| EI-105 | 22f4126b1c797bdebf7507cf022f4b77ca81bf9b | Already-processed explicit End returns500; local revision-guarded no-work finalization repair passes. Hosted rerun pending. |
| EI-106 | same22f4126 | Frontend treats failed End as local success; two fault regressions reproduce and pass after repair. |
| EI-107 | same22f4126 plus end-repair delta | Unsupported asyncio mark in new test; synchronous no-work assertion fixes instrument without dependency change. |

The provider-key-failure hypothesis is falsified for EI-102 by same-key accepted
filters and repaired hosted fixtures. EI-105/106 are product lifecycle defects,
not authentication failures: ordinary authenticated End reached Gateway and
returned500; the database remained resumable while the UI declared completion.
These reveal a missing already-processed-range case and an unsafe local-success
fallback, not a reason to weaken canonical approval or provider authorization.

Safety: exact P01 transcript retained for repaired ordinary End and cleanup;
no new turn, provider row, approved memory, purge, schema/flag/provider change or
voice run. Two older pending candidates remain untouched. Previous provider
probe subjects are verified zero but this is not current product terminal zero.

Next: finish full verification, publish and deploy one exact candidate under a
fresh idle-run guard, repeat ordinary End on the same fixture, join its database
and structural LangSmith receipt, then remove only the identified synthetic
fixture. Continue the memory matrix and observability work; no promotion claim.
