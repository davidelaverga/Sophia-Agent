# R-015 Builder handoff boundary at 2f5c5173

Read-only source review; no production action or autonomous test.

## Meaning of `lifecycle_tool_call`

`backend/packages/harness/deerflow/agents/sophia_agent/middlewares/lifecycle_tool_observer.py:14–17,77–118` logs an AIMessage tool selection in after_model, **before tool execution**. Its task_id is copied from the model's input arguments. A null task_id on start_builder_task is normal: start is intended to allocate a new child.

The log proves the companion selected start_builder_task. It does not by itself prove ToolNode executed the tool, arguments validated, a handoff was registered, or a child was created. A LangSmith tool span or matching ToolMessage is the next evidence boundary. Inspect name/type/tool_call_id/status, omitting content and arguments.

## Companion can succeed while Builder never starts

- The browser Gemini tool and backend companion tool share the name start_builder_task but are different layers. The browser forwards one ordinary companion message and waits for a running Builder UI task.
- `frontend/src/app/lib/voice-builder-actions.ts:39,314–346` waits 25 seconds. The companion can still be running when this deadline expires. A completed tool response with reason builder_start_unconfirmed therefore does not establish backend failure or absence of work.
- `backend/.../middlewares/artifact.py:194–251` ends a companion turn when its final AIMessage contains only emit_artifact. This is a per-turn companion metadata artifact, not a delivered Builder file. Mixed emit_artifact/lifecycle calls continue through the tool loop.
- `backend/.../tools/start_builder_task.py:2489–2500` returns ordinary strings for scope/active-task checks and caught independent-dispatch exceptions. These results need not fail the companion run.
- At 2501–2508, async_tasks is written only after independent dispatch returns a structured outcome. A thrown pre-handoff/registration error leaves no new async_tasks entry.

## Five-second admission freshness check

The elapsed time from the original source-action receipt to model tool selection does **not** measure the handoff admission age.

1. `MemoryRunGuard.check`, memory_context.py:436–438, rechecks sources and records fresh retained admission.
2. Tool wrapper calls guard.check before execution (813); start_builder_task calls it again (2493).
3. `BuilderSourceBindingService.register_independent_text`, builder_source_binding.py:230, calls it again, then verifies the exact source text and witness at 231–233.
4. Line 235 creates an independent **fresh zero-memory admission**. This separate result's prompt_admission_id is used at line 246.
5. Between that admission and registration there is one get_user_governance read (239), local consistency/hash/serialization work (240–248), then register (250 → 269).
6. SQL `backend/migrations/2026_09_14_mem00_c2_model_authority.sql:260–268` checks that exact prompt admission. It rejects missing/wrong provider_status/scope/context/outcome/manifest, age >5 seconds or future time, and changed catalog/revocation clocks under the same error `memory_builder_parent_admission_stale`.
7. The SQL does source assertion at 256–257 before checking age. Network delay, lock wait or slow source assertion in the short interval after step 4 can exhaust the window. A 23-second model generation before the tool cannot alone do so.
8. Child-run binding SQL at 280–317 has no five-second freshness check; it separately verifies historical handoff and current source.

Do not increase the TTL based only on whole-turn duration. Identify the exact registration RPC and status, the specific admission timestamp, and its acceptance/error time first.

## Existing instrumentation and its limits

Search read-only logs in the exact run window for:

- `sophia_memory_register_builder_handoff`
- `sophia_memory_get_builder_handoff`
- `sophia_memory_bind_builder_source_run`
- `sophia_memory_get_builder_source_run_for_handoff`
- POST /threads and child run requests
- `[Builder] ... invoked without tool_call_id`
- `memory_admission_denied` (child create-run boundary)
- `memory.context.entry_denied` (child before_agent boundary)

`register` catches registration exceptions, tries a read-only lookup, and wraps failure as memory_builder_handoff_unavailable (builder_source_binding.py:268–277). `register_independent_text` can retry lookup then wraps as independent_builder_handoff_unavailable (249–261). `_start_independent_builder_task` catches the outer failure and returns fixed unconfirmed text without logging the exception (start_builder_task.py:2497–2500). SQL failures roll back rather than record a denial row. Consequently SQL absence counts cannot reconstruct a swallowed exception's precise cause.

`dispatch_independent_builder` also catches thread allocation and child creation failures and observes by immutable identity; its observe catch returns unconfirmed without the original cause (builder_provenance.py:87–116). Never interpret the fixed unconfirmed result as permission to automatically retry a launch.

## Safe SQL interpretation

