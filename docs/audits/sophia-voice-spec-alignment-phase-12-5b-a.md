# Phase 12.5B-A - Sophia Voice Spec Alignment Audit

Date: 2026-05-21
Status: audit and implementation planning only; no runtime changes
Working branch: `audit/sophia-voice-spec-alignment-phase-12-5b-a`
Audience: Davide, Luis, Jorge, and the Sophia voice/runtime team

## Executive Summary

The new four-document Sophia Voice spec set is a meaningful architecture reset, not a small continuation of the Gemini Live parity work. The target direction is now: stable Sophia voice prompt, dynamic session seed, native provider conversation, narrow function tools, on-demand memory, and offline/sideband writeback. It should not be implemented by cloning the text companion middleware chain into Gemini Live or GPT Realtime.

The current repository is partially aligned in useful ways. Gemini Live already has a browser-owned Live session, setup-time authenticated memory context, canonical Sophia prompt assembly, Gemini-specific spoken policy, structured `emit_artifact`, builder lifecycle tool declarations, backend tool execution, and normalized `sophia.*` public events. OpenAI/GPT Realtime already has a provider adapter with `session.update`, `conversation.item.create`, function-call output, `response.create`, and `response.cancel` helpers, but it is still dogfood-level and is much less Sophia-context-complete than Gemini.

The largest gaps are clear:

- `retrieve_memories` is still a LangChain `StructuredTool` with `(query, categories)` and text-companion assumptions. It has no dependency-safe realtime contract and no query-only voice surface.
- Current companion artifacts are still 13-field Cartesia-era artifacts. The new Sophia Voice spec wants a 15-field introspection artifact and removes `voice_emotion_*` / `voice_speed` from the target GPT Realtime path.
- Current builder artifacts are final-deliverable metadata only. The artifact-traces spec wants a per-step builder trace substrate and `check_async_task.latest_artifact_summary`.
- Gemini Live cannot be treated like GPT Realtime. Gemini setup is effectively immutable after the first setup message, browser transport owns the Live socket, and public `sophia.*` events are observability, not automatically provider-visible context.
- GPT Realtime's default server conversation is the better fit for the new seed-plus-tools-plus-artifact-trail architecture, but the current repo has not yet wired the target Sophia prompt, seed, tools, or session config into a production voice path.

Recommended next implementation slice: **a narrowly scoped realtime `retrieve_memories(query)` phase**. Extract a shared dependency-safe retrieval core, expose query-only declarations to the relevant realtime provider path, bind `user_id` from trusted session context, cap output to about five memories, emit privacy-minimized diagnostics, and prove explicit-recall behavior with focused tests/manual smokes. Do not combine that with `consult_skill`, `wait_for_user`, time tools, artifact schema migration, VAD changes, default-provider changes, or builder trace storage.

## Scope And Safety

This phase intentionally does not:

- change runtime routing or make Gemini/GPT Realtime default;
- change Gemini Live production routing;
- change GPT Realtime routing;
- tune VAD or `realtimeInputConfig`;
- edit canonical Sophia prompt/skill behavior;
- modify `retrieve_memories` or add/expose tools;
- change artifact schemas;
- change builder storage/UI;
- commit or push.

The worktree was already broadly dirty and contains many pre-existing modified/untracked voice, frontend, backend, user-artifact, and docs files. This audit works with that state and does not revert unrelated changes.

## Evidence Base

Specs reviewed:

- `specs/sophia_voice_runtime_and_tools_spec_v1.md`
- `specs/sophia_voice_system_prompt_spec_v1.md`
- `specs/sophia_voice_context_engineering_spec_v1.md`
- `specs/sophia_artifact_traces_architecture_v1.md`

Current implementation areas reviewed:

- Gemini prompt/setup/tool path: `voice/realtime/sophia_prompt.py`, `gemini_memory_context.py`, `gemini_live.py`, `gemini_browser_dogfood.py`, `gemini_production_session.py`, `gemini_tool_loop.py`, `sophia_backend_tools.py`, `normalizer.py`.
- OpenAI/GPT Realtime path: `voice/realtime/openai_realtime.py`, `openai_browser_dogfood.py`.
- Sophia companion chain and state: `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`, `middlewares/mem0_memory.py`, `ritual.py`, `skill_router.py`, `artifact.py`.
- Memory and offline pipeline: `backend/packages/harness/deerflow/sophia/tools/retrieve_memories.py`, `mem0_client.py`, `offline_pipeline.py`, `handoffs.py`, `identity.py`, plus generic memory queue middleware.
- Artifact/builder contracts: `emit_artifact_contract.py`, `emit_artifact.py`, `builder_lifecycle_contract.py`, `start_builder_task.py`, `emit_builder_artifact.py`, `builder_artifact.py`.
- Prior decision docs: Phase 12.5A context decision report, Phase 12.4M Gemini memory/artifact hardening, and the realtime runtime contract.

