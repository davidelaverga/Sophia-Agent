# Production approval request — ordinary session deletion ordering

Status: **approved and production-applied**, verified at 2026-09-06T18:59:53Z. The user's next-turn “approved” granted this exact staged action. Both original fence hashes remain unchanged; the new helper hash, enabled BEFORE DELETE trigger, fixed search path, SECURITY DEFINER and denied anon/authenticated execution match this proposal. The exact disposable P01 deletion now returns200 and leaves zero session/message/source rows, but a Gateway recap file remains. See `ordinary-delete-applied-20260906.json`; this is not terminal-zero certification.

## Exact target and action

Supabase project `vlxnwmyvhchwbousrdzc`, main production database. Execute the complete transaction in `backend/migrations/2026_09_06_mem00_ordinary_session_delete_order.sql` only after verifying SHA-256:

`aa0bfd23151602da02cd28af6deba013e5e0c586018cfd2fae65341006ea5211`

It adds one function and one BEFORE DELETE trigger on `public.sophia_sessions`. For ordinary, non-Voice-Lab sessions, it deletes only child messages with both the exact parent ID and owner ID before the parent disappears. The existing parent and child fences remain unchanged. Applying the migration changes **no existing rows**, creates no service, and changes no Mem0 flag, contract, configuration, credential, or billing setting. Its ordinary-delete ordering applies to ordinary sessions generally, not just the single certification owner; existing authorization and row-security boundaries are unchanged.

## Evidence and before-state

All four product components run `00af23d8d24f5a28c9ec5dfb954992883fe51aaa`. The repaired End succeeds with202, canonical ended_at and an actual completed LangSmith event. Source deletion then fails500 at2026-09-06T17:37:21.255Z; PostgreSQL returns P0001 / synthetic transcript parent session is unavailable. The exact fixture still has1session,2messages and a local recap. The source invalidation receipt is committed and its extraction run is superseded; this is not successful deletion.

Read-only production fingerprints:

- existing message fence: `11adcf09844e96acbdc00e76bd9d6504a9a834540a3d30774e09a45b15a032f3`;
- existing parent cleanup fence: `0678607736ee21130257e2a87f79bc807d12a0f6d22295f55079ff6bbb4aa1b2`;
- proposed helper body: `4087a488f957a0fb77d758de1db94f9938644411103ecfc77c62f5b9664716ce`.

The migration aborts on message-fence drift, an unexpected existing helper body, or an unexpected trigger target. No existing fence is disabled or rewritten.

## Verification and risk

Disposable PostgreSQL with the exact deployed message-fence body reproduces the production failure before the migration. Applying the migration twice passes ordinary cascade, unchanged other-owner rows, transactional rollback of parent and child, fail-closed rollback for an inconsistent foreign-owner child, denied synthetic parent/child deletion, denied browser function execution, unchanged message-fence fingerprint and DDL rollback tests. The in-memory database is closed after each run. No production mutation is part of this test.

Verification runtime: isolated `@electric-sql/pglite@0.3.10`, PostgreSQL17.5,
Node22.22.0. Production PostgreSQL remains17.6. The after-suite passes5946backend
tests with161skips/12warnings in337.17seconds; focused migration/end tests17pass.
No product source changed after the already verified frontend1955/2, TypeScript
and Voice616/12 checks. Ruff and diff checks pass.

DDL acquires a brief table lock; ordinary deletion behavior is affected. Synthetic Voice Lab retention remains unchanged. The user-approved synthetic fixture is the only planned production deletion test. Do not purge older candidates, voice runs, ambiguous data or entire owners to make the test pass.

Immediately before applying: recheck0active voice runs and readiness/kill/gates, refresh remote/component/schema fingerprints, and confirm the migration digest. Apply one transaction; inspect both original fence fingerprints and the new helper/trigger/ACL. Re-run the exact ordinary fixture deletion through Sophia, verify session/message zero, source invalidation, derived-state cleanup and content-free retained receipts. A local recap currently remains and its cleanup must be addressed before terminal-zero certification. Run a fresh hosted Mem0 probe for the next certification candidate/schema combination. Five complete canaries and live metrics remain outstanding.

## Rollback

Within a transaction, verify the installed helper body matches the fingerprint above, then drop only `sophia_mem00_ordinary_session_delete_order` on `public.sophia_sessions` and its same-named function. This restores the prior ordering/failure and was tested locally. It does not restore sessions a user subsequently deleted; those deletions are ordinary requested product operations. Do not use rollback to bypass canonical tombstones or privacy decisions.

The specific approval was received and consumed only for the transaction above. No other schema, configuration, credential, billing, import or merge action is authorized by it.
