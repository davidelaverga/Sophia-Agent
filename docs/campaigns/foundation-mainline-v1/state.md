# FC-01 Campaign State

## Current state

`BLOCKED`

## Reason

Source identity is frozen and deterministic test evidence is being completed,
but BASE-00 contains hard unknowns that the specification forbids us to infer:
provider deploy/rollback selectability, live migration/catalog and backup/PITR
truth, exact live LangGraph/Voice source identity, provenance of tracked
runtime/user artifacts, and a complete pinned secret/history scan. The clean
baseline is red across backend, frontend, Voice, and browser lanes. PR #144 also
has unresolved source-valid P1 findings and no exact-head CI.

The acceptance budget is a draft with no human signatures. No FC-01B or live
M00 action is authorized.

## Safe next decision

Grant read-only authenticated access to the Render, Vercel, and governed
database control planes; establish provenance/disposition for tracked runtime
records; run an approved complete secret/history scan; and disposition current
review findings. Re-run BASE-00 against the same frozen source lock (or
invalidate and recompute it if either source head moves), then ask Davide and
Luis to sign the checksum-bound budget.
