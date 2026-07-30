# DQ-2 Campaign State

Updated: 2026-07-30T09:34:41Z

## CURRENT DEPLOYED SHA

- gateway: `74b4966fe2f7a2e66e3e9b343584c98cbfa2e2ea` (`dep-d9lhe9bm8hqs738o0300`)
- LangGraph: `74b4966fe2f7a2e66e3e9b343584c98cbfa2e2ea` (`dep-d9lhe9ajnfac73ai72tg`)
- both deploys are latest/live; Gateway `/health` returned 200, healthy, and the exact SHA, while LangGraph `/ok` returned 200 and true

## CURRENT BEST RESULT

The latest production baseline attempt failed safely before artifact publication. The frozen prompt was submitted exactly once through a wholly fresh authenticated `sophia-ei.com` session on the exact deployed SHA. The initial five-slide source had ten eligible repair anchors and standalone safe literal-pixel geometry, but placed the three mandatory absolute-box invariants only in one unique unused class rule rather than in every anchor's standalone `#id` rule. Its single shared repair changed `html_body` on slides 1 and 3, but the `#hero` and `#why` rules and their opening anchor tags remained identical and still missed the same three invariants. The full prior arguments and repair instruction were present, proving the repaired failure hit the same strict predicate.

No artifact was published, DQ-1 was not dispatched, and no DQ-2 transaction or repair invocation exists for this attempt.

## CURRENT BOTTLENECK

V51 failed strict IR before mechanics, so it neither reproduced nor disproved the V49/V50 collision family. It exposed an earlier, narrower source-contract gap: the author supplied all required anchor geometry and all three invariant constants, yet distributed them across an unused class and the anchor `#id` rules. That source is invalid under the strict self-contained-anchor contract, and the model's sole repair did not complete it.

## ACTIVE HYPOTHESIS

A fresh-only deterministic normalization can safely complete the V51 contract when and only when there is exactly one unused invariant carrier, every declared anchor and standalone geometry rule is independently valid, and no competing selector can affect protected anchor properties. Copying only the three constants into existing `#id` rules before the unchanged strict validator should avoid consuming the model repair on this mechanical source rewrite.

## CHANGE MADE

- Pushed and deployed exact commit `74b4966fe2f7a2e66e3e9b343584c98cbfa2e2ea` to Gateway and LangGraph.
- Verified both latest/live deploy identities and public health endpoints before V51.
- Created a wholly fresh authenticated production session, submitted the frozen prompt exactly once, and did not click the app-level retry.
- Correlated V51 through browser telemetry, sanitized Render logs, and a read-only LangSmith EU traversal of the exact builder root.
- Archived the failed-safe boundary under `evidence/dq2-psi-agent-architecture-20260730t092401z/`.
- Implemented a local, undeployed fresh-only unique-unused carrier completion with strict ambiguity guards; no-op cases retain the existing generic one-repair path.
- Preserved D2.1.1's one shared input-repair retry.

## LOCAL VERIFICATION

- The exact deployed SHA remained latest/live on both Render services; Gateway health identified the exact commit and LangGraph reported ready.
- LangSmith EU readback verified the exact 120-span builder root, two ordered `prepare_deck_build` calls, one shared repair, zero open/error spans, and the terminal failed deck status.
- The initial and repaired calls both returned `invalid_deck_ir`. The stylesheet and slide objects 1 and 3 changed; slide 1 `html_body` changed from 1,172 to 1,001 bytes and slide 3 changed from 1,646 to 1,441 bytes.
- Exact argument comparison proved the `#hero` and `#why` rules and their opening anchor tags remained identical and lacked the same three invariants in both calls. Full prior arguments and the repair instruction were present, not truncated.
- Monitoring performed no provider call, trace write, application mutation, or DQ-2 invocation.
- Focused deck-build service and IR-repair tests pass for the local next patch. It remains undeployed.

## PRODUCTION RESULT

Experiment `dq2-psi-agent-architecture-20260730t092401z` reached `FAILED_SAFELY` with terminal code `deck_prepare_retry_exhausted`. Prepare calls/results were exactly two, the shared repair count was exactly one, schema correction and parallel prepare counts were zero, no artifact was published, DQ-1 was not dispatched, and DQ-2 was not invoked.

## KNOWN RULED-OUT CAUSES

- Missing Render, LangSmith, Supabase, or OpenAI credentials.
- Wrong deployed SHA.
- Gateway or LangGraph deployment health failure.
- LangSmith EU endpoint/project/workspace mismatch.
- Parent or builder transport failure.
- Typed-schema correction, parallel execution, or dangling prepare calls.
- Artifact publication or DQ-1 dispatch after the failed baseline.
- DQ-2 invocation.
- A V49/V50 material-overlap terminal signature in V51; this experiment stopped earlier at strict IR.

## NEXT ACTION

Review, commit, and push only the scoped fresh-authoring carrier-completion patch, deploy its exact SHA to Gateway and LangGraph, verify health and LangSmith EU read access, then start one wholly fresh normal-app experiment with the unchanged frozen prompt and new identities.

## ROLLBACK SHA

`34217a8aa3b88e59c1ccbb2f4a187a8804adccb4`
