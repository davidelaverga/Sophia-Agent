# codex-049 — R-015 deployment and failed mobile Builder investigation

Written 2026-09-29. Records R-015 deployment and investigation under claude-055 as amended by claude-056; expanded at Davide's request into a detailed incident report. Readiness and validation limitations are explicit below. PR #165 remains open and draft. Tested source: `2f5c5173b442199d26f528d2ec7793b3967144a0`.

## Finding

For the session correlated to the mobile attempt, no completed governed source intake or companion run was found in the evidence inspected. Its database has **zero accepted source receipts, zero Builder handoff/run bindings, zero build-registry records, and zero artifacts**. Gateway logs show transcript persistence, but no `memory-source-actions`; LangGraph searches show no companion POST and no admission-denial event in the incident window. This places the observed failure earlier than the historical row-rewrite defect addressed by PR #165, subject to the session-correlation limitation below.

The exact browser-side cause is unresolved. Ordinary Builder tools execute locally in the browser and are removed from the event relayed to the voice server. The available logs therefore cannot distinguish a rejected/cancelled local tool call from a call that Gemini never made. The phone's existing tool diagnostics would distinguish these cases. No retry or production fix was performed during this investigation.

LangSmith is independently failing: contemporaneous multipart ingest returns HTTP 403 with `{"error":"Forbidden"}`. Both relevant EU projects remain stale. A local `trace_completed` log is not proof that a trace was successfully uploaded.

## Scope and evidence handling

- Investigation was read-only: Render logs/deployment/settings readbacks, LangSmith UI, public version/health endpoints, content-free Supabase SELECTs, and exact-commit code review.
- No new voice request, correction, typed control, Lab operation, data repair, memory action, retention action, environment edit, merge, or deployment was made during this investigation.
- The previously approved migration and LangGraph/web deployments are recorded below. They occurred before the mobile attempt.
- Message bodies, owner IDs, credentials, cookies, signed URLs, and raw provider payloads are excluded. The supplied screenshot is described, not uploaded to the repository.
- Prior forbidden threads were not queried or modified. An old thread's background 404 polling appeared incidentally in service logs and is not attributed to this mobile session.

## Deployment and migration ledger

| Component | Previous | Current / evidence |
|---|---|---|
| Supabase replace function MD5 | `1158a991bf13c2b105fe735be2350dbb` | `9e1d6ab6c1948e736742d6e7e3e4c4b4`; repeated readback during this investigation matches |
| LangGraph | `dep-dap8uvjtqb8s73fom2bg`, source `def5c454e665628875cbad2ffd39a21a9f72749a` | `dep-datv1pgu01pc73akueu0`; Render Live, source `2f5c5173…` |
| Web | `dpl_HQFC81JfbqGK2YHnpBTcCzvBaia4`, source `e601de54…` | `dpl_2vzq5ica6DEii89fcS5P9TPqnydp`; fresh Production build, source `2f5c5173…` |
| Gateway | Unchanged by R-015 | `/version` 200, `eb849b62d0e80777fbe1f333818510b0e7f1ff7f`; `/ready` 200 |
| Voice | Unchanged by R-015 | Current `/version` 200: `6f6545d6c4050526e95905a52821ba69e7e926be`; Render Live `dep-dass0759fdbs73eqoodg`; `/ready` 200 |

The migration `backend/migrations/2026_09_29_mem00_recorded_source_anchor.sql` was applied as its single BEGIN/COMMIT transaction. Source file SHA-256: `e049c0d023b7f0959c8fb872ff9d081ce649429c1569ee8fe1228ff620d50148`. Before/after owner is `postgres`; ACL is unchanged: `{postgres=X/postgres,service_role=X/postgres}`. This includes owner execute and service-role execute; no anon/authenticated grant.

Readback: the assertion that the replace definition contains `recorded_ids` is true; `sophia_memory_lookup_source_action_by_message(text,text,text)` exists; execute privileges are service_role=true, anon=false, authenticated=false. The exact trigger set is unchanged:

1. `sophia_memory_source_acceptance_epoch`
2. `sophia_memory_source_version`
3. `sophia_voice_lab_message_write_fence`
4. `zz_mem00_source_intake_version`

All migration assertions passed, so the mismatch rollback was not invoked. The migration changes functions, not existing transcript rows or receipts. It cannot repair historically invalidated receipts.

