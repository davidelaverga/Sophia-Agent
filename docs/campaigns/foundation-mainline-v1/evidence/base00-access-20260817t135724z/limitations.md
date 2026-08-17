# Limitations and Remaining Gates

- The required planning input
  `Sophia_Repository_Strategy_Selective_Refoundation_2026-08-16.md` is still
  absent. This delta does not substitute for that authority.
- Render now proves exact current Gateway and LangGraph sources, deploy IDs,
  branch settings, and selectable rollback coordinates. Image digests remain
  unknown. Voice is live from a different, 358-commit-earlier source, and its
  rollback coordinate remains unknown.
- The Gateway routing targets are now known and point to the intended current
  LangGraph and Voice hosts. This does not prove end-to-end functional delivery.
- The LangGraph source/config/environment combination strongly resolves to an
  in-process `InMemorySaver`; the live instantiated class is not directly
  exposed. Durable resume remains unproven and is owned by M01.
- The database dashboard exposes no migration ledger. PostgreSQL 17.6 and six
  required relations were confirmed using metadata-only statements, but exact
  applied migration bytes, checksums, ordering, and ACL state remain unknown.
- Eight daily physical restore points are visible, but point-in-time recovery
  is disabled, no restore drill was performed, and Storage objects are excluded
  from database backups.
- The database security dashboard reports 16 issues, including at least four
  visible critical public-RLS findings. Network restrictions allow all IP
  addresses. Exact sensitive relation names were deliberately excluded.
- The SQL editor may have autosaved a private metadata-only draft. Its prior
  provenance and exact count are unknown, so no deletion was attempted. No DDL,
  DML, migration, catalog, data, or provider-setting mutation occurred.
- PR #144 still has ten source-valid current findings: two P1 and eight P2.
  Twenty-three additional current threads appear fixed in source but require
  focused verification and administrative resolution.
- All 161 backend skip reports now have source-mapped provenance. Seventy-three
  reports represent 91 release-critical or governed logical tests whose
  outcomes remain unknown until the correct PostgreSQL, root-Linux, browser,
  and signed live-provider lanes run.
- The pinned history scan now classifies 16 records as structural false
  positives. Ten records representing three strings still require owner
  validation or credential rotation. No confirmed live secret was established.
- The 165 tracked runtime/user records retain unknown real-versus-synthetic
  provenance; this delta did not inspect their contents.
- The prior clean baseline remains red across backend, frontend, Voice, build,
  and browser lanes. No remediation is authorized in FC-01A.
- Davide and Luis have not signed the checksum-bound acceptance budget. No
  FC-01B, M00 synthetic attempt, deploy, rollback, migration, or product edit is
  authorized.
