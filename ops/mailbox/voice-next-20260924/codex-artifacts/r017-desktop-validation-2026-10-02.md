# R017 desktop validation: Builder did not start; audio output lost

Date: 2026-10-02. All evidence times below are UTC (Rome +02:00).
Scope: read-only investigation of Davide's test after the approved specific-commit LangGraph deployment. No new product request was sent by Codex. The pass stopped when failure was reported; no retry or automatic replacement was launched.

## Production baseline

- LangGraph serves 973534efa3ec48a00d919501c6e0088d84e3593a; /ok and /version both HTTP200 during investigation.
- Latest deployment dep-dave5v3bc2fs73chvgc0; prior same-SHA deployment dep-davda567bikc73dk7a0g. PR #165 unmerged.
- Code rollback target dbfaf818dcb26e14a06ad3b6191b694675d0cf1e. No rollback performed: service health remains good and this investigation does not establish that the LangGraph deployment caused the audio loss.
- Last verified web build is 2f5c5173b442199d26f528d2ec7793b3967144a0 / dpl_2vzq5ica6DEii89fcS5P9TPqnydp. Code mapping below uses that served-web baseline; browser console freshness payloads were collapsed, so this pass cannot independently identify the loaded client bundle from their objects.
- Source signature/ownership/admission/replay checks were not changed. Gateway, voice, web, settings, database schema/data, Lab, memory and retention untouched by the investigation.

## Correlation

| Identifier | Value |
|---|---|
| App session | c94bfbdb-0a7b-4fa6-9d56-bd923caa67c3 |
| Parent thread | 01a0fe86-0ee1-7070-b8b2-749d2c12061b |
| Companion run | 01a0fe88-561e-7823-b3a1-a96b067bcdac |
| Companion request | 17b76d93-27d6-46eb-a300-611717368c45 |
| Provider session | gemini-prod-e7f2c087b6d9477e8042b9d59e8709ae |

These are technical correlation IDs. No owner IDs, user utterances, model reply content, tokens, secret values or signed URLs are included.

## Timeline

| UTC | Evidence |
|---|---|
| 21:29:53.564 | New session created, from bounded SELECT-only lookup. |
| 21:30:10 | Codex recorded Davide's testing-now message. |
| 21:30:28.962 | Browser Builder Canvas SSE opened. |
| 21:32:20.39371 | Accepted source receipt's exact source timestamp. |
| 21:32:34.389248 | Same-run BuilderCommand skipped: no explicit document command. No start-envelope fast-path routing recorded. |
| 21:32:43.678547–21:32:46.582291 | Available same-run LangGraph log window; multiple HTTP200 internal reads. These reads are not child-launch proof. |
| ~21:34:17 | Davide reported he could no longer hear Sophia, while input still appeared to work; Codex asked to stop and end the session. |
| 21:34:54.997–998 | Builder Canvas SSE error and reconnect notification. |
| 21:35:13.742 | Canvas SSE reopened, 18.745 seconds after error. |
| 21:35:18.750 | Last captured app-version freshness-check warning. Browser subsequently observed at homepage without End session control. |

Exact source-actions POST HTTP status/time was not recovered from available gateway lines. The durable receipt timestamp is reported without relabeling it as an HTTP request timestamp. No handoff, child POST /runs, or child progress timestamp exists in the durable evidence.

## Authoritative Builder evidence

SELECT-only counts on this new session/thread, including a final readback after session end:

| Evidence | Count |
|---|---:|
| Accepted source receipts | 1 |
| Builder handoff receipts | 0 |
| Builder child-run bindings | 0 |
| Build registry records | 0 |
| Builder artifact records | 0 |

Q1 critical checks all true: source row exists, source version equal, sequence equal, exact created_at equal, acceptance epoch equal, metadata unchanged, thread equal. One matching message row, final=true, four revisions since source intake at the recorded Q1 readback. The timestamp was not millisecond-truncated; exact equality is the relevant passing check.

Structural SQL returned booleans/counts only:

- Accepted source is a start envelope: false.
- Accepted source is a correction envelope: true.
- Recorded start-envelope count in the session: 0.
- Recorded correction-envelope count: 1.

The SQL computed these checks inside the database; no message content was returned or printed. This identifies the forwarded protocol type, not the user's actual intent or words.

No matching admission-denial line surfaced in available memory.admission.denied or memory.context.entry_denied searches. Safe denial fields are unobserved. Render views are virtualized and searches are not a completeness guarantee; this is not a claim that no error occurred anywhere.

## Voice and browser evidence

Before ending the session, telemetry showed:

- Tool calls=4, responses=3, rejections=0, unresolved=0.
- Latest tool=start_builder_task, latest phase=tool_response_sent. An earlier observation identified update_async_task.
- Builder phase=inactive; progress and last update absent.
- WSS setup complete; relay active; consecutive relay failures=0; relay queue depth=0; no last WebSocket close.
- Provider events=369; output-audio events=228; playback generation=3.

Tool response counters prove a response was sent, not that a Builder launched. The exact later start result or frontend guard code was not captured. No missing response is inferred from 4 calls versus 3 responses because unresolved count was zero and cancellation/duplicate handling can affect counts.

