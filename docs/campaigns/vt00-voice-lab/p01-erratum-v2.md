# VT00 V-P01 composition erratum v2

Status: `REVIEWED — IMPLEMENTATION GATED`

Effective: 2026-09-02

This erratum is the controlling V-P01 composition contract when read with the
parent VT00 mission, VT00-C1, VT00-C2, and `runbook.md`. It supersedes only the
contradictory V-P01 v1 proof composition. It does not waive or relax any parent
security, privacy, deployment, retention, cleanup, spend, or evidence gate.

No official signed V-P01 may run until every implementation and proof item in
this erratum is green on one exact immutable deployment with all gates closed.
Documentation status alone is not implementation evidence.

## Reviewed defect disposition

| Defect | Contradictory v1 behavior | Required v2 behavior | Current status |
|---|---|---|---|
| Submission versus durable state | A mutating response is treated as both submission success and terminal operation proof. | The response records a truthful submission outcome separately from the durable operation state. A submitted or accepted mutation is not `succeeded`; later bounded observation must prove the exact operation terminal state. | `CLOSED DEPLOYMENT GREEN — 669c37b959c10f30bf50dceddd32aa61429146b6` |
| Strict adaptive policy | V-P01 supplies a caller-authored adaptive object while the service accepts adaptive observations only for V-A01. | The first `speak` is non-adaptive. The second `speak` is accepted only when it cites the exact fresh V-P01 observation receipt returned after the first assistant result. Missing, stale, cross-run, cross-turn, reused, or caller-invented receipts fail closed. | `CLOSED DEPLOYMENT GREEN — bc49414dcf2222a760e4f91ff53c3296f6d7a2d2` |
| Run-bound observation receipt | The caller reconstructs an observation from public event fields. | `wait_for_turn` mints a typed receipt bound to run ID, test-run ID, scenario/version, deployment identity, event sequence, turn ID, observation class, issue time, and a service-verifiable integrity value. The follow-up submits that receipt unchanged plus its intent. | `CLOSED DEPLOYMENT GREEN — bc49414dcf2222a760e4f91ff53c3296f6d7a2d2` |
| Semantic spine and polling | The collector requires exactly ten MCP items and records zero polls even when durable settlement requires observation. | V-P01 has exactly ten semantic spine calls. Bounded audited read-only polling may occur between spine calls and is excluded from the ten-call count, but every poll is recorded and joined to the same task, run, deployment, and audit window. Polling may not mutate, substitute for, or reorder a spine call. | `CLOSED DEPLOYMENT GREEN — 5f2cd711e60f83c26d1d0dcd71af5c65e094c4f3` |
| Ordinal domains | `ordinal` and `observed_order` are overloaded, so inserting a poll collides with spine numbering. | Evidence carries separate `spine_ordinal`, `poll_ordinal`, and `chronological_ordinal` domains. Spine ordinals are exactly 1–10; poll ordinals are exactly 1–N; chronological ordinals are unique and contiguous across all 10+N calls. | `CLOSED DEPLOYMENT GREEN — 5f2cd711e60f83c26d1d0dcd71af5c65e094c4f3` |

## Canonical ten-call semantic spine

The semantic spine is fixed and ordered:

1. `get_capabilities`
2. `start_voice_run`
3. `wait_for_turn` for the exact start operation to reach durable `succeeded`
4. first non-adaptive `speak`
5. `wait_for_turn` for the first assistant result and its service-minted observation receipt
6. adaptive `speak` citing the call-five receipt unchanged
7. `wait_for_turn` for the adaptive response and exact speak settlement
8. `inspect_voice_run`
9. `end_voice_run`
10. `export_voice_evidence`

Calls 2, 4, 6, and 9 must report both fields below:

- `submission_outcome`: whether the exact request was rejected, durably accepted,
  or replayed from an earlier durable acceptance;
- `operation_state`: the operation state known at response time, without promoting
  `accepted`, `queued`, or `running` to `succeeded`.

The spine verifier proves the exact operation IDs and their later durable terminal
states through run-bound audited observations. An eventual terminal failure is a
truthful harness/product result, not a submission failure and not a pass.

## Bounded audited polling

Read-only polling is allowed only when a spine response truthfully reports a
nonterminal operation state. The collector must use the smallest sufficient
condition and stop at the first conclusive receipt. The fixed upper bound is 20
polls total and 10 polls for any one operation; every poll uses an explicit timeout
no greater than 10 seconds. Polls are limited to `wait_for_turn` and
`inspect_voice_run`. Timeout inflation, unrecorded polling, polling after a
conclusive receipt, and repeated unchanged actions are invalid.

Each recorded call carries exactly one of `spine_ordinal` or `poll_ordinal`, plus
one `chronological_ordinal`. The merged chronological sequence must be 1 through
10+N with no collision or gap. The audit projection must reproduce the same tool,
argument hash, response hash, request/run/operation bindings, and chronology.

