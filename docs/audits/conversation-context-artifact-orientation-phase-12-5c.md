# Phase 12.5C - Conversation Context And Artifact Orientation Design

Date: 2026-05-22
Status: design, audit, and implementation planning only; docs-only
Source branch: `fix/memory-attribution-tree-cleanup-phase-12-5b-e`
Working branch: `audit/conversation-context-artifact-orientation-phase-12-5c`
Audience: Davide, Luis, Jorge, and the Sophia voice/runtime team

## Why This Phase Exists

Phases 12.5B-B through 12.5B-E stabilized the realtime memory read path: `retrieve_memories(query)` is query-only, provider-safe, status-specific, privacy-minimized, and clearer about stored memory versus setup context versus current-session knowledge. That makes the next context question unavoidable: what replaces the text companion's checkpointer and middleware context when Sophia is running inside a native realtime provider?

The answer is not one mechanism. Text companion continuity is a bundle: message history, LangGraph state, middleware-injected identity/handoff/memory/tone/skill/ritual blocks, previous artifacts, builder task state, tool results, summarization, and offline writeback. Native realtime should not clone that bundle into every audio turn. This phase separates which parts are replaced by provider-native conversation, which parts belong in the session seed, which parts are tools, which parts are sideband/offline only, and how the previous artifact should orient the next turn.

This phase intentionally does not implement runtime changes, change provider routing, tune VAD/turn detection, change artifact schema, migrate to the future 15-field artifact, add `consult_skill`, add ritual tools, add memory writeback, change Builder storage/UI, add web tools, rewrite the full system prompt, inject full conversation history into realtime prompts, clone the text companion checkpointer path, commit, or push.

## Evidence Base

Specs reviewed:

- `specs/sophia_voice_context_engineering_spec_v1.md`
- `specs/sophia_artifact_traces_architecture_v1.md`
- `specs/sophia_voice_runtime_and_tools_spec_v1.md`
- `specs/sophia_voice_system_prompt_spec_v1.md`

Recent audit docs reviewed:

- `docs/audits/sophia-voice-spec-alignment-phase-12-5b-a.md`
- `docs/audits/realtime-context-value-decision-phase-12-5a.md`
- `docs/audits/realtime-retrieve-memories-tool-phase-12-5b-b.md`
- `docs/audits/realtime-memory-tool-availability-phase-12-5b-c.md`
- `docs/audits/realtime-memory-routing-epistemic-honesty-phase-12-5b-d.md`
- `docs/audits/memory-attribution-tree-cleanup-phase-12-5b-e.md`
- `docs/architecture/sophia-realtime-runtime-contract.md`
- `docs/common-pitfalls.md`
- `COMPOUND_LOG.md`

Code areas reviewed:

- Text companion and state: `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`, `state.py`, artifact, memory, session, identity, platform, tone, skill, ritual, build-awareness, and prompt-assembly middlewares.
- Offline continuity producers: `backend/packages/harness/deerflow/sophia/offline_pipeline.py`, `handoffs.py`, `identity.py`, and smart-opener prompt inputs.
- Gemini realtime: `voice/realtime/gemini_live.py`, `gemini_browser_dogfood.py`, `gemini_production_session.py`, `gemini_tool_loop.py`, `gemini_memory_context.py`, `sophia_prompt.py`, and `normalizer.py`.
- OpenAI/GPT realtime: `voice/realtime/openai_realtime.py`, `openai_browser_dogfood.py`, and provider declaration helpers.
- Artifacts and UI: `emit_artifact_contract.py`, `emit_artifact.py`, `middlewares/artifact.py`, frontend artifact adapters, Presence artifact surfaces, telemetry export paths, and builder lifecycle contracts.

## Executive Recommendation

Realtime Sophia should use this hierarchy:

1. Current user turn and native provider conversation are the highest-priority live context.
2. Session seed supplies compact cross-session orientation at connection start.
3. Tools supply slower or deeper context on explicit need.
4. The latest artifact supplies current-session meta-orientation, bounded to one compact summary.
5. Handoff and Mem0 remain cross-session continuity, not a substitute for current intent.
6. Offline pipeline owns memory writeback, recap, identity update, and durable learning.

