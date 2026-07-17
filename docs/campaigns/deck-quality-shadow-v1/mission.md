# Campaign DQ-1 Mission

## Mission

Establish a production-canary shadow controller that independently recognizes
the difference between a mechanically clean deck and a presentation worth
showing. The controller observes final rendered native PPTX artifacts, persists
auditable evidence, and has no authority over artifact delivery.

## Target state

A successful canary build dispatches one durable asynchronous quality run. The
run evaluates every expected slide, keeps blind rendered judgment separate from
mechanical truth and plan realization, and derives its shadow result through a
deterministic controller. Task, build, artifact, builder trace, quality trace,
stored record, and render evidence remain correlatable.

The first negative anchor is `clean_underdesigned_psi_v1`. Its campaign-spec
expectation is `needs_revision` with mechanical status `passed`, while the
user-visible artifact remains an unchanged successful native/editable PPTX.

## Operating boundary

- Production execution is limited to the dedicated synthetic canary account.
- Shadow results cannot delay, block, relabel, replace, repair, or mutate the
  delivered artifact.
- Ordinary-user decks must not be sent to OpenAI under this campaign.
- Existing deterministic mechanical gates remain authoritative for mechanics.
- Assessment A is blind to mechanical findings and planning rationale.
- Assessment C is a separate fresh request and cannot see Assessment A scores,
  fixture labels, campaign verdicts, or mechanical failure codes.
- Provider clients are resolved through model routes; no quality module owns a
  direct provider client.
- Enforcement, automatic repair, Advisor, builder-model migration, companion-
  model migration, and edits to `soul.md` or `voice.md` are out of scope.

## Completion gates

Campaign completion requires the full engineering and production-canary gates
from the campaign spec, including 12 independently human-labeled fixtures, six
complete evidence bundles, zero critical false accepts, at least 10/12 verdict
agreement, at least 17/18 repeatable anchor verdicts, complete eligible-canary
dispatch and evidence coverage, no duplicates, no delivery regressions, and no
ordinary-user scope leaks. Passing local tests or one plausible canary is not a
terminal state.

## Authority

The authoritative execution contract is
`specs/sophia_campaign_DQ1_production_shadow_rendered_deck_quality.md`. Parent
P-2, D3, and D3.2 contracts retain their stated ownership. The older
`specs/sophia_spec_D3_deck_evaluation_rubric_loop.md` is historical where it
conflicts with D3.2 or DQ-1.

Amendment 001 remains the authoritative diagnosis of the invalid original
producer premise. Amendment 002 authorizes the durable-outbox successor and
reopens the campaign without weakening any completion gate or prohibition.
