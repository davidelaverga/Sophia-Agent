# DQ-2 Campaign State

Updated: 2026-07-17T11:25:00Z

## CURRENT DEPLOYED SHA

- gateway: `f05efb3adce121fb0af009407b7fc53ba6e98312`
- LangGraph: `f05efb3adce121fb0af009407b7fc53ba6e98312`
- frontend: `7092042b13f3edc40468fd614685d7ede3b21f2a`

## CURRENT BEST RESULT

The historical normal-builder PSI run produced a mechanically accepted five-slide editable PPTX and correlates across Render and LangSmith, but no DQ-1 or DQ-2 production judgment ran. DQ-2 has no candidate result yet.

## CURRENT BOTTLENECK

Production admission variables are being provisioned. DQ-2 orchestration, addressable manifest promotion, durable mutation, repair execution, second judgment, and comparator do not yet exist on the branch.

## ACTIVE HYPOTHESIS

Once exact-canary/HMAC/DQ model admission is valid, the existing DQ-1 observer can be deployed and proven as the live judgment boundary. The current compact native source substrate can then support DQ-2 with backward-compatible address roles, immutable candidates, and a transactionally bounded one-repair controller.

## CHANGE MADE

- Validated Render production access and LangSmith EU project access.
- Correlated the historical PSI builder run across both systems.
- Froze the exact production prompt, canary fingerprint, evidence convention, and campaign acceptance oracle.
- Began authorized Render admission provisioning.

## LOCAL VERIFICATION

Existing DQ-1/foundation focused suite: `96 passed` using `PYTHONPATH=. uv run pytest` in `backend/`. No DQ-2 tests existed at campaign start.

## PRODUCTION RESULT

Not run. The live gateway and LangGraph remain on `f05efb3...`; no fresh DQ-2 task has been submitted.

## KNOWN RULED-OUT CAUSES

- Render authentication failure.
- LangSmith authentication or EU workspace/project mismatch.
- Baseline app/session access failure.
- Baseline native PPTX builder failure for the historical PSI canary.

## NEXT ACTION

Verify the provisioned variables without exposing values, land the explicit shared-credential authorization policy, run local admission tests, and deploy/prove the DQ-1 observer before implementing and exercising DQ-2.

## ROLLBACK SHA

`f05efb3adce121fb0af009407b7fc53ba6e98312` (`dq1-baseline-f05efb3`)
