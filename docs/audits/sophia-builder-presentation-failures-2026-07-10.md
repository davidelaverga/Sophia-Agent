# Sophia Builder Presentation Failure Forensics - 2026-07-10

## Executive Summary

The two latest production presentation attempts failed for different reasons on the same live deployment. This was not a stale-deploy problem: both `sophia-langgraph` and `sophia-gateway` were running commit `4b6abdf1eef7e930d58667e428494caec671d749`, which matches the branch head.

1. **Attempt 1 crashed in loop-safety middleware before deck construction began.** After the fifth repeated `write_todos` call, `LoopDetectionMiddleware` tried to concatenate a string onto Anthropic's list-form message content. Python raised `TypeError: can only concatenate list (not "str") to list`. No `prepare_deck_build` call, image generation, compilation, or artifact emission occurred.
2. **Attempt 2 spent 33 turns before its first deck-service call.** The model ignored the one-shot deck latch and staged six slide HTML files through repeated `write_file`, `read_file`, `bash`, and todo calls even though the fresh-deck contract explicitly forbids that workflow.
3. **The first `prepare_deck_build` call failed a schema that is not actually documented to the model.** Each `creative_plan.slide_compositions[]` entry requires `selector`, `slide_role`, `headline_intent`, `layout_name`, and `composition_rationale`. The model supplied `slide`, `role`, and `layout`. The validator then returned the misleading message `creative_plan.selector is required`, omitting the array path and index.
4. **The one allowed repair did not execute.** The model emitted a second `prepare_deck_build` call, but LangSmith contains only one actual `prepare_deck_build` tool span. The trace shows a retry `Command(goto="model")`, overlapping middleware branches on the next graph step, no second tool node, and then `DanglingToolCallMiddleware` synthesizing missing tool results. The run continued through bash/write churn until the 45-turn ceiling.
5. **Product and trace status disagree.** Attempt 2 is `success` at the LangSmith/LangGraph root because the graph ended cleanly, while the gateway correctly delivered `timed_out`, `fallback_reason=hard_ceiling`, `budget_stop_reason=turn_limit`, and no artifact.

The recommended strategy is to treat this as a runtime contract failure, not a prompt-tuning problem: fix loop middleware message handling, expose a typed creative-plan schema, replace the retry jump with a deterministic retry state machine, and enforce a presentation-specific first-prepare and terminal deadline.

## Scope And Evidence

Evidence was collected read-only from:

- Render production logs for `sophia-langgraph` and `sophia-gateway`.
- Render live deploy records for both services.
- LangSmith EU project `Sophia`, including both root traces and the child-run hierarchy.
- Persisted LangGraph run/thread state for the two builder tasks.
- The deployed source at commit `4b6abdf1eef7e930d58667e428494caec671d749`.

All timestamps below are UTC. No API keys, provider payloads, or raw memory contents are included in this report.

## Deploy State

| Service | Deploy | Live at | Commit |
|---|---|---:|---|
| `sophia-langgraph` | `dep-d982sdnaqgkc73csnv5g` | 2026-07-09 23:31:23 | `4b6abdf1eef7e930d58667e428494caec671d749` |
| `sophia-gateway` | `dep-d982sgvaqgkc73cso840` | 2026-07-09 23:29:05 | `4b6abdf1eef7e930d58667e428494caec671d749` |

Both failed attempts started after these deploys became live.

## Attempt Summary

| Attempt | Builder run | Window | Wall time | Actual deck-service calls | Result |
|---|---|---|---:|---:|---|
| 1 | `019f4940-eaca-78e1-a360-338247223dc4` | 23:40:19-23:51:12 | 10m 52s | 0 | Graph error, no artifact |
| 2 | `019f4954-0ebd-7fb2-8faf-b8a9a4a3d0fe` | 00:01:14-00:27:36 | 26m 22s | 1 | Gateway timeout at hard ceiling, no artifact |

LangSmith traces:

