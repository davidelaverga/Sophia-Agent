# MEM00-C3 — current checkpoint

Updated: 2026-09-22, Codex takeover from Claude.
Target: **MEMORY_TEXT_PILOT_READY — NOT ACHIEVED**.
Owner: Codex, by Davide's direct takeover request. Claude confirmed idle at 07:22:10Z and returned deployment ownership. Davide subsequently authorized bounded delegation; Claude completed a local-only investigation in a separate worktree (4dc06455), with no live runs or deployment authority. His result concerns a separate clear/new-session edge case, not the proven timestamp failure. No deployment window is open.
Branch: `codex/mem00-c3-closure`, integration `d7f4c93437c638d58bb96f7e0f7341257a0279a8`, frontend repair `ef12097b876869b8d3dae13e70c287371847866a`, pushed. Draft PR: https://github.com/davidelaverga/Sophia-Agent/pull/150 (stacks on current VT00 branch).

## Scope and authorization

Continue the adopted MEM00-C3 mission, preserving canonical-ledger authority, receiving authentication and exact-owner isolation. No deployment occurred during takeover. One bounded ordinary text diagnostic has now been submitted in session `19acce9c-c2d3-4e9e-b53b-5f2387d3d42c`, thread `01a0c810-8fa8-7ee3-895e-7cd9b59a64eb`; it reproduced the post-model failure. Its actual cost remains unquantified; LangSmith exact-run lookup returned 404 and the bounded configured-project query returned no LLM rows. These are not zero-cost proof. Claude reports a $25 cumulative acceptance ceiling but no spend tally. Davide explicitly approved up to $5 NEW variable spend on 2026-09-22. Track this separately from the unquantified earlier $25; no recurring spend. Existing platform denials remain applicable; switching controllers does not bypass them. No recurring spend authorized.

## Versions and connections

- Gateway: **directly refreshed** `/health` 200, `406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490`, service `srv-d7be5s9r0fns7397l4g0`; authenticated Render shell reads succeeded. Contract `mem00.v1`, epoch 1.
- LangGraph: **directly refreshed** `/ok` 200. Fresh diagnostic run logs directly verify `406ff0a6` and local_dev API 0.8.1.
- Frontend: authenticated ordinary app is open. Last verified tuple remains `a5982c6e57efde05311a6add245e0258693f1471`, Production rebuild `dpl_3EfesqH5ZgqxnhpZB9HRnwwAMVgH`. Vercel remains signed in; do not substitute Preview promotion.
- Voice: last verified `5538d08b20a4cfed29e85e61abdffd4c22af6ce8`. Keep this repair; old integrated code cannot restart Voice against receiving auth.
- Lab worker/MCP: last verified `2deb762a7a03ca7f260ec2efd670b5993f7dc977`. Separate VT00 activation is open but test-auth blocked. MEM00 does not authorize changing those gates. Suspension agreement remains unresolved.
- Supabase `vlxnwmyvhchwbousrdzc`: scoped read-only application queries succeeded. Mem0 dashboard and Supabase dashboard are signed in. LangSmith EU authenticated reads returned no matching trace; run cost is not verified.

Local integration preserves `cdb6cebf`, Claude's undeployed `f0ef5f53` trigger compatibility repair, and Voice `5538d08b`. No uniform-SHA deployment is required. Original worktrees and uncommitted activation receipts are untouched.

## Verified current owner/profile and obligations

Gateway resolves certification principal and sole cohort member `CUyZxRFmDNONbR0eKqkJjTrJ2z8nkDKd`. Candidate write/read, canonical Pool, provider projection and governed runtime read are true; legacy inventory/import false. Fault feature enabled, but **fault-settings table empty**. The actual ordinary UI run and its accepted source rows carry this exact owner. The /api/auth/me browser probe was blocked by the client; no bypass was attempted.

Current exact canonical records:

| Record | State | Content/governance revisions | Binding |
|---|---|---|---|
| `14c6a3f8-dab6-4d50-9e58-3956d90642f4` Tin Otter | forgotten | 2 / 3 | both prior revisions purged |
| `a9352106-8ee7-43aa-8a7b-881f3b613219` synthetic summary preference | active | 1 / 1 | eligible, metadata verified |
| `07fe7c4d-5c24-4ec3-9f16-5ea946451d17` pre-existing | tombstoned | 2 / 4 | purged; do not mutate |

Tin Otter has a durable `purge_verified / provider_rows_absent` completion at 2026-09-20T21:40:24.934709Z. This is a newly read historical provider receipt, not a new provider inventory query. The summary preference remains an owned cleanup obligation. Preserve other historical uncertain provider operations; these owner-scoped reads do not clear them.

`ebd83dbc-2e26-4d1b-a345-9b716c6ac0b2` is now ended (2026-09-21T15:53:07.708640Z), extraction succeeded_zero. `f1a7f011-b57e-4b86-841d-ef2cacc95663` is ended with succeeded_nonzero. Do not repeatedly close them from stale instructions.

