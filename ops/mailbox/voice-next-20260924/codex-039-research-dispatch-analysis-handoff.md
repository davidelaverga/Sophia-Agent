# codex-039 — Research dispatch failure: analysis handoff

For Claude; 2026-09-27. Davide requested this analysis handoff. No implementation/deployment authorization.
Public-safe summary: private session/trace identifiers, raw conversation/audio, credentials and environment dumps remain excluded.

## Incident and current release
- Operator confirmed ordinary voice works after R-005, then reported that Sophia claimed to launch a research task with Markdown delivery, but no progress/artifact appeared.
- PR #161: reviewed head a836d4da8f68d6f9ea9b38c845ed28f57a8317fe; merged production SHA 87d471f2318b045b7d86b5c1224f4d4276c0c191; Vercel dpl_4jVRzMq4L1ANhx8nAWcR4uzBvptP.
- Public app-version and signed readiness verified the merged SHA; Lab/adapter off, kill switches on. Operator confirmation supersedes the previously pending mic check.
- R-005 fixed ordinary-lane null cleanup-authority validation only. Typecheck passed; connector 102/102 and hook 64/64 tests passed; automatic review completed before approved deployment.
- Gateway eb849b62d0e80777fbe1f333818510b0e7f1ff7f, voice f128af0c5604139b3d20d10424877001b1c0a7cd, LangGraph def5c454 unchanged by that deployment.
- Existing rollback target dpl_BBWRrjKMfsbDdRHFE7AJ4vua3ErV (12ce0f89) is context only, not a rollback recommendation.

## Evidence and limits
| Check | Observation | Limit |
|---|---|---|
| Browser voice telemetry | WSS/public SSE/relay connected; 4 calls, 4 responses, 0 rejections/unresolved; last tool coreview_get_builder_status | Other three names/results not recovered; four calls need not mean four distinct tools |
| Browser task/artifacts | Builder inactive, no active step, artifacts 0, Builder events 0 | Inspected session only |
| Render gateway | Matching parent snapshot HTTP200, active_task_present=False, recent_events=0; artifact totals 0 | No running task visible in that parent; does not prove no attempted dispatch |
| Render gateway events | HTTP200, active_task_id=None, active_run_id=None, replay_count=0 | Endpoint reachable with no work to stream |
| Render LangGraph | No matching Builder logs in inspected window; queue/worker snapshots active=0, pending=0, running=0 | Negative search is not exhaustive execution proof |
| Render voice/relay | Readiness200, relays202, continuation bootstrap200/setupComplete; no matching toolCall/CoreView execution logs | Browser-local calls can bypass these logs |
| Later browser transport | SSE error/timeout/reconnect then reopen; WSS close1008 'The operation was aborted' then setupComplete | Secondary symptoms; empty Builder snapshots preceded them; causality unproven |
| LangSmith voice trace | Cleared filters, refreshed, traversed entire displayed virtualized tree with overlapping scrolls; further scrolling added no spans | UI census, not a raw provider-event export |
| LangSmith census | 304 unique spans: root1, setupComplete48, input_transcription16, output_transcription207, interrupted3, turn_complete15, server_content13, goAway1 | Includes later reconnects; function_call/function_response/Builder spans0 |
| LangSmith content | structural mode; inspected input text stored as kind/char_length, not words; audio capture false | Cannot reconstruct spoken request/reply or arguments verbatim |
| LangSmith root | No output; duration displayed9.03min despite later setupComplete children | Displayed duration is not reliable session-end evidence |
| Main Sophia project | Both Traces and Runs checked; latest entries were session-start memory admission/retrieval; no subsequent research execution visible | No evidence of calls relocated here, not proof against untraced work |
| Startup memory event | zero_memory, authorized_count0, provider_hit_count0 | Separate recall issue; no demonstrated link to Builder failure |

## Code corroboration (frontend reviewed head/tree above)
- frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts:7248-7259 counts received tools BEFORE frontend handling, then relays only the returned event.
- Same file:6138-6255, handleGeminiFrontendCoreviewToolEvent executes local CoreView calls and constructs/sends Gemini responses in the browser.
- Same file:6786-6817, buildReviewToolCallSplitResult removes handled/suppressed calls from backend relay; returns null if no fields remain.
- Same file:6610-6749 includes review routing/suppression for generic Builder controls; a missing backend start_builder_task span does not prove it was never attempted in-browser.
- voice/realtime/gemini_langsmith_tracing.py:901-970 creates function_call:<tool_name>; :989-1027 creates function_response:<tool_name>. Tool names survive structural mode.
- voice/realtime/gemini_browser_dogfood.py:1410-1475 traces backend-executed responses/rejections. Both voice files were diff-checked unchanged versus served f128af0c.
- Confirmed code coverage gap: browser-local/suppressed calls can increment browser counters and never reach backend LangSmith instrumentation. Structural redaction alone does not explain absent names/spans.
- LangSmith's 14-tool setup list includes start_builder_task, but is labeled server_baseline_before_browser_owned_overrides: not proof of the final browser tool set.
- frontend/src/app/hooks/useStreamVoiceSession.ts:3990-4001 retains the last25 tool ledger entries in runtime telemetry. A surviving browser export is a recovery lead, not evidence obtained.
- frontend/src/app/lib/coreview-builder-actions.ts:875-885 returns ok=true with result/blockedReason=no_active_builder_task for empty status. Successful status lookup is not task-start success.

## Corrected assessment
1. Confirmed: no active Builder task/events/artifact in the inspected parent session. Missing/failed dispatch fits better than display-only streaming failure.
2. Leading, UNPROVEN hypothesis: fresh research went through local artifact-review/status controls or was intercepted before backend dispatch.
3. Backend attempt lost to missing tracing or another thread remains possible; actual call IDs, routing outcomes and task/run IDs are needed.
4. Reconnect behavior deserves separate investigation; no causal link established. Empty memory admission is not an established Builder cause.
- Codex initially overstated the wrong-tool explanation and corrected it. Only the last call name is known; DO NOT invent the other three, infer they were distinct, or assert start_builder_task was never attempted.

## Requested Claude analysis
- Audit fresh research/Markdown creation versus artifact review: final tool declarations, stale review context, start_builder_task suppression, bridge availability, status success versus launch success.
- Explain how Sophia might announce startup without a confirmed task/run ID; propose an acceptance condition tied to actual dispatch.
- Propose minimal sanitized tracing for local AND suppressed calls: call name/ID, route, result/blocked reason, correlation and task/run IDs; no raw text/audio/credentials, no double execution.
- Specify focused regressions: fresh create dispatch; empty status cannot imply launch; local/suppressed calls observable; selected-artifact review preserved.
- First attempt recovery of the existing browser ledger if available through the operator; otherwise specify one approved capture needed to distinguish hypotheses. Do not trigger a new task/run.
- Return evidence-backed causal findings, alternatives, exact proposed patch scope/tests and rollback. Analysis only; await approval before fixes.

## Evidence custody and boundaries
- Existing R-002/R-003/R-004/R-005 reports: codex-034/036/037/038 on this branch. Mem0 visibility findings remain separate.
- Operator-local detailed evidence: outputs/research-task/langsmith-deep-check-20260927.md in the active qualification workspace. Contains private trace references; Claude cannot access that Mac path. This public packet is self-contained for code analysis.
- No raw trace export successfully preserved. Evidence is UI observations plus read-only source inspection; absence claims retain those limits.
- Investigation changed no product code/settings/deployments, Lab state, database or retention. A-014b remains with its existing automation; leave worker/MCP kill=true state alone.
