# Campaign DQ-1 Terminal Report — 2026-07-17

## Terminal decision

`BLOCKED — AUTHORIZED PRODUCTION PREREQUISITES ABSENT`

This is Campaign DQ-1's explicit section 22 terminal. The canary-shadow
engineering candidate is implemented and locally verified, including its
production image, but it cannot be admitted to production within the current
authority. Required credential, canary, and HMAC configuration is absent. The
candidate therefore was not migrated or deployed, and no candidate production
canary was submitted. This is not `ACHIEVED`.

No API key was created, rotated, revoked, edited, revealed, substituted, or
value-inspected. No provider-dashboard mutation occurred. No production
environment variable, database migration, configuration, or deployment was
changed. The admission check failed closed before candidate deployment.

## Reviewed candidate and rollback

- Branch: `codex/sophia-observability-v1`.
- Release-candidate commit:
  `d306f07892a9666559bf75ead8ca5924baa80df3`.
- Durable-shadow implementation commit:
  `e6e28aafa5101350057047de5235f8f6bd547a58`.
- Frozen production and rollback SHA:
  `f05efb3adce121fb0af009407b7fc53ba6e98312`.
- Gateway baseline deploy: `dep-d9bu80navr4c73bbbk00`.
- LangGraph baseline deploy: `dep-d9bu80ojs32c73ed9pk0`.
- Immutable rollback tag: `dq1-baseline-f05efb3`.
- The current Vercel version was not independently refreshed during terminal
  preflight. Historical ledger coordinates are version
  `7092042b13f3edc40468fd614685d7ede3b21f2a` and deployment
  `dpl_Bv2yaEMssrnz6JnGhQtsxP9RgQjR`; they are not a fresh check.

The candidate supplies an immutable exact-canary primary and source pack, a
pre-delivery identity/reference-only durable outbox, atomic request-ready
convergence, archive-before-delete replay, durable producer/gateway failure
signals, dispatch-ambiguity fencing, LangGraph startup validation, keyed
cross-service canary proof, endpoint/body HMAC acknowledgement, and a
credential-isolated route-only judge boundary. These mechanisms are wired and
locally tested; none has executed in candidate production. Ordinary builds keep
their existing primary behavior and perform no DQ source or provider work.

## Local engineering proof

- Exact-HEAD backend run at `d306f078...`: `4343 passed, 149 skipped, 0 failed`
  in 284.48 seconds; the backend tree remained clean before and after.
- Required builder/gateway sweep: `274 passed`.
- Frontend: 188 test files / 1,581 tests passed; typecheck passed; lint exited
  zero with zero errors and 58 pre-existing warnings; Next 16.2.2 production
  build passed with 60/60 pages generated.
- PostgreSQL 16 migration suite: `48 passed`; static migration suite:
  `12 passed`; focused invariant suite: `159 passed`.
- Isolation slice: `143 passed, 11 skipped`; renderer/report slice:
  `168 passed, 3 skipped`; root-Linux identity/process slice:
  `19 passed, 1 environment skip`; live root-Linux sandbox: `17 passed`.
- Independent adversarial review found no open P0/P1/P2 issue.

The exact committed production image built successfully from
`backend/Dockerfile.langgraph`:

- digest:
  `sha256:ac60ef7dcc8d16431d33d5903ea5deb693c09fc1806b315b03f490b1d1d6daab`;
- size: `2,903,005,731` bytes; platform: `linux/arm64`;
- created: `2026-07-17T08:27:57.575313929Z`;
- required runtime tools present: `setpriv`, `pdftoppm`, `pdfinfo`, `soffice`,
  `chromium`, `node`, `pandoc`, `xelatex`, and `dot`;
- in-image production-root isolation/runtime proof: `39/39 passed` in 9.99
  seconds, including credential-free broker preflight;
- real fixture conversion: PPTX to five-page PDF to PNG passed; resulting PDF
  was 69,763 bytes and PNG was 138,399 bytes.

The production image's package operations are split into bounded transactions,
with network timeouts for dependency and Playwright downloads. This resolved
the local builder's earlier memory and timeout failures without changing the
application's API-key configuration.

The ordered forward migration chain and SHA-256 fingerprints are:

| Migration | SHA-256 |
| --- | --- |
| `2026_07_15` | `328f10ae75f2f1b0f39523621621abe3802ddf98d660a1c70b69c3b5b64c0dfb` |
| `2026_07_16` | `52fc6d563bd85bb35ae2c92ffcd9b0a261e896ceeef3dcc8b751cf46557c1635` |
| `2026_07_17` | `d2439af5768f5fb14f174a0e77ea4cc39ba3ed44c6c932f9de08d109debb5162` |
| `2026_07_18` | `4594e48cbbc12454b1b1d50ce66d0c73aa2b5b1093f3c9e18020802c3e13c556` |
| `2026_07_19` | `955a975c578d755cb655afdfd2437d8bf0eb4246fc48e34fc8bc905a5286f4b5` |

The July 17 through July 19 successors have accepted-input guards and
independent committed-output catalog/routine fingerprints. July 18 also has
first-apply default and function-comment drift rollback tests. The shipped July
15 and July 16 migrations remain byte-identical to the reviewed tree.

## Read-only production proof

The real production topology was inspected without mutation through computer
use and read-only service checks:

- gateway `/health` returned a healthy response at exact frozen SHA
  `f05efb3adce121fb0af009407b7fc53ba6e98312`;
