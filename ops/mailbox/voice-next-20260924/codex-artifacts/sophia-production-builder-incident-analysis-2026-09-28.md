# Sophia production Builder incident analysis — 2026-09-28

## Scope and conclusion

This was a read-only investigation of the current production voice session, Render logs, Vercel runtime logs, LangSmith, and the served frontend/LangGraph code paths. No deployment, setting, data, memory, Lab, or retention change was made.

The background Builder did not start and then fail. It was never launched. Both voice-to-companion dispatch attempts reached `sophia-langgraph`, but memory governance denied entry before the companion model could call `start_builder_task`. No Builder child run, task, or artifact was created. The UI kept polling a valid but empty Builder state, which explains why no progress streamed.

The direct production error was `MemoryContextUnavailable(memory_context_rotation_required)`. The available logs identify the failed validation stages but deliberately suppress the more specific underlying reason, so it is not yet justified to claim a particular receipt or row mismatch.

## Affected session and timeline

All times are UTC on 2026-09-28.

| Time | Component | Event | Result |
|---|---|---|---|
| 14:23:44.914 | LangGraph | Voice companion run created; request `4f12fdb7-f6fb-4094-bf0d-92e7b0f34356`, run `01a0e866-77b0-7d30-a281-a6f615624af1` | Entered `sophia_companion` |
| 14:23:46.369 | LangGraph | Memory entry guard, diagnostic line 414 | Failed after 2,227 ms; `final_dispatch_permission=false` |
| 14:23:54.452 | Voice/Gemini | Tool call `fc_7133221861083736748` cancelled | No Builder task existed |
| 14:23:59.535 | LangGraph | Second companion run created; request `ac6eecf6-10a8-4c59-8cc5-ee28d1d43e3c`, run `01a0e866-b0c7-70e1-b7df-3bb91d4343dd` | Entered `sophia_companion` |
| 14:24:00.963 | LangGraph | Memory entry guard, diagnostic line 256 | Failed after 2,276 ms; `final_dispatch_permission=false` |
| 14:24:08.639 | Voice/Gemini | Tool call `fc_12530748653632405628` cancelled | No Builder task existed |
| 14:27:09–14:27:12 | Voice/LangSmith | Multipart trace ingest | Repeated HTTP 403 `{"error":"Forbidden"}` |
| 14:28:18–14:29:17 | Gateway | Builder canvas snapshots | HTTP 200, `active_task_present=false`, `recent_events=0`, one subscriber |

The parent Builder thread was `01a0e865-1a34-7ac0-9863-42ddf7a72633`. Artifact aggregation returned zero local, Builder-task, thread, Supabase, and merged artifacts. LangGraph subsequently reported zero pending and zero running tasks.

## What failed in LangGraph

The served LangGraph commit was `def5c454e665628875cbad2ffd39a21a9f72749a`.

The first run was denied at `memory_context.py` line 414 while `recheck_model_source_dependencies(...)` revalidated the just-recorded source input against canonical state. For an ordinary voice input, the dependency set includes the current `SourceInputWitness`. The lower-level `recheck_recorded_source()` verifies:

- the receipt exists and matches exactly;
- source snapshot owner, session, thread, and clear epoch match;
- exactly one source row exists;
- the row remains eligible and its sequence, version, and acceptance epoch match;
- the accepted version still matches.

Any failure is collapsed to `recorded_input_source_unavailable`, and the outer middleware replaces that with `memory_context_rotation_required`. Therefore, the evidence narrows the fault to this validation family but cannot distinguish a missing receipt, receipt mismatch, scope/epoch mismatch, missing or changed source row, eligibility change, or acceptance-version change.

The second run was denied at `memory_context.py` line 256 in `checkpoint_source_history(...)`, while reconstructing and verifying the prior thread state. This is consistent with a cascading failure after the first run ended before it could establish a valid checkpoint seal. The first source recheck is the primary failure; the second indicates that retrying on the same thread may preserve a state that cannot be proven.

There were no `start_builder_task` events, no `sophia_builder` child run, and no Builder completion event. The Builder worker itself was therefore not the component that failed.

## Why the UI showed no streaming or useful failure

In the deployed frontend, `voice-builder-actions.ts` creates the `[Voice build request]` message, starts `sendCompanionMessage`, and polls canonical Builder state for up to 25 seconds. It only announces that a build started after a running task appears. `gemini-browser-live-websocket-dogfood.ts` detaches this routed Builder work from the ordered provider chain and returns the eventual result to Gemini.

That confirmation rule prevented a false “started” message, but the companion failure arrived as a terminal SSE event within an HTTP-successful stream. The browser apparently did not turn it into a prompt rejection or a visible Builder failure. It waited for running state that could never appear; the provider later cancelled each tool call. This produces the observed silent panel rather than a concise “the build did not start” result.

