# VT00-C4 reconciliation — 2026-09-13

Status: **CONTINUE — NOT PROMOTED**. This is an evidence/obligation inventory,
not a release attestation. Historical evidence is preserved and must not be
silently promoted to the new candidate.

## Current source and production boundary

- Reviewed checkpoint: `3add3336216e74324cd1ed4d3859caccc70c94fe` (CC).
- Committed memory checkpoint: `41b3322a1982387a408db3f52277a9f9450a438c`.
  `git merge-base` returns CC: the memory branch already includes it. There is
  no diff in `tools/sophia-voice-lab` or this campaign directory between the two.
- C4 work is isolated in the `Sophia-Agent-vt00-c4` worktree based on that
  committed memory checkpoint. The separate memory worktree has 1,256 porcelain
  status entries at inspection time. They are preserved, not included in C4 and
  not declared complete. This baseline is not yet an approved deployable head.
- Public readiness observed at `2026-09-13T08:30:12.624Z`: all four product
  identities are `8d0d6d335d4a4a833eb827b2678b639d4b927241`; MCP and the single
  live worker are BZ `e3b40f1b21739479db239c383ce88285ce740152`. Exact-target
  admission consequently fails. Worker heartbeat sequence 321390 reports a
  settled engaged kill switch; MCP/Gateway/Voice mutation gates are closed.
- `active_runs:0` is only the active-run projection. It does **not** prove zero
  provider epochs, Browser leases, owned Builder tasks, expired evidence, or
  independent product cleanup obligations. Those require authoritative audits.
- Installed `get_capabilities` returns `oauth_token_invalid_grant` and requires
  reauthentication. No current installed-package capability attestation exists.
- `resume-sophia-ah-voice-test` deletion returned `not_found`; the local
  automation inventory contains no automation TOML. No replacement was created.
  Safety, resource and spending limits are unchanged.

## First causal contract finding

The existing collector requires semantic call three to succeed on its first
observation. A real MCP/service timeout before the exact start operation settles
is rejected as `P01 call 3 returned a noncanonical status`, even if the next
bounded wait proves success. The signed verifier also omitted startup from its
poll policy. This contradicts a usable asynchronous startup contract.

The local repair shares the operation-observation topology between collector and
verifier. Startup timeouts are audited polls before call three; the first exact
conclusive start receipt occupies call three. Existing bounds remain ten polls
per operation, twenty total, ten seconds per poll. No timeout advances the spine
or authorizes speech. The first test attempt incorrectly expected an explicit
`condition_satisfied:false`; the actual timeout envelope omits it. Correcting that
test assumption then reproduced the collector defect above.

Proof scope: the boundary helper uses actual MCP/service envelopes and audit rows,
but manually settles worker operations, supplies product events/evidence, and
replays a simulated platform transcript. It is a collector/verifier integration
test, **not** a complete built-Sophia journey, real platform installation proof,
provider-cleanup proof, or production canary. The PostgreSQL variant must be run
against a freshly isolated dedicated test database; a skipped variant is pending.

Local verification at 2026-09-13 08:37Z: Node **22.19.0**, full Voice Lab suite
**351 passed / 7 skipped**, 30 files passed / one PostgreSQL file skipped,
13.14 seconds; TypeScript and `git diff --check` pass. The delayed-start test
joins real audit rows through both collector and signed verifier. Exactly ten
startup timeout polls plus terminal spine receipt pass; eleven are rejected
before signing. The initial Node 24 diagnostic run had 350 passes and one
cross-language test failure because the new worktree lacked Python environments.
After `uv` bootstrapping backend and voice on Python 3.12.14, the Node 22 rerun
passes without changing the test assertion or product verifier. Backend uses its
workspace lock; Voice uses its declared requirements (not a deployment lock).
Node 22 archive SHA-256 was checked against the official distribution checksum:
`1c3a9e78da501bbc1f0c99fbbb69bb7c722bc7a9bf30128b21ea502f3905892a`.
No production run, deployment, password change or gate opening occurred.

### Assistant-observation continuation — 08:43Z

A second real-boundary regression inserted a timeout before each of the two
assistant observations. The collector rejected the valid transcript with
`P01 polling must be one explicit operation_terminal wait of at most ten seconds`.
The local shared contract now retains those timeout-only observations before
their conclusive spine receipts. A new content-free audit field binds the
observation cursor. Both collector and verifier require settled speech first,
the exact observation cursor, the correct chronological boundary, and one shared
ten-poll budget for operation plus assistant waits. No separate spend or poll
allowance was introduced. The PostgreSQL integration recipe includes both
delayed startup and delayed assistant observations but remains unexecuted.

Node 22 full suite: **355 passed / 7 skipped**, 30 files passed / one PostgreSQL
file skipped, 11.11 seconds. TypeScript and diff checks pass. New negative tests
reject pre-settlement assistant polling, cursor drift and combined owning-speech
poll overflow. A preliminary invocation lacked Node in the spawned fixture's
PATH and exited 127; corrected PATH then reproduced the intended defect. The
first combined-budget negative fixture accidentally crossed the overall twenty
poll limit; preserving that result, it was corrected to isolate the per-operation
limit and now rejects for that precise cause.

The next async gap identified at this checkpoint: `awaitEndSettlement` can report operation succeeded but
evidence pending, while P01 forbids polling already-succeeded operations and
requires export to be immediately available. Inspecting this path is not yet a
causal test or a repair. The installed skill is not synchronized with these local
contract changes; no current package hash, deployment or P01 certification may
be inferred from the local results.

### Finalization continuation — 08:50Z

The boundary regression now settles the real end operation while the end call is
still waiting, proves its response is `timeout` with `operation_state:succeeded`,
and delays evidence persistence. The initial test was rejected because the MCP
schema had no finalization-ready condition. A local read-only
`finalization_complete` condition now requires the exact owned end operation,
operation success, terminal run state, cleanup flag and durable evidence metadata.
Missing prerequisites remain pending even for a terminal run. It creates neither
an operation nor an event, and does not manufacture a historical success receipt.
Failed end operations produce a terminal unavailable observation.

Collector and verifier share the end-readiness predicate and use this condition
instead of end-operation polling. The conclusive manifest hash must match the
exported immutable manifest. Existing ten-per-operation/twenty-total polling
bounds remain unchanged, including when the operation already succeeded.
The dedicated PostgreSQL recipe now covers delayed start, assistant observations
and evidence in the same run, but remains pending execution.

Node 22 full suite: **363 passed / 7 skipped**, 30 files passed / one PostgreSQL
file skipped, 12.16 seconds; TypeScript and diff checks pass. Five prerequisite
cases independently remove operation success, terminal lifecycle, cleanup, or
evidence, plus a positive control. Missing/foreign/non-end operation IDs are
rejected. A preliminary unit fixture lacked the browser ownership lease required
to claim its end operation; this fixture was corrected without changing claim
semantics. A second full run exposed the old hand-authored collector fixture's
missing terminal lifecycle. It is now explicit, and a new negative case proves
omission rejects before capture persistence/signing.

Scope remains a local ledger/collector/verifier contract. The cleanup boolean and
evidence metadata are not an independently verified production resource inventory;
artifact-byte availability/retention, owner-loss recovery and PostgreSQL parity
remain separate proof obligations. Installed skill/schema synchronization,
release-safe memory integration and all deployment/certification unlocks remain
open. No production activity or gate change occurred.

### Real PostgreSQL continuation — 08:56Z

The existing `mem00-qualification` local VM was stopped when selected. PostgreSQL
18.6 was installed there and a new isolated cluster was initialized at
`/tmp/sophia-vt00-c4-pg.zlMhyn/data`. Before executing any destructive test setup,
the actual connection independently returned database
`voice_lab_test_c4_20260913`, role `vt00_test`, address `127.0.0.1`, port `16432`,
PostgreSQL 18.6/aarch64. Only the new test database was authorized for reset.
Its connection was forwarded over a loopback-only SSH tunnel. No production or
memory-campaign database was used; no production credential was supplied.

The first real-database run had **5 passed / 2 failed**. Both P01 starts correctly
refused admission because the earlier ledger-only idempotency test left its
reserved fixture active. Its exact pending operation is now cancelled and its
resource-free run terminalized in the owning test, with a zero-active assertion.
No concurrency limit was increased. The P01 boundary helper also now releases
its exact simulated browser lease before setting cleanup complete. This is
fixture hygiene, not a production orphan-recovery proof.

The PostgreSQL-only rerun passed all **7 tests**. Two full-suite runs with the
database enabled passed **370/370, 31/31 files, zero skipped**, 12.10 and 12.27
seconds. Both memory and PostgreSQL implementations execute the actual service,
collector, audit and signed-verifier path, including delayed startup, assistant
observations and evidence. TypeScript and diff checks pass. The simulated
platform/worker/product boundaries described above remain simulated; these are
not installed-plugin production journeys. Production PostgreSQL-version parity
is not claimed from this local PostgreSQL 18.6 result.

Machine-readable result:
`../vt00-c4-evidence/local-tests-20260913T0856Z.json` relative to the C4 worktree,
SHA-256 `5ab1dc0137a94820b0641b28b3828cbb3a35fa40c2a3e77ba5512e856f35190e`.
Tested source identity: base `41b3322a1982387a408db3f52277a9f9450a438c`,
`git diff -- tools/sophia-voice-lab` SHA-256
`87e2dc31d375c0309ff50c5f9f8637cf5e59c8e93832e0bc8995afb92b434ded`, plus
the untracked `src/p01-contract.ts` SHA-256
`83796c0c785fda3f88f3587a0823d3ac56c7b92c69b3ef2bf6404fba2a34a680`.

After the final suite, the dedicated database independently reported zero test
schemas and zero other database connections. Its cluster stopped cleanly, the
exact tunnel was cancelled, and port 16432 returned `ECONNREFUSED`.
`mem00-qualification` returned to **Stopped**. The separate
`mem00-qualification24` VM was not stopped or modified. PostgreSQL packages and
the stopped disposable cluster remain available in the selected VM; test schemas
were removed by the suite. This introduces no running test-resource obligation.

### Existing-controller ownership/readiness continuation — 09:04Z

Two causal hook regressions reproduced product-controller defects on the
committed memory baseline. First, an older startup resolved after stop and a
successful replacement startup; it correctly closed its own connection but then
overwrote the replacement's Gemini telemetry with legacy/null state. The obsolete
branch now releases only its own connection, with no controller publication.
Second, reconnect changed connection state while retaining `setupComplete:true`.
Current setup/readiness is now invalidated on connecting, reconnect, closing and
loss, and restored only by a guarded current-owner setup transition. Late
connected events after terminal loss remain fenced. No new runtime, synthetic
activation wrapper or browser fallback was introduced.

The readiness test initially expected a legacy calling-state capture that the
Gemini path does not emit at that boundary. It now verifies actual current
telemetry, live-call state, and exactly two ready receipts (initial/current
reconnect), rather than adding a test-only event or fabricating evidence.

Full frontend: **1,983 passed / 2 skipped**, 222 files passed / one opt-in
frontend PostgreSQL file skipped, 30.00 seconds. TypeScript passes. Strict lint
reports three warnings; independently linting the unmodified committed hook
reproduces the same three warnings (import order and two optional-chain rules).
No warning was introduced or silenced. The first dependency bootstrap used the
bundled pnpm 11 and refused ignored builds; the test commands then used the
declared pnpm 10.26.2 with Node 22.19.0. The pnpm-11-generated placeholder
`allowBuilds` entries were removed; workspace build-script policy and lockfile
are unchanged.

Machine report: `../vt00-c4-evidence/frontend-tests-20260913T0904Z.json`, SHA-256
`973e4b86046f93f66f3616950b0e96e9dc97fef276a9f3635bd07db7cf980ad5`.
The two-file controller/test diff SHA-256 is
`d8c11f2caa71fb4f898805ce14a5500b35c4f2e87cd211c5fc823139d58cf94a`.
These remain mocked-transport hook proofs, not fresh-process built-app journeys.
Other provider callback ownership, retained authorization expiry and owner-loss
resource obligations still need causal audits. In particular, the control
adapter's expired cache entry can return its previously resolved promise; that
source finding is not yet a regression-tested repair. Historical
`control-cancellation.md` claims also need reconciliation with the later
document-scoped shared-request implementation.

### Retained authorization expiry continuation

The expired-cache finding above is now regression-tested and repaired locally.
A resolved cached promise no longer renews an expired authorization: the next
eligible mount requests a fresh server decision. Receipt validity is checked
again before publication and claiming; failed obsolete requests cannot erase a
newer cache entry. Valid in-flight sharing and exact-once epoch claims remain.
The causal tests cover both fresh denial (no invocation or authorization capture)
and fresh approval (only the new receipt is used). The historical cancellation
document now distinguishes its per-mount assumptions from current shared-request
ownership. Cross-principal/navigation invalidation remains unproven.

Full frontend report `../vt00-c4-evidence/frontend-tests-20260913T0907Z.json`:
**1,985 passed, zero failed, two skipped**, SHA-256
`804e17d91e161b5437d2f6dd1b432fa1c7bc90023ad2b31cb73fdb5e2de802d9`.
TypeScript and strict lint on the adapter and its tests pass independently.
These are local tests, not deployed canaries or installed-plugin P01 evidence.
No production limits, passwords or gates changed. A fresh deletion request for
`resume-sophia-ah-voice-test` returned `not_found`: it is already absent.

### Transport callback ownership continuation — 09:15Z

The preceding continuation made progress (expiry repair verification and evidence
recording). Three new causal regressions reproduced stale transport publication
after replacement, terminal connection loss and unmount. Old audio callbacks
incremented replacement counters and changed its provider epoch; old relay errors
degraded replacement/terminal telemetry; unmounted callbacks still emitted capture.
All three failed before repair. The existing request-generation/destroyed/terminal
predicate now guards all 27 supplied transport callbacks before payload handling,
including tool-ledger and synthetic-receipt publication. No new runtime or browser
activation layer was introduced. Tests prove current-owner audio first, then
reject old audio/error callbacks and exercise every callback after each boundary.

Full frontend: **1,988 passed, zero failed, two opt-in PostgreSQL skips**.
Report `../vt00-c4-evidence/frontend-tests-20260913T0915Z.json`, SHA-256
`f6dc21e0a36dbd426f4c5f4bc797028aed8961d96405dd6d04ec35932440945f`.
TypeScript and diff checks pass. Strict lint retains the same three documented
baseline warnings, with no new warnings. A test initially accessed a Gemini-only
field without narrowing the telemetry union; it was corrected to a runtime-tagged
object assertion before this final suite. These remain mocked-transport controller
proofs, not full built-app journeys, provider-epoch isolation, or durable cleanup.
No changes were deployed and the goal remains unachieved. Next resource audit:
worker `maintainSessions` calls retention purge before expired-run/recovery passes;
inspect both ledger purge implementations for preservation of content-free
allocation/settlement obligations across that ordering before judging it safe.

### Retention/recovery causal audit — release blocker

The previous turn made progress with the callback repair. Inspection now confirms
that both `MemoryVoiceLabLedger.purgeExpiredRetention` and the PostgreSQL version
delete terminal runs regardless of `cleanupComplete`. Memory explicitly deletes
browser leases; PostgreSQL deletes the run and dependent records. Worker
maintenance purges before selecting recovery work. The current tombstone stores
purge status but is not a recoverable allocation record; remote-purge work also
vanishes from `listRunsRetentionDue` after local deletion. This contradicts C4's
independence-of-retention requirement. It is not fixed by the earlier green suites.

New ordinary, intentionally release-blocking tests in
`tools/sophia-voice-lab/test/c4-retention-recovery.test.ts` reproduce **four failures**:
failed-harness, worker-loss and expired runs each lose their exact unsettled lease,
recovery binding and active-resource count while retained artifact bytes are
successfully deleted; a locally purged completed run also loses its pending
remote-retention recovery selection. No skip or expected-failure annotation hides
these failures. The initial probe stopped at `listEvents`' typed missing-run
result; the corrected probe uses a seeded artifact to verify content deletion
independently before asserting all resource invariants.

Corrected red report: `../vt00-c4-evidence/retention-recovery-red-20260913-v2.json`,
SHA-256 `79c8d1275ad1662a3de5e546092b2cbb0e4ae1dfae2a9b4254e1c7532bb1334e`.
TypeScript passes. PostgreSQL has the same inspected deletion path, but this new
negative matrix has not yet executed against PostgreSQL. No production mutations
or official P01 attempts occurred. The local lab suite is now knowingly red and
must not be deployed/certified until repaired.

Required repair must preserve the hard content deadline while separating durable
allocation/settlement authority from run content: write exact resource ownership
before external allocation; retain bounded content-free recovery identity,
deployment binding and worker/lease generation through content deletion; count
unsettled obligations in admission and operational inventory; settle only via
exact-owner CAS plus authoritative receipts. Recovery must operate without
transcripts/artifacts and must not republish expired evidence. Pending remote
purge remains discoverable until confirmed. D02 control/freeze/dispatch proof must
remain independently verifiable without retaining arbitrary event payloads.
Audit existing Gateway `sophia_voice_lab_cleanup_obligations` and admission records
before adding parallel authority. Do not merely postpone deletion, retain entire
runs/events, change TTLs, trust lease absence after deletion, or reorder one
maintenance pass: none resolves restart/outage/crash boundaries. Required tests
include PostgreSQL parity, restart after content purge, duplicate/stale settlement,
owner loss between allocation and receipt, and no content resurrection.

### Recovery authority and content-free transport boundary

The preceding turn made progress by reproducing four retention failures. Further
inspection confirms Gateway already owns durable cleanup admissions and a COMPLETE
purge barrier: `cleanup_fence.purge_completed_cleanup_obligations` checks terminal
state, source-zero and owning eligibility; the recovery endpoint accepts retired
authority only with its exact verified tombstone. The lab's raw-run deletion is
earlier than this boundary. Reuse Gateway authority, not a parallel product-cleanup
decision. Lab browser allocation/lease ownership still needs independent durable
control and cannot be inferred from Gateway live-zero alone.

Ran `uv sync --group dev` then Python 3.12/uv tests for Gateway recovery and retention
reaper: **66 passed**, eight existing Pydantic schema-shadowing warnings.
JUnit report `../vt00-c4-evidence/gateway-recovery-20260913.xml`, SHA-256
`1af13565052f743eacddc0caba7e1a643e41aa1084b13991811fbab253fc1f81`.
These are local owning-module tests, not live PostgreSQL/deployment proof.

The actual `VoiceBrowserDriver.recover` interface now accepts a narrow
`RecoveryTransportBinding` (lab run ID, test-run ID, cleanup-obligation ID and
Gateway URL) instead of requiring the entire evidence-bearing `RunRecord`.
Existing callers remain structural matches; two new tests execute recovery from
only this binding, verify exact/mismatched cleanup identity and prove no browser
allocation. All **34 driver-contract tests** and TypeScript pass. This prepares
the existing transport for durable content-free control; it does not yet persist
that control or fix the four red ledger regressions.

Full lab rerun with Node 22 on PATH: **365 passed, four known retention failures,
seven PostgreSQL skips**. Report `../vt00-c4-evidence/lab-recovery-boundary-20260913-v2.json`,
SHA-256 `e763d00712e77a0c56e300e058a12f2c5941b0dae3ae5f05d73cea0da882b388`.
The earlier report without Node on child-process PATH had 15 extra collector
launch failures (exit 127); it is preserved, not counted as product failures.
The corrected rerun proves those are absent. No deployment or new P01 run.

Next implementation must also decouple worker recovery-capability mint/audit and
D02 binding resolution from purged run events. `#mintAndVerify` currently reads
created/provider deadlines, retention policy, principal/environment/scenario,
expected deployment and D02 evidence and writes an audit keyed to the raw run.
Persist only these strictly typed control bindings before allocation; do not
retain arbitrary event payloads. Both `createRunWithOperation` implementations
perform their own concurrency query, so repairing `countActiveRuns` alone would
still permit new allocations over unsettled obligations.

### Strict recovery binding implementation

The previous continuation made progress with the Gateway audit and transport
contract. Added `src/recovery-control.ts`: an explicit strict schema/projector for
the immutable inputs required by recovery capability issuance. It retains opaque
run/test/cleanup identifiers, partitioned caller identity, principal, environment,
scenario, Gateway origin, exact deployment, creation/provider deadlines and
bounded retention hours. It excludes provider handles, transcripts, errors,
artifacts, operation inputs and raw OAuth subjects. Unknown fields (including
nested deployment fields), credentials/query/fragment/path-bearing origins,
oversized decoded input and extended provider deadlines are rejected. D02
ownership/settlement authority is deliberately not invented by this projector.

The worker now explicitly projects only the minimal transport identity before
calling recovery; the outage maintenance test asserts the exact object crossing
that boundary. **107 tests passed** across control-binding, driver and service
contracts (including 16 new binding tests). Report
`../vt00-c4-evidence/control-binding-20260913-v2.json`, SHA-256
`f70d3c5b6aa563c820f46b5bdfbdf6f90d87b5ecfb6c3dd8355f54c9c671db01`.
TypeScript and diff checks pass. The four ordinary retention regressions remain
unfixed; this targeted run does not replace or supersede their red evidence.

The strict binding is not yet durably persisted, and worker capability issuance
still depends on the original run and D02 events. Next integrate transactional
control persistence at admission/allocation, exact settlement CAS, both admission
queries, post-purge recovery and content-free audit. Gateway URL canonicalization
must be reconciled with accepted target spellings before wiring the projector at
admission (its persisted representation requires an exact origin). Backend
architecture instructions were encountered in a truncated read; read their full
contents before modifying backend migration files. No backend or deployment
changes occurred in this continuation. The goal remains unachieved.

### Independent memory-ledger control integration

The preceding turn made progress on strict binding validation. The memory ledger
now creates an independent content-free `RecoveryControlRecord` in the same
synchronous admission transaction as its run/start operation. The record has an
immutable partitioned binding and separate version, cleanup, remote-purge and
content-purge state. Retention deletes raw run/evidence/operation content but no
longer deletes browser leases or control records. Run updates mirror lifecycle
state into control; this is not yet independently validated settlement CAS.
`listRecoveryControls` returns defensive copies of outstanding obligations.
Both concurrency reporting and new-start admission count purged-but-unsettled
controls; cached cleanup-complete flags cannot hide a contradictory retained
lease. Cleanup identities remain reserved after raw run deletion.

The causal tests now prove artifact/raw-run deletion, independent control survival,
exact lease survival and rejection of a replacement allocation. Their four final
assertions deliberately remain red because the worker's old run-based recovery
queries are not yet wired to the new control inventory. A fifth test passes for
contradictory cleanup flags and defensive-copy isolation. Gateway root URLs with
a trailing slash now project to canonical origins; query/auth/path inputs remain
rejected. Two older fixtures had inconsistent creation/provider deadlines; their
dates were corrected without relaxing the control validator or retention limits.

Full suite before the fifth added test: **381 passed, four expected unresolved
regression failures, seven PostgreSQL skips**; report
`../vt00-c4-evidence/memory-control-final.json`, SHA-256
`9da2582ba7f9c88cc15cd3bb9db8b2ecdc28ab80f854cb46758ed58a9d6c6faa`.
Final focused five-case report: **one passed, four still failing**,
`../vt00-c4-evidence/memory-control-causal.json`, SHA-256
`700ceab23e5302eea0b0b637958836816c5a715cecd3f846890aecb6b50eb3c3`.
TypeScript/diff checks pass. PostgreSQL has not received this control model;
`listRecoveryControls` is presently memory-only, not on the shared ledger
interface. Worker post-purge capability issuance, D02 control proof, settlement
CAS, pagination/fairness, eventual control retirement and production migration
are still required. This is test-ledger implementation evidence, not durable
database or production cleanup proof. No deployment or official P01 attempt.

### Post-retention settlement CAS implementation

The preceding continuation made progress preserving test-ledger allocation
authority. Added an internal memory-ledger settlement operation for purged
controls. It validates a canonical, HTTP-200, exact test/cleanup-bound durable
Gateway receipt, live-zero declarations, terminal component statuses and complete
Builder discovery before mutation. It refuses any outstanding browser lease,
requires the expected control version, accepts only an exact prior-version replay,
and stores event/receipt hashes rather than response content. Live cleanup and
remote purge settle separately and monotonically. Confirmed remote purge updates
the existing keyed owner-facing tombstone without extending its expiry. Retained
control is never authorization for a new browser allocation; memory lease upsert
now requires an extant raw run, matching the existing PostgreSQL foreign key.

Tests cover stale nonidentical receipts, exact replay, foreign run/obligation,
wrong source, pending provider, missing Builder zero/durable receipt, wrong-worker
lease release, split live/purge completion and no content resurrection. Gateway
defines terminal statuses `completed`, `already_terminal`, `not_found`; all three
are tested, but absence is accepted only inside its exact-bound durable live-zero
receipt, never from local deletion. The internal operation still relies on the
worker's authenticated Gateway transport; it is not an exposed caller tool or a
cryptographic verifier of arbitrary client claims.

Full suite before the final vocabulary matrix: **391 passed, four known unresolved
worker-recovery failures, seven PostgreSQL skips**, report
`../vt00-c4-evidence/recovery-settlement-final.json`, SHA-256
`12bfa6b2e952b11f9e635d4a486020e7131e0d87d4519c38cef1e56c747ce8ea`.
Final control/settlement matrix: **27 passed**, report
`../vt00-c4-evidence/recovery-settlement-vocabulary.json`, SHA-256
`4ed2b55df25df4138c4533bea0ce6826af2ff9c03a86d8b5355e906021bceb35`.
TypeScript and diff checks pass. PostgreSQL persistence/transactional CAS, shared
ledger API, worker control discovery/capability issuance, D02 source independence,
fair scheduling and eventual safe retirement remain unfinished. No deployment,
production resource settlement, or official P01 attempt occurred.

### Staged PostgreSQL recovery-control adapter

The previous turn made progress on memory settlement CAS. Added staged
`migrations/004_recovery_controls.sql` and `src/postgres-recovery-control.ts`.
The table is independent of raw runs, with unique run/test/cleanup identities,
bounded binding JSON and complete-or-absent settlement hashes. SQL CHECKs use
`IS TRUE` so missing JSON fields or partial NULL settlement cannot exploit
PostgreSQL three-valued constraint semantics. Public access is revoked. The
adapter validates decoded bindings and identifiers, locks the control row and
any remaining browser lease, performs versioned settlement, and atomically updates
the owner tombstone. No runtime DDL is used.

**Three real PostgreSQL 18.6 tests passed**: concurrent identical settlement plus
replay through a separate pool, conflicting concurrent settlement/foreign-proof
rollback, and SQL rejection of missing identity/partial settlement. Report
`../vt00-c4-evidence/postgres-control-20260913-v2.json`, SHA-256
`f7234fdbe854b7da9fed91c720c2ff24d5c226d9aa418ebd9770f61ac27261fe`.
TypeScript and diff checks pass. This is actual database transaction evidence,
not a process-restart campaign, sealed release migration, or production proof.

Testing used a newly initialized loopback-only cluster inside the previously
stopped `mem00-qualification` VM: `/tmp/sophia-c4-controls.j4qXdIMq/data`, port
16432, exact database `voice_lab_test_c4_control_20260913`. The old /tmp cluster
was absent after VM restart. Initial startup failed because the default socket
directory was unwritable; the logged cause was corrected by using the task-owned
socket directory, without changing system permissions. Initial failure report
is preserved. After tests: schema count zero, other database connections zero,
PostgreSQL stopped, exact SSH forward cancelled, VM confirmed Stopped. The other
`mem00-qualification24` VM was not modified. Synthetic test schema was removed;
no user data was deleted. Stopped temporary cluster files remain disposable.

The new migration is deliberately **not wired** into `src/bin/migrate.ts` or the
sealed migration hash/catalog. The adapter is likewise not yet called by
`PostgresVoiceLabLedger`. Next complete exact-release migration composition,
backfill/validation, browser-lease FK ownership, atomic admission/control writes,
quota parity and worker post-purge recovery. Do not manually apply the staged SQL
to production or treat this adapter as deployed. The four worker-recovery
regressions remain open. No official P01 attempt occurred.

### Schema v4 fresh-install migration wiring

The previous turn made progress with PostgreSQL CAS tests. The migration runner
now composes the preserved, individually checksum-pinned v3 baseline and recovery
extension into one transaction, verifies the composite release hash and constructs
the independent reference catalog from that exact bundle. Schema v4 adds the
control table to the attested table set and uses its own local seal path. Exact
reruns skip DDL after full preflight, avoiding non-idempotent extension replay
without allowing `IF NOT EXISTS` to conceal drift. Docker now includes the pinned
extension. The existing schema advisory-lock key is intentionally shared with old
migrators. No baseline backend SQL bytes were rewritten.

Composite migration SHA-256:
`187eb4c875df9e27cdb7bd72d099e5b7cbc4bc2f41964a19595d16c858bc5bec`.
Extension SHA-256:
`e0a8e9121433ebf60936b0c45bac0aa454edff33ee770689a6f50563b39a531e`.
Fourteen schema/migration unit tests pass (including one-byte mutation rejection
for each source and exactly one transaction envelope). Seven real PostgreSQL
integration tests pass, including concurrent migration processes, exact reruns,
ownership/ACL/column/index drift rejection and P01 ledger boundaries. A new setup
negative test constructs the actual baseline v3 catalog with an outstanding run:
v4 refuses it before extension DDL, preserves the exact cleanup binding and leaves
the original catalog unchanged. This refusal remains intentional only while the
required transactional backfill is unfinished; it is **not** the final upgrade
solution or permission to discard the historical database.

PostgreSQL report `../vt00-c4-evidence/migration-v4-postgres-refusal.json`, SHA-256
`ffb9a532b41cb1376a08319e34278a8534122bd3db7678314a4be12ff1a4815b`.
TypeScript/diff checks pass. Isolated cluster `/tmp/sophia-c4-migration.y8wRCBlq/data`
used exact database `voice_lab_test_c4_migration_20260913` on loopback16432 in
`mem00-qualification`; after tests, target/reference schema count and other
connections were both zero. PostgreSQL was stopped, the exact forward cancelled,
and the VM stopped. Other VM unchanged. Only synthetic test schemas were removed.

Outstanding: populated-v3 upgrade/backfill, PostgreSQL admission/control-write and
quota parity, browser-lease FK transition, worker post-purge discovery and exact
D02 capability binding, retirement/fairness and production proof. The four worker
recovery regressions remain unresolved. Do not deploy this candidate over v3.
No production mutation or official P01 attempt occurred.

## PostgreSQL control/admission parity — 2026-09-13 09:58Z

Continued local recovery work; automation deletion again returned not_found (already
absent). Spending/resource limits remain unchanged. No production mutation or
official P01 attempt occurred.

PostgreSQL now creates the immutable recovery control atomically with admission,
mirrors lifecycle versions, counts orphan unresolved controls against admission,
preserves browser leases through the v4 control foreign key during content purge,
refuses new leases after raw-run removal, and retains caller-key coverage for controls.
The shared ledger API exposes control inventory and proof-bound settlement.

Real isolated PostgreSQL 18.6 integration: **8/8 passed**, including purge -> lease
survival -> quota rejection -> exact lease release -> durable settlement. The first
two attempts caught a nested test definition and an unsupported artifact fixture;
both were corrected without relaxing production constraints. The key-retirement
test now requires rejection while a recovery control still references that key.
Report `pg-wiring-postgres-v3.json` SHA256
`4f05def78187e8f29415b121c3df75880b403f3d93deae0190051522002667da`.
TypeScript compilation passed. Earlier full local report: 393 passed, four known
worker recovery failures, ten skipped PostgreSQL cases (before correcting test
collection). This is not a green full suite or production certification.

Dedicated test database `voice_lab_test_c4_pgwiring_20260913` finished with zero
test schemas and zero other connections. PostgreSQL stopped, exact SSH forward
cancelled, and task VM stopped; the other qualification VM was not changed.
Populated-v3 backfill, worker post-purge discovery/D02 binding, control retirement
and fairness, and all deployed qualification requirements remain outstanding.
Do not deploy this candidate over the existing v3 database yet.

## Recovery inventory traversal — 2026-09-13 10:02Z

Previous turn classified as progress (real PostgreSQL control/admission proof).
Inspected worker maintenance: it still selects expiring raw runs and reconstructs
D02 capability ownership from retained `harness.browser_context_bound` events.
Post-purge control discovery alone therefore cannot safely authorize recovery.
The release-blocking four regressions remain ordinary failing assertions.

Implemented strict UUID keyset pagination on the shared recovery-control API in
both ledgers. Memory now uses the same deterministic UUID ordering as PostgreSQL.
Unresolved first-page records no longer prevent a caller from traversing later
pages; settling an earlier row does not shift an offset and skip work. Malformed
cursors reject before database query; uppercase UUID cursors normalize.
This is an inventory primitive, not a claim of a completed fair worker scheduler.
A worker must persist/advance its bounded scan and wrap after exhaustion; durable
post-purge authorization, D02 binding/freeze/dispatch controls and authoritative
browser-owner-loss settlement remain required before that path can go live.

Focused local tests **32/32 passed**, report `recovery-inventory.json`, SHA256
`8b3e118ab3e0b7be8b1a536c161d44a5e649d2328f013b27a45fae23074fa736`.
Real PostgreSQL control tests **4/4 passed**, including 25 obligations paged during
concurrent inventory mutation, report `recovery-inventory-postgres.json`, SHA256
`a532c6fec07a5c96b927f106499c4b153530743773d524aa7f42516b2badbe83`.
TypeScript and `git diff --check` passed. No schema/checksum changes this turn.
Dedicated `voice_lab_test_c4_control_inventory_20260913` ended with zero test
schemas/other connections; PostgreSQL stopped and exact SSH forward cancelled.
Task VM shut down; other qualification VM untouched. No production mutation,
official P01 attempt, safety-limit change, or new automation.

## Durable D02 browser binding — 2026-09-13 10:08Z

Previous turn classified as progress (keyset inventory verified in both ledgers).
Added a bounded hash-only browser ownership projection to recovery controls.
The worker persists the successful driver's exact D02 attestation before the
retained binding event; both ledger implementations require an existing raw run,
the current unexpired worker/lease epoch, exact deterministic allocation hash,
and immutable replay. PostgreSQL locks run -> control -> lease, matching existing
allocation/retention order. Binding creation is forbidden after content purge.
The existing worker resolver prefers this independent control binding and still
rejects conflict with its active lease. Legacy retained-event validation now
checks the deterministic context allocation, not merely hash syntax.

This does NOT yet close allocation-before-driver-attestation crash boundaries,
post-purge capability/audit dispatch, owner-loss settlement, D02 freeze/dispatch
control retention, or populated-v3 backfill. Four original worker-discovery
regressions remain failing and unmodified. Do not deploy over v3.

Candidate v4 extension hash is now
`9d4d968da3af83ae664a336fb4697b37826f8df58a8f0e324706d723b1fb0ac1`;
compiled composite migration hash
`fff2aa299de6a51951e94d6e0ede2003e1573c27140fdc4bcd7e5a682e1a7532`.
Baseline migration remains untouched. Real PostgreSQL tests **9/9 passed**,
including concurrent idempotent binding, foreign lease/corrupt context rejection,
content purge survival, fresh schema attestation and populated-v3 refusal.
Report `recovery-d02-postgres.json` SHA256
`848d77115d7060b7f13c449a3c1669d3c3342d4c55e7a65391f045efc58df71f`.
Full local suite **406 passed / 4 known recovery failures / 12 PG skips** before
the additional PG test was added; report `recovery-d02-full-local.json` SHA256
`4014c4e7490c9fee6805cd45bc09ef54da0810f7de0ab85491db67e494de2e14`.
Focused binding/schema report `recovery-d02-binding.json` SHA256
`38adbe59142161acea5a250be00ada58b045eaf48ee54783ece9f44b79fb18df`.
TypeScript and diff whitespace checks passed.

Dedicated `voice_lab_test_c4_d02binding_20260913` finished with zero test schemas
and zero other connections. PostgreSQL stopped, exact SSH forward cancelled,
task VM stopped; other VM unchanged. No production mutation, P01 attempt,
password or safety-budget change, or new automation.

