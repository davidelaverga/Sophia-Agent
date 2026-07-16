# DQ-1 offline Sol smoke v8

This is the exact safe structured-output bundle from the first DQ-1 live Sol
smoke whose deterministic result agrees with the supplied PSI campaign anchor.
It completed at `2026-07-16T06:38:58Z` against the synthetic PSI
production-canary fixture.

It was an offline, manually invoked fixture run. It was not dispatched by
production, did not change the delivered artifact, and is not a human label.
The result was `needs_revision`, mechanical status was `passed`, coverage was
five of five slides, and the delivered artifact remained out of the judge's
control.

The archive intentionally excludes prompts, image bytes, source files, raw
plans, base64/data URLs, provider response IDs, safety-identifier values,
credentials, exception text, and the raw baseline LangSmith trace. It is safe to
retain only because the fixture is synthetic. Ordinary-user assessment output
must not be committed to this directory.

The evidence source remains the committed fixture bundle at
`backend/tests/fixtures/deck_quality_shadow/bundles/clean_underdesigned_psi_v1`.
Its `manifest.json` byte SHA-256 at archive time was
`dc4db5c2411175b81d3e2d8cf8a6d9a967206d66d474486f951a6b91adf21751`.

`SHA256SUMS` contains byte hashes for the six archived JSON files. Those differ
from controller canonical hashes because the latter hash normalized model
objects rather than file bytes. The canonical v8 assessment hashes are:

- visual: `7042bb6e64d44471e54bc5540449b6ae93bba3ea9d41fcb915e4fe759752b859`
- mechanical: `75bc7ead25273ef11adcef38155228ec50175d77af2dd38768d759db298e1620`
- plan: `a407a2272564e0d6dd221ce629b944b9d7038e10427f810da3af7bdef6c304d7`

This is a successful negative-anchor verdict, not corpus or promotion
readiness. It has no known-strong, brand-exception, minimal/text-led, or
independently human-labeled control. It emitted four of the five supplied
required failure codes; `low_sequence_rhythm` remains absent.