Output-audio events prove receipt of provider audio at some point in the session, not audible playback after the reported failure. No output playback receipt, AudioContext state/resume outcome, final-chunk timestamp, device-routing state or loss-correlated close reason was available. No HTML audio element was present; this code uses WebAudio. Playback generation=3 alone is not proof of an abnormal flush.

The 48 captured console warnings were predominantly routine diagnostic logging: hook-start=2; snapshot-response=12; snapshot-hydrated=12; empty passive snapshot=12; sse-open=2; sse-error=1; sse-timeout-reconnect=1; app-version freshness checks=6. No error-level console entry or named WebAudio exception was captured. Freshness-check object fields were collapsed; no stale-client-detected/check-failed message was seen. Do not turn warning-level instrumentation into 48 application failures.

## LangSmith follow-up after sign-in

Initial inspection reached an expired browser login; Davide signed in again. Follow-up completed early Oct 3 Rome time, for the same Oct 2 UTC session. No further product test was run.

- In the EU workspace, both Sophia and Sophia-Gemini-Live-Voice showed no runs in a last-three-hours window containing the test, including the individual Runs view. The project list still showed their most recent runs six days earlier. The additional project named with literal quotation marks around Sophia had no recent runs (most recent three months earlier).
- Voice seven-day view contained older gemini_live_conversation traces only: newest 9/27/2026 01:14:54 displayed time; other visible entries 9/26 23:28:58, 17:46:06 and 17:45:47. No current trace payload could be inspected. One old input cell rendered text but its actual payload presence was not verified; output cell was empty/placeholder. Do not reinterpret old payloads as this test's data.
- Current-session Render log correlation: trace_id 01a0fe86-adaf-7bb0-a295-c1f9ded2f70d, trace_started at 2026-10-02T21:30:34.288121986Z, trace_completed at 21:35:12.736306232Z, tool_count=0. Browser telemetry's four calls concern the browser tool bridge and are not proven to share the backend export counter's semantics.
- Current voice service logs explicitly contain 403 Forbidden for EU https://eu.api.smith.langchain.com/runs/multipart during this test. The rendered sample contained 47 such error lines between 21:31:22.135509021Z and 21:35:12.735952933Z, including finalization. This is a bounded/virtualized lower-bound sample of log lines, not a unique HTTP-request count or exhaustive total.
- At voice commit 6f6545d6, voice/realtime/gemini_langsmith_tracing.py logs trace_started after RunTree.post (around775–782). Its close path patches/flushes then logs trace_completed (around1216–1227). The same-session multipart403 plus absent current UI runs establish that the completed marker is not proof of ingestion acceptance.

Confirmed tracing problem: EU multipart ingestion rejection. Wrong US endpoint is not supported by the observed EU URL. The response establishes HTTP403; it does not identify which key/project/workspace permission is wrong. No endpoint, project, key, settings or access changes applied. This blocks current-trace inspection; it does not identify the missing start-envelope or audio-playback cause by itself.

## Code mapping and ranked explanation

1. Confirmed lifecycle/routing mismatch before any child launch. At web baseline 2f5c5173, frontend/src/app/lib/voice-builder-actions.ts buildVoiceBuilderChangeMessage emits the correction protocol (around 284); change (around 397) forwards it without verifying a current active build or durable completed artifact. Its start path (around 349) applies missing-brief, explicit-request and active-task checks before sending a start envelope (around 378). In this session a correction was forwarded, but a later provider start call did not yield a recorded start envelope. Which guard/delivery path explains that later call remains unknown.
2. R017's deterministic start route was not exercised. At LangGraph973534ef, backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_command.py parses only the start header/nonempty brief; corrections deliberately continue to the model. The observed skip line is consistent with the recorded correction. This pass does not demonstrate that the new start parser or carrier fix failed.
3. Canvas transport interruption is a separate observed symptom. frontend/src/app/hooks/useBuilderCanvas.ts handleBuilderCanvasSseError (around446) marks reconnecting and hydrates; handleBuilderCanvasSseOpen (around458) clears it. Reconnect timing is observed. Empty snapshots also match zero durable jobs; they cannot hide a child that the database counts do not contain.
4. Audio-output cause remains unresolved. frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts resumes AudioContext around1685, schedules WebAudio sources around9303, and flushes pending/active sources while incrementing playback generation around9418. These are candidate inspection points, not a diagnosed failure. The provider might also have stopped producing new audio after the last recorded chunks; the available counters cannot distinguish that from suspended/dropped playback or device routing.

Proposed changes for Claude to assess, not applied: reject or clarify update/edit requests without an actual current task/artifact instead of sending a correction-only intake; preserve explicit start authority and log only safe bridge outcome codes; add focused tests for update-before-start and rejected starts; collect content-free output receipt/context diagnostics around the audio failure. Keep governed admission/signature/source/replay checks intact. Do not silently convert an ambiguous correction into a new billable task. Each eventual fix needs its own review, exact-commit deploy scope and rollback to the prior verified component commit.

Verdict: VOICE_BUILDER_FLOW_FAILED_BEFORE_START_ROUTE; R017_START_ROUTE_NOT_EXERCISED; AUDIO_OUTPUT_FAILURE_REPORTED_CAUSE_UNRESOLVED. Stop. No merge, deployment, settings edit, product retry, Lab run, data repair or memory/retention action performed during this investigation.