## Pre-driver D02 allocation durability — 2026-09-13 10:14Z

Previous turn classified as progress (durable driver-attested ownership).
Closed the earlier persistence gap by reserving `browserAllocationBinding`
atomically with the D02 browser lease. This hash-only allocation intent is
distinct from `browserContextBinding` (successful driver attestation). The
existing deterministic allocation algorithm is now shared by worker and ledgers.
An attestation must match the prior intent; a second allocation for the same D02
run is refused even after lease release/reaping. Recovery resolution can use
the original intent without claiming readiness, attestation, or cleanup success.

Memory causal test reserves -> loses lease before driver attestation -> refuses
replacement -> purges content -> retains exact allocation and unresolved quota.
Real PostgreSQL checks verify reservation visibility and rollback of duplicate
allocation, then exact attestation/purge survival. Full transaction-crash injection
and worker-level post-purge execution remain to prove. This is not final recovery.

Initial full local run: 405 passed, four original recovery failures plus two
fixtures that attempted now-forbidden D02 replacement, 13 PG skips. Updated those
fixtures to assert replacement rejection and deliberately inject an inconsistent
ownership read, preserving stale-command/continuity rejection coverage.
Combined focused checks **36/36 passed**, including **9 PostgreSQL tests**;
`recovery-allocation-postgres.json` SHA256
`c7de9eba642c181641d31cb3919995b57c1985eb682bab31c8f5601fe5b26b84`.
TypeScript and diff whitespace checks passed. Original four post-purge discovery
regressions remain unmodified and unresolved; full suite not certified.

Current extension SHA256
`e0fcd28ad564cdca488c3a758d2e9c91868e65c42be474d4ccbb29fb42251feb`;
compiled composite
`61ef064995536516c59b727389d028dbe74d4c4cccc613b54c58f42a59d512b1`.
Populated-v3 upgrade remains forbidden pending complete backfill.
Dedicated `voice_lab_test_c4_allocation_20260913` ended with zero test schemas and
zero other connections. PostgreSQL stopped, exact forwarding cancelled, task VM
stopped; other VM untouched. No production mutation, P01 attempt, credential,
safety-limit or automation change.

## Expired owner heartbeat fence — 2026-09-13 10:18Z

Previous turn classified as progress (atomic D02 allocation intent). A new causal
boundary matrix reproduced lease resurrection: heartbeats at/after the exact
deadline previously succeeded. Both ledgers now require an unexpired exact-owner
lease. Rejected heartbeats leave the original record untouched for recovery.
PostgreSQL renewal and default reaping use `clock_timestamp()`; production reaping
no longer relies on worker/DB clock agreement. The explicit clock argument remains
available for deterministic tests. Reaping is still not authoritative cleanup.

Full local report: **410 passed / 4 original recovery failures / 14 PG skips**,
`browser-lease-expiry-local.json` SHA256
`9ea830fe5439ffc544b482cf88c0c22cbbeb862788c87ed890948b4662f59796`.
Real PostgreSQL integration **10/10 passed**, including live/foreign/expired
heartbeats, preservation before reaping, post-reap rejection and durable control
survival. Report `browser-lease-expiry-postgres-v3.json` SHA256
`e670e11819b5f54b9625e0b366e12765f2e69316cbce04cef949c5b8a25fcc83`.
Earlier PG attempts exposed host/VM clock assumptions and a pending test-only
start operation; fixture now cancels its own dispatch and default production
reaping uses the owning database clock. All before/after reports retained.
TypeScript passed. No schema/checksum changes this turn.

Dedicated `voice_lab_test_c4_leaseexpiry_20260913` ended with zero test schemas and
zero other connections. PostgreSQL stopped, exact forward cancelled and task VM
stopped; other VM unchanged. Four post-purge worker discovery failures remain,
along with dispatch/audit, owner-loss/freeze controls and broader VT00 obligations.
No production mutation, P01 attempt, credential, budget or automation changes.

## Strict recovery outcome vocabulary — 2026-09-13 10:23Z

Previous turn classified as progress (lease resurrection fixed and PG verified).
Traced generic recovery transport and execution-epoch release proof. Remaining
critical obligation: absence of a lease/acquisition event is not a process-death
receipt. Durable recovery dispatch must not infer browser zero from retained
content being absent; execution ownership and death receipts still need independent
control retention and owner-loss reconciliation.

Found and fixed a separate false-success path: driver recovery accepted any string
outside a short failure denylist as a terminal canonical/provider/auth status.
It now shares the exact `completed` / `already_terminal` / `not_found` predicate
with durable settlement. Worker component verdict projection uses the same
predicate and requires canonical-source recovery; Builder remains completed-only.
Retention-purged output now additionally requires exact-bound live cleanup, so a
foreign cleanup identity or unknown component status cannot certify deletion.

Three causal test cases (seven bad values across each of three components)
reproduced false success before repair. Red report SHA256
`3def54d3d9b0b06a1be91380bd924981fff11ed0c7346abe7b4b92780739007a`
(`recovery-status-red.json`). Full local verification **413 passed / 4 original
recovery failures / 14 PG skips**, report `recovery-status-local-v2.json`, SHA256
`720609be933fcc57ec75956f6327fa9debf8279af84ab8ae6dd1731e973116b0`.
TypeScript and diff whitespace checks passed. No schema change, VM startup,
production mutation, official P01, credential/budget/automation change this turn.
Goal remains unachieved; all broader deployment/journey/certification obligations
and four worker discovery regressions remain open.

## Missing process proof is not zero — 2026-09-13 10:25Z

Previous turn classified as progress (strict recovery outcome vocabulary).
Reproduced an unsafe proof derivation: an empty acquisition event set previously
returned required=false/ready=true with reason browser_process_not_allocated.
It now returns required=true/ready=false/process_acquisition_evidence_missing.
Pre-resource nonallocation must use its separate positive admission/allocation
authority; it cannot be inferred from absent retained evidence.

One old startup-failure fixture navigates to voice startup but provides neither
process ownership nor death proof. Its expectation now requires cleanup=false,
preserved browser lease and a complete failure manifest reporting the missing
proof. Manifest `gateway_live_resources_zero` preserves the Gateway claim;
`live_execution_resources_zero` additionally requires browser closure, lease
release and zero owned tasks. This prevents a backend-only receipt from claiming
all execution resources are gone.

Full local **413 passed / 4 original recovery failures / 14 PG skips**, report
`missing-process-proof-local-v2.json`, SHA256
`92b669b3b18fc4686e78573d1104c1383a75c5d3f2a83b19517fa26fd0603497`.
Before/after proof reports retained. TypeScript and diff whitespace checks passed.
No schema, VM, production, P01, credential, budget or automation changes.

Next required boundary: the lease-absent/reaped branch still needs an independent
all-scenario allocation history and positive process-death/nonallocation proof.
Currently only D02 allocation intent is retained; generic process ownership/death
and D02 freeze/dispatch controls must survive retention before recovery can be
certified. Do not interpret this local repair as completion of durable recovery.

## All-scenario allocation history — 2026-09-13 10:30Z

Previous turn classified as progress (missing process evidence no longer passes).
Recovery controls now retain monotonic `browserAllocationEver` for every scenario.
Creation initializes false; lease allocation changes it to true in the same
transaction; updates, release, reaping and content purge preserve it. PostgreSQL
decoding rejects missing/nonboolean history. Populated-v3 history must be
backfilled from authoritative evidence, never defaulted to false during upgrade.

The worker's lease-absent path now consults this control: previously allocated
runs require a valid execution-epoch cleanup proof and no local driver session.
A replacement-worker regression reaps the old lease, supplies Gateway cleanup,
and verifies cleanup remains false with no lease-absence success event.
This is not full independent process ownership/death retention; that projection,
post-purge dispatch/audit, D02 freeze/dispatch and v3 backfill remain outstanding.

Full local **413 passed / 4 original recovery failures / 14 PG skips** before the
additional replacement-worker assertion. Focused worker/ledger **60/60 passed**,
`allocation-history-worker.json` SHA256
`70938e99b15c81cf1a306e4dd4d9c1a6926f79633626fae96afad287768db6ea`.
Real PostgreSQL **10/10 passed**, `allocation-history-postgres.json` SHA256
`d517888380e37d21fd3c88bc12a4c2a6ac54abf30b22cb16fd761cad21be44cf`.
TypeScript and diff whitespace checks passed.
Current extension hash
`2a8404ceeac5f0e2e9c056c18c9214a7a09dbea2a208aa7f745b13edb40bd63d`;
compiled composite
`9c9bc5e570c7f3479787de8ef8105310e7ed06e7afface18a34d82cf9db42031`.

Dedicated `voice_lab_test_c4_history_20260913` ended with zero test schemas/other
connections. PostgreSQL stopped, exact forward cancelled, task VM stopped; other
VM unchanged. No production, P01, credential, safety-budget or automation changes.

## Independent execution cleanup proof — 2026-09-13 10:37Z

Previous turn classified as progress (all-scenario allocation history and
replacement-worker false-zero rejection). Extracted the existing execution-epoch
proof derivation into `execution-cleanup.ts`, preserving worker exports and using
the same implementation in both ledgers. No second runtime or alternate proof
recipe was added. The shared derivative accepts only the exact run/test/cleanup
identity inputs it actually needs.

`preserveRecoveryExecutionCleanup` derives from ledger-owned events under the
run/control/lease lock ordering, rejects incomplete proof or conflicting current
lease, and immutably saves only validated bounded proof metadata. It does not
accept caller-supplied success claims/event bodies. Worker saves it before exact
lease release. Raw content purge retains the proof; proof creation after purge is
rejected. Process death before this write, independent owner-loss proof and
post-purge dispatch/settlement consumption remain to implement and prove.

Shared memory/PostgreSQL causal fixture rejects incomplete evidence, accepts the
full exact-owner process/provider/auth chain, replays unchanged, excludes unrelated
content/raw worker identity, and proves survival after content deletion.
Full local **414 passed / 4 original recovery failures / 15 PG skips**, report
`execution-proof-full-local.json`, SHA256
`46804c808cafe4da52d6e74d70cda189fe355370cd109e0e92e5fad9e899dfc8`.
Real PostgreSQL **11/11 passed**, `execution-proof-postgres.json`, SHA256
`d304feeb36107bac1d34aaa7cbc8c39c5e99bc62239cdb086dee3481505cfec3`.
TypeScript and diff whitespace checks passed.
Extension hash `a35d485a662c74358adbcbb58026b7c25f12696dbed649aec64504a9a2733b58`;
compiled composite `76e186876afcfaec8227045210df1aa367db5d0f02c1ff8f728574226e4a4ca4`.
Baseline SQL remains untouched; populated-v3 backfill still required before deploy.

Dedicated `voice_lab_test_c4_executionproof_20260913` ended with zero test schemas
and zero other connections. PostgreSQL stopped, exact forwarding cancelled, task
VM stopped; other VM unchanged. No production/P01/credential/budget/automation
changes. The full VT00 promotion objective remains unachieved.

## Enforced post-retention process proof — 2026-09-13 10:40Z

Previous turn classified as progress (independent execution proof persistence).
Reproduced a direct settlement gap: a Gateway receipt plus deleted lease could
settle an allocated run without process cleanup. Both ledgers now require the
preserved execution-cleanup proof whenever browserAllocationEver is not false.
Absent live lease remains independently required. No process proof is inferred
from elapsed TTL, lease reaping, Gateway success or missing content.

Positive settlement fixtures now explicitly persist the exact validated execution
chain before retention purge. Negative memory and PostgreSQL cases keep valid
Gateway receipts and absent leases but omit the process proof, and verify typed
RECOVERY_EXECUTION_UNCONFIRMED without version or cleanup mutation.
Full local **415 passed / 4 original recovery failures**, report
`settlement-process-proof-local.json`. Before-fix regression retained in
`settlement-process-proof-red.json`. Real PostgreSQL **16/16 passed** (11 main
adapter cases and five control cases), report `settlement-process-proof-postgres.json`,
SHA256 `453fcae8ad50e96c987ef129f7ce1df77ebdb84c9b29520c5dfebe6971cc341f`.
TypeScript and diff whitespace checks passed. No schema/checksum change this turn.

Both dedicated settlementproof databases ended with zero test schemas and zero
other connections. PostgreSQL stopped, exact forwarding cancelled and task VM
stopped; other VM unchanged. No production, P01, credential, safety-budget or
automation change. Post-retention recovery dispatch/audit and independent
owner-loss proof still remain; four original regressions remain unmodified.

## Post-retention worker recovery verification — 2026-09-13

Previous turn classified as progress: independent process-proof enforcement.
Worker maintenance now paginates retained recovery controls after raw content
deletion. It records a durable bounded authorization audit before dispatch,
uses original immutable recovery identity and provider deadline, and does not
start a browser or extend provider lifetime. Settlement still requires exact
Gateway receipts, absence of a browser lease and preserved execution cleanup
proof for any previously allocated execution.

Worker tests cover normal and D02 retained recovery, missing process proof,
audit-write failure preventing dispatch, a remaining owned lease, and cross-run
receipt rejection. Original retention regressions now assert the independent
control inventory actually consumed by maintenance, rather than deleted raw runs.
Full local report `retained-recovery-full-local-v2.json`: **425 passed, 0 failed,
16 pending database tests**. SHA256:
`8dd00540fef78c7c1fb8c5a666985961101b55bdb7ac6c67f704faea291d82a0`.
TypeScript and diff whitespace checks pass. This invocation did not rerun the
real PostgreSQL suite; new retained authorization-audit integration still needs
database-backed verification. Restart fairness, owner-loss boundaries and v3
upgrade/backfill remain incomplete. No production test, deployment, credential
or budget change occurred. Automation deletion again returned `not_found` for
`resume-sophia-ah-voice-test`; no replacement automation was created.

## Retained authorization audit — real PostgreSQL verification

Previous goal turn classified as progress: full local retained-recovery suite
verified. Added database-backed tests proving that the content-free recovery
authorization audit is committed and visible from an independent connection,
retains the original caller partition without raw run identifiers, and leaves
the recovery control version unchanged. Stale-version, pre-purge and malformed
digest attempts are rejected without inserting an audit row.

PostgreSQL 18.6 adapter/control suite: **18 passed, zero failed or skipped**.
Report `retained-audit-postgres.json`, SHA256
`01eb9b0527c2c1de90c9db8b00fedc66016995cf1a80d6b0a0e0855d216e1875`.
TypeScript and whitespace checks passed. Both dedicated test databases ended
with zero test schemas and zero other connections. This establishes database
audit durability, not a complete deployed recovery or voice qualification.
No production calls, official P01 attempts, passwords, budgets or gates changed.
Restart fairness, independent owner-loss proof and populated-v3 upgrade remain
next recovery requirements before deployment qualification.

## Owner-loss deployment binding — causal regression and repair

Previous turn classified as progress: real PostgreSQL authorization durability.
Inspection found that raw-run recovery inferred zero allocation from absent
session identifiers and an absent lease. A worker crash before identifier
publication followed by lease reaping therefore rebound recovery to the current
deployment despite a durable earlier allocation. Reproduced the wrong identity
in `owner-loss-rebinding-red.json` before changing the worker.

Recovery runtime rebinding now additionally requires the independent control's
`browserAllocationEver === false`. Allocated history and unavailable legacy
control data retain the original release; lease expiry cannot certify zero
allocation. Tests cover proven never-allocated history, lost allocated lease,
and missing control data. Full local **427 passed, zero failed, 18 database tests
pending** in `owner-loss-rebinding-local-v2.json`, SHA256
`2674965befcd3f06dbb5f2f8112e8916907b04745b67035d83abb6dabb0ed1df`.
TypeScript and whitespace checks passed. No schema changes or production calls.
Independent process-death evidence after owner loss remains unimplemented; this
fix prevents identity drift but is not a complete owner-loss settlement proof.

## Early process acquisition durability

Previous turn classified as progress: owner-loss deployment binding repaired.
The existing driver previously returned process ownership only after successful
voice startup. It now awaits a worker acquisition callback immediately after
launch and before context/auth/provider activity. The worker fences its operation
and atomically appends exact process ownership plus worker/lease/runtime identity.
The actual owned Chromium version is used, not a separate readiness browser.
Successful startup reuses the same process-event dedupe key and does not append
a second runtime acquisition. Legacy driver doubles retain the prior fallback.

Driver boundary tests verify callback ordering and failed-write shutdown before
context allocation. Full local **429 passed, zero failed, 18 database tests
pending**, report `early-process-acquisition-local-v2.json`, SHA256
`40adf07c0f18b67ece492d37a24e8c5479e9397f048754a9c18b7a1d6fe96a40`.
The first test invocation exposed an incomplete synthetic browser close double;
its report is retained as `early-process-acquisition-local.json` and is not an
official production failure. This is early event durability only: independent
content-free ownership retention and external process-death proof remain needed.
No production, migration, password, budget or gate changes occurred.

## Content-independent execution ownership

Previous turn classified as progress: early acquisition event durability.
Added a strict, digest-checked ownership projection containing only exact
run/cleanup/process/boot/execution/worker hashes, lease epoch and source sequence
numbers. Both ledgers derive it from their own acquisition events under the
exact live allocation lease, persist immutable replay-safe ownership before
the driver proceeds, and preserve it independently of raw content. Unknown
fields, changed digest, foreign binding, duplicate acquisition and reversed
event order are rejected. It is explicitly not process-death or zero proof.

The staged extension gains `execution_ownership`; baseline SQL is unchanged.
Extension SHA256 `28af328b7c9fbd36ab85d5253b8e2502a664d144614821a5d56dbd1bad11f6b7`;
composite migration SHA256 `16a387dc39720f74d40c2555f7e95eab27f91be8e17448afa173b200013e213a`.
Existing-v3 migration remains refused until the separate backfill is implemented.

Full local **431 passed, zero failed, 18 database tests pending**, report
`independent-ownership-local.json`, SHA256
`6ca7062d10c4979947e552e7d106bff9b23c08fb423a37f4a8369b6fe710ad88`.
Real PostgreSQL **18/18 passed**, including ownership replay and retention
survival in the shared adapter fixture, report `independent-ownership-postgres.json`,
SHA256 `991f44c05cbbc787a3963c7f8e56ff1868942044c4c3ebd309ae59b20317b995`.
TypeScript and whitespace checks passed. Dedicated databases ended with zero
test schemas/other connections; PostgreSQL stopped and forwarding cancelled.
No production, credential, budget or gate changes. Independent process-death
authority and crash windows before acquisition persistence remain unresolved.

## All-scenario allocation-once fence

Previous turn classified as progress: independent ownership retained. The existing
deployment-controller worker-loss authority is D02-specific and cannot simply
be relabeled generic process-death proof. Tracing its allocator uncovered an
all-scenario gap: non-D02 runs could reserve a new browser after lease deletion,
including epoch reuse after reaping. Reproduced in `allocation-once-red.json`.
Both ledgers now require the independent monotonic allocation flag to be exactly
false before reserving a browser. Neither release nor reaping permits another
execution for the same run. Heartbeat remains the renewal path.

Shared memory/PostgreSQL matrix covers V-A01, V-N01 and V-D02, release and reap,
and original/replacement worker attempts, with unchanged control and absent lease
after each refusal. Full local **432 passed, 19 database tests pending**, report
`allocation-once-local.json`, SHA256
`1cccd018e1ced37a66b19ece4f4ad2ee3336882236c2bff8a1a70834ea636d20`.
The initial PostgreSQL run exposed queued synthetic fixture operations interfering
with later P01 boundary tests; those fixture operations are now cancelled.
Re-run **12/12 PostgreSQL adapter tests passed**, report
`allocation-once-postgres-v2.json`, SHA256
`596d529853a2e07be981ed5c207cc53458a387f2a9bfce8b17681fabde3e6f73`.
No failed report removed. TypeScript and whitespace checks passed before the
fixture-isolation adjustment. Dedicated database ended with zero test schemas
and other connections, PostgreSQL stopped and forwarding cancelled. No schema,
production, password, budget or gate change. Independent generic process-death
authority, retained D02 control inputs and populated-v3 upgrade remain incomplete.

## Historical backfill assessment foundation

Previous turn classified as progress: allocation-once fence. Inspected the
checksum-pinned migration and v3 storage. The old retention tombstones contain
only keyed identities, so missing historical raw rows cannot be reconstructed
or treated as nonallocation. Added a read-only per-run assessment for the
future transactional backfill. It uses original binding and positive allocation
evidence, derives ownership/cleanup from existing validators, ignores cached
cleanup flags, and requires an exact Gateway receipt after process closure for
live-zero projection. It returns only hashed typed rejection details when
identity/history is invalid or allocation is unknown. D02 assessment remains
explicitly unavailable until independent freeze/dispatch controls are supported.

Five assessment tests pass, including input immutability and no private-ID
leakage. Full local **437 passed, zero failed, 19 database tests pending**, report
`backfill-assessment-full-local.json`, SHA256
`7fb9185d5e4e122368d0b45644b0a4b7634ca4cee4c4bfb3b08dad9321386f60`.
TypeScript passed before the final receipt-order guard; whitespace checked.
This module is not yet wired to a transactional upgrade or database inventory.
No schema bytes, migration behavior, production, credentials, budgets or gates
changed. v3 upgrade refusal remains intact, and the broader promotion is unproven.

## Consistent read-only v3 inventory

Previous turn classified as progress: backfill assessment foundation. Added a
database inventory using one REPEATABLE READ, READ ONLY transaction, bounded run
and relevant-event enumeration, exact v3 migration metadata, and content-free
counts/hash projections. It includes retained tombstones even when raw recovery
identities have been erased. Any event/run cutoff reports incomplete enumeration;
unknown allocation and D02 history retain typed reconciliation requirements.
The report always states upgradeAuthorized=false; no catalog equivalence,
quiescence, external-resource zero or upgrade authorization is inferred.

Real PostgreSQL populated-v3 test checks unknown allocation, an unconfirmed
tombstone, unchanged historical rows, private-identifier exclusion, and an
event-bound cutoff. Main adapter suite **12/12 passed**, report
`backfill-inventory-postgres-v2.json`, SHA256
`89b6c94527b674ee2335d295148eb3b3b678a117038848fbdbdb600bc0824e7e`.
TypeScript and whitespace checks passed before the final boundary assertion.
Dedicated database ended with zero test schemas and other connections;
PostgreSQL stopped and forwarding cancelled. No production inventory or upgrade
has run. CLI wiring, full historical reconciliation and transactional migration
are still required; existing v3 upgrade refusal remains intact.

## Runnable historical inventory diagnostic

Previous turn classified as progress: consistent read-only database inventory.
Added `src/bin/recovery-inventory.ts`, using the existing caller-partition parser
and configured database/key-ring environment, with no command-line credential
arguments or test-secret fallback. The command never invokes migration or a
worker and prints only the content-free inventory report. It exits 2 on bounded
incomplete enumeration, 1 with fixed sanitized diagnostics on failure, and 0 for
a completed inventory (not an upgrade approval). README documents the compiled
command and its limits.

Four real subprocess tests verify missing database, wrong URL scheme, missing
key ring even under NODE_ENV=test, and malformed key configuration without
leaking supplied values. Full local **441 passed, zero failed, 19 database tests
pending**, report `inventory-cli-local.json`, SHA256
`4bdeb34e5e4466e1364269058dfabf89742622ead7b526df96966c4c590b6fd8`.
TypeScript and whitespace checks passed. The underlying successful database
inventory was verified in the prior PostgreSQL turn; the new CLI's successful
database invocation and production inventory remain to be verified. No schema,
production, credentials, budget, gates or automation changed.

## Successful CLI inventory and installed-plugin recheck

Previous turn classified as progress: runnable diagnostic and sanitized failures.
Added a real subprocess invocation against the populated v3 database fixture.
The command exits successfully with the same content-free entries and counts as
the direct read-only assessment; surrounding assertions verify historical rows
and tombstones remain unchanged. Main PostgreSQL adapter suite **12/12 passed**,
report `inventory-cli-postgres.json`, SHA256
`020c861eedaf688e3d4a973f551a5972a9ad046b05cb4b7d30b57c8a7878ae90`.
TypeScript and whitespace checks passed. Test database ended with zero schemas
and other connections; PostgreSQL stopped and forwarding cancelled.

Fresh installed `get_capabilities` returned UNAUTHORIZED with
`oauth_token_invalid_grant` / TRIGGER_REAUTHENTICATION. No voice run was started,
no official P01 attempt added, and no raw/direct live-test bypass used. Available
tools expose no dedicated reauthentication call. Reauthentication remains a live
test prerequisite, while local migration/recovery work can continue. Production
inventory, transactional upgrade, independent death proof and promotion are not
complete. No production, credentials, budget or gates changed.

## Staged transactional recovery upgrade

Previous turn classified as progress: successful inventory CLI and live plugin
authentication recheck. Added `upgradeHistoricalRecovery`, deliberately separate
from automatic migration/startup. The future deployment controller must supply
independently derived v3/v4 reference catalog hashes and establish closed gates
and stopped old services. The primitive verifies the extension checksum, locks
the old tables under the existing migration advisory key, refuses source drift,
recent worker activity, pending operations, erased history, unknown allocation,
D02 incomplete history and bounded-scan overflow. It builds every control before
DDL, inserts backfill before transferring browser-lease foreign keys, then checks
the v4 catalog and updates metadata in the same transaction. No host seal or
external gate changes occur.

Real PostgreSQL tests refuse tombstones, unknown history and recent workers;
force a post-DDL catalog failure and prove the table/catalog rolled back; then
upgrade a known lost allocation and compare run, event and lease rows unchanged.
Main adapter suite **12/12 passed**, report `recovery-upgrade-postgres.json`,
SHA256 `3e7899d9c81ba7f2962698af71c761a0fa6fe1195e2725be7a86c8e22c463942`.
TypeScript and whitespace checks passed. Test database ended with zero schemas
and other connections; PostgreSQL stopped and forwarding cancelled. Production
startup still refuses v3. This is not a deployment-ready full upgrade: controller
wiring, historical/D02 reconciliation, reference attestation and operational
closeout remain required. No production migration, password or budget changes.

## Admission respects unresolved controls before content expiry

Previous turn classified as progress: transactional upgrade proof. Reproduced
that terminal cached-cleanup runs with remaining leases were not counted before
purge. Both ledgers now count a raw run if its recovery control is unresolved
or any browser lease remains, independently of its cached cleanup flag. Memory
counting and atomic admission share one synchronous predicate. PostgreSQL's
shared count/admission query retains distinct raw/orphan branches without double
counting. The populated-v3 upgrade test now preserves a historical completed/
cleanup=true row while proving control=false retains its charge after lease
deletion and rejects another start at the concurrency boundary.

Before-fix report `control-admission-red.json` retained. Full local **441 passed,
19 database tests pending**, report `control-admission-local.json`, SHA256
`6e0d6c066ebc2a9364d07ee63392d5e4d9470e40f63a6f87bfb9663c4afed84f`.
PostgreSQL adapter **12/12 passed**, report `control-admission-postgres.json`,
SHA256 `7849af9b500df2d638989bc3c386d2409fe085fbed905f47b13002542a3f6fcc`.
TypeScript/whitespace checks passed. Dedicated database ended at zero test
schemas/other connections; PostgreSQL stopped and forwarding cancelled.
Next inspect recovery discovery and updateRun mirroring: unrelated raw-run
updates must not overwrite independent unresolved cleanup truth after backfill.
No production migration, credentials, budget or gate changes occurred.

## Completion ledger

| Required outcome | Current evidence / next proof | Status |
|---|---|---|
| Code/deployment/plugin/memory reconciliation | Ancestry and live identity mismatch established above; uncommitted memory integration and installed protocol still need reconciliation | Incomplete |
| Historical P01 attempts | Erratum lower bound is at least one: run `3c5bc1c1-75ac-4776-9120-d8a665ef5814`, test `8469f5b5-1258-42ed-b6b3-4236c36947e2`, Candidate AL; durable attempt inventory still required | Incomplete |
| One executable async P01 contract | Startup/assistant/finalization paths pass local memory and PostgreSQL 18.6 boundary integration; installed skill, production-version parity, artifact/retention semantics and full causal negative matrix remain to reconcile | Incomplete |
| Stable ownership and current readiness in existing controller | Superseded-start publication and reconnect readiness repaired in existing hook; remaining callback/authorization/owner-death boundaries and built-app proof pending | Incomplete |
| Durable allocation/settlement/owner-loss recovery independent of content retention | Audit all resource obligations, not only active runs; test allocation/settlement crash boundaries and retention expiry | Pending |
| Shared suite admission and truthful evaluators | Inspect single-run versus suite admission and failure/evidence classification on actual paths | Pending |
| Causal negative matrices | First delayed-start regression reproduced; all owning boundaries still require causal coverage | Incomplete |
| Twenty complete fresh-process built-Sophia journeys | Prior dynamic-injection trials do not prove this broader requirement | Pending |
| Five consecutive exact deployed canaries | No current-release series attested | Pending |
| Corrected P01 from fresh installed-plugin root task | Authentication, exact release and prerequisites must pass first | Pending |
| Full canonical suite | Local unit tests are not the canonical deployed suite | Pending |
| Exact-release evidence and operational closeout | Full obligation inventory, terminal zero, retention evidence, deployment IDs, strict reverse-order gate closure and final report required | Pending |
| `PROMOTE VT00` | Every requirement above must be evidenced on the exact release; preserve product failures under downstream-owner rule only with complete harness evidence | Not achieved |

Do not reset the historical attempt count. At five evidence-bearing P01 failures,
report `P01_FIVE_ITERATIONS_REACHED — CONTINUE` and continue. No local test failure
is reclassified as an official installed-plugin attempt.

## 2026-09-13 operator aggregate spending-policy change

The user explicitly requested removal of the safety budget and cancellation of
the automation while continuing the goal. Scoped the change to the aggregate
rolling provider-seconds cap, not per-run deadlines, resource limits, cleanup,
authentication, or release gates. Both provider-time environment settings now
accept exact `unlimited`, represented as null in capabilities/remaining capacity.
Memory and PostgreSQL admission preserve reservations and idempotency while
skipping only the selected provider-time comparison. The Blueprint selects
unlimited for both global and caller provider-time caps. No live environment
was changed: the existing deployment cannot parse this new setting.

Automation delete for `resume-sophia-ah-voice-test` returned `not_found`;
no local automation TOML was found and no replacement was created. Installed
get_capabilities still returns UNAUTHORIZED / oauth_token_invalid_grant.
No production run, credential change, gate opening, or deployment occurred.

Focused policy/config/caller-partition tests: 12 passed. TypeScript and full local
suite passed (report: sibling evidence directory/provider-spend-policy-local.json).
PostgreSQL integration was skipped in that local run and still must be executed
for this policy change before release. Continuing C4 recovery discovery and
stale raw cleanup-state reconciliation remains necessary; PROMOTE VT00 is not
achieved.

## 2026-09-13 recovery discovery and non-authoritative projection repair

Progress: both ledger adapters now discover terminal recovery work from an
unsettled control or outstanding browser lease even when raw cleanup_complete
is cached true. Unrelated updateRun projections preserve independent control
cleanup/retention fields instead of copying stale raw snapshots over them.
Explicit lifecycle patches remain the caller's existing authority boundary;
further hardening of proof-backed settlement is still required.

Real PostgreSQL historical-upgrade regression proves an unresolved backfilled
control remains counted and discoverable after lease release and an unrelated
trace projection. The memory regression covers a contradictory live lease.
Added PostgreSQL unlimited-spend tests: unchanged durable usage/replay identity,
restored finite global/caller caps count prior usage, run-start caps still apply.

Validation: TypeScript and diff checks pass; full local 449 passed, 20 optional
PostgreSQL tests pending. Main real PostgreSQL suite 13/13 passed.
Evidence in the sibling vt00-c4-evidence directory:
- recovery-discovery-local.json SHA256
  c51308c52d4d715ef6bc73fb94ef706e7014686b64cc0fcb32c4683b82f792cc
- recovery-discovery-postgres.json SHA256
  96bba05074f0e96c87e11b6399acd64c53c00dc480074a7cc57cfde4a35e0346

Dedicated test database showed zero harness schemas and zero other connections
after test cleanup. PostgreSQL stopped and exact SSH forward cancelled.
No product resources, live gates, credentials, deployed limits, or official P01
attempts changed. Next: worker terminal recovery still needs a causal regression
for completed raw runs with unresolved controls and truthful downward correction
of stale cleanup flags before failure-evidence publication.

## 2026-09-13 worker terminal recovery correction

Progress: reproduced completed-run recovery skip with an outstanding foreign
worker lease (terminal-recovery-red.json: recover called zero times).
Worker terminal handling now consults raw cleanup, independent control, durable
lease, and local session presence rather than treating completed state as proof.
It corrects stale cleanup flags downward when authoritative settlement is absent
and reconciles the independent control before failure evidence is published.

The new terminal-recovery-worker test proves canonical recovery dispatch,
no replacement browser start, false cleanup/evidence failure with the exact lease
preserved, admission still occupied, exported cleanup audit not claiming zero,
repeat maintenance recovery, and immutability of the first artifact.
An initial artifact assertion used Uint8Array.toString rather than Buffer decoding;
the fixture assertion was corrected, not the production evidence representation.
Full local suite and TypeScript/diff checks passed; report
vt00-c4-evidence/terminal-recovery-local.json (sibling directory).
No live resources or deployment were changed, no official P01 was attempted.
Remaining owner-loss process authority, historical D02 recovery, controller
upgrade/attestation, built-product journeys and exact-release certification
remain required; this is not PROMOTE VT00.

## 2026-09-13 bounded terminal recovery paging

Progress: recovery-page-red.json reproduced a first-run cleanup exception
aborting maintenance. Terminal recovery now isolates each run's exception and
advances an ordered UUID cursor through bounded pages, wrapping after exhaustion.
Both ledger adapters validate cursor/limit and use the same ordering. Expiry
recovery exceptions are also isolated so they cannot prevent terminal recovery.

A 12-run causal test with the first recovery permanently failing proves later
pages are reached, no browser starts, all unresolved obligations remain counted,
and retry after wrapping remains possible. This proves fairness within one live
worker, not durable restart fairness or persisted retry backoff. Those remain
open, as do expiry-list paging and independent owner-death authority.

Validation: 451 local tests passed (20 optional PG tests pending), TypeScript and
diff checks passed. Main PostgreSQL suite 13/13 passed, including actual cursor
boundary and invalid-cursor/limit checks. Evidence in sibling vt00-c4-evidence:
- recovery-page-local.json SHA256
  2e5133b0a7ab8b93d4d8606be3edb6709cd6317d719ac40a02cc307f65476607
- recovery-page-postgres-v2.json SHA256
  9fdfbaebb7a7194cf4c3e0eb1945596de0616f1d69fe6b777804183d60438db9

The first PG attempt failed because temporary cluster files were cleared on VM
restart; its report is preserved as recovery-page-postgres.json. A fresh cluster
and dedicated synthetic database were then created. After passing, test schema
and other connection counts were 0|0; PostgreSQL stopped and SSH forward cancelled.
No production, passwords, gates, deployed budgets, or official P01 attempts changed.

## 2026-09-13 shared cleanup proof authority

Progress: cleanup-authority-red.json reproduced foreign-run acceptance by the
shared authoritativeLiveCleanupComplete helper. It now requires the current
testRunId and cleanup-obligation hash, canonical source, HTTP 200, terminal
canonical-session/provider/auth components, and the existing authoritative
Builder discovery/zero contract. Missing run binding cannot prove settlement.
All worker settlement, failure/completion verdict, pre-resource scenario and
task-cleanup projections pass the owning run; process-death recovery proof
uses the same predicate.

Negative coverage includes cross-run, cross-obligation, wrong source, failed HTTP,
failed provider status and absent auth component. The first full run exposed
three incomplete mock receipts; fixtures were updated to provide actual
required identity/status fields while negative fixtures remain invalid.
Report cleanup-authority-local.json preserves those failures.
Final local suite and TypeScript/diff checks passed; report
cleanup-authority-local-v2.json in sibling vt00-c4-evidence. PostgreSQL integration
was not rerun for this helper change; it remains a pre-release verification item.
No production calls, resources, deployments, credentials, or gate changes.
Independent owner-death authority and full campaign closeout remain incomplete.