## New Spec Overview

### Runtime And Tools Spec

The runtime target is GPT Realtime through Vision Agents over the existing WebRTC/Stream session lifecycle. The major architectural decisions are:

- Function tools only for voice, not MCP server tools.
- Native `gpt-realtime-2` audio input/output with `semantic_vad`, explicit low eagerness, no idle auto-prompt, native interruption, and retention-ratio truncation.
- Existing session endpoints and SSE broker are preserved, but the cascade LLM/STT/TTS/turn-detection/coordinator stack is cut in the target runtime.
- Tool surface expands to `consult_skill`, time/schedule tools, query-only `retrieve_memories`, web tools, builder lifecycle tools, `wait_for_user`, and a modified 15-field `emit_artifact`.
- Several invariants move from middleware-enforced to prompt-enforced in realtime, especially builder tool sequencing and artifact-after-tool discipline.

### System Prompt Spec

The prompt target is a stable cacheable prefix plus dynamic runtime seed:

- Stable blocks: `soul.md`, `voice.md`, `techniques.md`, compressed `tone_guidance.md`, plus new GPT Realtime sections for language, reasoning, channels, preambles, unclear audio, silence, tools, skills, memory, builder, and artifacts.
- Skill files load on demand through `consult_skill`, not through deterministic middleware injection.
- Artifact instructions are updated around the 15-field introspection schema.
- Mutable session seed and ambient time are deliberately outside the stable prefix.

### Context Engineering Spec

The context model changes from text companion replay/reinjection to native realtime state:

- Within a GPT Realtime session, the provider's default conversation holds user transcripts, assistant speech, function calls, function outputs, and artifacts.
- Cross-session continuity is not native; it comes from the offline pipeline and session-start seed.
- Memory read path becomes seed-once plus on-demand `retrieve_memories(query)`.
- Memory write path remains offline/session-finalization; no in-turn Mem0 writes.
- Per-turn injection is near-zero except ambient time or future out-of-band items.

### Artifact Traces Spec

The artifact target is a unified introspection substrate:

- Sophia artifact moves from 13 to 15 fields by adding `previous_turn_reflection` and `lesson`.
- Builder gains a new per-step 12-field artifact trail for observation, approach, prediction, and continuity.
- `check_async_task` should surface `latest_artifact_summary` so Sophia can describe builder progress naturally.
- Harness enforces structural timing and metadata; the model owns semantic field content.

## Current Implementation Overview

### Legacy Companion

The legacy text/voice companion path still uses the full LangGraph Sophia middleware chain. It deterministically injects identity, handoff, tone band, context mode, ritual, skill file, Mem0 memories, build awareness, artifact instructions, and builder command routing before prompt assembly. That path is closest to old cascade parity, but it is not the target topology for native realtime voice.

### Current `retrieve_memories`

`make_retrieve_memories_tool(user_id)` returns a LangChain `StructuredTool`. The model-facing schema is currently `query` plus optional `categories`. It captures `user_id` by closure, calls `deerflow.sophia.mem0_client.search_memories`, and returns up to 15 raw bullet lines or a simple unavailable/no-results string.

The current tool is useful but not realtime-ready because:

- it has no dependency-safe provider declaration module;
- it exposes categories to the model, contrary to the new query-only voice spec;
- it returns too many memories for a spoken turn;
- it is LangChain-specific and assumes text companion construction;
- it does not provide structured diagnostics for provider relay paths.

### Current Memory Read/Write

`Mem0MemoryMiddleware` performs per-turn search in the companion chain, with rule-based categories, context mode weighting, voice cache reuse, a smaller voice limit, and low-signal voice turn skips. `mem0_client.search_memories` uses a 60-second TTL cache and can filter categories after Mem0 search.

Writes are already aligned with the new principle: the offline pipeline serializes session messages, extracts memories, writes Mem0 candidates with review metadata, generates smart openers and handoffs, and conditionally updates identity. That remains the correct write path for realtime voice.

