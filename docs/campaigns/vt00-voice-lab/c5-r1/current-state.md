# VT00-C5-R1 current state — 2026-09-22 16:02 UTC

**IN_PROGRESS — VOICE_LAB_INTERNAL_USE_READY not achieved.** Codex owns the serialized deployment/recovery window. The operator approved a separate $5 Voice variable-spend cap and suspension of both existing Lab services after cleanup; ordinary Sophia stays running with Lab gates closed at handover. No raw audio/video, replacement services, or new recurring charges.

Current tuple: frontend `b103c4afb8da032c2f4169d7a40e89be96a2433b` (Production `dpl_vj3NWuHsv4uf1iT5HjDJWsfLCGj8`); Gateway `7d0f0fb815a300a4416fb329d4edd8be5feec8f3`; LangGraph `def5c454e665628875cbad2ffd39a21a9f72749a`; Voice `5538d08b20a4cfed29e85e61abdffd4c22af6ce8`; MCP/worker `2deb762a7a03ca7f260ec2efd670b5993f7dc977`. Installed plugin `0.1.0+codex.20260913232552`, hash `f799c321aee48f59833918d07e4cb19d0ff2cc12ac521ea1be619affdf8b4f0b`. OAuth works through the installed controller.

Pins reconciled and signed frontend readiness verified200. Worker deploy `dep-dapa0kqd0e5s73f81ttg` Live15:36:33Z, fresh singleton hash `39ded29e3dcbe642e3f96769628abd8f82a342aef801bd54a8552d418d46362f`. MCP activation `dep-dapa2v60tbcc738un5o0` Live15:41:38Z. Admission reclosed after the failed attempt: `dep-dapa8l1srm7s73c3o7c0` Live15:53:45Z; installed get_capabilities15:55:25Z reports kill_switch=engaged with the exact tuple still verified. Both Lab services were manually suspended after positive current cleanup, verified in Render settings by16:02:15Z. MCP kill switch remains engaged in saved configuration. Ordinary Sophia stays running; its product Lab gates remain open during this serialized repair window and final closure remains outstanding. Resume existing services only for the verified candidate retry. No active owned run remains; this statement is backed by exact settlement below, not list emptiness.

First plugin attempt `4e79cd35-5d99-4ea2-998b-1cee97066bcd`, test run `248eb4ae-263d-4cf5-84e2-77b9836e4a6c`, V-O01/C5, started15:42:55Z. First speech: “Please give me one brief suggestion to focus for the next ten minutes.” Real microphone/PCM leg:48 frames,142656bytes,71328samples,58956nonzero,RMS0.088438433. No input transcript or assistant output/playback arrived during bounded observation; second adaptive utterance was correctly withheld. Provider later closed1008 “The operation was aborted.” and ordinary product continuation established epoch2. No forced reconnect was requested.

Supported End op `9777d9d1-106b-4cda-a553-802d968a4414` failed `PROVIDER_CLEANUP_UNCONFIRMED`: canonical finalization succeeded but Lab did not see the provider.stage closed callback. Source mismatch identified: current frontend intentionally fences obsolete transport callbacks when stop/terminal revokes ownership; Lab's normal End still depends on that callback. Local narrow authenticated-disconnect-evidence repair is being prepared; do not relax frontend ownership fences or D02.

Exact recovery completed15:49:43Z: browser context/process closed and registry absent (events204/205); Gateway recovery event206 authoritatively reports provider disconnected/settlement verified/admissions0, canonical session ended/watcher unregistered, Builder authoritative zero, auth terminal, cleanup admission closed/pending0, live_resources_zero=true. Execution lease released by exact CAS only after proof (event207). The browser-process receipt POST separately returned409; it is not claimed accepted. Canonical recovery independently confirmed already-terminal provider settlement. Retention remains pending until2026-09-23T15:49:04.758Z; evidence preserved, no live provider spend. Do not apply historical exceptions to this run.

Durable export succeeded: manifest `30f031cc-44de-5968-a251-06d7a5a9fa51`, SHA256 `7179e02f8391898ec4462c6676762317f6b0022be54d927d808b7d3b4e3a0262`, cleanup_complete=true. Local exact tool receipts: `evidence/2026-09-22-first-attempt.json` and `evidence/2026-09-22-first-attempt-settlement.json`. Product verdict fail; automated harness pass does not establish mission readiness. Evidence/provider scenario verdicts unavailable because no response; export availability is separately confirmed.