## 2026-09-13 cleanup authority PostgreSQL verification

Progress: executed both real PostgreSQL suites on the current dirty C4 worktree,
base HEAD 41b3322a1982387a408db3f52277a9f9450a438c. All 20 tests passed with
zero skipped/failed tests (main adapter 13 plus retained controls 7).
Report in sibling vt00-c4-evidence/cleanup-authority-postgres.json, SHA256
2806acc69bba22ca480fa7177c2477ca95b57d5141f1c9b72b40d05a31903432.
This closes the preceding helper-change PostgreSQL verification item, not
production certification or the full independent owner-loss protocol.

Both dedicated synthetic test databases returned 0 harness schemas and 0 other
connections after teardown. PostgreSQL stopped, exact SSH forward cancelled,
selected mem00-qualification VM shutdown confirmed. Other VM untouched.
No deployment, provider allocation, production gate, credential or official P01
attempt changed. Unresolved: independent process-death authority after lost owner
and content purge, durable restart fairness/backoff, historical D02 obligations,
complete upgrade controller/attestation, product journeys and exact-release tests.

## 2026-09-13 platform worker ownership prerequisite

Progress: audited the existing render-worker-controller rather than adding an
alternative voice runtime. Its D02 proof joins before/after Render instance sets,
the exact one-shot command/dispatch journal, and a worker-loss observation.
That is not yet an independent generic process-death authority after raw history
purge. Retained executionOwnership is available but no independently verified
terminal-owner receipt is accepted into those controls yet.

Found production bin/worker startup silently substituted a random worker ID when
RENDER_INSTANCE_ID was absent. Such an ID cannot match the controller's exact
Render instance inventory. Added resolveWorkerIdentity before ledger creation,
initialization, audio resolution or driver construction. It preserves the exact
platform ID, rejects malformed/absent identity with safe errors, and permits a
generated ID only for explicit test/development operation. Grammar matches the
existing controller inventory parser; no platform status is inferred from it.

Focused identity plus D02 controller suite: 29 passed. Full local suite and
TypeScript/diff checks passed; evidence worker-identity-local.json in sibling
vt00-c4-evidence. This is startup identity proof, not process death, resource zero,
or successful production deployment. No production/credential/gate changes.
Next authority work must retain the controller's exact owner/death proof outside
raw content, verify independent signatures and replay binding before settlement,
and handle missing pre-acquisition ownership without fabricating a zero.

## 2026-09-13 staged retained D02 owner-death verifier

Progress: added controller-side verifyRetainedD02OwnerDeath using the existing
signed D02 termination receipt and deployment-control public key, not a new
runtime or unsigned instance-absence assertion. It joins retained run/test/
cleanup/environment/deployment, attested browser context, original execution
ownership/lease, configured worker service, exact receipt signature, ordered
run/receipt timestamps, and acceptance before expiry. Allocation intent without
attested acquisition is rejected. Its content-free projection explicitly reports
providerCleanupProven=false and liveResourcesZeroProven=false.

The existing controller test now produces a genuinely signed synthetic controller
receipt bound to the retained fixture and verifies acceptance plus wrong-run,
cleanup, environment, scenario, deployment, service, expired/future receipt,
missing ownership/context, and signature-tampering rejection. This verifier is
staged: no durable ingestion route or settlement bypass uses its output yet.
Generic unplanned owner loss remains unsupported; integration must retain exact
source authority and preserve independent provider/auth/Builder zero requirements.

Full local suite: 464 passed, 20 PG pending, report
vt00-c4-evidence/retained-owner-verifier-local.json (sibling directory), SHA256
a019986115f2926cb0fc35a65a78a693535b59f67aa5c31c82d2455c597cb7cb.
Controller TypeScript checking exposed an unchecked structuredContent.status
access in P01 classification; added isRecord narrowing. Controller TypeScript
then passed, and external attestation controller tests passed 11/11.
No live calls, deployment, gate changes, secrets, or P01 attempt were involved.

## 2026-09-13 reproduced missing retained D02 dispatch authority

Progress: audited claimD02RenderWorkerDispatch and both ledger claimEvent
transactions. The guard checks a complete locked event snapshot, but the winning
dispatch event only goes into raw run_events. RecoveryControlRecord has no
retained command/freeze/consumed-dispatch journal; retention deletes that event
stream. This is why the staged owner-death verifier must not yet drive settlement.

Added an ordinary expect.soft release-gate assertion to the real service/ledger
D02 dispatch test: before acknowledgement, retained d02Journal must contain the
termination hash, authenticated command content hash, exact Gateway freeze hash,
consumed dispatch hash/sequence and frozen provider epoch union. It fails now,
while the rest of that scenario still executes; report
vt00-c4-evidence/d02-retained-journal-red.json in the sibling evidence directory.
This is a newly reproduced release blocker, not an xfail/skip or an official P01
failure. Current suite is therefore NOT green.

Next implementation boundary: persist the bounded metadata-only journal in
recovery_controls in the SAME locked transaction as the winning claimEvent,
before response. Preserve it through hard raw-content deletion; exact retries
must return the same claim/journal, conflicting attempts must never replace it.
Both memory and real PostgreSQL need crash/rollback/replay/retention proof, plus
schema checksum/attestation updates without editing historical baseline SQL.
Do not acknowledge first and mirror later, and do not infer this authority from
the generic canonical cleanup receipt or lease absence. No production changed.

## 2026-09-13 retained D02 journal local implementation

Progress: added bounded metadata-only D02 dispatch journal projection and strict
self-hash validation. Memory claimEvent persists the journal before returning;
PostgreSQL claimEvent locks recovery control before browser lease and updates the
journal in the event transaction. Exact guarded retries require the original
journal and conflicting claims cannot replace it. Raw-content purge retains it.
The unreleased recovery extension and its attestation hashes were updated; the
historical SQL baseline was not edited.

The actual service regression and shared memory durability fixture pass (9/9).
Full local suite: 465 passed, 0 failed, 21 PostgreSQL tests pending; report
vt00-c4-evidence/d02-journal-local-v2.json in the sibling evidence directory.
TypeScript checking passes. Real PostgreSQL execution and a forced rollback
after the journal update remain required; local success is not their substitute.
Pre-dispatch freeze retention and signed owner-proof ingestion also remain open.
No deployment, gate opening, password change, or official P01 occurred.

The aggregate provider spending caps are disabled only in local candidate
configuration. Per-run/resource/auth/cleanup gates remain intact. The requested
resume-sophia-ah-voice-test automation was absent when deletion was attempted,
and the local automations directory remains empty. No replacement was created.

## 2026-09-13 D02 journal PostgreSQL transaction proof

Progress: extended the shared journal fixture with an optional transaction
rollback probe. The dedicated PostgreSQL test installs a temporary BEFORE INSERT
trigger which first verifies that the dispatch transaction already contains a
non-null recovery journal, then raises D02_POST_JOURNAL_INSERT_FAILURE. After
rollback, the entire recovery control equals its prior value, the raw cursor is
unchanged, and no dispatch event exists. The trigger is removed in finally;
concurrent exact retries then converge to one dispatch and the journal survives
hard raw-content purge. This is causal post-write rollback evidence, not merely
a preflight failure. Synthetic adapter fixtures allocate no provider/browser.

Both real PostgreSQL suites passed: 21 passed, 0 failed, 0 pending. Evidence:
vt00-c4-evidence/d02-journal-postgres.json (sibling directory), SHA256
1310cef3299763ea33c0486b7d515b2f90ffe65b483fe36f0eff816ae8d78b20.
TypeScript checking passed. Both dedicated databases showed 0 Voice Lab schemas
and 0 other connections after suite cleanup; their fresh PostgreSQL cluster was
stopped and SSH forwarding cancelled. No production change or official P01.
Partial pre-dispatch freeze retention and durable signed owner-proof ingestion
remain separate unresolved requirements; this proof does not certify them.

## 2026-09-13 signed owner proof bound to retained dispatch

Progress: verifyRetainedD02OwnerDeath now requires a strict self-hashed retained
D02 journal and matches it against the signed receipt's run/cleanup/termination,
service, worker/lease/context, provider session/admission/current and frozen
epochs, dispatch claim/hash/sequence/attempt and action request. Its projection
also retains the journal proof hash. Missing or mismatched dispatch authority
fails closed even when the receipt signature is valid.

The signed controller fixture passes with its matching synthetic retained
journal; fourteen rehashed cross-binding negatives and missing-journal rejection
pass. An initial test fixture reused an existing HASH_D value and thus failed
to introduce drift; it was corrected to generate distinct per-field hashes.
The verifier is still staged, not durable ingestion or a settlement grant, and
still explicitly declines provider-cleanup and live-resources-zero proof.

Focused controller tests: 17/17. Full local suite: 465 passed, 0 failed,
21 PostgreSQL tests not selected in this local run. Controller TypeScript passed.
Evidence: vt00-c4-evidence/d02-owner-journal-local.json (sibling directory),
SHA256 d54188b8a5315040d46bc976ae9c638dde1b99955fcba0f8de2a7e456b92c7c7.
No production actions, secrets, resource allocations or official P01 occurred.

## 2026-09-13 private transactional owner-death ingestion

Progress: added persistRetainedD02OwnerDeath in the existing independent
controller package. It locks run -> retained control -> lease, checks exact
ownership, verifies the signed receipt against trusted public configuration and
the retained journal, accepts first writes using the database clock after locks,
and stores a strict bounded metadata projection with a version increment. Exact
receipt retries reverify at the durable original acceptance time; conflicting
receipts cannot replace it. It does not delete a lease, fabricate a process-close
event, set executionCleanupProof, or settle any live-resource obligation.

Added strict retained-owner-death storage parsing and cross-binding to control,
ownership and dispatch journal, plus d02_owner_death in the unreleased extension.
Current extension SHA256:
c8182099bde03ba15deec3d8bf5673a95f7d8debdd39051327473d8429a7fee5.
Current composite migration SHA256:
a5c8e2c01d85905ebd1f730c7dbdd66587aafb7e6e313e0f1d192e57b5fc0b7c.
Historical baseline SQL unchanged. No runtime DDL or public ingestion endpoint.

Controller mocked transaction tests cover stale-version rollback, single write,
exact replay, conflicting receipt rejection and no lease/cleanup mutation.
These are NOT real PostgreSQL transaction evidence. New-column migration,
post-write rollback, concurrent first ingestion, reconnect/replay after expiry,
and raw-purge survival require the next real-PG pass. Production integration
also remains pending; no claim that this callable alone completes owner recovery.
Focused controller/schema tests 25/25; controller TypeScript passes; full local
suite 465 passed, 0 failed, 21 PG pending. Evidence sibling directory:
vt00-c4-evidence/d02-owner-ingestion-local.json, SHA256
31d28096c333e6ca9bf45a320cb7072875d6058d088637afab064bd5abac3535.

## 2026-09-13 real PostgreSQL owner-death ingestion proof

Progress: added opt-in verifyOwnerIngestionPostgres invoked by the signed D02
controller fixture when SOPHIA_VOICE_LAB_OWNER_TEST_DATABASE_URL selects a
dedicated voice_lab_test_c4_owner_* database and reset approval is YES. It
applies the checksum-pinned composite to a fresh schema and uses synthetic
signed controller/ownership/journal fixtures, without contacting live services.

Real transactions prove: expired first submission and stale version rejected;
AFTER UPDATE exception rolls back the new proof; concurrent submissions converge
to one version increment and exact replay; raw terminal content purges without
deleting owner proof or original lease; independent reconnect replays the same
accepted signature after its actual expiry while fresh-time verification rejects
it; conflicting receipt is immutable. Execution cleanup remains absent, the
live-cleanup flag remains false, and the retained allocation still counts as one
outstanding run. No cleanup inference is made from owner death.

The first run correctly refused to purge the non-terminal fixture; the fixture
was corrected to failed_harness before retention. Its red report is preserved.
Final three-file run: 38 passed, 0 failed, 0 pending (17 controller tests including
the PG-backed scenario, plus 21 adapter/control tests). Controller TypeScript
passed. Evidence: vt00-c4-evidence/owner-ingestion-postgres-v3.json (sibling),
SHA256 3805cce33019b025c8d9bc289a034bef7345314d7e839654adccdea3e580999d.
All three dedicated databases had zero Voice Lab schemas and zero other
connections after cleanup. PostgreSQL stopped and forwarding cancelled.
No production changed. Controller workflow invocation, generic owner loss,
post-death resource settlement and full production certification remain open.

## 2026-09-13 retained signed Gateway provider join

Progress: traced the existing D02 Gateway settlement contract and found missing
retained joins: Render action acceptance/snapshot hashes and loss sequence/time.
Added those metadata fields to the verified owner-death projection and strict
parser. This is an unreleased shape extension; do not fabricate missing fields
for any older stored projection. Its source signed receipt must be reverified.

Extracted verifyD02GatewaySettlementSignature from the live client's existing
signature/issuance check and reused it in verifyRetainedD02ProviderSettlement.
The retained verifier requires exact control/owner/journal identity, deployment,
provider session/admission/frozen epochs, browser owner/lease/context, Render
action hashes and loss observation. The Gateway database observation must follow
owner settlement and loss observation. Output proves provider cleanup only and
explicitly leaves auth, Builder and overall live-zero false. No lease release or
durable settlement bypass is wired to this output.

The signed controller fixture now creates a separate synthetic Gateway signature
and tests positive joins, eleven re-signed hash drifts, loss/lease/environment/
scenario/time drifts, tampering, unknown authority and missing owner authority.
Focused Gateway/controller tests 28/28; controller TypeScript passed; full local
suite 465 passed, 0 failed, 21 PG not selected. Evidence sibling directory:
vt00-c4-evidence/retained-provider-join-local.json, SHA256
73fe5ab45870505240991b4e3b56c4ad3ba7a137622aa4203aa3464e6cfaa0a6.
Production unchanged. Expanded owner projection needs a fresh PG pass; provider
proof persistence, canonical auth/Builder joins and workflow invocation remain
required, alongside generic owner loss and the full VT00 certification campaign.

## 2026-09-13 exact retained recovery attempt matching

Progress: traced Gateway recovery response construction and its _recovery_id /
_attempt_id functions. The response includes recovery_id, attempt_id,
attempt_issued_at and recovered_at, but retained worker settlement previously
checked only the run/cleanup receipt. Added the exact Gateway hash recipe in
recovery-attempt.ts and a mandatory worker check against its newly minted,
verified capability before calling settleRecoveryControl. No token/nonce is
stored. Recovery observation must follow capability issuance and cannot be
implausibly future-dated. Existing run/component/lease/execution checks remain.

Six new same-run negative cases reject wrong/old/missing attempt IDs, wrong
recovery identity, old issuance, old observation and future observation; each
leaves the obligation unresolved and counted. Exact positive D02 and ordinary
retained recovery still settle. Focused retained worker tests 12/12; TypeScript
passes; full local suite 471 passed, 0 failed, 21 PG not selected.
Evidence: vt00-c4-evidence/retained-recovery-attempt-local.json (sibling), SHA256
98dcd48e137a19806da4b26efe9acf76ab49eb88043bd97e09e1f09ff580afa8.

This closes attempt-correlation, not the remaining owner-loss lifecycle. The
existing signed Gateway D02 receipt still needs durable provider-proof storage
and workflow invocation; original lease release must await the joint owner,
provider and fresh canonical auth/Builder proof. No production change, no new
browser/runtime, no official P01. All full-campaign requirements remain active.

## 2026-09-13 durable signed provider proof

Progress: added strict self-hashed provider proof storage and private controller
persistRetainedD02ProviderSettlement. It locks run -> control -> lease, validates
the existing Gateway signature against trusted configuration and exact retained
owner/journal, and commits a bounded metadata proof with version increment.
Exact retries reverify and return the immutable proof; stale first writes and
conflicting receipts fail. No lease deletion or overall cleanup mutation occurs.
Readback verifies the provider proof belongs to the retained owner-death proof.

Current unreleased extension SHA256:
2b3b53639ef52bc81b6a2e142d3c9b74e4c8ab5d18e04c47d9632032349256cd.
Composite migration SHA256:
6ce9ee6f8b5d299b4298389d073afa25b63a3e76dfb4120b3cbb9ebf25478017.
Historical baseline unchanged. The new d02_provider_settlement column requires
owner authority and explicitly cannot claim auth/Builder/overall live zero.

Real PostgreSQL fixture proves post-update rollback, stale CAS, concurrent first
submissions, one version increment, retained proof across raw purge, independent
reconnect replay and conflicting receipt rejection. Original lease remains;
execution cleanup remains absent and one unresolved obligation stays counted.
This pass also covers the expanded owner-death metadata projection.

Local suite 471 passed, 0 failed, 21 PG not selected; controller TypeScript passed.
Three-file PG/controller pass 38 passed, 0 failed, 0 pending. Sibling evidence:
provider-ingestion-local.json SHA256
7211185e37d94dd020ce6210a49917ea43a1b1892249b26454b3906427d46a1d;
provider-ingestion-postgres.json SHA256
b6b34cb775d2ea5e7d9200cfbdd259569f008acb92d840e96394c17ec85de36f.
All three test databases showed 0 Voice Lab schemas and 0 other connections;
PostgreSQL stopped, forwarding cancelled. Production unchanged.

Still required: workflow invocation and the atomic combined owner/provider/fresh
canonical auth/Builder settlement path. Storing these proofs alone must not
release resources or certify D02, generic owner loss, or the complete campaign.

## 2026-09-13 atomic combined retained D02 settlement

Progress: added a distinct retained D02 recovery proof joining stored verified
owner death, stored verified Gateway provider settlement, original execution
ownership and a fresh exact canonical recovery attempt with auth/Builder zero.
Capability issuance must follow the owner acceptance and provider observation.
Worker audit hashes now include exact attempt identity and are written before
transport dispatch. The combined ledger branch requires that audit at its exact
control version, plus matching original lease worker/epoch and CAS.

Both adapters implement the branch without inventing raw process-close events.
PostgreSQL deletes only the matching original lease and commits the combined
proof, live cleanup and retention-tombstone confirmation in the same transaction.
Existing direct-execution cleanup remains separate. Once stored, the combined
proof is immutable and exact settlement replay returns the committed revision.
Raw content remains deleted. A missing proof/audit, wrong lease or incomplete
canonical component cannot use this path.

Current unreleased extension SHA256:
223c03bf586be68283acb5cca9dbc29e438799780f59466f9fa9ac18d53d437f.
Composite migration SHA256:
f61cc09d624e8b06e00fc75fb76b862d71baa085727235a95c98fe6bd8dc06d1.
Historical baseline unchanged. Combined proof has its own strict bounded column.

Tests cover missing authorities, incomplete canonical/provider/auth/Builder
components, missing Builder zero and pre-authority attempt issuance. Real PG
also proves missing-audit rejection, wrong-lease rejection, failure after the
lease DELETE restoring the full control and lease, concurrent exact settlement
converging to one revision, zero remaining fixture obligations and confirmed
tombstone. Synthetic signatures/resources only: not a production run or P01.

Local suite 471 passed, 0 failed, 21 PG not selected; controller TypeScript passed.
Three-file PG/controller pass 38 passed, 0 failed, 0 pending. Sibling evidence:
combined-recovery-local.json SHA256
350e827d4964813b50aaa260c2eb32703cbfe53819f4b30118472385ee5acfa2;
combined-recovery-postgres.json SHA256
bd4d33834adc51c96414a8050fa238dbda124e9fc78362da3e5159fbb53159a5.
All three test databases reported 0 Voice Lab schemas/0 other connections;
PostgreSQL stopped and forwarding cancelled. Production unchanged.

Still required: invoke signature ingestion through the actual controller
workflow and prove worker-driven recovery end-to-end, not only the ledger call;
generic owner loss, partial D02 freeze retention, real deployment reconciliation,
built journeys/canaries/P01 and the remaining full campaign obligations.

## 2026-09-13 worker-driven retained recovery transport proof

Progress: added verifyRetainedWorkerPostgres to the opt-in signed-controller
fixture. It runs the real VoiceLabWorker and PlaywrightVoiceDriver.recover against
the real PostgreSQL ledger; only the Gateway HTTP response is synthetic. The
transport callback verifies the exact scoped capability, immutable original D02
browser/deployment/retention binding and durable audit before returning an exact
attempt-bound raw recovery response. The real driver then validates/redacts that
response before worker settlement; this is no longer a ledger-only success call.

The worker path is exercised while the post-lease-delete failure trigger is
installed, preserving unresolved truth and original lease, then again after the
trigger is removed. It settles correctly and concurrent exact ledger readbacks
return the same revision. Browser start/launch and replacement lease allocation
are spied and must remain unused; no raw run is rebuilt. This is a synthetic
Gateway boundary test, not a live Sophia journey, production D02 or official P01.

Controller TypeScript passed; local suite 471 passed, 0 failed, 21 PG not selected;
three-file PG/controller pass 38 passed, 0 failed, 0 pending. Sibling evidence:
worker-recovery-local.json SHA256
f8a2c92e9765468c5d2ae3676ca96fc7cc623a6409f0dede6f6cf14776077564;
worker-recovery-postgres.json SHA256
b06f078d476d281e126e34f25c86bd35a6650da0ad88a0cbac1838450f5f5fec.
All three disposable databases had 0 Voice Lab schemas and 0 other connections;
PostgreSQL stopped and forwarding cancelled. Production unchanged.
Actual controller workflow ingestion, generic owner loss, partial freeze
retention and full campaign deployment/certification obligations remain open.

## 2026-09-13 reproduced controller-to-runtime receipt handoff gap

Progress: traced executeD02RenderWorkerTermination through its durable local
render_worker_replacement_settled checkpoint and finalEvidenceFor. The final
signed attestation includes local_controller_receipt_sha256 but not the signed
source receipt. Meanwhile service.ts obtains the independent signed Gateway
settlement and appends it only to raw run_events. Neither existing workflow
boundary currently invokes the new durable signature-ingestion functions.

Added an ordinary expect.soft release-gate assertion requiring the exact local
signed receipt in the final controller payload. It reproduces the gap: focused
controller suite 16 passed, 1 failed. The test is not skipped or an expected-fail
waiver. Evidence sibling directory controller-receipt-handoff-red.json SHA256
31c730a69eeea3256955b4b1eaea439d6388ead4cab3a92449a755f3782cb81e.
The local release suite is therefore NOT currently green; earlier green reports
remain historical evidence for their exact boundaries, not completion claims.

Implementation boundary: use the existing authenticated attestation workflow
to carry/verify the exact independently signed receipt, matching its existing
hash and all command/loss joins, and persist owner then Gateway proof before
acknowledgement. Preserve exact replay and retention races. Do not trust a hash
as a signature or create an alternate ungoverned authorization path.
Receipt schemas/signature verification need a shared runtime module: the
external contracts currently import service.ts and the Docker runtime copies
dist, not external controller source. Importing that controller graph directly
into the service risks a schema initialization cycle and packaging failure.
No production changes, resource allocations, secrets or official P01 attempts.

## 2026-09-13 shared signed controller receipt handoff

Progress: moved the existing worker-loss and independently signed Render receipt
schemas/signature verifier into src/d02-worker-receipt.ts, shared by the runtime
and external controller. The controller now includes the exact signed source in
its final attestation. The service verifies its independent signature, digest,
run/deployment/provider/browser/action/loss and Render snapshot joins before
Gateway settlement. Signature failure is a typed authorization rejection.
Historical payload decoding remains compatible; this is not yet durable C4
ingestion and must not be presented as that completed boundary.

Added real service-boundary negative checks for tampered signature, re-signed
environment and snapshot drift, and mismatched digest. Each must reject before
the Gateway settlement spy is called. The positive source-carrying path passes,
including existing immutable expired-attestation readback behavior.

Verification: focused 33 passed; full local 471 passed, 0 failed, 21 PostgreSQL
tests not selected. Main and controller TypeScript passed; production TypeScript
build and built service/shared-receipt imports passed; git diff --check passed.
Evidence in the sibling vt00-c4-evidence directory:
controller-source-boundary-local.json SHA256
cb46a8625e3bda88f51658f9bf70922b64f9e8dd48ece4a6169150cfffe82d48;
controller-source-full-local.json SHA256
3822bef8700ca806a216d9568e19208e236bc335c6e3ac0f233e8794e5dd90c9.

The requested aggregate provider-seconds cap removal remains local/unreleased;
explicit unlimited policy preserves accounting and per-run/resource limits.
Scheduler delete of resume-sophia-ah-voice-test returned not_found (already
absent), and the local automation directory contained no files. No replacement
automation was created. Installed get_capabilities still returned UNAUTHORIZED,
oauth_token_invalid_grant, TRIGGER_REAUTHENTICATION. No gates were opened and no
production mutation or official P01 attempt occurred.

Next: connect verified owner/provider source persistence to the existing
authenticated workflow before acknowledgement, handling exact replay and
retention races. Full campaign deployment and certification obligations remain.

## 2026-09-13 runtime durable owner/provider ingestion

Progress: moved the existing independently signed owner verifier and transactional
PostgreSQL ingestion implementations into src with compatibility re-exports for
external-controller callers. Added typed internal ledger boundaries and matching
Memory behavior. Runtime code no longer imports the external contracts graph.
No public authority-input endpoint or unsigned cleanup grant was added.

The existing authenticated worker-loss attestation path now requires the signed
source for a new settlement, preserves owner death after all existing command/
dispatch/loss cross-joins and before requesting Gateway settlement, then persists
the independently verified Gateway provider fact before recording success.
Historical payloads remain decodable but missing source cannot acknowledge new
C4 settlement. Exact durable replay uses original owner acceptance time; new
facts retain CAS, exact-lease, signature and immutable-binding requirements.

Service/Memory proof uses synthetic signed sources and actual ledger methods.
Owner storage failure prevents Gateway dispatch; provider storage failure leaves
no settlement-success event. Wrong Gateway settlement preserves only owner fact.
Retry completes, both proofs survive raw-content purge, exact ledger readback
works after purge, and overall cleanup remains false. This does NOT certify an
HTTP re-entry after mid-workflow raw purge: that boundary still needs work.

PostgreSQL fixture now invokes runtime ledger methods for first ingestion,
CAS/rejection, rollback and concurrency; independent-pool compatibility calls
still prove restart/expiry readback. Worker-driven retained recovery still passes.
The service-to-Memory and ledger-to-PostgreSQL proofs are separate boundaries,
not yet a full service-through-PostgreSQL controller journey.

Verification: 471 local tests passed, 0 failed, 21 PG not selected; separate real
PG/controller run 38 passed, 0 failed, 0 pending. Controller TypeScript, runtime
build, built PostgreSQL ledger/service imports and diff whitespace check passed.
Evidence sibling directory runtime-ingestion-full-local.json SHA256
f4c6ee4fe97051c4c6418847f390963e7b847a3822966850f95df418b2633287;
runtime-ingestion-postgres.json SHA256
30af86ed88b14874917a7c9261a4b270ab587e7396dafbe9abb6c552ba0873d7.
All three disposable DBs reported 0 Voice Lab schemas/0 other connections;
PostgreSQL stopped, forwarding cancelled, mem00-qualification stopped (handle
7103 exit 0). Sibling memory VM untouched. No production changes or P01 attempts.

Next: full service/PG replay and retention-race handoff, partial D02 freeze/dispatch
recovery and generic owner loss. Deployment reconciliation, installed auth,
20 built journeys, five deployed canaries, corrected fresh P01 and full canonical
campaign/operational closeout remain unproven. Goal remains active.

## 2026-09-13 shared service/PG proof and retained fact readback

Progress: extracted the complete signed D02 service fixture unchanged into
d02-service-ingestion-helper.ts and ran it through a dedicated real PostgreSQL
service test, not only the ledger-only controller fixture. The same flow covers
command/freeze/dispatch, owner loss, signed owner/provider storage, storage
failure fences, expired exact retry, evaluator negatives and raw retention.
The standalone real PG service path passed before the readback change.

Reproduced post-retention HTTP/service retry failure: attachExternalAttestation
read runs before checking recovery_controls and returned RUN_NOT_FOUND despite
both signed facts having been preserved. Ordinary regression failed (7 pass,
1 fail); preserved retained-service-readback-red.json SHA256
5c23f3c5839efa8c9f0673bc4d6fa243b7ed85b2aca8c39396d09cdc59e2cd63.

Implemented authenticated read-only retained fact lookup within the existing
attestation boundary. Transport scope/subject and outer signature are verified
before lookup. It requires a purged control and both stored facts, exact original
signed source digest, immutable run/deployment and provider settlement binding;
the owner source is reverified at original acceptance time. It audits only hashes
with no raw run reference. The result is status ok, no run/session/event cursor,
proof_status retained_recovery_facts_only, and certification_available false.
It is NOT a new attestation acknowledgement, full-envelope replay or restored
scenario evidence; changed outer evidence is not certified by this lookup.
No Gateway call, browser allocation, raw-event recreation or TTL extension occurs.

Memory and PG tests cover readback plus wrong transport authority, invalid outer
signature, wrong source hash and wrong provider settlement. Full suite with the
dedicated service DB selected: 472 passed, 0 failed, 21 other PG not selected.
Controller TypeScript, runtime build/import and git diff --check passed.
Evidence sibling directory:
shared-d02-service-postgres.json SHA256
be80762a62df320d6c00b6be7add34dd3868bdc7912d82b037e68a7c3f934136;
retained-service-readback-full.json SHA256
710b54b7eb5039efa467fd4ede412dff298de9e70f6a6ea0ceecc4a8a9cf9922.
Disposable DB had 0 Voice Lab schemas/0 other connections; PostgreSQL stopped,
SSH forwarding cancelled and selected VM stopped. No production changes/P01.

Still required: interrupted first ingestion when only owner or no source is
stored at raw purge; controller handling of retained-only result without claiming
certification; partial freeze/dispatch and generic owner-loss recovery. Existing
Gateway settlement replay still needs raw provider identity; do not reconstruct
it from a digest. The remaining full campaign gates remain unproven.

## 2026-09-13 first owner ingestion after raw retention

Progress: the authenticated retained-fact path can now ingest a still-valid
independent owner-death receipt when content was purged before its first write.
It checks the immutable control/dispatch journal and configured signature
authority, records a content-free authorization audit, and uses the existing
ledger transaction to repeat validation with the database acceptance clock.
It never accepts an expired first source using a historical time. Previously
stored exact source readback still uses its original acceptance time.

When provider proof is absent, it returns status unavailable with
RETAINED_D02_PROVIDER_SETTLEMENT_UNAVAILABLE and retained_owner_only, not a
completed settlement. No raw provider ID is reconstructed, no Gateway call is
made, no raw run/events are rebuilt and no quota obligation is released.
The method is now recoverRetainedD02AttestationFacts to reflect possible owner
metadata ingestion rather than implying the entire path is read-only.

The shared service fixture now covers content cuts before owner storage and
after owner storage, expired first source rejection, exact replay without
revision churn, absent raw run, absent provider proof, active obligation count
one and cleanup false. All three service cases also run against real PostgreSQL
with isolated schema setup/teardown per case. A synthetic future-timestamp
fixture race was fixed by waiting for its ordered loss observation before
requesting a real-clock attestation; production timestamp guards were unchanged.

Final suite with the three PG service cases selected: 476 passed, 0 failed,
21 other PG not selected. Controller TypeScript and runtime build passed;
git diff --check passed. Evidence sibling directory:
partial-owner-retention-postgres.json SHA256
e33152b8c1244b73f85dda6d61443561b94ee5cd78ad78ce3b014eb164851127;
partial-owner-retention-final.json SHA256
a37479ce94e792a71ecf970d3549cbca1f4ddd4e1c0826c2a4249110c0aeb574.
Disposable DB had 0 Voice Lab schemas/0 other connections; PostgreSQL and
forwarding stopped, selected VM stopped (90605 exit 0). Production unchanged.

Remaining provider boundary: D02GatewayClient.settle and Gateway's
D02SettlementRequest require raw provider_session_id. The database-authorized
settlement path can return an existing signed receipt but currently binds the
original full request hash; no digest-only retained lookup contract exists.
Need an owning-Gateway authorized durable lookup/settlement contract, not hash
reversal, a fabricated receipt, or release of the unresolved control. Backend
CLAUDE.md read was truncated this turn; read it fully before backend edits.
Partial freeze/dispatch, generic owner loss, controller retained-response
handling and all full-campaign deployment/certification obligations remain.

## 2026-09-13 owning-Gateway retained receipt lookup

Progress, not certification. Backend CLAUDE.md was subsequently read fully.
The full pre-change backend baseline passed: 6104 passed, 161 skipped.
Added a strict digest-only D02 receipt lookup and matching Voice Lab client.
The request derives from retained control/journal/verified owner authority.
It uses the existing exact-body scoped settle capability and existing narrow
settlement-authorize RPC under the cleanup lock. No new grants or migrations.
Only an already committed signed receipt can be returned; no provider call,
finalize RPC, raw-session reconstruction or resource release is authorized.
Current capability validity remains mandatory; an existing signed fact can
outlive its original envelope expiry. All receipt bindings are independently
checked. Missing/candidate settlements remain unavailable.

TDD: three new tests first failed with absent route (404); after implementation
and negative expansion, 53 focused backend tests passed, including strict
numeric/epoch/time rejection, missing capability, wrong source, invalid signature,
transaction rollback and no candidate finalization. Ruff passed. Backend README
and CLAUDE updated. Red XML SHA256:
38aa98664b98a9c71eb39587e1a19876e6ea947404e91e8fe0f359171202b6d2.
Focused XML SHA256:
408b59cd3707cc0f18f9d8574dc88cbb88411ecc4db3bb6acb935269bde60e5a.

Voice Lab full local suite: 473 passed, 0 failed, 24 PG-dependent not selected.
retained-lookup-full-local.json SHA256:
1505da896ea7eb245409be3ea0aa716c78d93c5ba94a5ac063cf5ac4a365379c.
Runtime and controller TypeScript passed. Full post-change backend run started
with backend-after-retained-lookup.xml and completed: 6118 passed, 161 skipped,
13 warnings in 292.13 seconds (session 70871, exit 0). This is local regression
evidence only, not deployed Gateway or full-campaign qualification.

The client is not yet wired into retained service recovery. Next integrate the
already-committed receipt readback with storage/CAS and retention-cut tests;
never-committed settlement remains a separate unresolved boundary. Existing
retained service owner-only behavior is unchanged. No production mutation,
password change, migration, gate opening or P01 attempt occurred.
Installed get_capabilities still returns UNAUTHORIZED / oauth_token_invalid_grant
with TRIGGER_REAUTHENTICATION. Do not bypass the installed-tool boundary.
Automation resume-sophia-ah-voice-test deletion rechecked: not_found. Aggregate
provider-time cap removal remains local, explicit unlimited, not deployed.

## 2026-09-13 retained service receipt recovery integration

Progress: connected the digest-only Gateway lookup to authenticated retained
D02 service recovery when independently verified owner proof exists but local
provider proof is absent. The pre-call audit stores structural hashes only.
Retryable evidence-unavailable leaves owner-only recovery unresolved. Auth and
signature failures escape; they are not converted to recovery success. Returned
provider-settlement hash must also match the independent controller evidence.
Ledger ingestion repeats signature/binding verification under its existing CAS
and then the service reads the durable control before returning recovery facts.
No fallback mutating settle, raw content restoration, browser allocation, lease
release, complete-cleanup assertion or scenario certification was added.

New retention cut: Gateway receipt committed, local provider write failed, raw
content purged. Initial test reproduced the missing integration (10 passed,
1 failed). The completed shared Memory/PG fixture proves unauthorized lookup,
invalid signature, conflicting provider hash and local write failure leave the
control unchanged; exact successful retry stores the signed provider proof,
keeps raw run absent and active obligation count one, and later readback neither
queries Gateway again nor changes control version.