Render records LangGraph deployment start at `2026-09-29T17:09:58Z`, with the service available at approximately `17:12:31Z`. `/version` now returns HTTP 200 and the full approved SHA; `/ok` returns HTTP 200 `{"ok":true}`. Current configured branch is `codex/sophia-observability-v1`, Auto-Deploy Off, health check `/ok`; the deployment used the specific-commit action. The branch was not changed and no Blueprint sync was initiated.

**Readiness correction:** the earlier status message overstated the `/ready` check. The unauthenticated LangGraph `/ready` probe returned 401 `sophia_access_denied`, not 200. `render.yaml:20` and current Render settings designate `/ok`; the deployed custom app does not define `/ready`. Thus claude-055's literal `/ready=200` requirement is unmet, while the actual configured health check passes. This is a runbook/evidence correction, not a reason to bypass authentication.

Vercel Ready time was `2026-09-29T17:20:09Z` after a 1m29s fresh Production build. Existing build cache and the project Ignore Build Step were disabled for this deployment only; project settings/environment were not edited. The initial Preview `dpl_8qWdufMmSmmY9i46PpaARxhu4Z8q` had been cancelled by Ignore Build Step. `/api/app-version` returned HTTP 200 with both the exact approved SHA and Production deployment ID, again during this investigation. The phone's actual loaded JavaScript build ID was not captured; current server identity alone cannot prove the bundle in an already-open tab.

## Mobile incident identity and timeline

Davide reports failed build attempts a few minutes before the screenshot's 21:12 Rome clock (19:12 UTC). The only new session found in the bounded 18:45–19:15 UTC creation window is consistent with that report and the voice activity. Correlation is strong but was not confirmed by a phone-exported session ID.

| Identifier | Value |
|---|---|
| Session | `f40466b1-bb91-4d12-94d0-b7f1f77ccfd9` |
| Thread | `01a0ee8f-8253-7ff0-a9a1-eb294972539e` |
| Voice provider session | `gemini-prod-dba77902e96b44998db97ab66b2a7937` |
| Locally allocated voice trace | `01a0ee8f-a856-7af4-8467-cb06b2c04524` |
| Created / last updated | `19:06:17.506Z` / `19:12:42.337432Z` |
| Stored state at inspection | resumable, message_revision=25 |

All following times are 2026-09-29 UTC. Render's UI displays Rome time, two hours later.

| Time | Evidence | Implication |
|---|---|---|
| 19:06:19 | Gateway `GET …/memory-source-profile?thread_id=…` 200 | Source-profile request reached gateway successfully; this does not prove the browser accepted/cached its response |
| 19:06:21 | Gateway `GET …/messages` 200 | Transcript loaded |
| 19:06:27 | `voice.connect`, gemini_live, platform=voice, context_mode=gaming, preconnect=False | Voice session correlation established |
| 19:06:39–19:11:55 | 25 visible transcript PUTs, all 200; 15 touch POSTs, all 200 | Conversation persistence remained active |
| 19:07:03.515 | `gemini.relay.tool_calls`, `retrieve_memories`, call `fc_4369417869725901440` | One named tool call is evidenced on the server |
| 19:07:04.105 | Relayed toolCall sequence 99 / relay sequence 23 accepted | Tool event reached voice relay |
| 19:09:31.815 | toolCallCancellation `fc_3182201378472275365`, receive 308 / relay 75 | Cancellation observed; original tool name and effect are unknown |
| 19:10:14.889 | toolCallCancellation `fc_11102038055418069246`, receive 405 / relay 94 | Second cancellation observed; do not identify it as Builder without the browser ledger |
| 19:11:47.642 | inputTranscription receive 658 / relay 148; provider-events 202 | Speech transcription still reached the relay late in the session |
| 19:11:49–19:11:54 | outputTranscription/modelTurnAudio, provider-events 202 | Audio conversation continued |
| 19:12:11 | Gateway POST messages 200 | Final transcript write occurred |
| 19:12:28–19:12:29 | Session PATCH 200; voice DELETE 202 | End/persist requests accepted; this does not rule out an earlier transport interruption |
| 19:12:29.294 | local `gemini.langsmith.trace_completed`, event_count=156, tool_count=1, audio_attached=false | Local tracing lifecycle completed; upload still failed |

