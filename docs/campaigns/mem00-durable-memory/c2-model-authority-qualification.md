# C2 selected model-authority SQL qualification

This is an unapplied database/test slice, not a serving release or pilot activation.
It follows the eleven selected forward migrations on the C2 branch and the
existing September 2 base. Application execution privileges remain revoked.
Do not apply this file or grant access merely because the tests pass.

## Selected contract

`2026_09_14_mem00_c2_model_authority.sql` consolidates current v4 final admission,
prompt availability evidence, source-only Builder associations, positive legacy
dispatch checks, and immutable historical model-result receipts. It excludes
completion/resume admission and Builder personal-memory manifests. Ordinary
source witnesses must match the actual attempt's conversation.

## Evidence

`tools/mem00_c2_model_authority_contract.mjs` passed 69 PGlite checks and 75 native
PostgreSQL 17.9 checks (campaign outputs924843/cb5ed9). It executes actual selected
SQL, including source acceptance, canonical create/edit/tombstone, final admission,
Builder handoff/run binding, and historical result recording. Provider bindings
are synthetic observed-projection rows; no provider or hosted model is called.

Native checks include independent concurrent same-attempt requests (exactly one
admitted), a database restart, durable receipts and execution refusal afterwards.
Both modes test reapplication, preserved owner rows, wrong-owner and cross-thread
denial, immutable receipts, unavailable projection refusal, positive exact
canonical manifests, and stale admission after edit/tombstone.

The harness accepts a PGlite-compatible module path as its first argument.
For native mode, use the included `tools/mem00_native_sql_driver.mjs`, with
`MEM00_NATIVE_PG_RUNTIME` pointing to an isolated `/private/tmp/mem00-native-pg.*`
installation containing `pg@8.16.3` and
`@embedded-postgres/darwin-arm64@17.9.0-beta.17`. Inspect and run that package's
symlink-hydration setup before use. The driver creates, stops and removes only its
own temporary cluster. These are test dependencies, not application changes.

## Limits and release dependencies

This is not a production-schema upgrade test, approval to migrate, qualification
of serving grants, exhaustive transaction-lock proof, or hosted delivery evidence.
The compatible runtime integration is still separate WIP. Preserve Gateway
21e982242d8ad0f7b5528f9c6b1743dc5e486ef0 and coordinate a shared deployment window.
The production journey and durable rollback containment remain required before
`MEMORY_TEXT_PILOT_READY`. No Mem0 dependency, endpoint, project, plan or billing
setting is changed by this slice.
