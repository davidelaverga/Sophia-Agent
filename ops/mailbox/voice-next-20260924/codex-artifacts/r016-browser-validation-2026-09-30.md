# R016 supervised browser validation — no Builder handoff

Written September 30, 2026, Europe/Rome. Read-only investigation after Davide reported the fresh test still failed. Times ending Z are September 29 UTC; the test occurred September 30, approximately 00:06–00:08 Rome. No production/configuration/code/data/memory/Lab/retention changes, retry, correction or typed control were performed during this investigation.

## Finding

This attempt did not reach the child-run admission boundary that previously returned HTTP 403. The new source was accepted and remains valid; the companion completed, but no Builder handoff was registered. There is no child binding, build registry record, or delivered Builder artifact. The deployed carrier fix therefore was not exercised by this attempt. This does not establish whether that fix would succeed in a hosted Builder run.

The observed deterministic routing decision was `skipped (no explicit document command)`. The companion later captured a normal artifact and finished. The strongest code-backed candidate is a mismatch between the frontend Voice-build envelope and the backend command parser, followed by model selection that did not result in a handoff. The actual brief, tool arguments, messages and model reasoning were deliberately not read; a model refusal or pre-registration tool failure cannot be excluded from these observations.

## Identity and served source

| Evidence | Readback |
|---|---|
| Session | `3c948919-e1ff-4e5d-9d1c-0c582f0ef389` |
| Parent thread | `01a0ef34-6202-73a0-8c7f-cff4a96fdeb5` |
| Companion run | `01a0ef34-c3e0-7f30-805d-1f96481f1c40` |
| Parent request correlation | `d62ebb68-ce7e-4ae0-beb2-9042dd645d10` |
| Voice provider session | `gemini-prod-61f6117d19094b40a32dbc070979b3c4` |
| LangGraph `/version` | 200, `dbfaf818dcb26e14a06ad3b6191b694675d0cf1e` |
| Web `/api/app-version` | 200, build `2f5c5173b442199d26f528d2ec7793b3967144a0`, deployment `dpl_2vzq5ica6DEii89fcS5P9TPqnydp` |
| Final persisted session | resumable, message_revision=12; updated 22:18:31.294418Z |

The database lookup found exactly one newly created session in the bounded 21:55–22:08:35Z window, and its thread matches the live companion log context. The browser telemetry supplies the provider-session ID above. Public endpoints identify the served builds; the browser's loaded JavaScript build ID was not exported.

## Timeline and durable checks

| UTC | Evidence |
|---|---|
| 22:06:22.653 | Session created |
| 22:06:24–25 | Gateway source-profile/messages GETs 200 |
| 22:06:44 | Gateway source-actions POST 200; receipt created 22:06:44.419217Z, sequence=1 |
| 22:07:03.011619 | BuilderCommand: `skipped (no explicit document command)` in companion model node |
| 22:07:20.861791 | BuilderCommand: `skipped (latest message is not user input)` |
| 22:07:30.058790 | ArtifactMiddleware: ordinary `artifact captured`, without Builder-handoff classification |
| 22:07:30.311957–517227 | Delegation ledger storage GET400 followed by POST200; later than the routing skip, so it does not establish the launch cause |
| 22:07:31.674011 | Companion `Background run succeeded` |
| 22:08:37 | Gateway final visible messages POST200 |

| Current test evidence | Count/result |
|---|---|
| Accepted source receipts | 1 |
| Builder handoff receipts | 0 |
| Builder child-run bindings | 0 |
| Build registry records | 0 |
| Builder artifact registry records | 0 |
| All artifact registry records for thread/parent | 0 |
| Q1 row exists / version / sequence / created-at / epoch / thread / metadata | all true |
| Q1 rows with the recorded message ID / final / source | 1 / true / text |
| Transcript revisions after intake | 11 |

Q1 uses the same content-free comparison as the previous supervised pass, restricted to this new session/thread. Registry counts are not native async-task counts. No checkpoint/message payload or artifact title/body was retrieved. The public companion artifact count of one describes emitted state; it is not a durable research report or Builder deliverable.

## Browser, logs and traces

