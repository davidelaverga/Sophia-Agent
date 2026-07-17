# Campaign DQ-1 State

Last updated: 2026-07-17 01:47 PDT

## CURRENT STATE

`BLOCKED — AUTHORIZED PRODUCTION PREREQUISITES ABSENT`

Campaign DQ-1 has reached its explicit section 22 terminal. The durable
canary-shadow candidate and exact production image are locally verified, but
the candidate cannot be admitted to production within current authority. No
candidate deployment or post-change production canary occurred, so this is not
`ACHIEVED`.

No API key was created, rotated, revoked, edited, revealed, substituted, or
value-inspected. No production environment, migration, configuration, or
deployment was changed.

## MISSION

Deploy an independent rendered-deck quality controller into the real
production topology in exact-canary shadow mode while preserving native
artifact delivery and every locked prohibition. The mission is not achieved;
the campaign stopped at its required evidence-supported terminal.

## CURRENT BASE SHA

- Release-candidate commit:
  `d306f07892a9666559bf75ead8ca5924baa80df3`.
- Durable-shadow implementation commit:
  `e6e28aafa5101350057047de5235f8f6bd547a58`.
- Branch: `codex/sophia-observability-v1`.
- Frozen production and rollback SHA:
  `f05efb3adce121fb0af009407b7fc53ba6e98312`.

## CURRENT DEPLOYED SHAS

- Render gateway: `f05efb3adce121fb0af009407b7fc53ba6e98312`, deploy
  `dep-d9bu80navr4c73bbbk00`.
- Render LangGraph: `f05efb3adce121fb0af009407b7fc53ba6e98312`, deploy
  `dep-d9bu80ojs32c73ed9pk0`.
- Production remains frozen at the pre-campaign rollback SHA.
- Current Vercel version was not independently refreshed. Historical ledger
  coordinates are version `7092042b13f3edc40468fd614685d7ede3b21f2a`
  and deployment `dpl_Bv2yaEMssrnz6JnGhQtsxP9RgQjR`.

Read-only verification observed the exact frozen SHA from gateway `/health`,
`{"ok":true}` from LangGraph `/ok`, and authenticated `sophia-ei.com` app
access. This is baseline endpoint/app evidence only.

## CURRENT BEST RESULT

The best quality result remains offline smoke `dq1-sol-smoke-v9` against the
frozen five-slide PSI fixture:

- `needs_revision`; mechanical `passed`; 5/5 slide coverage;
- weighted score `4`; exactly two judge calls;
- actual cost `$0.456280`; admitted maximum `$0.591520`;
- four of five supplied high-level failure-code overlaps.

This is one supplied synthetic negative anchor, not an independent human label,
known-strong control, exception control, or production candidate result.

## CURRENT BOTTLENECK

Read-only production preflight inspected names only and found:

- both Render services lack `SOPHIA_DECK_QUALITY_CANARY_USER_IDS`;
- both Render services lack `SOPHIA_BUILDER_EVENTS_HMAC_SECRET`;
- LangGraph lacks `SOPHIA_DECK_QUALITY_OPENAI_API_KEY`.

Existing names do not prove credential validity or DQ/baseline cryptographic
distinction. Candidate startup is tested to fail closed without the complete,
matching exact-canary prerequisites. A partial migration or deployment is
inadmissible.

## ACTIVE HYPOTHESIS

If an authorized operator supplies the complete prerequisite set without
exposing values, the release candidate can enter the migration/deployment and
real-app canary sequence. This remains untested in production.

## LAST EXPERIMENT

`dq1-terminal-preflight-v1`: exact-HEAD local verification, production-image
runtime proof, and read-only production admission preflight. No provider
request, migration, configuration change, deployment, or production canary was
attempted.

## LAST RESULT

- Exact-HEAD backend: `4343 passed, 149 skipped, 0 failed` in 284.48 seconds.
- Builder/gateway sweep: `274 passed`.
- Frontend: 188 files / 1,581 tests passed; typecheck and production build
  passed; lint had zero errors and 58 pre-existing warnings.
- PostgreSQL 16 migration: `48 passed`; static migration: `12 passed`;
  focused invariant: `159 passed`.
