# Sophia Builder Post-`88c68110` Presentation Failures and False-Success Forensics

**Investigation date:** 2026-07-12
**Production window:** 2026-07-12 14:45-15:20 UTC
**Branch:** `codex/sophia-observability-v1`
**Deployed commit:** `88c68110cc5057bd03f5ff0573fe65e38886aae9`
**Evidence:** Render production logs, production LangGraph checkpoint/history state, LangSmith completion-annotation logs, current code and tests, commit history, and prior audit reports

**Security note:** This report excludes API keys, authorization values, raw prompts, provider-private blocks, generated CSS/HTML bodies, and memory contents.

**Remediation implementation status:** Implemented on
`codex/sophia-observability-v1` after this investigation. The patch uses exact
`tinycss2` declaration parsing, author-only canvas validation, compact model
HTML v2 limits, absolute authoring-stream cancellation, authoritative builder
task reconciliation, identity-matched LangSmith root selection, and a durable
event-store readiness/circuit breaker. Production database migration and
post-deploy canaries remain operational acceptance steps; this code change does
not deploy production.

## Executive Summary

The two post-redeploy presentation builds both failed, but for different immediate reasons:

1. **Attempt 1 exhausted the model's 16,384-token authoring output before producing a complete `prepare_deck_build` call.** The model call streamed for about 172 seconds, so the nominal 120-second authoring deadline did not interrupt it. The final AI message had `stop_reason=max_tokens` and a partial prepare call without the required slide payload. The builder correctly emitted `failed / deck_authoring_output_truncated`, with no service execution and no artifact.

2. **Attempt 2 reached `DeckBuildService` twice and was rejected by deterministic validator defects.** It produced five compact slides, accepted the creative plan, executed the real prepare tool twice, and honored the one-repair limit. Both service attempts falsely rejected otherwise legitimate CSS:
   - `text-transform: uppercase` is incorrectly matched by the validator's `transform:` regular expression and reported as unsupported `transform`;
   - the compact shell supplies one `main { ... }` rule before the model stylesheet, while the background validator reads only the first matching `main` rule. It therefore misses the later model-authored opaque background and reports `slide canvas must declare an opaque background`.

The user's observation that Sophia said the builds succeeded is also confirmed. The gateway persisted both authoritative builder completions as `status=error`, with no artifact. Later, `check_async_task` read only LangGraph's native run status. Because the failed builders terminate their graphs cleanly, native LangGraph reports `success`. The native lifecycle tool then overwrote each parent `async_tasks` record with `status=success`, discarded `builder_result` and its failure metadata, and returned the builder's last message instead of its authoritative result. This is a **product-status corruption bug**, not a model phrasing issue.

The current release is progress over the previous incidents: the invalid Anthropic `max_retries` parameter is gone, concrete `ToolRuntime` injection works, real prepare calls execute, counters are truthful, and incomplete PPTX files are not shipped. The current blockers are the next layer: an unenforceable streaming deadline, two compact-contract validator bugs, and lifecycle code that treats clean graph completion as successful artifact completion.

## Severity

| Finding | Severity | Confidence | Impact |
|---|---:|---:|---|
| Native `check_async_task` overwrites authoritative builder failure with graph `success` | P0 | Confirmed | Sophia tells the user failed builds succeeded and deletes the failure payload |
| Compact shell plus validator falsely rejects a valid opaque `main` background | P0 | Confirmed | Every model stylesheet that restyles `main` can be rejected before compilation |
| `text-transform` is falsely parsed as `transform` | P0 | Confirmed | Common uppercase labels make otherwise compiler-safe decks fail |
| The 120-second authoring deadline is an inactivity timeout, not an absolute deadline | P1 | Confirmed | Prepare can arrive 43+ seconds late; a truncated call can run 65+ seconds beyond the contract |
| One-call payload limits and 16,384 output tokens are internally inconsistent | P1 | Confirmed | A valid five-slide call can exceed the provider budget before the service sees it |
| Compact repair instructions still request legacy `html_source` | P1 | Confirmed | The single repair can be steered toward a mixed or obsolete contract |
| Build-foundation event table is missing in production | P1 | Confirmed | Durable event replay and recovery are unavailable; every event write/replay logs 404 |
| Completion metadata appears attached to a terminal-time LangSmith root, not the builder root | P1 | High-confidence inference | Root trace views can remain green or lack terminal metadata |
| Failure next-action copy mentions image generation when no image call occurred | P2 | Confirmed | User/operator guidance points at the wrong subsystem |