Do not replay the text companion checkpointer path per turn. Do not inject full conversation history or full artifact history. Treat GPT Realtime and Gemini Live differently until direct proof shows equivalent artifact visibility.

Recommended next implementation phase: **12.5C-B - Artifact Visibility Proof Harness**. Prove, provider by provider, whether a prior `emit_artifact` function call and/or tool response is actually model-usable on the next turn before building an orientation bridge.

## Part A - Text Companion Context Map

The text companion does not merely provide "history." It provides a layered state machine around every turn.

| Context item | Text companion source | Purpose | Needed in realtime? | Replacement strategy |
|---|---|---|---|---|
| Conversation message history | LangGraph thread/checkpointer state through `AgentState.messages`; written by model/tool/middleware runs; read by prompt assembly, tools, and summarization. Per turn and per thread. | Gives the model prior user/assistant/tool turns and lets tool results close the loop. Affects prompt, tool choice, artifacts, and spoken response. | Yes, within a live session. | Use provider-native conversation within the connection. Do not replay full LangGraph messages into realtime. On reconnect, use a compact recap, not full history. |
| LangGraph thread state | `SophiaState` fields in `state.py` such as `platform`, `turn_count`, `active_skill`, `active_ritual`, `previous_artifact`, `async_tasks`; written/read by middlewares and tools. Per thread/session. | Carries non-message working state that middleware reads before assembling the next prompt. Affects prompt blocks, tool availability/behavior, artifacts, and builder state. | Partially. | Replace with seed, provider session context, tool backends, and small sideband caches. Do not clone the whole state object into realtime. |
| Session state/current goal | `SessionStateMiddleware`, handoff frontmatter, and artifact fields such as `session_goal`/`active_goal`; written by offline handoff and model-authored artifact. | Keeps Sophia oriented to what this session is about. Affects opener, prompt, artifact, and spoken continuity. | Yes. | Seed with handoff/smart opener/current mode. During the session, use native conversation plus latest artifact orientation. |
| Previous artifact | `ArtifactMiddleware.after_model` moves `current_artifact` to `previous_artifact`; `before_agent` conditionally injects it when tone delta or skill risk warrants. Per turn/thread. | Carries Sophia's last meta-assessment: tone, target, skill, ritual phase, session goal, active goal, next step, takeaway, reflection. Affects prompt, skill routing, tone guidance, artifacts, and sometimes spoken response. | Yes, but bounded. | Use latest artifact only. GPT may get it natively through function-call conversation items if proven. Gemini needs proof; if absent, add a compact bridge later. Re-inject on reconnect/reseed only unless tests prove per-turn injection is required. |
| Previous tone estimate | `previous_artifact.tone_estimate` and `tone_target`; read by `ToneGuidanceMiddleware`, `SkillRouterMiddleware`, and artifact injection logic. Per turn. | Calibrates the next turn's emotional posture and active tone band. | Yes. | Carry tone in compact latest-artifact orientation. Do not inject the full tone framework per turn. |
| Previous session handoff | `users/{user_id}/handoffs/latest.md`; written by `offline_pipeline`; read by `SessionStateMiddleware` and Gemini setup context. Cross-session. | Provides short continuity and smart opener context from the prior completed session. Affects first-turn prompt and spoken opening. | Yes. | Include bounded handoff excerpt in session seed and reconnect reseed. Never accumulate handoff history in prompt. |
| Identity/profile | `users/{user_id}/identity.md` plus canonical skill files; written by offline identity update, read by `UserIdentityMiddleware`, file injection, and Gemini setup. Cross-session. | Stable user facts, preferences, and relationship context. Affects prompt and spoken personalization. | Yes. | Include a bounded identity excerpt/preferred name in seed. Do not dump full profile if not needed. |
| Mem0 retrieval | `Mem0MemoryMiddleware` per-turn search and `retrieve_memories` tool; Mem0 writes happen offline. | Brings relevant durable memories into context. Affects prompt, builder enrichment, and memory answers. | Yes, but not per-turn blocking. | Use setup seed memories plus `retrieve_memories(query)` for explicit recall. Keep writes offline. |
| Tool results | Tool messages in LangGraph message history; builder/memory/artifact tools also update state. Per turn/thread. | Lets the model consume backend results and produce final responses; closes structured tool calls. | Yes. | Use provider-native function outputs/tool responses. For Gemini, ensure browser sends backend `toolResponse`. For GPT, use `function_call_output` items. |
| Builder async task state | `async_tasks` state reducer, deepagents async-subagent middleware, `BuildAwarenessMiddleware`, builder lifecycle tools. Per thread with terminal fade. | Lets Sophia launch, check, update, cancel, list, and summarize builds. Affects prompt and builder tools. | Yes, selectively. | Seed active task one-line summary; use lifecycle tools on cue. Do not push full builder state every turn. `latest_artifact_summary` remains later work. |
| Active skill, ritual, context mode | Runtime configurable values, `ToneGuidanceMiddleware`, `ContextAdaptationMiddleware`, `RitualMiddleware`, `SkillRouterMiddleware`. Per turn/session. | Selects tone file section, context file, ritual file, active skill guidance, and memory categories. Affects prompt, artifacts, and spoken posture. | Partially. | Include selected platform/context/ritual in seed/setup. Defer `consult_skill` and ritual tools. Avoid deterministic per-turn SkillRouter clone in realtime. |
| Recap/summarized state | `SophiaSummarizationMiddleware`, offline recap/session files, handoff generation. Per long thread and cross-session. | Keeps long text threads usable and supports recap UI/offline continuity. | Yes only for reconnect/resume. | Generate or maintain a short current-session recap sideband for reconnect. Do not summarize every realtime turn in the hot path. |
| Offline writeback state | `offline_pipeline`, extraction, handoff, identity update, processed-session idempotence. Cross-session, after session. | Turns finalized transcripts/artifacts into memories, handoffs, identity updates, traces. | Yes, but sideband/offline only. | Preserve offline pipeline. Do not write Mem0 in-turn. Current-session facts remain current-session only until persistence. |
| Transient flags and diagnostics | `force_skill`, `skip_expensive`, `injected_memories`, diagnostic events, tool ledgers. Per turn/session. | Fast-path crisis, skip expensive context, aid debugging, track what was injected. | Selectively. | Safety flags need their own realtime safety design. Diagnostics stay outside prompt and privacy-minimized. Most transient flags are excluded from realtime context. |

