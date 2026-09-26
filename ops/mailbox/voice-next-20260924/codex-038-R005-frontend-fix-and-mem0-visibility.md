# codex-038 — R-005: frontend draft PR + Mem0 new-write visibility
- Scope: no deploy, merge, settings change, Lab action, or retention change; one disposable Mem0 add, subsequently deleted.
- Frontend draft PR: https://github.com/davidelaverga/Sophia-Agent/pull/161
- Head: `a836d4da8f68d6f9ea9b38c845ed28f57a8317fe`; base `codex/frontend-prod-083d4cb0@12ce0f8981f89d97ec96e2549e497442f2b61613`.
- Only production-code change: ordinary cleanup guard uses `token != null || cleanupExpiresAt != null`; synthetic validation unchanged.
- Tests: `pnpm typecheck` PASS; connector 102/102; voice-session hook 64/64; total 166/166. Completed before push.
- Coverage: ordinary absent/null accepted without cleanup authority; either string rejected; synthetic missing/null/malformed rejected; valid synthetic lifecycle remains accepted.
- Automated review: completed 2026-09-26T22:43:05Z on `a836d4d`; bot reported no major issues. No post-push deployment or testing.
- Deploy plan (approval required): merged commit → Vercel Production/current env/Lab off; verify served SHA + `auth:readiness` Lab/adapter off; Davide private-window mic check.
- Rollback plan: instant Vercel rollback to `dpl_BBWRrjKMfsbDdRHFE7AJ4vua3ErV`.
- Mem0 configured org/project: `org_UIGCqdvDj2Yl9F7y9bTEIhQdzH4JX9bYT58i9FPt` / `proj_q1I90sXEFJXjVt3Mvghj2P7nKEfzPvT9h0t9Ft3Z`; dashboard project matched.
- Starter billing period Sep 11–Oct 11: displayed adds 19/50,000, retrievals 669/5,000; no separate embeddings usage/limit or calendar-month total exposed.
- No quota/throttling warnings shown in inspected dashboard/billing/request views; this add Succeeded, one memory, 7.25 s processing. Not a full historical-error audit.
- Status https://status.mem0.ai/: All Systems Operational; add/search 45-day uptime 100%; no incidents indicated since Sep 22 in recent daily bars; no dated incident feed exposed.
- Test began 2026-09-26T22:30:52.976Z; gateway key, configured org/project, `infer=true`, SDK-default `async_mode=true`.
- Synthetic owner: `sophia-r005-disposable-baef221bb6ad4a82bfe760c48d80fd96`; memory `4eee7673-d109-4afa-aed9-3830ea9cc9a6`.
- Add HTTP 200; response had results/relations, no top-level ID/status. Nested queue/event fields were not retained: queued response is unconfirmed.
- Dashboard event `49983594-1374-42f2-a9ed-ce7aea920619`; event GET HTTP 200/SUCCEEDED; exact memory GET first confirmed by the 60 s sample.

| Target / actual s after add response | Search HTTP / hits | Metadata / exact GET |
| --- | --- | --- |
| 0 / 0.001 | 200 / 0 | N/A; no returned memory ID yet |
| 60 / 60.002 | 200 / 1 | All 8 equal / 200 |
| 300 / 300.004 | 200 / 1 | All 8 equal / 200 |
| 600 / 600.005 | 200 / 1 | All 8 equal / 200 |

- Cleanup finished 22:41:00.484Z: DELETE 200, exact GET 404, search 200/0; one R-004-owner search also 200/0.
- R-004 comparison: infer=false/async=false yielded immediate complete GET but search 0 through 300 s; R-005 became visible within 60 s. Two flags differ, so causality is not isolated.
- Recall cause rank 1: Mem0 raw/synchronous-write search-indexing path; strongest evidence is R-004 GET/search divergence versus R-005 visibility under identical gateway key/project.
- Rank 2: adapter consistency contract: immediate single metadata GET, zero waiting, and no search-visibility check; R-002 metadata mismatch itself was not reproduced in R-004/R-005.
- Rank 3: key-scope/quota/global incident, weakened by R-003 equal legacy hits across keys, low quotas, current successful add/search, and status page.
- Next proposal only: investigate raw-write indexing with Mem0 and add bounded pending/readback/search verification to the adapter; do not blindly flip infer=true because extraction can alter canonical content.
- Stop for review; no further application. Sanitized local evidence: outputs/r005/{mem0-timing,event-status,dashboard-evidence,validation}.json.
