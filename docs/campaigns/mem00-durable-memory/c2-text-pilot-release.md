# MEM00-C2 text pilot — current release record

Successful target: MEMORY_TEXT_PILOT_READY. Current status: IMPLEMENTING, not activated or deployed. C2 replaces the prior PROMOTE-only/five-core-run prerequisites for this owner-restricted pilot. Historical C1 records and failures remain valid history, not additional first-use gates. Latest failed iteration868; checkpoint863–867 reported; next five-failure checkpoint872.

## Candidate and scope

- Isolated worktree: Sophia-Agent-mem00-c2, branch codex/mem00-text-pilot.
- Integration base:35c6467c36b9ae052ec3dd943cf7c9f0ac28d589. Memory audit anchor:8d0d6d335d4a4a833eb827b2678b639d4b927241.
- Preserved source WIP: Sophia-Agent-mem00 at41b3322a1982387a408db3f52277a9f9450a438c. No reset, bulk staging or overwrite of unrelated work.
- Pilot cohort: Davide's authenticated application owner (identity verification and activation pending), plus exact synthetic acceptance principals. No legacy import or automatic approval.
- Enabled target: extraction/review/Pool/lifecycle, automatic and explicit-tool text recall, current final model admission/revocation.
- Disabled target: Builder personal-memory retrieval and inherited memory-derived briefs; voice personalization and identity. Ordinary Builder tasks remain available from independent user/task sources. Optional restore/bulk/source-mutation routes must be selected only with their proven dependencies or explicitly refused.
- Provider: preserve deployed mem0ai1.0.9, V1 CRUD/V2 search, existing project/configuration. Truthful bounded pending cleanup is permitted; no false terminal-zero claim.

## Selected foundation, not a deployable release

Published foundation d2944ebfa3319ff2b864311981a776b476b2ca1a has tree6018d1c4f587443fcc785847b4299fb79c158705, identical to locally tested35170741. The local authoring commit is retained on codex/mem00-c2-foundation-local; the pilot branch follows the verified published commit. GitHub publication used the existing authenticated connector, not a new token. Original memory/shared branches were not moved.

Next selected callsites: existing direct memory facade denial before cache/provider access, generic memory HTTP refusal and neutral identity with post-file-read authority recheck. The facade's new retrieval-provenance extension and raw-write metric extension are deliberately not imported yet; their dependencies belong with actual text admission and serving evidence. This intermediate code must not be deployed before those remaining boundaries are integrated. Focused foundation+actual-entrypoint tests7a21f8:25 passed with9 pre-existing Pydantic warnings; no external calls. The identity read-race test is reused with its fixture import pointed at the selected foundation module.

Publication failure accounting: EI864 (84c82a) expected HTTPS push, got missing username/credential. Hypothesis: CLI credential unavailable although an authenticated connector may exist. Verified connector profile davidelaverga and published the exact tree without new credentials. EI865: update-ref's documented create/update wording did not create the absent branch (422); follow-up fetch consequently found no ref. Owning fix: use create_branch for a new ref, then read-only fetch26ba53 and exact local/remote tree comparison3f9b84. No production/customer state affected, no temporary provider fixtures, no force push. These are publication/setup failures, not product-canary failures. Latest865,next867.

Selected identity race regression is terminal: b3108b30 passed,9 existing Pydantic warnings, across foundation, actual facade/generic HTTP/identity entrypoints, and post-read cutover/outage/wrong-owner races. Whitespace check8fb56e passed. This does not claim complete consumer containment or a production journey.

First extraction reuses the existing owner-authority resolver, typed model, exact store read and availability/authority separation. It includes only one proposed forward migration:2026_09_08_mem00_c1_owner_authority.sql, SHA2561044fd8e89438488e3cd349a759c8afa345dd8c68fa6da4a06a62676ca682b0d. That migration depends on the existing base memory schema; it does not enroll anyone. Production application and declarations remain pending exact approval review. No other private migration has been selected by default.

The selected helper tests are extracted unchanged from the existing authority suite. On this isolated source, d63c35:11 tests passed through Python3.12/uv frozen offline. adadef:27 disposable PostgreSQL17.5 checks passed: upgrade preservation, explicit declarations, receipt replay, downgrade/delete/truncate fences, canonical RPC compatibility, least privilege and reapplication. The database was closed. These are foundation proofs only: no actual facade/callsite inventory, mixed-binary routing, independent concurrency, hosted model or activation claim.

Next: extract the dependent canonical review/command/projection and actual text-admission callsites from the existing WIP, reviewing imports and SQL dependencies as selected. Contain Builder memory at real serving/delegation boundaries rather than importing all Builder personalization work. Reuse V89 evidence only where selected bytes/contracts still match; run focused checks for changed composition. No new generalized framework.

## Finite C2 acceptance

### Canonical source/review slice, 2026-09-14

This slice follows published receipt commit23072300a03b5a7a53fb8fc0a71ab3c27d5e99b0 (tree91f88c42e1a4b79d41b9dc7234a46077ba86ebc9), which follows legacy-boundary commit e6ff75d475a26b4a67289aac4b59e49dff243034. All are isolated from the shared deployment branch.

The current v2 review contract requires source eligibility and clear-epoch checks; it was not downgraded to an older contract to reduce the migration count. Nine existing dependency migrations are now selected in addition to owner authority and command receipts: dependency_authority, review_snapshot, snapshot_inventory, source_decision_fence, transactional_clear, source_intake, extraction_dispatch, epoch_source_target, and epoch_review (all2026_09_09_mem00_c1). None has been applied in production. Selecting SQL dependencies does not enable optional clear/restore/source mutation endpoints. The source-intake/target helpers are dependency code, not a claim that all write callsites are integrated.