The gateway’s polling endpoint was healthy: three observed snapshots returned HTTP 200. Their empty state accurately reflected that no task existed. This was not a streaming transport outage.

## Voice, frontend, and tracing health

The basic voice path remained healthy during the investigation. The voice service accepted provider input transcription, output transcription, `serverContent`, and usage-metadata events; provider-event POSTs returned 202 and `/ready` remained 200. The recently deployed frontend grounding change is not in the failing LangGraph path.

Vercel runtime logs showed no warning, error, or fatal event in the inspected 30-minute window. Client-side routed-call failures are not reliably represented there.

LangSmith observability is independently broken. `sophia-voice` continued to receive HTTP 403 with `{"error":"Forbidden"}` from the EU multipart-ingest endpoint after the project-setting correction. The voice project had no trace from September 28, and the main Sophia project was also stale. LangGraph marked memory trace export `unavailable` with content excluded. This now points to shared API-key scope, workspace permission/header, or credential validity rather than a voice-only project-name mismatch. It removes the traces that should expose the nested companion failure, but it did not itself stop Builder dispatch.

## Additional finding

Voice/gateway repeatedly attempted to delete an older browser session and received 404 “already gone.” This is an idempotent cleanup problem and not the Builder cause, but the terminal 404 should stop the stale retry timer.

The recurring A-014b retention-recovery log entries are the existing automation. They are unrelated to this incident and were left untouched.

## Historical comparison

The last verified successful cohort text-mode Builder launch in the available baseline was on 2026-09-19 at 21:53:48Z: task `01a0bba9-469c-7681-bb9b-fdd329eaacbd`, child run `01a0bba9-469e-7c02-944e-0d6dd2677599`, completed at 21:54:52Z with a Markdown artifact. Builder infrastructure has therefore worked in production; the current failure occurs before Builder dispatch in companion memory entry.

## Ranked causes

1. **Direct cause — companion memory-source recheck failed.** Both attempts were denied before model or tool execution, so `start_builder_task` was never called.
2. **Failure-handling defect — the voice bridge masked the terminal companion error.** It kept waiting for canonical running state instead of surfacing the failed stream and stopping the poll.
3. **Observability defect — shared LangSmith ingest is unauthorized.** Repeated EU multipart HTTP 403 responses leave both voice and companion traces absent or stale.
4. **Cleanup defect — a deleted browser session remains on a retry timer.** Repeated 404s add noise but do not affect Builder launch.

## Proposed fixes

### 1. Identify and repair the canonical source mismatch

Add non-content, field-level reason codes inside `recheck_recorded_source()`: `receipt_missing`, `receipt_mismatch`, `snapshot_scope_epoch_mismatch`, `source_missing`, `source_changed`, and `acceptance_changed`. Keep memory admission fail-closed. Compare gateway and LangGraph store identity, contract epoch, source-action receipt/signing configuration, and current source row semantics using names and equality only. Correct the canonical write/read race or mismatch revealed by those reason codes.

### 2. Prevent a failed current-input check from poisoning the next attempt

For an independently verified current input, provide a bounded ordinary-chat recovery that rotates or rebuilds a fresh companion thread from the canonical current source receipt. Do not admit stale prior sources. Ensure a run that fails before checkpoint sealing cannot leave the next attempt dependent on an unverifiable checkpoint.

### 3. Make voice Builder failure explicit

Parse terminal SSE errors even when the HTTP status is 200. Reject `sendCompanionMessage` immediately with the stable code `memory_context_rotation_required`, cancel the 25-second canonical-state poll, and publish a terminal Builder failure event for the progress panel. The Gemini response should state that the build did not start and should never imply that it did.

### 4. Restore LangSmith ingest

Verify the LangSmith identity against the EU workspace, then replace or re-scope the API key for multipart run ingestion and ensure the workspace header matches. Validate with one minimal trace in both the main Sophia project and the voice project. The existing project-name equality change alone is insufficient.

### 5. Stop terminal cleanup retries

Treat session-delete 404 “already gone” as success and clear the associated cleanup timer and local session reference.

## Validation plan for a future fix

Use a fresh private voice session and make one small explicit Markdown research request. Confirm that a `[Voice build request]` message appears, the companion run passes memory entry, `start_builder_task` produces a task and child run, the progress panel shows canonical running events, and a Markdown artifact completes. Then issue one spoken correction and confirm a fresh Builder run. Separately confirm one populated LangSmith trace for the voice session and companion run. A forced source-recheck failure should terminate promptly with a visible error and zero false “started” claims.