### Current Gemini Live

Gemini is the most mature realtime route candidate in this repo. It has:

- browser-owned Live WebSocket with ephemeral backend-minted auth token;
- setup-first protocol and setupComplete gate;
- authenticated backend relay for observed provider server messages;
- canonical Sophia prompt assembly plus bounded authenticated user context;
- Gemini-specific spoken turn policy overlay;
- `emit_artifact` and builder lifecycle declarations from dependency-safe contracts;
- backend tool execution and Gemini-compatible `toolResponse` client actions;
- normalized public `sophia.*` event output.

Current Gemini gaps relative to the new specs:

- no realtime `retrieve_memories` tool;
- no `consult_skill`, time/schedule, `wait_for_user`, or web tools on the Live surface;
- no 15-field Sophia artifact schema;
- no builder per-step artifact trail or `latest_artifact_summary` in lifecycle status;
- no mutable prompt/session update path during an open Live connection;
- no proof that public artifacts/events are model-visible for next-turn introspection unless carried through provider conversation/tool-response semantics.

### Current OpenAI/GPT Realtime

The OpenAI adapter has the lower-level provider pieces needed by the target direction: `session.update`, input audio append, text input, `conversation.item.create`, function-call output, `response.create`, and `response.cancel`. It also declares provider capabilities around session updates and function calls.

Current OpenAI gaps relative to the new specs:

- no production voice route using GPT Realtime as the target runtime;
- no assembled Sophia GPT system prompt from the new spec;
- no session-start seed implementation;
- no target session config values confirmed in code (`eagerness=low`, retention ratio, reasoning effort, etc.);
- no realtime Sophia tool surface registered from dependency-safe contracts;
- no artifact 15-field migration;
- no proof of builder/memory/offline integration through the live OpenAI sideband path.

## Spec-by-Spec Extraction And Alignment

### Doc 1 - Runtime And Tools

What is aligned:

- Function-tool strategy is already proven in principle through both provider adapters and Gemini's backend execution bridge.
- Builder lifecycle has dependency-safe contract definitions and a Gemini bridge for the current five tools.
- Trusted `user_id` binding already exists in builder implementations and Gemini session/tool execution patterns.
- OpenAI adapter already supports the client events needed for `session.update`, `conversation.item.create`, function outputs, and cancellation.

What is not aligned:

- The live target runtime is not GPT Realtime.
- Current `voice/server.py` cascade is not collapsed into a native speech-to-speech model.
- Target GPT session configuration is not wired.
- `retrieve_memories` is not query-only or dependency-safe for voice.
- `consult_skill`, time/schedule, `wait_for_user`, and voice web tools are not present on realtime provider surfaces.
- `emit_artifact` is still the 13-field legacy companion contract.

Audit conclusion: implement tool/runtime alignment in small slices. Do not attempt the whole Doc 1 tool surface in one phase.

### Doc 2 - System Prompt

What is aligned:

- Gemini prompt assembly already pulls canonical Sophia prompt sources.
- Gemini has an explicit spoken-output overlay to stop stacked native-audio responses.
- Current code already understands provider-specific prompt wrapping.

What is not aligned:

- The new GPT stable-prefix/dynamic-seed prompt is not assembled in code.
- Current Gemini prompt still deterministically injects context and ritual files rather than using `consult_skill`/on-demand loading.
- Current artifact prompt teaches the 13-field schema, not the 15-field introspection schema.
- Current tone guidance in Gemini is not the compressed stable prompt block described by the new spec.

Audit conclusion: prompt alignment should follow tool/seed decisions, not precede them with another broad prompt rewrite. The next memory-tool phase should avoid prompt behavior changes beyond the minimum tool description if/when implementation begins.

### Doc 3 - Context Engineering

What is aligned:

- Gemini already has bounded setup-time identity/handoff/Mem0 context.
- Offline pipeline writeback is already outside the turn hot path.
- Public diagnostics already avoid raw memory text in Gemini setup context reporting.

What is not aligned:

- GPT Realtime does not yet receive the target session seed.
- Gemini setup context is Gemini-specific and not yet a shared seed engine.
- Current text companion still does per-turn Mem0 middleware search; that behavior should not be copied into realtime.
- On-demand memory is missing from realtime provider tool surfaces.
- Ambient time turn-tail injection is not implemented.

