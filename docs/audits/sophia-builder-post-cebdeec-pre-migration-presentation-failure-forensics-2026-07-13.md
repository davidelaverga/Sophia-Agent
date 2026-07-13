# Sophia Builder Post-Deploy Presentation Failure Forensics

**Incident window:** 2026-07-13 15:31-15:34 UTC
**Builder run:** `019f5c1a-78c2-70b1-a51c-4184fd215630`
**Task:** `019f5c1a-78bd-7e50-b9ca-05cfa6b452ad`
**Deployed commit:** `cebdeecfd937dfc884342c4121f96c32130c7b48`

## Executive finding

The build did not fail because of the missing Supabase schema alone. Missing
tables and RPCs disabled durable event persistence, but the builder continued
through preflight, authoring, tool validation, and DeckBuildService entry. The
fatal failure was a concurrent LangGraph state update after the model emitted
two `prepare_deck_build` calls in one repair turn.

## Failure sequence

1. The event store reported its table and RPC paths missing and opened its
   nonblocking circuit breaker.
2. Bounded research completed and prepare was forced on turn two.
3. The first prepare failed typed argument validation because `creative_plan`
   was malformed JSON encoded as a string.
4. A repair reached DeckBuildService, where strict native validation rejected
   `letter-spacing` and `opacity` as lossy CSS.
5. Separate schema and creative repair counters incorrectly allowed a third
   authoring turn.
6. That response emitted two prepare calls. Both ToolNode branches wrote the
   last-value `builder_result` channel and LangGraph raised
   `InvalidUpdateError`.

The gateway truthfully published a failed completion with no artifact. The
LangSmith root carried failed terminal metadata and feedback but retained a
top-level successful graph status because completion annotation preceded the
concurrent-update exception.

## Root causes

- Duplicate prepare calls were diagnosed after the model turn but were still
  dispatched to parallel ToolNode branches.
- Schema and service validation used independent repair counters, violating
  the one-repair contract.
- Emitting any prepare call disabled the absolute authoring deadline, allowing
  approximately 169 seconds of model authoring against a 120-second budget.
- Model guidance did not clearly enumerate common CSS declarations that native
  compilation intentionally rejects.
- Terminal feedback lacked a deterministic identity, allowing duplicate
  records when terminalization ran more than once.

## Database assessment

The additive build-foundation migration repairs event persistence and
readiness, but it does not repair prepare routing, retry accounting, model
deadlines, or LangGraph state concurrency. The application processes must be
restarted after migration to clear the in-memory event-store circuit breaker.

## Implemented direction

- Reject parallel prepare calls in `after_model`, append one policy-error
  ToolMessage per call ID, and produce one terminal state update.
- Use one global prepare-repair counter while honoring legacy queued state as
  already consumed.
- Keep the 120-second authoring deadline active through the repair turn while
  leaving DeckBuildService under the separate 480-second execution deadline.
- Require object-form creative plans for compact-v2 and derive concise CSS
  restrictions from the canonical compiler capability module.
- Propagate repair and final-failure diagnostics through completion surfaces
  and use deterministic LangSmith terminal feedback IDs.

## Post-deploy acceptance

Run one four-slide and two six-slide canaries. Each must emit prepare by turn
two and before 120 seconds, use at most one repair, finish within eight minutes,
produce no dangling or parallel tool execution, persist build events, and show
the same terminal result in the gateway, task checks, wakeups, and LangSmith.