Next: causal normal-End repair and focused regression; investigate silent provider input without text/direct-Gemini substitution or provider upgrade. Then exact compatible rollout and affected plugin journey within remaining $5 cap, two truly adaptive turns, supported end/export/settlement, all Lab gates closed and both Lab services suspended. Actual billed cost is not yet available. Historical136 quarantined/admission-excepted inventory and Gateway accepted pending1 remain unverified unchanged.

## Previous retained checkpoint

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

## Reconnected controller and preserved newer MEM00 work

At 2026-09-21T16:26:31.943Z, installed get_capabilities succeeded after the user
reconnected the existing ChatGPT plugin. See evidence/plugin-reconnected.json.
The registered app/package hash matches the local installed package. Authorized
scopes remain read/run/fault; no new client or expanded permission was created.
Kill switch remains engaged; expected product pins are stale.

MEM00 now contains 13eb09d3e9744ebe01ced9ea551dbb6d03f613de and has an active
LangGraph deploy dep-daolkuugekts73ao8av0. Preserved that two-file memory-context
diagnostic change by merging into this branch as code candidate
406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490. No conflict. The 57 affected auth/runtime
tests passed again in 19.94s. No shared deployment or admission opening by VT00.

Hosted backend run 35622117255 ended cancelled, not passed. Its log archive
returned BlobNotFound. Architecture CI remains failed against main. Local pinned
Sentrux could start with existing bundled OpenSSL but crashed at scan (exit139),
so no actual-base result exists. Temporary measurement worktrees were removed.
The next action is a coordinated review/window for the integrated candidate,
then exact pin qualification and the one plugin demonstration.

## Authoritative rollout blocker, 2026-09-21T16:40:51Z

Claude completed independent review with no candidate regression reported and
reported 7,278 passed, 168 skipped, and two local-sandbox-encoding failures it
reproduced on the unchanged base. MEM00's deployment window is closed; its
LangGraph remains 13eb09d3 and Gateway remains46cd2302.

The requested VT00 rollout did NOT start. Although the UI continued to show its
browser operation as running, the exact tool result in the controller's execution
record is terminal: Claude Code auto mode classifier denied it as [Production Deploy]
at 16:40:51.429Z. See evidence/deployment-permission-denial.json. No Render candidate
deployment receipt exists. No alternate controller was used to bypass the denial.
User was asked to approve only the specific Gateway-then-LangGraph deployment at
406ff0a6, preserving all closed gates, rather than broaden platform permissions.

Historical J01 source records retain accepted proof557a783aa59d6e0ab2292700ff00154ce2d557b9b919f8400460c3537af4b531
and canonical settlementba413dbffaac15426bc952553804c8faf14d7c7d30cb33ed0e35dd7d018ebf61.
Installed inspection of J01 and the Sep14 fourth-window run now returns RUN_NOT_FOUND;
that is not fresh cleanup evidence and does not extend the separately accepted
unverified historical exception. Current-run settlement remains an explicit gate.
# Current checkpoint — 2026-09-21T17:02:03Z

The user manually completed the previously denied code deployment. Gateway
`dep-daom0f5bedkc73aq9f10` and LangGraph `dep-daom262d0e5s73fgogug` are live at
`406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490`. Installed-plugin capabilities independently
observe both exact builds and HTTP 200 readiness. Gateway protected-plane and
admission readiness are true, with its mutation gate still closed. See
`evidence/compatible-code-pair.json`. The earlier deployment denial remains an
accurate historical receipt, but no longer describes code-rollout completion.

The existing installed plugin is authenticated, with unchanged read/run/fault
scopes and package hash
`f799c321aee48f59833918d07e4cb19d0ff2cc12ac521ea1be619affdf8b4f0b`.
Frontend remains `a5982c6e57efde05311a6add245e0258693f1471`, Voice remains
`35c6467c36b9ae052ec3dd943cf7c9f0ac28d589`, and Lab MCP/worker source remains
`2deb762a7a03ca7f260ec2efd670b5993f7dc977`. Lab expected pins are still stale;
all Voice mutation gates remain closed. No present-run resource was allocated.

Remaining work is exact pin reconciliation and the ordered bounded activation,
the installed-plugin two-turn journey, supported end/export, current resource
settlement, ordered closure, and the established service-suspension posture.
Neither readiness nor current/historical resource zero is inferred here.
