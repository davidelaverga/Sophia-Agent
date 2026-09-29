# R-015 supervised browser follow-up — Builder child run refused

2026-09-29. Read-only investigation of Davide's new test in the built-in browser, following codex-049's earlier mobile investigation. No fix, merge, deployment, environment edit, Lab action, memory action, retention action, or agent-initiated validation request was performed. Davide started and ended the conversation himself.

## Finding and evidence boundary

**The Builder child create-run request failed with HTTP 403 Forbidden.** Source intake succeeded, the companion selected `start_builder_task`, and a durable Builder handoff was registered. The child has no run binding, build registry record, or delivered Builder artifact. The parent companion subsequently succeeded; that is not Builder success.

The strongest code explanation is a carrier incompatibility with LangGraph API 0.8.1: the framework copies `config.configurable` into `context`, including the valid Builder handoff, then Sophia's auth hook rejects a handoff in context before binding the child. The exact live denial stage was not logged in the searches inspected, so **`handoff_in_context` is a code-backed causal inference, not an observed production denial field**.

The earlier correlated mobile session had no completed source-intake evidence. This browser attempt reached a later, independently evidenced boundary. Its results must not be used to invent missing mobile tool history.

## Identity and served source

| Item | Readback |
|---|---|
| Session | `ac600ec5-d485-4804-ac49-399688558089` |
| Parent thread | `01a0eed8-b725-7743-9d34-e12ed0a84e24` |
| Companion run | `01a0eed9-ac7d-7941-a993-61d689e9ff19` |
| Builder child thread | `dd6f7ab6-5fc4-51b2-992e-820399fd63ea` |
| Child request correlation | `0706c0a3-f60c-401b-8822-633adbc12cda` in the parent tools-node log context |
| Voice provider session | `gemini-prod-86ac7f723f654256b6f085117deb3bae` |
| Local voice trace ID | `01a0eed8-c899-7e4c-8a5e-fc02eb97da44` |
| Web | `/api/app-version` 200; `2f5c5173b442199d26f528d2ec7793b3967144a0`, `dpl_2vzq5ica6DEii89fcS5P9TPqnydp` |
| LangGraph | `/version` 200; `2f5c5173b442199d26f528d2ec7793b3967144a0`; log API version `0.8.1` |
| Voice | `/version` 200; `6f6545d6c4050526e95905a52821ba69e7e926be` |

Version endpoints identify the currently served deployments. The browser's own loaded build ID was not recovered from its telemetry JSON; source citations use the approved server source, with that client-bundle qualification.

## Timeline

All dates below are September 29, 2026. Rome time is UTC+2. Davide's “started” reply was received at approximately 22:26:36 Rome; the app had already mounted and preconnected shortly earlier. He reported finishing the spoken test around 22:28 and ended the still-open app session later.

| UTC | Rome | Evidence |
|---|---|---|
| 20:26:15.950 | 22:26:15.950 | Browser Builder canvas hook mounted |
| 20:26:17 | 22:26:17 | Gateway source-profile GET 200 for the session and thread |
| 20:26:19 | 22:26:19 | `voice.connect`: Gemini Live, preconnect=true, voice, gaming; provider session matches visible telemetry |
| 20:26:33.709 | 22:26:33.709 | Browser Builder canvas `sse-open` console marker |
| 20:27:14 | 22:27:14 | Gateway source-actions POST 200 |
| 20:27:37.586776 | 22:27:37.586776 | Companion `lifecycle_tool_call`, `start_builder_task`, parent run/thread; task_id=None is normal for a start request |
| 20:27:42.219472 | 22:27:42.219472 | Durable Builder handoff accepted_at |
| 20:27:42.235984 | 22:27:42.235984 | `sophia_memory_register_builder_handoff` RPC 200 |
| **20:27:45.681279** | **22:27:45.681279** | **LangGraph POST `/threads/dd6f7ab6-5fc4-51b2-992e-820399fd63ea/runs` → 403, 2 ms** |
| 20:27:45.681861 | 22:27:45.681861 | Parent tools node confirms SDK POST `http://api/threads/dd6f7ab6-5fc4-51b2-992e-820399fd63ea/runs` → `HTTP/1.1 403 Forbidden` |
| 20:27:59–20:28:02 | 22:27:59–22:28:02 | Parent source lookup/snapshot and prompt-admission RPCs 200; retained-context transitions continue, authorized_count=0 |
| 20:28:03.096106 | 22:28:03.096106 | Parent `Background run succeeded` |
| 20:42:20 | 22:42:20 | Voice local `trace_completed`, event_count=65, tool_count=0, audio_attached=false |
| 20:42:27 | 22:42:27 | Gateway session recap GET 200 |