- [Attempt 1 trace](https://eu.smith.langchain.com/o/26b7385f-8e69-4a13-b4da-49873ae46191/projects/p/7dd40980-665a-4f4a-95c3-582e6270b707/r/019f4940-eaca-78e1-a360-338247223dc4?trace_id=019f4940-eaca-78e1-a360-338247223dc4)
- [Attempt 2 trace](https://eu.smith.langchain.com/o/26b7385f-8e69-4a13-b4da-49873ae46191/projects/p/7dd40980-665a-4f4a-95c3-582e6270b707/r/019f4954-0ebd-7fb2-8faf-b8a9a4a3d0fe?trace_id=019f4954-0ebd-7fb2-8faf-b8a9a4a3d0fe)

## Attempt 1: Loop Safety Crashed

### What Happened

The run completed research and planning activity but never entered the deck service. Its tool history included two web searches, two web fetches, three file reads, and repeated todo updates. At 23:51:12, the fifth repeated `write_todos` call reached the loop hard limit:

```text
Loop hard limit reached - forcing stop
count=5 tools=['write_todos']
```

The intended safety action was to strip the last AI message's tool calls and append a stop instruction. Instead, the LangSmith root error shows:

```text
TypeError: can only concatenate list (not "str") to list
LoopDetectionMiddleware.after_model
loop_detection_middleware.py:202
```

Anthropic represents a tool-using message's content as a list of content blocks. The implementation assumes a string:

```python
"content": (last_msg.content or "") + f"\n\n{_HARD_STOP_MSG}",
```

### Code Cross-Reference

- `backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py:193-204` performs the invalid list-plus-string concatenation.
- `backend/packages/harness/deerflow/agents/sophia_agent/builder_middlewares.py:162-171` puts loop detection inside the builder's after-model chain.
- `backend/tests/test_loop_detection_middleware.py:106-122` tests only string-form content. There is no hard-stop test using Anthropic list-form content blocks.

### Impact

- No clean terminal builder result or artifact failure payload was produced.
- No `prepare_deck_build`, image generation, native compilation, or emit gate ran.
- The run had already consumed at least about `$0.85` before its final long model call.
- The safety mechanism converted a recoverable runaway-planning condition into an unhandled production exception.

## Attempt 2: Contract Failure, Lost Retry, Then Ceiling

### Timeline

| Time | Turn / event | Evidence |
|---|---|---|
| 00:01:14 | Run starts | Correct route: `deck_build_service`; `prepare_deck_build` is exposed |
| 00:01-00:24 | Turns 1-32 | Research, repeated todos, `str_replace`, bash geometry work, six file writes, and file rereads |
| 00:12:03 | Loop warning | Repeated `write_todos` warning is followed by dangling-tool repair |
| 00:24:45 | Turn 33 | First actual `prepare_deck_build` execution |
| 00:24:45 | Validation failure | `deck_creative_plan_invalid`, reported as `creative_plan.selector is required` |
| 00:24:45 | Retry scheduled | `deck.prepare.repair_instruction` and `deck.prepare.retry` spans succeed |
| 00:24:45-00:27:00 | Repair model call | 135 seconds; model emits a second `prepare_deck_build` call |
| 00:27:00 | Turn 34 | Builder logs the second tool call, but no tool span/node executes it |
| 00:27:00 | Recovery churn begins | Dangling middleware injects/reorders two tool results; model switches to bash checks |
| 00:27:03-00:27:35 | Turns 35-45 | Rapid bash/write/model churn, including generic forced `write_file` near ceiling |
| 00:27:36 | Terminal | Gateway emits `timed_out`, `hard_ceiling`, `turn_limit`; artifact path is null |

The run consumed approximately 2.75 million cumulative input tokens, 148 thousand output tokens, and about `$3.97`. It made zero image-generation calls and never compiled a PPTX.

### The Creative Plan Contract Was Not Model-Usable

The first creative plan used composition entries shaped like:

```json
{"slide": 1, "role": "cover", "layout": "..."}
```

The implementation actually requires every entry to contain:

```json
{
  "selector": "slide:1",
  "slide_role": "cover",
  "headline_intent": "...",
  "layout_name": "...",
  "composition_rationale": "..."
}
```

Code and model-facing guidance disagree:

- `backend/packages/harness/deerflow/sophia/deck_build/creative_plan.py:208-231` requires the five fields above.
- `creative_plan.py:265-269` always formats a missing field as `creative_plan.<field>`, losing the nested path and array index.
- `backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py:26-51` names `slide_compositions` but provides no schema or complete example.
- `skills/public/sophia/deck_craft.md:5-35` describes planning order and HTML constraints but not the JSON contract.
- `skills/public/ppt-generation/SKILL.md:19-34` lists top-level creative-plan sections but not their required nested fields.

The repair message therefore told the model to fix `creative_plan.selector`. The model added a top-level `selector`, which the normalizer ignores, while leaving the invalid composition entries unchanged. The validator's pathless message actively pointed the repair in the wrong direction.

### The Allowed Retry Was Lost Before Tool Execution

This is the most important control-flow finding from LangSmith:

- Exactly one `prepare_deck_build` tool span exists, at 00:24:45.
- The model's second call is present in persisted state and is logged by `BuilderArtifactMiddleware` as turn 34.
- There is no second `tools -> prepare_deck_build` child span.
- The next model call begins immediately and asks bash whether a PPTX appeared.
- `DanglingToolCallMiddleware` then reports that it injected/reordered two missing tool results.

The trace boundary is consistent with a graph fan-out or jump interaction, not a deck-service timeout:

1. Graph step 371 executes the first tool.
2. `_prepare_deck_build_retry_command` returns `Command(goto="model")`.
3. Graph step 372 runs the 135-second repair model call.
4. At graph step 373, `BuilderArtifactMiddleware.before_model` and `LoopDetectionMiddleware.after_model` overlap, while no tools node executes the new call.
5. The dangling-call repair makes the conversation acceptable to Anthropic by synthesizing an error result, but that also converts the missing execution into more model turns.

Code cross-reference:

- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:11130-11223` returns the retry command with `goto="model"`.
- `builder_artifact.py:11225-11259` would terminalize a second failed result, but it cannot do so because no second `ToolMessage` reaches this handler.
- `builder_artifact.py:11660-11683` dispatches actual tool results into that handler.
- `backend/packages/harness/deerflow/agents/middlewares/dangling_tool_call_middleware.py:28-155` inserts a synthetic error `ToolMessage` whenever a tool call did not execute or its result is misplaced.
- `backend/tests/test_deck_build_service.py:972-1035` unit-tests the returned `Command` and second-failure mapping, but does not execute a real agent graph across model -> tool -> retry -> model -> tool.

**Confidence:** high that the retry was lost in graph/middleware routing; medium-high that `goto="model"` combined with the normal agent edge is the initiating mechanism. A small local integration reproduction should confirm the exact LangGraph edge behavior before patching.

### The Deck Latch Was Advisory, Not Authoritative

The fresh-deck route tells the model not to write `slides/*.html`, yet the toolset still exposes broad file and shell tools. The model spent most of the run staging slide HTML and helper files instead of making the authoritative service call.

- `builder_artifact.py:6209-6223` defines a deck latch as a `HumanMessage` instruction.
- `builder_artifact.py:9878-9907` injects that instruction once after drift or several non-artifact turns.
- There is no forced `tool_choice=prepare_deck_build` for the fresh service route.
- `builder_artifact.py:7061-7105` falls back to generic forced `write_file` when the ceiling is near and no deliverable exists. That is the wrong recovery action for a service-owned PPTX build.
- `builder_artifact.py:13384-13458` uses the generic 45-turn ceiling. The soft warning at turn 27 does not constrain tools or route execution.

This is why a valid "stop authoring and call the service" instruction did not change runtime behavior.

## Secondary Findings

### Loop Warnings Can Create Dangling Tool Calls

Before the hard-stop crash, loop detection's warning path appends a `SystemMessage` after an AI tool call. In attempt 2, the turn-13 repeated `write_todos` warning was immediately followed by dangling-tool repair for that call. A warning inserted after a tool-using AI message can become the last message used by routing and interrupt the normal tool edge.

This middleware should never alter the AI-message/tool-result adjacency before the tool executes. Warning state should be carried separately and injected on the following model turn after the tool result is complete.

### Terminal Diagnostics Are Internally Contradictory

Attempt 2's root output correctly contains:

```text
artifact_path=null
failure_code=builder_completed_without_deliverable
fallback_reason=hard_ceiling
budget_stop_reason=turn_limit
steps_completed=45
```

But it also contains:

- `generated_visuals_complete=true` with zero expected, zero generated, and no creative plan accepted.
- `unmet_conditions=["visuals_not_embedded", "hero_missing"]` even though image planning never began.
- A companion summary saying "token limit" although the actual stop reason was the turn limit.
- LangSmith root status `success` while the gateway/user result was `timed_out`.

These do not cause the failure, but they make automated diagnosis and alerting unreliable.

### Memory Was Not The Cause

Mem0 returned ten candidates and injected five snippets. They were presentation preference and project-context memories aligned with the request's technical, dark, visual style. Nothing in the trace connects them to either deterministic failure. The first task crashed in Python; the second failed a missing schema and graph routing. Memory changes are not indicated by this incident.

### Security And Log Hygiene Need Immediate Attention

Two unrelated but serious issues appeared during evidence collection:

1. An HTTP client log includes a credential-bearing Telegram API URL. Rotate the affected bot token and redact credential-bearing paths before logging HTTP request URLs.
2. The production LangGraph run/thread state endpoints returned full task state without authentication. Those states include prompts, memories, and tool content. Require service authentication or network restriction and avoid exposing task/thread identifiers in public surfaces.

The LangSmith key supplied for this investigation should also be rotated because it was shared in the task conversation.

## Root Cause Matrix

| Priority | Finding | Confidence | Role in failure |
|---|---|---:|---|
| P0 | Loop hard-stop assumes string content and crashes on Anthropic blocks | Confirmed | Direct cause of attempt 1 |
| P0 | Required creative-plan composition schema is absent from model-facing contract | Confirmed | First service failure in attempt 2 |
| P0 | Validation error omits nested path/index and misdirects repair | Confirmed | Repair changed the wrong field |
| P0 | Second `prepare_deck_build` call never reaches the tool node | Confirmed | Prevented bounded retry and terminal handling |
| P0 | Retry `goto="model"` creates/participates in overlapping graph routing | High-confidence inference | Likely mechanism behind lost retry |
| P1 | Deck latch is instructional only; broad tools remain available | Confirmed | Delayed first service call to turn 33 |
| P1 | Generic 45-turn and `write_file` recovery apply to service-owned PPTX | Confirmed | Extended cost and latency after failure |
| P1 | Loop warning insertion can interrupt AI/tool-result adjacency | Confirmed from logs | Creates dangling-call recovery churn |
| P2 | Trace success, gateway timeout, and diagnostic reason disagree | Confirmed | Masks failures and weakens alerting |

## Recommended Next Strategy

### Phase 0: Contain Production Cost

- Stop repeated production deck probes until the P0 runtime fixes are deployed.
- If presentation creation is customer-facing, temporarily disable the D2 fresh-deck route or route only a canary tenant. Do not rely on the current 45-turn ceiling as protection.
- Rotate the exposed LangSmith and Telegram credentials and close unauthenticated state endpoints.

### Phase 1: Hotfix The Deterministic Failures

1. Make loop hard-stop content type-safe:
   - For string content, append text.
   - For block-list content, append a text block while preserving existing blocks.
   - Never throw from safety middleware; on normalization failure, log and return a terminal-safe message.
2. Move loop warnings out of the active AI/tool-call boundary. Record a warning flag and inject guidance only after the corresponding tool results exist.
3. Add an explicit typed input model for `creative_plan`, including typed `slide_compositions` and generated JSON schema in the tool description.
4. Report validation paths as `creative_plan.slide_compositions[0].selector`, not `creative_plan.selector`.
5. Optionally normalize the observed legacy aliases (`slide`, `role`, `layout`) into the canonical fields when this can be done unambiguously.

### Phase 2: Replace The Retry Jump With A Runtime State Machine

- Do not return directly from the tool wrapper to an unconstrained model with `goto="model"` unless a graph integration test proves there is exactly one outgoing path.
- Prefer the normal tools-to-model edge with state marking `deck_prepare_retry_pending=true`.
- On that next model call, force `tool_choice=prepare_deck_build` and allow no unrelated tools.
- Require a matching real `ToolMessage` for the retry call. If it is missing, terminalize immediately as `deck_prepare_tool_result_missing`; do not let dangling middleware silently turn it into another general model turn.
- After the second real service failure, emit the existing terminal fallback immediately.

### Phase 3: Make Fresh Deck Execution Authoritative

- Force the first `prepare_deck_build` call by turn 6-8 after required research/skill reads.
- Once the deck-service latch is active, reject `bash`, `write_file`, `str_replace`, and lower-level deck work except narrowly defined source reads.
- Do not use generic forced `write_file` for a fresh service-owned PPTX route.
- Introduce a presentation-specific ceiling: approximately 12 non-artifact turns and 5-8 minutes, with the service call required well before the ceiling.
- Longer-term, reduce giant model tool payloads by accepting a structured slide specification that the service turns into native HTML. Requiring the model to assemble six multi-kilobyte inline HTML strings encourages temporary file staging and context growth.

### Phase 4: Align Completion And Observability

- Mark the LangSmith root as error/timeout, or at minimum set authoritative root metadata, when `builder_result.status` is not successful.
- Use the actual stop reason in user copy (`turn_limit`, not `token limit`).
- Do not report generated-visual completeness before the creative plan establishes expected assets.
- Add `first_prepare_turn`, `prepare_call_count`, `prepare_retry_executed`, `dangling_prepare_call_count`, and `terminal_reason` to safe completion metadata.
- Alert whenever a model emits `prepare_deck_build` but no matching tool span/result appears.

## Required Regression Tests

1. Loop hard-stop with Anthropic list-form content preserves blocks, removes tool calls, and never raises.
2. Loop warning does not prevent the current AI tool call from executing.
3. Tool schema exposes all required composition fields and a complete canonical example.
4. Validation errors include the exact nested path and index.
5. Full graph integration: first retryable prepare failure -> one repair model call -> one real second prepare tool call -> terminal result.
6. Full graph integration: a missing second prepare result terminalizes instead of invoking dangling-call recovery and more model turns.
7. Fresh deck drift test: after the latch, file/shell authoring is blocked and `prepare_deck_build` is forced.
8. Presentation ceiling test: no run can reach 45 generic turns.
9. Completion test: LangSmith/root metadata, gateway status, user message, and `builder_result` agree on timeout/error reason.
10. Security tests: production state endpoints require auth and HTTP logs redact credential-bearing URLs.

## Canary Acceptance Gates

Before reopening production traffic, run two six-slide canaries, one visual-heavy and one ordinary technical deck. Both must satisfy:

- First `prepare_deck_build` call by turn 8.
- Exactly one real tool span per emitted prepare call.
- Retryable failure produces exactly one real retry, then success or a clean terminal failure.
- No dangling placeholder for `prepare_deck_build`.
- No prohibited slide-file staging after the deck latch.
- Terminal outcome within 12 turns and 8 minutes.
- A valid PPTX is emitted immediately on service success.
- Trace root status and gateway completion status agree.
- No secrets or raw provider payloads appear in logs.

## Conclusion

The deployed D2 route is selected correctly, and provider availability was not the problem. The failures occurred before image generation and native compilation: first in loop middleware, then at the model/tool schema and retry-control boundary. The next change should be a narrow runtime stabilization patch with graph-level tests. Another visual-quality or prompt-only iteration will not address these production failures.
