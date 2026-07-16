# Campaign DQ-1 State

Last updated: 2026-07-16 (US/Pacific)

## TERMINAL STATE

`PREMISE_INVALIDATED`

The campaign did not deploy its DQ-1 candidate. A mandatory predeploy audit
disproved the load-bearing section 8.3 assumption that Sophia already has a
durable, replayable builder-event path. The required amendment is
`amendment-001-durable-builder-event-premise.md`.

This is not `ACHIEVED`: production-canary reliability and quality gates were
not run. It is not `BLOCKED`: no missing credential or external outage caused
the stop. Per section 22, a false load-bearing architecture premise requires an
amendment and termination rather than a deployment that only appears durable.

## MISSION

Deploy an independent rendered-deck quality controller into the real production
topology in canary-scoped shadow mode, preserving native artifact delivery and
all locked invariants.

## BASELINE AND PRODUCTION ROLLBACK

- Campaign branch: `codex/sophia-observability-v1`.
- Frozen source/production SHA:
  `f05efb3adce121fb0af009407b7fc53ba6e98312`.
- Immutable rollback tag: `dq1-baseline-f05efb3`.
- Render gateway deploy: `dep-d9bu80navr4c73bbbk00`.
- Render LangGraph deploy: `dep-d9bu80ojs32c73ed9pk0`.
- Vercel app build:
  `7092042b13f3edc40468fd614685d7ede3b21f2a`, deployment
  `dpl_Bv2yaEMssrnz6JnGhQtsxP9RgQjR`.

No DQ-1 migration, environment change, Render deploy, or new production canary
was performed from the candidate tree. The production rollback point therefore
remains the unchanged baseline, not a post-DQ deploy.

## BEST QUALITY RESULT

`dq1-sol-smoke-v9` is the final paid offline calibration result. Against the
frozen five-slide PSI fixture it produced:

- quality run
  `quality_fad93a9e830a2c8a198c4eadfd7e9540073674c41ec85859150094fd05549087`;
- `needs_revision`, matching the supplied expectation;
- mechanical status `passed`;
- five expected, rendered, and evaluated slides;
- weighted score `4` and failing critical criteria
  `narrative_arc_and_pacing`, `signature_realization`, and
  `subject_specificity`;
- four of five supplied required failure codes, with
  `low_sequence_rhythm` still missing;
- exact A/C input counts 22,633 and 23,671 tokens;
- projected worst-case cost `$0.591520` under the immutable `$0.60` ceiling;
- actual two-call cost `$0.456280`; and
- no adaptive downsampling, provider storage, response continuation, automatic
  private-payload tracing, enforcement, repair, or Advisor activity.

The immutable result bundle is under
`offline-runs/dq1-sol-smoke-v9`. It establishes one supplied synthetic negative
anchor, not human-corpus agreement or promotion readiness.

## ENGINEERING RESULT

The candidate established and tested:

- a compiled rubric, strict A/B/C schemas, complete-slide evidence, and
  deterministic adjudication;
- a provider-routed, exact-two-call judge with exact count/generation request
  parity and fail-closed cost admission;
- no automatic tracing of raw judge messages, images, plans, or provider-private
  state;
- immutable source/run records, leased dispatch, bounded safe trace records,
  restart/idempotency guards, and real-PostgreSQL persistence tests; and
- a blind-context boundary derived only from the sanitized current request.
  Plan-only sentinel changes cannot alter the blind brief, messages, canonical
  Responses input, or payload hash.

Verification on the final integrated candidate tree:

- full backend suite: `4162 passed, 95 skipped, 3 warnings`;
- focused publication/persistence/worker regression: `44 passed`;
- focused blind-context pipeline: `72 passed`;
- real PostgreSQL publication/quality integration: `5 passed`;
- prescribed builder/gateway sweep: `267 passed`; and
- campaign-touched Python Ruff checks: passed.

Local correctness does not repair the missing durable producer boundary and is
not a deployment gate by itself.

## INVALIDATED PREMISE EVIDENCE

The actual production-path implementation has two unrecoverable process-death
windows:

1. terminal delivery succeeds before DQ preparation/admission begins; death in
   that interval leaves no durable publication row; and
2. DQ admission succeeds before local-only source capture/upload/commit; death
   in that interval strands `awaiting_inputs` without a reconstructable source
   pack.

The producer uses a daemon thread and process-local deduplication. The gateway
terminal worker is in-memory. Best-effort LangGraph thread-state persistence is
not an indexed outbox. The artifact registry lacks the current request and
creative/design/build inputs. Build-foundation shadow mode does not durably
mirror those inputs. Bounded retries or a second POST cannot provide restart
safety.

Consequently the candidate cannot satisfy:

```text
eligible-canary shadow dispatch rate = 100%
restart-safe durable asynchronous publication
durable shadow_dispatch_unavailable evidence
```

## LOCKED INVARIANTS AT CLOSE

All sixteen campaign invariants remain locked. In particular, production still
has no DQ-1 enforcement, artifact mutation, automatic repair, Advisor,
ordinary-user OpenAI processing, or builder/companion model migration. No
changes were made to `soul.md` or `voice.md`.

## SUCCESSOR REQUIREMENT

Continuation requires a newly authorized or amended campaign that first adds:

- canary-only immutable, manifest-last source mirroring under shadow authority;
- a durable producer outbox written before detached delivery;
- independent delivery and DQ reconciliation so DQ recovery never replays
  delivery;
- durable `shadow_dispatch_unavailable`; and
- startup validation plus explicit degraded DQ readiness.

Only after the required crash/restart tests pass may that successor deploy a
canary-scoped shadow iteration and resume browser, Render, LangSmith, stored
record, and rendered-artifact evidence collection.

## REMAINING QUALITY EVIDENCE

Even after the architecture premise is repaired, `ACHIEVED` still requires the
three PSI-style production canaries, a known-strong canary, an explicit-brand
exception canary, the twelve-fixture human-labeled corpus, repeatability runs,
and all reliability/quality gates. No model output or campaign-agent inspection
was promoted into a human label.