Session `9531d9e2-9612-47f0-9859-451db04acf39` is now durably ended at 2026-09-22T07:42:00.198906+00:00 after ordinary Start fresh. Its previous failed_terminal extraction obligation remains. Its thread `01a0c4ab-d608-7480-972c-0b6ac91a8564` returns **404** to an exact-owner authenticated GET /state; no checkpoint recovered. This does not independently prove physical deletion.

Latest owner extraction inventory: 22 rows, 7 succeeded_nonzero, 5 succeeded_zero, 5 superseded, **5 failed_terminal**, zero queued/leased/retry_wait. This does not certify physical provider settlement. All five terminal failures have attempt_count 8 and retry_budget_exhausted:

- `dfb38056-0278-4c76-be67-1e9471c26555` / session `707ac996-1a0d-45be-b9b1-488ce6c3a838`
- `c7c5c0a4-5867-4fc8-b060-b770b1e13c74` / `5d6c4f9c-a48f-4fde-bf1c-65f4fc9dc148`
- `3008536f-97d6-42fc-8a82-85dc280eb7a9` / `534d30bf-c6d4-4bb7-837d-9a254b6dd9a3`
- `a14ec967-2db1-4428-a039-d3a7e2360e92` / `dc8aa777-9fa5-4500-aab6-bd10dbc9c32b`
- **newly reconciled:** `50cfec91-bc28-4b55-8ebb-7ed130f76ebd` / previous session above.

No retries were reset or manufactured. `source_target.py` reuses matching current input even for failed_terminal runs, so calling enqueue again is not proof of a fresh retry. Reconcile through supported exact-source machinery; preserve original receipts and budgets.

## Defects and acceptance

D1 source cause is proven and fixed locally at ef12097b: stream persistence rewrote the accepted user message timestamp, rotating its source_version during model execution. The exact receipt/row comparison and causal regression are in c3-hosted-diagnostic-2026-09-22.md. Deployment and a successful hosted admission remain outstanding. The backend source-version guard is unchanged.

D2 wrong-run-owner hypothesis is retracted: Claude distinguished correct-owner run logs from default_user GET /state construction. Retain the state-poll load observation separately.

The Tin Otter marker exists in still-active approved summary preference a9352106; retained context names that exact record. Output text alone is not evidence of a forgotten-record leak. The distinct warm-forget admission test remains unproven.

Acceptance: E1/E2 and automatic E3 have historical evidence; explicit-tool E3, actual E4 next admission, E5 warm revocation, E6 complete cleanup/reload, and E7 practical owner handover remain unproven.

## Checks and next action

Frontend: 2423 passed, 10 skipped (238 passed files, 4 skipped); TypeScript passed. The new timestamp regression fails without the fix. Changed-test lint passed; one pre-existing route warning remains. Integrated backend baseline: 120 tests passed through the dedicated Python 3.12 uv environment. PR Memory Highlights E2E succeeded; draft Unit Tests and Architecture workflows skipped. Required independent review and architecture validation are not claimed.

The new diagnostic session 19acce9c-c2d3-4e9e-b53b-5f2387d3d42c was durably ended at 2026-09-22T08:08:17.692276+00:00. Its extraction e29e6af7-81d2-454f-8c34-301b19b06daf progressed from retry_wait (attempt 7) to succeeded_nonzero (attempt 8, two candidates). The old error_code remained on the successful row. Recap loaded after refresh. Both incidental synthetic candidates (73dfe4fc-7c89-4379-b9ea-61bdbef860ef and 52594f43-1cbb-4ae8-9993-d0e6fc9a1523) were rejected through Sophia and rejection verified in the canonical table. Complete reported zero memories saved. No new canonical approval or provider projection was requested. Debug-export click did not yield a located durable file; do not claim portable export.

Read-only Supabase diagnostics: extraction dispatch EXECUTE privilege is present; governance events estimated 150 rows and extraction runs 22. The dashboard reports high CPU. At 08:21Z, 15 PostgREST connections were associated with sophia_memory_authorize_extraction_dispatch, many waiting for tuple/transaction locks. Query ages were near zero; the traffic origin and persistence remain unproven. No connection was killed, no grant/schema changed, and no service restarted. Gateway logs showed bounded dispatch-authority failures; the latest owned run nevertheless completed. Do not infer all historical failures are repaired.

Next: obtain independent review of PR150, satisfy required gates, then use the supported controller/human path for a Production-environment frontend build of ef12097b (or its later docs-only descendant), with Ignore Build Step override unchecked. Do not redeploy old Production source or promote a Preview-environment build. Existing platform Production Deploy denial remains in force; no alternative controller bypass. Native Claude remains inaccessible while the Mac is locked; the in-app browser works. No deployment has occurred.

After deployment, finish the actual explicit-tool/edit/forget admission checks within the remaining verified $5 budget, reconcile the five historical extraction failures and provider obligations, and clean the existing synthetic preference through supported governance. Keep readiness withheld. Live Gateway/LangGraph/Voice/Lab tuple and separate VT00 posture are unchanged.

Evidence index: c3-hosted-diagnostic-2026-09-22.md, c3-actions.jsonl (C3-0015 through C3-0017), c3-first-use-proof.md, c3-defects.md; historical rollout remains in Git history. This checkpoint supersedes earlier open-session and missing-marker-origin statements.