Audit conclusion: the next implementation should unify a small memory retrieval core first, then later decide whether to generalize Gemini setup context into the target session-seed engine.

### Doc 4 / Artifact Traces

What is aligned:

- Existing artifacts are structured tool calls, not text parsing.
- Current builder final artifact tool has a strong file/path verification middleware and upload/webhook flow.
- Public normalized artifacts already feed frontend/UI/telemetry paths.

What is not aligned:

- Sophia artifacts are still 13 fields and include Cartesia delivery fields.
- Existing `ArtifactInput` does not include `user_emotional_reading`, `response_register`, `predicted_user_trajectory`, `previous_turn_reflection`, or `lesson` as described in the new spec.
- Builder artifacts are final-output records, not per-step traces.
- `check_async_task` contract does not expose `latest_artifact_summary`.

Audit conclusion: artifact schema migration is larger and riskier than the memory-tool slice. It should be a later explicit schema/version phase with backend, frontend, offline, and GEPA consumers updated together.

## Davide Comment Alignment

The new spec set appears to supersede the older GPT v1.3 direction that emphasized MCP/session-log/shared-view architecture for voice. The current audit aligns with Davide's newer direction as follows:

- **Function tools, not MCP, for voice hot path.** The repo should not resurrect MCP server-url execution for voice memory/builder tools unless a later signed-off spec reverses this.
- **Seed plus pull, not full middleware clone.** The text companion chain remains valuable, but native realtime should get a stable prompt, a bounded seed, and explicit tools.
- **Offline memory writes remain offline.** No in-turn Mem0 write or competing memory provider should be introduced.
- **Provider differences matter.** GPT Realtime default conversation assumptions must not be applied to Gemini without evidence.
- **Artifact traces supersede session-log substrate.** Do not reintroduce a separate session log/shared-view substrate for 12.5B-B work.
- **Harness/model boundary stays load-bearing.** Code must enforce trusted identity, tool argument validation, bounded outputs, and deterministic side effects; model-authored fields stay semantic.

Where sign-off is still needed: the new prompt spec says crisis turns may skip `emit_artifact`, while older Sophia hard constraints say `emit_artifact` is required on every companion turn. That conflict should be resolved explicitly before artifact-schema work begins.

## Gemini Vs GPT Realtime Implications

### GPT Realtime

GPT Realtime is the cleaner match for the new spec architecture because the provider owns a stateful default conversation where user turns, assistant output, function calls, function outputs, and injected items can all become model-visible context. This is what the artifact-trail and seed-plus-pull design assumes.

Implications:

- `emit_artifact` function-call items can plausibly serve as within-session introspection context.
- `retrieve_memories` tool output can be model-visible in the conversation without rebuilding instructions.
- `conversation.item.create` can support future ambient time or out-of-band context injection.
- `session.update` can update tools/config where supported.

But current repo status is still early. The OpenAI adapter is a dogfood/provider layer, not the product voice runtime. The session config, prompt, seed, tools, and builder/memory integration all need explicit implementation and validation.

### Gemini Live

Gemini Live is further along in the current production-candidate route, but it is a poorer literal match for several GPT-oriented assumptions:

- Setup is first-message/connection-scoped and effectively immutable.
- The browser owns the provider WebSocket; backend execution is a relay/return-client-action loop.
- Public `sophia.*` events are observability and frontend state; they are not automatically prompt context.
- Tool declarations must be known at setup; adding broad tools later usually means a new session or a new setup strategy.

Implications:

- Query-only `retrieve_memories` can still be added to Gemini as a declared tool plus backend relay execution, but it must be present at setup.
- Gemini cannot rely on a later `session.update` to add or revise tool surface/prompt guidance mid-session.
- Whether Gemini can use prior `emit_artifact` content for next-turn `previous_turn_reflection` through provider conversation state needs verification; if not, an explicit bridge or session item strategy is needed.
- Gemini setup memory context remains useful, but it is not equivalent to the GPT session seed unless generalized and validated.

## Current Alignment Matrix