Evidence in sibling vt00-c4-evidence directory:
- retained-service-lookup-red.json SHA256
  60ae20a8dd4fbf7122369d5ae2b1fec860e0ce33ad4cb995a6a28b13adff68b8.
- retained-service-lookup-postgres.json: 15 passed, 0 failed, SHA256
  eac55e56cc9994f3ec6a29b1fb753875e7cfddb3977f452a0c3166a0936d4a4b.
- retained-service-lookup-final.json: 478 passed, 0 failed, 21 other PG not
  selected, SHA256
  767667d9bb9e545df758abd4e1d4798b7124fdcb1d0f2327f897931c1842f4c2.

Runtime/controller TypeScript and git diff --check passed. Disposable selected
PG database reported 0 Voice Lab schemas and 0 other connections after tests.
PostgreSQL and forwarding stopped; selected VM shutdown confirmed (25904 exit
0). The already-running sibling VM was not changed.
Production untouched, no P01 attempt. Previously committed receipts can now be
recovered locally after retention; never-committed settlement, partial dispatch,
generic owner-loss, retained controller response handling and the full campaign
deployment/qualification requirements remain open. This does not narrow PROMOTE
VT00 to local regression success.

## 2026-09-13 controller retained-only classification

Progress: retained-only service responses now carry the exact signed-claim hash.
Added a strict retained response contract and a distinct
RETAINED_RECOVERY_ONLY_NOT_CERTIFIED error with response-byte hash and structural
facts. HTTP attestation handling classifies this before the normal immutable
attestation schema. It cannot satisfy VerifiedAttestationReceipt, cannot append
final_attached, and is not retried as an ambiguous success. Wrong claim/kind,
certification upgrades, non-null raw run/cursor and invented event fields reject.

Actual worker-controller flow test returns retained-only on final attachment,
checks no final-attached checkpoint, then resumes the existing final-prepared
journal: the identical signed claim is reused and Render is not revisited.
The durable special outcome checkpoint is still pending; the typed error alone
does not complete operational closeout or prove complete resource cleanup.

Focused contract/controller tests: 24 passed; worker flow+contract: 20 passed.
Full local suite: 477 passed, 0 failed, 25 PG-dependent not selected this turn.
retained-controller-classification-flow.json SHA256
60442315006e3ec7281cb6584536ce6f07a681c46eda95570957368ae601e445;
retained-controller-classification-final.json SHA256
4609b3ef7065f17f5721e9f6dc2465985664e2d91054541383bb8344c33e2949.
Runtime/controller TypeScript and diff whitespace check passed. No VM started,
production mutation, new run, P01 attempt or gate opening. Full objective stays
active; prior local tests are not promotion evidence.

## 2026-09-13 durable retained controller outcome

Progress: added final_retained_recovery as a terminal non-certification branch
in the existing controller checkpoint journal. It stores the response-byte hash
and strict structural facts; the CLI persists it using the existing deployment-
key MAC, chained entry hash, exclusive lock and create-only secure file writer.
It occupies the next final response slot, index 10 or 11, preserving existing
journal filenames and successful certification paths. A retained branch before
the exact prepared final claim, after both normal responses, or followed by
additional phases rejects. No fabricated attestation event is introduced.

On resume, the full static command/source/final-claim joins are checked first;
the retained signed-claim hash must equal that final claim. The controller then
reports RETAINED_RECOVERY_ONLY_NOT_CERTIFIED without any network request.
Historical recovery facts do not become a fresh live-cleanup attestation.

Tests cover persisted CLI outcomes on both first response and replay, immutable
file bytes, no network on resumed outcome, mismatched claim rejection and
nonterminal branch rejection. Full local suite: 479 passed, 0 failed, 25 PG
not selected. retained-controller-checkpoint-final.json SHA256:
b008e2bd1a076a408e5609544ee22b958bf4308a5cdee46785e64641615a81c0.
Runtime and controller TypeScript passed; git diff --check passed.
No live resource allocation, deployment, migration or P01 attempt. Next durable
resource gaps still include never-committed settlement and generic/partial
dispatch owner loss; all deployed qualification and promotion obligations remain.

## 2026-09-13 maintenance-stage failure isolation

Progress: worker audit found certification listing/transition exceptions aborted
maintainSessions before hard retention and resource cleanup. Two causal tests
first failed with injected listing/transition errors. Certification listing and
each deadline update are now separately caught and error-logged; no failed
certification operation is marked successful. Later cleanup still executes.
Expanded negatives found the same interruption for remote retention listing and
local purge; those stages now record unconfirmed failure independently and allow
later authoritative recovery. A remote-list failure does not skip the local
hard-deadline purge attempt. Failed purge is never represented as success.

Tests use durable Memory controls with content already purged and confirm one
bound recovery dispatch and independently validated settlement despite each of
the four preceding failures. They also verify the local purge attempt occurs.
No production permissions, limits, retention deadlines or cleanup proof gates
were relaxed. Restart-safe queue fairness, recovery-list failures and later
maintenance stages still need separate work; this is not complete starvation
qualification.

Evidence: maintenance-isolation-red.json 12 pass/2 fail SHA256
d237f0fb62351f05dad666b0e058d9fed625c550b18f3052fa82a8861dea045e;
maintenance-retention-isolation-red.json 14 pass/2 fail SHA256
f081cbd59a2912f3f556fbe967081f49a9d572db084dac9c48be4c20f1ca2016;
maintenance-isolation-final.json 483 pass/0 fail/25 PG not selected SHA256
4e8e596e9edb88523d28a52c1d2085e872b10b2c3266e1a1a38627e380210e31.
Runtime/controller TypeScript and diff check passed. No production changes,
new resources or P01 attempts. Full VT00-C4 goal remains active.

## 2026-09-13 persisted retained recovery scheduling

Progress: removed the process-local retained recovery cursor from maintenance.
The ledger now schedules the least-recently selected outstanding, content-purged
controls. PostgreSQL records recovery_scheduled_at before external dispatch in
one bounded row-locking statement (SKIP LOCKED). Memory models ordering in its
ledger-owned state. Scheduling is separate from proof/version and is not an
exclusive execution claim or cleanup success. Auth auditing still precedes the
external recovery call; canonical settlement gates remain unchanged.

Added shared 13-obligation/10-batch test under persistent recovery failure: two
fresh workers reach all 13 while all control proofs/versions and 13 active
obligations remain unchanged. PostgreSQL repeats the test after closing and
reopening its connection pool between worker instances. No browser starts.
Inventory's stable-ID read-only pagination remains unchanged. Retry backoff,
raw-run queue restart fairness, database clock rollback and broader maintenance
failure isolation are not qualified by this test.

Unreleased extension adds recovery_scheduled_at and its partial scheduling index.
No live migration applied. Updated exact pins:
- historical baseline unchanged:
  9396354e67e47fc304cd9af1ff2d782f3fc6ba9c953e37475efe4965b57873a6
- recovery extension:
  45b11ae9ea280a7aad871cac86f9f5192e348a555b7bb6d0ce2e56690a8f861f
- composed migration:
  813d13627f8dc3aa48db3b2188d6545f6c2786062ecd9b189b8606ff5941655f

Full local suite with five PG service/scheduling tests selected: 489 passed,
0 failed, 21 other PG not selected. recovery-scheduling-final.json SHA256
ae2ae8c4a79803871b0a9bba406e64800b98b79fff5336581e16c15a9707382d.
Disposable database verified 0 lab schemas/0 other connections; PostgreSQL and
forwarding stopped, selected VM shutdown confirmed (49953 exit 0).
Runtime/controller TypeScript and git diff --check passed. No production
mutation, deployment, gate opening or P01 attempt. Full goal remains active.

## 2026-09-13 persisted retained-recovery retry cooldown

Progress: causal restart test observed 20 dispatches where 13 unique obligations
should be attempted once before retry eligibility (recovery-cooldown-red.json,
0 passed/1 failed, SHA256
cc985eeab477de2480cdf9c292851a0346b20920f46ae1fa455385d8771a950c).
Added shared fixed 30-second cooldown for already-selected retained controls.
PostgreSQL compares persisted selection time to its own clock; Memory models the
same eligibility with ledger-owned timestamps. Never-selected work is immediately
eligible. This does not change provider expiry, content retention, admission,
authorization auditing, proof versions or canonical cleanup acceptance.

Shared restart test now sees ten initial dispatches, three after restart, zero
on an immediate third worker, then ten eligible retries after the cooldown.
Memory uses a controlled Date clock; PostgreSQL waits a real 30.1 seconds and
reopens the connection pool between workers. All control proofs stay unchanged
and all 13 unresolved obligations remain active. Clock rollback remains outside
this qualification; no completed cleanup is inferred from scheduling.

Full suite with five PG tests selected: 489 passed, 0 failed, 21 other PG not
selected. recovery-cooldown-final.json SHA256
803b1e6d79db265dc0508b426613d9d5543eecb706484fb809d444b1730a98aa.
Runtime/controller TypeScript and git diff --check passed. Migration pins are
unchanged from the scheduling entry. Disposable PG reported 0 lab schemas and
0 other connections. No production mutation, P01 attempt or gate opening.
PostgreSQL/forwarding stopped and selected VM shutdown confirmed (77480 exit 0).

## 2026-09-13 complete local PostgreSQL regression qualification

Progress: selected all four dedicated database endpoints (main adapter, control,
owner-ingestion/worker and service), including the conditional owner helper.
Initial full run: 509 passed/1 failed/0 skipped. The owner helper expected a
second immediate dispatch after an injected post-lease-deletion rollback, which
conflicted with the new persisted cooldown. Preserved that failing evidence in
c4-all-postgres-current.json, SHA256
7bb2b02764e45a4015818b05264369cf4949a026b089e3e690ed8e25b4b2268d.

Corrected the test—not runtime cooldown or proof acceptance—to assert immediate
retry ineligibility, wait the real 30.1-second interval, then demand full bound
worker/transport/PG settlement and lease release. Its bounded test timeout rose
from 30 to 60 seconds to include that real interval. Existing rollback, version,
lease ownership, auth audit, immutability and zero-resource assertions remain.

Final full local Voice Lab suite: 510 passed, 0 failed, 0 skipped. Main migration
refusal/reference sealing, runtime ledger/retention/admission, control constraints,
independent owner/provider ingestion, settlement rollback, restart scheduling,
OAuth concurrency and local P01 transport tests all ran. They do not constitute
twenty built-product journeys, five deployed canaries or installed-plugin P01.
c4-all-postgres-final.json SHA256
b5a619f0eaf1619622082cb7b9e18b874e8309447e6d3843560ee8b39e387024.
Current base still 41b3322a1982387a408db3f52277a9f9450a438c with uncommitted
C4 changes; no new release SHA has been published. Runtime/controller TypeScript
and diff check passed. No production services or gates changed.
All four disposable DBs verified 0 lab schemas/0 other connections after tests.
PostgreSQL and forwarding stopped; selected VM shutdown confirmed (69388 exit 0).

## 2026-09-13 remote source and installed-access reconciliation

Read the complete 205-line operator runbook. Read-only git ls-remote confirms
codex/sophia-observability-v1 still resolves to
3add3336216e74324cd1ed4d3859caccc70c94fe. Local base
41b3322a1982387a408db3f52277a9f9450a438c contains 36 additional commits;
the C4 working changes remain uncommitted. Preserve the intervening memory work:
neither the old remote head nor the dirty local tree is a new exact release.
No merge, reset, push, migration, deployment or production gate mutation occurred.

The checked-in deployment-gates.yaml remains an unpassed historical template
(updated_at 2026-08-24), not current deployment evidence. Do not recreate resources
or promote its placeholders to PASS from the 510-test local result. Before a
release, reconcile outstanding recovery/upgrade obligations, complete the required
product/process evidence, package and commit the preserved candidate, and attach
fresh exact-release attestations in runbook order.

Installed get_capabilities again returned UNAUTHORIZED,
oauth_token_invalid_grant, TRIGGER_REAUTHENTICATION. No browser/provider run was
started; no live budget, deployment or resource state can be inferred from that
rejection. Installed-app reauthentication remains a separate live-test prerequisite,
not grounds to bypass the installed control plane. Aggregate provider-time limits
remain explicitly unlimited in the local Blueprint only; per-run/resource limits
and admission accounting remain enforced. Previously cancelled automation remains
cancelled; no replacement was created.

## 2026-09-13 maintenance-stage failure isolation

Progress: five causal tests reproduced short-circuiting of the expired-lease
check when retained scheduling, expired-run listing, terminal-recovery listing,
pending-evidence listing, or runnable-suite listing fails. Focused red result:
16 passed/5 failed; focused green: 21 passed/0 failed. Worker now logs each
unconfirmed stage and continues independent maintenance. Failed terminal queue
reads preserve the existing pagination cursor. Per-run evidence-publication
errors no longer prevent later resource checks; suite maintenance errors are
likewise isolated. No failed stage is interpreted as zero resources or success.

Initial broad run found one existing test expecting the old whole-tick rejection
after an orphan manifest write. Updated it to assert continued lease reaping,
while retaining all unpublished-evidence, immutable artifact and later revision/
orphan-pruning assertions. Final suite: 489 passed, 0 failed, 26 PostgreSQL tests
not selected on this turn. This is not a replacement for the prior all-PG run or
fresh PG qualification of these new worker changes.
maintenance-stage-isolation-verified.json SHA256
74acf5aa17f3b34cd3ae6a6e265b6ae9797d6e78d714e83132cea8947252d64a.
Runtime and controller TypeScript builds and git diff --check passed.
Per-active-lease failure isolation, raw queue restart fairness, remaining owner-
loss boundaries and required built/deployed journeys remain open. No production
mutation, resource allocation, gate opening, password change or P01 attempt.

## 2026-09-13 expired-lease batch isolation

Progress: causal test injects failure persisting the first returned lease's loss
observation; previously the second lease was never processed. Worker now catches
each loss-observation failure independently. The second bound loss observation
must persist, neither control becomes cleanup-complete, and both obligations
continue counting active. Focused red: 2 passed/1 failed; green: 3 passed/0 failed.
The test explicitly substitutes the returned expired-lease batch, so it proves
batch isolation, not adapter expiry or atomic expiry-to-observation persistence.

Full local suite: 490 passed, 0 failed, 26 PostgreSQL tests not selected.
lease-batch-isolation-final.json SHA256
a4ed33ee5d45adb32fc1bc869bed82ed125897aacc9b4571a86b6a03e79916b7.
Runtime TypeScript and diff check passed. No deployed services changed.

Next concrete durability gap: both Memory and PostgreSQL reapExpiredBrowserLeases
delete leases before returning them to the worker. A crash or failed loss write
after that deletion can lose the exact expired lease receipt needed by later
recovery. Immutable allocation/control authority still prevents false zero, but
does not itself prove that this reaper-to-observation gap can settle. Qualify and
repair that durable boundary before release; the new per-item catch is not its
solution. Per-active-lease maintenance isolation also remains outstanding.

## 2026-09-13 durable expired-lease observation

Progress: replaced destructive expiry enumeration with non-destructive observation
in both Memory and PostgreSQL. Renewal remains forbidden at/after the deadline;
allocation-once fencing still refuses replacement. The exact lease survives an
interrupted enumeration-to-loss-write boundary until explicit release/settlement.
No migration bytes changed. This preserves cleanup authority, not process-death
proof or permission to infer resource zero.

Memory boundary tests first failed when requiring repeated exact readback after
expiry. Strengthened the worker batch test to use actual zero-TTL ledger leases,
not a substituted enumeration: fail the first loss write, preserve both active
obligations, then use a new worker to persist the original exact lease binding.
PostgreSQL additionally verifies repeated readback from a new adapter connection.

Initial all-PG run: 508 passed/8 failed/0 skipped. Synthetic fixtures formerly
depended on expiry deleting leases and freeing capacity; added explicit fixture-
only releases after all no-reallocation/control-immutability assertions. A foreign
lease can trip either the retained ownership fence or allocation-once fence under
host/database clock skew; both forbid allocation and must leave receipt/control
unchanged. Same-owner and post-release replay retain the exact allocation-once
error assertion. No runtime gate or concurrency assertion was relaxed.

Final full suite: 516 passed/0 failed/0 skipped, all four PG endpoints selected.
lease-retention-allpg-verified.json SHA256
09c1302f7702cde2622b258951c27c101ef15cc2a9018c185d68c084691022ec.
Runtime/controller TypeScript and diff check passed. All four disposable DBs
reported zero lab schemas and zero other connections. PostgreSQL and forwarding
stopped; selected VM shutdown confirmed (87153 exit 0).
No production mutation, password change, gate opening or P01 attempt. Remaining
generic owner-death/settlement, per-active-lease isolation, raw queue fairness,
built-product journeys and exact deployed qualification are not implied complete.

## 2026-09-13 controller callback result ownership

Progress: re-read trial/controller/process/cancellation prerequisites. Historical
20-operation dynamic-injection proof is not twenty complete fresh-process built-
Sophia journeys. No existing evidence was relabelled to satisfy that requirement.

Found and causally reproduced late completion capture after controller unmount
or action replacement. The already-started visible callback could settle after
its page lost ownership and publish into current capture. Added mounted action-
owner publication fencing to the existing hook, without cancelling/replacing the
product callback or adding an activation path. Readiness pauses remain distinct:
the started action can still legitimately complete/fail as readiness changes.
Tests exercise delayed success and failure across unmount, action replacement,
and readiness pause, retaining exactly-one invocation. Focused red: 13 passed/
2 failed; focused green: 15 passed/0 failed. Driver completion/failure diagnostics
are not the canonical streaming/readiness gate; that gate remains unchanged.

Full frontend suite: 1991 passed, 0 failed, 2 skipped; TypeScript passed.
controller-result-ownership-frontend.json SHA256
858268afea080c1afe872f0875473c26758b47bcdccc126453ea995442cab979.
Test process confirmed exit 0 (36758); no background test process remains.
Bundled pnpm initially attempted an automatic install and refused ignored build
scripts. Reran via pnpm with its per-command dependency auto-install check off,
using existing dependencies; no dependency build approval or lockfile/package
change. No production mutation or P01 attempt. Built-Sophia journeys, current
installed-protocol parity and remaining owner/resource boundaries remain open.

## 2026-09-13 production frontend build prerequisite

Progress: executed pnpm production build of the current dirty candidate. Initial
compilation and TypeScript passed, but page-data collection refused missing
BETTER_AUTH_DATABASE_URL. No auth bypass or product auth change was introduced.
Rebuilt with a build-only synthetic secret and loopback port-1 database placeholder,
explicit verify-full TLS and NEXT_PUBLIC_DEV_BYPASS_AUTH=false. Google OAuth
credentials remained absent (warnings expected). Build completed, including all
62 static pages and dynamic route output; process 55307 exited 0. This is a local
build proof, not a usable authenticated environment, release artifact or deployed
voice journey. Rebuild with attested exact candidate/runtime configuration before
release; never deploy the placeholder configuration.

Build ID: df3Ms033_Lhg8hUmh9ukE.
app-paths-manifest SHA256:
8ec7b43b3f9830f332c11469b51ad98940d9b78cd1cd411017e6b65e9d1a8471.
routes-manifest SHA256:
8b366099cf8dc17fe2192a98c15e30ef43159642476056586b2cbe53b1f723b6.

Started that built app only on 127.0.0.1:3197 with the same placeholder settings.
Bodyless unauthenticated POSTs to test-auth/login and both Voice Lab control
actions returned 404 with no authorization receipt. Test-auth was not found;
both controls explicitly reported voice_lab_control_adapter_disabled. No browser,
microphone, grant, provider session or production target was used. Local server
stopped via its owning process handle (12741 exit 130); listener absence verified.

Reviewed existing voice E2E entry point: it uses next dev, auth bypass, browser-
storage seeding and DOM mic activation, so it is not admissible as the requested
VT00 built-Sophia qualification. Did not run it or label these three denial probes
as any of the twenty journeys. That broader proof remains outstanding.

Correction to prior tool housekeeping: pnpm's initial automatic install had added
placeholder allowBuilds entries to pnpm-workspace.yaml. Removed only those exact
tool-added placeholders; workspace policy, package.json and lockfile now match
their prior tracked bytes. No dependency permission was granted. Diff check passed.

## 2026-09-13 repository plugin asynchronous-contract reconciliation

Progress: repository SKILL.md prescribed operation_terminal for pending end and
omitted startup/assistant timeout classification, contradicting the shared C4
collector/verifier contract. Added one routed p01-asynchronous-flow reference for
all four observation phases, exact operation/cursor bindings, conclusive semantic
waits, shared ten-per-operation/twenty-total limits, adaptive receipts and final
manifest joins. Updated entrypoint/tool/scenario guidance without changing any
runtime gate, independent-certification requirement or failure limit.

Skill-creator and plugin-creator validators passed using the existing backend uv
environment (system Python lacked yaml). Validated repository marketplace name
personal and plugin name sophia-voice-lab. Ran the standard cachebuster helper;
no marketplace or installed cache was modified.
Local version: 0.1.0+codex.20260913145718.
Two identical sophia-plugin-tree-sha256-v1 computations: 12 files/46777 bytes,
8ddac7425097f62fd20c50e01bca2048c44d805da5f9ff5d01d4d69291099adf.
Selected collector/live-boundary/external-attestation regressions: 27 passed,
0 failed, 0 skipped. p01-package-contract-reconciliation.json SHA256
6efc0179c51268a417c01e245306c1e5b297a1abebc6556e0fa798e97c32070d.
These tests validate runtime semantics, not independent agent compliance with
prose or fresh installed-platform qualification. Diff check passed.

Installed cache remains the old 20260826110843 package and was not edited.
Commit/deploy exact candidate, verify service package identity and then collect
real installation/fresh-task evidence in runbook order. No production environment,
password, gate, authentication connection or P01 attempt changed this turn.

### Connection-refresh UI checkpoint — 2026-09-13

The installed ChatGPT Sophia Voice Lab settings exposed Connection Reconnect.
Invoking it opened a fresh consent request for the existing fault/read/run scopes.
The existing Render consent secret was accessed without printing its value;
neither an AX set-value nor a supported locator fill retained a value in the
consent input (read-only DOM check: hasValue=false). The one Approve attempt
therefore did not establish a refreshed connection. No successful authorization
or voice test is claimed. The input is enabled, writable, type=password with
maxlength=512; the root cause of value loss remains unproven.

Render secret visibility was restored to masked and the temporary settings tab
closed. The consent tab was retained for handoff. No passwords, scopes, production
gates, deployments, migrations or budgets were changed in this checkpoint.
Automation cancellation and local aggregate-budget removal remain as previously
recorded; production qualification and exact release remain outstanding.

### Active-lease maintenance isolation — 2026-09-13

Current source confirmed that active-run/lease lookup and heartbeat exceptions
escaped before the independent expired-lease scan. Extracted the existing lease
maintenance body without changing its D02, TTL, kill-switch or cleanup decisions.
The caller now visits remaining active leases and expired receipts before
rethrowing the first active-maintenance failure. Failures remain logged and
observable; a failed read does not synthesize loss, cleanup or replacement.

Three causal negatives inject getRun/getBrowserLease/heartbeatBrowserLease
failure after ordinary worker start, with a second healthy synthetic driver
session and an expired ledger-only obligation. They prove continuation for the
second session, durable loss observation for the expired receipt, three remaining
admission obligations, and next-pass continuation of the first session with the
same owner/lease epoch. These are local worker/ledger tests, not built-Sophia
journeys, physical browser sessions, provider termination proof or deployed tests.
The existing D02 drift rejection tests remain unchanged and pass.

Initial fixture failure (missing readiness stub), causal red failures, and the
intermediate focused result are retained. Broad attempt without Node on child
PATH produced 15 fixture-process exit-127 failures; rerun with the documented
Node 22 PATH passed 493 tests, zero failures, 26 PostgreSQL tests not selected.
active-lease-isolation-broad-verified.json SHA256:
0dc3a94c4097e3c4615fab47c16699019f6595eba0979aa1b02ead03f84dee23.
Runtime and external-controller TypeScript checks passed. No adapter/schema
changes, production changes, gates, secrets or official P01 attempts this turn.
Hung-call bounds, restart fairness, exact release, fresh installed-root P01,
20 complete built journeys, five deployed canaries and canonical suite remain
required before PROMOTE VT00; this checkpoint does not satisfy them.

### Live release and product-obligation reconciliation — 2026-09-13 15:18 UTC

The previous turn was progress (lease isolation plus verified local regressions).
Fresh git and external reads now independently reconfirm local HEAD 41b3322a,
remote target branch 3add3336, MCP/worker e3b40f1b and product/memory 8d0d6d33.
Public frontend deployment is dpl_4YLNzsHb1LJaqQEfCXECVaJD7pt5. Product identity
reports mem00.v1/epoch 1; that is not complete memory-isolation qualification.
Installed get_capabilities still rejects with oauth_token_invalid_grant.
MCP readiness reports one settled kill-switched worker and zero active runs,
but mismatched product identities and unavailable signed frontend readiness.
Gateway and Voice mutation gates are closed; Gateway admission is also false.

Critically, Gateway retention readiness is degraded with two pending obligations.
Read-only SELECTs in the signed-in product Supabase editor independently found
exactly two closed, overdue session_provisional obligations from September 3.
Both still join to synthetic V-F01 session metadata. The 19:24 UTC obligation has
live-cleanup and provider-settlement fields populated, provider state closed,
receipt arrays and zero admission rows, but no terminal retention completion.
The 20:18 UTC obligation lacks live-cleanup and settlement fields, retains one
overdue browser_active provider admission, reports provider state active and has
neither browser-close nor activation-abort arrays. Both use the provisional
session-created retention anchor. No raw identity, transcript or credential was
selected. One initial metadata query used an absent session_id column and failed;
the corrected metadata-presence projection succeeded without changing data.

The Gateway log search exposed no retention-specific diagnostic in its last-hour
window. Its repeated Voice disconnect already-gone message does not establish
the owning process or provider is dead. Source review confirms that a remaining
activated admission intentionally requires an owning completion callback rather
than accepting a load-balanced absence. Do not delete the admission or fabricate
receipts to unblock readiness. The first obligation's exact blocking component
remains unproven; its stored live-zero checkpoint alone does not authorize purge.

Evidence: ../vt00-c4-evidence/live-reconciliation-20260913-1518.json, SHA256
cfbd8828bc251b4e7b56aafe5ecc5a5f41e492340957f389780d67c71c0513d1.
This is a bounded content-free read-only projection, not a new signed deployment
or complete zero-resource attestation. No production gates or data were changed.
Next operational work must reconcile these two historical product obligations
(terminal receipt replay/retention for the first; independent owner-loss/provider
settlement for the second) before treating zero MCP runs as a release prerequisite.
The isolated harness v3 historical inventory and v4 upgrade attestation remain
separate, outstanding requirements; this product query does not replace them.

### Deployed read-only retention dependency diagnosis — 2026-09-13

The preceding turn was progress: actual product backlog enumeration changed the
release prerequisite assessment. This turn used the existing Gateway web shell
and deployed Python environment, with PostgreSQL read_only=true, a 10-second
statement timeout and at most three obligation rows. It invoked only pure
receipt/binding validators and SELECTs; no recovery, provider, grant, purge or
cleanup mutation was invoked. Credentials remained in the existing environment
and raw session/principal/provider IDs remained inside the diagnostic process.

The deployed _provider_terminal_settlement_sha256 reproduces a valid digest for
the 19:24 obligation and it equals the stored settlement. The 20:18 obligation
has no valid terminal receipt digest. Complete isolation-bound metadata validates
for both through the deployed _obligation_from_session. An initial minimized
projection omitted the seven required isolation booleans and failed validation;
that diagnostic defect was corrected by including their existing stored values,
not by changing the records or validator.

The first obligation sees exactly one other-run lab auth session and one other
active grant for the same principal. The second sees its own single lab auth
session and no other-run active grant. These observations satisfy the deployed
auth_active_run_conflict predicate for the first obligation: its provider closure
is valid, but the second obligation blocks auth cleanup. No mutating recovery call
was made, so other simultaneous component blockers are not excluded.

The activated second obligation has a stored activation receipt but no close or
abort arrays. Its top-level synthetic metadata has no owner/worker/instance/lease
field; that limited key inventory does not prove that independent historical
ownership evidence is absent elsewhere. The unactivated-provider abort path is
explicitly inapplicable to this browser_active admission. Do not weaken the
cross-run auth check or turn a current Voice instance's absence into termination.

Evidence: ../vt00-c4-evidence/retention-dependency-diagnostic-20260913.json,
SHA256 1b4c6495e3534f1d345a8d252f41ea20af19428d595b940e1e699237ae3bfdbd.
The next recovery frontier is historical activated-provider owner/settlement
evidence for the second V-F01, alongside the independent harness v3 inventory.
No production gate, schema, credential, application code or P01 count changed.
PROMOTE VT00 remains unproven; safe reconciliation and implementation work remain.

### Authoritative isolated-v3 inventory — 2026-09-13 15:31 UTC

Previous turn: progress, because deployed receipt validation and auth-conflict
counts narrowed the historical cleanup dependency. This turn inspected the
existing MCP service's isolated database through its installed pg client and
existing environment. Both diagnostic transactions were repeatable-read,
read-only with 15-second statement bounds; neither initialized a worker nor
executed migration, schema seal, test control or cleanup.

Exact schema v3/base checksum 9396354e67e47fc304cd9af1ff2d782f3fc6ba9c953e37475efe4965b57873a6
is present. At 15:31:43.221Z the ledger had zero runs, operations, run events and
browser leases, but 136 retention tombstones: 3 remote-confirmed and 133
remote-unconfirmed. Unconfirmed purge timestamps range from August 26 18:31 UTC
through September 5 20:45 UTC. This independently establishes that raw historical
ownership/event evidence is no longer in these live tables. It does not prove
zero external resources or nonallocation. Do not equate all 133 tombstones with
live leaks either: their histories still require reconciliation.

A second bounded read fingerprinted all 136 ordered tombstones (limit 1001,
reject above 1000) as 1d6610358ec282714a2c7ee485fa537931938ac16d6d010766e4349667eeb341.
No controls were expired; the first scheduled control expiry is September 25,
16:12:23.031Z. Only a hash/count projection was exported, not a tombstone backup.
No control lifetime was extended. A focused filename inventory across the shared
workspace and outputs found no September 3 canary/owner-attestation bundle;
this does not exhaust platform task history or external archives.

Evidence: ../vt00-c4-evidence/isolated-v3-inventory-20260913.json,
SHA256 52790ece82a3c1c5cbce9a7433f33dce2aca315ee026000fd0661e4cc8bd2a0c.
This is read-only SQL enumeration, not execution of the uncommitted C4 CLI,
independent historical backfill attestation or v4 upgrade authorization. The
empty content ledger must not bypass the 136 tombstone reconciliation gate.
Next evidence sources are independent platform/deployment history and exact
product-to-retention HMAC joins; preserve the two product obligations and every
remaining tombstone. No live test, schema change or official P01 attempt occurred.

### Exact product-to-tombstone joins — 2026-09-13

Previous turn: progress, with the authoritative v3 inventory preserved. This
turn correlated both overdue product obligations to exactly one unconfirmed
retention tombstone each. Existing recovery-secret HMACs were computed inside
Gateway using the deployed domain-separated recipe; only non-authorizing hashes
were transferred to a bounded read-only MCP database lookup. No raw cleanup ID
or credential was exported.

The 19:24 V-F01 content was purged September 3 at 20:24:13.071Z; its control expires
October 3 at the same time. The 20:18 activated-provider V-F01 content was purged
September 5 at 20:45:09.552Z; its control expires October 5 at the same time.
These joins narrow historical recovery but do not establish provider settlement,
owner death, cleanup completion or upgrade authorization. Both product records
and all tombstones remain untouched.

Evidence: ../vt00-c4-evidence/product-tombstone-joins-20260913.json,
SHA256 d81fda68fe16e275fe382b8cd1f8d67e801a7d5dd80c2d80ad46990270df4a4b.
A bounded platform task inventory located the current observability task; its
two newest turn summaries contained no historical receipts. This is not an
exhaustive history search and does not prove earlier owner evidence absent.
Both temporary diagnostic shell tabs were closed. No live test, gate change,
schema change or official P01 attempt occurred. Aggregate budget removal remains
local, the requested automation remains cancelled, and PROMOTE VT00 is unproven.

### Bounded expired-lease observation pages — 2026-09-13

Previous turn: progress, because exact product-to-tombstone joins narrowed the
historical recovery frontier. Current source inspection found expired browser
receipt observation still returned the entire retained backlog in one batch.
Both adapters now enforce integer page limits 1..100, default 100, ordered by
run UUID with an exclusive continuation key. PostgreSQL retains its database
clock for production expiry checks. No schema change or receipt deletion.

The worker requests ten receipts per pass, wraps at exhaustion, and advances
only after successful listing. Failed loss writes do not pin the page. A causal
12-obligation test proves first-page bounds, unchanged cursor on a failed read,
later-page discovery, wrap/retry of a failed loss write, and preservation of all
12 leases/admission obligations. Memory adapter coverage also proves ordering,
exclusive continuation, replay and rejection of invalid limits. PostgreSQL
integration assertions were extended but not executed in this turn.

Initial worker test timed out at its default 15 seconds during the real bounded
cleanup retry delays; the initial red JSON is preserved. Only this test's bound
was increased to 60 seconds, not production retry/operation limits. Focused
verification passed 11 tests. Full local lab suite passed 495 tests, zero failed,
26 PostgreSQL tests not selected. Runtime and external-controller TypeScript
checks and git diff --check passed.

Evidence: ../vt00-c4-evidence/expired-lease-pages-broad.json,
SHA256 e35a1be2393cf92133c6b3bfe68f102c3ab318646519adfc5a2fbb4a50d7c6cd.
Focused report: expired-lease-pages-focused-verified.json,
SHA256 fbb9b5a37439773e25a0e4467740ca221b9e0ddae75f76d907873562c3444193.

The cursor is in-process: this is not restart fairness, a query wall-time bound,
owner-death evidence, or deployed qualification. Real PostgreSQL verification
of this adapter delta remains required before release. Historical provider
settlement, exact release, twenty complete built journeys, five deployed
canaries, fresh installed-root P01 and canonical-suite closeout remain open.
No live gates, credentials, data, deployments or official P01 count changed.

### Real PostgreSQL paging verification — 2026-09-13

Previous turn: progress, with bounded adapter/worker scans and causal local
tests. This turn extended the PostgreSQL test to twelve retained expired leases,
exclusive ordered pages (ten plus two), exhaustion, and exact lease readback
through a new connection. Every assertion passed on PostgreSQL 18.6. This is
connection restart/readback, not worker restart fairness or provider settlement.

The isolated mem00-qualification VM was confirmed stopped before use; its old
temporary cluster was absent. A new loopback-only cluster was initialized at
/tmp/sophia-c4-pages.QXBBnNgN/data and a UTF8 database named
voice_lab_test_c4_pages_20260913 created. The actual forwarded connection
independently confirmed that database, vt00_test role, loopback address, port
16432 and PostgreSQL 18.6 before reset-capable tests were run. The first attempt
omitted the explicit test-reset environment flag and the guard correctly refused
setup; that red report is retained. The rerun supplied the flag for this exact
disposable database, without weakening any code guard.

Full selected suite: 510 passed, zero failed, 12 separate database tests not
selected. All 15 postgres-integration tests passed, including paging, expired
heartbeat fencing, historical migration refusal, ownership retention, P01
envelopes and OAuth replay. Runtime TypeScript and diff checks passed.
Evidence: ../vt00-c4-evidence/expired-lease-pages-allpg-verified.json,
SHA256 69741fc79d33cecca21bf9a5854e3da37ead5417b9a33964302d99f3d8b81467.
The filename does not imply all optional database suites ran; twelve were not
selected. No deployed P01 or built-product journey is counted by this result.

After tests the dedicated database independently reported zero test schemas and
zero other connections. PostgreSQL stopped cleanly and its exact SSH forward
was cancelled. No production database, memory-campaign database, credentials,
gate, deployment or historical obligation was modified. Disposable cluster files
remain; only the test suite's synthetic schemas were removed.