Conclusion: realtime should replace text-companion context by function, not by internal shape. Message history becomes native provider conversation; identity/handoff/memory become seed; deeper memory and builder become tools; artifacts become latest compact orientation; durable learning stays offline.

## Part B - GPT Realtime Context Mechanics

Davide's context spec describes GPT Realtime as a stateful server-side default conversation. Under that model, the provider conversation can include user transcription items, assistant response items, function calls, function outputs, and injected items. This is the cleanest match for artifact-trail architecture.

Current repo evidence:

- `OpenAIRealtimeProviderSession.configure()` sends `session.update`.
- `send_text()` sends a user `conversation.item.create`, then `response.create`.
- `send_tool_result()` sends `conversation.item.create` with `item.type = function_call_output`, then `response.create`.
- The mapper observes `conversation.item.created` and recognizes `function_call_output` items as tool results.
- OpenAI browser dogfood currently declares a basic `emit_artifact` function, but there is no complete OpenAI product tool-execution bridge equivalent to Gemini's relay. The query-only memory declaration exists for a later phase but is not advertised/executed in a live OpenAI route.

Answers:

| Question | Current answer |
|---|---|
| Does default conversation include user transcription items? | The GPT spec says yes. Current adapter maps OpenAI user transcription events and can inject text items. Product proof still requires a live session harness. |
| Assistant response items? | The spec says yes; current mapper handles text/audio transcript deltas and response lifecycle events. |
| Function calls? | The spec says yes; current mapper maps function call argument events and can surface tool-call requests. |
| Function outputs? | Supported by adapter through `function_call_output` via `conversation.item.create`. Whether every Sophia tool path uses it today is not proven because OpenAI execution wiring is incomplete. |
| Injected `conversation.item.create` items? | Adapter supports user text and function output item creation. Future ambient/context injection should use this sparingly and only after proof. |
| Can prior `emit_artifact` be model-visible next turn? | Likely under the GPT default-conversation design if the function call and/or output is part of the conversation, but unproven in this repo. The current OpenAI dogfood path does not yet prove artifact tool execution plus next-turn use. |
| Can ambient time or sideband context be inserted? | Mechanically yes via `conversation.item.create` or a small turn-tail item, but this is future work. |
| Can instructions be updated? | Mechanically yes via `session.update`, but mutable per-turn context in instructions risks prompt-cache churn and should not be the default. |
| What survives within a session? | Provider conversation items until truncation or session end. |
| What dies on reconnect? | The provider conversation. Reconnect starts empty and must be reseeded. |
| What must be reseeded after reconnect? | Stable prompt, preferred name, identity excerpt, handoff, top memories, latest artifact summary, active builder summary, short current-session recap, ambient time. |
| How does truncation affect old artifacts/context? | Native drop-oldest can evict older items. Use latest artifact only for reconnect/bridge; do not depend on full artifact history. |
| Prompt caching implication? | Keep stable prompt prefix stable. Put seed after the stable prefix. Put mutable time/artifact/reconnect payloads outside the cacheable prefix. |
| Risk of too much `conversation.item.create`? | Prompt bloat, stale context competing with the latest user turn, cache churn, and internal bookkeeping leaking into speech. |

