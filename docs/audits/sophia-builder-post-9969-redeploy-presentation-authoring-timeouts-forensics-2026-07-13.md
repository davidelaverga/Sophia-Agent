# Sophia Builder Post-`9969e9e9` Presentation Authoring Timeout Forensics

**Investigation date:** 2026-07-12 Pacific / 2026-07-13 UTC
**Production window:** 2026-07-13 00:22:39-00:27:44 UTC
**Branch:** `codex/sophia-observability-v1`
**Deployed commit:** `9969e9e92759be243dd754f2e17addb11e096c7e`
**Current branch head:** `9895964a9cab273b87f9e281da6d79a99c35c3b0`
**Evidence:** Render production logs, LangSmith trace trees, gateway terminal events, current code, deployed and current commit history, and prior presentation forensic reports

**Security note:** This report excludes credentials, signed URLs, raw prompts, model-authored HTML/CSS, memory contents, and provider-private payloads.

## Executive Summary

The two latest presentation tasks failed for the same immediate reason: the builder cancelled the final Anthropic stream at the absolute 120-second presentation-authoring deadline before the model completed a `prepare_deck_build` tool call.

This is a deterministic control-flow problem, not a DeckBuildService, CSS validator, image-generation, compiler, or provider-availability failure:

- both tasks selected the production `deck_build_service` route;
- Anthropic accepted every request with HTTP 200;
- neither trace contains a `prepare_deck_build` tool run;
- neither trace entered `DeckBuildService`;
- no image generation, HTML validation, native compilation, inspection, or repair occurred;
- both gateway completions truthfully reported `timeout` with no artifact.

The strict cancellation added in commit `23b2e23f` is working. The regression is that it is paired with an unreachable clock-based prepare latch. `prepare_force_after_seconds` is 120 seconds, while the model stream is also cancelled at 120 seconds. If a model call is in flight when the threshold is crossed, the runtime cancels that call and terminalizes the build. There is no next model turn on which the 120-second force can take effect.

The turn latch does not save these runs. It is configured for turn 6, but both models began the large all-deck authoring response on approximately turn 4. The payload must contain the complete creative plan, shared CSS, and every slide body in one tool call. After skill reads, planning, research, and in one case a shell call, only 83 seconds remained in Attempt 1 and 108 seconds in Attempt 2. Neither stream completed in that time.

The prior 2026-07-12 incident is important context. Its comparable authoring call ran for about 172 seconds and then truncated at 16,384 output tokens. The new absolute timeout prevents that late response, but the current one-call workflow has not been made fast enough to fit inside 120 seconds. The release changed late failure into timely, truthful failure without making successful authoring feasible.

There are two secondary operational defects:

1. Production still lacks the build-foundation event table/RPC migration, so durable build events are unavailable and every run reports degraded readiness.
2. LangSmith terminal metadata and feedback are attached to an `after_model` child span, not the actual `Sophia Builder` root. The root traces remain clean/green and the logs show `builder_run_id=None`, despite the trace metadata itself containing the correct builder run ID.

## Severity and Confidence

| Finding | Severity | Confidence | Impact |
|---|---:|---:|---|
| The 120-second prepare force and 120-second hard cancellation are mutually incompatible | P0 | Confirmed | In-flight authoring is cancelled before the clock force can ever produce a prepare call |
| The full-deck authoring response begins without a forced tool choice and too little reserved time | P0 | Confirmed | Both latest tasks fail before any deterministic deck work begins |
| Pre-authoring skill, todo, research, and shell activity consumes the strict authoring window | P1 | Confirmed | Attempt 1 lost 36 seconds and Attempt 2 lost 12 seconds before final authoring |
| The model input and one-call output contract are too large for the observed latency budget | P1 | Confirmed | Final prompts reached 10 messages; preceding calls already carried 27k-34k prompt tokens |
| LangSmith completion annotation misses the builder root | P1 | Confirmed | Root traces remain successful and lack terminal tags/metadata |
| Build-foundation event persistence is unavailable in production | P1 | Confirmed | Durable replay, recovery, and deployment acceptance evidence are absent |
| `prepare_deck_build` emits a repeated Pydantic `register` shadowing warning | P2 | Confirmed | Schema noise on every model turn; not causal in these failures |

## Deployment State

Both production services were on the same commit before either task began:

| Service | Deploy | Live at (UTC) | Commit |
|---|---|---:|---|
| `sophia-gateway` | `dep-d9a2fvho3t8c738732dg` | 23:51:22 | `9969e9e9` |
| `sophia-langgraph` | `dep-d9a2ft1o3t8c73872rl0` | 23:53:22 | `9969e9e9` |

There was no gateway/LangGraph version skew.

