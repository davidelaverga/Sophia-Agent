# FC-01 v1.2 Amendment A Evidence Package

This append-only package defines `FC-01A-R`, a bounded pre-G0 remediation lane.
It is a governance and evidence artifact only. It changes no product file,
provider setting, database state, secret, deployment, or current budget.

The amendment resolves the FC-01A/G0 deadlock without a P0-P2 waiver by binding
every known blocker to one of two temporal gates with exact reachability:

- `M00_PREREQUISITE` must pass before a recomputed BASE-00 may be approved.
- `POST_M00_RELEASE_GATE` remains failed and blocks its original later release
  boundary.

The source repair allowlist is exactly two P1 threads, eight P2 threads, and the
enumerated M00-critical test repairs. Voice is explicitly excluded from the
text-only M00 execution set and remains a later hard release gate. Secret,
tracked-record, and M00 database ACL/RLS evidence must be handled through the
confidential, redacted disposition contract.

Gateway and LangGraph are unconditional future candidate targets. Vercel is a
conditional third target because mandatory frontend test edits can enter its
production-input closure; it requires a hermetic build plus separate Davide
and Luis target decisions and is promoted last. Voice never participates.

The immutable payload is `AMENDMENT_DRAFT_PENDING_SEAL`. After its additive Git
seal receipt verifies, the campaign may become
`AMENDMENT_READY_FOR_JOINT_APPROVAL`; the two human decisions are not present
here. The current unsigned BASE-00 budget remains unsigned.

Run the offline evaluator from the campaign directory:

```text
python3 evaluate_fc01_v1_2_amendment_a.py \
  evidence/fc01-v1.2-amendment-a-20260817t151323z
```

Before the second commit, the evaluator may emit only
`PASS_AMENDMENT_DRAFT_PENDING_SEAL`. After the additive seal receipt and Git
objects verify, `PASS_AMENDMENT_READY_FOR_JOINT_APPROVAL` means only that the
bundle is complete, checksum-bound, sanitized, internally consistent,
non-waiving, and still unapproved. Neither result authorizes FC-01A-R,
deployment, BASELINE_FROZEN, FC-01B, or M00.

## Files

- `fc01-v1.2-amendment-a.md`: normative amendment.
- `blocker-reachability.json`: complete temporal blocker classification.
- `authorized-repair-scope.json`: exact source, test, path, branch, and mutation
  authority.
- `m00-deployment-set.json`: participating runtime identities, state
  dependencies, immediate rollback anchors, and Voice exclusion.
- `provider-nullability.json`: schema-permitted null handling and non-null hard
  identities.
- `confidential-disposition-index.json`: M00 relation/RPC/storage posture plus
  secret and tracked-record proof contract.
- `repair-budget.json`: finite zero-spend repair budget.
- `candidate-identity-budget.json`: inactive, target-specific bounded budget
  for establishing Gateway/LangGraph candidate deployment identities.
- `test-plan.json`: deterministic M00-critical lanes and counts.
- `approval-contract.json`: separate Amendment, later BASE-00, and
  target-specific approval requirements.
- `approval-receipt-schema.json`: immutable direct Davide/Luis decision and
  aggregate-receipt contract.
- `predecessor-evidence-index.json`: exact paths and SHA-256 values for every
  cited predecessor receipt.
- `authority-lock-correction.json`: additive correction for the malformed
  predecessor lock-digest transcription; prior evidence remains unchanged.
- `limitations.md`: current facts that remain unproved or unauthorized.
- `SHA256SUMS`: checksum coverage for every file except itself.

The companion approval evaluator is
`evaluate_fc01_v1_2_amendment_a_approval.py`. Until two valid direct decision
files, their authenticated GitHub issue-comment statements, and an aggregate
receipt exist as append-only control-branch commits, it returns an awaiting or
blocked state; it never infers a signature from conversation text.

The only identity method is `GITHUB_ISSUE_COMMENT_V1`: the evaluator reads the
exact canonical comments through `gh api`, requires the authenticated Davide
actor to designate Luis's GitHub login/ID and the evidence operator, verifies
both unedited comments on one governance issue, enforces timestamps and the
repair-budget expiry, and rescans later same-actor comments for revocation.
The two decision files and aggregate are three separate add-only commits after
the seal; later control commits may only add evidence outside that immutable
decision directory.