- Davide confirmed that no progress or result appeared in the UI. Existing telemetry: Builder phase inactive, no progress/steps/update; public companion artifacts=1; tool calls=4, responses=3, rejections=1, unresolved=0. Last named tool was retrieve_memories, phase tool_response_sent. Those totals do not identify the rejected call.
- Relay failures=0 at readback; public SSE connected. Last WebSocket close=1008, safe reason `The operation was aborted.` Its timestamp was not recovered, so it is not assigned as the cause of the earlier launch failure.
- The rendered telemetry was read without utterances, previews, arguments or raw backend responses. Copy/export JSON did not yield the telemetry document through the available browser interfaces. No spoken-response transcript was captured by Codex.
- Render Last-hour searches for memory_admission_denied, memory.admission.denied and memory.context.entry_denied returned no matching logs. Report stage, denial_reason, error_type and denied_at_line as **not observed**, not passing values. No rejection-stage claim is made without a captured marker.
- A global search for start_builder_task returned no matches; the small Builder-related result set contained the routing markers and ledger storage operations above. These are log observations, not proof of the model's hidden decision.
- EU LangSmith projects Sophia-Gemini-Live-Voice and Sophia were inspected with Last 3 days. Latest visible entries were still September 27, 01:14:54 Rome; there is no populated trace for this attempt in the inspected view.
- Voice logs expose at least 50 visible multipart-ingest Forbidden rows in the filtered Last-hour list, including 22:07:37–42Z. HTTP403 remains an independent observability failure; the generic response does not select a safe exact config correction. LangGraph also logged memory export status=unavailable during this companion run.
- No current local voice trace_completed line was found in its Last-hour query. Final trace flush is not independently confirmed; the session persisted as resumable.

## Code-backed candidate and next fix for Claude — not applied

1. `frontend/src/app/lib/voice-builder-actions.ts:273–281` constructs a Voice-build envelope with a start_builder_task directive and prefixed Brief. `sendAndConfirm` at 314–346 waits for a genuinely new running task; an ordinary companion artifact cannot satisfy it. Missing confirmation should remain truthful.
2. `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_command.py:35–43,98–108,150–165` requires a direct document verb at its supported punctuation boundary, then a document noun and about/on topic. It has no explicit Voice-build envelope route. A prefixed brief or a research-first brief can miss the grammar.
3. Local pure-parser checks on exact deployed dbfaf818: a plain direct document command routed; a frontend-shaped synthetic research envelope and a frontend-shaped synthetic direct-document envelope did not. Only synthetic text was used, no production call or database write. These demonstrate a contract gap, not the exact undisclosed production brief.
4. `artifact.py:198–259` captures emit_artifact separately from Builder execution. Its ordinary artifact marker is consistent with the observed public artifact and absent handoff. `agent.py:78–91` instructs the model to call start_builder_task for the first build, but that prompt is not a deterministic dispatch guarantee.

Proposed isolated backend follow-up: recognize the existing explicit Voice-build envelope at the companion routing boundary, retain its complete description/task type, and dispatch through the existing start_builder_task tool. Validate structure and the current authorized source/turn; never treat a marker or carrier location as authority. Keep handoff signature, owner, child, source validity, payload and replay/binding gates unchanged. Preserve crisis behavior and prevent duplicate dispatch or unsupported correction routing. Add synthetic envelope integration cases proving one launch/binding for valid current sources, rejection/no launch for invalid sources, and truthful unconfirmed responses. Do not broaden the legacy grammar alone or weaken admission.

Before applying that proposal, recover only allowlisted call name/phase/result reason/send_error and companion routing/tool names if retained. This separates skipped model selection from a failed pre-handoff tool execution. No message, owner ID, brief or raw response is needed. Existing observability cannot prove which browser call was rejected.

Rollback for a separately approved isolated routing fix: revert only that follow-up and redeploy LangGraph at dbfaf818. Keep the carrier fix, recorded-source migration and current frontend. Do not change LangSmith settings to try to repair Builder behavior. A hosted completed artifact still requires a later supervised test; no second test was initiated here.

**Verdict: SOURCE_ANCHOR_VERIFIED; BUILDER_NOT_LAUNCHED_BEFORE_HANDOFF; EXACT_PRE_HANDOFF_TOOL_FAILURE_UNOBSERVED.**