Use the separate [read-only SQL patterns](r015-browser-evidence-queries.sql) for exact new-session Q1, source/handoff/binding/registry counts, and safe child/run IDs. It selects no message content, owner IDs, argument payloads, memory text, tokens or secrets. The file also includes optional RPC existence/grants and prompt-admission queries; those additional queries were not executed for the findings in the coordinator's browser report.

| Evidence | Narrow conclusion |
|---|---|
| lifecycle selection only; no tool span/message yet | Model selected tool, execution unproved |
| ToolMessage/status error; no handoff | Tool validation or wrapper/body refused before durable handoff; inspect fixed error classification privately |
| Backend tool executed; no registration request/handoff | Pre-registration check/return/exception |
| Registration request 4xx; no handoff | Database/RPC rejection; inspect safe error code and function metadata, do not retry write |
| Handoff count >0; child binding count 0 | Registration passed, child creation/binding boundary remains |
| Child binding >0; native run unconfirmed | Inspect exact child run and confirmation path |
| Child run running/success; frontend task absent | Investigate projection/stream/UI path |

Any relevant tool output should be reduced locally to equality against fixed code responses, error class, or known status/reason fields. Do not paste the whole ToolMessage, because model output can contain user content.

## New supervised browser attempt: proven failure boundary

Parent investigator supplied the following sanitized production observations. This subagent performed source inspection only and did not independently execute production queries.

- Parent thread `01a0eed8-b725-7743-9d34-e12ed0a84e24`; companion run `01a0eed9-ac7d-7941-a993-61d689e9ff19`.
- The source action was accepted at 2026-09-29 20:27:14Z. Q1 readbacks were all equal: row exists, thread, source version, sequence, created_at and epoch. Later source revisions did not invalidate the anchored source.
- The source receipt count was 1, durable handoff count 1, child binding count 0, build record count 0 and Builder artifact count 0.
- Handoff registration RPC returned 200 at 20:27:42.235984Z; handoff accepted_at was 20:27:42.219472Z. The successful durable handoff excludes the five-second registration TTL as the cause of this attempt.
- Child thread was `dd6f7ab6-5fc4-51b2-992e-820399fd63ea`.
- At 20:27:45.681279Z the LangGraph server logged POST `/threads/dd6f7ab6-5fc4-51b2-992e-820399fd63ea/runs` → 403 in 2 ms. The companion tool's SDK log at 20:27:45.681861Z confirms POST `http://api/threads/dd6f7ab6-5fc4-51b2-992e-820399fd63ea/runs` → HTTP/1.1 403 Forbidden, under the parent run's tools node; request ID `0706c0a3-f60c-401b-8822-633adbc12cda`.
- API log version was 0.8.1. The parent companion later succeeded; that is not a successful Builder run.
- Parent investigator found no `memory_admission_denied` marker in the one-hour log search, rechecked after the 403. Therefore the **observed** denial stage/reason remains unavailable. Do not report a modeled stage as an observed log field.

This establishes that the current browser failure is the child create-run HTTP 403, before child binding and before Builder execution. It is distinct from the earlier mobile attempt, which had no accepted source-action receipt and never reached this boundary.

## Highest-ranked code defect: framework duplicates the handoff into context

Source commit: `2f5c5173b442199d26f528d2ec7793b3967144a0`. The repository's backend/uv.lock pins langgraph-api 0.8.1 (2037–2038), langgraph-runtime-inmem 0.28.0 (2146–2147), and langgraph-sdk 0.3.9 (2164–2165). Local cached wheel METADATA independently reports those versions. Production logs directly confirm API 0.8.1, but this investigation did not independently inventory every installed production wheel or prove its source bytes equal the local cache.

Exact forward path in those sources:

1. Sophia `backend/packages/harness/deerflow/sophia/memory_governance/builder_provenance.py:111–113` calls runs.create with `sophia_builder_handoff_v1` in config.configurable, and supplies no context or metadata.
2. langgraph-sdk 0.3.9 `langgraph_sdk/_async/runs.py:470–494` forwards config and drops context/metadata when None. It does not add owner metadata or rewrite the handoff.
3. langgraph-api 0.8.1 `langgraph_api/models/run.py:225–240` reads config and context, takes configurable from config, and when context is empty executes **context = configurable.copy()**. Thus the valid configurable handoff is now also present in context.
4. That same file's 284–320 sends both config and the copied context through encryption handling to Runs.put. No carrier-specific stripping occurs on this path.
5. langgraph-runtime-inmem 0.28.0 `langgraph_runtime_inmem/ops.py:2409–2424` constructs RunsCreate with those kwargs and invokes its create_run auth handler before owner filtering or inserting a run.
6. Sophia `backend/packages/harness/deerflow/sophia/langgraph_auth.py:507–511` reads the configurable handoff, then rejects any nonnull context handoff with `_deny_run("handoff_in_context")`.
7. This precedes `bind_builder_run` at 550–552, so the result predicted by the source is HTTP 403 with zero child bindings, matching the observed boundary and fast refusal.