The 25 final voice rows comprise 15 user rows (`19:06:37.998Z`–`19:11:47.647Z`) and 10 assistant rows (`19:06:42.783Z`–`19:11:54.030Z`). No message text was selected. This rules out a session-wide failure to receive/persist voice transcripts; it does not prove every turn arrived through normalized SSE rather than the barge-in handoff path.

## Admission, Builder and artifact evidence

The searches below used Render's last-hour application-log view during approximately 19:16–19:26 UTC, covering the complete 19:06–19:12 incident. No absence claim extends beyond that coverage. Long log lists are virtualized; counts called “visible” are lower bounds unless the query's entire small result set was returned.

| Check | Result |
|---|---|
| Gateway `memory-source-actions` search | No matching logs; session-specific log sequence also contains none |
| LangGraph `POST /threads` search | No matching logs |
| LangGraph exact new-thread search | No matching logs (routine GET logs can use route templates, so this alone is not decisive) |
| LangGraph `memory_admission_denied` | No matching logs |
| LangGraph `memory.context.entry_denied` | No matching logs |
| Voice `builder`, `gemini.builder`, `function` searches | No matching logs; browser interception limits this evidence |
| Session governance events | 0 |
| Accepted source-action receipts | 0 |
| claude-053 Q1, adapted only to this new thread | 0 rows; version_equal/sequence_equal are **not evaluable**, not a pass |
| Build registry records for owner_thread_id | 0 |
| Artifact registry rows for thread_id or parent_thread_id | 0, including 0 Builder artifacts |
| Governed Builder handoff receipts / child run bindings | 0 / 0 |

Registry counts are not native LangGraph `async_tasks` counts. No checkpoint/message payload was read. The combined evidence shows no durable governed launch for this session; there is no task/run/artifact ID to report.

Requested refusal fields: `memory_admission_denied.stage=not observed`, `denial_reason=not observed`, `error_type=not observed`. Do not substitute `source_version_changed` from the older incident. The diagnostic marker does not cover every authentication/helper refusal. Zero accepted source receipts and no observed companion POST place the failure before completed source intake for the correlated session; an unlogged failed intake attempt is not excluded.

**Validation verdict:** Davide reports unsuccessful mobile build attempts; the correlated session has no launch evidence. The request-by-request tool ledger and private-window/fresh-bundle status were not captured, so exact compliance with the planned single-pass procedure is unverified. The investigation honored the stop condition: no further request, correction or typed control was initiated by Codex. Read-only Q1/log checks were completed for diagnosis. This session cannot establish that PR #165's source-anchor invariant succeeds or fails, because no recorded source exercised it.

## LangSmith evidence

- EU workspace was inspected in the signed-in browser. Projects: `Sophia-Gemini-Live-Voice` (`0af6dbbc-00f0-449e-bad6-4c8945f9130c`) and `Sophia` (`7dd40980-665a-4f4a-95c3-582e6270b707`).
- Project overview shows newest runs about three days old. Voice project refreshed with no September 29 incident trace; newest visible voice start is September 27 01:14:54 Rome / September 26 23:14:54 UTC. Main Sophia project also ends at that window.
- At least **50 visible multipart-ingest 403 lines** occur between `19:10:30.207Z` and `19:12:29.294Z`. Endpoint: `https://eu.api.smith.langchain.com/runs/multipart`; response detail exactly `{"error":"Forbidden"}`. This is a lower bound from the visible filtered list, not a whole-session total.
- LangGraph separately logged `/v1/metadata/submit` HTTP 204 at `19:12:26.462Z`, with n_runs=0. That metadata API success does not establish trace multipart permission.
- Consequently, the voice `trace_completed` ID cannot supply the missing tool tree. Browser-local Builder calls would also be missing from backend-only relay traces even if ingestion were repaired.
- Endpoint region is EU as requested; the generic 403 body does not distinguish key scope, project/workspace permission, or another policy. No credential/config change is justified from that body alone.

## What the screenshot means

The screenshot shows Gemini Live, setup complete, relay active, listening, “Provider transcript not surfaced,” “Mic connected, no signal,” one regression marker, and Session Ready “--”. It does not show the app SHA, tool names/results, a source receipt, companion HTTP status, or a Builder task.