## Deployment and Run Matrix

Both services were running the same current commit before the requests began:

| Service | Deploy | Live at (UTC) | Commit |
|---|---|---:|---|
| `sophia-gateway` | `dep-d99qk2ss728c73dmrgmg` | 14:53:56 | `88c68110` |
| `sophia-langgraph` | `dep-d99qjvgk1i2s73ek299g` | 14:56:07 | `88c68110` |

| Property | Attempt 1 | Attempt 2 |
|---|---|---|
| Task/thread | `019f56d8-6b4a-7fb0-ac50-a885ec8681ec` | `019f56dd-9424-77c3-a371-85275f675ebd` |
| Builder run | `019f56d8-6be5-7d92-92ff-6c3c78d40ff4` | `019f56dd-9426-7061-8696-6b30b1bc021b` |
| Started | 15:00:51.815 | 15:06:29.799 |
| Ended | 15:03:57.548 | 15:10:14.849 |
| Duration | 185.7 s | 225.1 s |
| Requested slides | 5 | 5 |
| First prepare turn | Partial call on final turn | Turn 6 |
| Prepare emitted/executed/results | partial / 0 / 0 | 2 / 2 / 2 |
| Service entries/results | 0 / 0 | 2 / 2 |
| Creative plan accepted | No | Yes |
| Outcome | `deck_authoring_output_truncated` | `deck_slide_html_invalid` |
| Artifact | None | None |

Gateway terminal events were correct for both tasks:

- `status=error`
- canvas `status=failed`
- `requested_artifact_ext=pptx`
- no artifact path or URL
- `fallback_reason=deck_build_service_failed`

There was no provider fallback, no legacy deck fallback, and no incomplete PPTX surfaced as success.

## Attempt 1: Truncated Before Service Execution

### Timeline

1. The builder selected the forced production `deck_build_service` route.
2. Turn 1 read `ppt-generation`.
3. Turn 2 performed web research and created the todo plan.
4. Turn 3 read the visual-design skill.
5. The next model call began at approximately 15:01:04.9 and completed at 15:03:56.7, taking 171.8 seconds.
6. The response contained a partial `prepare_deck_build` tool call but ended with `stop_reason=max_tokens`. Required deck fields were incomplete.
7. `BuilderArtifactMiddleware` terminalized the run as `deck_authoring_output_truncated` before ToolNode execution.
8. The gateway received an error completion with no artifact.

### What worked

- Anthropic returned HTTP 200; the July 12 `max_retries` invocation regression is fixed.
- The runtime recognized truncation and did not execute malformed arguments.
- No dangling prepare result was fabricated.
- No degraded or partial deck was delivered.

### What failed

The configured request timeout is passed as model setting `timeout`. For a streaming response, that is effectively an HTTP connect/read inactivity timeout. The provider kept sending data, so it did not enforce an absolute 120-second authoring deadline. Middleware can check elapsed time only before or after the model call; it cannot preempt the in-flight stream.

The terminal label is also ordered incorrectly. When the model finally returned, elapsed authoring time was about 185 seconds. `_deck_authoring_message_failure_update()` checks truncation and returns immediately, so the already-exceeded authoring deadline is not considered. The truthful primary terminal reason should be `deck_authoring_deadline_exceeded`, with truncation retained as a secondary diagnostic.

The payload contract makes this likely. The tool permits:

- 24 KB shared CSS;
- 16 KB body plus 8 KB slide CSS per slide;
- 128 KB total authoring payload;
- a nested creative plan in the same call.

That maximum cannot fit inside a 16,384-token response. Even a much smaller five-slide deck can cross the limit because tool-call JSON escaping adds overhead. The contract is bounded at the service boundary but not sized to the provider boundary.

