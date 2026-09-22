# VT00-C5-R1 mutation and test receipts

Actions below are local unless explicitly identified as publication or public read-only.

- Created a detached isolated worktree from C3 `5f4ed1cb`, then fast-forwarded to
  `46cd2302` and `2e949238` as MEM00 published its repair and handover. Preserved
  the new Voice changes and both original worktrees. No shared deployment.
- Bootstrapped `backend/` with `uv sync --group dev`: Python 3.12.14,
  langgraph-api 0.8.1, langgraph-runtime-inmem 0.28.0, SDK 0.3.9, httpx 0.28.1.
- Causal red: after correcting the disposable retention clock fixture, the real
  authenticated `sessions/start` path failed in `OwnerScopedAuth` with
  `LangGraphServiceAuthError: langgraph_service_auth_denied`. No constructed
  receiving AuthContext was used. Original signing prohibition is unchanged.
- Added exact reserved-thread transport authentication and receiving policy;
  wired session creation, failed-start discard and all three overdue fence callers.
- Fixed test-only seams: per-request task isolation for the installed runtime's
  request-local auth context; included the runtime's empty `crons` storage.
- `PYTHONPATH=. uv run pytest` for session auth runtime, ordinary session signing,
  session routes, recovery, service-auth, service-lane and installed-lane tests:
  **162 passed**. Raw receipt: `evidence/focused-tests.txt`.
- Exact-authority negative cases plus capability, process-termination and retention
  reaper tests: **173 passed**. Raw receipt: `evidence/lifecycle-tests.txt`.
- Repository-required nine-file Gateway/Builder sweep plus installed framework
  auth regressions: **320 passed**, including ordinary synthetic finalization,
  repeat end/idempotency, wrong-run and failed lifecycle persistence. Raw receipt:
  `evidence/gateway-tests.txt`. No full destructive-fault campaign was run.
- Expanded installed-policy negatives use an authentic still-reserved credential
  while changing thread, principal, graph or obligation: each returns 403.
  Rechecked runtime/authority files: **12 passed**, `evidence/auth-tests.txt`.
  The three disjoint suites cover 655 tests; the 12-test recheck overlaps them.
- Final review reserved opaque fence metadata against ordinary owner writes and
  bound the discard caller identity to the configured Lab principal. Rechecked
  affected auth/runtime suites: **60 passed**, `evidence/final-auth-tests.txt`.
- Targeted `uv run ruff check` on all six changed/new Python files: passed.
  Nine existing Pydantic schema-name warnings remain; no dependency changes.

These tests exercise disposable stores, real installed auth and runtime filters.
They are not hosted SQL qualification, a live plugin journey, provider closure
proof, or a readiness verdict. No schema or cleanup-ledger function changed.

