# Successful voice Builder launch: latency and validation evidence

2026-10-03 UTC. Read-only analysis after Davide's desktop test of R-018. No request was replayed and no fix was applied during this investigation. Message content, owner identifiers, credentials, filenames and signed URLs are excluded.

## Finding

The admission/routing path succeeded for this request: one recorded voice start produced one handoff, one bound child run and one available Markdown artifact. The child returned success. Q1 still passes after 58 subsequent transcript revisions. The earlier child-create 403 is not reproduced here: this child POST /runs returned 200.

The launch was slow: **31.144 seconds from the recorded source timestamp to the first child progress emission**; 30.948 seconds from the source-action HTTP 200 to that emission. This is backend timing, not a measured speech-to-screen interval. The time of the spoken request and the browser's first painted progress panel were not captured.

The full R-018 validation is incomplete: the expected durable build-registry row is absent, and the browser reader flattened the diagnostic objects. A functional success does not establish every runbook acceptance criterion or authorize a merge.

## Identifiers and deployment

| Item | Identifier |
|---|---|
| Web and LangGraph commit | e4d55b3102fd86c15d6fa88c26a6b2cd6f05ddf2 |
| Vercel Production | dpl_GnKJDi1nqMX8L7PFBt9Y4oDvNPPT |
| Render LangGraph | dep-db0mokugekts73acr2k0 |
| Session | fa978e7d-e46f-4000-9e95-9b865a00d2fd |
| Parent thread | 01a103a8-d301-7611-9be2-5e4c46dd8ca8 |
| Parent run | 01a103a9-baa3-7b62-8306-12ed5f16d69d |
| Parent request | 66e6cc6d-cd37-4af3-b1f6-6c260192b06b |
| Handoff event | d1ec03bf-6042-44b8-abfd-47e19b8e6d38 |
| Child thread/task | ce0b5338-e61b-5fab-b42f-40740694f5cf |
| Child run | 01a103aa-0afa-7ae0-88a3-9652492475f8 |
| Child request | a1c825bc-0997-46cb-bdae-34bf01942aaf |
| Canonical build ID, derived by deployed seed | build_d1ec03bf-6042-44b8-abfd-47e19b8e6d38 |
| Artifact | artifact_f3d0f3d9e4440fd9b30cc671 |

PR #165 remains unmerged. The deployment and migration readbacks are in codex-053; their full original record remains in mailbox commit fa882e7acbda140ce0084155d05e7f865ec7b675. No gateway or voice deployment, configuration, Lab, memory or retention change was made for this investigation.

## Launch timeline

All times below are UTC on 2026-10-03; add two hours for Rome. Render's platform timestamps can differ slightly from the embedded application timestamp. Database timestamps retain their precision.

| Event | UTC time | Evidence |
|---|---|---|
| Recorded start source timestamp | 21:26:53.727955 | Source receipt, equal to stored row |
| Source-action response | 21:26:53.924204 | Gateway POST memory-source-actions, HTTP 200 |
| Parent run created | 21:26:57.670249 | Parent worker completion record |
| Parent worker started | 21:26:58.226619 | Parent worker record |
| Voice start routed | 21:27:08.607576 | BuilderCommand, task_type=document |
| Handoff accepted | 21:27:14.952850 | Durable handoff receipt |
| Child binding accepted | 21:27:18.102750 | Durable binding receipt |
| Child POST /runs response | 21:27:18.126492 | LangGraph HTTP 200, tools node |
| Exact child run GET response | 21:27:18.286408 | LangGraph HTTP 200, tools node |
| Child worker started | 21:27:19.933753 | Child worker record |
| Child task type observed | 21:27:24.865901 | BuilderTask: document, personalization disabled |
| First child progress emitted | 21:27:24.871947 | BuilderProgress phase=starting |
| First progress processed by gateway | 21:27:24.946716 | Matching child task, running state |
| Parent run ended successfully | 21:27:35.987034 | Parent worker record |
| Researching phase | 21:27:49.562853 | Child progress |
| Drafting phase | 21:29:38.443410 | Child progress |
| Artifact available in registry | 21:30:09.346469 | Durable artifact registry created_at |
| Done phase emitted | 21:30:09.406525 | Child progress |
| Child run ended successfully | 21:30:10.838966 | Worker completion record |
| Gateway completion processed | 21:30:12.013746 | Matching child success/completed state |
| Session ended | By 21:41:05.757774 | Durable session status=ended |