### Runtime ledger database wait bounds — 2026-09-13

Previous turn: progress, with actual PostgreSQL expired-receipt paging proof.
Source inspection found runtime ledger pools had no connection-acquisition,
server-statement or lock-wait bounds. PostgresVoiceLabLedger now supplies a
5-second connection/pool acquisition timeout, a 5-second server statement
timeout and a 2-second lock timeout. These use the installed pg client's startup
parameter support; no client-side query race is used to pretend a mutating
server statement stopped. Migration clients retain their separate existing
timeouts. No cleanup success or lease release is inferred from a timeout.

One causal real-PostgreSQL test verifies SHOW-equivalent settings, pg_sleep(30)
cancelled with server code 57014, an exhausted single-client pool timing out,
and an access-exclusive table lock causing the actual expired-lease read to
fail with 55P03. Elapsed lower/upper bounds are asserted; subsequent queries
and the lease read succeed after each failure/release. The combined test passed
in 12.053 seconds. Full selected suite: 511 passed, zero failed, twelve separate
database tests not selected. Runtime/controller TypeScript and diff checks pass.

Evidence: ../vt00-c4-evidence/runtime-db-bounds-verified.json,
SHA256 0978b5906760695978e3b257d488809440210ebc38499db6390275d7910feecd.
This is actual PostgreSQL 18.6 behavior, not production transport qualification.
Silent network stalls, total multi-query pass deadlines and durable raw-queue
restart fairness remain unproven; these settings do not claim to close them.

Testing used a new UTF8 loopback-only cluster at
/tmp/sophia-c4-timeouts.q4kh7dKU/data in mem00-qualification, with independently
verified database voice_lab_test_c4_timeouts_20260913, vt00_test role and port
16432. The old temporary cluster was absent on VM restart. After tests, exact
database readback showed zero test schemas and zero other connections;
PostgreSQL stopped cleanly and the exact SSH forward was cancelled. Only
synthetic test schemas were removed; disposable cluster files remain. The
unrelated memory VM was untouched. No production gate, migration, credential,
deployment, historical obligation or official P01 count changed.

### C4 journey qualification checkpoint reconciliation — 2026-09-13

Previous turn: progress, with runtime database wait bounds verified on actual
PostgreSQL. This turn revisited the built-product qualification frontier. Current
voice-webrtc.spec.ts still uses browser-state seeding and DOM microphone clicks;
it is not admissible for the requested twenty journeys. The owning control hook
and call sites were inspected without adding an activation path or runtime.

Found a checkpoint gap: deployment-gates.yaml represented twenty deterministic
audio trials but omitted the distinct C4 twenty-complete-journey requirement.
Added an explicit unpassed, empty-evidence gate with independent process/run and
exact built identity, ordinary authenticated controller, current readiness,
input/output, finalization, settlement and durable-export requirements. Kept
audio trials, five deployed canaries and fresh installed-root P01 separate.
The campaign report and runbook now preserve this distinction explicitly.

Also replaced the checkpoint's obsolete arbitrary-long-poll exclusion with the
current ten-call semantic spine, ten polls per operation, twenty total and
ten-second per-poll bound, including finalization's four required facts. Two
checkpoint-shape regression tests pass; diff check passes. These are documentation
contract checks, not runtime admission enforcement or journey execution. No new
journey, canary or official P01 is counted.

Evidence: ../vt00-c4-evidence/c4-qualification-checkpoint.json,
SHA256 ec521e7d50e61168d8c4089a4a98ea537768986eabffbe34593ab212aa78165b.
The actual executable complete-journey collection/verification path remains
required, alongside historical cleanup and exact deployment prerequisites. No
production mutation or gate change occurred; PROMOTE VT00 remains unproven.

### Shared executable P01 limits — 2026-09-13

Previous turn: progress, with the missing complete-journey checkpoint made
explicit and historical audio trials excluded. Current collector/schema/verifier
inspection found independently repeated P01 numeric bounds. Added frozen
P01_LIMITS and derived chronological maximum to the existing p01-contract.ts;
the service submission schema, signed verification checks and independent
platform collector now use those constants. Exact policy remains ten semantic
calls, ten polls per operation, twenty total, ten seconds per poll. No sequence,
settlement predicate, authority or budget was widened.

The checkpoint regression now compares its limits with the executable contract;
an additional fixed-value assertion prevents a coordinated accidental policy
change from passing just because both sides moved together. Runtime and external
controller TypeScript pass. Broad local run passed 497 tests, zero failed,
28 database tests not selected. After the final collector output literal was
replaced and the fixed-value test added, focused collector/live-boundary/checkpoint
tests passed 19/19, zero skipped. The broad report predates those final two small
edits and is not claimed as full final-tree verification. Diff check passed.

Evidence: ../vt00-c4-evidence/shared-p01-limits.json,
SHA256 c8fbab3c16f00dd56a93a15fe0ec540cb9e9d4d7f299b2012761a3ae0f1839a2.
Final focused report: shared-p01-limits-final-focused.json,
SHA256 a2479440df61e6136ac04e8fbe12f055cf6af9b426b1e9b0bda26d636a17c779.
These are local contract/integration proofs, not a new installed-root P01 or any
of the twenty built-product journeys. No production gate, resource, migration,
credential or deployment changed. Historical cleanup and exact qualification
remain outstanding.

### Live connector and advertised-schema recheck — 2026-09-13

Previous turn: progress, with shared executable P01 limits. A fresh installed
get_capabilities call still returned UNAUTHORIZED / oauth_token_invalid_grant /
TRIGGER_REAUTHENTICATION. No voice run was started. Worktree remains detached at
41b3322a1982387a408db3f52277a9f9450a438c with 113 changed/untracked entries at
this check; no candidate was committed or deployed.

Opened the existing registered app's signed-in connection settings and used its
Reconnect action to obtain a fresh consent request for the existing read/run/fault
scopes. Its advertised wait_for_turn condition enum lacked finalization_complete;
this is visible registered-schema evidence, not a new live server version claim.
The registered connection therefore still needs exact C4 package/schema parity
after the deployment prerequisites, independently of reauthentication.

Used the existing Render consent secret only in the authorized Sophia consent
form, without printing or changing it. Supported paste and direct typing each
reported no value via content-free DOM inspection. The input was connected,
enabled, not read-only, type password, in a POST /authorize form. Password-field
inspection may itself be limited, so no root cause is asserted from that alone.
An authorized Approve click did not redirect or visibly complete consent. The
Render field was remasked, temporary credential variables cleared, and temporary
environment tab closed. Consent tab 105 was retained for continuation; it will
require a new request after expiration. No security bypass or password reset.

Plugin-management guidance found no callable dedicated reconnect tool. Official
OAuth documentation consulted: https://developers.openai.com/plugins/build/auth.
The skill-prescribed live lane remains unavailable; no local-runner substitute,
test, gate change or historical cleanup mutation was attempted. This check does
not prove completion or a new P01 failure. Independent implementation and
qualification work remains; goal is not marked blocked or complete.

### Missing-child suite admission fence — 2026-09-13

Previous turn reconfirmed a live authorization blocker and advertised-schema
mismatch; it did not execute a journey. Current source inspection found that
#advanceSuites filtered missing children before deciding whether to consider new
admission. Unlike terminal evidence publication, it did not check that all
recorded children were present. Unknown historical state could therefore be
treated as an empty/completed prerequisite subset.

Added a causal test with an existing suite whose prior recorded child cannot be
read. Before repair it failed because countActiveRuns was reached once; after
repair scheduling stops before that admission check, creates no run, preserves
the exact suite child list/index/state, and publishes no suite evidence. This
proves the missing-child admission fence, not that the old path successfully
allocated resources under every later gate. The worker now logs only a suite
hash and expected/observed counts and leaves history intact.

Full local suite: 499 passed, zero failed, 28 PostgreSQL tests not selected.
Runtime/controller TypeScript and diff checks pass. Red and green focused
reports are retained alongside suite-missing-child-broad.json,
SHA256 59a117e05f3c0dc84f0506620459acc47f53d7a0231e5e40ac38566ffefb9e67.
The historical recovery path must still reconcile missing children; this fence
does not recreate raw data or infer cleanup. No live test, new official P01,
deployment or production gate change occurred. Full campaign remains unproven.

### Shared suite child-binding validation — 2026-09-13

Previous turn: progress, with missing-child admission fencing. The adjacent
scheduler and evidence paths still trusted the child list without checking its
complete suite binding. Added suiteChildrenMatchDefinition to all three sites:
advancement, terminal-suite evidence selection, and final evidence construction.
It verifies supported-scenario prefix/order and counter bounds, exact run list,
caller, configured dedicated principal, environment, target and capture policy.
Run IDs, test-run IDs and cleanup IDs must be independent across children.
Declared unsupported slots are skipped, never represented by a reused run.

New unit matrix has sixteen mismatches (including all children under the same
foreign principal) plus valid exact/unsupported/empty initial-prefix cases.
Rejection leaves the inputs unchanged. Existing worker missing-child negative
and suite-evidence integration tests remain green. This proves local binding
validation, not fresh process ownership, signed cleanup or full journeys.

Final full local suite: 516 passed, zero failed, 28 database tests not selected.
Runtime and external-controller TypeScript and diff checks pass. Evidence:
../vt00-c4-evidence/suite-child-binding-final.json,
SHA256 abb94753651f250c87916acf72196aa8f16ad378c6b82d652769fa0cf094d639.
No production gate, deploy, credential or historical record changed. Exact
deployed qualification and historical resource reconciliation remain required;
no canary, complete built journey or official P01 was counted.

### Lifecycle-aware shared suite verdict — 2026-09-13

Previous turn: progress, with exact suite-child binding. The aggregate still
derived certification solely from cached verdicts: active, pending-evidence and
cleanup-incomplete rows could project certified, and an empty set projected
certified by vacuous truth. Four new negatives reproduced these cases (17 old
tests passed, four new tests failed). Added lifecycle/cleanup checks to the
aggregate, and made the scheduling decision consume that same projection.

An unsupported-only suite can finish scheduling but explicitly reports
not_certified/no_supported_children. Valid terminal D02 aborted-driver runs can
still certify from complete evidence. An additional test verifies terminal
unavailable-evidence verdicts remain pending in both decision paths. Existing
product-pass/unavailable/mixed and D02 certified-outcome tests remain green.
These checks validate lifecycle fields, not independent owning-process or
provider settlement receipts; the latter retain their existing proof gates.

Final full local suite: 521 passed, zero failed, 28 database tests not selected.
Runtime/controller TypeScript and diff checks passed. Evidence:
../vt00-c4-evidence/suite-lifecycle-shared-final.json,
SHA256 48618f10b31977892cdde28077df3b21d19493bf45f17020d62af21b30ed159b.
Red report suite-lifecycle-red.json is preserved. No production mutation,
deployment, live run or P01 attempt occurred; campaign attainment remains open.

### Combined current-tree PostgreSQL verification — 2026-09-13

Previous turn: progress, with shared lifecycle-aware suite certification. This
turn ran the current lab tree with all four optional database endpoints enabled:
base adapter, staged recovery controls, authenticated D02 service and retained
owner ingestion. Full result: 549 passed, zero failed, zero skipped. This includes
the runtime timeout changes, retained recovery restart scheduling, owner/provider
ingestion, P01 contract integration and suite binding/verdict regressions together.
It does not turn their synthetic product/owner fixtures into deployed receipts.

Source identity was checked both during and after execution: 152 sorted tracked
and nonignored untracked files under tools/sophia-voice-lab plus the base SQL
backend/migrations/2026_08_23_sophia_voice_lab.sql. SHA256 of JSON.stringify of
sorted {path,sha256} objects was unchanged:
6835a99a43fa3197961dec943f49da89cee8012512667af860540ba624569bf2.
Base HEAD remains 41b3322a1982387a408db3f52277a9f9450a438c; this is a dirty-tree
test identity, not an immutable release commit or complete product-tree hash.
Runtime/controller TypeScript passed. Test report c4-combined-allpg.json SHA256:
7086e10c3a681413d47ecf8ff0742fca3df036c4e52378ef7cc209f5ef30942e.

Four newly created UTF8 databases in a loopback-only PostgreSQL 18.6 cluster at
/tmp/sophia-c4-combined.MtUU5TLq/data were individually identified before reset:
voice_lab_test_c4_combined_20260913, voice_lab_test_c4_control_combined_20260913,
voice_lab_test_c4_service_combined_20260913 and
voice_lab_test_c4_owner_combined_20260913. Each independently reported zero
remaining test schemas and zero other connections after the suite. PostgreSQL
stopped cleanly; exact port-16432 SSH forwarding was cancelled. Only synthetic
test schemas were removed; the stopped disposable cluster files remain.
The unrelated memory VM was not modified. No production gates, credentials,
historical obligations or deployments changed. All complete built-product
journeys, deployed canaries, fresh installed-root P01 and promotion remain open.

### Scoped historical tool-response recovery — 2026-09-13

Read only this task's retained rollout, filtering original response timestamps
to September 3, 19:00–20:59 UTC. The window contains 441 original custom tool
responses; 22 contain selected scenario/settlement markers. No credentials or
full raw responses were exported. This is historical evidence discovery, not
live settlement or a resource mutation.

The 20:26:31.864Z response at rollout line 258404 includes run
6cc3c9a0-0c9d-49f3-8da6-bd8d364c9a4b and test run
fbec2095-a4e0-433d-9107-828f196aa4d5. Its original output-string SHA256 is
eca7dba2604ae5e6a251b752a6245f3e4df22418b1bb17ee3372cc7c729282f7.
Selected historical fields include browser_registry_absent=true,
browser_process_disconnected=true, browser_process_close_resolved=true,
provider_spend_live=false, provisional_cleanup_only=true,
retention_purge_pending=true, complete=false and
cleanup_admissions_pending=1. These are projected fields from a composite tool
response, not yet a validated signed receipt with established field provenance.
Do not interpret their coexistence as provider settlement or owner-death proof.

Next reconciliation must recover the enclosing receipt schemas and exact
ownership/binding provenance, independently join the product obligation and
retained tombstone, and validate signatures if available. Historical response
presence does not waive the live zero-resource gate or the populated-v3 upgrade
attestation. No production change, live journey or official P01 was counted.

The subsequent provenance check found the response's second text block is
exactly 20,000 characters and ends inside JSON; parsing the complete block fails
with an unterminated string. Intact nested event objects were parsed separately,
without completing or inventing truncated fields. Event 786 is a browser-source
cleanup.browser_context_closed receipt under
sophia_voice_lab_execution_epoch_browser_cleanup_v1. SHA256 of JSON.stringify
of that intact event is
fd915dfe7edbf2c72a9cecd65236fffe569125106cf9ec66dd2f93ff807791ad.
It binds the run hash
54db564ccca15d083c40eb507a02e4685b614dbee424377b7763071ad4a4ccc0,
cleanup hash d2cf113b23759fec1b4b28e0ed3541b56e7b55a81c17c85f8c55209adf2731b9,
process hash 0fecf9247f3ddc84db8a804fa3065c013baf6b7c2458c2ba2bf56c2e1d42ddd4,
boot hash 80ad11719a95b36f22df02497e2df04c8dc9817c4f84c66809f448cf24b401e7,
and execution epoch
5e0e5790219d6a0b24666e5724685861101c6dc980ed3aec322200403d24b5e2.

Immediately preceding event 785 is canonical auth.session_cleanup with the
same ownership hashes but confirmed=false (event hash
f13a043254584aad9474ba52f9a3b4fa77c36500cda319aa4b3a7c8d247cb71f).
Additional intact recovery events through the sampled 20:50 responses report
complete=false and HTTP 202. No process/runtime acquisition markers appeared
in original tool responses in the bounded lines 258180–259100. This is a scoped
search, not proof that acquisition evidence never existed elsewhere.

Current deriveExecutionEpochCleanupProof explicitly requires acquisition and
runtime lease bindings plus either direct provider/auth cleanup before process
closure or authoritative complete recovery afterward. The recovered close
event alone therefore cannot release a lease, settle the provider, or pass the
historical upgrade gate. No signature or current provider zero was established.

### Execution receipt envelope binding — 2026-09-13

Previous turn: progress, recovering historical receipt provenance without
claiming settlement. Inspection of the current pure ownership and cleanup
verifiers found they checked payload ownership hashes but not LabEvent.runId.
Added causal negatives changing only one event envelope to a foreign run while
leaving the otherwise valid payload intact: both acquisition events, all five
direct cleanup events, and the authoritative-recovery event. All eight new
cases failed before repair (six existing tests passed).

Both deriveExecutionOwnership and deriveExecutionEpochCleanupProof now reject
a supplied event list containing a foreign run envelope before deriving proof.
The former throws a binding error; the latter returns not-ready with no proof
digest. Existing valid direct and recovered cleanup paths remain covered.
This validates local envelope consistency, not event source authenticity or
independently signed provider settlement. It does not repair the historical
missing acquisition/auth/provider evidence by inference.

Full local lab suite: 529 passed, zero failed, 28 optional database tests not
selected. Runtime and external-controller TypeScript and git diff checks pass.
Report execution-envelope-full.json SHA256:
57f5e9c2340ac96aad5672e362802f98e2aeb69eafb31d0d8920f0ca963b7854.
Red report execution-envelope-red.json is retained. Earlier 549-test combined
PostgreSQL verification predates this change; do not cite it as current-tree
database verification. No production changes, live runs or P01 attempts occurred.

### Installed connection and consent-input revalidation — 2026-09-13

Previous turn: progress with execution envelope binding. Fresh installed
get_capabilities still returned UNAUTHORIZED/oauth_token_invalid_grant. The
registered app settings still advertise the older wait_for_turn enum without
finalization_complete. Existing Reconnect generated a fresh consent request for
the unchanged read/run/fault scopes.

Used only the existing Render SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET, privately
verified clipboard equality against its revealed row, then remasked Render.
AX setValue populated the password field: the screenshot showed masked input
and read-only DOM validity reported valueMissing=false, valid=true. Both the
AX Approve activation and the exact submit-button locator left the same consent
page visible; subsequent installed capabilities remained unauthorized. Thus
the earlier empty-input hypothesis does not explain this attempt. No successful
redirect or token exchange was observed. Browser logs provided no specific
consent-submission error (an older compliance-settings error is not causally
attributed to the form). No root cause is asserted.

Native-app inventory reported the Mac locked; in-app browser inspection still
worked. Do not claim that lock proves the browser submission failure. Cleared
the agent-copied clipboard secret, consent input, and temporary secret variables;
closed both newly created tabs. No password, permission scope, deployment,
resource obligation or live test gate changed. Connection refresh remains open.

### Reproduced consent redirect policy defect — 2026-09-13

Previous turn: progress narrowing the consent failure beyond empty input.
Both local and deployed e3b40f1b21739479db239c383ce88285ce740152 oauth.ts
line 628 set form-action 'self', while successful approval returns HTTP 303
to the pinned cross-origin ChatGPT callback. W3C CSP form-action navigation
checks and documented browser differences motivated a credential-free local
probe, not a claim that production logs had already established the cause.

oauth-consent-navigation-probe.mjs serves two loopback origins with no real
authentication, provider, credentials, or external requests. In the current
in-app browser, /self sent one POST but reached zero callback requests and
left the form visible. Permitting the local callback origin completed the
redirect (counters POST=2/callback=1). A separate fresh-process probe with the
full callback URL, including /complete, also completed (POST=1/callback=1).
The diagnostic browser pages were closed and both exact server processes
terminated cleanly. This is an OAuth navigation diagnostic, not a voice journey.

Changed the consent CSP to allow 'self' plus the existing fixed
CHATGPT_STABLE_REDIRECT_URI constant; no wildcard or caller-supplied URL is
accepted. CSRF, secret checks, one-time request consumption, PKCE, pinned client
validation, script/base/frame restrictions and live gates are unchanged.
The exact-header regression failed before repair (29 passed, one failed), then
the full local suite passed: 529 passed, zero failed, 28 database tests not
selected. Runtime TypeScript and diff checks passed. Full report
oauth-callback-policy-full.json SHA256
321a785198a4f8216c5866f0424cb54131a67d2cf8e6ceaa5cc37941fcc9af82;
red report SHA256
a3eac10670954f7358d21b48a8ca9800cf1b3e1802a4170dd9e51e3a0d0b32ee.

This reproduces a browser defect consistent with the observed production
symptom. The repair remains local: no exact release, deployed authorization
refresh, token exchange or installed capabilities success has been claimed.
Historical settlement and v3 upgrade gates remain independently unresolved.

### Clean authorization-repair candidate — 2026-09-13

Previous turn: progress, reproducing and fixing the consent CSP redirect.
Prepared a separate clean detached checkout at
../Sophia-Agent-oauth-callback from memory-preserving HEAD
41b3322a1982387a408db3f52277a9f9450a438c. Committed only the two-file OAuth
policy/test correction as 1a5614141e59de4725303eb58f61c0afc5727da1.
Working tree is clean after removing the temporary node_modules symlink;
the original C4 dirty tree and all its pending changes are untouched.

Fresh remote read still resolves codex/sophia-observability-v1 to
3add3336216e74324cd1ed4d3859caccc70c94fe, an ancestor of this candidate.
The committed lab tree before this fix matches that checkpoint. Relative to
deployed e3b40f1, it additionally contains the already committed ordinary exit
guard and cleanup-before-evidence ordering repairs; do not describe the complete
deployment delta as only OAuth. Committed memory history is preserved.
Voice Lab base migration, migration runner and schema-attestation source are
byte-unchanged from e3; the uncommitted v4 upgrade is not included. Product
migration changes in memory history remain separate and were not executed.

Initial clean-checkout suite had 347 pass/one fail/six skipped because the
golden cross-language test's expected Python environments were absent. Bootstrapped
backend with Python 3.12 uv sync --group dev and a separate Python 3.12 voice
environment with FastAPI 0.141.1 for its actual internal-auth import. Rerun:
348 passed, zero failed, six optional database tests not selected. Runtime
TypeScript and diff checks passed. Node dependencies were reused through a
temporary symlink, with unchanged package/lockfile; no product voice runtime
was launched. Evidence oauth-clean-candidate-verified.json SHA256
be5c9ee9189a4ddfad297cbaf2ccb5366b5f1315b773dc1b46c6da0f331c2e31.

Candidate is local only, not pushed/deployed. Before publication/deployment,
re-attest automatic deployment settings, current closed gates and worker/resource
state and resolve the runbook's exact-identity ordering. No pending v4 schema
change, broad Blueprint sync, test admission or credential change is authorized
by this local commit. This is a repair candidate, not PROMOTE VT00.

### Published exact authorization-repair tree — 2026-09-13

Previous turn: progress with clean repair candidate. Live settings re-audit
confirmed Auto-Deploy Off on all five Render services (MCP, worker, Gateway,
Voice, LangGraph), inspecting selected controls and cancelling without saving.
Voice Lab and main Blueprint Auto Sync both selected No; Blueprint inventory
also showed Sophia Voice Lab Database Sync paused. Vercel production currently
tracks main, not codex/sophia-observability-v1. Do not describe production as
tracking the campaign branch or infer that every preview build is disabled.

Local HTTPS git push failed for missing credentials; ssh-agent has no identities.
Used the installed GitHub connector instead. GitHub did not contain local docs
commit 41b3322a but did contain deployed memory parent 8d0d6d3. Uploaded only
the committed memory checkpoint and two OAuth files; all three Git blob hashes
matched the local committed blobs. Recreated the documentation checkpoint as
65d5f6d237955be5a7a1feadd54bb07a1fb68fc4, preserving parent 8d0d6d3 and exact
tree af7050370b45d898d6517b314fc6c86ae098a330. Created repair commit
48bd4e713f92b2130c9eb0bfea60a2d6d563327b with exact tested local tree
621010679a064eeb493f41888515755a70784fb8. Commit IDs differ because connector
metadata differs; bytes and tree identities were independently matched.

Fetched that exact GitHub object, checked the old campaign head was its ancestor,
re-read the unchanged remote ref and updated it with force=false. Independent
git ls-remote now confirms codex/sophia-observability-v1 at 48bd4e713f92b2130c9eb0bfea60a2d6d563327b.
Clean repair checkout now selects the published commit; original local 1a561414
is retained under local branch codex/vt00-oauth-local-1a561414. Main C4 dirty
checkout, original memory checkpoint and unpublished C4 changes remain intact.

Post-publication readiness heartbeat at 2026-09-13T17:01:58.716Z still reports
deployed e3b40f1, one live worker, execution_gate_settled=true, active_runs=0,
kill_switch_engaged and mutation_ready=false. Publication did not deploy the
repair or resolve historical resources. Ordered closed-gate deployment and
real installed authorization refresh remain next; no migration or gate edit
was performed and no journey/canary/P01 was counted.

### Closed authorization repair rollout — 2026-09-13

Updated only the service-local repository candidate SHA to
48bd4e713f92b2130c9eb0bfea60a2d6d563327b on worker and MCP, using Save only
and verifying the saved values. Effective kill settings remain true; expected
product identities, plugin identity, passwords and budget settings are unchanged.
Worker deployment dep-dajdfvgjo6nc73de9jog succeeded and is Live. Startup
reran the unchanged v3 migration/attestation and logged release_schema_sealed;
this is not the unpublished v4 upgrade or a product migration.

The old MCP readiness correctly rejected the new worker with
heartbeat_deployment_version_mismatch. A bounded BEGIN READ ONLY query through
the signed-in MCP Render shell independently observed exactly one worker at
2026-09-13T17:13:59.521Z, browser_ready=true, candidate/service version 48bd4e71,
effective_kill_switch_engaged=true, booted_at=2026-09-13T17:07:40.440Z,
heartbeat_sequence=189. Boot hash
58012af20bcfe5dfc9361cddf141f056f5378e2ea3ff7848211db12374b89561;
instance hash 97839066be1802e149465c4dd0220f1441864c207f7095b3f2f6805e98f131d0;
deployment identity a3c2036f2aeb2a044e01e8686cfef220b3133d2ad2fab11720d67dfc93552875.
The query rolled back and closed its connection. An earlier quoting error
occurred before SQL execution; no data mutation or credential output occurred.

Only after that heartbeat, launched exact-commit MCP deployment
dep-dajdjvuk1f9s73d7pj8g; its log confirms checkout of the full 48bd4e71 SHA
at 2026-09-13T17:14:50Z. Last observed Building, not yet accepted as Live.
Do not launch a duplicate deployment because an observation is delayed.
No test admission, journey/canary/P01 or historical-resource settlement counted.

### Authorization repair accepted; installed tool works — 2026-09-13

MCP dep-dajdjvuk1f9s73d7pj8g became Live at 2026-09-13T17:16:18Z,
after existing v3 release_schema_sealed at 17:16:07Z. Public readiness now
attests MCP and worker exact 48bd4e713f92b2130c9eb0bfea60a2d6d563327b,
one live worker, runtime/browser/fixtures ready, execution_gate_settled=true,
effective kill=true, mutation_ready=false and active_runs=0. Heartbeat
17:16:38.633Z (sequence 268, same new worker boot/instance/deployment hashes)
follows both ordered deployments. Product identity/retention blockers remain;
this is closed authorization infrastructure, not full campaign readiness.

Initiated fresh existing-connection Reconnect from the same registered plugin.
Read/copied only existing Render SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET into
the exact owned HTTPS authorization form, under prior explicit user authority;
no credential or permission change. Cleared clipboard and temporary variable.
DOM password value reads were masked/empty, while screenshot confirmed filled
dots; do not interpret a masked DOM read as proof the form is empty. Approve
now navigated successfully back to ChatGPT. Crucially the installed tool returned
status=ok, error=null, server_version=48bd4e71: first successful request
679ca3b9-8c54-4048-930a-5f45ce09096b at 2026-09-13T17:18:12.971Z.
The old Connected-on-Aug-29 badge alone was not used as proof.

Saved a second authenticated read-only capability receipt, request
71abb6b4-a482-44d0-a4fc-c352da524c0d, in sibling evidence file
oauth-repaired-capabilities-20260913.json, SHA256
d032d9dd47fa62a1c299cdea66d02fb51f6c41b2a57fd453975b7851db9a79fd.
It truthfully retains installed plugin version 0.1.0+codex.20260826110843,
old expected product e3 versus observed memory release 8d0d6d3, closed product
gates, and live aggregate provider caps 604800 seconds global/per caller.
Neither read-only capability call is a P01 or voice-test attempt.

Fresh local provider-spend-policy tests passed 8/8. Requested unlimited policy
is still unpublished C4 code, not enabled by this auth-only release. Reviewed
the possibility of a separately qualified v3-compatible policy release: config,
ledger cap types and both admission adapters need matching nullable-limit and
numeric-usage changes plus independent real-PG tests. Do not paste unlimited
into the existing live parser or deploy the entire dirty C4/v4 tree to obtain it.
Clean authorization checkout remains clean at published 48bd4e71. No further
release was created here. Automation files remain absent; no replacement.
Goal remains active and PROMOTE VT00 is not reached. Historical cleanup,
full C4 release/protocol, twenty built journeys, five canaries and fresh P01
remain outstanding; all mutation gates stay closed.

### C4 sequence-addressed ownership and cleanup proofs — 2026-09-13

Previous goal turn was progress: ordered authorization repair deployed and the
installed plugin authenticated successfully. Re-inspected current dirty C4 code
and root instructions before this change; clean live auth release stays separate.

Found cleanup derivation counted only runtime-acquisition events after the
process acquisition. An additional earlier canonical runtime was silently
discarded, allowing a direct-cleanup proof despite ambiguous acquisition count.
Also reproduced accepted zero/negative/fractional process ordinals and duplicate
event addresses, including collisions from event kinds outside the selected
proof. The ownership derivation separately accepted the latter collision.
Focused causal red: cleanup 12 pass/5 fail; ownership 4 pass/1 fail. NaN/Infinity
already failed indirectly and were retained as explicit invalid-ordinal controls.

Added shared executionEventSequencesValid: all receipt addresses must be safe
positive integers and unique across the supplied ledger projection. Both
ownership and cleanup derivation now apply it before selecting evidence.
Cleanup counts every canonical runtime acquisition, then independently checks
process-before-runtime order. No sequence sorting/relabeling, alternate runtime,
cleanup authority or allocation assumption was introduced.

Full current local suite: 537 passed, zero failed, 28 optional database tests
not selected. Runtime TypeScript and diff checks pass. Report
execution-sequence-full.json SHA256
af9e1fde780c9dd621458c8a1b95150f50bac522d10c590caebf61aff8cfa0fa.
Test session 36626 and TypeScript session 22826 both exited 0. No live mutation,
deployment, credential change, resource settlement, journey/canary or P01 occurred.

Reinspection confirms a substantive remaining boundary: generic allocation
history is recorded for every scenario, but deterministic retained allocation
binding/owner-death/provider-settlement flow remains V-D02-specific. A generic
worker loss or crash before the acquisition pair persists must not be declared
allocation-free or settled from lease expiry/new worker liveness. This still
needs an independently authoritative recovery path and its causal crash matrix,
not removal of the allocation-once fence. Full C4 release and certification
remain incomplete; keep the goal active and all live mutation gates closed.

### Generic pre-acquisition reservation identity — 2026-09-13

Previous goal turn made progress on causal sequence/ownership proof validation.
Current source inspection reproduced the generic pre-acquisition crash window:
upsertBrowserLease recorded a retained reservation binding only for V-D02;
other scenarios retained only browserAllocationEver. Shared adapter regression
failed for V-A01 because no reserved owner/epoch identity existed.

Memory and PostgreSQL now atomically retain the existing deterministic allocation
reservation with every initial lease. Allocation-once/CAS/lease ownership fences
remain intact. Split the reservation parser from the D02 attested-context parser:
generic reservations are validated by exact run/worker/epoch/hash recipe, while
driver context binding still requires V-D02. The generic reservation's context
hash is an allocation identity, not an assertion about a launched browser.
No product capability, runtime, driver activation or D02 settlement authority
was expanded. A memory crash-before-acquisition/content-purge case retains the
hashed reservation, has no acquisition/driver/cleanup proof, and still counts
as outstanding. Shared real-PG tests verify reservation identity, no attestation,
allocation-once after release/expiry, and preservation through content deletion.

Changed only unpublished isolated v4 recovery allocation-shape constraint to
allow generic reservation records with bounded hash/epoch shape. The separate
D02 browser-context constraint remains scenario-restricted. Historical base SQL
is unchanged. New extension SHA256
4e348cbfd497704fa9fb4d96b7fa4229f6f12d55e2c70a7fe7fd46e092ccf10b;
composed migration SHA256
d97e6e903b2af1c5c612af591b31726462f85b6bdf1f1f3eb46afe9b56ac9663.
These bytes were not deployed or applied to any production database; they do
not bypass the unresolved populated-v3 upgrade/backfill gate.

Confirmed mem00-qualification stopped before starting it; separate
mem00-qualification24 remained running and untouched. Initialized a new isolated
PostgreSQL cluster /tmp/sophia-c4-allocation.v9TZRUgO/data in the selected VM,
loopback-only port 16432 with SSH forwarding. Actual connection independently
attested voice_lab_test_c4_allocation_20260913, vt00_test, 127.0.0.1:16432,
PostgreSQL 18.6 before explicit test reset approval. Full suite with main PG
adapter selected: 554 passed, zero failed, 12 other DB tests not selected;
all 16 main PG tests passed. Runtime TypeScript passed. Report
generic-allocation-pg-full.json SHA256
e0dc9a7266f974ef0d751beb0fb4d24d1831b6c88ef3f53da961b08ab22560d8.
That test process 92151 exited 0. A final added parity assertion explicitly
rejects promoting generic reservations into D02 driver-attested context;
its follow-up run is tracked separately below.

This supplies durable generic allocation ownership, not generic owner-death or
provider-zero settlement. The latter authoritative recovery flow and causal
crash matrix still remain, along with deployed historical reconciliation,
twenty built journeys, five canaries, fresh P01 and full release closeout.
No live voice run or official P01 attempt was made; goal stays active.

Follow-up authority-separation run: 18 passed, zero failed/skipped, including
all 16 PostgreSQL adapter tests and both memory allocation tests. Report
generic-allocation-d02-separation.json SHA256
ebf3eb7991338176553c70516a4e6b95894bcb8a6267c199e2127ea90ed5033a.
Test session 1827 and final TypeScript session 90230 exited 0. Actual dedicated
database readback returned zero lab schemas and zero other connections after
test teardown. Stopped its PostgreSQL process and cancelled the exact loopback
forward; requested selected VM shutdown and observed VZ stopped. Separate
memory VM untouched. No production migration or release occurred.

### 2026-09-13 — reject incomplete Render owner inventory

Local controller audit found both Render controllers silently discarded malformed
instance records before deriving owner absence. Two worker-controller regressions
causally reproduced signed success with an invalid extra owner before and after
dispatch. The first test draft lacked its required checkpoint and was not causal
evidence; the corrected draft reached the provider mocks and exposed the defect.
Both controllers now reject malformed records and non-string instance identities.
A shared fatal inventory error propagates through observation polling and retained
resume instead of treating malformed evidence as transient absence. An intermediate
implementation swallowed the error and exhausted the mock polling process heap;
that run failed and was not counted. No real provider calls occurred.

Added MCP parity tests require zero provider POSTs before malformed admission,
at most the original one POST after dispatch, and no final attestation. Full local
suite: 542 passed, zero failed, 28 database tests unselected. Report
render-inventory-full.json SHA256
8cdeb5e4ac5653abba7b7b512fb5ea94567f8bf324881229bc1b48b0ffbed11e.
Runtime and external-controller TypeScript checks passed. A subsequent small
parser wrapper also makes malformed list/record/timestamp parsing fatal; focused
controller verification is recorded below. The full report predates that wrapper.

Source review: https://api-docs.render.com/reference/list-instances documents an
instance listing, not an explicit process-terminal receipt. Render's deployment
lifecycle https://render.com/docs/deploys allows old-instance shutdown after the
new deployment is live. Therefore this hardening is not itself a new generic
owner-death source contract or provider-zero proof. Generic recovery, historical
settlement, built journeys, canaries and fresh P01 remain outstanding. No live run,
password change, production migration, budget deployment or gate opening occurred.