GPT recommendation: rely on native conversation for within-session continuity after proof, especially function-call/tool-output context. Do not manually re-inject previous artifact every turn until a proof harness shows the provider ignores tool/function items or uses them poorly.

## Part C - Gemini Live Context Mechanics

Gemini Live is more production-wired in this repo, but it is not a GPT default-conversation clone.

Current repo evidence:

- `GeminiLiveProviderSession.configure()` sends setup once and raises if setup is sent again on an open connection.
- Gemini production setup builds instructions once with `build_gemini_live_realtime_instructions_with_memory_context()`.
- Gemini setup includes canonical Sophia prompt sources, bounded authenticated user context, handoff excerpt, up to four Mem0 snippets, and Gemini-specific spoken-turn policy.
- Gemini tool loop executes approved Sophia backend tools and returns browser client actions containing `toolResponse.functionResponses`.
- The browser must send that `toolResponse` over the Live WebSocket; public `sophia.*` events only prove backend observation, not provider model ingestion.
- For `emit_artifact`, backend execution validates the full artifact, emits public artifact state through the normalizer path, and returns a `toolResponse` with `artifact_recorded`, `artifact_keys`, and result summary. The current tool response does not include the full artifact content; the full artifact fields live in the model-authored function call arguments and public event path.

Answers:

| Question | Current answer |
|---|---|
| Does Gemini retain provider conversation state inside the session? | It is a stateful Live session, but exact next-turn availability of function-call args/tool responses for Sophia-style artifact introspection is not proven locally. |
| Does Gemini see `toolResponse` payloads next turn? | The browser sends `toolResponse` to the provider; that is the intended model-visible return path. Whether the model uses prior tool responses as durable orientation requires live proof. |
| Does public `sophia.artifact` become model-visible? | No. Public `sophia.artifact` is observability/frontend state emitted after backend normalization; it is not automatically sent back into Gemini setup or conversation. |
| Does the browser bridge send tool responses back? | Yes. Backend returns a Gemini-compatible client action and the browser sends `toolResponse.functionResponses`. Cancellations suppress stale responses. |
| Does current artifact tool result include enough orientation? | Not by itself. It includes status and artifact keys, not the full tone/session/takeaway fields. The model may still have its own function-call args, but this must be tested. |
| If UI receives `sophia.artifact`, does Gemini know it next turn? | Not from the UI event alone. Only provider conversation/function-call/toolResponse mechanics can make it model-visible. |
| Is setup context immutable after setup? | Yes for the current Live connection. Changing prompt/tool surface means a new setup strategy or reconnect/reseed. |
| Can we inject mid-session context? | No OpenAI-style `session.update` exists in the current Gemini path. Viable routes are tool response content, provider-supported client content/realtime input if proven safe, or session restart/reseed. |
| What needs a live test? | Whether prior `emit_artifact` function-call arguments and/or the artifact tool response are usable by the model on the next turn. |

Gemini recommendation: do not assume public artifacts or frontend telemetry are context. Prove artifact visibility through tool-call/toolResponse semantics. If it fails, design a compact artifact orientation bridge that is short, internal, and non-spoken.

## Part D - Artifact Orientation Design