## Observation receipt contract

The receipt is a typed object, not an interpretation supplied by the fresh task:

```yaml
schema: sophia_voice_lab_observation_receipt_v1
run_id: exact UUID
test_run_id: exact UUID
scenario_id: V-P01
scenario_version: vt00.scenarios.v1
deployment_identity_sha256: sha256
event_seq: positive integer
turn_id: stable identifier
observation_class: assistant_turn_complete | assistant_question | assistant_result | assistant_uncertainty | assistant_commitment
issued_at: RFC3339 timestamp
receipt_sha256: canonical service-authenticated digest
```

The service derives every field from durable run/event state. It verifies the
receipt again during call six, proves the cited event and turn belong to the same
run and current execution epoch, and consumes the receipt at most once for that
follow-up. `followup_intent` remains an explicit caller choice and is not covered
by the observed-fact receipt.

## Required real integration proof

Before deployment unlock, one test must execute the actual P01 collector against
the actual service and event projection, persist through both the memory ledger
and a real PostgreSQL ledger, emit the real audit rows, submit the resulting signed
attestation, and verify the same stored run. The test must exercise at least one
nonterminal submission that requires an audited poll and the adaptive receipt
path. Handcrafted expected envelopes, fabricated audit rows, and a mocked service
boundary cannot satisfy this proof.

The same assertion must pass for both ledger implementations with identical
public semantics. Focused tests and every affected full suite must pass before a
candidate is published. Deployment evidence must then show all six exact component
identities, one settled worker, zero active runs, and every mutation/execution gate
closed before the next repair iteration.

Implementation status: `IMPLEMENTED — CLOSED DEPLOYMENT ASSERTION REQUIRED`.
`test/p01-live-boundary-helper.ts` obtains every envelope and authorization audit
from the actual MCP/service boundary, replays those exact items through the actual
collector, attaches its signed claim to the same durable run, and verifies the
stored attestation. The identical assertion runs in
`test/p01-live-boundary.test.ts` for the memory ledger and in the opt-in,
dedicated-database `test/postgres-integration.test.ts` suite for real PostgreSQL.
It includes a timeout followed by bounded audited operation polling and a
service-minted adaptive observation receipt. The proof also requires the actual
export envelope to attest `cleanup_complete`; omission now fails the integration
test instead of being hidden by a handcrafted fixture.

## Execution unlocks that remain outside this erratum

Even after this composition contract is implemented, V-P01 remains blocked until
the campaign separately proves the server-authorized, default-disabled
`VoiceLabControlAdapter` (implementation tracked in `control-adapter.md`);
disposable Chromium process ownership; execution-epoch
fencing; driver/process death; provider/session cleanup; controller parity;
cancellation; 20/20 real built-app trials; and five consecutive deployed canaries.
No dashboard label, DOM click, MutationObserver activation, storage transplant,
CDP/React probe, route reload heuristic, direct provider shortcut, or text shortcut
may serve as the canonical path or fallback.

Execution-unlock progress is monotonic:

- server-authorized `VoiceLabControlAdapter`: closed deployment green;
- disposable Chromium process ownership and execution-epoch fencing: closed
  deployment green at `0b505c40928fedf6a6ca7bdd5fe874ab64208c26`;
- driver/process death plus provider/session cleanup ordering: closed deployment
  green at `8f0cb46a1c9ca23a2e2b7950fb12e6d125e5f35b`;
- storage transplant removal: closed deployment green at
  `81e3da1641f1e3ae2edc56a7dc693915184ebe62`;
- MutationObserver and injected DOM-button activation removal: closed deployment
  green at `b9fafffe575fa39a5f29ff22d9811e449eb4e067`;
- superseded direct UI activation and route-reload fallback removal: closed
  deployment green at `b973a2af742f36dbf148b7bd2f395d5b3bd32bb6`;
- CDP/React diagnostic probe removal: closed deployment green at
  `66cebaa414b2a8b89f2881b34baaac22870652f5`;
- controller parity: implemented in `controller-parity.md`, closed deployment
  assertion required;
- cancellation, 20/20 real built-app trials, and five consecutive deployed
  canaries: pending.

## Historical iteration counter

The evidence-backed lower bound is `P01 attempts >= 1`. The preserved attempt is
run `3c5bc1c1-75ac-4776-9120-d8a665ef5814`, test run
`8469f5b5-1258-42ed-b6b3-4236c36947e2`, on Candidate AL. It ended as a harness
failure with product outcome inconclusive and does not authorize promotion. The
counter is monotonic and must be increased when stronger historical evidence or a
new official attempt is attached; it must never be reset.

## Review decision

The five contradictions above are accepted as the falsifiable repair contract.
Implementation remains gated. Each subsequent candidate may make exactly one of
these semantic repairs, with synchronized code, tests, and documentation, then
must be published, deployed closed, identity-attested, and checked against the
same corrected assertion before the next semantic repair begins.
