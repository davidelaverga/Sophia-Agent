# codex-036 — R-003 read-only Mem0 checks
Observed 2026-09-26 ~20:20–20:27 UTC. No production changes, Lab actions, database writes, or retention changes.
## M1 — existing keys and scope
| Check | Gateway key | LangGraph key |
|---|---|---|
| Key comparison | Not equal | Not equal |
| GET /v1/ping/ (one call each, configured org/project) | HTTP 200 | HTTP 200 |
| Returned org/project/account/user identity | Unavailable: response has only status | Unavailable: response has only status |
| Same existing non-test memory query, same owner/configured scope | HTTP 200; 10 hits | HTTP 200; 10 hits |
Configured org ID: org_UIGCqdvDj2Yl9F7y9bTEIhQdzH4JX9bYT58i9FPt.
Configured project ID: proj_q1I90sXEFJXjVt3Mvghj2P7nKEfzPvT9h0t9Ft3Z; signed-in dashboard project ID equal.
The known non-test record is month-old, owned by the cohort principal in the legacy owner namespace; both result-ID sets are equal (10/10), including d1618431-0073-447d-aaba-30b093023eec.
Search used the same query, owner filter, org/project, and limit=100; 10 is the returned count, not a complete inventory or governed-admission proof.
Neither key exhibits a configured-scope access difference in this search. Resolved identity equality and default-scope mismatch remain UNKNOWN; HTTP 200 and equal results do not resolve them.
## M2 — metadata failure and R-001 searchability
c17f9d6c-faf5-4d29-9668-b90da18fcbbb: R-002 observed provider_error / mem0_initial_metadata_not_preserved; current receipt is stale, attempt 7, canonical_state_changed_before_call, completed 18:23:07.549263Z.
Exact mismatched field names: UNAVAILABLE. Deployed adapter raises a generic code for a missing/non-object metadata value or any unequal field; it does not preserve a field diff.
Gateway two-day search for that error code has no matching logs. Mem0 request 0e541ec0-832d-4e3e-b05b-2d875a159600 retains submitted metadata, not the failing exact-ID readback; submitted fields are not evidence of which failed.
595f2773-de35-4de3-955f-e33c5164e3cd remains direct_write_verified / provider_metadata_verified at 17:24:36.460885Z.
A current owner-scoped synthetic search returns gateway HTTP 200 / 0 hits and LangGraph HTTP 200 / 0 hits after Forget/purge.
Whether the R-001 write was later searchable by the gateway BEFORE purge is UNPROVEN; no historical gateway-key hit count was recovered. Current zero cannot answer that historical question.
## M3 — voice
Davide's DevTools capture is missing: Console, Google WebSocket status/close code/reason, and on-screen error are unavailable; conditional frontend code mapping not performed.
## Ranked causes and proposed fix — approval required, nothing applied
Recall #1: provider projection/readback contract failure is proven for R-002; the offending fields and provider-side cause are not established.
Recall #2: provider indexing or governed namespace/filter behavior remains plausible for R-001 (verified write, retrieval zero); legacy-owner search parity does not test governed filters.
Recall #3: differing API-key scope is weakened by equal 10/10 results; it is not demonstrated and does not justify replacing either key.
Voice #1: browser activation/WebSocket path remains the leading unlocalized hypothesis given R-002 gateway 200/voice creation 201; no browser capture supports an exact repair.
Exact proposed first patch: in Mem0ProjectionAdapter.project_revision, record only missing/unequal metadata field names (or metadata-not-object), provider IDs and operation ID in the safe failure receipt; preserve fail-closed verification and exclude values/content/keys.
This closes the diagnostic gap; a behavior-changing repair is not yet justified. After approval, use the field evidence and a read-only governed-filter comparison to choose that repair; no credential alignment or metadata coercion is proposed.
Rollback for that proposed diagnostic patch: revert it and restore the currently served gateway eb849b62 and LangGraph def5c454 if either is deployed with it; no data/schema/env rollback. Voice/frontend stay f128af0c/12ce0f89.
STOP: awaiting approval; A-014b automation and kill=true worker/MCP untouched.