| Area | New spec target | Current repo state | Alignment | Notes |
|---|---|---|---|---|
| Default voice runtime | GPT Realtime target, phased | Legacy cascade default; Gemini candidate default-off | Gap by design | Do not change in audit. |
| Gemini route | Provider-specific candidate | Advanced browser WSS + relay + tools | Partial | Mature but not same assumptions as GPT. |
| OpenAI route | Target GPT runtime | Dogfood adapter/sideband pieces | Partial | Provider plumbing exists; Sophia wiring missing. |
| Session config | semantic_vad low, no idle timeout, retention ratio, low reasoning | OpenAI helper minimal; Gemini default activity config unchanged | Gap | VAD/config explicitly out of this phase. |
| Stable prompt | A-R stable GPT prefix | Gemini canonical prompt + overlay; no GPT target assembler | Partial | Current artifact/tone/tool sections differ. |
| Dynamic seed | structured current/authoritative/background seed | Gemini-specific memory context only | Partial | Needs shared seed design later. |
| Memory write | offline pipeline | Offline pipeline exists and idempotent | Aligned | Needs transcript quality proof per provider. |
| Memory read | seed plus `retrieve_memories(query)` | Gemini setup snippets; no realtime tool | Partial | Best next implementation slice. |
| `retrieve_memories` contract | query-only, trusted user id, cap about 5 | LangChain query+categories, cap 15 | Gap | Needs shared core/declaration. |
| Skill routing | model calls `consult_skill` | Text companion deterministic router; no realtime tool | Gap | Do not bundle with memory phase. |
| Time/wait tools | `get_current_time`, `schedule_check`, `wait_for_user` | Not exposed in realtime | Gap | Later slice. |
| Artifact schema | 15-field Sophia artifact | 13-field legacy/Cartesia contract | Gap | Later schema migration. |
| Builder lifecycle | five tools, shared async_tasks | Current contracts + Gemini execution bridge | Partial | `latest_artifact_summary` missing. |
| Builder trace | per-step 12-field trail | final `emit_builder_artifact` only | Gap | Larger backend/storage phase. |
| Public events | preserve SSE/public contract | Normalizer and Session path exist | Partial | Event names differ from new spec examples. |
| Provider diagnostics | compact, privacy-minimized | Gemini has strong current-run telemetry | Partial | GPT diagnostics less complete. |
| Prompt/runtime defaults | no Gemini/GPT default change during planning | Current default remains legacy | Aligned | Must stay true through next docs-only work. |

## Gaps And Risks

### High-Priority Gaps

- Realtime memory tool is missing despite being the safest first parity slice.
- The new artifact schema is not compatible with current backend/frontend consumers.
- Provider-specific assumptions are easy to conflate because Gemini is the most advanced route while GPT is the new target spec.
- Current `retrieve_memories` returns too much raw content for live voice and exposes category selection that the new spec explicitly removes.
- Builder progress summary and per-step trace substrate are not implemented.

### Behavioral Risks

- Adding memory, skill, ritual, and artifact changes together would make any bad voice turn impossible to attribute.
- Full middleware prompt injection in native realtime can reintroduce the Gemini over-continuation failure class.
- Changing artifact schemas before UI/offline/GEPA consumers are ready can break Presence, recap, traces, and TTS/voice-state assumptions.
- Making Gemini/GPT default before seed/tool/artifact correctness is proven would remove the safe legacy fallback.

### Security/Privacy Risks

- Model-supplied `user_id` must remain diagnostic-only everywhere.
- Memory diagnostics must not include raw memory text.
- `retrieve_memories` output must be bounded because realtime tool output becomes model context and may be spoken.
- Builder lifecycle ids must remain trusted-session scoped; invented ids should continue failing closed.

## Recommended Implementation Roadmap

### 12.5B-B - Realtime Memory Tool Contract

Implement only the memory-tool slice:

- Extract `_retrieve_memories_core(user_id, query, *, limit, context_mode, categories/internal weights)` behind the existing LangChain tool.
- Preserve text companion behavior unless intentionally adjusted by tests.
- Add dependency-safe realtime declaration/validation for `retrieve_memories(query)`.
- Bind `user_id` from trusted session context only.
- Cap voice results to about five concise snippets.
- Return structured enough data for the provider loop but plain enough for the model to use.
- Add privacy-minimized diagnostics: status, count, categories, lengths, latency, cache hit/miss; no raw memory text in public diagnostics.
- Wire one provider first if necessary, with an explicit note that the other provider follows the same contract.
- Validate explicit recall prompts and no-general-background overuse.

Do not include `consult_skill`, artifact schema changes, builder trace changes, VAD changes, default-provider changes, or prompt-file rewrites in this slice.

### 12.5B-C - Shared Session Seed Design

