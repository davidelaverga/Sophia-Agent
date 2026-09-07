# MEM00_FIVE_ITERATIONS_REACHED — CONTINUE

Recorded2026-09-07. Covers EI118–122 without erasing prior failures. Complete clean production canaries: **0**.

| Attempt | Exact candidate | Failure cluster / falsifiable hypothesis | Evidence and outcome |
| --- | --- | --- | --- |
| EI118 | b12e3a2190a9e9e7a0aaac0a52b3cee95d31a788 | Implementation: strict Pool model rejects a database-only join key. | Actual Journal503 and deployed reproduction; mapping repaired, ordinary lifecycle passes on c0729da7636f4f1c4f306affe3af329f62d10795. |
| EI119 | c0729da7636f4f1c4f306affe3af329f62d10795 | Observability: exporter ignores the pinned production environment. | Four RED regressions; actual joined f809d43daa26a20aa7e32e4b510f3f558918b17e trace reports production and empty inputs. |
| EI120 | c0729da7636f4f1c4f306affe3af329f62d10795 | Observability: fresh-shell counters cannot represent the serving process. | Missing-surface RED tests; ordinary f809d43 app export and GET200 join prove live process identity and partial gauges, not full release coverage. |
| EI121 | f809d43daa26a20aa7e32e4b510f3f558918b17e | Instrument: Gateway-key-pinned probe dispatched to LangGraph. | Preflight refuses before adapter construction/provider mutation. Correct Gateway dispatch passes three fixtures and zero cleanup. Guard regression added. |
| EI122 | f809d43daa26a20aa7e32e4b510f3f558918b17e | Architecture: lookup approval cannot authorize retained voice memory across later inputs without revocation fencing. | Four RED voice-caller containment tests and two RED unavailable-versus-empty tests; all six now GREEN, adjacent53tests pass. Local containment is not deployed. |

## Hypotheses and safety

The Pool failure was not a provider outage: exact model decoding reproduced it. Environment mismatch was not deployment drift: independent pins and exporter metadata disagreed. EI121 is not a provider contract failure and requires no credential/configuration change. EI122 remains a transport/admission architecture issue: the voice renderer retains supplied snippets without a source manifest/next-input epoch barrier; a lookup receipt alone does not authorize later retention. No deployed post-tombstone admission is asserted from these local tests.

All four deployed components remain f809d43/tree1557667c7acea9feab5cd34680891c872a37ae6b. SDK1.0.9, endpoints, project/configuration, flags and enforced mem00.v1/epoch1 are unchanged. P01D has no live candidate/canonical plaintext or provider rows. Fresh project structural inventory covers783 distinct records plus an explicit empty page and finds zero certification markers. Voice/cache derivatives remain incompletely measured. Older two pending candidates and three unrelated history entries are untouched. No audio run, provider setting, billing change, schema mutation, real-user import or merge occurred.

## Verification update

Ten new regressions pass including four additional carried-state cases. Final full backend6034passed/161skipped/12warnings394.15s; frontend1972passed/2skipped155.98s plus TypeScript; voice616passed/12warnings9.92s; Ruff/diff pass. EI123 separately records a nine-error collection failure from using backend dependencies for voice; the existing voice Python3.12 environment passes its explicit dependency preflight and full suite. No package installation or production operation occurred. Repair remains unpublished at this verification capture.

## Next falsifying experiment

Verify cohort-scoped zero-memory voice containment before provider/reader/cache calls across setup, dynamic, direct fallback and retrieval tool; preserve non-cohort and text/Builder behavior. Keep unavailable distinct from authoritative empty. Run the full suite, publish the isolated repair, obtain fresh idle/worker/closed-gate evidence before redeploying, remeasure hosted behavior and directly test the deployed voice memory boundary without starting audio. Then continue the complete consumer/fault matrix and terminal cleanup. No promotion certificate is implied.
