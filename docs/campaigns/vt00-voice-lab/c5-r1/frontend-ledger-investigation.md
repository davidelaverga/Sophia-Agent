# C5-R1 frontend signed-readiness investigation — 2026-09-21

Status: blocker narrowed, exact failing ledger predicate not yet identified. No
journey or resource-settlement verdict follows from these checks.

## Decisive observation

The existing deployed MCP `probeTestAuth(loadConfig(process.env, 'web'))` was
invoked in its authenticated Render shell. A diagnostic fetch wrapper printed
only the HTTP status and an allowlisted error-code string from the non-success
JSON response. Credentials and signed capabilities were not printed by this
probe. No session or voice run was created.

Result: HTTP **503**, **voice_lab_auth_ledger_not_ready**. The probe's ordinary
public projection hides the non-success body, explaining why `/readyz` alone
did not distinguish the failure.

At frontend a5982c6e, this failure is downstream of capability verification,
control-gate parsing, and TEST_NAME validation. The proposed TEST_NAME/boolean
edit and blind Production rebuild are not supported by this result. Claude
accepted the correction and resumed ledger investigation.

The ledger preflight first obtains its schema advisory lock and ACCESS SHARE
table locks, then validates the tombstone keyring, then executes catalog queries
and checks their results. Its catches intentionally collapse many failures into
the same error. This observation alone does not distinguish these phases.

## Read-only catalog observations

Used the Gateway's existing SOPHIA_VOICE_LAB_AUTH_DATABASE_URL in the installed
Python 3.12/psycopg runtime. Connections explicitly used read-only transactions,
five-second connection and statement timeouts, and returned catalog metadata
only. This is evidence about the Gateway auth connection, not independent proof
that the frontend uses the identical connection configuration.

- session_user/current_user both better_auth_app.
- Runtime role: NOINHERIT, not superuser, cannot create roles/databases, LOGIN,
  no replication/BYPASSRLS, cannot CREATE in public.
- SELECT privileges on session, sophia_voice_lab_auth_grants, and
  sophia_voice_lab_cleanup_obligations all true (the three ACCESS SHARE targets).
- Governed tables inspected have RLS and FORCE RLS false, owner postgres:
  session, user, sophia_sessions, sophia_session_messages, all auth/cleanup and
  D02 Voice Lab tables returned by the catalog query.
- Both better_auth_app and sophia_voice_lab_gateway have only the observed
  canonical inbound postgres membership granted by supabase_admin, admin=true,
  inherit=false, set=false. No outbound memberships returned.
- D02 effective public non-extension function names equal the expected 15
  gateway-executable names. Signatures/ACLs were not fully re-attested here.
- MEM00 ordinary-session delete-order trigger is enabled O, SECURITY DEFINER,
  search_path pg_catalog, public, with the expected trigger definition and source
  SHA256 4087a488f957a0fb77d758de1db94f9938644411103ecfc77c62f5b9664716ce.
- Voice Lab cleanup-write-fence source SHA256 matches the frontend constant:
  0678607736ee21130257e2a87f79bc807d12a0f6d22295f55079ff6bbb4aa1b2.
- The plain diagnostic connection search_path is not frontend evidence:
  frontend database.ts explicitly supplies pg_catalog,public,pg_temp options.

The proposed pg_stat_statements discriminator could not run: better_auth_app
lacks access to schema extensions. No privileges were changed and no alternate
role was used to circumvent that denial. The failed statement aborted that
diagnostic transaction; a subsequent table-comment query in that transaction
did not execute and must not be reported as verified.

A separate fresh read-only transaction subsequently verified the auth-ledger
table comment exactly matches the frontend migration marker:
`sophia.voice-lab.auth-ledger.v1 migration_sha256=42e6f2b3bf083675bcdd7b2f29c66b400c6fca9771b76f866e6c55f8513b514c`.

At 21:23:49Z the installed plugin successfully returned capabilities; the
redacted, scoped receipt is in evidence/frontend-ledger-capabilities-check.json.
At 21:24:22Z public readiness still returned not_ready: browser_worker ready,
one live worker, heartbeat sequence 1126 from boot 20:46:35.609Z, expected and
observed worker gates false, identity 804117c3... matched, all four product pins
verified, test_auth HTTP 503, mutation_ready false. Active_runs=0 is only an
admission-store observation and is not resource-settlement proof.

Existing IAB Vercel access redirects to login. User sign-in was requested for
read-only frontend configuration inspection; no credentials were requested in
chat. Claude is preparing the narrower read-only diagnostic.

## Remaining discriminators

Verify tombstone keyring configuration in the actual Production frontend
environment without displaying key values, including strict JSON format,
active-kid membership, length and key separation. If valid, use an exact
read-only expected-versus-observed ledger diagnostic, preserving all existing
role/ACL/function contracts. Do not infer a missing migration from this generic
503 and do not weaken the validator to obtain readiness.

No production configuration, schema, grants, deployments, pins, or gates changed
during these diagnostics. Current run admission remains blocked by readiness;
open gate settings are not equivalent to a ready or suspended service posture.
