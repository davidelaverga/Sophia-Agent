# FC-01 Campaign State

## Current state

`BLOCKED`

## Reason

Source identity remains frozen. The resumed investigation binds current and
prior Vercel production metadata, historical Render rollback metadata, exact
migration rewrite lineage, tracked runtime-record addition history, and a
pinned redacted secret-history scan. It does not establish current Render
deploy/image identities or rollback selectability, exact live migration bytes
and recovery state, real-versus-synthetic runtime-record provenance, or the
validity of thirteen unresolved documentation candidates. The clean baseline
remains red across backend, frontend, Voice, and browser lanes. PR #144 also
has unresolved source-valid P1 findings and no exact-head CI.

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

## Safe next decision

Grant read-only authenticated access to the Render, Vercel, and governed
database control planes; establish provenance/disposition for tracked runtime
records; validate the thirteen unresolved scanner records with their credential
owners; and disposition current review findings and red tests. Re-run BASE-00
against the same frozen source lock (or invalidate and recompute it if either
source head moves), then ask Davide and Luis to sign the checksum-bound budget.
