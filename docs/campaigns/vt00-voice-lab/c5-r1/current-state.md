# VT00-C5-R1 current state

Updated 2026-09-21. **IN_PROGRESS — VOICE_LAB_INTERNAL_USE_READY unproven.**
Authority: user's direct VT00-C5 continuation request and adopted
`/Users/davidelaverga/Downloads/01_CONTINUATION_MISSION.md`.

## Source and coordination

Isolated worktree: `work/Sophia-Agent-vt00-c5-r1`. Base `2e949238` contains
the MEM00-C3 `46cd23026838cce6fdae7995df6c566639c33891` release and its handover.
The original selected folder has no Git metadata. Original C4 and C3 worktrees
were left intact, including C4's uncommitted finalization rejection diagnostics.
No old shared-branch deployment, reset, schema change, credential replacement,
live Voice run, or shared deployment was performed by this continuation.

MEM00-C3 owned the shared window while deploying `46cd2302`; the existing Claude
task acknowledged our coordination notice and recorded the closed window in the
[MEM00 checkpoint](../../mem00-durable-memory/c3-current-state.md).
Fresh shared mutation still requires checking for a subsequent active owner/run.

## Refreshed operations

Public health/readiness evidence is saved under `evidence/` with observation times.

| Component | Observed source |
|---|---|
| Frontend | `a5982c6e57efde05311a6add245e0258693f1471` |
| Gateway | `46cd23026838cce6fdae7995df6c566639c33891` |
| LangGraph | `46cd23026838cce6fdae7995df6c566639c33891` |
| Voice | `35c6467c36b9ae052ec3dd943cf7c9f0ac28d589` |
| Lab MCP / worker | `2deb762a7a03ca7f260ec2efd670b5993f7dc977` |
| Installed local plugin | `0.1.0+codex.20260913232552`; local hash verified below |

Installed package tree SHA-256 (12 files, 46,777 bytes):
`f799c321aee48f59833918d07e4cb19d0ff2cc12ac521ea1be619affdf8b4f0b`,
matching the prior accepted package. Authenticated server comparison is pending.

Lab web health is 200; readiness is 503 because product pins are stale. Database
schema is attested and one worker is healthy, execution-gate-settled and closed.
Both Lab services are running, not suspended, as shown by live API/heartbeat.
Gateway and Voice mutation gates are closed. Lab reports active_runs=0; this is
capacity evidence only, not resource settlement. Gateway's current reaper reports
one accepted historical pending obligation, no blocking pending obligations,
historical_cleanup_verified=false, with historical authorization hash
`7c5407cd71b622c8dc70208f7b5881b4d768ac5f01dc4c03dd7350b135a01529`.
The exception is retained as unverified history and is not expanded.

Installed `get_capabilities` returned `UNAUTHORIZED`, `oauth_token_invalid_grant`,
requiring supported reauthentication. User was asked once through the existing
connection flow. Server OAuth readiness is healthy; that does not prove this
client connection. The repeated read-only check still returned the same error.
No alternate bearer/controller was used. The old temporary
Render API credential file is absent; no historical credential was reused.

## Local repair and next action

Real authenticated Gateway session creation now uses a reservation-bound session
credential through installed receiving auth, while ordinary owner auth still
refuses the Lab principal. The overdue delete/create/read fence receives the
actual expired admission and can create only the exact opaque fence. It cannot
create model runs, read state/history, or obtain memory authority. Focused tests
cover actual create, failed persistence, lost allocation response, repeated fence,
unreserved replay, wrong-owner read and malformed fence creation. See receipts.

Candidate `d12c0b4b4917d8c3b3da27808f1026ee1152103a` is published on
`codex/vt00-c5-authenticated-session` as
[PR #149](https://github.com/davidelaverga/Sophia-Agent/pull/149), based on the
MEM00-C3 handover branch. No production deployment has occurred.

Next: review the exact candidate (655 focused tests passed), verify deployment
and spend/service permissions (including suspension agreement), and coordinate
its narrow rollout. After reauthentication,
refresh capabilities and obligations, update exact pins, then execute one governed
two-turn plugin journey and its complete close/export/settlement procedure.
The user was asked once to resolve whether post-settlement suspension covers both
Lab services; that answer remains pending. The current Codex browser needs Render
login, while the existing Claude controller has an authenticated Render session.
No new spending or continuously running service is authorized by this checkpoint.

Latest deployment access check: native UI returned that the Mac is locked and
automatic unlock failed. User was asked to unlock it. The authenticated Claude
Render session is therefore currently inaccessible; no deployment window has
been claimed and no shared mutation was attempted.

## Resumed access and CI, 2026-09-21

The Mac is unlocked. MEM00 resumed its E-phase work in the existing Claude task;
Codex sent a coordination notice and Claude acknowledged preserving PR149.
No VT00 shared deployment window was claimed. The plugin still returns
`oauth_token_invalid_grant`. Computer Use explicitly denied access to the Codex
app for safety reasons, so the user must perform the normal reconnect there.
No alternate controller or credential path was attempted.

PR149 is now ready for review (not a Voice readiness verdict). Required CI ran:
hosted lint passed; architecture run `35621734249` failed against `origin/main`
(quality 5671→4272, cycles 1→7, god files 7→27, complex functions 176→719).
This is not an isolated comparison against the actual MEM00 PR base. Review did
identify and remove a new helper→receiver circular import by passing the receiver's
fixed metadata labels into the helper. The 57 affected auth/runtime tests and Ruff
passed after this change. The pinned macOS Sentrux binary cannot run locally
because its Homebrew OpenSSL dylib is absent; no architecture pass is claimed.
