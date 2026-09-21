# C5-R1 frontend signed-readiness investigation — 2026-09-21

Status: concrete deployed-schema/frontend compatibility mismatch identified. No
journey or resource-settlement verdict follows from these checks.

## Confirmed sufficient cause: three newer MEM00 companions

Corrected catalog query 09 returns eight non-internal triggers. The existing
`withoutAttestedMem00Trigger` accepts/removes only
`sophia_mem00_ordinary_session_delete_order`. Seven rows remain, while
`EXPECTED_PRODUCT_CLEANUP_TRIGGERS.size` is four. The exact check at
session-ledger.ts:2171 therefore throws ledgerNotReady. The three additional
MEM00 triggers are all on sophia_session_messages:

| Trigger | Function source SHA256 |
| --- | --- |
| sophia_memory_source_acceptance_epoch | b17c97cb0ff43cc2886c91167f3892e55dbf81d901749b7489eb8b20dff88f78 |
| sophia_memory_source_version | 3698f8af3e80860903d7600709eae539ac38a955ac54f1e396856f938dbe38a1 |
| zz_mem00_source_intake_version | 5234c90212fde254bdf0876ea11891857c6d9a4612f14b7193c5af348f2ba095 |

These live hashes independently match the function bodies in the repository's
2026_09_09_mem00_c1_transactional_clear.sql, dependency_authority.sql, and
source_intake.sql migrations respectively. Live metadata: enabled O, invoker
(prosecdef=false), volatile v, plpgsql, public function identity, owner postgres
matching the control table, search_path=pg_catalog, public; existing function
authority predicate true. Their BEFORE INSERT OR UPDATE definitions match the
named migration triggers. These are legitimate memory-governance companions;
they must not be removed or disabled to satisfy the Voice Lab validator.

Repair requested from Claude Code: extend the shared runtime/operator companion
validator with exact contracts for these three functions/triggers, preserving
all four mandatory Voice Lab fences and rejection of unknown, duplicate, or
drifted companions. No blanket exclusion or schema/permission change. Focused
regressions and compatible PostgreSQL verification precede any frontend deploy.

### Diagnostic qualification

All 41 extracted catalog queries executed without SQL errors using read-only
transactions. The initial generated harness contained two bind bugs: query08
used table names instead of index names; query09 omitted the session table.
Both initial results were invalidated. Only those two queries were rerun with
bindings checked against source. Query08 returned both expected cleanup indexes;
query09 returned the eight triggers described above. Claude audited the other
39 bindings and removed its resolver's fallback. The generic boolean metadata
scan found no ownership, role, ACL, RLS, or validity-flag mismatch; it is not a
replacement for the full runtime acceptance predicate.

Raw catalog metadata was temporarily captured at
`/tmp/vt00-c5-ledger-catalog.json` in the existing Gateway service instance for
read-only comparison. No credential values or application record contents were
queried. This database evidence proves a sufficient contract mismatch; it does
not establish that it is the sole possible frontend configuration failure.

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

### After user sign-in

Vercel project `sophia-30911edf/sophia-agent-front` displays www.sophia-ei.com and
Production deployment `3EfesqH5ZgqxnhpZB9HRnwwAMVgH` at a5982c6e. Project
environment metadata directly shows both
`SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS` and
`SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID` as Secret variables scoped to
Production, added August 25. `BETTER_AUTH_DATABASE_URL` is also a Production
Secret variable, updated August 26. No values were revealed or edited.
This rules out absent keyring variable names, not malformed/empty secret values
or active-kid mismatch in the deployed runtime. Claude received these findings.

A further read-only Gateway auth connection with frontend-style startup
search_path options returned `pg_catalog,public,pg_temp`, replication role
`origin`, synchronous_commit `on`, and in_recovery false. The diagnostic also
forced transaction_read_only=on for safety, so that setting cannot be compared
to frontend's required off. This tests the existing Gateway auth route only;
Vercel's hidden database URL has not been equated to that route. A backend's
inet_server_port would not independently establish the client's pooler route.

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