## Attempt 2: Valid Compact Authoring Rejected by Validator Bugs

### Timeline

1. Turns 1-3 repeated the required skill and research setup.
2. Turn 5 wrote a shared CSS support file.
3. At turn 6 and 91.6 seconds elapsed, middleware forced `prepare_deck_build`.
4. That model call took 71.5 seconds; the first prepare was emitted around 163 seconds after kickoff, already past the 120-second authoring deadline.
5. The first real service execution received five compact slides and failed as retryable `deck_slide_html_invalid`.
6. The single repair call took about 59 seconds.
7. The second real service execution failed on the same two remaining validation errors.
8. The runtime terminated cleanly with no artifact. Counters correctly show two calls, executions, service entries, service results, and matching tool results.

### First service result

The first call failed on slide 1 with:

- `unsupported_native_deck_css: letter-spacing`
- `unsupported_native_deck_css: transform`
- `lossy_native_deck_css: letter-spacing`
- `slide canvas must declare an opaque background`

The repair removed `letter-spacing`, as requested.

### Second service result

The repaired call still failed on slide 1 with:

- `unsupported_native_deck_css: transform`
- `slide canvas must declare an opaque background`

Both remaining errors are deterministic false positives.

### False `transform` detection

`compiler_capabilities.py` uses:

```python
_TRANSFORM_RE = re.compile(r"\btransform\s*:\s*([^;}{]+)", re.I)
```

The word boundary after the hyphen in `text-transform` matches this pattern. Consequently, `text-transform: uppercase` is parsed as if it were `transform: uppercase`, which is then rejected because only rotate transforms are supported.

The production stylesheet contained `text-transform` but no actual `transform` property. A local reproduction on current HEAD returns exactly:

```text
unsupported_native_deck_css: transform
slide canvas must declare an opaque background
```

for a compact slide whose only typography rule is `text-transform: uppercase`.

### False opaque-background detection

The compact assembler emits this shell before model CSS:

```css
main { width: 1920px; height: 1080px; box-sizing: border-box; overflow: hidden; }
```

The model then correctly supplies a later `main` rule with an opaque background. `_selector_rule_body(css, "main")` uses `re.search` and returns only the first matching rule body. `_canvas_backgrounds()` therefore sees the shell's dimension-only `main`, never sees the later model rule, and reports the background missing.

This defect is an integration regression between the older full-document validator and the compact shell added in commit `d6d803f0`. Both production calls had a model-authored `main` background. The service rejected them anyway.

### Retry contract mismatch

The generated repair instruction still says to provide "one `html_source` per slide" even though new model calls must use `deck_stylesheet` plus `slides[*].html_body`. The model happened to stay in compact mode, but the instruction contradicts the active schema and can cause mixed-mode validation failures in other runs.

## Why Sophia Reported Success

### Authoritative state was initially correct

For Attempt 2, parent checkpoint history shows this transition:

```text
15:10:14.975  status=error  builder_result present  terminal_reason=deck_slide_html_invalid
```

The gateway persisted the full failed builder result. The canvas and event bus also published error.

### `check_async_task` corrupted it

At 15:11:23 the companion called `check_async_task`. The native deepagents tool:

1. fetches `client.runs.get()`;
2. sees native LangGraph run status `success`, because the graph ended cleanly;
3. treats that as successful task completion;
4. reads the builder thread's last message as the result;
5. writes a narrow `AsyncTask` record containing only IDs, status, and timestamps.

The parent checkpoint immediately became:

```text
15:11:23.697  status=success  builder_result absent
```

Attempt 1 underwent the same overwrite after a status check. A contemporaneous failed PDF task also transitioned from `error` with a complete result to `success` without it. The bug is therefore systemic across cleanly terminated builder failures.

Two local wrappers currently preserve the native behavior:

- `BuildAwarenessMiddleware._refresh_task_status()` trusts `run["status"]` without reading `thread.values.builder_result`.
- `make_check_async_task_wrapper()` only normalizes missing fields, then delegates to native `check_async_task` unchanged.