Artifact orientation means Sophia uses her previous turn's meta-assessment to calibrate the next turn. It is not durable memory and it is not a transcript recap.

Orientation-critical fields in the current 13-field schema:

- `tone_estimate`
- `active_tone_band`
- `tone_target`
- `session_goal`
- `active_goal`
- `next_step`
- `takeaway`
- `reflection` when present
- `skill_loaded`
- `ritual_phase`

Future 15-field migration will add `previous_turn_reflection` and `lesson`, but this phase does not migrate the schema. Those fields should later strengthen the prediction/reflection loop after a separate compatibility phase.

Recommended policy:

| Decision | Policy |
|---|---|
| Full artifact or compact summary? | Use a compact latest-artifact orientation summary. Full artifact history is too much and grows stale. |
| How many artifacts? | One: the latest valid companion artifact. Optionally one short rolling recap on reconnect. |
| Where should it live? | GPT: native function-call/tool-output conversation if proven; reconnect seed otherwise. Gemini: prove function-call/toolResponse visibility; if missing, add a compact bridge later. UI/backend retain full artifact for product/telemetry. |
| Should it be spoken? | No. It is internal orientation. Prompt/bridge wording must explicitly say not to mention artifact fields, tone estimates, or bookkeeping. |
| Priority order | Latest user turn and current transcript outrank artifact orientation. Artifact orientation outranks stale handoff but not explicit user correction. Mem0 outranks artifact only for durable facts. |
| Staleness guard | Latest artifact only, tied to current session/connection and updated only after a valid `emit_artifact`. Ignore missing/cancelled/invalid artifacts rather than inventing one. |
| Missing artifact | Continue from native conversation and seed. Do not ask the model to reflect on a nonexistent previous artifact. Diagnostics should record absence. |
| Memory interaction | Artifact = current-session meta-orientation. Mem0 = durable cross-session memory. Handoff = cross-session summary. Transcript = immediate intent. |
| Builder interaction | Builder lifecycle remains tool-driven. `check_async_task.latest_artifact_summary` is later work and should be translated into plain user-facing language, not dumped as artifact fields. |

Suggested compact orientation shape for future implementation, not for this phase:

```text
<latest_artifact_orientation internal="true">
Previous tone: grief_fear, 1.1 -> target 1.6.
Session goal: help the user debrief the investor conversation without spiraling.
Last active goal: slow them down and name the fear beneath the anger.
Takeaway: they were most hurt by feeling unprepared despite doing the work.
Next-step hint: ask one grounded question about what they can control now.
</latest_artifact_orientation>
```

The content must be bounded, internal, and subordinate to the next user turn.

## Part E - Conversation Context Strategy Options

| Option | Assessment | Recommendation |
|---|---|---|
| 1 - Native provider conversation only | Lowest latency and cleanest within a single connection, but provider-specific and dies on reconnect. Public events are not guaranteed model context. | Use within a live session where proven, especially GPT. Not enough for reconnect. |
| 2 - Session seed + native conversation | Aligns with specs and current Gemini setup direction. Keeps latency low while restoring cross-session continuity. | Baseline v1 policy. Seed once, then rely on native conversation and tools. |
| 3 - Previous artifact compact orientation | Gives Sophia self-assessment continuity with small payload. Risk is stale internal framing or speech leakage. | Use on reconnect by default. Add mid-session only if provider proof shows native artifact visibility is weak. |
| 4 - Short rolling conversation recap | Useful across reconnect and truncation; risk of summary drift and competing with current turn. | Use only for reconnect/resume or long-session recovery, not every turn. |
| 5 - Per-turn checkpointer replay | Closest to text companion but adds latency, prompt bloat, stale context, and double-agent topology. | Not recommended. |
| 6 - Sideband context cache | Provider-agnostic support for reconnect and future async injection; eventual consistency risk. | Good future v2/reconnect substrate if source-of-truth rules are tight. |

Staged approach:

1. Keep current memory-read progress: bounded seed/setup plus `retrieve_memories(query)`.
2. Prove provider artifact visibility.
3. Implement compact artifact orientation only where needed or during reconnect/reseed.
4. Add short sideband recap for reconnect/resume.
5. Defer full schema migration and builder trace work to separate phases.

## Part F - Provider-Specific Recommendation

### Provider-Agnostic Policy

