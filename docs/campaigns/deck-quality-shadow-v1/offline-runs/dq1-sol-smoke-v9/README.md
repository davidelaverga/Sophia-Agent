# DQ-1 offline Sol smoke v9

This is the exact safe structured-output bundle from the first complete DQ-1
run using the dimension-stable `deck-evidence-v4` profile and the canonical
`deck-judge-invoker-v4` count/generation transport. It completed at
`2026-07-16T18:46:09Z` against the synthetic PSI fixture
`clean_underdesigned_psi_v1_evidence_v4`.

It was an offline, manually invoked fixture run. It was not dispatched by
production, did not change the delivered artifact, and is not a human label.
The result was `needs_revision`, mechanical status was `passed`, coverage was
five of five slides, and the delivered artifact remained out of the judge's
control.

Both complete requests were prepared before inference and counted through the
provider's input-token endpoint. Assessment A counted 22,633 input tokens and
Assessment C counted 23,671. Their combined worst case at the locked 6,000
output-token ceiling was `$0.591520`, so the run was admitted under the exact
`$0.60` cap. The two completed calls used 7,492 output tokens in aggregate and
cost `$0.456280`. No adaptive downsampling or partial-response resume occurred.

The archive intentionally excludes prompts, image bytes, source files, raw
plans, base64/data URLs, provider response IDs, safety-identifier values,
credentials, exception text, and raw LangSmith traces. It is safe to retain
only because the fixture is synthetic. Ordinary-user assessment output must
not be committed to this directory.

The evidence source is the committed fixture bundle at
`backend/tests/fixtures/deck_quality_shadow/bundles/clean_underdesigned_psi_v1_evidence_v4`.
Its `manifest.json` byte SHA-256 at archive time was
`1f6dbe2ce17aac4b20140232b45dda854663b4f5a7017b6511677ee9e5e6b9ab`.
The corpus byte SHA-256 was
`f9c94570d5a37a2af9986d182bfb459eefc89baf3b0cbb93f189b1d220002e91`.

`SHA256SUMS` contains byte hashes for the six archived JSON files. Those differ
from controller canonical hashes because the latter hash normalized model
objects rather than file bytes. The canonical v9 assessment hashes are:

- visual: `a062bcf1bf8b29855893b42f5b55273a8d5c3c58b3906444b0bef502d0664d6e`
- mechanical: `75bc7ead25273ef11adcef38155228ec50175d77af2dd38768d759db298e1620`
- plan: `20db924dbe85884b2de5fc2356854eeb9e1b71271bbb7247f968ad5be7edd4bb`

This is a successful negative-anchor verdict, not corpus or promotion
readiness. It has no known-strong, brand-exception, minimal/text-led, or
independently human-labeled control. It emitted four of the five supplied
required failure codes; `low_sequence_rhythm` remains absent.