| Interval | Seconds | Interpretation |
|---|---:|---|
| Recorded source to parent creation | 3.943 | Includes preparation/submission; no complete client span |
| Parent queue wait | 0.556 | Worker-reported queue time |
| Parent worker start to routing | 10.381 | Before direct Builder routing; not child execution |
| Routing to handoff acceptance | 6.345 | Tool/boundary/provenance work before handoff |
| Handoff to child binding | 3.150 | Admission/binding path |
| Binding to first progress | 6.769 | Includes 1.808s child queue wait and 4.938s from worker start to progress |
| Recorded source to first progress | 31.144 | Launch feedback threshold exceeded |
| Child worker execution | 170.905 | Worker-reported execution time |
| Child creation to completion | 172.829 | Worker-reported completion interval |
| Recorded source to child success | 197.111 | Approximately 3m17s total after recording |

The parent completion log separately reports run_exec_ms=37760 and run_completed_in_ms=39126; do not replace these with a speech-to-response measurement.

## Counts and Q1

Read-only SELECTs joined the session to its governance receipts and matched artifact records by parent/child thread. The result was:

- One recorded `[Voice build request]` row; zero recorded `[Voice build correction]` rows.
- Four source-action receipts across the whole session: one for the start and three later non-start/non-correction turns. The session therefore did not remain a single-turn transcript; the later turn contents were neither selected nor reported.
- One handoff; one child binding; initial handoff manifest size zero, as expected for source-only independent dispatch.
- One non-deleted Builder artifact: extension `.md`, artifact_type=markdown, storage_status=available, matching child run/task.
- Public sophia_build_registry: zero matching rows for parent/child ownership or the canonical build ID. Public sophia_build_operation_events: zero rows for the canonical build ID. Queries also checked the child task ID separately. This is a distinct unmet runbook criterion; it does not negate the bound native run or artifact.
- All four Q1 receipts: stored row exists; source version, sequence, exact created_at, acceptance epoch, metadata and thread equal; final=true; exactly one matching message row.
- The start source has sequence 5 and remains equal after 58 transcript revisions. The final session revision is 63.
- Routed task_type=document; child task_type=document. No mismatch.

The gateway processed running and completed progress states. Its operational progress registry must not be conflated with the SQL durable build registry. Deployed code contains an in-memory BuildRegistryRepository and computes a build ID in the independent runtime seed; the examined launch path did not demonstrate durable register_fresh persistence. Claude should reconcile the runbook's expected registry record with the intended production integration before calling the validation fully passed.

## Logs and tracing

The inspected launch interval contains repeated source-action lookup/source snapshot, memory-contract/authority reads, Mem0 ping/search and prompt-admission recording at MemoryContextModelProducer.before_model and model boundaries. Successful inspected HTTP operations returned 200. The visible transition events use revocation_epoch_unchanged and authorized_count=0. These are structural checks, not evidence of an admission refusal.

The matching child POST /runs returned 200, and the child worker succeeded. The previously failing handoff-without-binding condition is not present in this request. No matching memory_admission_denied was surfaced by the focused gateway/LangGraph searches; virtualized/search results are not an exhaustive export of every application log.

At completion, BuilderResearchDiagnostics reported: allow_web_research=True; builder_web_search_count=1; builder_web_fetch_count=2; write_file_count=1; wrote_before_research=False; sources_used_empty=False. This verifies that research preceded the file write; it does not establish factual accuracy, source quality or document design, which were not reviewed in this pass.

Both the Sophia and Sophia-Gemini-Live-Voice EU LangSmith projects showed No runs found in the Last 3 hours Runs view after the session ended. The matching Builder log explicitly says completion annotation was skipped because there was no active run tree; its diagnostic langsmith_tracing_enabled=False, builder_tracing_flag=True, and key/workspace/project-ID presence=True. memory_langsmith_export status=unavailable also appears on the inspected parent/child execution path.

Voice logs independently contain repeated multipart ingest 403/Forbidden through 21:40:59Z, overlapping the test/finalization window. The inspected virtualized selection contained 150 matching log rows, not necessarily 150 distinct ingest requests; no owner, body, key or token is included. Those rows lack enough correlation to attribute every individual rejection solely to this session. Voice trace_started/trace_completed markers would not prove remote ingestion succeeded.

