# Sophia Builder Post-D2.1.1 Presentation Failure Forensics - 2026-07-11

## Executive Summary

Both production presentation tasks failed because the model-facing `prepare_deck_build` tool could not receive its LangGraph runtime argument. The failure happened before `DeckBuildService` began, so neither attempt reached creative-plan validation, HTML validation, image generation, native compilation, mechanical inspection, preview rendering, or artifact upload.

The deterministic defect is in the decorated tool definition:

1. `prepare_deck_build.py` enables postponed annotations with `from __future__ import annotations`.
2. Its `runtime: ToolRuntime` annotation is therefore stored as the string `'ToolRuntime'`.
3. LangChain's `StructuredTool` identifies runtime parameters by inspecting the concrete annotation class.
4. The production tool consequently has `prepare_deck_build._injected_args_keys == frozenset()`.
5. LangGraph invokes the function with only model-supplied schema arguments, producing `TypeError: prepare_deck_build() missing 1 required positional argument: 'runtime'`.

The branch already contains a regression test and explanatory comment for this exact failure mode in another runtime-wrapped tool, but the production deck tool was not covered by that invariant. Its existing test proves only that `runtime` is absent from the model-facing JSON schema, which is necessary but not sufficient.

The two tasks then diverged:

- Attempt 1 made one real prepare execution, emitted a repair call, and crossed the strict eight-minute deadline before that repair could execute. It terminated as `timed_out / wall_clock_limit`.
- Attempt 2 made two real prepare executions, both failed with the same TypeError, then emitted a third call. The bounded retry guard stopped it as `failed / deck_prepare_retry_exhausted`.

The current live deployment is now commit `bd19c92483c7361be21aa54bcaf74a54cd4a6a99`, but the failing tool file is unchanged between the incident commit and current HEAD. A redeploy of the current code alone will not fix presentation generation.

## Scope And Evidence

Evidence was collected read-only from:

- Render deploy records for `sophia-langgraph` and `sophia-gateway`.
- Render production logs around both task windows.
- Full LangSmith EU trace hierarchies for both builder run IDs.
- Gateway terminal events for both task IDs.
- The deployed source at incident commit `c245d90847fbb0d225605feb6ed8c0c6d9ab958e`.
- The current branch HEAD at `bd19c92483c7361be21aa54bcaf74a54cd4a6a99`.
- Local introspection of the production `StructuredTool` using the repository's `uv` environment.

All timestamps are UTC. This report excludes raw prompts, memory payloads, provider payloads, API keys, and credential-bearing URLs.

## Deployment State

Both observed builder runs executed on commit `c245d90847fbb0d225605feb6ed8c0c6d9ab958e`:

| Service | Deploy | Live at | Commit |
| --- | --- | ---: | --- |
| `sophia-gateway` | `dep-d98ouhbtqb8s739gal2g` | 2026-07-11 00:35:25 | `c245d908` |
| `sophia-langgraph` | `dep-d98ouffaqgkc73ec3hdg` | 2026-07-11 00:37:32 | `c245d908` |

A later manual deployment became live after both failures:

| Service | Deploy | Live at | Commit |
| --- | --- | ---: | --- |
| `sophia-gateway` | `dep-d98qsebeo5us73fjhd8g` | 2026-07-11 02:47:17 | `bd19c924` |
| `sophia-langgraph` | `dep-d98qsc1o3t8c73ebhc70` | 2026-07-11 02:49:32 | `bd19c924` |

`git diff c245d908..bd19c924 -- backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py` is empty. The same empty runtime-injection set reproduces at current HEAD, so the later deployment still contains the blocker.

## Attempt Summary

| Attempt | Task ID | Builder run / trace | Window | First prepare | Actual prepare executions | Terminal outcome |
| --- | --- | --- | --- | ---: | ---: | --- |
| 1 | `019f4ed5-a9b6-7071-8c8d-677ffcb09610` | `019f4ed5-a9bc-7a32-8f85-164814bc60ea` | 01:40:54-01:49:20, 506s | Turn 6, 405s | 1 | `timed_out`, `wall_clock_limit`, `deck_deadline_exceeded` |
| 2 | `019f4ef4-e1d1-7d90-b96b-41286b225dad` | `019f4ef4-e1d3-76d0-a46f-c63fd272d762` | 02:15:00-02:21:56, 416s | Turn 4, 224s | 2 | `failed`, `deck_prepare_retry_exhausted` |