Evidence: Gateway recovery rerun56e5cf passes29 tests after the lost process handle was safely rerun. Disposable SQL-only b16578 passed39 checks,1,005 candidates/six pages. Joined proof0cffad passes41 checks with22 actual Gateway/HTTP-store requests, actual Next recap/recent proxies and the recap loader, exact1,005 candidate/revision preservation, zero provider calls, and two executed—not skipped—frontend cases. Reporter SHA2561aa7652aafc2010e666895d9041031bdf9688a2d370617666b7beb328230e26f. Disposable database and private synthetic transport/report files were removed. This proves the read chain, not an actual hosted browser lifecycle or lost decision-response UI recovery.

Frontend79d9c6 passes50 unique tests: schema19, authenticated recap proxy8, existing session routes4, loader15, truthful empty views4. An earlier50-test result122487 included19 repeated registrations from importing a test module; it is superseded by a standalone fixture and the unique50-test run. TypeScript9f7142 exits0. Whitespace809d98 exits0. Current review rendering cannot consult competing derivative copies when a canonical envelope is present. Full owner-switch/transient browser-state integration remains pending; the historical owner-unaware session-history interface is not represented as complete isolation.

Failure accounting: EI866, local Python collection826f26, hypothesis: selected Gateway inventory function ended before its exception handler body. Repaired the exact handler with content-free503/no-store; regression56e5cf29 passed. EI867, local TypeScript69c6f6, hypothesis: wrapper still restricts the old recap status union. Updated RecapComponents to accept no_pending/source_excluded, verified9f7142 and rendered-state tests79d9c6. MEM00_FIVE_ITERATIONS_REACHED — CONTINUE was reported for863–867: prior legacy-privacy fixture mismatch, two publication setup errors864/865, and two incomplete patch selections866/867. Pattern: composition/dependency selection, not hosted provider failure; next experiment was typed/rendered read-chain verification, now passing. EI868, stale loader expectation0c3cb5: hypothesis:404 now correctly reports source_not_found but the test still expects session_not_ended. Updated only that diagnostic expectation; all15 loader tests pass79d9c6. These failures had no production effect or provider state. Next: finish the selected write lifecycle and actual text admission, then requalify their integrated paths.

Receipt-recovery integration selected next: existing2026_09_08_mem00_c1_command_receipts.sql (the second selected migration, not the entire C1 set), typed original command receipts, strict owner/key-bound store lookup, canonical service and authenticated Gateway status route, plus existing Next proxy/schema. SQL93c4c8 passes24 actual RPC receipt/replay/tombstone and lock-order checks including repeated migration application; disposable database closed. Backendfff312 passes38 focused tests, including committed/tombstoned/absent/wrong-owner/wrong-key/outage/duplicate/extra-plaintext status responses. Frontend9f62f7 passes6 proxy tests; TypeScript376b15 terminal0. Frozen offline dependency install reused844 packages/downloaded0; existing pnpm policy skipped native build scripts and was not changed. This proves recovery plumbing, not complete review UI or actual hosted lifecycle. Remaining ordinary decision response/UI integration is still required.

| Gate | Current disposition |
| --- | --- |
| Isolation and durable rollback | Foundation tests pass; actual callsites and rollback-safe deployment boundary pending |
| SQL → Gateway → Next → UI review and lost response | Joined current review read chain passes; ordinary decision/lost-response UI integration pending |
| Actual text model admission/retained revocation/disabled inheritance | Existing WIP evidence available; pilot-specific integration pending |
| Exact delayed-effect/edit/delete and truthful pending | Existing WIP evidence available; candidate integration pending |
| Selected migration compatibility/least privilege/restart | Eleven selected; foundation/receipt/review disposable checks pass; complete selected upgrade/restart and production approval pending |
| One complete authenticated browser-to-hosted-model lifecycle | Not run on this candidate |
| Davide account activation and practical handover | Pending trusted owner resolution and authorized rollout |

Provider uncertainty is tracked debt, not an automatic pilot-wide blocker. Keep exact ownership, last/next reconciliation observations, bounded retries and visible pending status. Never erase the two historically uncertain synthetic obligations to make a report pass.

## Shared deployment coordination

Fresh public reads10:47–10:48UTC on2026-09-14 pin Gateway, Graph, Voice and frontend to35c6467c. Frontend deployment dpl_HDssPdmDg3DCMMztw4kWzwBMKfkj. Schema advertises mem00.v1/epoch1 but earlier actual column reads showed the owner-authority/clear additions absent; advertisement is not migration proof.

VT00 reports no C5 run started or gates opened; it released the provisional freeze for local/planning work. An explicit exclusive shared deployment window is still required before product mutation. MEM00 owns pilot memory cohort/profile; VT00 owns Lab admission/controls. Neither changes the other's settings. No production mutation was performed.

Render's documented rollback restores the target health-check path as well as artifact/environment, so a new health path alone is not durable old-binary exclusion. Keep that deployment issue explicit; do not invent a paid service or rotate credentials without authority.

## Deferred full-release work

Full C1 fault campaigns/five-canary promotion, universal historical provider finality, broad user rollout, Builder/voice personalization, identity v2 and optional bulk/restore expansion remain later work. They do not replace C2's finite acceptance or defer a proven usable pilot handover.