- Do not replay full checkpointer context per turn.
- Use seed plus native conversation plus tools.
- Treat the latest artifact as current-session orientation, not durable memory.
- Treat Mem0 as durable cross-session memory.
- Treat handoff as cross-session summary.
- Treat the current user transcript as highest-priority immediate intent.
- Keep artifact orientation bounded and non-verbalized.
- Do not inject full artifact history.
- Keep diagnostics privacy-minimized and outside prompt text.
- Preserve offline memory writeback; do not add in-turn Mem0 writes.

### GPT Realtime

- GPT Realtime is the natural fit for the artifact-trail assumption because the provider's default conversation is expected to hold user turns, assistant turns, function calls, function outputs, and injected items.
- Use `conversation.item.create` for future ambient time or sideband context only when needed and in compact form.
- Use `session.update` for stable session configuration/tool setup, not as a per-turn mutable context dumping path.
- On reconnect, reseed with handoff, latest artifact summary, compact session recap, top memories, active builder summary, and ambient time.
- Validate that function-call arguments and `function_call_output` items are model-visible and useful for `emit_artifact` before relying on them.
- Do not manually re-inject previous artifact every turn until the proof harness shows it is necessary.

### Gemini Live

- Gemini is the most production-wired path today, but setup is effectively immutable and browser-owned WSS plus backend relay makes context mechanics different from GPT.
- Verify whether prior `emit_artifact` function-call args and/or `toolResponse` payloads are usable model context on the next turn.
- Do not treat public `sophia.artifact`, frontend Presence state, or telemetry export data as provider model context.
- If native visibility fails, design a compact artifact orientation bridge. Candidate routes are enriched toolResponse content, a later explicit orientation tool/response, or reconnect/reseed; each needs a separate implementation phase.
- Keep any bridge short, internal, and non-spoken.
- Use live telemetry and smoke scripts to prove the behavior before broad prompt changes.

## Part G - Reconnection And Reseed Strategy

GPT Realtime loses the provider default conversation on reconnect. Gemini Live loses the open Live session state and must send setup again. In both cases, continuity must be re-established by our seed/reseed payload.

Reseed should include:

- Preferred name.
- Bounded identity excerpt.
- Latest handoff excerpt.
- Top relevant stored memories, bounded and status-labeled.
- Latest valid companion artifact summary.
- Active builder task summary, if any.
- Short current-session recap, 3-6 lines, generated from finalized transcript plus latest artifact.
- Ambient time and connection/reconnect marker.

Reseed should not include:

- Full transcript.
- Full artifact history.
- Raw memory dump.
- Broad LangGraph state object.
- Diagnostics/tool ledgers.
- Internal schema bookkeeping that could leak into speech.

60-minute/provider-drop behavior:

- Detect impending cap or disconnect.
- Keep `session_id`, authenticated `user_id`, and app-side session record stable.
- Build reseed off the last confirmed public transcript/artifact/tool state.
- Start the new provider connection with stable prompt plus reseed.
- If the user notices the gap, use a simple spoken bridge: "give me one second - I'm still here." Do not over-explain provider internals.

This is design only. No reconnect implementation belongs in this phase.

## Part H - Test Plan And Future Proof Points

### Artifact Visibility Test - GPT Realtime

1. Start a GPT Realtime dogfood session with `emit_artifact` declared and executed.
2. Have the model emit an artifact with a distinctive `takeaway` and `session_goal`.
3. Next turn asks: "What was your previous takeaway about where this was heading?"
4. Verify whether the model uses the prior artifact without manual re-injection.
5. Inspect provider event evidence: function call args, function output item, and next response.

### Artifact Visibility Test - Gemini Live

1. Start a Gemini Live session with the current `emit_artifact` tool.
2. Have the model emit an artifact with a distinctive `takeaway` and `next_step`.
3. Ensure backend returns `toolResponse` and browser sends it.
4. Next turn asks: "Reflect on your previous takeaway."
5. Verify whether Gemini uses the prior function-call args/toolResponse or only native conversation text.

### Missing Artifact Test

1. Simulate a turn where artifact emission is missing, cancelled, invalid, or suppressed.
2. Next turn asks about previous orientation.
3. Expected: Sophia does not hallucinate a previous artifact; it answers from conversation or says it does not have that internal note.