`lifecycle_tool_call` records model selection before tool execution. Here, the independent durable handoff and child HTTP request also prove that dispatch executed. The absence of a child binding localizes the failure before Builder execution. The recap and local trace completion support session finalization; trace completion does not establish upload success.

## Content-free database checks

SELECT-only checks on this exact session/thread returned:

| Evidence | Result |
|---|---:|
| Accepted source-action receipts | 1 |
| Builder handoff receipts | 1 |
| Builder child-run bindings | 0 |
| Build registry records | 0 |
| Builder artifact registry records | 0 |

Q1 source parity was checked during the investigation and again after the session ended:

| Q1 assertion | Result |
|---|---|
| Source row exists | true |
| Source version equal | true |
| Sequence equal | true |
| Created-at equal | true |
| Acceptance epoch equal | true |
| Thread equal | true |
| Transcript revisions after receipt | 5 initially, **6 at final readback** |

This exercises the recorded-source protection that the mobile attempt did not reach: later transcript flushes preserved this receipt's version, sequence, time and epoch. These booleans do not by themselves prove every possible cryptographic/source-admission condition, but the accepted handoff independently demonstrates that its registration checks passed.

The successful handoff excludes the five-second *registration* freshness check as this attempt's failure. Extending that TTL would not address the evidenced child-run 403. Registry counts are not native LangGraph `async_tasks` counts; checkpoint payloads and ToolMessage content were not read.

`memory_admission_denied` returned no matching logs in the last-hour Render view, rechecked after the child refusal. Reported fields are therefore `stage=not observed`, `denial_reason=not observed`, `error_type=not observed`. The child response body was not recovered. It would be incorrect to label `handoff_in_context` as a captured live reason.

## Code explanation and coverage gap

The [detailed handoff audit](r015-builder-handoff-boundary-2f5c5173.md) maps the exact forward path:

1. `builder_provenance.py:111–113` sends the sealed handoff under `config.configurable.sophia_builder_handoff_v1`, with no context.
2. Pinned SDK 0.3.9 forwards config and omits null context/metadata.
3. API 0.8.1 `models/run.py:225–240` populates empty context with `configurable.copy()`.
4. The API forwards both copies through `Runs.put`; runtime-inmem invokes the auth handler with both.
5. `langgraph_auth.py:507–511` rejects the handoff's presence in context before `bind_builder_run` at 550–552.

This predicts a fast child create-run 403 and zero bindings, matching production. Production directly reports API 0.8.1. SDK/runtime versions and source behavior were inspected in pinned/local wheels; their production bytes were not independently inventoried. Earlier plain owner/metadata refusal remains an alternative until the live stage/body is recovered.

Normalization also works in the opposite direction: raw context-only data can be copied into configurable. Equality of the two normalized dictionaries cannot prove which raw surface supplied authority. Claude should preserve sealed handoff, owner, child, source, payload, epoch and single-binding checks while correcting the API contract. Blindly removing the context guard or accepting matching dictionaries would change the intended admission policy.

Existing framework auth tests cover companion create-run. Builder tests stub `runs.create` and directly invoke binding, skipping this normalization path. The required regression is the real API-shaped Builder auth path, including allowed dispatch and rejected context-only/conflicting/replayed authority. No local execution test or production replay was run in this investigation.

## Browser and voice observations