Final parser-wrapper verification: both controller files, 35 tests passed with
zero failures (session 87929 exited 0); external-controller TypeScript session
20295 exited 0, and git diff --check passed. Goal remains active and incomplete.

### 2026-09-13 — preserve the reservation fence after lease deletion

Following the generic recovery path exposed another causal defect: after release
of the transient lease, preserveRecoveryExecutionCleanup accepted an internally
valid event chain belonging to a different worker than the durable allocation.
The new shared ledger regression failed by returning a persisted cleanup proof
for that wrong worker. The durable control was consequently changed, not merely
a verifier return value. No actual browser or external resource was involved.

Memory and PostgreSQL persistence now share executionMatchesRecoveryAllocation:
allocation history and the exact validated run/worker/lease reservation must
exist and match execution evidence even when the live lease has disappeared.
If preserved execution ownership exists, its worker, lease and execution epoch
must also agree. The check is applied to ownership and cleanup persistence;
existing live-lease, immutable-replay and full receipt checks remain in force.
Negative worker/lease-epoch cases require rejection with unchanged control.

Initial full memory run: 542 passed, zero failed, 28 DB tests unselected;
durable-allocation-cleanup-full.json SHA256
71845684f2bd0f7dc77d5fcf150b8934b9b3c409af9b07be9f8496bc56d06fa4.
The first full PostgreSQL run had 556 passes and two downstream P01 failures:
new ledger-only negative fixtures left pending start operations, which the later
collector consumed. Those fixtures now explicitly cancel their non-dispatched
operations and mark only their simulated teardown complete, matching existing
fixture practice. The failing durable-allocation-cleanup-pg-full.json is retained.

Corrected full PostgreSQL run: 558 passed, zero failed, 12 other DB tests not
selected. durable-allocation-cleanup-pg-final.json SHA256
9039e989a4fb953744db151edcfa87aa9db0df41a91579fa25e065ffa2dddfaa.
Session 92655 exited 0; runtime TypeScript and diff whitespace checks passed.
This used a freshly initialized loopback-only PostgreSQL 18.6 cluster inside
mem00-qualification, database voice_lab_test_c4_owner_fence_20260913, role
vt00_test; exact server/database identity was queried before test reset approval.
The separate memory VM was untouched. A follow-up moves the positive fixture's
lease release before cleanup persistence to prove legitimate recovery remains
possible; its result and isolated-resource shutdown are recorded below.

This is a durable ownership fence, not generic signed owner-death recovery or
authoritative historical settlement. Historical backfill still lacks durable
allocation bindings for some positively allocated v3 controls and needs explicit
source reconciliation, not fabrication. No production deployment, gate opening,
live voice test or new official P01 attempt occurred. Goal remains active.

Positive released-lease follow-up passed: 17 tests, zero failed/skipped, including
all 16 main PostgreSQL adapter cases. Report
durable-allocation-released-positive.json SHA256
92f8d12622c8c34c6c1be302cfa3c1bd48ccbe2820ed890e08c476e762801980.
Session 36081 exited 0. Actual database readback showed no lab schemas and zero
other connections after teardown. Stopped the exact temporary PostgreSQL cluster
and cancelled its loopback forward; selected VM shutdown requested. No production
resource was altered. Existing concurrent-query deprecation warnings were emitted
by the PostgreSQL test suite; no warning was treated as a pass substitute.

VM shutdown session 23309 exited 0; limactl readback confirms selected
mem00-qualification Stopped and unrelated mem00-qualification24 still Running.

### 2026-09-13 — retain positively evidenced historical allocation identity

Four causal backfill regressions failed before implementation: process-only and
expired-lease histories lost their reservation binding, and contradictory worker
or lease epoch histories were accepted as ready. The read-only assessment now
projects the existing deterministic allocation recipe from a validated lease or
the hash-only exact process/runtime acquisition pair. When both sources exist,
their worker and lease epoch must agree; disagreement or an invalid lease epoch
returns historical_owner_binding_conflict. A reservation is not driver context
attestation, process acquisition, process death, or provider settlement.

Provider/session/thread-only histories still preserve an unresolved allocation
obligation without inventing a worker, reservation binding, or live-zero proof.
Missing history and D02-specific historical authority still fail closed. The
existing transactional v3-to-v4 upgrader now persists browser_allocation_binding
with the other control fields. Its real PostgreSQL fixture asserts the exact
binding before and after live-lease deletion, unchanged source run/lease/events,
and transaction-wide rollback on a forced postflight catalog mismatch.

Full suite with PostgreSQL selected: 567 passed, zero failed, 12 other DB cases
unselected; historical-allocation-backfill-pg-full.json SHA256
d27aa274e68fdd83e632cdf29ef6aeb763c70bf597e38fb02c45397dde8e6cdf.
Session 27873 exited 0. Runtime TypeScript and git diff --check passed. Additional
cases cover unsafe/nonpositive/noninteger lease epochs and matching dual-source
ownership without incorrectly asserting provider zero.

Used fresh loopback-only PostgreSQL 18.6 cluster
/tmp/sophia-c4-backfill.SEwER3Kt/data inside mem00-qualification, database
voice_lab_test_c4_backfill_20260913, role vt00_test. Exact database/server identity
was queried before reset approval. The previous VM temporary cluster was absent
after reboot; its failed start did not start any process. After suite teardown,
readback showed zero lab schemas and zero other connections. Stopped the exact
cluster, canceled its loopback forward and requested selected VM shutdown.

No production v4 migration, credential change, gate opening, live voice run or
new official P01 attempt occurred. Generic signed owner-loss recovery, deployed
historical reconciliation and full campaign qualification remain outstanding;
these local backfill tests do not establish PROMOTE VT00. Goal remains active.

Selected VM shutdown session 51312 exited 0; authoritative list reports
mem00-qualification Stopped, with the unrelated qualification24 VM still Running.

### 2026-09-13 — separate generic owner-loss source contract (not yet wired)

End-to-end tracing confirms the existing signed worker termination receipt embeds
D02 provider freeze/admission/loss-observation facts. Removing its scenario guard
would erase that authority distinction. Added a separate generic-owner-loss.ts
receipt contract and verifier instead; no runtime, browser activation path,
ingestion endpoint, dispatch producer or live restart was added.

The new contract requires configured deployment-control Ed25519 authority,
canonical run/control and reservation hashes, exact worker/service/lease binding,
a separately loaded immutable dispatch claim and action request binding, an
accepted source action, bounded ordered timestamps, and before/after singleton
replacement inventories with a newly created replacement identity. Receipt TTL
is at most fifteen minutes. ProviderCleanupProven and liveResourcesZeroProven
are fixed false; the output is owner-loss verification only. D02 is explicitly
rejected. Reservation-only pre-acquisition history can be verified without
fabricating process acquisition, but cannot thereby settle provider/auth cleanup.

Ten tests exercise valid retained reservation verification, correctly signed
foreign control/allocation/service/dispatch/action hashes, signature tampering,
wrong keys, unchanged/multiple/pre-existing replacement instances, time bounds,
missing allocations, D02 authority substitution and forbidden cleanup booleans.
Full local suite: 561 passed, zero failed, 28 DB cases unselected. Report
generic-owner-contract-full.json SHA256
e99cd58b6d404fa1f1106c62e247f3277ebf76b6d39be6cfe8e3bd463acf4cad.
Session 98691 exited 0. A final canonical-base64url signature representation
check was added after that full run; the ten focused verifier tests passed again.
Runtime TypeScript and git diff --check passed before the final representation
check; final TypeScript is tracked below.

This contract remains intentionally unconnected: its only importer is the test.
It must not be treated as executable generic recovery. Required next integration:
persist immutable run/allocation/version-bound one-shot dispatch in both ledgers,
consume before any Render POST, make uncertain dispatch resume observation-only,
reuse the independently fetched exact worker snapshot source with strict inventory
validation, sign under existing deployment-control custody, then atomically ingest
against trusted stored control/dispatch and source signature. Keep provider/auth
zero and current canonical recovery settlement as separate requirements. Do not
pass caller-supplied dispatch or authority into an ingestion route.

No schema migration, production change, live voice call or new official P01
attempt occurred. No test VM was started. Generic source production/ingestion,
historical settlement, complete journeys/canaries/P01 and release closeout remain
incomplete; goal remains active and production gates remain closed.

Final runtime TypeScript session 44884 exited 0 after canonical signature checking.

### 2026-09-13 — durable generic owner dispatch (provider lane still unconnected)

Added prepare/consume journal operations to both ledger implementations. Preparation
binds immutable run/control, evidenced allocation, exact worker service/instance,
stable request ID, original control revision and the existing Render action hash
recipe. Consumption uses the current control revision and exact prepared digest,
records its timestamp before any prospective provider POST, and returns a permit
only for the first successful transition. Replayed consumption returns false;
an uncertain response cannot authorize another POST. No provider call is made by
either ledger method. D02 and already-complete cleanup remain excluded.

A unique service/worker-instance claim in PostgreSQL, with memory parity, prevents
another run from independently claiming a second restart of the same owner. The
journal lives in recovery_controls without a raw-run FK, survives content purge,
and stores hashes rather than the raw worker ID. The generic owner-loss verifier
now derives its dispatch binding from the stored consumed journal; the prior
separate caller-supplied dispatch parameter/interface was removed.

Shared memory/real-PG test covers stale revisions, immutable preparation replay,
changed request IDs, another-run owner claim, wrong prepared digest, eight
concurrent consumers yielding exactly one permit, post-consumption retries, and
content deletion with identical retained journal and zero further permits.
All fixtures are ledger-only and cancel queued start operations. PostgreSQL
teardown deletes only the exact test-created run IDs after assertions; no actual
provider resource was allocated or labeled clean by those fixtures.

The unpublished v4 extension adds generic_owner_dispatch plus owner uniqueness.
Historical base migration bytes remain unchanged. New extension SHA256:
705ae6145226ad5b097be4038df97d38379584a5c13609e9e2d9a5a8db2657c8;
new composite SHA256:
38de9de52e5b29956aad0b5d7dd5fa6dd9345201aef0aa40af43dbb368a3b8fb.
These supersede the earlier local v4 checksums only; no deployed v3 seal changed.

Full suite with PostgreSQL enabled: 579 passed, zero failed, 12 other DB cases
unselected; generic-owner-dispatch-pg-full.json SHA256
5f7d3f808856f17c286576edda76a8be92e07703cd842787d355d93a0fe29956.
Session 78805 exited 0. Runtime TypeScript and diff whitespace checks passed;
a final redundant-type removal is type-only and final check tracked below.
Actual test target was newly initialized PostgreSQL 18.6 on loopback16432,
voice_lab_test_c4_dispatch_20260913 / vt00_test, in
/tmp/sophia-c4-dispatch.ZiNuFk3r/data inside mem00-qualification. Identity was
read back before reset approval. Final readback showed no lab schemas and zero
other connections; exact cluster stopped and loopback forward canceled.

Still required before live use: an authenticated deployment-control producer
with fresh exact service/owner snapshot and gate/admission preflight, durable
source checkpoints and GET-only ambiguous-dispatch resume, signing under existing
custody, atomic verified receipt ingestion, and separate current provider/auth/
Builder cleanup settlement. Shared historical obligations for one already-claimed
owner must reuse verified owner evidence, not request another restart. An expired
unconsumed preparation currently fails closed and needs explicit recovery semantics
before the producer is complete. None of these missing pieces is certified by
the journal tests. No production migration/restart, live voice run, official P01
attempt, password change, gate opening or new automation occurred. Goal active.

Final runtime TypeScript session 32629 and VM shutdown session 65158 exited 0.
Readback confirms selected mem00-qualification Stopped; unrelated
mem00-qualification24 remains Running and untouched.

### 2026-09-13 — authenticated generic dispatch journal boundary

Added /internal/voice-lab/recovery/owner-dispatch with strict inspect/prepare/
consume request schemas. It uses the existing attestation authenticator and
requires both voice_lab:attest and voice_lab:attest:deployment_control scopes,
authorizationKind=attestation, and the configured deployment-control subject.
Ordinary/fault voice callers and other source authorities cannot access it.
The service requires the current MCP kill switch engaged and explicit
SOPHIA_VOICE_LAB_GENERIC_RECOVERY_WORKER_SERVICE_ID configuration. That new
non-secret service ID defaults null (disabled) and rejects non-Render-ID values.
The caller cannot supply/override the service in a request. Existing journals
must match it; controls must match the configured principal/environment and
must not be D02. These checks precede ledger mutation.

Replies are no-store; audit entries contain bounded request/control hashes,
revision, journal digest and whether a permit was returned, never credentials or
raw retained content. Malformed/oversized JSON follows the existing audited
attestation body-rejection handler. Authentication is not bypassed for inspect.
No provider HTTP call is performed by this endpoint. A lost consume response
remains consumed, so a retry cannot recover a second permit.

Actual loopback HTTP tests use the existing static/attestation authenticators:
missing/bad credentials, ordinary and fault callers, other attestation sources,
open kill switch, missing service configuration, extra service-override fields,
foreign principal/environment and D02 controls reject before prepare/consume.
Authorized concurrent requests produce exactly one permit; inspect and consumed
replay work after raw content purge. Malformed JSON is bounded and audited;
responses are no-store and credential material is absent from audits. The local
HTTP listener and connections were closed in finally.

Full local suite: 564 passed, zero failed, 29 DB cases unselected. Report
generic-owner-dispatch-http-full.json SHA256
752ff0acf88f8493e247311936465487912426df7d5b9ba385683993f3f7dd47.
Session 4228 exited 0; runtime TypeScript session 57460 exited 0 and git diff
--check passed. No test VM/database was started for this transport-only change.

This connects the durable journal to authenticated source-controller access,
not yet to a complete independent Render producer or verified receipt ingestion.
Those still require fresh exact owner and deployment/gate preflight, durable
before/dispatch/after checkpoints, observation-only ambiguous resume and signed
receipt publication under existing deployment-control custody. Separate provider/
auth/Builder settlement, historical source reconciliation and all live campaign
qualification remain required. New configuration was not set in production;
no deployment, restart, voice call, P01 attempt or gate opening occurred. Goal active.

### 2026-09-13 — generic independent source controller and custody fence

Added generic-worker-preflight.ts and generic-worker-controller.ts. Independent
preflight joins exact lab/product/LangGraph revisions, fresh singleton worker
heartbeat, closed product and worker gates, database readiness and strict Render
inventory. Active runs must be exactly one until owner-batch reconciliation is
implemented. Credential destinations are fixed; redirects are refused. The
replacement must independently pass the same closed-gate/release checks.

The controller consumes the authenticated durable journal before its sole Render
restart POST. Required checkpoint callbacks cover prepared, consumed, accepted
response and signed receipt phases. Lost responses and consumed resumes are
observation-only; neither an HTTP acceptance nor cleanup is invented. Exact
request/release/control/allocation bindings survive replay. Missing or mismatched
deployment-control signing custody rejects before preparing/consuming a claim.
The signed owner-loss receipt explicitly proves neither provider cleanup nor
zero live resources. This code was exercised only with mocked provider HTTP and
ephemeral local signing keys; it has not restarted a live service.

Tests cover closed-gate/release/inventory drift, accepted restart, lost response,
post-restart gate drift, checkpoint write failures, changed-release replay and
missing/wrong signing custody. Latest full local suite: 584 passed, zero failed,
29 database cases unselected. generic-worker-source-custody-full.json SHA256
e3cf1b3ef9ff5a235d43313f7eda8a9b39037469ebf43bb74b471e7466692344.
Session 47879 exited zero. Runtime TypeScript session 33163 and controller
TypeScript session 72227 exited zero; git diff --check passed. Earlier source
suite had 580 passing tests (cd78d73787ff8538068e893b45389c8f7c85f4676eff1c8b85a1170e5dd735ac);
checkpoint follow-up had 29 passing tests
(43413eef1c3eadebd4e3ae71d8680cc40ecd28ef6e295f06aa6e9d05eba732d3).
An earlier exact-optional-property TypeScript error was corrected and rechecked.

Still required: immutable on-disk CLI checkpoint wiring, verified receipt
ingestion/storage, ambiguous-claim and owner-batch recovery, independent current
provider/auth/Builder settlement, historical reconciliation and all campaign
qualification. No test VM was started. Automation directory was verified empty;
aggregate unlimited-provider policy remains local and unpublished. No production
migration, budget change, gate opening or new official P01 attempt occurred.
PROMOTE VT00 remains unmet; goal active.

### 2026-09-13 — executable generic recovery checkpoint journal

Added generic-worker-journal.ts and CLI generic-render-worker-loss. Private
credential files remain separate from strict non-secret controller input. A
private real directory holds exclusive atomic mode-0600 numbered entries, chained
by hashes and a domain-separated HMAC under existing deployment-key custody.
Input and authority fingerprints bind the journal; raw key bytes are cleared
after the CLI invocation. No credential values are printed.

Explicit --resume true loads and authenticates the entire phase prefix. Changed
scope/custody, tampering, gaps, unexpected visible files and unintended new starts
reject. Exclusive publication fences competing writers; append failures poison
that writer until a new invocation. Pre-consumption re-observation appends another
prepared phase rather than replacing history. Post-consumption resume cannot
issue a second provider POST, including after a lost provider response. A signed
receipt remains owner-loss-only; exit 2/unconfirmed does not invent cleanup.

Tests exercised a persisted pre-consumption interruption and full disk-backed
resume, immutable completed replay, tamper/scope/key/gap rejection, concurrent
creation and the real CLI command with credential files. Both accepted and
lost-response CLI retries issue exactly one mocked provider POST; the POST test
reads the actual consumed checkpoint from disk before simulating acceptance.
Full suite: 588 passed, zero failed, 29 DB cases unselected, session 95916 exit 0.
generic-worker-journal-full.json SHA256
f140cae57bb1db3888871c7ee920603b53558530242a685215440b00134c385f.
The added lost-response CLI follow-up passed all 12 focused tests, session 71230
exit 0, generic-worker-journal-lost-response.json SHA256
b3b43c095759097f96c2dcee4e733734e6ca4730149af54e56f582be640ab666.
Controller TypeScript session 66283 exited zero; git diff --check passed.

No live restart, gate change, database migration, budget configuration change or
official P01 occurred. No test VM started; test-created temporary credential and
journal directories were removed by fixture teardown. Next required recovery
work is verified receipt ingestion/storage and independent provider/auth/Builder
settlement, including historical and owner-batch reconciliation. Full built
journeys, canaries, fresh installed-plugin P01 and canonical promotion evidence
remain mandatory. Goal active, not PROMOTE VT00.

### 2026-09-13 — immutable generic owner-loss ledger ingestion

Added strict verified-generic-owner-loss proof parsing and common ingestion
logic. First acceptance verifies the exact signed source receipt, configured
authority/release/service, retained allocation and consumed dispatch journal,
then checks the exact control revision. Accepted proof includes only bounded
hashes, revisions/epoch, release identities and acceptance time. Replays require
identical signed receipt bytes and reverify against the original acceptance
time; expiry cannot invalidate a previously accepted immutable proof or permit
an expired first acceptance. D02 is excluded. Neither cleanup boolean can be true.

Memory ledger persists within its synchronous critical section; PostgreSQL
uses SELECT FOR UPDATE and a transaction. Concurrent submissions produce one
new version and identical replay proofs. The record reader validates proof
digest and exact control/allocation/dispatch joins. The unpublished v4 extension
adds generic_owner_loss with size/schema/consumed-claim/owner/false-cleanup
constraints. Base v3 migration remains unchanged. New extension SHA256:
f2699c4582eed3e2eac910d14552ab6bbf3103344cf0a34e9282f55bea1fbe1d;
new compiled composed migration SHA256:
e627a3e1d6d18dbdc24cf7154b47529e737df51aefa94d38d4fb1db1ebf018d3.
These bytes have not been applied to production.

Shared Memory/PostgreSQL tests cover wrong revision, tampered receipt, unchanged
state on rejection, eight concurrent ingestions, immutable replay, release
drift and raw-run absence after retention purge. Pure tests additionally prove
expired replay versus expired first acceptance and stored-proof tamper/scope
rejection. Full PostgreSQL-enabled suite: 608 passed, zero failed, 12 separate
DB suites unselected. Session 39888 exited zero. Report
generic-owner-ingestion-pg-full.json SHA256
d7aa26d7940e5d71c5de45c5ad8e9d51f2e4fa65e5711ab1c2996790eb7a18da.
Runtime TypeScript session 64913 and controller TypeScript session 5643 exited
zero; git diff --check passed. The suite emitted an existing pg concurrent-query
deprecation warning, not a failed assertion.

Dedicated PostgreSQL 18.6 database voice_lab_test_c4_owner_ingest_20260913 used
only loopback port 16432 in mem00-qualification. Teardown readback showed zero
Voice Lab schemas and zero other connections; server stopped and SSH forwarding
was canceled. The unrelated mem00-qualification24 VM was not changed.

This adds verified persistence, not the HTTP receipt submission path or live
resource settlement. Next work must connect authenticated receipt publication
to the producer and then independently settle provider/auth/Builder obligations,
including historical and owner-batch cases. No live restart, production gate,
password, budget setting or official P01 attempt changed. All full campaign
requirements remain active; no promotion claim.

### 2026-09-13 — authenticated owner-loss publication and acknowledgement

The existing closed deployment-control endpoint now accepts strict
ingest_owner_loss requests. It requires the same authenticated source, configured
service/principal/environment and non-D02 control, plus exact configured product
deployment and current lab/LangGraph release identities. Verification uses the
configured public key, not caller-provided authority material. Receipt ingestion
increments the retained ledger once and returns the persisted control; content-free
HTTP audit includes the owner-loss proof digest. No provider action occurs there.

The source controller checkpoints the signed receipt before publication and
cross-verifies the returned stored proof against that exact signed receipt and
its persisted acceptance time. Lost committed publication responses resume by
replaying the same receipt, without another Render POST or ledger version change.
A verified source-local receipt alone no longer makes the command successful.
Provider/auth/Builder cleanup remains unproven and its booleans remain false.

Tests cover real authenticated loopback HTTP rejection for ordinary/fault/other
authority callers, tampered receipt, wrong revision, open MCP gate, absent target
and product-release drift. Accepted/replayed replies are no-store; proof audits
omit signatures and credentials. Source tests exercise a lost committed ingestion
response with unchanged stored proof and only one mocked restart.

An initial full run failed one HTTP acceptance test and controller TypeScript
identified the corresponding authority-field mismatch (runtime camelCase versus
receipt snake_case). The explicit mapping and test fixtures were corrected;
the failed report remains generic-owner-publication-full.json SHA256
47e994afc6300a1b19d997f72dc857402ed6e9deede1831c621cf1221692d983.
Corrected full suite: 592 passed, zero failed, 29 DB cases unselected. Session
56477 exited zero; generic-owner-publication-corrected-full.json SHA256
1b030204bc9c1c4a86775f46dfea607a04681e7a8eaffe550fa2c8a9b040f21d.
Controller TypeScript session 88670, runtime TypeScript session 90329 and git
diff --check passed. HTTP listeners closed and test-only key directories were
removed by teardown. No VM was started for this transport/source change.

No production deployment, migration, budget setting, gate opening, restart or
official P01 attempt occurred. Next required work is independent resource
settlement and its generic-owner proof integration, historical and owner-batch
reconciliation, then the complete exact-release campaign qualification. Goal
active; PROMOTE VT00 remains unproven.

### 2026-09-13 — generic owner plus current canonical recovery settlement

Added retained-generic-recovery.ts and integrated its proof into Memory and
PostgreSQL settleRecoveryControl. A retained generic control may now satisfy
its browser-owner side with the independently verified owner-loss proof, but
only alongside an exact current authenticated canonical recovery result. The
existing canonical validator still requires terminal session/provider/auth,
complete authoritative Builder discovery/zero, durable receipt and live zero.
The attempt must postdate owner-proof acceptance, be current within five minutes,
match receipt attempt identifiers/timing, and have the exact prior durable
capability audit at the control revision. Lease identity and CAS remain checked
inside the same critical section / row-lock transaction. D02 remains separate.

The resulting hash-only genericRecoverySettlement is distinct from both owner
loss and normal browser execution cleanup; no browser context or provider close
receipt is fabricated. Stored proof parsing checks its digest and owner/control
joins. The unpublished extension adds generic_recovery_settlement constraints
and requires verified generic owner loss plus live cleanup. New extension SHA:
e4de0b1df288a1f3d0bc95581dd26c97c9392714fcc451117f150e60e7d5546e;
composed migration SHA:
4e0e602b8bfec59d6da3ae9f29672c8f386d30cc7505a1519ca8243b8fd2c3b1.
Base v3 bytes remain unchanged; no production schema change occurred.

Shared Memory/PostgreSQL tests reject each pending component, missing Builder
zero, absent owner proof, D02 substitution, predating/stale/wrong attempts,
missing exact audit and wrong revision, without changing the control. Four
concurrent valid settlements return one new version; source owner proof remains
unchanged and raw run remains absent. Full PostgreSQL-enabled suite: 609 passed,
zero failed, 12 separate DB cases unselected. Session 63021 exited zero. Report
generic-recovery-settlement-pg-full.json SHA256
062af13efb62bda751f34aa41b38792f5d87162c059c16733e9106dc4b75aaac.
Runtime TypeScript session 75778, controller TypeScript session 8763 and git
diff --check passed. Existing pg concurrent-query deprecation warning persists.

Dedicated PostgreSQL 18.6 database voice_lab_test_c4_generic_settle_20260913 was
loopback-only in mem00-qualification. Teardown showed zero Voice Lab schemas
and zero other connections; server stopped and SSH forwarding canceled.
No production gates, deployments, budget settings, passwords or P01 attempts
changed. The unrelated mem00-qualification24 VM was untouched.

This is the final proof join, not a replacement for an owning provider terminal
receipt. Historical activated browser providers without canonical closure still
require independent source reconciliation; owner-batch and ambiguous-dispatch
cases also remain unresolved. Exact deployment, twenty full built journeys,
five canaries, fresh installed-plugin P01 and canonical suite/operational
closeout remain required. Goal active; no PROMOTE VT00 claim.

### 2026-09-13 — real maintenance and recovery-transport qualification

Added generic-recovery-worker.test.ts using the actual VoiceLabWorker,
PlaywrightVoiceDriver recovery transport, CapabilityCodec, retained scheduling
and Memory ledger. Only the Gateway HTTP response is synthetic; no browser or
provider is started. A real signed generic owner proof is ingested before
maintenance, after raw content purge. The test checks exact recovery origin,
redirect refusal, recovery-only capability scope, full scenario/deployment/TTL
bindings and a persisted exact-attempt capability audit before HTTP dispatch.

Six schedules cover complete recovery, provider pending, auth pending, unknown
Builder zero, wrong attempt and lost response. Each negative leaves control
truth unchanged and one active obligation, then a later scheduled complete
response settles it. Success proves zero active obligations, confirmed retention
tombstone, absent raw run/artifacts and a joined generic settlement; browser
start/allocation/launch spies stay at zero. Test Date is advanced only to exercise
the existing maintenance retry schedule, never to claim production cleanup.

The first focused run exposed a test-fixture omission of expected scenario
bindings in capability verification. The real transport correctly classified
that rejection as unavailable. The fixture was corrected and transport-spy
assertion failures are surfaced explicitly so they cannot hide as product
failures. No production code change was needed for this step.

Full local suite: 598 passed, zero failed, 29 DB cases unselected; session 78402
exited zero. generic-recovery-worker-full.json SHA256
88d43db0b4b2a5b4cdabe4800805d1390bbd963cf7dc24758a7fc30686470c83.
Follow-up explicitly checked the synthetic lost-response error and passed all
six cases: generic-recovery-worker-loss-followup.json SHA256
b46f12fd793a9931e5ec0a675ca739a64bdfa01ad948baf50bf26b3288687aaa.
git diff --check passed. No VM, external browser, provider, production change or
official P01 attempt occurred. This proves maintenance integration locally,
not the twenty complete built-Sophia journeys or any live campaign gate.
Historical source reconciliation and full exact-release qualification remain.

### 2026-09-13 — fresh deployed-state and source reconciliation

Installed get_capabilities succeeded at 19:17:51.569Z, request
4774ee1c-745f-4eb5-97c7-e395dd16677b. This was read-only, not an official P01.
Lab remains 48bd4e713f92b2130c9eb0bfea60a2d6d563327b with installed plugin
0.1.0+codex.20260826110843. The four product components still report memory
release 8d0d6d335d4a4a833eb827b2678b639d4b927241 while lab configuration expects
e3b40f1b21739479db239c383ce88285ce740152. The MCP kill switch is engaged;
Gateway/Voice product mutation gates are closed. Live aggregate provider caps
remain 604800, not the local unpublished unlimited policy.

Fresh public Gateway readiness confirms running but degraded retention recovery:
two discovered, zero completed, two pending; no discovery failure, processing
failure, malformed row or conflict was reported. Protected-plane and admission
readiness remain false. This does not re-prove the identity or underlying
resource state of either historical obligation. The existing Supabase SQL tab
was found, but attachment timed out twice; native desktop inventory reports a
locked Mac. No SQL query, credential access, gate change or password operation
was attempted through another route.

git ls-remote independently confirms campaign branch at 48bd4e7. Local HEAD is
41b3322a1982387a408db3f52277a9f9450a438c with 133 changed/untracked paths.
git merge-base of local HEAD and remote campaign is memory release 8d0d6d3;
their committed trees differ only in OAuth source/test (the callback repair).
The C4 work remains local and uncommitted, not a deployable exact release.

Evidence: live-capabilities-20260913-191751.json SHA256
bf80d06ef9d475d5f4d469910dc2a0b6242527a90e4449a612e9ebe712a1f848;
live-release-reconciliation-20260913-1917.json SHA256
425a6e8e84aaf86c94006959cb87168bd7b1a7d77d6d7bbaa57bc1926e900bdc.
The runbook's twenty complete installed-tool built journeys remains an unpassed
inventory gate, not an executable collector; five canaries and fresh-root P01
are separate requirements. Source/resource reconciliation, complete release
integration and those qualification flows remain the next work. No evidence
justifies opening gates or promotion. Goal active; this is not a live wait.

### 2026-09-13 — causal correction of retained-worker negative tests

Audit found that the older retained-worker fixture required D02-only browser
capability fields for any allocated non-D02 run. Those capabilities correctly
omit D02 fields, so the spy could reject authentication before reaching the
intended missing-process-proof or remaining-lease check. Merely observing an
unsettled control was therefore insufficient causal evidence.

The fixture now verifies those fields only for D02. Both negative tests require
the recovery transport to return a complete canonical event, require one ledger
settlement invocation, and inspect its exact rejection code:
RECOVERY_EXECUTION_UNCONFIRMED or RECOVERY_BROWSER_UNSETTLED. A corresponding
positive allocated non-D02 case proves preserved process cleanup plus lease
release reaches cleanup, zero active count and raw-run absence. No runtime
safeguard was weakened and no production change was made.

Full local suite: 599 passed, zero failed, 29 DB cases unselected. Session 58395
exited zero. recovery-worker-causal-rejections-full.json SHA256
2ae840b272bd6d04450a734271eb1219361d2194529d21564efbef71064d6bf6.
git diff --check passed. No VM, browser/provider allocation, gate or P01 attempt.
The preceding live database-access blocker has not been reclassified as a
completed audit. Remaining release integration, authoritative historical cleanup
and full installed-tool journey/canary/P01 qualification remain mandatory.

### 2026-09-13 — full backend release verification

Bootstrapped the existing backend workspace with runtime-tools/bin/uv sync
--group dev; Python is 3.12.14. No pyproject or lockfile change resulted.
The changed D02 retained-receipt endpoint's focused suite passed all 53 tests
(session 6605). The full backend suite then passed 6118 tests with zero
failures, 161 skips and 13 warnings in 296.05 seconds (session 55297, exit 0).
Both runs used PYTHONPATH=. uv run pytest, not system Python or bare pytest.

Skipped checks remain unverified: disposable PostgreSQL configuration,
root-Linux identity/filesystem boundaries, unavailable browser/rendering
dependencies, and state-schema cases with no applicable shadow field. These
results do not replace deployed journey or provider-terminal evidence.

Evidence in the sibling vt00-c4-evidence directory:
- backend-d02-release-verification.xml SHA256
  5984176ebc5d7718a80da329e021a872d6b97a2fcae38784dc3512fd31b75b06
- backend-release-full-verification.xml SHA256
  1fcd8d2d2d7cc0d001bc26b34a0e691e2dcbc8d2f5f49bf38e9f626f213bf192

Confirmed the cancelled resume-sophia-ah-voice-test automation directory is
absent. Aggregate unlimited-provider-budget support remains local, unpublished;
no live cap, password, migration, gate, browser allocation or P01 attempt changed.
Source/resource reconciliation, release integration and deployed qualification
remain required. Goal remains incomplete.

### 2026-09-13 — frontend release verification and current live admission

Previous turn classified as progress: full backend verification completed.
This turn ran the complete frontend suite with pnpm 10.26.2 and Node 22.19.0:
1991 passed, zero failed, two pending (session 71594, exit 0). Typecheck passed
(9391). Scoped lint on both changed controller hooks and their tests passed with
zero errors and three warnings (60163). No source edits were needed.

The first production build compiled and typechecked but failed page collection
because this local checkout lacked auth database configuration (56142, exit 1).
After inspecting the existing lazy Pool construction, a build-only loopback
placeholder DSN on port 9 and non-secret local auth placeholder allowed a second
build to finish (80496, exit 0; Next 16.2.2; 62 static pages). Auth bypass and E2E
test login remained false. Google provider credentials were intentionally absent
and produced warnings. This is build evidence only: the local .next output is
not an artifact authorized for deployment and does not prove production auth.

Fresh installed get_capabilities request f0ccdef0-58cf-456f-aa19-a17e7fe0f15a
at 2026-09-13T19:36:00.750Z still reports lab 48bd4e713f92b2130c9eb0bfea60a2d6d563327b,
plugin 0.1.0+codex.20260826110843 and the old finalization protocol. All four
products observed 8d0d6d335d4a4a833eb827b2678b639d4b927241 against configured
e3b40f1b21739479db239c383ce88285ce740152. Gateway protected plane is not ready;
product gates are closed and MCP kill switch engaged. Aggregate provider caps
remain 604800. No live start, P01, migration or gate mutation occurred.

Evidence in sibling vt00-c4-evidence:
- frontend-release-full-verification.json SHA256
  93b12c36d9ca9e8d80126c13eab09a75edc2f7e6c137af66e74a6aa4cf45cd5a
- live-capabilities-20260913-193600.json SHA256
  6e62140894004db286eed3efcc6a70c590447f35ab6ad93058d2486b94077382
- frontend-release-verification-summary.json records both build attempts and
  distinguishes local placeholder configuration from deployable release evidence.

Historical source/resource settlement, immutable release integration, twenty
complete built journeys, five canaries, fresh-root P01 and canonical campaign
closeout remain unproven. No promotion claim; goal active.

### 2026-09-13 — individually auditable erased-history inventory

Previous turn was progress: frontend suite, typecheck and build verification.
The existing Supabase SQL tab again failed to attach within its bounded call;
no fresh database reconciliation was obtained and no SQL ran. This is not a
verified wait on a live deployment or evidence that historical obligations ended.

The v3 inventory previously reported only an aggregate tombstone count. It now
enumerates a separately bounded, ordered structural projection of erased rows,
with SHA-256 fingerprints of both retained keyed lookup identities, remote purge
status and retention timestamps. Raw HMAC lookup IDs and deleted content are not
exported. Tombstone overflow makes overall enumeration incomplete even when raw
runs are zero. Malformed status, identity or timestamps roll back the read-only
snapshot. Every erased row, including remote-purge-confirmed rows, still requires
independent historical reconciliation; upgradeAuthorized remains false.

