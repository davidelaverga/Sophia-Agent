# Phase 12.5C-B - Artifact Visibility Proof Harness

Date: 2026-05-22
Status: implemented proof helpers, focused tests, and manual smoke plan; no runtime behavior change
Source branch: `chore/commit-realtime-migration-stack`
Working branch: `test/artifact-visibility-proof-harness-phase-12-5c-b`

## Why This Phase Exists

Phase 12.5C chose the realtime context strategy: session seed plus native provider conversation plus tools, with the latest artifact treated as current-session meta-orientation. It explicitly deferred any compact artifact orientation bridge until provider behavior was proven.

This phase answers the narrow pre-bridge question: where does prior `emit_artifact` content exist today for Gemini Live and GPT Realtime/OpenAI Realtime?

Follow-up note from Phase 12.5C-B2: the first live Gemini smoke was inconclusive because the model routed a short reflection artifact request into Builder and the attempted `emit_artifact` response was cancelled/suppressed before `toolResponse` send-back. The visibility proof should be retried only after a simple reflection-artifact request produces `artifactCount > 0` with no Builder invocation.

Non-goals preserved: no compact artifact bridge, no 15-field schema migration, no artifact schema changes, no Gemini/GPT default routing changes, no VAD/turn-detection changes, no `consult_skill`, no ritual tools, no memory writeback, no Builder storage/UI changes, no web tools, no full checkpointer replay, no full conversation history injection, no system prompt rewrite, no `users/**` or `backend/users/**` edits, and no `voice/sophia_llm.py` or `vision_agents`-blocked slice changes.

## Proof Scenario

The deterministic probe uses artifact values that should be impossible to guess from normal conversation:

- `session_goal`: `artifact_visibility_probe_session_goal_alpha_7291`
- `takeaway`: `artifact_visibility_probe_takeaway_blue_lantern_4832`
- `next_step`: `artifact_visibility_probe_next_step_copper_bridge_9157`
- `reflection`: `artifact_visibility_probe_reflection_silver_orbit_6204`

The next user probe is:

```text
Without guessing, what was your previous internal takeaway?
```

The probe value is intentionally not spoken in the assistant transcript. In tests it appears only in function-call arguments, synthetic tool/function output payloads, and public artifact payloads depending on the variant.

The classifier treats an answer as visible only if it contains the exact distinctive takeaway, `artifact_visibility_probe_takeaway_blue_lantern_4832`. Non-empty answers without that value classify as not visible; empty/missing answers classify as inconclusive.

## Harness Added

Added `voice/realtime/artifact_visibility.py` with:

- deterministic probe payload construction;
- exact-answer visibility classification;
- public-artifact-event visibility classification;
- compact fingerprint diagnostics for tool-call args and tool/function responses;
- recursive probe detection for synthetic provider fixtures.

Diagnostics are compact and fingerprinted. They do not include raw artifact field values. The exact probe values appear only in synthetic fixtures and assertions.

## Gemini Findings

### Variant 1 - Function-call args

Code-path result: code-path ready, live proof missing.

Evidence:

- `GeminiLiveEventMapper` maps `toolCall.functionCalls[].args` into `ProviderEventType.TOOL_CALL_REQUESTED`.
- For `emit_artifact`, the same function-call args also produce `ProviderEventType.ARTIFACT_PAYLOAD`.
- `SophiaEventNormalizer` emits public `sophia.artifact` from that artifact payload.
- The distinctive probe values are present in the model-authored function-call arguments and in the public artifact payload.

What this proves: backend/provider-event observation receives the function-call args and the public UI/event path receives the artifact.

What this does not prove: whether Gemini Live attends to its own prior function-call arguments on the next user turn. That still requires live manual smoke because a mapper fixture cannot prove model attention.

### Variant 2 - toolResponse

Current production-ish `emit_artifact` toolResponse result: current `emit_artifact` toolResponse does not contain enough orientation.

Evidence:

- `GeminiDogfoodToolExecutor` executes `emit_artifact` and returns `artifact_recorded`, `artifact_keys`, session/runtime/provider metadata, and result summary.
- The distinctive `takeaway`, `session_goal`, `next_step`, and `reflection` values are not present in that current toolResponse.