After memory tool proof, decide whether to generalize Gemini's memory-context builder into a provider-neutral seed engine. This phase should define seed inputs, token budget, redaction rules, and provider placement. It should not change artifact schema.

### 12.5B-D - GPT Realtime Target Session Config And Prompt Assembly

Wire the target GPT Realtime config and stable prompt/seed assembly behind explicit non-default gates. Use the OpenAI adapter's existing `session.update` support but verify exact key paths against the installed API/plugin.

### 12.5B-E - Artifact Schema Migration Plan

Plan and then implement the 13-to-15 Sophia artifact migration across backend contract, Gemini/OpenAI declarations, frontend Presence/recap adapters, offline traces, GEPA consumers, and compatibility shims. Resolve the crisis-turn artifact conflict before implementation.

### 12.5B-F - Builder Artifact Summary

Add builder progress summaries and `check_async_task.latest_artifact_summary` before attempting the full per-step builder trace substrate. This gives Sophia better status language without immediately changing builder storage/UI deeply.

### Later - Skill/Time/Wait/Web Tools

Add `consult_skill`, time/schedule, `wait_for_user`, and web tools in separate phases with provider-specific smoke tests. `consult_skill` should not be a hidden full SkillRouter clone; it should be model-selected and auditable.

## Final Decision Table

| Decision | Recommendation | Rationale |
|---|---|---|
| Implement runtime changes in 12.5B-A | No | This phase is audit/planning only. |
| Make Gemini or GPT Realtime default | No | Legacy cascade remains fallback while context/tool work is incomplete. |
| Treat GPT assumptions as Gemini assumptions | No | Gemini setup/relay semantics differ materially. |
| First implementation slice | `retrieve_memories(query)` | Highest continuity value with manageable blast radius. |
| Expose categories to realtime model | No | New spec says query-only; categories/weights stay internal. |
| Add memory, skill, ritual tools together | No | Too much attribution risk. |
| Change artifact schema during memory slice | No | Schema migration touches many consumers. |
| Reuse MCP/session-log/shared-view v1.3 scope | No | Superseded by function tools and artifact traces. |
| Keep Mem0 writes offline | Yes | Preserves latency and review semantics. |
| Keep `user_id` trusted-session bound | Yes | Non-negotiable privacy/security boundary. |
| Keep diagnostics privacy-minimized | Yes | Counts/status/categories/lengths, not raw memory text. |

## Open Questions Requiring Davide Sign-Off

1. Is GPT Realtime still the primary target runtime while Gemini remains a production-candidate parallel path, or should the next implementation prioritize Gemini because it is currently more wired?
2. Should the 15-field artifact replace the 13-field contract everywhere at once, or should voice carry a dual-schema compatibility period?
3. The new prompt spec exempts crisis turns from `emit_artifact`, while prior Sophia hard constraints require `emit_artifact` on every companion turn. Which rule wins for realtime?
4. Confirm `retrieve_memories(query)` for voice should remove model-facing categories entirely and cap results around five snippets.
5. Should `consult_skill` return full skill file text, a realtime-specific compressed version, or a structured skill summary?
6. For Gemini Live, is a tool call/tool response enough for the model to use previous `emit_artifact` content as next-turn context, or do we need an explicit bridge?
7. What exact seed retrieval query should be used: ritual/context/smart opener, latest user utterance, active goal, or another ranked blend?
8. Does the memory-upgrades spec's newer category set, including any `goal_structure` category, supersede the current repo's Mem0 category list?
9. Can voice builder tools reliably share the same `async_tasks` channel through the bound `thread_id`, or does the voice runtime need an adapter layer?
10. Should ambient time be injected as a turn-tail item in GPT Realtime v1, or should the first implementation use only `get_current_time()`?
11. Are web tools in scope for the first GPT Realtime voice implementation, or should they remain text companion only until memory/builder/artifact are stable?
12. What is the acceptance bar for GPT Realtime replacing legacy cascade: subjective voice quality, event correctness, artifact compliance, memory recall, builder coordination, or all of these as separate gates?

## Closing Recommendation

Proceed with 12.5B-B as a small memory-tool implementation phase. The cleanest test of the new spec direction is not a broad runtime rewrite; it is whether native realtime Sophia can answer explicit memory questions through a trusted, bounded, dependency-safe `retrieve_memories(query)` tool without changing routing, VAD, artifact schemas, prompts, or provider defaults. If that works, the rest of the spec can be staged with much less fog.