At the deployed web source, the transcript headline/regression uses a positive provider-transcription count against a **capture-only** public-transcript count. The detailed summary elsewhere already considers the runtime public count. Opening telemetry late enables capture, and resetting it empties capture events. Thus these two UI sections can disagree after real transcripts have already been received. The saved voice rows demonstrate why the headline must not be treated as proof that no speech reached Session.

The microphone badge uses a diagnostic analyser/probe rather than production PCM transmission counters. An unavailable/empty probe plus runtime microphoneState=connected can display “no signal.” The screenshot and persisted speech do not establish a microphone failure. “--” is missing measured readiness timing, not proof that Gemini setup failed. These are code-supported diagnostic weaknesses; whether capture was enabled late/reset on this phone was not recorded.

## Code path and remaining failure candidates

All frontend/backend line references below are at `2f5c5173…`; see the linked detailed audits for the complete maps and qualifications.

| Boundary | Exact source | Consequence for this incident |
|---|---|---|
| Recent explicit request | `frontend/src/app/lib/voice-builder-actions.ts:263–270,349–381` | Uses the last four utterances within three minutes; `explicit_builder_request_required` can stop before intake |
| Raw transcript for intent | `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts:4018–4022,6581–6612` | Reads raw provider input, waits up to 1.5s, then checks cancellation/current connection; screenshot's normalized-transcript headline is not the guard's input |
| Browser-local routing | Same websocket file `:6468–6479,7188–7194,7270–7294` | Intercepts Builder tools and removes handled calls before backend relay; tool_count=1 is not total phone tool count |
| Bridge registration | `frontend/src/app/hooks/useSessionRouteExperience.ts:693–739` | Captures governed source, validates app version/scope, sends through text companion path |
| Source-profile readiness | `frontend/src/app/hooks/useSessionSourceInputs.ts:21–46` | Initial load errors are swallowed; later capture can raise `memory_source_profile_unavailable`; GET200 reduces a network-failure explanation but does not prove browser acceptance |
| Source recording | `frontend/src/app/hooks/useSessionSendActions.ts:127–198` | Busy/session/scope/version failures may occur before the gateway source-action request |
| Failure returned to model | `frontend/src/app/lib/voice-builder-actions.ts:576–619` | Safe `reason` and `send_error` distinguish unsent requests from refused/unconfirmed companion runs |
| Local diagnostic evidence | `frontend/src/app/hooks/useStreamVoiceSession.ts:4376–4387`; websocket file `:6383–6402` | `gemini-tool-loop-diagnostic` can contain call ID, name, phase, success, backendResponse.reason/send_error; existing phone export is the missing discriminator |
| Generic upstream 403 mapping | `frontend/src/app/api/chat/_lib/post-handler.ts:291–303` | Emits `memory_source_send_refused`; no such current request is evidenced |
| Admission diagnostic | `backend/packages/harness/deerflow/sophia/langgraph_auth.py:62–86,450–580` | Logs fixed stage and optional safe reason/error; plain helper/auth refusals are not universally instrumented |
| Post-admission entry | `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/memory_context.py:321–357` | Separate entry-denial event; no match in this attempt |

Gaming context does not disable the frontend bridge or remove Builder declarations in the reviewed code. The eight cited voice setup/prompt/tool files are identical between live voice `6f6545d6…` and tested source `2f5c5173…`; this statement applies to live voice source as well. No iOS-specific Builder route was found. Mobile can still differ in loaded bundle, browser APIs, timing, permissions and cancellation behavior; “same backend” is not proof of identical client behavior. A speculative older-Safari API problem should not be promoted to cause, particularly because the profile GET succeeded.

### Ranked conclusions

1. **High confidence for the correlated session: no launch reached completed source recording/companion admission.** This is the narrowest boundary supported by the logs plus zero receipts/bindings/registry/artifacts. It differs from the confirmed historical source-row mutation. Mapping this session to the phone remains strongly supported, not directly confirmed.
2. **Unresolved within that boundary: browser tool guard/cancellation/bridge failure versus model not invoking the intended Builder tool.** Two cancellations make local call lifecycle worth examining, but their names are unknown. No evidence currently selects one exact rejection code. The source-profile GET200 lowers, but does not eliminate, a browser readiness/profile interpretation failure.
3. **Confirmed observability failure: LangSmith multipart 403 and browser-local tool trace omissions.** These prevent exact reconstruction; neither proves the Builder's functional cause.
4. **Code-supported telemetry weakness: capture-only headline/probe states can mislead.** This is consistent with the screenshot plus successful voice persistence, not proof of the exact UI capture history.
5. **Not established for this attempt:** a renewed source-version mismatch, Mem0 recall failure, Builder execution failure after a child launch, missing artifact rendering after completion, or generic Gemini/WebSocket outage. No current evidence reaches those stages.