### Reconnect Reseed Test

1. Start a session and build current-session context.
2. Capture latest transcript, latest artifact summary, active builder task summary, and current memory status.
3. Simulate reconnect.
4. Seed the new connection with compact reseed payload.
5. Verify continuity without full transcript replay.

### Current Versus Durable Memory Test

1. User gives a new fact during a live session.
2. Later in the same session, Sophia can refer to it as current-session context.
3. Start a new session before offline writeback.
4. Expected: Sophia does not claim the fact is stored durable memory unless Mem0 retrieval/setup seed proves it.

### Prompt-Leak Test

1. Inject compact artifact orientation in a test harness.
2. Ask a normal emotional question.
3. Expected: Sophia does not say "artifact," "tone estimate," field names, JSON, or internal schema phrases aloud.

## Part I - Recommended Next Implementation Phases

### 12.5C-B - Artifact Visibility Proof Harness

Purpose: prove whether GPT Realtime and Gemini can see prior artifact/function/tool outputs as model context.

Scope:

- Provider-specific dogfood tests/smokes.
- No schema migration.
- No artifact bridge yet.
- Capture enough provider/public evidence to separate function-call visibility from public event visibility.

### 12.5C-C - Compact Artifact Orientation Bridge, If Needed

Purpose: if Gemini or GPT cannot reliably use prior artifacts, add the smallest bridge that exposes the latest artifact summary.

Scope:

- Latest artifact summary only.
- No full artifact history.
- Non-verbalized/internal framing.
- Provider-specific implementation; Gemini likely first if proof fails.

### 12.5C-D - Reconnect Reseed Design And Implementation

Purpose: create compact reseed payload for provider reconnect and 60-minute cap handling.

Scope:

- Preferred name, identity, handoff, latest artifact, active builder summary, short session recap, ambient time.
- No full transcript replay.
- No checkpointer clone.

### Later - 15-Field Artifact Schema Migration

Purpose: implement Davide's artifact trace architecture after visibility and reseed questions are settled.

Scope:

- Backend contract.
- Provider declarations/tool responses.
- Frontend adapters and Presence/recap surfaces.
- Offline pipeline and GEPA consumers.
- Builder traces and `latest_artifact_summary`.

## Open Questions

1. In GPT Realtime live sessions, are model-authored `emit_artifact` function-call arguments and `function_call_output` items both available and useful on the next turn?
2. In Gemini Live, does the model attend to its prior function-call arguments, the backend `toolResponse`, both, or neither after the next user turn?
3. Should Gemini's `emit_artifact` tool response include a compact orientation summary later, or would that duplicate function-call args and increase leakage risk?
4. What is the acceptable artifact-visibility proof: manual smoke, provider event fixture, automated browser dogfood test, or all three?
5. Should the first reconnect recap be model-generated, deterministic from artifacts/transcript, or offline-pipeline generated during disconnect?
6. How should crisis turns reconcile older "artifact every turn" constraints with newer "crisis may skip artifact" prompt language before schema migration?

## Final Decision Table

| Decision | Recommendation | Rationale |
|---|---|---|
| Clone text checkpointer/middleware into realtime | No | It defeats realtime latency and duplicates provider-native conversation. |
| Use native provider conversation | Yes, where proven | It is the right live-session substrate, especially for GPT. |
| Treat Gemini public events as model context | No | Public `sophia.*` events are observability/UI state, not provider prompt/context. |
| Use latest artifact as orientation | Yes | It is Sophia's current-session meta-assessment. Keep it compact and latest-only. |
| Inject full artifact trail | No | Bloats context and increases stale/internal speech leakage. |
| Re-inject previous artifact every turn | Not by default | Only if proof shows native provider context is insufficient. |
| Reseed on reconnect | Yes | Provider conversation dies on reconnect; continuity is ours to restore. |
| Change runtime code now | No | This phase is design/planning only. |

## Closing Recommendation

Move next to 12.5C-B. Build the smallest proof harness that answers the artifact visibility question for GPT Realtime and Gemini Live separately. That proof determines whether artifact orientation can ride native provider conversation or needs a compact bridge. Until then, keep the policy conservative: seed once, rely on native conversation and tools, use the latest artifact only as bounded orientation, and keep durable memory in Mem0/offline pipeline.