# BASE-00 Limitations and Blockers

1. Render authentication is unavailable. Current deployment IDs, images,
   branches, auto-deploy settings, events, retention, and rollback
   selectability are unknown. Public health establishes Gateway source and
   service health only; it does not establish current LangGraph or Voice source.
2. Vercel provider authentication is unavailable. The active application
   receipt is exact, but provider branch/alias/promotion/preview settings and
   rollback selectability are unknown.
3. Governed database access is unavailable. The live migration ledger,
   applied historical checksums, schema-equivalence proof, backup status, PITR,
   and restore-point availability are unknown.
4. The production source/config resolves the custom LangGraph checkpointer to
   in-memory storage, but the exact live instantiated class is not exposed.
   Restart durability is not proven and is handed to M01.
5. PR #144 is dirty/unmergeable, has no exact-head CI, and retains source-valid
   P1 findings plus mission-relevant P2 review debt. Twenty-nine additional
   non-outdated P2 findings still need individual reproduction/disposition.
6. Both lineages track 165 runtime/user artifacts with content-bearing and
   stable-identifier-shaped fields. Their real-versus-synthetic provenance is
   unknown; no values were copied here.
7. GitHub secret scanning reports no alerts, but non-provider patterns and
   validity checks are disabled and no pinned complete local/history scanner is
   installed. The complete result remains unknown.
8. G-VIS has 62 failures and zero successes. The latest job had blank provider
   credentials and did not produce a deliverable, so product quality is
   `NOT_RUN`, never green.
9. The budget, identity, window, and spend ceiling are proposals. Davide and
   Luis have not signed them.
10. The clean test baseline is red: backend lint and full tests, frontend unit
    and production build, and full Voice tests all fail. Canonical browser E2E
    was not run, backend skips remain unaudited, and PR #144 has no exact-head
    CI.

These limitations require `BLOCKED`; none may be silently waived or inferred.