`merge_async_tasks()` replaces the entire per-task record with the narrow update, so the previously persisted `builder_result`, terminal reason, artifact metadata, and failure summary are deleted.

The native success result also imports the last raw builder message rather than the safe builder result. In Attempt 1 that message contained an incomplete tool-call payload and provider-private content. Even apart from truthfulness, this is the wrong data boundary for companion status reporting.

## LangSmith and Observability Findings

The production service logged completion annotations for both failures:

| Attempt | Logged completion annotation run/root |
|---|---|
| 1 | `019f56db-3e1e-7560-ad3b-44ab2a9a122c` |
| 2 | `019f56e0-fef1-7d62-a816-d16da8040806` |

For each, the logged `run_id` and `root_run_id` are identical and differ from the long-running builder run. The IDs appear only at terminal time. Current code selects `_current_run_tree()` first and only consults the identity-scored active Pregel root when no current run exists. A detached middleware/tool run can therefore win and prevent the intended fallback from attaching metadata and feedback to the actual builder root.

Direct LangSmith EU API retrieval was attempted during this investigation, but the previously supplied key now returns HTTP 403, consistent with the planned credential rotation. Detailed claims in this report therefore rely on Render logs and the production LangGraph checkpoint/history records, which contain the authoritative AI/tool/result sequence and terminal state. No conclusion depends on an unread trace payload. A follow-up with a current read-only LangSmith credential should verify whether the actual builder roots carry `terminal_status`, `terminal_reason`, and failing feedback.

The same logs expose another observability gap: all `sophia_build_operation_events` replay calls returned 404. The migration exists at `backend/migrations/2026_07_11_sophia_build_foundation.sql`, but the production table is absent. This did not cause either deck failure because in-graph counters remained correct, but durable event replay and recovery are unavailable.

## Commit and Prior-Incident Cross-Reference

### Fixed from prior reports

- **July 11 ToolRuntime failure:** fixed. Attempt 2 executed the real decorated tool and entered `DeckBuildService` twice.
- **July 12 invalid Anthropic `max_retries`:** fixed by `8b4b51c6`. Both runs reached Anthropic and received HTTP 200 responses.
- **Unbounded prepare retry:** fixed. Attempt 2 stopped after one real repair and two actual service executions.
- **Incomplete artifact surfacing:** fixed. Neither run shipped a fallback or partial deck.

### Newly exposed or introduced

- Commit `16ceac06` introduced the transform parser that matches `text-transform`.
- Commit `d6d803f0` added the compact shell ahead of model CSS, exposing the first-`main` background lookup defect and adding the non-preemptive model timeout.
- Commit `8b4b51c6` removed the invalid `max_retries` field and improved error classification, allowing the runtime to reach these deeper failures.
- Commit `5201c1e4` preserves updated completion metadata in gateway/canvas paths, but does not protect it from the companion lifecycle tool's later native-status overwrite.
- Commit `5a416ed4` added active Pregel root discovery as a fallback, but `_current_run_tree() or _active_pregel_run_tree(...)` still prefers a detached current span.
- Commit `033413ab` added the build-foundation event schema, but the corresponding production database migration has not been applied.

This is not a recurrence of the July 10 SVG-loss defect. The current validator blocks unsupported SVG before compilation. It is now over-rejecting valid CSS before native compilation begins.

## Recommended Fix Direction

### P0: Correct compact CSS validation

1. Parse CSS declarations by exact property name. Inspect only declarations whose property is exactly `transform`; never search a substring regex that can match `text-transform`.
2. Replace first-match selector extraction with a declaration/cascade-aware collector. For canvas validation, inspect all matching `main`, `.slide-root`, `.canvas`, `body`, and inline declarations in source order.
3. Add production-shaped tests using the actual compact shell:
   - model `main { background: #101010 }` after the shell passes;
   - `text-transform: uppercase` passes;
   - `transform: rotate(...)` passes;
   - `transform: translate(...)` fails;
   - transparent or absent canvas backgrounds fail.
4. Remove duplicate reporting where lossy CSS is emitted as both `unsupported_*` and `lossy_*`, unless the two severities intentionally carry different actions.

