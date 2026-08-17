# FC-01 Campaign State

## Current state

`BLOCKED`

## Reason

The previously unavailable selective-refoundation strategy is now present and
its SHA-256 exactly matches the frozen authority lock. Source identity and the
public application receipts remain unchanged. The current operator asked to
continue on the premise of joint signoff, but the statement is not bound to the
acceptance-budget checksum and contains no direct Luis decision. It is recorded
as an operator claim, not converted into signatures.

Authenticated provider inspection binds the exact current Gateway, LangGraph,
Voice, and Vercel deployments; Gateway and LangGraph rollback coordinates;
current branch/auto-deploy settings; and the Gateway routing targets. It also
proves that production Voice is 358 campaign commits behind, LangGraph still
has a strong non-durable checkpointer inference, and database recovery/security
posture is not release-ready.

Metadata-only database inspection proves PostgreSQL 17.6 and six required
catalog surfaces, but the provider migration ledger is empty and exact applied
migration bytes, checksums, ACLs, and ordering remain unknown. PITR is disabled,
no restore drill exists, at least four critical public-RLS findings are visible,
and network restrictions allow all IP addresses. PR #144 retains two valid P1
and eight valid P2 findings. Ninety-one release-critical or governed test
outcomes remain unexecuted, ten secret-history records await owner validation,
and tracked runtime-record provenance remains unknown.

The acceptance budget remains a draft with no checksum-bound human signatures.
No FC-01B or live M00 action is authorized.

## Evidence receipt

- Evidence payload commit: `25ad22ca3b7e42e8510d6169591b8aa6929a1142`
- Evidence checksum-manifest digest:
  `b9abb220ceebdc7ab7531f9aaadc71ea4e3710004981129cb1cf12cd654d689b`
- Offline evaluator: structure, checksum, privacy, and terminal consistency
  `PASS`; campaign state remains `BLOCKED` with 55 explicit hard-unknown values.
- Resume evidence payload commit:
  `95c74327b3c3afc040c9d17239b574a27caa03be`
- Resume checksum-manifest digest:
  `6c0f90bc84c55115d9ee35873bb06e37389de928b00a9ff2e8e03a4c722da141`
- Resume offline evaluator: structure, checksum, privacy, source-lock, and
  terminal consistency `PASS`; the delta remains `BLOCKED` with 38 explicit
  hard-unknown values.
- Authenticated-access evidence payload commit:
  `bb2b25eff74deae165b81dd9489b5438a5c50043`
- Authenticated-access checksum-manifest digest:
  `6b4e62e79c05fb3e9244ca702c1f96fbeeb081ee8f62c5982472ada8d053ace7`
- Authenticated-access offline evaluator: structure, checksum, privacy,
  source-lock, provider-identity, database-no-mutation, and terminal
  consistency `PASS`; the delta remains `BLOCKED` with 16 explicit hard-unknown
  values.
- Authority-intake evidence payload commit:
  `a13503660f92501c03ae936217100264e574303a`
- Authority-intake checksum-manifest digest:
  `ce70293b0e6e722c8150c72530ef14075dc6855b728fbe4fd4bae7fba169d0f3`
- Authority-intake offline evaluator: structure, checksum, privacy, authority,
  non-impersonation, source-lock, and terminal consistency `PASS`; the strategy
  input is resolved while the delta remains `BLOCKED` with 16 hard-unknown
  paths and no valid joint signature.

## Safe next decision

Obtain a jointly approved, checksum-bound FC-01A remediation amendment; current
FC-01 has no waiver path and FC-01A itself prohibits product repair. The bounded
lane must resolve or prove the Voice alignment/rollback coordinate, two P1 and
eight mission-scope P2 findings, 91 required test outcomes, migration identity,
tracked-record provenance, and the remaining secret candidates. Recompute
BASE-00 afterward, then obtain direct Davide and Luis decisions on the resulting
budget receipt. Do not begin FC-01B or M00 before those gates pass.