The branch is currently at `9895964a`, three commits ahead of production. Those commits address PDF visibility and renderer URL handling. They do not change presentation force timing, authoring orchestration, or the one-call deck contract. Redeploying current HEAD alone will therefore not fix this incident.

## Run Matrix

| Property | Attempt 1 | Attempt 2 |
|---|---|---|
| Task/thread | `019f58da-c082-7901-8cf5-18833607d037` | `019f58dd-8e7b-75b0-859e-f57bbc3ee2af` |
| Builder run / LangSmith trace | `019f58da-c084-72c0-a57e-ab5b21ef7a42` | `019f58dd-8e7e-75c3-81f2-15666bf8e166` |
| Builder root start | 00:22:39.969 | 00:25:43.439 |
| Final authoring stream start | 00:23:15.868 | 00:25:55.067 |
| Stream cancelled | 00:24:38.988 | 00:27:42.791 |
| Time spent before final authoring | 35.9 s | 11.6 s |
| Time available to final authoring | 83.1 s | 107.7 s |
| Final assembled prompt | 43,504 chars / 10 messages | 44,763 chars / 10 messages |
| Highest completed prompt-token count | 34,260 | 31,258 |
| `prepare_deck_build` emitted/executed/results | 0 / 0 / 0 | 0 / 0 / 0 |
| Service calls/results | 0 / 0 | 0 / 0 |
| Terminal status/reason | `timed_out` / `deck_authoring_deadline_exceeded` | `timed_out` / `deck_authoring_deadline_exceeded` |
| Artifact | None | None |

An immediately preceding post-deploy task at 00:12 UTC failed with the same `elapsed_ms=120009` signature. It is not counted as one of the two latest attempts, but it raises confidence that the behavior is systematic rather than request-specific.

## Attempt 1

### Trace sequence

1. The builder selected the forced production PPTX route.
2. The first model turn returned after 2.85 seconds with 26,684 prompt tokens and 257 completion tokens.
3. The model called `read_file` and `write_todos`.
4. The next model turn forced/performed `builder_web_search`.
5. A third model call ran for 29.15 seconds, with 34,260 prompt tokens and 2,151 completion tokens.
6. The model called `bash`.
7. The final authoring stream began at 00:23:15.868 with about 83 seconds left.
8. The stream had not completed a tool call when the 120-second absolute deadline cancelled it.
9. The builder produced a clean terminal timeout with no artifact.

The important point is that the research itself took only about 1.2 seconds. Most of the pre-authoring loss came from another long model turn and workflow churn, not external search latency.

## Attempt 2

### Trace sequence

1. The builder selected the same forced production PPTX route.
2. The first deck model turn carried 27,329 prompt tokens and called `read_file`.
3. The next turn carried 29,629 prompt tokens and called `builder_web_search` plus `write_todos`.
4. A third turn carried 31,258 prompt tokens and called `read_file` again.
5. The final authoring stream began at 00:25:55.067 with about 108 seconds left.
6. The stream had not completed a tool call when it was cancelled at 00:27:42.791.
7. The builder again emitted an accurate timeout with no artifact.

This attempt had more authoring time than Attempt 1 and still did not finish. That agrees with the prior production evidence that a complete model-owned deck call can require materially more than 120 seconds.

## What Worked

- The production route flag was correct and lower-level deck compilation was not used.
- The absolute `asyncio.timeout_at` now cancels the Anthropic stream at the intended deadline.
- No SDK retry or provider fallback extended either run.
- No malformed, partial, or degraded PPTX was surfaced.
- The builder terminal object used `timed_out` and `deck_authoring_deadline_exceeded`.
- The gateway mapped the completion to `timeout`, persisted no artifact, and queued a timeout companion wakeup.
- The previous false-success gateway overwrite was not observed in this window.

The LangGraph worker still logs `Background run succeeded` because the graph terminates cleanly rather than raising. That is expected for the chosen architecture, but only safe when every consumer uses the authoritative `builder_result`. Gateway behavior in these two runs did so.

## Root Cause Analysis

### Root Cause A: The clock latch and hard deadline share one threshold

`PRESENTATION_BUILDER_BUDGET` sets:

```text
prepare_force_at_turn = 6
prepare_force_after_seconds = 120
authoring_timeout_seconds = 110
max_wall_clock_seconds = 480
```

`_deck_prepare_force_due()` activates the forced prepare choice only when a model turn begins and elapsed time is already at least 120 seconds. `awrap_model_call()` independently computes remaining authoring time as `120 - elapsed_since_builder_start` and cancels the current model stream when that reaches zero.

Therefore, a model call that crosses 120 seconds cannot complete and cannot advance to the next turn. The clock latch is unreachable in exactly the failure mode it was intended to prevent.

### Root Cause B: Turn 6 is too late for a single large authoring call

The model began the final authoring response around turn 4 in both traces. Because turn 6 had not been reached, `tool_choice=prepare_deck_build` was not forced. The model was free to reason and stream a large response under the ordinary tool set.