Twelve focused tests passed, including zero-raw-run enumeration, stable report
hash, no raw keyed-ID disclosure, exact bound/overflow, invalid-bound rejection
before connect, and malformed-source rollback. Full local lab suite: 611 passed,
zero failed, 29 DB tests unselected (57139, exit 0); runtime TypeScript passed
(62642). Real PostgreSQL inventory assertions were extended but not executed in
this turn. No VM was started and no production migration hash changed.

Evidence: sibling vt00-c4-evidence/historical-tombstone-inventory-full.json SHA256
d95adce1b177aa520c2f9fa4e94b100d02c2b8b488453277cb6d530f5ba1a221.
README documents projection, bounds and non-authority. The upgrade still refuses
erased history; this diagnostic improvement does not invent its missing external
owner/provider settlement. Historical reconciliation and exact-release campaign
qualification remain required. All live gates unchanged; no new P01 attempt.

### 2026-09-13 — real PostgreSQL erased-history inventory verification

Previous turn classified as progress: bounded structural tombstone inventory.
Extended the real PostgreSQL test with a second, confirmed tombstone and a bound
of one. It proves tombstone overflow independently makes enumeration incomplete,
preserves the retained-run assessment, orders the reported fingerprint, and does
not convert confirmed remote purge into upgrade authority. Existing populated-v3
upgrade refusal and unchanged-source assertions also ran, as did CLI output and
the complete PostgreSQL-enabled lab suite.

Result: 628 passed, zero failed, 12 separately configured DB cases unselected.
Session 35252 exited zero. Evidence in sibling vt00-c4-evidence:
historical-tombstone-inventory-pg-full.json SHA256
9023b2b17353c46314cb7099e5ab6723579c2a4efd56bb86a14e869aad564462.
The existing pg concurrent-query deprecation warning remains; no failed test.

Isolated runtime: PostgreSQL 18.6 in mem00-qualification, cluster
/tmp/sophia-c4-erased-inventory.7BjsFhY5/data, database
voice_lab_test_c4_erased_inventory_20260913, role vt00_test, loopback port 16432.
Exact database/server identity was read before tests. After test teardown, SQL
confirmed zero sophia_voice_lab-prefixed schemas and zero other database
connections. PostgreSQL stopped, SSH forwarding cancelled, VM shutdown session
1944 exited zero and limactl list confirmed Stopped. The unrelated
mem00-qualification24 VM was not changed. No production database access or DDL.

Current tool discovery exposes no Supabase/PostgreSQL/Render management connector
to replace the unavailable signed-in SQL tab. This does not end useful local
work, but production resource reconciliation cannot be inferred from test data.
Historical owner/provider settlement and populated-v3 upgrade authority remain
missing, followed by immutable release integration and full deployed campaign
qualification. Goal active; no promotion or new official P01 attempt.

### 2026-09-13 — close the remaining local PostgreSQL test selection gap

Previous turn was progress: real historical inventory/upgrade-refusal evidence.
Audited the remaining 12 unselected database tests; they cover retained-control
settlement and authenticated D02 service recovery, not optional campaign proof.
Ran both suites against separate dedicated PostgreSQL 18.6 databases:
voice_lab_test_c4_control_serviceproof_20260913 and
voice_lab_test_c4_service_serviceproof_20260913. Verified each database/user/server
identity first. All 12 passed, zero failed or skipped (session 58355, exit 0).
This covers durable authorization auditing, concurrent settlement/replay,
missing-owner refusal, signed owner/provider retention, lost Gateway-write
recovery, and the actual 30-second retained-recovery schedule across restarts.

Evidence in sibling vt00-c4-evidence:
retained-control-d02-service-pg-verification.json SHA256
47f3648122286e54445d4e0078595c11764ebcc9bba3cdd503054c387a6e39b1.
Together with the immediately preceding 628-pass report, every currently
collected local lab test has executed successfully across these runs; this is
not a claim that the deployed canonical campaign or fresh journeys passed.

Cluster /tmp/sophia-c4-service-proof.67FHeoPX/data, mem00-qualification, loopback
16432, role vt00_test. Both test databases had zero remaining lab schemas and
zero other connections after teardown. PostgreSQL stopped, forwarding cancelled,
VM shutdown 61421 exited zero; limactl confirmed Stopped. Unrelated VM unchanged.
No code change, production DDL, gate opening, password or provider action.

The upgrade audit confirms erased history still has no accepted independent
source reconciliation path; expiry/confirmed remote purge alone cannot supply
it. Generic source recovery also still requires an observed original worker,
so historical already-lost and owner-batch cases need an authoritative source
contract before implementation can honestly converge. Exact-release integration
and live certification remain outstanding. Goal active, not PROMOTE VT00.

### 2026-09-13 — platform instance evidence integrity

Previous turn was progress: all previously unselected PostgreSQL control/service
tests executed. Auditing the existing Render source reader found two defects:
worker instance IDs were sorted independently of creation timestamps, breaking
the positional owner/age join; duplicate IDs raised a generic retryable error,
allowing a later subset to conceal malformed source inventory.

The worker reader now sorts complete ID/time records together. Both worker-loss
and MCP-restart readers classify duplicate IDs as fatal RenderInventoryError.
Empty transitioning inventories remain unavailable/retryable, never owner-death
proof. New source tests prove the order-sensitive timestamp join, fatal duplicate
propagation through the retry handler, and empty-inventory distinction. Expanded
MCP controller tests require duplicate refusal before and after dispatch with
zero/one provider POST respectively and no final evidence attachment.

Initial focused and full reports failed on the old worker-controller test's
literal error-message expectation, not an accepted invalid inventory. Preserved
render-owner-source-integrity.json and render-owner-source-integrity-full.json;
updated that assertion to the exact duplicate message without relaxing rejection
or the no-POST assertion. Corrected full suite: 616 passed, zero failed, 29 DB
tests unselected (97609, exit 0). Controller TypeScript passed (16339).
Evidence: sibling vt00-c4-evidence/render-owner-source-integrity-corrected-full.json
SHA256 f84e4b1bcdede17985194069ff28ec5ea2edeee8dc704ad1a2ef01782f895b9b.
README documents the source semantics; git diff --check passed.

Consulted Render's primary List instances and List deploys API references:
https://api-docs.render.com/reference/list-instances and
https://api-docs.render.com/reference/list-deploys. Those endpoint descriptions
do not by themselves establish a terminal historical-owner receipt. No such
contract was invented and no production Render request/restart was performed.
No VM, migration, gate or new P01 attempt. Historical authoritative source
reconciliation, immutable release integration and live qualification remain
required; goal active.

### 2026-09-13 — authenticated production SQL access restored

Previous turn was progress: Render evidence source-integrity fixes/tests.
The old Supabase tab 21 still timed out. Following the documented browser
attachment recovery, created a fresh tab in the same selected browser; tab 115
attached successfully with the existing signed-in project session. The previous
browser-access blocker is resolved, not a reason to keep waiting. Preserve tab
115 for continuation; if a retained tab stalls, recover with a fresh same-browser
tab instead of repeatedly assuming account access is unavailable.

Created two new SQL snippets without overwriting old queries. Both transactions
explicitly used READ ONLY and a ten-second statement timeout. Fresh obligation
audit at 19:55:30Z returned exactly two rows: Sep3 19:24 has recorded live cleanup
and provider settlement and zero admissions; Sep3 20:18 lacks both records and
retains one browser_active admission. Both remain closed/session_provisional and
overdue for provider and retention deadlines. Closed is not complete.

Fresh auth aggregate at 19:56:51Z confirms one expired grant still marked active,
with one linked retained auth session. The database performed the token hash join
internally; no token, keyed identifier, principal, transcript or secret was
selected. The aggregate does not by itself identify which obligation owns the
grant. No fresh provider signature validation or metadata audit was performed;
settlement-record presence must not be described as revalidated proof.

Queries: f53a0ade-a397-4afb-a346-f5805d19ef5c (obligations),
832be80e-dd97-47df-aab2-c662135969fb (auth counts), project vlxnwmyvhchwbousrdzc.
Evidence: sibling vt00-c4-evidence/production-obligation-audit-20260913-1955.json
SHA256 cb78645eef393db98d2140f0b98254f1ca9a81c630e8665cca37a41c32625adf.
No production data/role/password/gate mutation or new P01 attempt. Current source
reconciliation and canonical cleanup are now the next accessible work; do not
substitute additional local test reruns for that production investigation.

### 2026-09-13 — retained provider and auth obligation attributed

Fresh read-only SQL query c5dd626d-e3ae-4b10-84a8-17e287b0d9d3 at
19:58:45Z attributes the one active auth grant to the Sep3 20:18 obligation.
That session remains active with provider_state active and an activation-receipt
key, but no close- or activation-abort-receipt keys. The older 19:24 obligation
has provider_state closed and all three receipt keys, with zero active grants.
These are presence checks, not fresh signature validation or nonempty-array
validation. Top-level synthetic_voice_lab ownership-key enumeration found only
the two provider epoch fields; this is not an exhaustive nested metadata audit.

Evidence: sibling vt00-c4-evidence/production-provider-attribution-20260913-1958.json
SHA256 0a70c44cbcb0e40c4ddc80766c3d44983a0f43f6cf1df53ae8f9346e4cc053b1.
No credential, raw keyed identifier, or user content was selected.

Inspected the strict activation receipt schema: it binds activation, session and
epochs, not an independent Render service/instance owner. The existing expired
unactivated-provider recovery branch requires credential_minted and no activation
receipt, so it cannot apply to this browser_active allocation. Do not broaden
that branch merely to erase the outstanding state.

Render primary deployment documentation (https://render.com/docs/deploys,
Zero-downtime deploys / Graceful shutdown) specifies replacement, original-process
termination and forced termination after shutdown delay, and notes that failed
rolling deployments can revert. This provides a possible source for a distinct
historical service-generation retirement contract, but not a receipt on its own.
Still required: allocation-to-exact-service provenance, complete source scope,
an independently verified completed cutover, and canonical provider/auth cleanup.
Current absence or elapsed time alone cannot substitute for those joins. No
retroactive controlled-restart receipt was fabricated. No production mutation,
password change, migration, gate opening or new P01 attempt; goal remains active.

### 2026-09-13 — historical Render source availability tested

Previous turn: progress with live provider/auth attribution. Created a fresh
same-browser Render tab and inspected the authenticated worker deploy history.
Current Live still points to dep-dajdfvgjo6nc73de9jog / 48bd4e713f92b2130c9eb0bfea60a2d6d563327b.
Historical dep-dact3bcmqu1s73boq6h0 is marked Deploy succeeded at
Sep3 21:59:41 GMT+2 (displayed duration 30.8s), source e3b40f1b21739479db239c383ce88285ce740152.
Retained logs show platform Live at 20:00:12Z and start:worker at 20:00:13Z
under label 5rcbs. This deployment precedes, not follows, the unresolved 20:18
allocation. A UI label is not a verified full instance ID.

Used the Logs custom date/time UI to inspect Sep3 20:15–20:30Z with no search
filter. Render returned No logs were found in the selected time range. Thus
deployment logs survive, but this bounded application-log source does not yield
the required direct allocation-to-worker join. Empty logs are not owner-death
or settlement evidence. The exact historical worker entrypoint uses
RENDER_INSTANCE_ID or a random fallback for worker identity; that source fact
does not establish the actual runtime value for this run.

Evidence: sibling vt00-c4-evidence/render-historical-worker-source-20260913.json.
Next source work must target a retained full ownership/acquisition receipt or
an independently supported service-scope reconciliation contract, not repeatedly
query this now-tested empty window. No production mutation, official P01 or
qualification run. Goal remains active; historical cleanup and release remain
unproven.

### 2026-09-13 — upgrade reconciliation is a missing implementation path

Previous turn: progress testing the retained Render application-log source.
Inspected the current runbook, recovery-upgrade.ts, recovery-backfill.ts,
recovery-backfill-inventory.ts and the PostgreSQL upgrade test call sites.
The executable upgrade does not currently support independently reconciled
erased history: EXISTS(retention_tombstones) unconditionally throws
UPGRADE_ERASED_HISTORY_UNRECONCILED. No receipt input is accepted and no durable
historical reconciliation table is consumed. The existing tests prove refusal
with a tombstone and success after the synthetic fixture tombstone is removed;
they do not prove an admissible populated-tombstone upgrade. Therefore even
obtaining fresh provider settlement would not, by itself, make the current
upgrade executable against the retained production inventory.

The next implementation work is an evidence-backed populated-history upgrade
path, with source-specific authority validation, an exact complete inventory
commitment, immutable per-erased-identity disposition, and preservation of
unresolved obligations. A confirmed remote-purge bit alone is insufficient.
No deleting historical tombstones, elapsed-retention waiver, operator boolean,
or reconstructed success receipt may substitute for missing evidence. Unknown
ownership must remain explicit and prevent allocation until independently
reconciled. D02 must retain its separate authority/settlement requirements.
The upgrade must consume the verified disposition under its existing catalog
and quiescence lock, rejecting inventory changes and missing/duplicate/foreign
entries, and retain the reconciliation independently of expiring run content.
Tests must prove a populated-history success path plus causal rejection cases;
mock validation alone cannot establish production resource zero.

This is a source-code gap, not solely a provider-support wait. Do not declare
the whole goal blocked while this aligned implementation work remains. No code
or production behavior changed in this diagnostic turn. A bounded search of
the local evidence directory for the historical run ID and run hash found no
additional JSON/Markdown receipt artifact; the original scoped rollout remains
the known partial source, and its previously established limitations remain.

### 2026-09-13 — complete historical inventory binding implemented

Previous turn: progress identifying the unconditional erased-history upgrade
refusal. Implemented historical-inventory-commitment.ts and connected it to the
read-only inventory report. Complete reports now expose inventorySha256 over
the exact migration identity, counts, run assessments and every projected
tombstone field. Ordering is canonical; observation time remains bound by the
separate report hash so an unchanged later inventory can match. Duplicate run
or tombstone identities, inconsistent totals, partial enumeration, invalid
timestamps and foreign migration identity are rejected. Incomplete inventories
return inventorySha256:null. Neither hash is a signature, source attestation,
resource-zero proof or upgrade authorization; upgradeAuthorized remains false.

Added 16 causal commitment tests and strengthened report integration assertions.
Focused inventory tests: 28 passed. Full local lab suite: 632 passed, zero failed,
29 optional database tests not selected (19287, exit 0). Runtime TypeScript
passed (66448); git diff --check passed. Report:
sibling vt00-c4-evidence/historical-inventory-commitment-full.json
SHA256 6e09cd7b3140774c1d718a3163937aacbe4785e84596510c78bbdab50b08d8e7.
No current-tree real-PostgreSQL run was made in this turn; prior DB evidence
predates this addition. All test processes ended, and no VM was started.

This completes only the exact-inventory binding layer. Source-specific verified
dispositions, durable reconciliation storage, locked upgrade consumption and
production historical cleanup remain unimplemented/unproven. The existing
erased-history upgrade refusal was not weakened, no migration hashes changed,
and no production operation or new P01 attempt occurred. Next code work must
connect authentic source evidence and immutable dispositions to this binding,
not count the commitment itself as reconciliation or repeat local tests as a
substitute for the full upgrade path.

### 2026-09-13 — private product-obligation to erased-inventory join

Previous turn: progress implementing exact inventory binding. Traced the actual
retention producer: recovery_id_hmac binds the cleanup obligation, while the
lookup HMAC separately binds run plus caller. These identities must not be
conflated. Extracted the existing byte-identical retentionHmac into
retention-identity.ts and reused it in both memory and PostgreSQL ledgers.
Added joinHistoricalObligations over a fully committed inventory and candidate
cleanup IDs from an authorized product read. It returns only candidate hashes,
exact matched tombstone hashes, unmatched rows and a report digest. Duplicate
candidates, ambiguous recovery matches and incomplete inventories reject.
Wrong keys or missing candidates remain unmatched, never zero-resource proof.
The helper explicitly returns sourceAuthenticated, ownershipProven,
cleanupProven and upgradeAuthorized all false. It does not reconstruct erased
caller/run identities or supply an acquisition receipt.

Focused tests: 32 passed. Full local lab suite: 636 passed, zero failed,
29 optional database tests not selected (37452, exit 0). Runtime TypeScript
passed (57366); git diff --check passed. Evidence:
sibling vt00-c4-evidence/historical-obligation-join-full.json
SHA256 6e749e39774fb003812f5e0c557da83f86a4cecf8dd37a5f73fb3d514cc3cef1.
No real-PostgreSQL verification of this extraction yet; prior database runs
predate it. Both active test handles are terminal. No VM or production changes.

Existing generic settlement requires the authenticated canonical recovery
response AND retained verified owner loss with its exact attempt audit. D02
separately verifies a Gateway signature bound to retained acquisition/dispatch.
Neither can be replaced by the new keyed identity join. The remaining work is
source-backed acquisition/owner reconciliation and authentic canonical settlement,
durable dispositions, locked populated-history upgrade consumption, then exact
release qualification. This helper is not an enabled ingestion endpoint, not a
live source observation and not completion of the historical recovery path.

### 2026-09-13 — PostgreSQL historical identity binding verified

Previous turn: progress with shared retention identity and private historical
join. Added real PostgreSQL setup assertions for a retained keyed tombstone:
two independent inventory reads match the stable inventory hash; adding the
row changes that hash; the product obligation joins only the exact row; the
unrelated erased row stays unmatched and upgrade authority remains false.
The existing populated-v3 refusal and transaction-wide rollback checks still
execute in the same suite. These are synthetic adapter proofs, not live cleanup
or any complete built-Sophia journey.

Created a fresh loopback PostgreSQL 18.6 cluster in the dedicated
mem00-qualification VM at /tmp/sophia-c4-historical-join.87Qm8iSe/data.
Verified database voice_lab_test_c4_historical_join_20260913, user vt00_test,
127.0.0.1:16432 before running the destructive synthetic-fixture suite.
Initial and diagnostic invocations omitted the required test reset flag;
both stopped before setup/tests and are preserved as failed invocation evidence.
Corrected invocation set SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED=YES:
17 passed, zero failed/skipped (99721, exit 0). Existing pg concurrent-query
deprecation warning remains; it was not silently recast as test failure.
Report: sibling vt00-c4-evidence/historical-obligation-join-postgres-verified.json
SHA256 9566c00762b7a62c2a675fe96842d4554a1b83e67d0abb6b575146965882bbbb.

Post-test SQL verified zero lab schemas and zero other connections. Synthetic
test fixtures were removed by suite teardown; disposable cluster files remain.
PostgreSQL stopped, the exact SSH port forward was cancelled, and the dedicated
VM was stopped. The unrelated mem00-qualification24 VM was not changed. No
production resources, gates, credentials or migration hashes changed. Historical
source authenticity, worker ownership/settlement, durable verified dispositions
and populated-history upgrade ingestion remain the next implementation work.

### 2026-09-13 — independent historical platform evidence request prepared

Previous turn: progress with real PostgreSQL inventory/identity verification.
Inspected schema attestation, upgrade and admission paths for a closed-state
upgrade that could preserve unknown history. Such preservation would still not
prove historical worker termination or canonical cleanup. No quarantine-table
migration or admission change was implemented; the current refusal remains.

Prepared a minimal Render support request in sibling
vt00-c4-evidence/render-historical-worker-support-request.md. It asks for the
full instance behind 5rcbs, complete overlapping/reverted service instances in
the bounded Sep3 window, terminal lifecycle records, process-tree guarantees and
record completeness limits. It includes only the relevant service/deployment
identities and timestamps, with no credentials, transcripts or user content.
It explicitly requests no resource mutation. Asked the user asynchronously for
permission to send this external coordination request; it has NOT been sent.

The receipt cannot be manufactured locally: the retained Render application
window was empty and product metadata lacks an acquired worker identity. A
platform response would still need exact binding and would not substitute for
provider/auth/Builder settlement. Source-backed historical reconciliation is
not supplied by the local inventory commitment or keyed identity join. No new
voice run, deployment, schema edit or production mutation occurred in this turn.
Pending approval is a new external-coordination dependency, not evidence that
the overall objective is complete or grounds to mark the goal blocked now.

### 2026-09-13 — external-coordination approval audit, second turn

Previous turn prepared the minimal source request and requested approval; this
turn has no new implementation or external evidence. Revalidated the saved draft,
latest test/cleanup record, clean diff formatting and stopped disposable VM.
No approval to contact Render has arrived. An automatic goal continuation is
not an answer to that specific external-coordination question. No request was
sent, no live wait handle exists, and this is not a verified process wait.

The identified source gap cannot be repaired by inventing an attestation schema
or accepting the existing identity-only hashes as terminal proof. Remaining
historical source-backed ingestion depends on establishing the source and its
exact evidence semantics. More local test reruns would not resolve this blocker.
This is the second consecutive turn with the pending external-coordination
dependency (counting its original request). Leave the goal active now; if the
same genuine impasse remains on the next continuation with no approval or new
authoritative evidence, apply the required blocked audit rather than repeatedly
claiming ongoing progress. Full VT00-C4 completion remains unproven.

### 2026-09-13 — external-evidence blocker confirmed, third turn

Previous turn: no progress, not a verified wait. No user approval or new
authoritative historical source evidence arrived on this continuation. The
specific permission to contact Render remains unanswered for three consecutive
turns including the original request. The prepared request remains unsent.
Known local and retained source alternatives were checked; further synthetic
tests or new identity hashes cannot establish the missing historical lifecycle
facts. Do not fabricate a terminal receipt or weaken admission to proceed.

Marking the existing full goal blocked, not complete. Resume when the user
authorizes the prepared Render support request or supplies an authoritative
alternative source. Preserve all dirty work, evidence, histories and existing
gate state. The external reply will itself require exact identity/completeness
validation and separate canonical cleanup; it will not automatically authorize
upgrade, deployment, or promotion. No new automation or production action.

### 2026-09-13 — user rejects support; support-free recovery resumed

User explicitly declined contacting Render and requested a workaround. The
support draft must remain unsent; do not ask again as a prerequisite. The full
goal is active again (verified with get_goal), with a fresh blocked audit if an
actual impasse recurs. No automatic support request or replacement automation.

Re-read the original retained tool response at line 258404 via a bounded,
content-minimizing extractor, sibling evidence/probe-retained-cleanup-source.mjs
(actual sibling folder vt00-c4-evidence). Recovered intact events 785/786 with
the same output/event hashes recorded earlier. Also examined the nested
_runner_binding rather than assuming its contents: it contains only run_id and
test_run_id_sha256, not a worker ID or lease. The test-run hash is
5e5c154ad684e4cb1b00f7e9b6b3551c012ed2da4d9d0f07e13c08e92b612a49.
The close event positively records browser disconnection and resolved process
close for the known process/boot/execution/run/obligation hashes; preceding auth
cleanup remains confirmed=false. The extractor prints only field names,
allowlisted hashes/booleans/lease epoch, never raw response contents or secrets.
Initial parsing assumed a string output; corrected it to accept the actual
array and reproduced the original serialized output hash. All probe processes
ended. No source bytes were reconstructed or modified.

Support-free investigation now targets the archived tool-call/response source
chain and existing explicit browser-process closure, plus independent deployment
containment and canonical provider/auth/Builder recovery. An archival receipt
must be source-authenticated and exactly bound before any historical-specific
recovery contract can use it. It cannot be silently recast as the missing C4
acquisition/lease proof, a D02 receipt, or a successful canonical settlement.
No workaround has yet passed the full cleanup gate; no production mutation or
new P01 attempt occurred. Do not substitute another support request for this
user-directed investigation.

### 2026-09-13 — support-free source chain and independent auth cleanup

Previous turn: progress re-reading the original close evidence, but not proving
overall settlement. Extended the bounded extractor to pair the response with
its original call_id. Response line 258404 matches call line 258402 at
20:26:28.738Z: exec references the installed
tools.mcp__codex_apps__sophia_voice_lab_inspect_voice_run and the exact target
run. Input hash b38fc3618c0c36df0f8fd812c49c84f4b5a094e34c6ba49aa73b0598638e829c.
This is archived call linkage, not yet proof of byte-preserving forwarding or
a signed independent terminal receipt. Do not overstate it as completed source
authentication. Support remains explicitly declined and no request was sent.

Found a concrete cleanup dependency in recover_voice_lab_run: any pending
provider admission skipped the exact auth cleanup routine entirely. Implemented
independent auth cleanup only when the fence returns status pending, exact code
cleanup_admission_in_flight and admission_closed is literally true, excluding
V-D02. The existing routine retains its principal/run/obligation/session-marker
and grant binding checks. Canonical session, provider and Builder components
remain pending; no admission is consumed and live-zero/complete stay false.
This reduces retained authority without using a fabricated provider settlement.
No tombstone, migration or runtime role authority was changed.

Added five component-ordering cases: closed generic success, D02 exclusion,
unclosed fence, nonboolean closed flag, and unavailable fence. Before repair the
positive case failed as expected; the initial D02 case also hit capability auth
before reaching the tested branch. The component test now explicitly supplies
validated claims, while existing route-auth tests remain intact. Entire recovery
test file: 45 passed, nine existing warnings (42334, exit 0), through Python3.12
uv. Report: sibling vt00-c4-evidence/independent-auth-cleanup-recovery.xml.
git diff --check passed. Production has NOT received this change; actual
cross-database grant revocation with a pending provider admission still requires
verification. Auth cleanup alone does not resolve historical browser/provider
ownership, full migration readiness or VT00 qualification. Goal remains active.

### 2026-09-13 — exact auth pruning scope and database guard review

Previous turn: progress implementing independent exact auth cleanup behind a
durably closed generic fence. Inspected the actual SQL auth_cleanup_transition
guard: it requires the active-to-revoked canonical tombstone shape, unchanged
signed binding, CLOSED obligation and matching provider deadline, but does not
require provider admission zero. This source review supports the intended
ordering; it is not a real product-database execution proof. D02 remains excluded.

Found that _recover_auth_sessions_sync ended with a global DELETE of every
expired revoked grant, outside the exact run's validated set. Scoped that
deletion to grant_fingerprint = ANY of the exact grants already selected,
binding-validated and locked. Empty exact sets cannot prune unrelated history.
Kept status and expiry predicates; no raw grant or signed binding mutation is
newly permitted. Ordinary-session and delayed-run conflict safeguards remain.

Added query-scope assertions to exact-marker and allocation-free auth tests;
both failed against the original global deletion. After repair the complete
recovery file passes: 45 passed, nine existing warnings (38819, exit 0), via
Python3.12 uv. Report sibling vt00-c4-evidence/scoped-auth-grant-cleanup.xml
SHA256 82ce413f0cbd605615460b06893563de51f165da06f9d3158f7e35908573936d.
git diff --check passed. The prior independent-auth report hash is
49d14e66d49a7d608603072542f6763c678e3e6d5f38b1011a57053b9d2fc4df.

No live grant was revoked, no production code deployed, no schema or role was
changed and no voice/P01 test started. Next verify actual auth transactions with
the pending-provider state and then integrate the closed-state repair into an
immutable release; the source-backed browser/provider reconciliation remains
separate and incomplete. Do not count these mocked SQL tests as production
settlement or all VT00 requirements satisfied. Support remains declined.

### 2026-09-13 — real product-DB independent auth recovery verified

Added backend/tests/test_voice_lab_auth_recovery_postgres.py, invoked via uv
from the frontend product-migration integration suite. Uses a dedicated loopback
voice_lab_test database and the actual migration runner, with recovery connected
as better_auth_app (not owner). The exact expired active grant and marked Lab
session are removed; an ordinary same-principal session and unrelated expired
revoked grant survive byte-for-byte/row-for-row checks. A browser_active provider
admission stays present, obligation stays closed with no live-cleanup or provider
settlement claim. A repeated recovery is already_terminal. No mocked database.

First isolated PG18 attempt refused the existing catalog verifier before recovery
(product-auth-recovery-postgres.json); no verifier rules were relaxed. Built
PostgreSQL 17.6 from the official source archive, SHA256
2910b85283674da2dae6ac13fe5ebbaaf3c482446396cba32e6728d3cc736d86,
inside mem00-qualification. First PG17 run passed new recovery but exposed an
existing fixture's two separately sampled clock_timestamp deadlines; changed
those two test expressions to statement_timestamp so auth_provisional deadlines
are equal. No production migration or constraint changes.

Complete real product-DB suite: 3 passed, zero skipped, session 79413 exit 0.
Evidence sibling vt00-c4-evidence/product-auth-recovery-postgres17-verified.json
SHA256 a950a8b15a813b1b9531dc76b75100ecda16bd98cce58a9ab1659c6eef85788f.
Unit regression: 45 passed, one explicit real-DB skip without fixture, nine
existing warnings. New Python test lint and git diff --check pass; frontend
focused ESLint has zero errors and eight preexisting warnings.

Teardown verified zero public product tables and zero other DB connections;
both isolated PG18 and PG17 clusters stopped and exact localhost SSH forward
cancelled. Test files remain unpublished in the dirty C4 worktree. No production
secrets/passwords, deployment, gates, admissions, or provider state changed.
This verifies a support-free auth-cleanup component, not historical provider
settlement or PROMOTE VT00. Next integrate closed-state repair into an immutable
release while retaining the separate source-backed historical cleanup gate.

### 2026-09-13 — isolated current-head auth repair candidate

Fresh git ls-remote confirms campaign branch remains
48bd4e713f92b2130c9eb0bfea60a2d6d563327b. Created a separate detached worktree
at sibling Sophia-Agent-vt00-auth-repair from that exact head, preserving all
newer remote memory changes and the entire dirty C4 worktree. Transferred only
the scoped auth route, its unit/integration regressions, and fixture docs.
Local immutable commit: 5fbf7a3909ca3d0ff48c63eebd46459dc0be639a (five files).
Worktree clean; no push or deploy yet. No migration/runtime/plugin changes.

Exact candidate unit tests: 45 passed, one real-DB fixture skip, eight existing
warnings, session44447 exit0. Evidence auth-repair-release-unit.xml SHA256
85c6c3617a8843d63baea2ca5454407b5db39afabe7f1da8aa20a774314de098.
Frontend typecheck session38366 exit0. Full backend suite is running under uv
Python3.12, session92052; poll that same handle before claiming a result or
restarting. Intended report auth-repair-release-backend.xml. Schema files are
unchanged; this candidate's recovery module SHA256 is
aa05a25bf1136a80d3632f40f6c03b278271f288748cb219fb8eeefdf83e882c.

Installed capability refresh observed2026-09-13T20:57:56.860Z, request
147c5725-46c5-4770-a0c2-c658bef9e0ca: lab48bd, product8d0d versus expectede3b40,
old installed plugin, MCP kill engaged and product mutation gates closed.
Evidence auth-repair-live-capabilities-20260913.json SHA256
b018b630f036e45a351d6579d1404705e68e489d3f980bbcbe9a230c870d2a66.
This is not an auto-deploy/Blueprint attestation: refresh those before publishing.
Repair still needs an exact authenticated historical-obligation invocation;
the retained provider source/settlement gap remains separate and cannot be
resolved merely by deploying this commit. No new P01 start or live mutation.

Read-only Render UI audit later this turn: Gateway settings shows last live
8d0d6d335d4a4a833eb827b2678b639d4b927241, deploy dep-dafiou8u01pc73akpb20;
the DOM-backed autoDeployTrigger value is Off. Main Blueprint
exs-d7bdovruibrs739mdfk0 (render.yaml, campaign branch) visibly says Sync paused.
No UI settings changed. Other linked services, lab Blueprint and Vercel still
need a fresh auto-deploy audit before publishing. Backend suite92052 remains
live, latest observed progress52%, no failure output yet; this is not a pass.

### 2026-09-13 — closed-gate auth repair published, not deployed

Backend full suite92052 completed exit0: 6109 passed,162 skipped,12 warnings in
330.10s. Report auth-repair-release-backend.xml SHA256
6db0184915e4da3bdf1655d374c1bb0c8cee7ea8e0f8e7a35b0756b396bfed68.
Do not poll92052 again or rerun merely because the prior turn was pending.

Finished prepublication read-only UI audit: Voice, LangGraph, MCP and worker
autoDeployTrigger all Off; Lab Blueprint exs-da6sqh8u01pc73cs6in0 autoSync No.
Vercel Build and Deployment shows Ignored Build Step Don't build anything,
command exit0. Together with prior Gateway Off/main Sync paused, all linked
automatic rollout controls were verified closed before publication. No settings
were edited. The three product Render services remain at8d0d6d33.

CLI push failed for unavailable local HTTPS credentials (no remote mutation).
Used connected GitHub create_tree/create_commit/non-forced update_ref instead.
Published8107a1276db13ff9be4d095aed43a4ed48f62cf0 parent48bd4e71; fetched and
ls-remote verified. Treec7daf61bf47f3033901d8810577b6299ad30412d exactly equals
tested local5fbf7a39; git diff between commits is empty. Auth-repair worktree now
clean at published8107. Local tag vt00-auth-repair-tested-20260913 preserves the
original tested commit. Dirty C4 work remains untouched.

Evidence auth-repair-publication.json records exact identities and rollout
observations. No manual deploy, production migration, grant revocation, P01 start,
or gate opening this turn. Next establish the exact authenticated historical
recovery invocation and deploy the closed repair through the existing release
controls; publishing alone does not consume or settle the retained obligation.

### 2026-09-13 — retained close-event forwarding boundary inspected

Extended bounded probe-retained-cleanup-source.mjs to parse archived call syntax
with TypeScript and redact all string literals before inspection. Call258402 is
not text(rawResponse): it awaits installed inspect(run_id exact,after_cursor782,
limit100), projects r.structuredContent, maps each event's seq/kind/source/payload
unchanged, JSON.stringify(...,null,2), then slice(0,20000). Thus intact nested
payloads785/786 were not rewritten by that projection, while the enclosing result
remains truncated. Do not claim a complete raw response or signature validation.
Archived projection says status completed, run_state product_failed; it is not
cleanup success (auth785 confirmedfalse remains).

Read exact historical e3b40f1 browser-driver: harness.browser_process_acquired is
emitted at lines771ff after startup readiness. Bounded original-task scan lines
248001..258404 found no acquisition output matching either the target run's
paired inspect call or run hash. This is NOT a claim that no acquisition ever
occurred; do not manufacture an acquisition from the close record. Do not rescan
this same window without a new hypothesis. Need a different retained source or
an explicitly validated legacy closure reconciliation, not a schema bypass.

Evidence retained-close-projection-audit.json SHA256
7ebe6fa72a34ca5177dd1d4f67f87d1445b3ad05c1cf1398d93d9fd4d8d783b9.
Probe sessions67665/96008/92699/3370/24244 all terminal; no current processes.
No deployment, DB mutation, gate change or voice start. Remote auth repair8107
remains published but not manually deployed. Support remains declined.

### 2026-09-13 — historical close semantics and causal negative matrix

Inspected exact e3b40f1 browser-driver blob d65de34822277f433bf622a42b2b0885af5955ec.
closeDisposableBrowserProcess (533ff) closes browser and server, waits boundedly,
attempts SIGKILL if needed, then requires BOTH browser.isConnected false AND
child.exitCode or signalCode nonnull. A kill dispatch returning true is not used
as terminal proof. closeContextEvent (1367ff) emits the observed successful
record only after context close and owned process close; its nonnull cleanup
hash comes from the retained exact session binding. This supports interpretation
of intact event786 as one run-owned browser process death, not all-worker death,
canonical provider settlement, or proof against a second historical lease/epoch.
No acquisition, worker lease, or provider-close receipt was reconstructed.

Added five causal cases to browser-driver-contract.test.ts in dirty C4: browser
disconnected/child alive with acknowledged kill stays false; exited or signaled
child/browser still connected stays false; disconnected plus observed exit or
signal passes. Full focused file44 passed, session65817 exit0. Typecheck44996
exit0 and diff check pass. Evidence browser-terminal-conjunction-matrix.json
SHA256 f99c3183039e1114feeb407791131d6468b9f1f845b5d866bedf57f0fafc3cd1.

No live changes. The remaining historical repair must connect this original
source evidence and the complete possible owner/epoch set to canonical provider
settlement; the current C4 acquisition/lease proof gate remains intact. These
local causal tests are not the twenty built journeys, canaries, or P01.