- LangGraph `/ok` returned `{"ok":true}`;
- `sophia-ei.com` loaded successfully and displayed authenticated historical
  sessions, including the baseline PSI control session.

This proves only the observed endpoints and real-app accessibility at the
frozen baseline. It is not candidate-runtime evidence.

The production admission check inspected variable names only:

- both Render services lack `SOPHIA_DECK_QUALITY_CANARY_USER_IDS`;
- both Render services lack `SOPHIA_BUILDER_EVENTS_HMAC_SECRET`;
- LangGraph lacks `SOPHIA_DECK_QUALITY_OPENAI_API_KEY`.

Existing variable names cannot establish credential validity or the required
cryptographic distinction between DQ-only and baseline builder authority. No
value was opened or compared.

Because the candidate was not deployed, no candidate Render log, LangSmith
quality trace, stored production quality row, durable publication/outbox
record, evidence object, delivery-latency measurement, or candidate rendered
artifact exists. Historical trace
`019f675a-dcc1-7053-80dc-c6f572fb4d87` has 155 runs and zero errors in the
ledger, but it is a baseline builder trace, not a candidate quality trace. The
current LangSmith trace UI stopped at sign-in; access is sufficient only after
authentication and once candidate traces exist.

## Offline quality and attached artifact proof

The frozen PSI artifact is a valid five-slide, native/editable PPTX. It has no
embedded slide media under `ppt/media`; the OOXML package does contain its
standard `docProps/thumbnail.jpeg`. Total `python-pptx` shape counts, including
connectors, are 5, 19, 15, 20, and 12. Non-connector `<p:sp>` counts are 5, 19,
14, 20, and 8.

- PPTX SHA-256:
  `1e9b3a8f1b6605c60388bcb0ade3cb35574428de5929553dbb4c76a7a76b2bd4`.
- Regenerated contact-sheet SHA-256:
  `7d90a237e56d9c0a9a4c06a8f929b73825710964580201169768f5de15cd225e`.
- All six stored checksums in offline run `dq1-sol-smoke-v9` pass.

Smoke v9 classified this supplied synthetic negative fixture `needs_revision`,
with mechanical `passed`, complete 5/5 slide and two-call coverage, weighted
score `4`, actual cost `$0.456280`, and admitted maximum `$0.591520`. It is
offline evidence, not candidate production output and not an independent human
label.

## Locked invariants preserved

- canary-only shadow; no ordinary-user DQ or OpenAI processing;
- no enforcement, automatic repair, Advisor, artifact mutation, or delivery
  authority;
- no builder or companion model/provider/fallback migration;
- no DQ credential on gateway and no DQ credential read before exact
  campaign/mode/scope/user/route admission;
- candidate configuration/tests require exactly two bounded, independent,
  non-stored judge calls per admitted run; no candidate production call
  occurred;
- no `soul.md` or `voice.md` change.

Production stayed at the rollback baseline; no invariant was weakened to force
a deployment.

## Residual risk and missing achievement proof

One nonblocking P3 residual remains: a credential-free ordinary same-thread
subprocess can escape a session kill with `setsid` and retain that thread's
filesystem authority. It receives no service, provider, storage, or HMAC
credential, has no cross-thread authority, and cannot read a fresh provider
UID's `/proc` environment. Full containment would require cgroups or a PID
namespace and is not claimed.

After production admission, `ACHIEVED` would still require:

- three consecutive PSI-style production canaries, plus one known-strong
  control and one explicit-brand/default-look exception canary;
- the known-strong false-reject gate and required top-failure overlap gate;
- 12 independent human labels: four strong, four mechanically clean but
  under-designed, two mechanically invalid, one explicit-brand/default-look
  exception, and one minimal/text-led deck;
- six complete evidence bundles, at least 10/12 verdict agreement, 17/18
  repeatable anchor verdicts, and zero critical false accepts;
- complete eligible-canary dispatch, evidence, delivery, privacy, latency, and
  cost proof.

Current counts are zero independent human labels and one complete offline
bundle. These are separate promotion gates; their absence is not the cause of
the current `BLOCKED` admission terminal.

## Smallest authorized unblock

An authorized operator, without sharing secret values with Codex, must:

1. attach an already-authorized DQ-specific credential to LangGraph only and
   establish operationally that it is distinct from baseline
   `OPENAI_API_KEY`;
2. configure the identical exact synthetic-canary set on both Render services;
3. configure the matching builder-event HMAC on both services.

If an already-authorized distinct DQ credential does not exist, DQ-1 remains
blocked under the instruction not to change API keys. No partial production
configuration is safe.

After that unblock, the controlled campaign sequence is to apply migrations
`2026_07_15` through `2026_07_19` with transactional catalog/ACL proof, deploy
release candidate `d306f07892a9666559bf75ead8ca5924baa80df3` gateway first and
LangGraph second, then run every runtime-significant canary through
`sophia-ei.com` and correlate app behavior, Render logs, LangSmith traces,
stored rows, source packs, outbox/archive records, and rendered artifacts.

## Conclusion

Predeployment engineering and the exact production-image build are complete.
The observed production baseline remains frozen and accessible, and no API key
or production configuration was changed. The explicit campaign terminal is
`BLOCKED`, not `ACHIEVED`, because the prerequisite production admission state
cannot be created within authorized scope.
