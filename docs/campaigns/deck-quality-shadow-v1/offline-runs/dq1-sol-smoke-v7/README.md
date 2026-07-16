# DQ-1 offline Sol smoke v7

This is the exact safe structured-output bundle from the first complete DQ-1
live Sol smoke, completed at `2026-07-16T06:15:25Z` against the synthetic PSI
production-canary fixture.

It was an offline, manually invoked fixture run. It was not dispatched by
production, did not change the delivered artifact, and is not a human label.
The result was `needs_user_review` while the supplied campaign-spec anchor is
`needs_revision`; the bundle is retained as a calibration failure.

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
objects rather than file bytes. The canonical v7 assessment hashes are:

- visual: `4af78f15e977b54c058933ddb151aa928ccf6fd113e5418150724cb0abd7db7b`
- mechanical: `75bc7ead25273ef11adcef38155228ec50175d77af2dd38768d759db298e1620`
- plan: `ec87488b4c92d10ea823ed7d1ebf42a97de873ec1d12ec47622af9e3db3c405d`
