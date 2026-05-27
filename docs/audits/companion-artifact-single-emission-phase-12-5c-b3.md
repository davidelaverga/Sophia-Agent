# Companion Artifact Single-Emission Stability - Phase 12.5C-B3

Date: 2026-05-22
Status: Implemented, focused tests passing

## Scope

Phase 12.5C-B3 stabilizes the simple Gemini companion artifact path after the B2 Builder-routing fix. The target behavior is:

- one user request;
- one `emit_artifact` call;
- one successful `toolResponse` client action;
- one public `sophia.artifact` event;
- no Builder;
- no repeated artifact attempts from the same function-call id;
- no repeated spoken completion phrase.

This phase intentionally does not change the artifact schema, add an artifact-orientation bridge, change default provider routing, tune VAD/activity detection, add memory writeback, change Builder storage/UI, add web tools, replay checkpointer history, or touch runtime `users/**` data.

## Smoke Root Cause

The latest B2 smoke showed the important routing improvement first: `builderToolCallCount: 0`. The remaining instability was a Gemini Live tool-loop stability problem: `artifactToolCallCount: 4`, `artifactCount: 1`, `toolCallCancellationCount: 3`, `interruptionCount: 3`, and `playbackFlushCount: 3`.

The most likely cause was a cancellation/retry storm around `emit_artifact`. Gemini produced artifact function calls, then cancelled earlier call ids during interruption/barge-in before the browser could send `toolResponse`. The browser correctly suppressed stale send-back for cancelled call ids, but the backend relay had a separate public artifact side effect: the raw Gemini mapper could turn `emit_artifact` function-call arguments into public `sophia.artifact` before backend execution and before cancellation filtering.

That means cancellation safety and public artifact emission were not tied to the same success boundary. B3 makes them share one boundary: a public companion artifact is emitted only from a validated, backend-executed, non-cancelled, respondable `emit_artifact` call.

The repeated spoken phrasing had a second prompt-policy contributor. Even after B2 said short reflection artifacts belong to `emit_artifact`, Gemini could still interpret an artifact functionality request as a request to ask the user for a reflection topic. B3 now says artifact functionality tests should be satisfied directly with a minimal valid companion artifact and a short completion acknowledgement.

## Part A Answers

1. Why did `artifactToolCallCount` exceed one?
   Gemini likely retried after cancelled tool calls. The three cancellations match the interruption/playback flush count, so the repeated attempts were probably not Builder routing; they were Live cancellation/retry behavior plus unclear artifact-test policy.

2. Did the earlier cancelled calls return usable `toolResponse` payloads?
   No. The existing browser ledger suppresses send-back when Gemini sends `toolCallCancellation` before the browser sends `toolResponse`. B3 preserves that rule.

3. Did a cancelled call ever create a public artifact?
   The old relay could emit public artifacts from raw provider function-call args before backend execution. The latest smoke happened to report only one public artifact, but the code boundary was too early and could leak artifacts from stale calls. B3 moves public artifact emission to post-execution cancellation filtering.

4. Which call created the visible artifact?
   It was the one non-cancelled, successful final `emit_artifact` call. The reported final content appeared tied to the later recall/validation phrasing rather than a clean single-shot artifact test, so it was not a stable proof of the original request.

5. Was Builder still involved?
   Not in the latest smoke. B2 fixed the routing class. B3 keeps the Builder boundary intact and focuses on single-emission stability inside the companion artifact path.

6. Why did Sophia repeat spoken completion phrasing?
   The Gemini spoken policy had generic stop guidance but no artifact-test-specific rule. B3 adds a direct artifact-test instruction and says to stop after one `emit_artifact` call without repeating the same spoken sentence.

## Implementation

Model-facing policy:

- `emit_artifact` declarations now say short reflection or artifact-functionality requests should be satisfied directly with `emit_artifact`, without asking for a reflective follow-up question first.
- The voice artifact prompt says a short reflection artifact is not a reflective follow-up prompt, and that artifact tests should use a brief acknowledgement such as `Done - I created a short reflection artifact.`
- Gemini's spoken-turn overlay now includes the same direct artifact-test policy and one-new-artifact rule for `again` / `new one` / `another artifact` after completion.

Relay stability:

- `GeminiDogfoodToolExecution` now carries `public_artifact` for validated `emit_artifact` execution.
- `GeminiBrowserDogfoodSessionManager` strips `emit_artifact` calls from the raw provider mapper path so raw Gemini `toolCall` args no longer create public `sophia.artifact` directly.
- Public `sophia.artifact` is published only after backend validation/execution and only for respondable executions whose call id was not cancelled.
- Completed and public artifact call ids are tracked per session so duplicate relay delivery of the same function-call id does not create another backend side effect, another tool response, or another public artifact.

Diagnostics added to the compact Gemini relay payload:

- `artifact_emission_attempt_count`
- `artifact_emission_completed_count`
- `artifact_emission_cancelled_count`
- `artifact_duplicate_suppressed_count`
- `artifact_cancelled_before_backend_execution`
- `artifact_cancelled_after_backend_execution`
- `artifact_public_event_emitted_count`
- `artifact_tool_response_prepared_count`

## Validation

Focused automated validation:

```bash
python -m pytest voice/tests/test_gemini_browser_dogfood.py -q
```

Result: `30 passed, 5 warnings`.

The updated tests cover:

- successful `emit_artifact` creates exactly one public `sophia.artifact` and one Gemini `toolResponse` action;
- already-cancelled `emit_artifact` creates no client action and no public artifact;
- in-flight-cancelled `emit_artifact` records `completed_after_cancellation` but creates no client action and no public artifact;
- duplicate relay delivery of the same `emit_artifact` call id suppresses duplicate side effects, duplicate tool response, and duplicate public artifact;
- prompt/declaration text contains direct artifact-test guidance and the companion artifact vs Builder boundary.

## Next Smoke Criteria

A clean B3 Gemini smoke for `create/test a short reflection artifact` should show:

- `builderToolCallCount: 0`;
- `artifact_emission_attempt_count: 1`;
- `artifact_emission_completed_count: 1`;
- `artifact_tool_response_prepared_count: 1`;
- `artifact_public_event_emitted_count: 1`;
- `artifact_emission_cancelled_count: 0` in the no-interruption case;
- exactly one public `sophia.artifact`;
- no repeated spoken completion phrase.

If the user interrupts mid-tool-call, a healthy interrupted run may show `artifact_emission_cancelled_count > 0`, but cancelled calls should not send stale `toolResponse` client actions or publish public artifacts. The next non-cancelled artifact request can still create exactly one new artifact.

## B4 Follow-Up

Phase 12.5C-B4 reconciles a later smoke where `emit_artifact` execution succeeded and the UI rendered a companion artifact, but exported telemetry still reported `artifactCount: 0` / `counts.artifacts: 0`. B4 keeps this B3 emission boundary intact and fixes frontend/report counting so canonical rendered artifact state is counted separately from raw tool calls.