Confidence: **high for the deterministic source incompatibility**; **strongest current causal candidate for this production 403**, but not a directly observed denial stage. The missing denial marker is a real evidence gap. No live payload or exception body was printed, and no SDK create/replay or local execution test was performed.

The current code's framework mirroring is bidirectional: context-only input is copied into configurable at models/run.py:235–238. Consequently equality of the two copies alone cannot demonstrate which raw surface originally supplied the handoff.

## Why a missing run_id or external service key is lower-ranked

- API models/run.py:393–412 generates run_id via uuid7 when omitted. Runtime RunsCreate includes it at ops.py:2412. Missing caller-supplied run_id therefore does not explain either the 403 or the missing marker.
- Sophia `_deny_run` at langgraph_auth.py:78–82 individually catches absent/invalid context/run IDs, then still logs at 83. Its outer catch can suppress logging failures; owner keyed-reference generation can also fail. No specific logging failure was established here. Prior successful HMAC-backed handoff work makes a persistently missing reference secret unlikely, without proving logger behavior.
- Sophia get_client(url=None), langgraph_client_auth.py:68–79, retains the in-process path and does not install OwnerScopedAuth. SDK _async/client.py:113–125 uses root_path `/noauth`; API auth/middleware.py:44–53 bypasses external reauthentication for that internal transport; API route.py:166–171 retains the parent AuthContext.
- If an earlier uninstrumented owner/metadata authorization check rejects, the response can also be 403 without the memory marker: Sophia langgraph_auth.py:140–151,454,468 and _owner:109–126. The fresh child allocation and valid parent run narrow this possibility but do not independently prove every request context field.
- A database source mismatch is lower-ranked for this attempt because Q1 and source/handoff receipt checks passed and the observed refusal occurred at child create-run before a child binding. Do not weaken source guards or change settings to address this evidence.

## Proposed fix boundaries and verification for Claude — not applied

Use one canonical, fully validated handoff authority at the auth boundary and explicitly handle the framework-produced duplicate. Preserve all existing owner, assistant, child thread, payload, receipt, seal, source-consent/version/epoch, empty-memory-manifest, and single-run binding checks. Reject conflicting, malformed or unproven carriers. Do not simply delete the context guard or accept any matching dictionary as authority.

Because API normalization erases whether the raw caller used config or context, preserving an explicit-context-injection prohibition requires validation before that normalization, or a server-only dispatch witness with a precisely scoped lifetime. If the design intentionally treats both normalized carrier shapes equivalently, acceptance must still require the same cryptographically and durably verified handoff, and this semantic change must be reviewed explicitly. Do not guess the origin from dictionary equality.

Required future local tests should use the installed create_valid_run → Runs.put → actual Sophia create_run path with real API normalization, then prove:

- Legitimate governed Builder dispatch reaches bind_builder_run and records exactly one binding under synthetic fixtures.
- An ordinary configured handoff that the framework mirrors is accepted only after complete validation; conflicting copies, malformed/altered/expired source authority, wrong owner/child/assistant/payload, and replay are refused.
- Explicit raw context-only carrier attempts preserve the chosen security contract; field equality alone cannot be used to satisfy this test.
- Denial emits a safe stage/reason even if keyed-reference logging fails, without logging content, identities, payloads or secrets.
- Child create-run failure remains unconfirmed rather than falsely reporting a running build; errors retain safe status/stage diagnostics.

Current coverage misses this integration: `backend/tests/test_mem00_langgraph_framework_auth.py:141–241` exercises installed loopback create-run for the companion only; `backend/tests/test_mem00_c2_builder_source.py:320–395` stubs the SDK client and directly invokes bind_builder_run, bypassing API normalization and the create_run guard. Existing green tests therefore do not establish this Builder boundary works.

Keep the correction and its focused tests in one reviewed code commit. The rollback is reverting that single commit and redeploying the prior verified LangGraph code artifact; leave the R-015 source-anchor migration, frontend, gateway, environment, data, Lab and retention untouched. Any deployment/validation requires its own explicit approval. No fix or production action was applied during this review.