### P0: Make builder result authoritative in companion lifecycle

1. For `sophia_builder`, replace native `check_async_task` result construction with a product-aware adapter:
   - read the builder thread state;
   - if `builder_result.terminal_status` exists, map `completed -> success`, `failed -> error`, and `timed_out -> timeout`;
   - return a safe subset of `builder_result`, never the last raw AI message.
2. If the cached parent task already has a signed terminal webhook result, do not replace it with native graph `success`.
3. Preserve the existing task dict when updating timestamps/status. Do not reconstruct a narrow `AsyncTask` that drops `builder_result` and artifact/failure metadata.
4. Apply the same precedence rule in `BuildAwarenessMiddleware` and `list_async_tasks`.
5. Add graph-level regressions for cleanly terminated `failed` and `timed_out` builders, including a later explicit status check and synthetic wakeup.
6. Assert that provider-private blocks and raw tool arguments never enter companion lifecycle tool results.

### P1: Enforce an absolute authoring deadline

1. Wrap the asynchronous model handler in `asyncio.timeout(remaining_authoring_seconds)` or equivalent cancellation, rather than relying on HTTP stream inactivity timeout.
2. If a response returns after the deadline, classify `deck_authoring_deadline_exceeded` as primary and retain `output_truncated` as secondary diagnostics.
3. Add a controlled streaming model test that yields chunks continuously beyond 120 seconds; it must still be cancelled at the absolute deadline.
4. Record `authoring_started_at`, `authoring_deadline_at`, `authoring_cancelled_at`, and the provider stop reason.

### P1: Make compact authoring fit the provider budget

Choose one coherent contract:

- **Recommended short-term:** reduce the model-facing limits and prompt toward genuinely compact output (for example, about 8 KB shared CSS and 3-4 KB body per slide), while keeping larger internal legacy limits for queued callers.
- **Longer-term:** add staged model-owned authoring tools that store the shared stylesheet and slide fragments incrementally, then let one small `prepare_deck_build` call reference that trusted state. This preserves model ownership without requiring the complete deck and creative plan in one provider response.

Do not simply raise the token cap while retaining a strict 120-second deadline; the first run already spent 172 seconds streaming 16,384 tokens.

### P1: Align repair and observability contracts

1. Generate repair instructions from the active authoring mode. Compact calls must request `deck_stylesheet`, `html_body`, and optional `slide_css`, not `html_source`.
2. Apply `2026_07_11_sophia_build_foundation.sql` to production and verify event append/replay no longer returns 404.
3. Prefer the identity-scored Pregel root over an unverified current span when annotating completion. Log both the graph root and active child IDs, and test that terminal metadata/feedback lands on the actual root.
4. Make `user_next_action` reason-specific. Neither observed presentation attempted image generation, so image-generation remediation should not be suggested.

## Post-Deploy Acceptance

Run two five- or six-slide canaries and require all of the following:

- first prepare emitted by turn 6 and no later than 120 seconds;
- absolute cancellation at 120 seconds if no complete prepare is available;
- `text-transform: uppercase` and a later model-authored `main` background pass validation;
- exactly one real result per executed prepare call;
- no more than two service executions;
- zero dangling calls;
- a successful canary produces a native editable PPTX and preview;
- a deliberately invalid canary remains `error` after `check_async_task` and after companion wakeup;
- parent `async_tasks` retains `builder_result`, terminal reason, and counters;
- no raw model/tool payload appears in lifecycle status output;
- build-event persistence returns success, not 404;
- LangSmith actual root metadata, gateway terminal event, canvas status, and companion narration all agree.

## Bottom Line

The deck service is now reachable and the bounded retry path works. The current production failure is not a stale deploy or provider outage. Attempt 1 proves the authoring deadline/output contract is still internally inconsistent; Attempt 2 proves the compact validator rejects valid model-authored CSS because of two deterministic parser/cascade defects. Sophia's false success report is a separate lifecycle bug that collapses product failure into clean graph success and destroys the authoritative result.

Fix the validator and product-status precedence first. Then enforce a real absolute authoring deadline and resize or stage the compact payload so valid deck calls can fit inside it.