## Proposed next changes for Claude to plan — none applied

1. Recover the existing phone telemetry, if retained, without another run. Read only allowlisted fields: loaded build ID; call ID/name/phase; result.success; backendResponse.reason/send_error; request status; source-intake/companion dispatch flags; transcript/probe counts. Exclude utterance text, briefs, tool args, owner IDs, credentials and signed URLs. Correlate the two cancellation IDs above. If the export is gone, record that limit rather than reconstructing it from guesses.
2. Add content-free, correlated telemetry for browser-local Builder calls: reception → guard decision → source profile/version readiness → source record → companion dispatch → observed task/run. Preserve named safe failures in both the tool ledger and visible error state. Avoid logging raw backend responses. Rollback: revert that isolated instrumentation commit and redeploy the prior tested frontend commit.
3. Apply the functional fix only after the failure code is established. If readiness/profile is the cause, expose/reload valid profile state with scope/cancellation checks and align voice availability with source readiness. If explicit intent/timing or cancellation is the cause, fix that branch with captured failing-case tests, while keeping explicit user authorization and one-dispatch rules. If the model never invokes Builder, inspect effective tool declarations/prompt and preserve truthful “started” reporting. Rollback: revert the isolated functional change; keep admission guards intact.
4. Correct telemetry health calculations to use current-session runtime transcript counts consistently, and show unavailable diagnostic microphone samples as unavailable. Test late capture enable/reset and absent probe with working production voice. Rollback: revert telemetry-only change.
5. Investigate the existing LangSmith credential/workspace/project authorization read-only first. Generic Forbidden does not justify another blind project-name edit. After separately approved correction, verify a populated trace and local Builder span coverage. Rollback any approved config edit to its privately recorded prior value; never publish that value.
6. Retain PR #165 as unmerged pending review. The migration and served source are verified, but this attempt never exercised an accepted source receipt. A future validation requires separate agreement after the current failure is understood; no silent retries or old-thread repair.

Migration rollback remains the approved claude-055 sequence (reapply `2026_08_22_fc01_m01_c2_reject_stale_session_snapshots.sql`, drop the by-message lookup). LangGraph/web previous deployment IDs are recorded above. No rollback was warranted by a migration assertion mismatch, and none was performed during this analysis.

## Reproducible evidence and supporting audits

- [Production web deployment](https://vercel.com/sophia-30911edf/sophia-agent-front/2vzq5ica6DEii89fcS5P9TPqnydp)
- [LangGraph deployment](https://dashboard.render.com/web/srv-d7be5s9r0fns7397l4fg/deploys/dep-datv1pgu01pc73akueu0)
- [Voice deployment](https://dashboard.render.com/web/srv-d7be5s9r0fns7397l4f0/deploys/dep-dass0759fdbs73eqoodg)
- [PR #165](https://github.com/davidelaverga/Sophia-Agent/pull/165), head confirmed open/draft/unmerged during investigation.
- [Frontend audit](codex-artifacts/r015-mobile-frontend-audit-2f5c5173.md) — telemetry derivation, local routing, safe diagnostic fields, guarded fixes.
- [Admission audit](codex-artifacts/r015-admission-code-audit-2f5c5173.md) — complete stage/reason map, source-anchor behavior, remaining backend observation gaps and test coverage.
- Q1 is exactly the claude-053 comparison with its session filter restricted to `01a0ee8f-8253-7ff0-a9a1-eb294972539e`; it returned zero rows. Independent count query confirmed accepted_receipt_count=0 and governance_event_count=0.
- Artifact counts filter both `artifact_registry_records.thread_id` and `.parent_thread_id`; build count filters `sophia_build_registry.owner_thread_id`; handoff/run-binding counts filter the governed receipt's parent-thread fields. No content-bearing columns were returned.

The exact browser failure remains unresolved without the local tool ledger. No evidence shows the old admission race recurring in the correlated session; the next discriminating evidence is the existing phone's local Builder call/result history.