The runtime currently relies on the model voluntarily completing the prepare call before either force threshold. That is not deterministic.

### Root Cause C: Presentation preflight policy contradicts the compact kickoff contract

The prompt says the injected deck-craft bundle is authoritative and separate skill reads are optional. The runtime still presents or forces a general-agent workflow that includes:

- design-skill reads;
- todo planning;
- web research;
- additional file reads;
- shell access before the prepare latch.

Both traces followed those paths. The activity consumed time, added conversation messages, and grew the final model context. It did not produce a service-ready deck artifact.

### Root Cause D: Input/context size and output size are not calibrated to the deadline

The final calls had six assembled prompt blocks, approximately 44k characters of assembled prompt, 10 conversation messages, a large typed tool schema, and preceding prompt-token counts between 31k and 34k.

The same call must serialize:

- a complete nested creative plan;
- one shared stylesheet;
- every slide's title, narrative, role, layout, notes, and HTML body;
- optional slide CSS;
- all JSON escaping and tool-call structure.

Compact v2 caps the result at 48 KiB and 16,384 output tokens, but those are maximum boundaries, not a latency guarantee. The prior production call needed about 172 seconds and still ended at `max_tokens`. The new 120-second cutoff is stricter than observed authoring performance.

### Root Cause E: Terminal trace selection remains non-authoritative

The LangSmith root runs are correctly named `Sophia Builder` and use the actual builder run ID as trace ID. They finish with `error=false` and only the normal builder tags.

Terminal metadata instead appears on `BuilderArtifactMiddleware.after_model` child runs. Production logs report:

```text
builder_run_id=None
```

and identify the child span as both `run_id` and `root_run_id`. The in-memory `parent_run` chain is incomplete at annotation time, and the state/artifact identity supplied to `_completion_identity()` does not contain the builder run ID. The scoring fallback consequently selects the current child span.

### Operational Cause F: The required database migration is still absent

Every builder startup reports the build-foundation event table/RPC as unavailable. The circuit breaker prevents repeated writes from blocking the build, so this did not cause the timeouts. It does remove durable events and weakens forensic and recovery guarantees.

## Ruled Out

- **Anthropic outage or request rejection:** every provider request returned HTTP 200.
- **Runtime injection regression:** `prepare_deck_build` was present in the route and startup completed.
- **CSS/background validator defects:** the service never received either request.
- **Image generation:** no image-generation tool or service stage ran.
- **Native PowerPoint compilation:** no compiler stage ran.
- **Retry exhaustion:** no first prepare result existed, so the creative repair was never used.
- **Gateway/LangGraph deploy skew:** both services ran `9969e9e9`.
- **The three commits not yet deployed:** they are PDF/renderer fixes and do not affect this flow.

## Recommended Fix Direction

### 1. Make prepare deterministic before the first large response

For service-owned fresh PPTX tasks, force `tool_choice=prepare_deck_build` on the first true deck-authoring model call. If factual research is required, allow at most one bounded preflight phase and then force prepare. Do not wait until turn 6.

The runtime should reserve at least 100-110 seconds of the 120-second authoring budget for the forced authoring call. If preflight exceeds its reserve, skip remaining preflight work and begin authoring immediately.

### 2. Separate the latch threshold from the cancellation threshold

Use distinct values and semantics:

- an early prepare latch, for example 15-30 seconds or turn 2;
- an absolute prepare completion cutoff at 120 seconds;
- the existing total build deadline at 480 seconds.

The early latch must be applied before entering a model call. A threshold checked only after an in-flight call returns cannot guarantee anything.

### 3. Use a presentation-specific authoring lane

Once the request is classified as a fresh PPTX:

- inject the compact craft bundle and relevant source excerpts up front;
- remove todo, shell, write/replace, lower-level deck tools, and redundant skill reads from the model-facing tool set;
- either precompute bounded research outside the authoring lane or expose exactly one bounded search action;
- invoke a dedicated forced structured authoring call with only `prepare_deck_build` available.

This keeps model ownership of story, design, CSS, and semantic HTML while removing general-agent choreography from the critical path.

### 4. Reduce prompt and payload cost

- Avoid injecting overlapping deck guidance when the compact craft bundle is already present.
- Reduce tool-schema descriptions and duplicated completion instructions.
- Require shared CSS classes and smaller slide bodies by default, not only as maximum validation limits.
- Benchmark and set a target serialized payload for four- and six-slide decks that reliably completes inside the reserved stream window.
- Consider a presentation-specific low-latency model configuration with no extended reasoning for the forced serialization call, after quality benchmarking.

Do not solve this by reintroducing deterministic template fallback or accepting partial decks.

### 5. Preserve the working hard cancellation and improve its telemetry

