# MEM00-C3 — current checkpoint

Updated: 2026-09-22, Codex takeover from Claude.
Target: **MEMORY_TEXT_PILOT_READY — NOT ACHIEVED**.
Owner: Codex, by Davide's direct takeover request. Claude confirmed idle at 07:22:10Z and returned deployment ownership. Davide subsequently authorized bounded delegation; Codex is assigning a local-only D1 reproduction in a separate Claude worktree, with no live runs or deployment authority. No deployment window is open.
Branch: `codex/mem00-c3-closure`, integration `d7f4c93437c638d58bb96f7e0f7341257a0279a8`.

## Scope and authorization

Continue the adopted MEM00-C3 mission, preserving canonical-ledger authority, receiving authentication and exact-owner isolation. No production change or new provider/model run occurred during takeover. Claude reports a $25 cumulative acceptance ceiling but no spend tally. A single request for up to $5 NEW variable spend is pending with Davide; no approval inferred. Existing platform denials remain applicable; switching controllers does not bypass them. No recurring spend authorized.

## Versions and connections

- Gateway: **directly refreshed** `/health` 200, `406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490`, service `srv-d7be5s9r0fns7397l4g0`; authenticated Render shell reads succeeded. Contract `mem00.v1`, epoch 1.
- LangGraph: **directly refreshed** `/ok` 200. Last deployment receipt/Claude handover reports `406ff0a6`; SHA not independently reread this window.
- Frontend: authenticated ordinary app is open. Last verified tuple remains `a5982c6e57efde05311a6add245e0258693f1471`, Production rebuild `dpl_3EfesqH5ZgqxnhpZB9HRnwwAMVgH`. Vercel remains signed in; do not substitute Preview promotion.
- Voice: last verified `5538d08b20a4cfed29e85e61abdffd4c22af6ce8`. Keep this repair; old integrated code cannot restart Voice against receiving auth.
- Lab worker/MCP: last verified `2deb762a7a03ca7f260ec2efd670b5993f7dc977`. Separate VT00 activation is open but test-auth blocked. MEM00 does not authorize changing those gates. Suspension agreement remains unresolved.
- Supabase `vlxnwmyvhchwbousrdzc`: scoped read-only application queries succeeded. Mem0 dashboard and Supabase dashboard are signed in. LangSmith EU connection not yet refreshed.

Local integration preserves `cdb6cebf`, Claude's undeployed `f0ef5f53` trigger compatibility repair, and Voice `5538d08b`. No uniform-SHA deployment is required. Original worktrees and uncommitted activation receipts are untouched.

## Verified current owner/profile and obligations

Gateway resolves certification principal and sole cohort member `CUyZxRFmDNONbR0eKqkJjTrJ2z8nkDKd`. Candidate write/read, canonical Pool, provider projection and governed runtime read are true; legacy inventory/import false. Fault feature enabled, but **fault-settings table empty**. Browser account ID still needs direct product-route verification before acceptance.

Current exact canonical records:

| Record | State | Content/governance revisions | Binding |
|---|---|---|---|
| `14c6a3f8-dab6-4d50-9e58-3956d90642f4` Tin Otter | forgotten | 2 / 3 | both prior revisions purged |
| `a9352106-8ee7-43aa-8a7b-881f3b613219` synthetic summary preference | active | 1 / 1 | eligible, metadata verified |
| `07fe7c4d-5c24-4ec3-9f16-5ea946451d17` pre-existing | tombstoned | 2 / 4 | purged; do not mutate |

Tin Otter has a durable `purge_verified / provider_rows_absent` completion at 2026-09-20T21:40:24.934709Z. This is a newly read historical provider receipt, not a new provider inventory query. The summary preference remains an owned cleanup obligation. Preserve other historical uncertain provider operations; these owner-scoped reads do not clear them.

`ebd83dbc-2e26-4d1b-a345-9b716c6ac0b2` is now ended (2026-09-21T15:53:07.708640Z), extraction succeeded_zero. `f1a7f011-b57e-4b86-841d-ef2cacc95663` is ended with succeeded_nonzero. Do not repeatedly close them from stale instructions.

Newest test session `9531d9e2-9612-47f0-9859-451db04acf39` remains resumable, 3 canonical messages, no ended_at. Its thread `01a0c4ab-d608-7480-972c-0b6ac91a8564` returns **404** to an exact-owner authenticated GET /state; no checkpoint recovered. This does not independently prove physical deletion.

Owner extraction inventory: 21 rows, 6 succeeded_nonzero, 5 succeeded_zero, 5 superseded, **5 failed_terminal**, zero queued/leased/retry_wait. All five terminal failures have attempt_count 8 and retry_budget_exhausted:

- `dfb38056-0278-4c76-be67-1e9471c26555` / session `707ac996-1a0d-45be-b9b1-488ce6c3a838`
- `c7c5c0a4-5867-4fc8-b060-b770b1e13c74` / `5d6c4f9c-a48f-4fde-bf1c-65f4fc9dc148`
- `3008536f-97d6-42fc-8a82-85dc280eb7a9` / `534d30bf-c6d4-4bb7-837d-9a254b6dd9a3`
- `a14ec967-2db1-4428-a039-d3a7e2360e92` / `dc8aa777-9fa5-4500-aab6-bd10dbc9c32b`
- **newly reconciled:** `50cfec91-bc28-4b55-8ebb-7ed130f76ebd` / newest resumable session above.

No retries were reset or manufactured. `source_target.py` reuses matching current input even for failed_terminal runs, so calling enqueue again is not proof of a fresh retry. Reconcile through supported exact-source machinery; preserve original receipts and budgets.

## Defects and acceptance

D1 remains open: actual memory context entry failure was observed by Claude on 2026-09-21, not merely a frontend completion-banner problem. The diagnostic change `13eb09d3` is integrated/deployed but has no fresh failing-turn receipt. The local installed langgraph-api 0.8.1 source DOES emit relative Content-Location on runs/stream; missing-header hypothesis is not established. Do not weaken completion confirmation or bless unproven output.

D2 wrong-run-owner hypothesis is retracted: Claude distinguished correct-owner run logs from default_user GET /state construction. Retain the state-poll load observation separately.

Potential forgotten-content admission remains **unverified**: Claude observed Tin Otter in a response after forget, but did not establish its source or actual admission. Needs scoped hosted evidence, not inference from generated text.

Acceptance: E1/E2 and automatic E3 have historical evidence; explicit-tool E3, actual E4 next admission, E5 warm revocation, E6 complete cleanup/reload, and E7 practical owner handover remain unproven.

## Checks and next action

Fresh dedicated uv Python 3.12.14 environment; editable harness resolves to this branch. Focused backend tests: **120 passed** (text context, checkpoint provenance, extraction worker, service auth). Focused frontend: **50 passed** (22 completion + 28 companion trigger), via project-pinned pnpm. No full-suite claim. Real-PG companion integration and Sentrux remain unverified; Sentrux tool not callable in Codex and Claude reported ENOENT.

Next: after spend answer, verify ordinary app owner, close/resume the exact owned test session through supported UI, and execute one fresh bounded governed text turn with LangGraph logs. Capture actual run completion and denied_at_line without retaining secret/content-bearing logs. Repair the causal path, qualify only affected components, respect deployment denials, then finish remaining E stages and cleanup. Keep ready verdict withheld until evidence is complete.

Historical rollout details remain in git history and c3-actions.jsonl. Current state above supersedes older activation, record lifecycle and stuck-session statements.
