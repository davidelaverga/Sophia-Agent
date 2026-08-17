# FC-01 Campaign State

## Current state

`BLOCKED`

## Reason

Source identity remains frozen. Authenticated provider inspection now binds the
exact current Gateway, LangGraph, Voice, and Vercel deployments; Gateway and
LangGraph rollback coordinates; current branch/auto-deploy settings; and the
Gateway routing targets. It also proves that production Voice is 358 campaign
commits behind, LangGraph still has a strong non-durable checkpointer inference,
and database recovery/security posture is not release-ready.

Metadata-only database inspection proves PostgreSQL 17.6 and six required
catalog surfaces, but the provider migration ledger is empty and exact applied
migration bytes, checksums, ACLs, and ordering remain unknown. PITR is disabled,
no restore drill exists, at least four critical public-RLS findings are visible,
and network restrictions allow all IP addresses. PR #144 retains two valid P1
and eight valid P2 findings. Ninety-one release-critical or governed test
outcomes remain unexecuted, ten secret-history records await owner validation,
and tracked runtime-record provenance remains unknown.

The acceptance budget is a draft with no human signatures. No FC-01B or live
M00 action is authorized.

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

## Safe next decision

Provide the missing selective-refoundation strategy input, establish
provenance/disposition for tracked runtime records, validate or rotate the
three unresolved scanner strings with their owners, and decide an authorized
remediation lane for the Voice divergence plus the two P1 and eight P2 source
findings. Run the 91 release-critical/governed tests in their required isolated
environments. Re-run BASE-00 against the same frozen source lock (or invalidate
and recompute it if either source head moves), then ask Davide and Luis to sign
the checksum-bound budget. Do not begin FC-01B or M00 before those approvals.
