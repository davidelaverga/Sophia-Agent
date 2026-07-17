# Campaign DQ-1 State

Last updated: 2026-07-16 (US/Pacific)

## CURRENT STATE

`ACTIVE — AMENDMENT 002 PREDEPLOY VERIFICATION`

The historical candidate correctly terminated as `PREMISE_INVALIDATED` and
was not deployed. The campaign has since been explicitly reopened under
`amendment-002-durable-outbox-reopen.md`, which implements Amendment 001's
required successor architecture without weakening any locked invariant.

This is not `ACHIEVED`: no amended SHA has yet been deployed and the production
canary, strong/exception controls, twelve-fixture human corpus, six complete
bundles, and repeatability gates remain outstanding. It is not `BLOCKED` while
local verification and authorized deployment preparation can still progress.

## MISSION

Deploy an independent rendered-deck quality controller into the real
production topology in exact-canary shadow mode, preserving native artifact
delivery and all locked prohibitions.

## BASELINE AND ROLLBACK

- Campaign branch: `codex/sophia-observability-v1`.
- Frozen production rollback SHA:
  `f05efb3adce121fb0af009407b7fc53ba6e98312`.
- Historical non-deployed archive commit:
  `72c2fed659d474689c49b149e7d5820f59460064`.
- Immutable rollback tag: `dq1-baseline-f05efb3`.
- Baseline Render gateway deploy: `dep-d9bu80navr4c73bbbk00`.
- Baseline Render LangGraph deploy: `dep-d9bu80ojs32c73ed9pk0`.
- Baseline Vercel deployment: `dpl_Bv2yaEMssrnz6JnGhQtsxP9RgQjR`.

The amended release must deploy gateway first and LangGraph second. Rollback is
the reverse order, restoring this baseline SHA and its exact pre-campaign
environment behavior.

## LOCKED CANDIDATE

- Exact synthetic canary only; the identity is dashboard-managed and is not
  written into public campaign evidence.
- `enabled=true`, `mode=shadow`, `scope=canary`, `sample_rate=0`.
- `mutate_artifact=false`, `affect_delivery=false`.
- Exactly two bounded judge calls through `deck.judge.visual`.
- Separate DQ-only provider credential admitted only after exact canary scope.
- Gateway receives no DQ-specific OpenAI credential; its pre-campaign
  environment remains otherwise unchanged.
- Pre-existing ordinary builder visual/fallback behavior is unchanged.
- No enforcement, automatic repair, Advisor, ordinary-user DQ processing,
  builder migration, companion migration, `soul.md`, or `voice.md` change.

## AMENDED ENGINEERING RESULT

The successor candidate now provides:

- a public-signable, create-only, artifact-version/content-hash-bound primary
  path for eligible exact-canary PPTX builds only;
- unchanged ordinary-user primary path/upsert behavior and zero DQ reads;
- a private canonical source pack followed by a content-free outbox marker no
  larger than 64 KiB, written before detached delivery;
- no second PPTX upload or producer-side PPTX read;
- gateway validation of campaign, canary, instrument, identity, and canonical
  paths before source/artifact reads;
- bounded rehashing of source pack and accepted PPTX, atomic request-ready DB
  convergence, immutable archive, and retry-safe inbox retirement;
- durable flat producer-failure and gateway-rejection evidence that degrades DQ
  readiness until resolved;
- content-free large-object conflict evidence, poison isolation, bounded
  listing, absolute deadlines, and response-loss/readback recovery;
- a forward-only atomic migration with exact legacy/v2, function-body,
  function-attribute, owner, return/argument, ACL, and existing-row guards; and
- startup validation of route, instrument, canary, storage, persistence, and
  DQ-only provider authority.

The shipped `2026_07_16_sophia_deck_quality_publications.sql` migration remains
byte-identical to repository `HEAD`. The successor uses the ordered,
forward-only `2026_07_17` atomic-convergence, `2026_07_18` producer-failure,
and `2026_07_19` dispatch-intent-fence deltas. Every step independently proves
its accepted input catalog and exact committed output catalog.

## VERIFICATION TO DATE

- Publisher, builder boundary, primary storage: `172 passed`.
- Additional builder callers: `30 passed`.
- Worker/reconciler: `28 passed`.
- Expanded producer/storage/router/migration slice: `353 passed`.
- Forward migration/persistence slice: `12 passed`.
- Real PostgreSQL 16 convergence/integration: `13 passed`.
- Production configuration/invariant slice: `56 passed`.
- Targeted Ruff and `git diff --check`: passed.

The full DQ graph/snapshot sweep and complete backend/frontend builds are still
required on the final integrated tree before deployment. Local verification is
necessary but cannot establish delivery-latency or production durability.

## BEST QUALITY RESULT

`dq1-sol-smoke-v9` remains the best paid offline calibration result. It
classified the frozen five-slide PSI fixture `needs_revision`, with mechanical
`passed`, complete 5/5 coverage, weighted score `4`, four of five supplied
failure-code overlaps, exact two-call request parity, `$0.591520` worst-case
admission, and `$0.456280` actual cost.

That is one supplied synthetic negative anchor. It is not a human label,
known-strong control, brand-exception control, corpus agreement result, or
promotion decision.

## PREDEPLOY GATES REMAINING

1. Make the full DQ graph/snapshot and all backend suites green on the final
   tree; run the prescribed builder/gateway sweep, full frontend test/build,
   typecheck, lint, and final adversarial audit.
2. Commit and push one reviewed SHA while preserving unrelated user files.
3. Apply the historical migration followed by the ordered immutable
   `2026_07_17` → `2026_07_18` → `2026_07_19` forward chain to the production
   project, with transactional schema/ACL evidence.
4. Set the exact canary environment on both services and the DQ-only provider
   credential on LangGraph only. Do not alter baseline builder authority.
5. Deploy the same SHA to gateway then LangGraph and verify startup/readiness,
   Render logs, and rollback coordinates.
6. Submit every runtime-significant canary through the real `sophia-ei.com`
   application using computer use, and correlate delivery, Render logs,
   LangSmith traces, durable records, evidence objects, and rendered artifact.
7. Require zero material delivery delay, status/path divergence, duplicate
   delivery, unresolved producer failure/rejection evidence, or noncanary read.

## ACHIEVEMENT GATES STILL MISSING

`ACHIEVED` still requires three PSI-style production canaries, a known-strong
canary, an explicit-brand exception canary, twelve independently human-labeled
fixtures, six complete evidence bundles, at least 10/12 verdict agreement,
17/18 repeatable anchor verdicts, zero critical false accepts, complete
eligible-canary dispatch/evidence coverage, and every locked reliability,
privacy, cost, and delivery gate.

No model output, agent judgment, or supplied expectation may be promoted into
an independent human label. If an external credential, required corpus, or
human decision remains unavailable after all safe authorized work is exhausted,
the campaign must record an explicit evidence-backed external-decision terminal
instead of claiming `ACHIEVED`.