### 2026-09-13 — auth repair deployed to closed Gateway

Independent qualification audit: C4 twenty journeys require installed tools and
live product admission; existing suite API rejects duplicate scenario/version
pairs. Do not silently count twenty same-scenario suite entries or bypass the
historical gate with a local runner. No journey started.

Revalidated remote8107a1276db13ff9be4d095aed43a4ed48f62cf0. Through the existing
Gateway Render service's Deploy a specific commit UI, selected exact8107 and
submitted once. Service srv-d7be5s9r0fns7397l4g0, deployment
dep-dajh5fdg1s2s73aocn30. This is a closed auth-repair rollout, not candidate-C4
promotion or the full six-service campaign rollout. No env edit, Blueprint sync,
DB migration, credential change or gate opening. Prior Gateway live8d0d6d33 /
dep-dafiou8u01pc73akpb20 remains the rollback reference.

Observed building then in progress; transient version/readiness502 at21:18:27Z
during startup, not treated as terminal or grounds to repeat deploy. Render
reports Deploy succeeded|Live, service-live log21:18:32Z. Installed capability
requestcb95144a-2c42-4aad-8044-1c16b520a581 observed21:19:17.728Z confirms
Gateway exact8107, version200/readiness200, valid closed gate: enabledfalse,
killtrue, admissionfalse, mutationfalse. Protected-plane health stillfalse;
the unresolved historical/readiness state was not declared repaired. Frontend,
Voice,LangGraph remain8d0d6d33; Lab remains48bd and still expectse3b40f1.

Evidence auth-repair-gateway-deployment.json and
auth-repair-postdeploy-capabilities.json. Deployment is terminal: do not repeat
it or wait on a missing local process. Historical auth revocation still requires
its exact authenticated invocation; provider settlement remains separate.

## 2026-09-13 — existing expiry reaper workaround, local verification

Installed inspect of original run6cc3c9a0-0c9d-49f3-8da6-bd8d364c9a4b
returned RUN_NOT_FOUND (requeste6062728-f482-40cd-919c-04fe766aed36,
21:20:25.831Z). Safe summary: retained-original-run-inspection-20260913.json.
The deployed End handler requires ownedRun and cannot reach cleanup for this
missing raw record. No replacement run was created.

Investigated but did not implement a quarantined historical-schema upgrade:
simply permitting tombstones would not supply durable admission fencing or
historical ownership evidence. The v3 upgrade refusal remains intact.

Found an actionable alternative in the existing product expiry reaper, which
retains canonical obligation discovery independently of the Lab's erased run.
Its pending admission early return bypasses the already repaired exact auth
revocation function. In Sophia-Agent-vt00-auth-repair (base8107a127), patched
only that branch: non-D02, status pending, admission_closed strictly true,
code cleanup_admission_in_flight can invoke lease-fenced exact auth recovery.
It still returns false, does not call provider/Builder cleanup, does not mark
live zero, and does not purge the canonical discovery record. No new endpoint,
credential, database migration, provider call, or voice runtime was added.

Focused reaper+recovery tests: 78 passed, 8 warnings, zero skips;
auth-reaper-closed-recovery-unit-verified.xml. First report retains the invalid
D02 test fixture failure; the fixture was corrected with its required exact
worker/context/lease bindings, not by weakening production validation.
New code is local/unpublished and not deployed. Full backend verification was
started as session77179, report auth-reaper-full-backend.xml; check its terminal
result before any publication. Provider settlement and campaign gates remain
unresolved/closed. No support request or automation created.

Full backend session77179 finished exit0: 6116 passed, 162 skipped, 12 warnings,
317.29 seconds. Report auth-reaper-full-backend.xml SHA256
3eecdf840909d1e4fb5a55346504becdd512430a46ea2c21d22601e58e5c714a.
Additional overdue-admission variants were added after full-suite collection;
focused final matrix+recovery suite85passed,0skips,8warnings covers these,
report auth-reaper-overdue-recovery-unit.xml. Runtime bytes were unchanged.
Ruff and diff check passed. Preserved both files in local commit
4ff7fc1f3bdaf2b364c3d22480234b244fa843aa (parent8107a127).
Safe evidence auth-reaper-local-repair.json records file and report hashes.
Commit remains unpublished/not deployed. Next bounded step is verify publication
controls, publish this narrow repair and deploy only the closed Gateway, then
read-audit exact retained auth resources. Neither revocation nor provider zero
has yet been observed in production. No test processes remain running.

## 2026-09-13 — reaper workaround deployed; auth cleanup verified

Previous turn was progress (tested local repair). Revalidated clean local4ff7fc1f
and remote parent8107a127, all5Render auto-deployOff, main Blueprint Sync paused /
AutoSyncNo, Lab Blueprint AutoSyncNo, Vercel ignoredbuildexit0. Published using
GitHub connector nonforced branch update: f2ecc5232ddf28b5b5b273e178dac4255cc1abb8.
Tree5dbd09fbaae39d326ae82bdad034840d846515a1 exactly matches tested4ff7fc1f;
local fetch, empty diff and ls-remote confirmed. Evidence auth-reaper-publication.json.

Specific-commit Gateway deployment submitted once:
srv-d7be5s9r0fns7397l4g0 / dep-dajhfbgae00c73a0boa0. Observed Building then
In progress then Deploy succeeded|Live, service-live log21:39:37Z. Prior8107
deploymentdep-dajh5fdg1s2s73aocn30 remains rollback reference. No other service,
env, password, schema, gate, or Blueprint changed. Installed capability readback
request1aa95001-70ee-4210-8888-0a3f57e6b6b3 at21:39:59.920Z verifies Gateway
exactf2ecc523, valid closed gate, enabledfalse/killtrue/admissionfalse/mutationfalse.
Protected-plane readiness remainsfalse. Lab and other product versions unchanged.

Read-only Supabase query8b063806-19b9-4e79-959a-9ac3b365591f: at21:39:33Z
newer20:18:19obligation stillclosed with1admission,1activegrant,1boundauthsession.
At21:40:06Z: stillclosed with1admission but0activegrants/0joinedauthsessions.
Because the latter count depends on grants, ran an independent session-prefix
count at21:42:21Z: allLab-markedauthsessions0,allactiveLabgrants0,revokedgrantrows0.
No credentials/content selected. One initial editor replacement syntax error
was corrected with select-all/paste; no write query was run.

Further readback21:43:08Z: older19:24:02obligation nowcomplete with livecleanup
and settlement recorded,0admissions. Newer20:18:19obligation stillclosed,
no livecleanup/settlement,1admission. Thus auth cleanup is verified, but provider
settlement/globalresourcezero/PROMOTE remain unproven. Full safe before/after:
auth-reaper-production-readback.json. Existing overdue-admission code still
requires owning Voice durable callback; load-balanced404 is not owner-zero.

Ported the exact two-file repair into dirtyC4 using apply_patch after confirming
both pre-edit blobs matched8107. Post-edit blobs match publishedf2ecc exactly
(worker9af9d266c36691bc65c23db779cf8409526e688d,
test63f0ceaae843438bd6d14c07625594af86d66069); unrelated C4/memory work preserved.
No new P01/journey, no support request, no automation, no active local process.

Post-port dirtyC4 focused integration:85passed,0skips,9warnings,2.36seconds,
session44792exit0; auth-reaper-c4-integration-unit.xml. Deployment handle is
terminalLive; do not redeploy or restart it merely to resume this task.

### Retained activation authority audit

Revalidated remote f2ecc523 and inspected the strict browser activation model
and canonical stored projection in voice.py. Neither records worker, lease,
process, or retirement identity. Nested previous_socket_close_receipt belongs
to the previous epoch, not the currently activated candidate epoch. Therefore
do not repeat a nested-activation-field search as if it could recover historical
browser-process ownership. Source hash and exact field inventory are preserved
in retained-activation-authority-audit.json. No new settlement proof was found.

Rechecked recovery-upgrade.ts: populated erased history remains an unconditional
refusal. Removing that check alone would enable allocation without durable
unresolved-history fencing. No such change, migration, or production mutation
was made. The quarantined populated-history upgrade remains an implementation
gap, not an implemented workaround or a certified resource-zero state.

## 2026-09-13 — populated erased-history quarantine implemented locally

The preceding audit identified the gap but did not implement it. This turn
changed the local C4 extension and upgrade primitive. Default tombstone refusal
remains. Explicit expectedInventorySha256 enables only a complete erased-only
inventory (rawruns0,leases0,1–10000tombstones) under existing exact catalog,
checksum, quiescence and table/advisory locks. No identity or ownership is
reconstructed. Every original keyed locator/status/deadline is copied into a
content-independent immutable historical_quarantine table before commit.
Confirmed remote purge does not exempt any entry. Update/delete/truncate are
database-rejected; source expiry cannot discard quarantine. Triggers reject
new runs/suites/browserleases and non-End operation insert/update. Ledger health
explicitly reports historical-recovery-quarantined. The upgrade itself does
not write a host seal or touch external gates. README describes these limits.

Compiled extension hash cb51dc845ddbc7d2b26a31358053e5254f1b41d4fabe250247d8760215689c96;
composed migration28c879606b8ea36bac1e70665daac2f83531a9480a0de932eda3204d5c563198.
Historical base bytes unchanged. New functions explicitly revoke public EXECUTE;
the schema verifier caught their initial default ACL, which was corrected rather
than weakening attestation. Initial DB fixture duplicate recovery key was also
corrected; all failed reports retained. No production DDL was run.

Real PG18 disposable voice_lab_test on mem00-qualification:17passed0skips,
including beforeAll quarantine proof helper. Tests prove exact populated success,
inventory rejection, post-DDL rollback, normal startup attestation, quarantined
readiness, fresh-connection preservation after source expiry, all allocation
insert fences, immutable control. Report historical-quarantine-postgres-final.json
SHA5c509a4e60f03cb935d9c6a231a3b03799475539fa1808884f2d4a398e6dd094.
Full lab suite641passed29DBskipped; historical-quarantine-full.json
SHA9d91f5ae75cd9ed27bb0e507e2daa8edb2b9129d2fdf29f75344e06b760e85a2.
Typecheck and diff check passed. All test sessions terminal.

Guest cluster /tmp/sophia-c4-quarantine.EPfwbFRy/data stopped after zero remaining
lab schemas and zero other DB connections; localhost16432 forwarding cancelled.
VM shutdown requested in session27386; verify terminal result before considering
teardown complete. Unrelated mem00-qualification24 untouched.

This code remains unpublished/undeployed. Quarantine resolution is deliberately
not implemented or claimed: independently authenticated historical settlement
and a reviewed disposition transition remain necessary before admission can
resume. The live newer provider obligation is still unproven. No voice run,
support request, automation, gate opening, password change or promotion.

Teardown confirmed:27386exit0 and limactl reports mem00-qualification Stopped;
mem00-qualification24 remains Running and untouched. No active test processes.

## 2026-09-14 — quarantine liveness and durable diagnostic inventory

Added two real-loopback HTTP health tests: quarantine keeps healthz200 but
readyz503/mutation_readyfalse/active_runsnull with either kill-switch value.
The health handler does not query active-run/worker counts after failed ledger
health. Report historical-quarantine-http-health.json,7passed,
SHA5a8a7216fd36017dfdc09fe9edc349410cc8c7890a841c803136e78b09a39efb.

Existing inventory CLI was v3-only. Added explicit environment-selected
quarantine mode, exact current migration metadata validation, read-only repeatable
snapshot, bounded complete-count reconciliation, retained hashed locators and
original inventory commitments. No source tombstone dependency or caller-key
requirement in this mode. Invalid mode/source/rows/counts refuse; CLI errors remain
redacted. Empty or confirmed-purge rows never authorize admission or certify
cleanup. This is a diagnostic, not authenticated settlement or catalog attestation.
No quarantine discharge mechanism has been added.

Focused31passed0skips; historical-quarantine-diagnostics.json
SHAb72d47f7e4ea8735f7ff74282c00f946808c3482ecb6992ee3464c02995a95e3.
Real PG18 adapter17passed0skips including beforeAll proof of the new inventory
after source expiry and bounded truncation; historical-quarantine-diagnostics-postgres.json
SHAf91fe280cfa3b767bb62dc89ad02919e4f6b6fc331c34916b07a20d9e429dbb8.
Full local suite663passed29DBskipped; historical-quarantine-diagnostics-full.json
SHA4efa2df52d8fff83c4d632e2248214df19d5929bfa63de13398f314963348130.
Typecheck and diff check passed. Unit tests are not live voice qualification.

Disposable guest cluster /tmp/sophia-c4-quarantine-diagnostics.cba3owEi/data
used only voice_lab_test on localhost16432. Initial startup failed because the
default Unix-socket directory was not writable; switched its socket directory
to the task temporary directory without changing permissions. After tests:
zero lab schemas, zero other DB connections, cluster stopped, forward cancelled,
VM stopped confirmed session35968exit0. Unrelated qualification24 untouched.

Installed capabilities request ba6993b2-3ccf-4056-8897-7dd214b3bb0f observed
2026-09-13T22:07:39.464Z still reports MCP48bd4e7, Gatewayf2ecc523,
frontend/Voice/LangGraph8d0d6d3 versus configured expected e3b40f1. Kill engaged,
product mutation gates closed. No new run, restart, deployment, DDL, password,
support contact, automation or promotion. Quarantine/inventory changes remain
local and unpublished. Independently authenticated outstanding historical
provider/owner settlement remains unresolved; no receipt was manufactured.

## 2026-09-14 — live provider blocker revalidated

Previous turn was progress (implemented/tested durable quarantine diagnostics).
This continuation does not claim another recovery implementation or test pass.
Signed-in Supabase read-only queries,10s timeout, observed22:15:29.033085Z:
newer obligation created2026-09-03T20:18:19.486887Z remainsclosed,
live_cleanupfalse,provider_settlementfalse,admissions1. Separate follow-ups
show provider/browser_active with both deadlines expired; one bound canonical
session, one activation receipt field, zero closed resources and zero browser
close receipt fields. This rules out the hypothesis that the deployed reaper
had settled the last admission since the preceding check.

Older completed obligation no longer appears in the bounded creation-time
query; prior verified completion remains evidence, current absence is not a
new proof. Report provider-obligation-reaudit-20260914.json retains only counts,
state and dates. Old browser tab21 failed attachment twice; fresh tab122 worked.
Saved snippet was absent and the UI opened a new query; no saved query data was
overwritten. No production writes or live test starts occurred.

The existing non-D02 recovery code retains browser_active until its owning
resource supplies durable completion; neither timeout nor a non-owning replica
404 qualifies. Existing signed retained-owner/provider verifiers also require
the actual stored allocation/dispatch binding, which the erased history lacks.
Do not fabricate these fields or add an unsigned quarantine discharge switch.
Current impasse audit: first consecutive no-progress revalidation after the
diagnostics progress turn. No verified running job is being waited on. Goal
remains active; authenticated historical closure/ownership evidence is the
blocking condition, not a need for further cosmetic local tests.

### Second consecutive impasse revalidation

2026-09-13T22:19:36.683572Z signed-in SQL read-only transaction confirms the
same newer obligation closed, provider settlement absent, browser_active
admissions1. Re-read current canonical settlement verifier: closed resource,
complete canonical close/abort receipts, no pending epoch, canonical timestamp
and exact digest are required. Retained generic recovery still requires actual
verified owner-loss authority plus a fresh exact-attempt canonical receipt.
There is no supported transition from the observed activation-only record.
No new code repair or useful qualification can supply the absent historical
facts. This is no progress, not a verified wait. Goal left active for the required
blocked audit threshold. All gates unchanged; no restart/run/DDL/support request.
Audit tab123 marked handoff for reuse; next check should reuse it if available.

### Third consecutive impasse revalidation — blocked

Reused tab123 and verified the exact BEGIN READ ONLY query before execution.
At2026-09-13T22:20:18.877248Z the same obligation remainsclosed,
provider settlementfalse,browser_active admissions1. Third consecutive
no-progress goal turn with the identical missing historical closure/ownership
authority; no live test/deployment job is pending. Mark goal blocked, not complete.

Resume prerequisite: independently authenticated closure/settlement evidence
for the retained provider admission, with the exact historical ownership/binding
required by the existing recovery contracts, or a newly available authoritative
source from which that evidence can be obtained. This is not satisfied by elapsed
time, replacement-worker health, missing raw history, a fresh restart, an unsigned
operator claim, or deletion of the admission. Do not contact support against the
user's instruction. Preserve all local changes, histories and closed gates.
Quarantine/inventory code remains unpublished; promotion and live qualification
are incomplete. No further changes to production or automations were made.

## 2026-09-14 — operator accepts unverified historical closure

New user instruction supersedes the preceding blocker: “Continue the goal
without requiring verified closure”. Exact text SHA256
7c5407cd71b622c8dc70208f7b5881b4d768ac5f01dc4c03dd7350b135a01529.
Interpretation stated to user: accept previously identified unresolved history
as a disclosed exception, not proof of cleanup; preserve new-run cleanup,
authentication, per-run/concurrency limits and D02 role isolation. Runbook now
records this override. get_goal confirms active. Do not re-block solely on
missing closure evidence for that accepted historical scope.

Implemented local Lab-side admission exception: immutable per-row
historical_admission_exceptions keyed to preserved quarantine locator AND exact
inventory commitment, with authorization reference and explicit unverified
disposition. Optional admissionExceptionAuthorizationSha256 on the existing
locked erased-only upgrade records acceptance; default remains blocking.
Readiness and database allocation triggers agree on unexcepted rows. Original
quarantine is never discharged, deleted or marked settled. Diagnostic inventory
separately reports accepted/unverified versus blocked/unverified. No new runtime
API or global bypass was introduced; later rows still block.

Extension SHA35540a1e16c18cfda38e8916b809c76c0b57c26fc4a8b8ea3e44dbe932fc83ff;
composed v4 migration9407b1e0e881e9e497bb97e711067f304b3c323a50bf2b2302293b25561d5932.
Base v3 unchanged. The extension remains unpublished/undeployed.

Focused39passed0skips; historical-acceptance-focused.json
SHA845e14c755cb41dad0bc011ef2b3bf2801036488cf55d8e72aad5463758a20b6.
Full663passed29DBskips; historical-acceptance-full.json
SHA272e0e2fbfbaf4dca19280e384770f038d750e2101c2c4031da191ecfe4311c4.
RealPG18 adapter17passed0skips (both policy variants in beforeAll),
historical-acceptance-postgres-final.json
SHA33ca74a134f421f6b67f7fcc2f0458213d3425d56389326b71f8ba17703a55a5.
Tests prove accepted history permits normal run+operation creation, concurrency
still rejects a second run, records survive source expiry, exception records are
immutable, and a later quarantine identity reestablishes every allocation fence.
Initial reports retained: bare truncate hit the new FK before the immutable
trigger (CASCADE test now exercises the trigger); initial fixture called nonexistent
createRun (corrected to real createRunWithOperation). No verifier was weakened.
Typecheck/diff check passed. No live voice scenario was executed.

Disposable PG cluster /tmp/sophia-c4-historical-acceptance.UmuInEXm/data stopped
after zero lab schemas/other connections. Forward cancelled; VM shutdown90966
requested, verify terminal completion. Other VM untouched.

NEXT: integrate the same exact-obligation exception into Gateway readiness,
report accepted pending separately from completed/zero, and retain reaper
cleanup attempts. Malformed/conflicting/new obligations must still degrade
readiness. Then reconcile/publish exact release and follow deployment ordering;
do not demand historical closure again as a prerequisite. Production gates and
data are unchanged; migration, deployment, new journeys and promotion remain.

Teardown confirmed:90966exit0, mem00-qualification shutdown completed.

## 2026-09-14 — Gateway historical acceptance integrated locally

Previous turn was progress (Lab-side acceptance implementation and verification).
Added strict Gateway configuration parser for
SOPHIA_VOICE_LAB_HISTORICAL_ACCEPTANCE_JSON: exact cleanup/run hash pairs,
authorization reference, canonical past cutoff, bounded unique entries. Absent
configuration keeps default behavior; malformed configuration fails without
echoing its contents. Explicitly excludes D02 and post-cutoff/new identities.

Reaper still tries recovery and returns false for unverified historical cleanup.
Only a durably closed, overdue exact accepted scope, successful/already-terminal
auth cleanup, and typed provider-owner-ack-pending or provider-settlement-unconfirmed
result can count as accepted_historical_pending. Total pending/completed counts
remain truthful; readiness subtracts only that accepted subset, publishes the
authorization reference and historical_cleanup_verifiedfalse. Errors, malformed
records, conflicts, new pending work and invalid counters still degrade it.
Acceptance tracking resets each cycle. No provider receipt or purge is fabricated.

Found and repaired the next-cycle interaction with new runs: historical auth
maintenance formerly rejects every other active Lab run for the same principal.
Only accepted historical scope now opts into exact auth cleanup that preserves
distinct other run+cleanup pairs. Partial identity matches, wrong-principal
markers and all default callers retain rejection. SQL mutation targets remain
the exact session tokens/grant fingerprints. Already-terminal auth is explicitly
accepted, whereas not_found/pending are not. D02 path remains unchanged.

Focused final121passed0skips9warnings,3.90s;
historical-acceptance-gateway-scoped-unit.xml
SHA0065fe1738abc52fddb99f7babfdd820fa08fe972e7d0594a995b513eefec302.
Full backend6173passed162skipped13warnings,299.25s,session79770exit0;
historical-acceptance-gateway-full.xml
SHAd80cf8dc2c2733b5248908cd1c8e4edfc49a7091224abb289516f70beb826017.
Python3.12 uv sync --group dev/PYTHONPATH=. uv run used. Ruff import fixes applied
before full run; ruff and git diff check passed. No running test remains.

Fresh signed-in Supabase SQL read-only source binding confirms the newer
obligation cleanup hashd2cf113b23759fec1b4b28e0ed3541b56e7b55a81c17c85f8c55209adf2731b9
and canonical run hash5e5c154ad684e4cb1b00f7e9b6b3551c012ed2da4d9d0f07e13c08e92b612a49;
canonical run equals synthetic metadata test_run_id. Separate readback confirms
scenarioV-F01,retention deadline2026-09-03T21:18:25.546Z. Raw IDs/content/secrets
were not selected. Prepared historical-acceptance-gateway-config.json with the
existing user authorization hash and fixed cutoff2026-09-13T22:40:38.000Z
(assistant clock observation, not a claimed user-message timestamp). Parser
validates one exact pair. Config SHA26e33fe5c67c448755525bda62a168e7fff034f5775f57b9e02620cc05c1bd3f.
Source detail historical-acceptance-gateway-binding-readback.json; not deployed.

Remote campaign branch revalidated atf2ecc5232ddf28b5b5b273e178dac4255cc1abb8.
Auth-repair worktree still clean at4ff7fc1f3bdaf2b364c3d22480234b244fa843aa.
No production environment, gates, database, password, deployment or voice run
changed. No support contact/automation. Backend README and runbook document the
new narrow setting. NEXT: curate exact deployable revision (preserve all C4 and
memory work), verify closed/manual deployment controls, publish/deploy and apply
matching accepted-history scope through the reviewed ordering. Lab upgrade and
production qualification remain incomplete; historical verified closure is NOT
a prerequisite to continue under the operator exception.

### 2026-09-14 — Gateway historical acceptance exact release

Ported only the six tested Gateway policy/reaper/recovery source and regression
files into the clean auth-repair checkout; updated backend README and CLAUDE.
All C4 and memory changes remain intact. Local tested commit
124a38b7bc8a3638b02905db7827864517a6c8de has tree
c6963bae68789b1e025d8df93498ecc8fbb47e4e. Published exact matching tree as
dd6b6f8b04bee480dcf9695d69e908ecdf4394ab, direct parent
f2ecc5232ddf28b5b5b273e178dac4255cc1abb8, on the campaign branch using a
non-forced update. Fetched remote identity/tree verified after publication.

Python3.12/uv focused121passed0skips8warnings2.51s; report
historical-acceptance-release-focused.xml SHA256
5ac2ecbbd25edf89cb1856491def6772b660f64b58656e3c158e90bcfb7f8b71.
Full exact release6159passed162skipped12warnings295.07s; session73001exit0;
historical-acceptance-release-full.xml SHA256
aecb27a4fa7165198aba4dbe11434c34b4ecc340ef620bcd6df27fdd23f2dfae.
Ruff and diff checks pass; auth-repair clean after commit. Counts differ from
the dirty C4 suite because this release deliberately excludes pending C4 work.

Immediately before publication, live dashboard reads verified all five Render
services autoDeployTrigger Off, main Blueprint AutoSync No and Sync paused,
Lab Blueprint AutoSync No, and Vercel Ignored Build Step Dont build anything /
exit0. No setting changed in this verification. Installed read-only capability
request505d94ca-764b-41e8-9fd4-343f19b5137e at2026-09-13T22:59:18.763Z
reported unchanged old service identities, all product mutation gates closed,
and Lab kill switch engaged.

Manually requested only Gateway exactdd6b6f8 through Render's specific-commit
selector. Deployment dep-dajimb6k1f9s73dq2g4g was observed Building.
This is a closed code-only deployment: historical acceptance configuration
has NOT yet been installed, Lab v4 has NOT been applied, and no voice run,
password change, support contact, automation, or gate opening occurred.
Await terminal deployment and content-free exact identity/readiness, then
install the previously prepared exact nonsecret acceptance configuration
through the closed deployment workflow. Historical cleanup remains unverified;
this release does not itself qualify the voice goal.

#### Exact Gateway release and acceptance verified live

Code deployment dep-dajimb6k1f9s73dq2g4g reached Live; service-live log
2026-09-13T23:03:13Z. Installed capability request
4c2f5944-173b-4576-b23a-37f4a03a41ca at23:03:54.264Z independently
observed exactdd6b6f8 with gates closed and admission still false before config.
Saved only the previously absent historical acceptance environment key on
Gateway, with the exact one-pair policy from historical-acceptance-gateway-config.json.
No existing value, password, credential, per-run limit, D02 setting or gate changed.
Then manually deployed exactdd6b6f8 again:
dep-dajiojh594qs73cc0hrg reached Live at2026-09-13T23:07:16Z.

Installed capability request4eb4bd77-3ff4-424c-9290-b51122ad6c90
at2026-09-13T23:07:52.530Z proves exact Gateway SHA,
health_ready=true, protected_plane_ready=true, admission_ready=true,
mutation_ready=false, enabled=false, kill_switch_engaged=true.
Other product builds and Lab identity remain unchanged/mismatched; this is
not all-service readiness and does not authorize a voice start.

The public /ready read confirms reaper ready/running, discovered1,
completed0,pending1,accepted_historical_pending1,blocking_pending0,
conflicts0,malformed0,discovery_failedfalse,processing_failed0;
historical_cleanup_verifiedfalse and the exact user authorization SHA.
Last cycle2026-09-13T23:07:10.021Z. The browser readiness surface returned
Bad Gateway around rollout; installed server probe and subsequent direct
public JSON read both succeeded, so no fallback admission assertion was used.
Evidence: historical-acceptance-gateway-release.json.

NEXT: preserve this live Gateway exception while curating/publishing the complete
C4 exact candidate, perform reviewed closed Lab v4 historical inventory/exception
upgrade and all-service/config/plugin reconciliation, then qualify new runs.
No new voice runs executed. Historical closure is accepted as unverified, not a
remaining stop condition. No support contact or automation; all gates stay closed.

### 2026-09-14 — complete C4 release qualification and explicit upgrade operator

Previous turn is progress: Gateway historical acceptance was deployed and
independently observed ready without claiming historical cleanup. This turn
preserves that deployment and all dirty C4/memory work; no production mutation.

Frontend current source: typecheck passed; focused controller79/79
(useStreamVoiceSession64,useVoiceLabControlAdapter15), report
c4-release-controller-focused.json SHA65c2623c827a2870dc380b44676f241c9bfad9c5cbe7c82f9518ec6df2ef6e0e.
Full frontend1991passed3DB-skipped,222filespassed1skipped,29.74s,
session68551exit0; c4-release-frontend-full.json
SHA2afd403843feb0a2cf8b8333d8c82476a6f60fdb5bb41f5a725b487b64cb9866.
Existing act/canvas warnings retained; no failed tests.
Plain build compiled/typechecked but page collection refused missing local
Better Auth DB configuration (session73553exit1). Re-run with process-only
synthetic build secret and non-listening loopback build-only DB URL completed
all62pages (session35215exit0); no auth bypass, production credential, environment
file edit, or live browser qualification. Do not deploy this local placeholder
build: the exact hosted release rebuild must use its existing real environment.

Added src/recovery-upgrade-operator.ts and separate src/bin/upgrade-recovery.ts.
The command is not normal startup: explicit approval, closed kill-switch intent,
exact expected/runtime commit, inventory hash, existing production partition keys
and optionally explicit historical authorization are required. Immutable source
checksums validate before DB connection. Exact v3 metadata is required before
temporary reference DDL. Both catalogs derive from rollback-only reference
schemas; the existing transactional primitive then locks/rechecks actual source,
inventory, recent workers, pending operations and target catalog before commit.
No host seal/gate mutation/cleanup certification. Sanitized failures report
outcome unconfirmed, never assert rollback after a lost commit response.
Normal service startup continues to refuse v3 and independently attests/seals v4.

Focused operator15/15 passed after fixing a test parameter-table shape
(initial failed c4-upgrade-operator-focused.json retained).
Final c4-upgrade-operator-focused-final.json
SHAc3bb11c965511f48b11f0bdbe01ae8cb256832ff984c3442516f3d47eb1a52be.
Actual PG18 helper invokes the new operator for accepted history and proves no
reference schemas survive. Both accepted/default variants retain original rows
and immutability/new-identity fences. Real PG17/17 no skips,session31978exit0,
c4-upgrade-operator-postgres.json
SHA1e6402eb290e3099ac9c5854584f5f810157fdac0e20dca85c4153f8f4ca8677.
Full Lab678passed29DB-skipped,63filespassed3skipped,32.21s,
session73766exit0;c4-upgrade-operator-lab-full.json
SHA4c9d6f8591986f7b7bbf242b5ad9c3f6853794045ed2a060e6da76d1f4867ecf.
Lab typecheck/build/diff check passed.

Fixed runbook sequencing ambiguity: complete-built-journeys.md now defines
the required twenty fresh-process complete V-F01 journeys as a bounded phase
before the separate five-consecutive-canary phase. Each journey has two
observation-linked completed synthetic voice turns, distinct browser execution
identity, ordinary authentication/controller, finalization/settlement/export.
All non-live prerequisites remain mandatory; no official P01 or suite in these
collection windows. No checkpoint was marked passed from documentation/tests.

Disposable cluster /tmp/sophia-c4-upgrade-operator.TlmarVdw/data: after proof,
zero Lab/reference schemas and zero other DB connections; PostgreSQL stopped,
SSH forwarding canceled, mem00-qualification stopped(session51707exit0).
Unrelated VM untouched. No running test/build remains.
New operator sourceSHA116ae23252a31f6fbe0cc4ec6ba89ff75a8394b024c6641c3d7b05bafe3a8865;
CLI SHAf27e16de0ed3e313e5f5a47826081ddd246d3fde416d850effc781edf50c2bb3.
NEXT: commit/publish complete C4 exact source with final plugin packaging,
then execute the reviewed closed Lab upgrade and all-service rollout. Historical
closure is not a blocker; remaining new-run qualification evidence is incomplete.

### C4 plugin source repair and final packaging

Clean implementation checkpoint: 5509f5a94e6973291d7f1a357e7998620d7ff691
(tree 176a1728f8b0e77b3fe350093ce677af9af68274).
The configured personal marketplace referenced expired temporary source
/private/tmp/sophia-voice-lab-remote-b-2914be9. The supported
`codex plugin marketplace add` command replaced that source with this persistent
C4 worktree; marketplace list verified the new root. No marketplace file or
configuration was edited by hand and no installed plugin was replaced.

The default cachebuster helper produced 0.1.0+codex.20260913232552
(host clock timestamp, not an independent release attestation). Plugin and skill
validators passed through the backend uv Python environment; system Python lacked
PyYAML, so its initial validator invocations failed without validating anything.
Canonical package hash computed and independently checked:
f799c321aee48f59833918d07e4cb19d0ff2cc12ac521ea1be619affdf8b4f0b
(12 files, 46777 bytes). Registered app identity and permissions unchanged.
Reinstallation remains sequenced after matching closed production protocol
rollout. No new live run, migration, production gate change, or closure claim.

## 2026-09-14 — closed C4 rollout and MEM00 compatibility repair

Published C4 e3be7691b1c64c19e7d9f65e3bc2fda0f3b1871f reached all six services.
The Lab v3-to-v4 operator preserved 136 historical identities with the existing
operator_accepted_unverified_history authorization; no historical cleanup claim.
Detailed rollout and upgrade receipts remain in sibling vt00-c4-evidence files.
All admission/execution/product gates stayed closed. Main Blueprint was not
blanket-synced because it would overwrite existing memory settings; code-only
exact-commit deployments preserved those settings. Initial overlapping product
deploys failed; Gateway-ready then LangGraph-ready then Voice-ready retries passed.

Both Lab services now run C4 normally. Worker dep-dajjkt5g1s2s73b0qtp0 and web
dep-dajjkqvqj5pc73dssbqg report one settled closed worker and zero active runs.
Resume service initiated the exact-C4 web rebuild immediately; builds overlapped,
but acceptance required a fresh exact worker heartbeat after web startup.
Initial masked Render field edits did not persist; loaded nonsecret fields were
corrected and verified through capabilities. The authorized aggregate provider
seconds caps now report unlimited; per-run/concurrency bounds are unchanged.

Frontend signed readiness still returned 503 voice_lab_auth_ledger_not_ready.
Read-only Supabase catalog evidence identifies a sufficient cause: its exact
four-trigger check includes the independently deployed fifth MEM00 ordinary
session-delete-order trigger. That function's source hash is exactly
4087a488f957a0fb77d758de1db94f9938644411103ecfc77c62f5b9664716ce;
its search_path is pg_catalog, public and ACL is owner plus non-grantable
owner-issued service_role EXECUTE. No production schema/ACL/credential changed.

Added one shared optional-companion validator to frontend runtime and owner
preflight. It pins source, signature, trigger definition, enabled state, table,
owner, search path, language and execute authority. All four governed fences
remain mandatory; unknown/duplicate/drifted companion triggers still reject.
The memory function and migration bytes are unchanged.

Verification: 25 focused tests passed; full frontend 1992 passed, 3 DB-dependent
skipped (c4-mem00-compat-frontend-full.json SHA256
b41ccfdb119ebf4e8c12b2063283ba7011a8c3598820a7d6df1972173d86ed0c).
Typecheck passed; ESLint had zero errors, existing warnings plus import-order
warnings subsequently tidied. Local production build compiled and generated
62 pages using process-only synthetic auth material and a loopback port-1 DB
placeholder with verify-full TLS; this is not deployable configuration.

Real PG17.11 integration: all 3 tests passed, including real runtime/preflight
acceptance and rejection of PUBLIC/runtime-role grants, service_role grant
option, disabled trigger, invoker mode and source drift, plus existing backend
recovery integration. Report c4-mem00-compat-pg17.json SHA256
01c6043bb17a148b53f2a2770e5b54ca5fc410b619d6312b06c24fc13b8bfd67.
Earlier fresh-cluster setup lacked test roles; PG18 then failed preexisting
constraint-count checks before the new cases. Neither was reported as a pass.
Built PG17.11 from the official PostgreSQL source archive after checksum
verification to match production's major version, without changing unrelated
PG18 catalog assertions.

Disposable guest cluster /tmp/sophia-c4-pg17.nhAgS5t1/data, exact voice_lab_test,
loopback guest16433/host16432: zero remaining fixture tables and other connections
after tests. Both temporary PG18 and PG17 clusters stopped; forward cancelled;
mem00-qualification VM stopped. Files retained; unrelated qualification24 untouched.

Repair publication/deployment and signed readiness remain next. Installed plugin
replacement, twenty journeys, five canaries, fresh-root P01, canonical suite and
promotion are still pending. Historical waiver is not global zero certification.
