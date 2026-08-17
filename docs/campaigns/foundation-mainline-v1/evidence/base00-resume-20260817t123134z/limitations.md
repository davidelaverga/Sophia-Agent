# BASE-00 Resume Limitations and Remaining Gates

This delta closes no release gate by inference.

1. GitHub metadata now binds the current and immediately prior Vercel
   production deployments. Current provider branch, alias/promotion behavior,
   retention, and rollback selectability remain unknown without Vercel
   control-plane access.
2. Historical Render receipts bind exact Gateway and LangGraph deployment IDs
   at source `74b4966f...`. They do not bind the current Render deployments or
   the provider IDs for the declared rollback source `34217a8a...`. Current
   deploy/image identities, branches, events, and rollback selectability remain
   unknown without Render control-plane access.
3. Source history exactly explains all six migration rewrites. Existing
   receipts do not prove which bytes ran in production. Live-applied variants,
   the current catalog, provider migration history, backup/PITR, and a usable
   restore point remain unknown without governed read-only database access.
4. The 165 tracked runtime/user records are inherited pre-divergence and have
   no scanner match. Commit subjects and test references are not sufficient to
   prove every record synthetic. Real-versus-synthetic provenance and governed
   disposition remain unknown.
5. The pinned, redacted history scan found no confirmed live secret. Thirteen
   records remain unresolved pending credential-owner/manual validation. Its
   reported commit count is 269 below the reachable-object count, and
   unreachable/reflog-only objects, dirty content, deeper archives, and deeper
   encodings were outside the scan boundary.
6. The original red baseline, PR review/mergeability findings, non-durable
   checkpointer inference, missing exact-head CI, and unsigned acceptance
   budget are unchanged.

These limitations require `BLOCKED`. FC-01B and M00 remain unauthorized.