Test-only toolResponse path: code-path ready, live proof missing.

Evidence:

- `GeminiLiveProviderSession.send_tool_result()` sends an official Live API `toolResponse.functionResponses[]` payload.
- A synthetic diagnostic response containing only the distinctive takeaway is sent over the provider client-message path in the fixture.

What this proves: Gemini can be sent a toolResponse carrying compact orientation if a future bridge chooses that route.

What this does not prove: whether Gemini will attend to that toolResponse on the next turn in a real Live session.

### Variant 3 - public `sophia.artifact`

Result: proven not provider context by current architecture.

Evidence:

- Public `sophia.artifact` is produced by `SophiaEventNormalizer` after provider events enter the backend/public event boundary.
- The browser sends provider-visible content back to Gemini only through returned `client_actions[].type == "gemini_tool_response"` payloads, not through public `sophia.*` events.
- A public artifact event with zero provider sends after it classifies as `proven_not_visible` for provider model context.

## GPT Realtime / OpenAI Findings

### Variant 1 - function-call args

Code-path result: code-path ready, live proof missing.

Evidence:

- `OpenAIRealtimeEventMapper` maps `response.function_call_arguments.done` for `emit_artifact` into `ProviderEventType.TOOL_CALL_REQUESTED`.
- The same function-call arguments produce `ProviderEventType.ARTIFACT_PAYLOAD` and public `sophia.artifact`.
- The distinctive probe values are present in the function-call arguments and public artifact payload.

What this proves: adapter observation preserves the model-authored artifact arguments.

What this does not prove: whether a live GPT Realtime model will use those prior function-call arguments on the next turn in the current Sophia dogfood route.

### Variant 2 - `function_call_output`

Code-path result: code-path ready, live proof missing.

Evidence:

- `OpenAIRealtimeProviderSession.send_tool_result()` sends `conversation.item.create` with `item.type == "function_call_output"`, the matching `call_id`, and JSON output.
- It immediately follows with `response.create`.
- `OpenAIRealtimeEventMapper` maps observed `conversation.item.created` `function_call_output` items into `ProviderEventType.TOOL_RESULT_RECEIVED`.
- The synthetic distinctive takeaway survives in the `function_call_output` JSON fixture.

What this proves: the adapter sends and observes the correct provider conversation item shape for tool/function output.

What this does not prove: whether a live GPT Realtime model uses that function output on the next turn in Sophia.

### Variant 3 - injected item support

Result: partial code-path support; no orientation bridge implemented.

Evidence:

- `OpenAIRealtimeProviderSession.send_text()` already sends `conversation.item.create` user message items and then `response.create`.
- `send_tool_result()` sends `conversation.item.create` function output items and then `response.create`.

This proves the adapter can emit conversation item creation events. It does not add a compact orientation/reseed item helper, and it does not inject artifact orientation.

## Classification Matrix

| Provider | Variant | Classification | Notes |
|---|---|---|---|
| Gemini Live | Function-call args | Code-path ready but live proof missing | Args are observable and become public artifact; next-turn model attention unproven. |
| Gemini Live | Current `emit_artifact` toolResponse | Not enough orientation content | Current response has status/keys, not the artifact values. |
| Gemini Live | Test-only toolResponse with probe | Code-path ready but live proof missing | ToolResponse can carry probe output; live attention unproven. |
| Gemini Live | Public `sophia.artifact` | Proven not visible as provider context | Public event is UI/telemetry state unless explicitly sent back to provider. |
| GPT Realtime | Function-call args | Code-path ready but live proof missing | Args are observable and become public artifact; live next-turn attention unproven. |
| GPT Realtime | `function_call_output` | Code-path ready but live proof missing | Adapter sends/observes correct item shape; live attention unproven. |
| GPT Realtime | Injected item support | Partial code-path support | `conversation.item.create` exists for user/function-output items; no bridge helper added. |

## Tests Added

Added `voice/tests/test_artifact_visibility_proof.py` covering:

- deterministic probe and exact-answer classifier;
- missing/empty answer does not false-positive visibility;
- public artifact event alone classifies as not provider-visible context;
- Gemini function-call args carry the distinctive artifact and public artifact event is emitted;
- current Gemini `emit_artifact` toolResponse does not contain the distinctive orientation fields;
- Gemini `toolResponse` path can carry a test-only distinctive output;
- OpenAI function-call args carry the distinctive artifact and public artifact event is emitted;
- OpenAI `send_tool_result()` sends `conversation.item.create` `function_call_output`, follows with `response.create`, and mapper recognizes the output item;
- OpenAI `conversation.item.create` user-message path exists without adding an orientation bridge.

Focused test result:

```powershell
$env:PYTHONPATH='.'; uv run pytest voice/tests/test_artifact_visibility_proof.py
# 6 passed
```

## Manual Smoke Plan - Gemini Live

1. Start a Gemini Live session from the debug or production candidate surface with telemetry export enabled.
2. Ensure `emit_artifact` is declared in setup and tool loop diagnostics are visible.
3. Ask Sophia for a short reflection that should produce an artifact.
4. Use a known distinctive internal artifact value in a controlled dogfood prompt or fixture. Do not let Sophia speak the distinctive `takeaway` value in normal transcript text.
5. Confirm the UI/public stream receives `sophia.artifact` with the distinctive `takeaway`.
6. Confirm the relay/tool-loop evidence includes the `toolCall` args fingerprint, backend execution, and browser `toolResponse` send.
7. Next user turn: `Without guessing, what was your previous internal takeaway?`
8. Classify the answer:
   - exact `blue_lantern_4832` takeaway present: function-call args and/or provider conversation are likely visible;
   - no exact value, guessing, or says it cannot see it: not proven visible;
   - ambiguous paraphrase without exact value: inconclusive.
9. Export telemetry and preserve provider receive sequence, tool-call id, toolResponse send evidence, public artifact event, and answer transcript.

## Manual Smoke Plan - GPT Realtime / OpenAI

1. Start a GPT Realtime/OpenAI dogfood session if the route is available and tool execution is attached.
2. Trigger an `emit_artifact` call with the distinctive probe artifact while keeping the probe value out of spoken assistant text.
3. Inspect provider events for `response.function_call_arguments.done` and/or response output function-call item carrying the artifact args.
4. Inspect tool execution for `conversation.item.create` with `item.type == "function_call_output"` and the matching `call_id`.
5. Next user turn: `Without guessing, what was your previous internal takeaway?`
6. Classify by exact takeaway match.
7. If the OpenAI dogfood route still lacks full Sophia tool execution, record this as code-path ready but live proof missing rather than claiming provider visibility.

## Recommendation For 12.5C-C

Do not implement a provider-agnostic artifact bridge yet solely from this phase. The current automated proof establishes code paths and boundaries, not live model attention.

Recommended next step: run the Gemini manual smoke first because Gemini is the production-wired path and the current `emit_artifact` toolResponse does not contain orientation values. If Gemini cannot answer from its prior function-call args, 12.5C-C should implement a compact latest-artifact orientation bridge for Gemini, likely through an intentionally bounded provider-visible path rather than public `sophia.artifact`.

For GPT Realtime/OpenAI, wait for live dogfood evidence unless the product route needs reconnect/reseed earlier. The adapter is prepared for `function_call_output` and `conversation.item.create`, but the route is not yet enough evidence to skip the smoke.

Provider-agnostic compact orientation remains the fallback if both providers fail or if maintaining provider-specific behavior becomes too costly. Do not wait for the 15-field artifact schema migration to answer the current 13-field visibility question; this proof can be repeated after schema migration.

## Most Important Next-Prompt Context

Phase 12.5C-B added proof helpers and tests only. Runtime behavior is unchanged. Gemini current `emit_artifact` toolResponse carries status and keys, not artifact orientation values, so Gemini can only use the full prior artifact today if Live retains and attends to the model-authored function-call args. Public `sophia.artifact` is not model context. OpenAI code paths for function-call args and `function_call_output` are ready, but live next-turn model attention remains unproven.