- During the spoken test, telemetry showed microphone signal, Gemini setup complete, relay active and public SSE connected. Initially Session Ready was 1.58 seconds. The later missing readiness timing is a missing measurement, not proof of failed setup; capture handling may explain it, but the cause was not observed.
- Tool loop reached 3 calls, 2 responses, 0 rejections and 0 unresolved; the last tool was `start_builder_task` with phase `tool_response_sent`. Tool-response completion does not mean a build started.
- Builder workflow stayed inactive; captured Builder events and public artifacts stayed 0. Repeated Builder canvas snapshot markers reported the empty passive state. Console warnings exposed only collapsed objects, so their hidden fields were not reconstructed.
- Browser confirmation waits 25 seconds (`voice-builder-actions.ts:39,314–346`). Source acceptance to parent completion was about 49 seconds. This permits an early unconfirmed response while the parent continues, but the 403 and missing binding independently explain absent Builder work. The exact local result.reason/send_error and Sophia's spoken response were not recovered.
- The app session remained open after Davide finished speaking. A later observation, well after the original child refusal, showed three public SSE errors, reconnect/setup events and WebSocket close 1008, reason `The operation was aborted.` The late transport evidence is a separate reliability/telemetry issue; it must not be attributed as the cause of the earlier 20:27:45 child 403.
- Browser telemetry Export JSON timed out in the available download API; clipboard extraction returned empty. No raw JSON bundle was published. Existing rendered metrics and durable backend evidence were used instead.
- Local microphone observation was explicitly requested. A native on-device English observer was compiled, but macOS TCC aborted it at Speech authorization before capture began because the usage description was not accepted in this execution context. **No microphone recording or transcription was captured; Codex did not hear the conversation.** No audio was uploaded or published. Microphone signal observations above come from Sophia's telemetry.

## LangSmith and remaining observability limits

EU projects `Sophia-Gemini-Live-Voice` and `Sophia` were inspected and refreshed using the signed-in browser. With Last 3 days selected, no September 29 incident trace was visible; their newest visible entries remained September 27 01:14:54 Rome / September 26 23:14:54 UTC.

Voice logs show at least 50 visible multipart-ingest 403 rows in the inspected filtered list, spanning 20:26:35–20:35:57 UTC. Endpoint: `https://eu.api.smith.langchain.com/runs/multipart`; detail `{"error":"Forbidden"}`. This is a virtualized-list lower bound, not a whole-session total. LangGraph separately logged `memory_langsmith_export status=unavailable` during the parent run.

The voice trace's local tool_count=0 is compatible with the browser's 3 tool calls: ordinary Builder calls are intercepted locally and removed before provider-event relay. Repairing upload permissions alone would not create those missing browser-local spans. The generic Forbidden response does not select an exact credential/project/workspace correction.

## Ranked cause and planning guidance — no fix applied

1. **Confirmed functional failure:** child create-run HTTP 403 after accepted source and handoff, before binding or execution.
2. **Strongest code explanation:** API 0.8.1 mirrors the handoff into context and Sophia rejects it. Treat the exact live stage as unconfirmed; preserve the evidence gap.
3. **Alternative:** an earlier uninstrumented owner/metadata check in child authorization. In-process SDK transport retains parent AuthContext, lowering an external API-key/endpoint explanation. No configuration change is supported by this evidence.
4. **Confirmed observation failures:** LangSmith ingest 403, missing denial marker, and unavailable browser JSON export. These obscure safe failure details.
5. **Additional symptom:** the 25-second confirmation window can expire before companion completion. Changing the window would not make the refused child run succeed. Late idle-session transport errors require their own timing/cause analysis.

Claude's correction should reconcile canonical handoff authority at a trusted request boundary or use a server-only dispatch witness while preserving all provenance gates. Explicit context-only injection must remain governed according to the reviewed security contract; matching normalized copies alone are insufficient evidence of origin. Include tests through actual API normalization and safe failure instrumentation. Rollback: revert the isolated reviewed correction and redeploy the prior LangGraph artifact; the R-015 source-anchor migration need not be reverted on this evidence.

Local synthetic reproduction of the exact API normalization and auth contract can proceed without another production/user test. Existing retained request/ToolMessage metadata, if available, can be reduced to safe status/stage fields. Prospective instrumentation requires a reviewed code change and authorized release; it cannot recover the missing historical denial marker. No blind child-run retry, data repair, timeout increase, settings edit or further deployment was performed here.

Supporting source notes: [handoff audit](r015-builder-handoff-boundary-2f5c5173.md), [read-only SQL patterns](r015-browser-evidence-queries.sql), and the earlier [frontend audit](r015-mobile-frontend-audit-2f5c5173.md).
