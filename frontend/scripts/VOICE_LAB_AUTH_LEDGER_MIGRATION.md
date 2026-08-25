# Voice Lab auth-ledger migration

This migration is an explicit operator action. Product requests never create,
alter, or repair the ledger schema. Keep the Voice Lab kill switch engaged for
the entire operation.

The runner requires two same-target DSNs: the deployed, restricted
`BETTER_AUTH_DATABASE_URL` for `better_auth_app`, and a shell-only
`SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL` for the exact `postgres` owner.
The owner DSN must never be deployed to the frontend. The runner cross-checks
both against `BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF`, verifies the canonical
SQL files against compiled SHA-256 values before opening the database, applies
only with the explicit `--apply` command, and proves the exact schema, owners,
runtime grants, service-role grants, client-role revocations, and persisted
migration identities. Its output never includes either DSN.

Before the first apply, provision the dedicated D02 login with the separate,
owner-only operator. It creates only the fixed
`sophia_voice_lab_gateway` role, requires the exact `postgres` owner session and
Supabase project ref, and passes the new password only as a bound value into a
transaction-local setting. It never places the password in SQL or output. An
already exact role is preserved without password rotation. The versioned
`supabase_pg17.directional_membership.v1` contract accepts either no touching
membership row or the single Supabase PostgreSQL 17 inbound creator edge where
`roleid` is the restricted role, `member` is `postgres`, `grantor` is
`supabase_admin`, and the options are exactly `admin=true`, `inherit=false`,
`set=false`. Any outbound, transitive, duplicate, reversed, or otherwise
noncanonical edge, attribute drift, public raw-object, future-default, or
cross-schema effective authority is a hard stop before repair. The operator accepts only a
pre-migration database with no D02 relation or routine footprint, then applies
its explicit direct-grant revocations to the newly created or already-attested
role. It deliberately refuses to rewrite a grant to `PUBLIC` or another owner's
default ACL. Resolve database-policy drift separately and rerun. After commit,
both the create and idempotent paths open a separate,
bounded connection as `sophia_voice_lab_gateway` with the supplied password and
attest `session_user = current_user`, the exact database, and safe session
settings. A credential mismatch fails with a static error; the operator never
uses `SET ROLE` and never resets or rotates an existing password.

```zsh
export SOPHIA_VOICE_LAB_ENVIRONMENT=production
export SOPHIA_VOICE_LAB_D02_ROLE_PROVISION_APPROVED=YES
export BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF="<expected-project-ref>"
read -s "SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL?Paste temporary postgres owner DSN: "
export SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL
read -s "SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_PASSWORD?Paste a new independent Gateway login password: "
export SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_PASSWORD
pnpm auth:voice-lab-d02-role:provision
unset SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_PASSWORD
unset SOPHIA_VOICE_LAB_D02_ROLE_PROVISION_APPROVED
unset SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL
unset BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF
unset SOPHIA_VOICE_LAB_ENVIRONMENT
```

Build `SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL` out of band from that exact
credential and store it only on the Gateway. Do not pass that restricted DSN to
the role operator; the operator derives an ephemeral equivalent only for its
post-commit login attestation. Re-running the operator is an idempotence check,
not a credential rotation path.

From the repository's `frontend/` directory:

```bash
pnpm auth:voice-lab-ledger:verify-files
pnpm auth:voice-lab-ledger:apply
pnpm auth:voice-lab-ledger:preflight
```

For production, copy the Better Auth DSN only from the authenticated Vercel
dashboard. Do not put it in shell history, command arguments, logs, tickets, or
evidence. Load it through a hidden prompt in the current shell, run the three
commands, then unset it and clear the clipboard:

```zsh
read -s "BETTER_AUTH_DATABASE_URL?Paste restricted Better Auth runtime DSN: "
export BETTER_AUTH_DATABASE_URL
read -s "SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL?Paste temporary postgres owner DSN: "
export SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL
export BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF="<expected-project-ref>"
export SOPHIA_VOICE_LAB_KILL_SWITCH=true
export SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID=d02-db-finalize-v1
read -s "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET?Paste Gateway-only DB finalize secret: "
export SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET
pnpm auth:voice-lab-ledger:verify-files
pnpm auth:voice-lab-ledger:apply
pnpm auth:voice-lab-ledger:preflight
unset BETTER_AUTH_DATABASE_URL
unset SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL
unset BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF
unset SOPHIA_VOICE_LAB_KILL_SWITCH
unset SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID
unset SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET
unset SOPHIA_VOICE_LAB_D02_FINALIZE_AUTHORITY_ROTATION_APPROVED
pbcopy </dev/null
```

The D02 role and these migrations target that existing product/Better-Auth
database. They must never target the isolated `sophia-voice-lab-postgres`
harness database. A database-finalize authority rotation additionally requires
a drained Gateway plane, `SOPHIA_VOICE_LAB_KILL_SWITCH=true`,
`SOPHIA_VOICE_LAB_D02_FINALIZE_AUTHORITY_ROTATION_APPROVED=YES`, a new key ID,
and `--apply --rotate-d02-finalize-authority`. The operator verifies there are
no relay rows, unsettled freezes, or incomplete continuity chains while its
schema lock is held; it emits only the old/new key IDs and never the secret.

The initial command verifies the immutable files without opening a database.
The apply command itself performs the locked pre-DDL target, role, and exact
fresh/predecessor checks; the normal preflight is meaningful only after the
current D02 schema exists. Any target-identity, file-hash, shape, metadata, or
privilege failure is a hard stop. Do not bypass it. The migration adds and
retains its schema and data objects after a product rollback so spent-grant
tombstones remain effective. Its explicit privilege hardening is intentionally
subtractive, as described below.

PostgreSQL's built-in global default grants `PUBLIC` execute access on future
functions; a schema-specific revoke cannot override that global default. The
migration therefore removes global `PUBLIC` and D02 Gateway defaults for future
`postgres`-owned functions, covering every schema, and separately denies their
additive `public`-schema function, table, and sequence defaults. Existing
defaults for unrelated, non-member roles are preserved and remain subject to
their own service review. Do not restore the global `PUBLIC` function default;
keep the Gateway's `public`-schema allowlist unchanged.

The destructive real-Postgres regression has a separate test-only target gate.
It accepts only a database whose exact name is `voice_lab_test`, and requires
both `NODE_ENV=test` and
`SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED=YES`. It never accepts this
lane for production migration commands. From `frontend/`, run:

```bash
NODE_ENV=test \
SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED=YES \
SOPHIA_VOICE_LAB_TEST_DATABASE_URL="$DATABASE_URL" \
pnpm exec vitest run \
  src/__tests__/api/voice-lab-ledger-postgres-integration.test.ts
```

The regression resets the product, Better Auth, cleanup, and D02 test objects
inside that isolated `voice_lab_test` database, executes the same pinned
operator `--apply` and preflight path, proves both cleanup expressions are
selected by PostgreSQL `EXPLAIN`, and exercises the signed-binding update fences
before removing its test objects.