Thus LangSmith cannot supply a model/tool waterfall for this run. Backend worker records, durable receipts and gateway progress provide the timeline above. The Builder's disabled tracing and voice multipart rejection are separate observability failures; neither explains a failed Builder launch in this successful run.

## Browser diagnostics and limits

The console reader retained three `[voice-builder] outcome Object` entries and, after session end, two `[voice-audio] context-state Object` entries. Their object fields were not exposed. The capture timestamps are not original event timestamps and were not used for latency calculations. Telemetry Copy JSON did not yield JSON in the clipboard; Export JSON did not produce a download. No product request was retried. Davide was asked for the expanded content-free console fields.

Therefore tool names, ok/reason/send_error/status/waited_ms, refused-tool rejectionReason, and AudioContext state/at are not established by this capture. No claim is made that a particular bridge call actually returned unconfirmed, or that audio remained running. The saved artifact was visible in the app before finalization, but the exact first progress-paint time is unavailable.

## Ranked latency explanation and proposed follow-ups

1. **Serial pre-launch admission/provenance work: strongest measured contributor.** Parent worker start to direct routing consumes 10.381s, followed by 9.495s from routing to child binding. The fast path in BuilderCommand returns a synthetic start_builder_task tool call without first asking the companion model to decide whether to launch. Repeated network-backed guard checks are visible before routing and across handoff/binding. Their exact individual costs require spans; the intervals are not attributed entirely to a single RPC or Mem0 search.
2. **First progress arrives after the frontend confirmation deadline.** voice-builder-actions.ts uses 25,000ms and 250ms polling, and confirms only when its adapter sees a new running task. Backend progress arrives at about 31s after recording, before any browser delivery/paint delay. A timeout/unconfirmed reply is therefore plausible, although the flattened console objects prevent proving it in this session. A longer timeout alone would not make creation faster.
3. **Child startup adds queue plus initialization.** The child queue is only 1.808s; its worker then spends another 4.938s before starting progress. This makes a large worker backlog or a cold deployment an unsupported primary explanation. The rollout was already live well before this request.
4. **Tracing may add critical-path work, but its contribution is unmeasured.** memory_governance/observability.py directly creates a non-batched client and posts structural spans synchronously. Failed exports exist in logs. Trace failures can lose evidence and potentially add latency; the present capture does not isolate their share of the launch interval.

Proposed code work, not applied:

- Add monotonic, content-free spans for bridge entry, source-save completion, parent submission/start, each admission boundary, handoff/bind/native response, progress publication and browser receipt/paint. Include correlation IDs and safe codes. Serialize console diagnostic objects so the supported reader preserves fields. Reproduce with focused tests or a later authorized supervised pass.
- Show a truthful launching/pending state immediately after accepted submission, and transition it to running only on authoritative bound-run/progress evidence. Keep the duplicate-start and conversation-switch guards. Resolve late confirmation asynchronously without claiming a second run or inviting a duplicate request; separate the voice acknowledgment wait from the actual Builder lifetime.
- Profile guard.check/_check_source/_readmit and register_independent_text before optimizing. Reduce redundant round trips with an atomic source/authority/contract snapshot or shared reads within a single authorized boundary, while retaining every source-validity, owner, signature, child, revocation and replay check. Do not cache authority across boundaries or remove checks to meet a latency target.
- Reconcile and, if intended, implement idempotent durable build/operation registration for the independently seeded build identity. Keep native-run and artifact reconciliation separate from gateway in-memory progress. This is needed for persistence/follow-up guarantees, not to explain the observed child-create timing.
- Repair observability separately: first verify the exact tracing flag resolution and the voice 403 permission/project detail. Then propose a narrowly scoped settings/code change with approval. Do not infer an endpoint/key replacement solely from these symptoms. Move structural export off the user-visible critical path only with bounded ownership/cleanup and explicit gap reporting.

Rollback for any later code experiment: redeploy the currently verified e4d55b31 LangGraph commit or make a fresh web build of e4d55b31, according to the changed component. No such experiment, merge, deploy, settings edit or rollback was performed during this analysis.
