# MEM00 campaign state

Updated: 2026-09-02

Operational state: `AUTHORIZED_R3_R4_EXECUTION`; continue through the approved bounded hosted probe, additive migration, dark deployment, and synthetic certification cohort.

## Completed safe gates

- Re-pinned repository lineage, deployed services, pre-migration schema, existing Mem0 SDK/endpoints/project/configuration/usage, and LangSmith workspace/project.
- Preserved the active VT00 worktree and reconciled every post-review Voice Lab commit through remote head `7d1e6b6a58ea98a77c00e96be54c61f8fdf2b66e`. Production is currently mixed: frontend and Gateway are on `d8ad61b3`, while Voice and LangGraph remain on `ad611e38` after the external LangGraph `d8ad61b3` attempt failed. The later `566bf2ab`, `80801eff`, and `7d1e6b6a` commits add Voice Lab dynamic-injection/fresh-session certification evidence and preserve authorized voice start across callback identity changes without changing MEM00 authority or deployed product bytes.
- Implemented the additive durable extraction/candidate ledger, canonical authority, revisioned desired-state projection jobs/bindings, monotonic tombstones, owner-scoped governed reader, consumer convergence, identity containment, truthful privacy receipts, structural observability, and default-closed feature contract.
- The post-freeze Section 17 audit repaired the last legacy privacy routes: memory export now fails closed unless canonical and candidate-ledger scope is complete, while memory deletion rejects pending candidates, fences active and forgotten canonical rows, reports provider purge independently, and returns a typed scope-specific receipt. Gateway, LangGraph/Builder, Voice, and frontend identity endpoints now report `mem00.v1` and supported epoch `1` for mixed-version enforcement.
- The synthetic fault flag now owns a durable service-only control plane: exact certification-principal binding, one use, maximum five-minute TTL, content-free audit reference, explicit cleanup, and injected claimant/provider/database/lease/cache/LangSmith failure paths. Browser and ordinary-user identities cannot arm or consume it; the disposable proof ends with zero active fault settings.
- Pinned `mem0ai==1.0.9` in both Python package graphs and kept the existing host/endpoints/configuration.
- Verified the final migration twice in disposable PostgreSQL and executed the transaction-level contract successfully: 12 content-free governance events, two tombstones, one valid atomic prompt admission, one idempotent atomic session-finalization/extraction run, zero eligible collision bindings, two bindings held for reconciliation, and all five service-only operational views queryable.
- A final defense-in-depth audit added locked canonical scope authorization to prompt admission, explicit `scope_denied` accounting in both governed-reader passes, and content/identifier-free diagnostics across legacy Mem0 facade, gateway, retrieval, and memory middleware paths. The migration SHA-256 is `96303ed50b1508b35287cb70acd26dd34e58aa44a50b0527090f17ac302f96b7`.
- The current backend tree is green with 5,895 passed and 161 skipped; the focused governance/migration/consumer slice is green with 434 passed. After rebasing onto remote `7d1e6b6a`, the current full frontend suite is green under bounded worker concurrency: 219 files passed, one skipped; 1,947 tests passed, two skipped. The new authorized-voice-start regression is green 7/7. The current Voice service suite is green with 616 passed. The reconciled Voice Lab tool baseline is green: 29 files passed, one skipped; 341 tests passed, six skipped. Ruff, changed-file ESLint (zero errors), TypeScript, and Voice Lab TypeScript are green.

## External state

- Production schema has not been changed.
- Production MEM00 flags do not exist/are false; the action-time Gateway environment refresh still showed no `SOPHIA_MEMORY_*` variables.
- Voice Lab's action-time read reported no active run, an engaged kill switch, closed backend/voice mutation gates, and the exact frontend/Gateway versus Voice/LangGraph identity mismatch. No voice run was started.
- The failed external LangGraph deployment is retained as evidence-bearing `MEM00-EI-009`. The YAML scanner traceback is falsified as causal because it is also present in successful deployments; the silent status-134 cause remains unproven, and a controlled same-byte rerun is deferred to the already-requested production deployment authority.
- No real user has been imported or enrolled.
- R3 created three unmistakably synthetic provider rows across two isolated subjects. The existing API key denied all tested public v1 delete forms; the authenticated Mem0 dashboard deleted exactly those three rows, and paginated API verification reached terminal zero for both subjects.
- No Mem0 project/configuration/plan/billing/algorithm change was made.
- The refreshed signed-in Mem0 account remains an Admin in the existing project. The API-key page exposes five hashed keys but no per-key scope selector; no credential was changed. The refreshed billing window remains unchanged, Growth Plan remains active, Extra Usage remains off, and usage is 30/200,000 add requests plus 1,786/20,000 retrieval requests.
- R3 is partially proven. The user authorized a bounded current-key delete preflight and, only if it still fails, one replacement key in the existing project, an update to only the existing Gateway key, preservation of the old provider key for rollback, and full terminal-zero R3. After a clean action-time Voice Lab read and passing R3, the same approval covers the exact additive migration, dark deployment with every MEM00 flag closed, and synthetic-only MEM-P01–MEM-P08 cohort. Provider projection remains closed until R3 passes.
- The refreshed signed-in LangSmith Sophia project still uses the pinned workspace/project, 14-day retention, and showed no runs in the selected one-day window.

## Promotion status

`PROMOTE MEM00` is not yet permitted. Required remaining work is the now-authorized bounded credential/R3 repair if necessary, action-time Voice Lab inactivity proof, additive migration, dark exact-candidate deployment, synthetic MEM-P01–MEM-P08 certification, any separately approved real-user legacy/cutover work, five consecutive clean exact-candidate canaries, terminal-zero cleanup, and the final independently reviewable evidence packet. Real-user enrollment/import, bulk or ambiguous purge, project/API/SDK/plan/billing changes, merge, and full promotion remain unauthorized.