LangSmith traces:

- [Attempt 1](https://eu.smith.langchain.com/o/26b7385f-8e69-4a13-b4da-49873ae46191/projects/p/7dd40980-665a-4f4a-95c3-582e6270b707/r/019f4ed5-a9bc-7a32-8f85-164814bc60ea?trace_id=019f4ed5-a9bc-7a32-8f85-164814bc60ea)
- [Attempt 2](https://eu.smith.langchain.com/o/26b7385f-8e69-4a13-b4da-49873ae46191/projects/p/7dd40980-665a-4f4a-95c3-582e6270b707/r/019f4ef4-e1d3-76d0-a46f-c63fd272d762?trace_id=019f4ef4-e1d3-76d0-a46f-c63fd272d762)

## What Went Wrong

### 1. ToolRuntime Was Not Registered For Injection

The production definition combines a concrete runtime dependency with a model-only Pydantic schema:

```python
from __future__ import annotations

@tool(
    "prepare_deck_build",
    args_schema=PrepareDeckBuildInput,
    ...
)
def prepare_deck_build(
    runtime: ToolRuntime,
    deck_title: str,
    ...
) -> str:
```

Code references:

- `backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py:3` postpones all annotations.
- `prepare_deck_build.py:21-36` declares the custom schema and runtime parameter.
- `backend/packages/harness/deerflow/sophia/deck_build/tool_contract.py:175-183` correctly excludes runtime from the model-facing input model.

Local production-shaped introspection returned:

```text
prepare_deck_build._injected_args_keys == frozenset()
inspect.signature(prepare_deck_build.func).parameters["runtime"].annotation == "ToolRuntime"
"runtime" not in prepare_deck_build.args
```

The last condition is correct for the model schema. The first two are the defect: runtime must be absent from model arguments while still present in `_injected_args_keys` as an execution-context argument.

Both traces show the same stack:

```text
langchain_core.tools.structured.StructuredTool._run
  return self.func(*args, **kwargs)
TypeError: prepare_deck_build() missing 1 required positional argument: 'runtime'
```

There are zero `deck.*` service spans in either trace. That proves the exception occurred before `DeckBuildService.prepare_and_build()` at `prepare_deck_build.py:76`.

### 2. The Existing Tests Missed The Production Dispatch Contract

`backend/tests/test_deck_build_service.py:1032-1045` asserts that `runtime` is excluded from the model-facing schema, but it does not assert that LangGraph recognizes it as injected.

The graph-level retry tests in `backend/tests/test_deck_prepare_runtime.py:92-124` use a fake `prepare_deck_build` function with no runtime parameter. They validate the retry state machine, but bypass the production tool's dispatch signature.

The repository already documents the exact invariant in `backend/tests/test_update_async_task_wrapper.py:1307-1355`: postponed string annotations prevent `StructuredTool._injected_args_keys` from recognizing `ToolRuntime`. That guard was not generalized to all runtime-dependent tools.

### 3. Infrastructure Errors Were Misclassified As Repairable Schema Errors

`ToolErrorHandlingMiddleware` catches the TypeError and returns a plain error `ToolMessage` (`backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py:22-35,53-65`).

`BuilderArtifactMiddleware._deck_builder_result_payload()` then attempts `json.loads()` and returns `None` for that plain error message (`builder_artifact.py:11237-11243`). The prepare handler treats any unparseable result as `deck_prepare_argument_invalid` and schedules one model repair (`builder_artifact.py:11547-11581`).

That policy is appropriate for a typed input validation result, but not for a Python invocation exception. The model cannot repair missing runtime injection by rewriting `creative_plan` or slide HTML.

Consequences:

- Attempt 1 spent another 101 seconds generating a second prepare call, then timed out before execution.
- Attempt 2 spent 102 seconds on the first repair and 89 seconds on another prepare call before the retry guard terminated it.
- Completion metadata reported emitted-call counts rather than actual service execution counts. Attempt 2 reported `prepare_call_count=3`, while LangSmith contains only two actual tool spans. `prepare_result_count` and `prepare_service_result_count` were null in the terminal artifact.

### 4. The 120-Second Prepare Latch Cannot Preempt A Long Model Call

The elapsed-time latch is checked at middleware/model boundaries (`builder_artifact.py:7089-7108`). The wall-clock terminal gate is also evaluated before or after model calls (`builder_budget.py:521-532,581-595`). Neither can interrupt an in-flight provider request.

Observed long model calls:

- Attempt 1: 84s, 174s, 121s, then 101s for repair. The first real prepare arrived 405 seconds after kickoff.
- Attempt 2: 213s to produce the first complete prepare payload, then 102s and 89s on repair calls. The first real prepare arrived after 224 seconds.

These calls produced 6.9k-22.7k completion tokens each. The current contract requires six complete inline HTML documents plus a deeply typed creative plan in one tool call, so the large output is expected. It makes `prepare_force_after_seconds=120` aspirational rather than enforceable: the model can enter a large authoring call before the threshold and return well after it.

This timing issue did not cause the TypeError, but it made Attempt 1 terminate on the deadline instead of exposing a clean execution failure and left too little time for image generation and native compilation even if injection had worked.

### 5. Trace Root Status Still Looks Successful

Both LangSmith roots are marked `success` because the graph terminated cleanly. The authoritative child completion metadata and feedback are correct:

- Attempt 1: `terminal_status=timed_out`, `terminal_reason=wall_clock_limit`, feedback score 0.
- Attempt 2: `terminal_status=failed`, `terminal_reason=deck_prepare_retry_exhausted`, feedback score 0.

Gateway outcomes are also correct (`timeout` and `error`). However, a default LangSmith view that only checks root status will miss both product failures. The root metadata contains the deployed SHA and static task context, but not the final terminal status.

## Root Cause Assessment

### Primary Root Cause

The concrete `ToolRuntime` annotation was stringified by `from __future__ import annotations`, leaving `prepare_deck_build._injected_args_keys` empty. This is deterministic, reproduces at current HEAD, and explains every actual prepare failure in both traces.

### Contributing Causes

1. Production dispatch was not exercised by tests using the real decorated tool.
2. A non-JSON tool exception was treated as model-repairable schema failure.
3. Emitted prepare calls and actual prepare executions are conflated in terminal counters.
4. Large inline HTML tool arguments create provider calls longer than the 120-second force threshold.
5. Clean graph termination leaves the LangSmith root green even when the product result is failed or timed out.

### Ruled Out

The evidence rules out these as causes of the two incidents:

- Stale routing: both runs selected `deck_build_service` with `.pptx` target.
- Creative-plan validation: the service never received the request.
- HTML sanitizer/compiler capability checks: no service spans ran.
- Hands-on-deck, Impeccable, or Hallmark import/runtime failures: those paths were not entered.
- Image provider failure: no image-generation call occurred.
- Native compiler, LibreOffice, Playwright, or preview failure: no compilation or rendering began.
- Artifact surfacing failure: no artifact existed to surface.

## Recommended Fix Direction

### P0: Restore ToolRuntime Injection Before Another Canary

1. Remove `from __future__ import annotations` from `prepare_deck_build.py`, or otherwise ensure the decorated callable's runtime annotation is the actual `ToolRuntime` class at decoration time. Retain `PrepareDeckBuildInput` so runtime remains absent from the model-facing schema.
2. Add explicit invariants:

```python
assert "runtime" in prepare_deck_build._injected_args_keys
assert inspect.signature(prepare_deck_build.func).parameters["runtime"].annotation is ToolRuntime
assert "runtime" not in prepare_deck_build.args
```

3. Add a ToolNode or `create_agent` regression that executes the real decorated `prepare_deck_build` while stubbing `DeckBuildService.prepare_and_build`. The test must prove a runtime object reaches the service, not merely inspect JSON schema.
4. Add a startup audit for every registered tool whose callable declares `ToolRuntime`: fail startup if its parameter is not present in `_injected_args_keys`. This converts a production-only runtime error into a deploy-time failure.

Removing postponed annotations is the smallest proven fix. A local probe with the same explicit `PrepareDeckBuildInput` but a concrete annotation produced `frozenset({'runtime'})` while still excluding runtime from model arguments.

### P1: Make Prepare Failures Semantically Correct

1. In `_prepare_deck_build_result_command`, inspect `ToolMessage.status == "error"` before JSON parsing.
2. Terminalize invocation/infrastructure exceptions immediately with a non-retryable code such as `deck_prepare_execution_error`; preserve only a safe exception class and stage in diagnostics.
3. Reserve the one bounded model repair for structured service payloads where `retryable=true` and `failure_code` is in the approved creative/HTML/mechanical set.
4. Track distinct counters:
   - `prepare_emitted_call_count`
   - `prepare_execution_count`
   - `prepare_real_result_count`
   - `prepare_service_entry_count`
   - `prepare_retry_executed`
5. Define `prepare_call_count` as one stable semantic or retire it from acceptance decisions. Do not use emitted calls as proof that the service executed.

### P2: Make The Eight-Minute Contract Achievable

1. Force the authoritative prepare call immediately after mandatory skill/source reads. Avoid additional unconstrained planning turns once the creative contract is available.
2. Bound pre-prepare provider calls by remaining time and a first-prepare cutoff. A 120-second latch checked only after a 213-second call is not a deadline.
3. Put a strict output budget on inline slide HTML and require compact compiler-supported markup. Record tool-argument bytes and completion tokens.
4. Prefer the next design migration already implied by the service architecture: have the model emit concise structured slide intent and let `DeckBuildService` render canonical HTML. This removes tens of thousands of model-authored HTML tokens while preserving native PPTX compilation and mechanical gates.
5. Do not extend the eight-minute deadline as the primary fix. The service needs enough of that budget for images, compilation, inspection, and preview rendering; authoring should become cheaper and earlier.

### P3: Tighten Terminal Observability

1. Attach final `terminal_status`, `terminal_reason`, `failure_code`, prepare execution counts, and deployed SHA to the trace root or a trace-level summary that the default incident query reads.
2. Keep the existing failing LangSmith feedback, but alert on it rather than root `status=error` alone.
3. Alert when `prepare_emitted_call_count != prepare_execution_count` or when any prepare tool span ends in a Python invocation error.
4. Make gateway and LangSmith copy name the primary failure. Attempt 2 currently tells the user that a repair was exhausted; the more useful message is that deck execution failed before the service started.

## Verification Strategy

Before production deployment:

1. Run a unit invariant over the actual `prepare_deck_build` object.
2. Run a graph-level test with the actual decorated tool and injected runtime.
3. Run one structured service failure followed by one real bounded repair.
4. Run an invocation exception and prove it terminates immediately without a model repair.
5. Run the focused builder/deck suite and Sentrux gate.

Post-deploy, run two six-slide canaries and require all of the following:

- Render and LangSmith report the intended fixed SHA.
- `prepare_deck_build` enters the service at least once; `deck.design_plan.resolve` is present.
- Every emitted prepare call has exactly one real tool span and matching result.
- No prepare span has `missing ... 'runtime'` or another invocation exception.
- First prepare occurs within the declared turn and elapsed-time objectives.
- The service retains enough wall-clock budget for image generation, native compile, inspection, preview, upload, and terminal webhook.
- LangSmith terminal metadata, feedback, gateway status, and artifact result agree.

## Separate Security Finding

During log collection, gateway HTTP client logs included credential-bearing Telegram Bot API URLs. The credential is intentionally omitted here. Rotate the affected bot token and add URL redaction or lower the `httpx` request logger level so secrets embedded in URL paths cannot reach Render logs. Production logs also contain content-bearing diagnostic snippets; review info-level logging for data minimization.

## Bottom Line

The D2.1.1 deck pipeline did not fail its design or mechanical gates. It never started. Both attempts were blocked by a known class of LangGraph runtime-injection defect in the new production tool wrapper. Fix and test the real decorated tool first, make invocation errors non-retryable, then address the inline-HTML timing contract before evaluating visual quality again.

## Implementation Resolution

The remediation keeps model-owned deck design but replaces repeated complete
documents with one shared model-authored stylesheet and compact per-slide body
fragments. DeckBuildService assembles only a neutral 1920x1080 shell, then
runs the unchanged compiler-capability, asset, source-retention, contrast, and
mechanical gates. Runtime injection is guarded against the real decorated tool,
tool execution errors no longer spend the creative repair, authoring calls are
bounded by the 120-second prepare deadline, completion diagnostics target the
LangSmith root run, and gateway HTTP logging redacts credential-bearing URLs.

The exposed Telegram credential and the separately supplied LangSmith key must
be rotated operationally after the logging fix is deployed. No secret value is
stored in this report or repository code.
