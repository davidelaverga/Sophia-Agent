# M00 — Current Production Campaign Closeout and Contract Freeze

**Mission type:** production quality / evidence / prerequisite  
**Primary owner:** Davide  
**Luis parallel lane:** observe final artifact states and build the first visual state references  
**Current branch context:** DQ-2 Deck Design Lift, inspected at head `9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca`

## Outcome

Produce one production deck through the intended path that:

1. survives strict Deck IR or is repaired once deterministically;
2. compiles as the intended editable/native artifact;
3. passes mechanical and rendered design checks;
4. receives at most one targeted repair;
5. is judged improved after repair;
6. is then stopped for human review;
7. leaves a complete evidence archive and a stable event/manifest example for the broader product program;
8. freezes the boundary between canonical product records and supplemental LangSmith evidence before later missions build on it.

## Why this mission comes first

The current campaign is the only deeply instrumented, real production loop. It is the best source of truthful event semantics, failure states, artifact-version behavior, and evaluator transitions. The next platform should generalize from this evidence rather than interrupt it with a broad rewrite.

## Current reality

The latest campaign record showed a safe failure before artifact publication because the authored anchor contract was incomplete. The current branch head adds a narrowly guarded deterministic normalization for that exact source pattern. This patch must be evaluated with the existing frozen prompt before the platform program depends on its results.

The same inspected head also establishes the Companion/voice baseline that later missions must migrate from rather than describe as finished:

- Builder LangSmith tracing is scoped and useful, while Companion primary/fallback tracing is disabled;
- Gemini Live realtime is the primary voice runtime; the cascade remains the stabilization fallback;
- the browser owns the Gemini Live WebSocket and the backend currently observes only selected relayed events;
- the model-authored per-turn `emit_artifact` is produced after a response and therefore cannot regulate voice that has already been spoken;
- the local artifact-derived trace logger treats model tone output as ground truth (including a `+0.5` golden convention), which is not an acceptable evaluation authority;
- the frontend feedback proxy can report success when the backend feedback route is absent;
- there is no complete, trusted Companion → Builder distributed trace or Companion-grade masking, sampling, retention, and per-user tracing opt-out yet.

These are baseline facts, not target contracts. The Tone Scale and its scalar reward convention are **superseded** as final ontology, runtime policy, and evaluation truth. It may run only as a time-boxed, non-authoritative shadow baseline until parity evidence is captured.

## Scope

- deploy and verify exact head;
- run one fresh authenticated frozen-prompt experiment;
- preserve one shared input-repair ceiling;
- capture all build/manifest/mutation/quality events;
- confirm no failed candidate publishes;
- confirm repaired candidate is objectively better before presentation;
- generate one canonical event timeline fixture from the run;
- capture a redacted Companion/Gemini/Builder observability gap fixture and migration checklist;
- freeze semantic events and small app-authored receipts as product truth, with LangSmith as optional evidence only.

## Non-scope

- no unified session event fabric yet;
- no new Workstream UI yet;
- no LoopRun refactor;
- no co-review;
- no Hydra/Graphiti work;
- no broad deck compiler rewrite unless the current hypothesis is disproved;
- no immediate deletion of `emit_artifact`; removal follows dual-write parity and replay gates;
- no use of LangSmith as runtime state, feedback truth, replay source, or a dependency for user-visible success.

## Work packages

### M00.1 Deploy identity and health

- commit/push exact scoped patch;
- verify Gateway and LangGraph exact SHA;
- verify health endpoints and LangSmith access;
- record rollback SHA.

### M00.2 Frozen production experiment

- new authenticated session;
- one unchanged prompt;
- no app-level retry;
- correlate browser, Gateway, LangGraph, LangSmith, Supabase, and artifact outputs.

### M00.3 Quality decision

Use the existing campaign stop rule:

```text
fresh build → judge → one repair → judge again → coding-agent self-review → human review
```

The system does not surface “ready” unless repaired output is better than the original candidate and the judge approves it.

### M00.4 Contract extraction

From the successful or safe-failure timeline, produce:

```text
builder-start fixture
strict-IR failure fixture
repair-start fixture
repair-commit fixture
quality-check fixture
terminal-ready or terminal-failed fixture
manifest/component example
```

These become M02 draft inputs and Luis’s first fixture pack.

### M00.5 Companion observability and receipt migration freeze

Publish one signed-off migration contract:

```text
canonical local semantic events + app-authored receipts = authoritative/replayable
LangSmith traces + mirrored feedback                = supplemental evidence
Gemini Live                                         = primary voice runtime
cascade                                             = stabilization fallback
voice trace unit                                    = session root + event spans
Tone Scale                                          = shadow-only, then removed
```

The migration gate is dual-write parity across representative text, Gemini Live, cascade-fallback, correction, feedback, and Companion → Builder handoff scenarios. During dual-write, compare old artifacts to canonical event/receipt projections; never promote the old artifact or LangSmith trace into product truth. Remove model-authored per-turn `emit_artifact`, artifact-derived “ground truth,” and synthetic voice turns only after canonical replay, privacy, and outage tests pass.

## Production scenario

> “Create a five-slide technical presentation explaining PSI agent architecture.”

Keep the user request frozen across the loop so design and runtime changes can be compared.

## Acceptance gates

### Engineering

- exact deployed SHA verified;
- no artifact published on failed strict IR;
- deterministic normalization only fires under its guarded predicate;
- one repair ceiling holds;
- event order and manifest revisions are monotonic;
- no dangling spans/tool calls;
- artifact publication is atomic;
- Companion and voice traces fail open without changing runtime behavior;
- no browser-visible LangSmith credential or trusted public trace header;
- canonical feedback is persisted locally before any optional LangSmith mirror;
- dual-write fixtures join old artifacts, local events/receipts, and LangSmith evidence without treating the latter two observability paths as state.

### Product

- the artifact is demonstrably better after repair;
- mechanical success alone is insufficient;
- the system stops for human review after its own success confirmation;
- failure remains honest and recoverable;
- product state and replay remain correct with LangSmith unavailable;
- no scalar Tone Scale output is used as ground truth, reward, or challenge decision.

### Experience

- Luis receives screenshots/video of each meaningful state;
- the future Workstream vocabulary can explain the run without raw tool jargon;
- “checking,” “refining,” and “ready” map to real states.

## Metrics

```text
prepare attempts
repair count
strict-gate failures
artifact published
mechanical pass
visual judge pass
initial vs repaired score
manifest revisions
terminal reason
time to stable preview
canonical receipt/event completeness
old-artifact parity mismatch count
trace join completeness
masked-field leak count
LangSmith-outage product divergence
Gemini Live / cascade runtime path
```

## Stop condition

**PROMOTE** when one fresh production run either produces an approved artifact after the bounded loop or fails safely with a fully understood new blocker. The mission must also publish the first semantic fixture pack and approve the Companion observability/receipt migration contract. No later plan may assume `emit_artifact`, Tone Scale labels, synthetic voice turns, or LangSmith are canonical state.