Keep the absolute timeout. Add safe fields for:

- authoring call start time;
- time reserved for the call;
- prompt-token count at call start;
- streamed output bytes/tokens before cancellation;
- whether a tool-use block had begun;
- cancellation and provider-close completion.

The cancelled LangSmith LLM spans currently remain open with `end=None` and zero tokens. Explicitly close or patch cancelled spans so traces do not contain ghost in-progress calls.

### 6. Attach completion to the actual LangSmith builder root

Seed the concrete builder run/trace ID into state at graph start and use that ID directly for terminal metadata, tags, and feedback. Do not depend solely on the transient `RunTree.parent_run` object chain.

Add a production-shaped test proving that:

- the `Sophia Builder` root receives `builder_terminal:timed_out`;
- root metadata contains `terminal_reason=deck_authoring_deadline_exceeded`;
- root feedback score is failing;
- the child `after_model` span is not misidentified as the root;
- the logged `builder_run_id` is non-null and equals the trace ID.

### 7. Complete the operational migration

Apply `2026_07_11_sophia_build_foundation.sql` before the next application deployment. Verify the event table and RPC using the production service role, then require `build_event_store_status=available` in readiness and canary acceptance.

### 8. Remove schema warning noise

Rename or alias the model field currently exposed as `register` so the Pydantic model does not shadow `BaseModel.register`. Keep the public JSON name stable through an alias if compatibility requires it.

## Test and Acceptance Strategy

Add production-shaped regressions that assert successful progress, not only truthful failure:

1. A slow model plus one preflight action must enter `prepare_deck_build` before 120 seconds.
2. A model that starts a large response before the latch must be interrupted and immediately re-invoked with forced prepare while sufficient time remains.
3. Fresh PPTX traces must not call todo, shell, write/replace, or redundant skill reads before prepare.
4. Four- and six-slide payload fixtures must fit the selected prompt, token, and wall-clock envelope.
5. Every emitted prepare call must have one real ToolNode execution and one matching result.
6. Gateway, task resolver, companion wakeup, and LangSmith root must report the same terminal status and reason.
7. Event persistence must be available before canaries begin.

Post-deploy acceptance should require two six-slide canaries and one four-slide canary to:

- emit prepare no later than turn 2 and within 120 seconds;
- retain at least 360 seconds for service execution;
- finish within eight minutes;
- have zero dangling prepare calls;
- produce no fallback or partial-success artifacts;
- retain identical status before and after `check_async_task`;
- attach terminal metadata and feedback to the actual builder root;
- persist build events successfully.

## Conclusion

The current release is safer but not yet viable for presentation authoring. It now stops exactly at 120 seconds and reports the failure honestly, which fixes the earlier late/truncated behavior. But it still permits a general-agent preflight and an unforced, high-volume deck response to consume that same fixed window. Because the clock force and cancellation share the 120-second boundary, the runtime cannot recover once an authoring stream is in flight.

The next patch should not relax quality or add a fallback. It should make the first large presentation response a dedicated, forced `prepare_deck_build` call with a real reserved authoring window, then let the existing deterministic service, bounded repair, and eight-minute total deadline do their jobs.

## Remediation Implemented

The branch now implements the recommended recovery while retaining model-owned compact HTML and strict failure semantics:

- presentation execution uses explicit preflight, authoring, prepare, and terminal phases;
- research is limited to one eight-second fetch/search preflight and explicit research opt-out is preserved;
- the next model call is forced to `prepare_deck_build` with no general builder tools available;
- the prepare latch defaults to turn 2/eight seconds, independently of the 120-second hard authoring deadline;
- the forced request carries only the task brief, bounded attachment/memory context, compact craft contract, and bounded preflight result;
- prompt, schema, output, timing, force, phase, and prepare-counter diagnostics propagate through completion events;
- concrete build/run identity selects the LangSmith root, and canceled model descendants are explicitly closed;
- the internal deck register field no longer shadows Pydantic while the public `register` JSON name remains stable;
- the additive build-foundation migration is transactional, idempotent, service-role-only, and reloads the PostgREST schema.

Verification completed on the implementation worktree:

- focused deck/runtime suite: 290 passed;
- builder/gateway sweep: 314 passed;
- complete backend suite: 3,552 passed, 92 environment-dependent skips;
- Ruff on all changed Python files: passed;
- Sentrux regression gate: passed with no increase in complexity, cycles, coupling, or god files;
- Sentrux absolute check: retains the repository's existing architectural baseline violations and introduces no regression-gate degradation;
- diff credential scan: no API keys, authorization values, or bot tokens found.

Application deployment and post-deploy presentation canaries remain deliberately outside this code delivery. The production database migration is applied as a separate authenticated operation before the next application release, followed by readiness verification and process restart to clear the event-store circuit breaker.
