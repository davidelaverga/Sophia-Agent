# MEM00 campaign state

Updated: 2026-09-02

Operational state: `CONTINUE` until new production authority is required.

## Completed safe gates

- Re-pinned repository lineage, deployed services, pre-migration schema, existing Mem0 SDK/endpoints/project/configuration/usage, and LangSmith workspace/project.
- Preserved the active VT00 worktree and reconciled every post-review Voice Lab commit through remote head `d8ad61b303b5df8df262dad46d51782353741761`. Production is currently mixed: frontend and Gateway are on `d8ad61b3`, while Voice and LangGraph remain on `ad611e38` after the external LangGraph `d8ad61b3` attempt failed.
- Implemented the additive durable extraction/candidate ledger, canonical authority, revisioned desired-state projection jobs/bindings, monotonic tombstones, owner-scoped governed reader, consumer convergence, identity containment, truthful privacy receipts, structural observability, and default-closed feature contract.
- Pinned `mem0ai==1.0.9` in both Python package graphs and kept the existing host/endpoints/configuration.
- Verified the final migration twice in disposable PostgreSQL and executed the transaction-level contract successfully: 12 content-free governance events, two tombstones, one valid atomic prompt admission, one idempotent atomic session-finalization/extraction run, zero eligible collision bindings, and two bindings held for reconciliation.
- Latest expanded focused backend run: 539 passed. The reconciled backend tree is green with 5,881 passed and 161 skipped. The full frontend suite through `ad611e38` is green: 219 files passed, one skipped; 1,940 tests passed, two skipped; the only later frontend delta at `d8ad61b3` passed its exact six-test file and full TypeScript check. The reconciled Voice Lab tool is green: 29 files passed, one skipped; 341 tests passed, six skipped. Ruff, ESLint, TypeScript, and Voice Lab TypeScript are green.

## External state

- Production schema has not been changed.
- Production MEM00 flags do not exist/are false; the action-time Gateway environment refresh still showed no `SOPHIA_MEMORY_*` variables.
- Voice Lab's action-time read reported no active run, an engaged kill switch, closed backend/voice mutation gates, and the exact frontend/Gateway versus Voice/LangGraph identity mismatch. No voice run was started.
- The failed external LangGraph deployment is retained as evidence-bearing `MEM00-EI-009`. Its owning cause is unproven; a controlled same-byte rerun is deferred to the already-requested production deployment authority.
- No real user has been imported or enrolled.
- R3 created three unmistakably synthetic provider rows across two isolated subjects. The existing API key denied all tested public v1 delete forms; the authenticated Mem0 dashboard deleted exactly those three rows, and paginated API verification reached terminal zero for both subjects.
- No Mem0 project/configuration/plan/billing/algorithm change was made.
- The signed-in Mem0 account is an Admin in the existing project. The API-key page exposes hashed keys but no per-key scope selector; no credential was changed.
- R3 is partially proven but cannot pass while the existing API key lacks memory-delete permission. Provider projection remains closed. R4+ production gates remain.

## Promotion status

`PROMOTE MEM00` is not yet permitted. Required remaining work includes an explicitly authorized same-project delete-capable Mem0 credential and a clean full R3 rerun, explicit R4 authorization, dark production deployment, synthetic MEM-P01–MEM-P08 certification, any separately approved legacy/cutover work, five consecutive clean exact-candidate canaries, and the final independently reviewable evidence packet.