- Exact production image built at digest
  `sha256:ac60ef7dcc8d16431d33d5903ea5deb693c09fc1806b315b03f490b1d1d6daab`;
  39/39 in-image root-runtime tests and real five-page PPTX-to-PDF-to-PNG smoke
  passed.
- Independent review found no open P0/P1/P2 issue.
- Admission: `BLOCKED`; provider calls/cost: zero; production effect: none.

Ordered migration hashes:

- `2026_07_15`: `328f10ae75f2f1b0f39523621621abe3802ddf98d660a1c70b69c3b5b64c0dfb`
- `2026_07_16`: `52fc6d563bd85bb35ae2c92ffcd9b0a261e896ceeef3dcc8b751cf46557c1635`
- `2026_07_17`: `d2439af5768f5fb14f174a0e77ea4cc39ba3ed44c6c932f9de08d109debb5162`
- `2026_07_18`: `4594e48cbbc12454b1b1d50ce66d0c73aa2b5b1093f3c9e18020802c3e13c556`
- `2026_07_19`: `955a975c578d755cb655afdfd2437d8bf0eb4246fc48e34fc8bc905a5286f4b5`

## KNOWN RULED-OUT CAUSES

Tests found no syntax, full-suite, focused gateway/builder, frontend build,
PostgreSQL migration-contract, durable-outbox replay, exact-canary admission,
ordinary-user isolation, provider pre-admission, route-only model-fence, or
production-image runtime regression on the release candidate. They do not rule
out production topology, provider, storage, database, delivery-latency, or
observability failures because the candidate was not deployed.

Historical LangSmith trace `019f675a-dcc1-7053-80dc-c6f572fb4d87` is
baseline-only. Current trace UI access stopped at sign-in; no candidate trace
was inspected or claimed.

## LOCKED INVARIANTS

- exact synthetic-canary scope; `enabled=true`, `mode=shadow`,
  `scope=canary`, `sample_rate=0`;
- `mutate_artifact=false`, `affect_delivery=false`;
- no enforcement, automatic repair, Advisor, ordinary-user DQ/OpenAI
  processing, builder model migration, companion model migration, `soul.md`,
  or `voice.md` change;
- DQ provider authority admitted only after exact campaign, mode, scope, user,
  and route checks;
- gateway has no DQ-specific OpenAI credential;
- immutable canary primary/source pack and durable identity/reference-only
  outbox precede detached delivery;
- candidate configuration/tests require exactly two bounded, non-stored judge
  calls per admitted run; no candidate production call occurred.

All remained intact. No enforcement or repair path was enabled.

## NEXT ACTION

The smallest authorized unblock is for an authorized operator, without sharing
secret values with Codex, to attach an already-authorized distinct DQ credential
to LangGraph only, configure the identical exact-canary set on both services,
and configure the matching builder-event HMAC on both services.

If that prerequisite is satisfied, the subsequent controlled sequence is to
apply migrations `2026_07_15` through `2026_07_19` with transactional
catalog/ACL proof, deploy `d306f07892a9666559bf75ead8ca5924baa80df3`
gateway first and LangGraph second, and exercise all runtime-significant
canaries through `sophia-ei.com` while correlating app, logs, traces, rows,
source packs, outbox/archive records, and rendered artifacts. No subset should
be applied now.

## ROLLBACK POINT

- SHA: `f05efb3adce121fb0af009407b7fc53ba6e98312`.
- Immutable tag: `dq1-baseline-f05efb3`.
- Gateway deploy: `dep-d9bu80navr4c73bbbk00`.
- LangGraph deploy: `dep-d9bu80ojs32c73ed9pk0`.
- No rollback was required because production was unchanged.

## HUMAN DECISIONS NEEDED

After admission, achievement still requires three consecutive PSI-style
production canaries plus one known-strong and one explicit-brand/default-look
exception canary; the known-strong false-reject and top-failure overlap gates;
12 independent human labels across the required distribution; six complete
bundles; 10/12 verdict agreement; 17/18 repeatability; zero critical false
accepts; and complete dispatch/evidence/delivery/privacy/latency/cost proof.

Current counts are zero independent human labels and one complete offline
bundle. These are separate promotion gates, not the cause of the current
`BLOCKED` production-admission terminal. Campaign expectations, model output,
or agent inspection cannot be promoted into human labels.
