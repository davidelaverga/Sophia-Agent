# DQ-2 Campaign State

Updated: 2026-07-30T09:03:28Z

## CURRENT DEPLOYED SHA

- gateway: `34217a8aa3b88e59c1ccbb2f4a187a8804adccb4` (`dep-d9hit4uq1p3s73a0q8b0`)
- LangGraph: `34217a8aa3b88e59c1ccbb2f4a187a8804adccb4` (`dep-d9hit4sm0tmc73avii90`)
- both services remain live; Gateway `/health` is healthy and LangGraph `/ok` is true

## CURRENT BEST RESULT

The latest production baseline attempt failed safely before artifact publication. The frozen prompt was submitted exactly once through a wholly fresh authenticated `sophia-ei.com` session. The first call failed the strict slide-1 repair-anchor IR contract. Its single bounded repair corrected the IR and produced exactly five native/editable slides, but one reciprocal material-overlap pair remained on slide 2.

No artifact, artifact version, DQ-1 judgment, DQ-2 transaction, or repair invocation exists for this attempt.

## CURRENT BOTTLENECK

Two consecutive fresh baselines on the same deployment exhausted their one repair with material text-shape overlaps. V50's repaired result was otherwise exactly five slides, native/editable, picture-free, and mechanically evaluated. The repeated family is not a credential, deployment, trace, persistence, or editability failure; it requires an authoring/repair contract change before another production attempt.

## ACTIVE HYPOTHESIS

Promoting existing content containers instead of adding overlay anchors, plus a canvas-global 16px separation rule for unrelated text-bearing rectangles, will prevent the V49/V50 repair-collateral family without relaxing mechanics or the single shared retry budget.

## CHANGE MADE

- Created a fresh authenticated production session.
- Submitted the frozen prompt exactly once.
- Did not click the app-level retry after terminal builder failure.
- Correlated V50 through sanitized Render logs, durable zero-row checks, browser telemetry, and a read-only LangSmith EU traversal of the exact builder root.
- Archived the failure under `evidence/dq2-psi-agent-architecture-20260730t084230z/`.
- Hardened the model-facing system prompt, typed tool schema, authoritative deck skills, and bounded IR/mechanical repair prompts against duplicate anchors and partial text collisions.
- Preserved D2.1.1's one shared input-repair retry.

## LOCAL VERIFICATION

- Exact deployed SHA remained live on both Render services.
- LangSmith EU readback verified the exact V50 builder root, ordered initial/repaired calls, and terminal outcome.
- The repaired build contained five native HTML slides, 53 native text shapes, editability score 1.0, zero pictures, and one reciprocal overlap pair represented by two gate records.
- Monitoring performed no provider call, trace write, application mutation, or DQ-2 transaction.
- All 268 focused contract, service, repair, and runtime tests pass locally; the patch remains undeployed until its commit is pushed and both Render services report the exact new SHA.

## PRODUCTION RESULT

Experiment `dq2-psi-agent-architecture-20260730t084230z` reached `FAILED_SAFELY` with terminal code `deck_prepare_retry_exhausted`. Prepare calls/results were exactly two, the shared repair count was exactly one, schema correction and parallel prepare counts were zero, and durable artifact/DQ-1 row counts were zero.

## KNOWN RULED-OUT CAUSES

- Missing Render, LangSmith, Supabase, or OpenAI credentials.
- Wrong deployed SHA.
- LangSmith EU endpoint/project/workspace mismatch.
- Parent or builder transport failure.
- Typed-schema correction, parallel execution, or dangling prepare calls.
- Artifact or DQ-1 persistence after the failed baseline.
- DQ-2 invocation or transaction creation.
- Native slide-count or editability failure in the repaired V50 build.

## NEXT ACTION

Commit and push only the scoped authoring-contract patch, deploy the exact SHA to Gateway and LangGraph, verify health and LangSmith EU read access, then start one wholly fresh normal-app experiment with the unchanged frozen prompt and new identities.

## ROLLBACK SHA

`34217a8aa3b88e59c1ccbb2f4a187a8804adccb4`