- Publication: committed code and receipts as `d12c0b4b4917d8c3b3da27808f1026ee1152103a`,
  pushed `codex/vt00-c5-authenticated-session` through the existing authorized SSH
  identity, and created draft [PR #149](https://github.com/davidelaverga/Sophia-Agent/pull/149)
  against `codex/mem00-c3-first-use`. Attached the PR to the current Codex task.
  Removed duplicate `.log` copies; retained the identical `.txt` evidence.

- GitHub candidate checks: combined commit statuses empty; Unit Tests run
  `35613143170` and Architecture gate run `35613142610` both concluded `skipped`
  on the draft PR. These are not additional passing test evidence.

- Resumption: Mac unlocked; MEM00 resumed, acknowledged the coordination notice,
  and retains the current shared window. No VT00 deployment/run occurred.
- Marked PR149 ready for review to execute the repository-required CI. Hosted
  lint passed. Sentrux run 35621734249 failed against origin/main, not the PR base.
  Backend run 35621734266 was still running when the follow-up was prepared.
- Removed the new helper→receiver circular import without changing auth labels or
  policy. Exact receiver constants are now passed to the helper. Rechecked runtime,
  authority, framework-auth, service-lanes and lane-runtime suites: 57 passed in
  11.67s. Ruff and diff checks passed. This supersedes the original code candidate
  for deployment; do not deploy d12c0b4b without this follow-up.
- Downloaded the CI-pinned Sentrux v0.5.7 macOS binary from its official GitHub
  release into runtime-tools. It failed before execution because the required
  Homebrew OpenSSL library is absent. No local architecture result was produced.

- User completed supported OAuth reconnect. Installed get_capabilities succeeded,
  matching package hash and previous bounded limits; saved plugin-reconnected.json.
- Integrated newer MEM00 commit 13eb09d3 without conflicts as 406ff0a6; affected
  auth/runtime suites passed again: 57 tests in 19.94s.
- Backend CI 35622117255 ended cancelled; no test-pass inference.
- Local Sentrux scan with bundled OpenSSL exited139; no baseline was generated.
  Removed the two clean, temporary measurement worktrees.

- Read the deployment controller's exact terminal tool result after its UI remained
  stale. Production deploy was denied by its automatic approval classifier at
  16:40:51.429Z. No retry/alternate deployment route was attempted. User asked for
  approval of the specific action only. Candidate code remains406ff0a6.

## 2026-09-22 renewed first-use window

- User directly approved a separate $5 Voice cap and suspension of both isolated Lab services after cleanup; ordinary Sophia remains running with Lab gates closed. No memory budget inference.
- Read-only installed capabilities verified existing OAuth/package, worker2deb and current product tuple; stale frontend/backend/LangGraph pins and signed frontend409 block admission. Runtime capability verifier maps expected-build mismatch to409.
- Current Gateway/LangGraph retain the session/fence repair byte-for-byte against406ff0a6 in sessions, recovery, thread-auth and receiver files; shared signer only moves the user-validator import. Reused the recorded655 focused lifecycle/auth regressions and57 integration rechecks. No schema or source edit required yet.
- MCP environment kill switch savedtrue, then exact2deb deployment dep-dap9rertqb8s73frhi70 started. No latest-branch deploy. Worker expected frontend/backend/LangGraph pins savedb103c4af/7d0f0fb8/def5c454, not yet deployed; Voice pin5538d08b preserved. MCP pin update/open remains later.
- Authenticated MCP Web Shell read-only transaction, statement timeout5s: runs[], operations[], browser_leases[]. Five retained recovery controls report live_cleanup_complete=true (10f1c17a,1ef0fd45,59ed1e58,939d10ae,fce8fc66); first control execution_cleanup_proof absent, remaining four present. Historical quarantine136/exceptions136 retained unverified. These observations are not global historical cleanup certification. Supabase memory database lacks the Lab schema; its failed read was not used as inventory proof.
- No plugin start/speech/provider allocation performed in this window yet. Current MCP closure deployment is still Building with clone-stage logs at15:24:46Z; do not restart based on observation timeout.

- First closure deployment dep-dap9rertqb8s73frhi70 became Live15:30:23Z but runtime gate remainedopen. Direct saved-value readback showedfalse: Render lazy-loaded masked fields overwrote the initial edit. This is a failed configuration attempt, not verified closure. Changed approach: reveal ONLY non-secret gate/pin values, wait for them to load, edit, verify buffer, save and reload-readback. MCP savedtrue then exact2deb redeploy started; worker saved pins were likewise corrected after loaded-buffer verification. No secrets intentionally revealed or copied; an existing consent field was exposed in the initial tool-provided page state, so subsequent environment observations are narrowly filtered. No credential rotation or expansion performed.

- Corrected MCP closure dep-dap9vl80cd8s73c93r5g Live15:34:40Z; public runtime confirms kill_switch_engaged/mcp_closedtrue. Worker dep-dapa0kqd0e5s73f81ttg Live15:36:33Z; singleton fresh boot15:36:42.611Z/heartbeat44 observed15:38:11.134Z, browser/TTS/fixtures ready, open gatefalse, exact deployment hash39ded29e3dcbe642e3f96769628abd8f82a342aef801bd54a8552d418d46362f equals expected current tuple.
- Signed frontend read-only readiness via deployed probe with corrected expected pins returned verified/HTTP200. Existing ledger compatibility repair passes; no new schema/config weakening needed. MCP current runtime stillclosed during this diagnostic.


### 2026-09-22 installed-plugin first attempt and safe recovery

MCP opening deployment `dep-dapa2v60tbcc738un5o0` Live15:41:38Z on exact2deb762a. Installed capabilities15:42:29Z verified full current tuple. start4e79cd35-5d99-4ea2-998b-1cee97066bcd succeeded through ordinary Sophia UI; one espeak utterance reached real PCM, but no input transcript/output/playback. No second adaptive speech was fabricated. Supported End was durably accepted and then failed PROVIDER_CLEANUP_UNCONFIRMED. Worker performed existing automatic recovery; exact positive live-resource-zero receipt206 plus owned browser-process closure204 and lease release207 confirmed settlement. Export returned durable manifest30f031cc-44de-5968-a251-06d7a5a9fa51 / SHA7179e02f8391898ec4462c6676762317f6b0022be54d927d808b7d3b4e3a0262 / cleanup_complete=true. Retention pending24h is explicit and separate from live effects.

MCP admission closed again with saved/readback verified booleantrue and exact2deb deployment `dep-dapa8l1srm7s73c3o7c0`, Live15:53:45Z. Installed get_capabilities15:55:25Z confirms kill_switch engaged; source/target identity unchanged. No overlapping worker or product deployment, no active-run restart. Both Lab services remain running temporarily for local repair; suspension is still owed.

Source investigation: current frontend stopTalking/reset/terminal paths revoke callback ownership before asynchronous transport closes. The Lab driver still waits for callback-derived provider.stage closed; this is incompatible with the preserved ownership fence. A narrow driver repair is being developed to verify the actual authenticated ordinary provider-disconnect response and all observed epochs. No frontend fence relaxation or D02 change authorized by this diagnosis. PCM encoding matches documented 16-bit little-endian audio/pcm;rate=16000 and uses audioStreamEnd with default automatic activity detection. Silent provider reply cause remains unproven; no provider upgrade, fake transcript, or direct model experiment performed. Reference: https://ai.google.dev/gemini-api/docs/live-api/capabilities (read2026-09-22).

Both existing Lab services subsequently manually suspended via Render after current settlement: worker srv-da6uiqfavr4c739mtbo0 then MCP srv-da6uiqfavr4c739mtbng. Settings showed Suspended/Manually suspended/Resume for each, verified by2026-09-22T16:02:15Z. No deletion, plan change, or credential change. Product services remain running; their Lab gates still await final closure.


### Narrow normal-End repair qualification — 2026-09-22 16:04 UTC

Only Lab browser driver/worker and focused tests changed. Ordinary page disconnect response is observed passively before the End click; exact origin/path/POST/JSON202, provider session, canonical submitted/accepted receipt equality, complete epoch coverage, and real current websocket closure required. Proof records authenticated receiving acknowledgement as basis. Failed End persists already obtained finalization through worker recovery. No frontend ownership fence, receiving authentication, memory authority or D02 policy changed.

Runtime Node22.22.0/pnpm10.26.2. `pnpm typecheck`, `git diff --check`, and149 tests across seven suites passed in6.54s: normal-provider-disconnect, browser-driver-contract, execution-epoch-cleanup, operation-terminal-cleanup-heartbeat, service-ledger, input-evidence, cleanup-authority. Exact command from tools/sophia-voice-lab:

```sh
PATH=/tmp/node-v22.22.0-darwin-arm64/bin:$PATH /tmp/node-v22.22.0-darwin-arm64/bin/node /Users/davidelaverga/.cache/node/corepack/v1/pnpm/10.26.2/bin/pnpm.cjs test test/normal-provider-disconnect.test.ts test/browser-driver-contract.test.ts test/execution-epoch-cleanup.test.ts test/operation-terminal-cleanup-heartbeat.test.ts test/service-ledger.test.ts test/input-evidence.test.ts test/cleanup-authority.test.ts
```

Causal baseline: replaced only end() with HEAD old body, ran new real-driver success fixture with20s test timeout, reproduced PROVIDER_CLEANUP_UNCONFIRMED after10.10s despite valid receiving202/socket receipts. Fixed body restored before passing qualification. Negative fixture rejects401 while retaining finalization and browser recovery ownership.

Independent read-only review found no blocking correctness/security issue for C5 ordinary End. Conservative contiguous epoch coverage may reject previously settled epochs or future aborted activations after reconnect; those paths are not certified by this patch. This limit cannot produce false cleanup success. No live acceptance or Voice readiness is claimed from these checks.
