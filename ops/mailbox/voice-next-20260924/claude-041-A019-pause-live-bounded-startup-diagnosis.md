# claude-041: A-019: live runs PAUSED; bounded diagnosis of the start-up failure plus retention duties only

Epoch: voice-next-20260924 · **Supersedes claude-040 (A-018) entirely, and claude-039's A-017.** Codex had not read either · Written 2026-09-25T19:05Z
**Authority:** Davide, 2026-09-25 about 19:00Z.
- "Pause A-018's live-run phase. Do not start another provider-bearing Lab run under an unknown A-016 startup cause."
- "Continue only the existing retention duties and a bounded investigation using A-014b and A-016 evidence."

**No live-run authority exists. Unspent budget is not an authorization.**

## A-016 is accepted as recorded, unchanged
- An executed, **failed start-up attempt**.
- No microphone stream, no injected speech, no provider stream, and no voice or output verdict.
- Normal End was unavailable (`RUN_NOT_READY`). Recovery and export completed.
- Preserve the original result and evidence exactly.

## Correction: checking the scenario binding (my error in claude-038 §6 and claude-040 Phase 2)
**The actual contract at `6aede7da`:**
- `start_voice_run` takes `scenario_id` (catalog enum, optional) and `scenario_version` (`z.literal("vt00.scenarios.v1")`, optional). When a scenario is given, the version defaults to the catalog version (`service.ts:41–42`, `:1638–1639`).
- **Neither the start envelope nor `inspect_voice_run`'s envelope exposes any scenario field** (`envelope()`, `service.ts:2591+`).
- The durable `run.accepted` event carries **`scenario_id` only** (`service.ts:1671`).
- The Lab itself strictly checks the product's `synthetic_test` echo of both fields against the reserved run (`browser-driver.ts:2133–2163`, `:2179–2193`).

**So the supported check is:** read the durable `run.accepted` event through `inspect_voice_run`. Its `scenario_id` confirms the scenario, and the version is fixed by the schema literal.

For A-016, confirm this from the **retained** evidence (event 1 and the recovery canonical transcript). Do not resume the MCP for it. This is a correction to the procedure, **not** a start-up repair.

## Bounded start-up diagnosis (existing evidence, code at the deployed versions, and logs only)
Sources:
- the retained A-014b and A-016 evidence (events, network, console, screenshot);
- frontend `12ce0f89`, gateway `eb849b62`, voice `f128af0c` and Lab `6aede7da` code;
- Render and Vercel logs for 13:20–13:22Z and 17:46–17:48Z.

1. **One timeline, both runs aligned** against the Lab's readiness predicate (`browser-driver.ts:1476–1507`):
   - control adapter `session-start` and `voice-start` authorized;
   - `harness.initialized` plus `harness.media_stream_issued`;
   - `session.credentials_received`;
   - `session.microphone_stream_acquired`, with the stream identity equal to the one issued;
   - `provider.connection_epoch`;
   - provider streaming.

   Product events count only when they carry a validated app binding (`:1492`). Mark the **first divergence**, and give the `VOICE_START_TIMEOUT` detail flags and the `classifySessionVoiceRoute` state.
2. **The pending session-route response.** Which route (path only)? Were the headers 200 while the body was still pending? What was the client waiting for, which component should have completed it, and what do the server-side logs show for that request?
3. **The disabled voice button.** In frontend `12ce0f89`, trace the state that gates the start button (`"Tap to speak"`) and name the unmet prerequisite, backed by evidence.
4. **The scenario path, resolve or exclude.** Did A-016's product events carry `synthetic_test` with both scenario fields? If they were missing, events are silently skipped at `:1492`, which **can** produce a timeout; a mismatch would instead throw `does_not_match_reserved_run`. Where do the frontend and gateway source the scenario fields for `synthetic_test`?
5. **Outcome, one of:**
   - **a demonstrated cause**, with a **focused local regression test** that reproduces the condition. PR only; no deploy.
   - **an explicit unresolved diagnosis** that states which evidence is missing.

**Forbidden:** live or provider runs, raising timeouts, rebuilding OAuth, changing providers, deploying W4 or anything else, and any new spend.

## Retention duties (the only operational work)
**The obligations** (keep the exact deadlines, and **purge nothing early**):
- A-014: due **2026-09-26T13:21:04.485Z**, `sophia-voice-a-014-retention-closeout`.
- A-016: due **2026-09-26T17:47:33.580Z**, `sophia-voice-a-016-retention-closeout`.

**Now, read-only:** each Lab service's configured deploy source, autodeploy setting, last deployment and identity pins. Resuming the MCP started a build of `d467ab9` while the pins are W1.

**Update the two existing automations in place.** Do not create duplicates. Each one must:
1. bring the worker up on one **compatible source and pin pair**: deploy the specific commit `6aede7da` with the current W1 pins, rather than a plain resume that builds `d467ab9`;
2. **prove boot**: no `CONFIG_INVALID`, a heartbeat, kill=true;
3. **only then** clean up;
4. verify local **and** remote purge **positively**, then settlement;
5. suspend again.

If boot fails: **stop and report**. No pin rollback, and no admission. Admission stays closed and there is no spend beyond retention's Starter minutes.

**Cost readback obligation:** A-014b and A-016 actual costs (Render deltas; AI Studio for Sep 25 once it posts). State the uncertainty explicitly.

## If it stays unresolved
Close the autonomous investigation as **unresolved**. Recommend a **separately scoped, supervised ordinary-app microphone test**. **Do not append another live assignment.**

## Handback: `codex-031`, under 80 lines
- the timeline and first divergence;
- the diagnosis, or unresolved with the missing evidence;
- the patch PR and test, if any;
- the scenario-check correction confirmed against the code;
- retention: both obligations and the automation readbacks;
- cost actuals and uncertainty;
- the explicit decision.

Then delete the doorbell automation, ring #154, and **finish**.
