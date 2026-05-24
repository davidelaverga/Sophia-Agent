# Sophia Realtime Runtime Contract

Date: 2026-05-21
Status: Phase 12.5A realtime context value decision documented, legacy cascade still active by default

## Why This Exists

The current voice stack is a cascade runtime: Stream/Vision Agents hosts the call, Deepgram provides STT, `SophiaLLM` bridges finalized text to DeerFlow, Cartesia speaks the reply, and custom flow code repairs turn boundaries. The migration audit in `docs/audits/sophia-voice-realtime-migration-audit.md` concluded that the reusable boundary is the public `sophia.*` browser contract, not the cascade internals.

The new `voice.realtime` package creates an inactive provider-neutral seam for future native realtime adapters. It does not change `voice/server.py`, does not select a new provider, and does not alter the default `SOPHIA_BACKEND_MODE` path.

## Phase 12.5A Realtime Context Value Decision

Phase 12.5A is a docs-only product/architecture decision phase. The full decision report lives at `docs/audits/realtime-context-value-decision-phase-12-5a.md`.

The decision is that native realtime parity should be selective, not a full cascade-in-the-loop clone. The legacy cascade still owns production voice by default and reaches the full Sophia companion middleware chain through DeerFlow. Gemini Live and GPT Realtime should instead receive the smallest high-value trusted context needed for live speech, then use tools and sideband processes for deeper or slower capabilities.

Realtime context capabilities should be classified before implementation:

| Classification | Intended use | Examples |
|---|---|---|
| Setup context | Small, stable context sent once at session setup | Platform voice guidance, preferred name. |
| Bounded setup context | Curated, length-limited context sent once | Identity excerpt, latest handoff excerpt, top Mem0 snippets. |
| On-demand tool | Backend lookup only when needed | Memory/profile search, builder lifecycle checks. |
| Sideband/asynchronous | Background persistence outside speech path | Mem0 writeback, recap, compact session cache refresh. |
| Backend/UI-only | Product state surfaced through events/UI, not prompt text | Builder artifacts, diagnostics panels, telemetry exports. |
| Outside realtime | Legacy/offline behavior that should not shape live speech | Offline identity update, GEPA, long recap processing. |
| Harmful | Context likely to regress voice quality or privacy | Full Mem0 dumps, full middleware prompt assembly, broad tool registry. |
| Unknown/needs tests | Provider-specific behavior not yet proven | GPT session-update context refresh, Gemini VAD policy changes. |

The recommended parity levels are:

1. Put trusted preferred name, compact profile, platform, and selected context mode into setup.
2. Keep profile, handoff, and memory snippets bounded and privacy-filtered.
3. Add on-demand memory/profile tools for explicit recall questions.
4. Keep memory writeback, session recap, and identity updates sideband/asynchronous.
5. Keep artifact and builder state structured through tools/events/UI, not spoken prompt text.
6. Avoid full per-turn Sophia middleware execution in the critical realtime audio path unless a future evidence phase chooses deterministic cascade behavior over native realtime latency.

This boundary applies to both Gemini Live and GPT Realtime as a product policy. Provider differences still matter: current Gemini Live setup is effectively immutable during an open session, while OpenAI/GPT Realtime code advertises session-update support and semantic VAD, but those differences do not justify full prompt, memory, or tool expansion without dogfood evidence.

Phase 12.5A made no runtime, prompt-file, VAD, tool, default-provider, or canonical Sophia identity changes.

## Phase 12.5B-A Sophia Voice Spec Alignment Audit

Phase 12.5B-A is a docs-only alignment audit against the new Sophia Voice spec set in `specs/`. The full audit lives at `docs/audits/sophia-voice-spec-alignment-phase-12-5b-a.md`.

The new spec direction supersedes the older GPT v1.3 MCP/session-log/shared-view path for the immediate voice runtime work. The target architecture is:

- stable Sophia prompt prefix;
- dynamic per-session seed;
- native provider conversation state;
- narrow in-process function tools;
- on-demand memory retrieval;
- offline/sideband memory writeback;
- artifact traces as the introspection substrate.

Current implementation is partially aligned but provider-skewed. Gemini Live has the most product-route wiring today: browser-owned Live WebSocket, authenticated setup memory context, canonical Sophia prompt assembly, Gemini spoken policy overlay, selected existing tool declarations, backend relay execution, and normalized `sophia.*` events. GPT Realtime has lower-level adapter support for session updates, conversation items, function-call output, response creation, and cancellation, but it does not yet have the target Sophia prompt, seed, tool surface, or production route wiring.

Provider assumptions must stay separate. GPT Realtime's default server-side conversation is the natural fit for the new artifact-trail and seed-plus-pull model because function calls, function outputs, and injected items can remain model-visible within the session. Gemini Live setup is effectively immutable after the first setup message, the browser owns the provider socket, and public `sophia.*` events are observability/frontend state rather than automatically provider-visible context. Any claim that Gemini can use prior artifacts or tool outputs for next-turn introspection requires direct provider evidence or an explicit bridge.

The recommended next implementation slice is narrow: adapt `retrieve_memories` for realtime as a query-only, trusted-user-id, bounded-output function tool. The current tool is still LangChain/text-companion-shaped with `(query, categories)` and up to 15 bullet results. A safe realtime phase should extract a shared core, keep user identity bound from trusted session context, cap voice results around five snippets, expose privacy-minimized diagnostics, and prove explicit-recall behavior without changing prompts, artifact schemas, VAD, builder storage, routing, or runtime defaults.

Deferred until explicit later phases: time/schedule tools, `wait_for_user`, web tools, the 13-to-15 artifact migration, builder per-step artifacts, `check_async_task.latest_artifact_summary`, GPT target session config, and any provider promotion. Phase 12.5B-A made no runtime, prompt behavior, routing, VAD, schema, tool, builder-storage, or default-provider changes. Phase 12.6A later closed the older voice `consult_skill` path by baking the emotional skills into the cached prompt instead of implementing a skill retrieval tool.

## Phase 12.5B-B Realtime retrieve_memories Tool Contract

Phase 12.5B-B implements the first narrow tool slice recommended by the 12.5B-A audit. The implementation report lives at `docs/audits/realtime-retrieve-memories-tool-phase-12-5b-b.md`.

The realtime memory tool now has a dependency-safe shared contract in `backend/packages/harness/deerflow/sophia/tools/retrieve_memories_contract.py`. Realtime providers see only `retrieve_memories(query)`: no `user_id`, no categories, no raw filters, and no provider configuration. Trusted identity comes from authenticated runtime/session context. Results are structured, capped to five snippets for voice, and memory text is length-bounded.

The existing text companion `make_retrieve_memories_tool(user_id)` remains a LangChain `StructuredTool` with `query` plus optional `categories`, but it now wraps the shared core. That preserves text companion compatibility while keeping the realtime schema query-only.

Gemini Live declares the tool through `voice/realtime/sophia_backend_tools.py` and executes it in `voice/realtime/gemini_tool_loop.py` through the existing backend relay. Model-supplied `user_id` or category/filter arguments are ignored and recorded only as redacted ignored-argument names. Gemini tool diagnostics include status, count, latency, query length, categories, and text lengths, but do not duplicate raw memory text.

GPT Realtime is prepared but not wired: `openai_retrieve_memories_function_declaration()` converts the same contract to OpenAI function format for the next phase. OpenAI production/dogfood routes do not advertise the tool until trusted sideband execution is implemented.

Phase 12.5B-B did not change prompts, rituals, `consult_skill`, web tools, sideband writeback, artifact schemas, builder trace storage, VAD, turn detection, provider defaults, or Gemini/GPT routing.

## Phase 12.5B-C Realtime Memory Provider Availability

Phase 12.5B-C follows the first live `retrieve_memories(query)` smoke, where Gemini successfully called the tool but received a generic `unavailable` result. The implementation report lives at `docs/audits/realtime-memory-tool-availability-phase-12-5b-c.md`.

The shared Mem0 wrapper is now dependency-tolerant for realtime read paths. Backend/LangGraph still uses the Mem0 SDK when present. Slim voice runtimes can import the wrapper without `cachetools`, and when `MEM0_API_KEY` plus `httpx` are present but the SDK is missing, read-only search can use Mem0 REST fallback. Existing `search_memories()` compatibility remains; `search_memories_with_diagnostics()` adds safe provider status, reason, transport, cache status, and latency metadata.

The realtime memory contract now distinguishes provider-reachable zero matches from provider unavailability and provider search errors. `success` means memories were returned, `no_results` means the provider was reachable and returned zero relevant matches, `unavailable` means missing config/dependencies or invalid trusted user context, `error` means search failed after availability, and `invalid_query` means the model supplied no useful query.

Gemini setup-time memory context and realtime tool execution now use the same provider status/search helper. Setup may still personalize from identity/handoff files even when Mem0 is unavailable, so diagnostics include `mem0_provider_reason` to avoid mistaking file-based continuity for Mem0 reachability.

Gemini memory-tool diagnostics now include provider status/reason/transport, cache status, trusted user id source, ignored forbidden argument names, and `raw_memory_text_excluded`; raw memory text still appears only in the bounded tool response that the model needs to answer.

## Phase 12.5B-D Realtime Memory Routing And Epistemic Honesty

Phase 12.5B-D follows the live smoke after 12.5B-C. Provider availability was no longer the main blocker: broad recall called `retrieve_memories`, but later specific recall was weak, and a hint/guess flow ended with Sophia saying `I knew it had to be` after the user supplied the answer.

The implementation report lives at `docs/audits/realtime-memory-routing-epistemic-honesty-phase-12-5b-d.md`.

The realtime memory tool remains query-only and provider-safe. The declaration now makes explicit recall prompts and repeated specific recall prompts stronger retrieval triggers, while preserving negative rules for greetings, current-session facts, present-moment clarification, and `what is my name?` when setup context already contains the preferred name.

Realtime prompt assembly now includes a narrow memory recall guidance block. It tells Sophia to distinguish stored memory, setup context, current-session context, inference/guess, missing stored memory, and unavailable memory retrieval. New facts learned in the current live session are not durable memory until offline writeback confirms persistence. After a user reveals an answer that was not retrieved, Sophia must not say `I knew it`, `I remembered that`, `I had that`, or similar stored-memory language.

Tool result guidance is now status-specific. `success` permits remembered-language only for matching returned memories; `no_results` means no relevant stored match was found; `unavailable` and `error` mean Sophia cannot check stored memory right now and must not claim absence.

This phase did not add memory writeback, `consult_skill`, ritual tools, web tools, artifact schema changes, VAD/turn-detection changes, provider default routing changes, GPT Realtime execution wiring, or Builder storage/UI changes.

## Phase 12.5B-E Memory Attribution And Current-Session Boundary

Phase 12.5B-E follows the next memory-smoke analysis need: determine whether a recall failure means missing stored memory, provider-reachable `no_results`, weak query matching, or the model ignoring a useful returned memory. The implementation report lives at `docs/audits/memory-attribution-tree-cleanup-phase-12-5b-e.md`.

The realtime memory tool still returns bounded memory text to the model when it succeeds, because the model needs that text to answer. The diagnostics path is now more explicit and still privacy-minimized. `diagnostics` includes `has_results`, `query_fingerprint`, `query_length`, `query_term_count`, `result_fingerprints`, `result_text_lengths`, `result_categories`, `max_query_terms_matched_count`, `any_result_exact_query_terms_present`, `result_preview_included: false`, `raw_query_excluded: true`, and `raw_memory_text_excluded: true`. Result fingerprints include rank, text fingerprint, text length, category/score when available, and query-term match counts, but no raw memory preview.

Gemini backend relay diagnostics and compact reliability diagnostics carry those safe attribution fields. Browser-side Gemini tool-loop diagnostics redact `retrieve_memories` tool-call args and backend responses before capture, while preserving the raw Gemini `toolResponse` payload sent over the provider WebSocket. This keeps the model-visible tool result useful without turning telemetry exports into memory dumps.

Model-facing guidance now says that a returned memory directly answering a recall question should be used directly, starting with the highest-ranked matching result. If the user supplies an answer after no matching memory was retrieved, Sophia should treat that answer as current-session knowledge only and must not promise permanent memory, future recall, or long-term storage until offline writeback persists it.

This phase did not add memory writeback, `consult_skill`, ritual tools, web tools, artifact schema changes, VAD/turn-detection changes, provider default routing changes, GPT Realtime execution wiring, permanent sideband writeback, or Builder storage/UI changes.

## Phase 12.5C Conversation Context And Artifact Orientation Design

Phase 12.5C is a docs-only design/audit phase after the realtime memory-read stabilization work. The full report lives at `docs/audits/conversation-context-artifact-orientation-phase-12-5c.md`.

The decision is that realtime Sophia should replace the text companion checkpointer path by function, not by internal topology. The text companion supplies message history, LangGraph state, previous artifacts, tone/skill/ritual state, identity, handoff, Mem0 retrieval, builder async state, tool results, summarization, diagnostics, and offline writeback. Native realtime should not replay that bundle per turn.

Provider-agnostic policy:

- Use session seed plus native provider conversation plus tools.
- Do not replay full checkpointer/message history per turn.
- Treat the current user transcript as highest-priority immediate intent.
- Treat Mem0 as durable cross-session memory, handoff as cross-session summary, and the latest artifact as current-session meta-orientation.
- Keep artifact orientation compact, latest-only, and non-verbalized.
- Keep memory writeback, recap, identity updates, and durable learning offline/sideband.

Provider-specific boundary:

- GPT Realtime is expected to support artifact-trail mechanics more naturally because its default conversation can contain user items, assistant items, function calls, function outputs, and injected items. Current OpenAI adapter code supports `session.update`, `conversation.item.create`, and `function_call_output`, but the repo still needs proof that prior `emit_artifact` calls/outputs are useful model context in a real Sophia session.
- Gemini Live is currently more production-wired, but public `sophia.*` events are not provider-visible context. Gemini setup is effectively immutable after the first setup message; backend tool execution returns a browser-sent `toolResponse`, and current `emit_artifact` responses report artifact status/keys rather than the full orientation content. Prior artifact visibility must be proven through Gemini function-call/toolResponse behavior before relying on it.

Recommended next phase: 12.5C-B Artifact Visibility Proof Harness. Prove GPT and Gemini artifact visibility separately before adding any compact artifact-orientation bridge, reconnect reseed payload, or 15-field artifact schema migration.

## Phase 12.6A Baked Emotional Skills Prompt

Phase 12.6A implements Davide's updated voice skills direction. The implementation report lives at `docs/audits/bake-emotional-skills-into-voice-prompt-phase-12-6a.md`.

Voice mode no longer treats emotional skills as a fetchable tool path. The realtime prompt now carries all eight fixed emotional modes in the stable instructions prefix: `active_listening`, `vulnerability_holding`, `crisis_redirect`, `trust_building`, `boundary_holding`, `challenging_growth`, `identity_fluidity_support`, and `celebrating_breakthrough`. Sophia flows between these modes in context and records `skill_loaded` as the mode she is in this turn, not a tool call that happened.

The Gemini voice tool surface remains narrow and existing-tool-only: `emit_artifact`, builder lifecycle tools, and `retrieve_memories`. `consult_skill` is not declared for Gemini Live, is not part of the prepared OpenAI-compatible declaration path, and should not be added to voice mode unless a later measured scaling problem reopens skill retrieval/RAG.

Crisis remains in prompt as an override. It stops other skill behavior, avoids exploration/problem-solving/build work, gives direct resources, and includes minimal crisis acknowledgment wording for future observability. This phase does not change the 13-field artifact schema and does not implement a crisis classifier, tripwire, live cancellation, memory writeback, Builder behavior, VAD/turn detection, or provider routing.

The harness slow-state contract is documented but not fully implemented here. Future session seeds may constrain the model with session count, established-trust flag, recurring-pattern flags, and prior tone band; the model holds the repertoire, but should stay within those bounds.

## Phase 12.6B Spoken Assistant Transcript Fidelity Evidence

Phase 12.6B is a focused observability phase after the 12.6A smoke showed a mismatch between Sophia's reportedly correct spoken crisis redirect and sparse public assistant captions. The implementation report lives at `docs/audits/spoken-assistant-transcript-fidelity-phase-12-6b.md`.

The key decision is to distinguish spoken behavior from transcript audit fidelity. A broken public `sophia.transcript` trail is not proof that Gemini spoke the wrong response. For safety and crisis smokes, telemetry must show separate evidence for provider audio chunks, provider `outputTranscription`, public assistant transcript snapshots, interruption/playback flush, finalization, response/source metadata, and export scope.

`turnCaptureDiagnostics.version` is now `2` and includes `summary.assistantTranscriptEvidence`. The evidence is compact and bounded: per-window audio chunk counts, provider output-transcription fragment/text lengths, public assistant transcript counts/lengths/final-seen state, latest safe previews, provider-to-public ratio, interruption/flush flags, source/response id gaps, and warnings such as `assistant_audio_present_without_provider_output_transcription`, `assistant_audio_present_without_public_transcript`, `public_assistant_transcript_shorter_than_provider_output`, `assistant_transcript_interrupted_before_final`, and `capture_scope_may_omit_earlier_provider_events`.

Gemini browser provider telemetry now carries a `responseId` field when the raw provider message exposes one. This is diagnostic metadata only. Phase 12.6B does not change spoken audio, crisis prompt behavior, emotional skills, artifact schema, Builder behavior, memory behavior, provider routing, or VAD.

## Phase 12.6C Skill Slow-State Seed Contract

Phase 12.6C implements the slow-state seed promised by 12.6A. The implementation report lives at `docs/audits/skill-slow-state-seed-contract-phase-12-6c.md`.

Voice emotional skills remain a baked in-context repertoire, not a fetchable tool path. The new dynamic `### Voice Skill State` block is appended at setup time outside the stable cached prompt prefix. It tells Sophia the conservative slow-state facts the harness can safely provide: session count, established-trust status, recurring-pattern summaries, prior tone band, default posture, `challenging_growth_allowed`, the reason for that gate, in-bounds skills, out-of-bounds skills, and the always-in-bounds crisis override.

Gemini Live appends this seed after authenticated setup context (identity/handoff/bounded memories) and before the Gemini spoken-turn overlay. OpenAI/GPT Realtime dogfood defaults now use the same seed renderer in session instructions when explicit instructions are not supplied, and the OpenAI session-config helper carries seeded instructions unchanged. Provider routing is unchanged.

The harness boundary is intentionally narrow: it gates slow structural appropriateness, especially early-session `trust_building` and `challenging_growth`, while the model still reads the live emotional moment. Unknown state defaults conservatively: trust unknown, recurring patterns unknown, `default_posture=trust_building`, and `challenging_growth_allowed=false`. This phase does not implement trust analytics, trace/session-history counting, crisis classification, ritual tools, memory writeback, artifact schema changes, Builder changes, VAD tuning, or provider promotion.

## Phase 12.6D Gemini Barge-in / Stale Assistant Output Suppression

Phase 12.6D follows the first 12.6C smoke where Gemini continued or repeated stale assistant speech after user barge-in, including stale `Done and ready...` text leaking through a later Spanish turn. The implementation report lives at `docs/audits/gemini-barge-in-stale-output-suppression-phase-12-6d.md`.

The runtime contract now treats barge-in as a multi-layer fence, not a single playback stop. Browser-owned Gemini playback has a generation counter: interruption and `flushOutputAudio()` stop active PCM sources, reset scheduled playback state, and make later stale output diagnosable. The browser connector can suppress stale assistant audio/transcript after a barge-in fence before old output is scheduled or relayed.

The public transcript contract remains replace-by-snapshot, but ingestion now remembers interrupted response/segment keys and latest user-input time. User input and public `sophia.user_transcript` close the active assistant transcript segment locally. New assistant generations reopen the default/no-id path; explicitly interrupted response ids stay rejected until the provider sends a new response start.

On the backend, `SophiaEventNormalizer` closes the active assistant response when a finalized user transcript arrives during assistant output. Later assistant deltas/finals for that closed response become compact diagnostics instead of public `sophia.transcript` mutations, even when their source sequence is higher than the interruption boundary. An explicit new `RESPONSE_STARTED` can reopen a reused provider response id for provider compatibility.

Diagnostics now include stale assistant audio/transcript drop counts, playback generation, interrupted response ids, assistant/user overlap duration, transcript relay backlog warnings, and unresolved Gemini tool-call counts. Raw Gemini `emit_artifact` calls still do not count as public artifacts; artifact reconciliation remains based on validated public/runtime/rendered artifact evidence.

This phase did not change baked skills, prompt files, crisis behavior, artifact schema, Builder behavior, memory behavior, provider routing, or VAD/activity tuning.

## Phase 12.6D-B Gemini Barge-in Guard Sensitivity Hotfix

Phase 12.6D-B follows the integrated-branch smoke where the 12.6D stale-output fence cut Sophia audio off after about one word. The implementation report lives at `docs/audits/gemini-barge-in-guard-sensitivity-hotfix-phase-12-6d-b.md`.

The root cause was local guard sensitivity, not artifact/tool lifecycle. The smoke showed `toolCallCount=3`, `toolResponseCount=3`, `unresolvedToolCallCount=0`, and `artifactCountMismatch=false`, but also `assistantUserOverlapMs=23583`, `maxAssistantUserOverlapMs=23583`, and `staleAssistantOutputSuppressionCount=30`.

The runtime contract now distinguishes barge-in candidates from confirmed barge-ins. Browser `input_audio_frame_sent` diagnostics alone are not enough to invalidate assistant output. They become short-lived candidates and decay if frames stop. Stale-output suppression is armed only by provider interruption, explicit playback flush, provider input transcription, or sustained user audio over a short threshold.

Confirmed interruption behavior stays intact: playback flushes, playback generation advances, old interrupted response ids remain stale, and old transcripts cannot mutate the next turn. The difference is that incidental residual mic frames no longer stop valid Gemini audio or mark assistant transcript state interrupted.

Diagnostics now expose `userInputActiveAgeMs`, `bargeInConfirmed`, `bargeInCandidateFrameCount`, `suppressionDeferredReason`, `staleSuppressionArmedAt`, `staleSuppressionArmedBy`, `assistantAudioDropReason`, and `inputFrameOnlyNotBargeInCount` in input/stale-output telemetry.

This hotfix did not change skills, prompt behavior, memory, Builder, artifact schema, provider routing, crisis behavior, `users/**`, `backend/users/**`, `voice/sophia_llm.py`, or Vision Agents files.

## Why BackendAdapter Is Not Reused

`voice/adapters/base.py` defines `BackendAdapter` for one finalized user text turn. It yields text chunks, an artifact, builder task events, or an error from a backend such as DeerFlow. That is still useful for the legacy cascade.

Native realtime providers need a different contract. They may own audio input, audio output, VAD, interruption, response lifecycle, tool calls, session updates, and provider metrics before a finalized text turn exists. Extending `BackendAdapter` would mix text-backend concerns with bidirectional realtime session semantics.

## Responsibility Split

Provider layer:
- Implements `RealtimeProviderSession` from `voice/realtime/contracts.py`.
- Declares `ProviderCapabilities` from `voice/realtime/capabilities.py`.
- Emits normalized `ProviderEvent` values from `voice/realtime/events.py`.
- Keeps provider wire names, SDK payloads, and modality negotiation private.

Sophia runtime layer:
- Uses `SophiaRealtimeTurnRuntime` from `voice/realtime/runtime.py` as the future orchestration boundary.
- Owns provider event normalization, artifact validation hooks, builder routing hooks, diagnostics, cancellation shape, and runtime lifecycle.
- Uses `DeliveryIntent` from `voice/realtime/delivery.py` before mapping to provider-specific voice controls.

Frontend public event layer:
- Receives only the existing envelope shape: `{ "type": "sophia.*", "data": { ... } }`.
- Continues to use the known event names consumed in `frontend/src/app/hooks/useStreamVoiceSession.ts`: `sophia.user_transcript`, `sophia.turn`, `sophia.transcript`, `sophia.artifact`, `sophia.builder_task`, and `sophia.turn_diagnostic`.

## Legacy Cascade Compatibility Bridge

Phase 2 adds an inactive compatibility bridge in `voice/realtime/legacy_cascade.py`. The bridge does not replace the live Deepgram → DeerFlow → Cartesia cascade and is not selected by `voice/server.py`, the gateway, or the frontend. It exists so the current cascade can be described in the same provider-neutral vocabulary future OpenAI and Gemini adapters must use.

The bridge translates current legacy lifecycle semantics into `ProviderEvent` values:

| Legacy cascade semantic | Provider event |
|---|---|
| Final user transcript emitted by `SophiaLLM.simple_response` | `user_transcript_final` |
| First assistant response progress / agent start | `response_started` |
| Backend text chunk from `BackendEvent.text` | `assistant_text_delta` |
| Final accumulated assistant text | `assistant_text_final` |
| Validated companion artifact payload | `artifact_payload` |
| Builder task payload from DeerFlow custom/values stream | `builder_task_payload` |
| Backend/TTS response completion | `response_ended` |
| Cancel-and-merge or barge-in interruption | `response_cancelled` / `response_interrupted` |
| Backend, STT, TTS, or runtime stage error | `provider_error` |
| Existing turn diagnostic payload | `provider_metric` |

`LegacyCascadeCompatibilityBridge` deliberately stops at the provider-neutral layer. It never emits `sophia.*` directly. Tests route its output through `SophiaEventNormalizer`, which proves the existing public event order and payload vocabulary can still be produced from legacy cascade semantics without binding future provider work to Deepgram, DeerFlow SSE details, or Cartesia controls.

The companion helper `LegacyCascadeProviderSession` is a replayable `RealtimeProviderSession` for isolated tests and future shadow instrumentation. Its declared capabilities describe the legacy cascade truthfully: Sophia owns turn authority, audio is not provider-native in this contract, cancellation is not native provider cancellation, and speech delivery is represented as hints. This keeps the bridge useful for migration parity without pretending the cascade is already a native realtime provider.

This bridge is not yet the active production path because the live runtime still depends on Vision Agents session ownership, Stream transport, SmartTurn repair, `ConversationFlowCoordinator`, `SophiaLLM` artifact validation, and `SophiaTTS` delivery. Replacing that path requires a later feature-flagged runtime switch with shadow/dogfood validation.

## Phase 3 Runtime Selection And Shadow Parity

Phase 3 adds a runtime selection foundation without switching production away from the legacy cascade. The voice runtime selector lives in `voice/realtime/runtime_selection.py` and uses a separate environment variable, `SOPHIA_VOICE_RUNTIME_MODE`, so it does not overload the text-backend `SOPHIA_BACKEND_MODE` / `SOPHIA_LLM_MODE` setting. The default runtime is `legacy_cascade`. Values `openai_realtime` and `gemini_live` are declared so configuration and tests can name the migration targets; as of Phase 6 they validate only behind explicit experimental double opt-in.

Shadow parity is controlled by `SOPHIA_VOICE_REALTIME_SHADOW_PARITY_ENABLED`, default false. When enabled, the live legacy cascade still emits public events through the existing `SophiaLLM._emit_call_event` path. The shadow path mirrors lifecycle facts into `LegacyCascadeCompatibilityBridge`, normalizes those provider events through `SophiaEventNormalizer`, and records expected public events in memory only. After the existing emitter succeeds, the actual `sophia.*` payload is compared against the next expected shadow-normalized payload.

The shadow comparator lives in `voice/realtime/shadow_parity.py` and records diagnostics for matches, missing expected events, unexpected actual events, type mismatches, stable payload mismatches, and sequencing mismatches. It deliberately ignores dynamic fields such as timestamps, provider identifiers, response ids, turn ids, session ids, and latency fields ending in `_ms`. These records are for logs and test assertions only. They are not sent to the browser, the Stream event broker, or the gateway.

The current target architecture specs now exist in-repo: `docs/architecture/sophia_gpt_realtime_experiment_spec_v1_3.md` for the GPT-Realtime experiment and `docs/architecture/sophia_frontend_architecture_spec_v2.md` for the frontend v2 surface. Phase 3 remains pre-adapter parity work; it does not integrate either native provider.

## Phase 4 OpenAI GPT-Realtime-2 Adapter

Phase 4 adds the first real native-provider adapter in `voice/realtime/openai_realtime.py`. It remains non-default and feature-flagged: constructing `OpenAIRealtimeProviderSession` requires `SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED=true`, while `SOPHIA_VOICE_RUNTIME_MODE=openai_realtime` additionally requires the Phase 6 global experimental runtime gate. `voice/server.py` is unchanged, so normal live sessions continue through the Deepgram -> DeerFlow -> Cartesia legacy cascade unless a later routing phase deliberately changes that.

The OpenAI adapter has two pieces:

- `OpenAIRealtimeEventMapper` maps OpenAI Realtime GA server events into `ProviderEvent` values.
- `OpenAIRealtimeProviderSession` implements the provider-neutral session protocol around injected raw event streams and injected client-event senders, without introducing an OpenAI SDK dependency or opening sockets itself.

The mapper uses official GA event names: `session.created`, `session.updated`, `conversation.item.input_audio_transcription.delta/completed/failed`, `input_audio_buffer.speech_started/stopped/committed`, `response.created`, `response.output_text.delta/done`, `response.output_audio.delta/done`, `response.output_audio_transcript.delta/done`, `response.function_call_arguments.delta/done`, `response.done`, `response.cancelled`, and `error`. Benign provider lifecycle events do not become public events. Public output still passes through `SophiaEventNormalizer` and remains limited to the existing `sophia.*` vocabulary.

Function-call handling is structured, not text-parsed. `response.function_call_arguments.done` and `response.done` function-call output items produce `tool_call_requested`; `emit_artifact` additionally emits `artifact_payload`, and builder tool results can emit `builder_task_payload`. This preserves the hard requirement that companion artifacts arrive through tool-use JSON, not assistant text scraping.

The outbound half emits documented OpenAI client event shapes through an injected sender: `session.update`, `input_audio_buffer.append`, `conversation.item.create`, `response.create`, `conversation.item.create` function-call outputs, and `response.cancel`. Because the transport is injected, the adapter is import-safe and testable without adding OpenAI runtime dependencies to the voice service.

## Phase 5 Gemini Live Adapter

Phase 5 adds the second native-provider adapter in `voice/realtime/gemini_live.py`. It remains non-default and feature-flagged: constructing `GeminiLiveProviderSession` requires `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, while `SOPHIA_VOICE_RUNTIME_MODE=gemini_live` additionally requires the Phase 6 global experimental runtime gate. `voice/server.py` is unchanged, so normal live sessions continue through the Deepgram -> DeerFlow -> Cartesia legacy cascade.

The Gemini adapter follows the same safe shape as the OpenAI adapter:

- `GeminiLiveEventMapper` maps official Live API server-message union fields into `ProviderEvent` values.
- `GeminiLiveProviderSession` implements the provider-neutral session protocol around injected raw event streams and injected client-message senders.
- No Google SDK, WebSocket, or production routing dependency is introduced.

The mapper is grounded in the official Google Live API surface. A Live API WebSocket is stateful, starts with a `setup` client message, and reports readiness with `setupComplete`. Client messages are one of `setup`, `clientContent`, `realtimeInput`, or `toolResponse`. Server messages can contain `serverContent`, `toolCall`, `toolCallCancellation`, `goAway`, `sessionResumptionUpdate`, and `usageMetadata`. The adapter accepts SDK-style snake_case aliases only as casing variants of those documented fields.

Gemini `serverContent.inputTranscription` becomes `user_transcript_final`; `serverContent.outputTranscription` and text parts from `serverContent.modelTurn.parts` become assistant text events with one transcript surface selected per response; inline audio parts start assistant audio; `generationComplete` and `turnComplete` produce response/audio terminal events; `interrupted` and `toolCallCancellation` become interruption events and diagnostics. `toolCall.functionCalls` becomes structured `tool_call_requested`; `emit_artifact` additionally becomes `artifact_payload`; builder lifecycle tool calls remain internal candidates until a later Sophia runtime layer executes them and sends `toolResponse` messages.

Outbound client-message helpers emit documented Live API shapes: initial `setup`, realtime input audio as raw PCM bytes encoded in a Blob-shaped payload, realtime input text, `toolResponse.functionResponses` with matching function-call ids, and an `activityStart` realtime input as the best documented interruption signal for manual activity flows. The provider has native barge-in behavior, but Google does not document an OpenAI-style standalone `response.cancel` client event.

Capability notes are intentionally version-aware. Current Google docs distinguish Gemini 3.1 Flash Live Preview from Gemini 2.5 Flash Live Preview: native audio response modality is audio-only, text should come from output audio transcription, session setup cannot be mutated while the connection is open, async function calling is not supported in Gemini 3.1 Flash Live but is supported in Gemini 2.5 Flash Live with `NON_BLOCKING`, and affective dialog/proactive audio are model/version-specific preview features. The adapter records these distinctions as provider hints instead of pretending all Gemini Live models share one behavior.

## Phase 6 Experimental Runtime Activation

Phase 6 changes OpenAI and Gemini from "declared but always rejected" into explicit experimental active runtimes at the provider-neutral factory layer. The production default remains `legacy_cascade`. Normal voice sessions continue to use the existing Deepgram -> DeerFlow -> Cartesia cascade unless an operator deliberately sets all required experimental flags.

Experimental activation is fail-closed and requires two independent opt-ins:

| Runtime | Required configuration |
|---|---|
| OpenAI GPT-Realtime-2 | `SOPHIA_VOICE_RUNTIME_MODE=openai_realtime`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED=true` |
| Gemini Live | `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true` |

The provider adapter flag alone is not enough. The global experimental flag alone is not enough. `SOPHIA_VOICE_REALTIME_SHADOW_PARITY_ENABLED` is legacy-only and rejects experimental runtime modes because the Phase 3 parity path mirrors the live cascade, not provider-native sessions.

The runtime resolver lives in `voice/realtime/runtime_factory.py`. It builds a `RealtimeRuntimeBundle` containing the validated `VoiceRuntimeSelection`, selected `RealtimeProviderSession`, and `SophiaRealtimeTurnRuntime`. All providers still stop at `ProviderEvent`; public browser output still passes through `SophiaEventNormalizer`.

The live `voice/server.py` cascade remains legacy-only. If an experimental runtime is selected in live server settings, `validate_live_voice_server_runtime` first proves the selected provider bundle is constructible through the factory, then raises a clear error instead of silently falling back to Deepgram/Cartesia. This keeps Phase 6 activation explicit while preventing a misleading production runtime claim before media transport routing is wired.

The comparative smoke harness lives in `voice/realtime/smoke_harness.py`. It runs deterministic legacy, OpenAI, and Gemini fixture turns through the same factory + normalizer path and verifies required public milestones: final user transcript, `user_ended`, `agent_started`, final assistant transcript, structured artifact, and `agent_ended`. It also checks that raw provider wire names do not leak into public `sophia.*` envelopes.

This phase intentionally does not make OpenAI or Gemini the default and does not remove any legacy cascade components. It creates the first safe construction path for experimental provider runtimes and a comparative proof harness for future live transport wiring.

## Phase 7 Internal Dogfood Session Path

Phase 7 adds an explicit internal dogfood path for experimental OpenAI and Gemini runtime modes without changing the browser voice default. `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade` remains the normal live path. The existing Stream/Vision Agents session route is now guarded as legacy-only: if `openai_realtime` or `gemini_live` is selected, `/calls/{call_id}/sessions` returns a clear conflict instead of silently constructing the Deepgram -> DeerFlow -> Cartesia cascade.

The dogfood surface lives in `voice/server.py` under `/dogfood/realtime/*` and is backed by `voice/realtime/dogfood_session.py`. It starts a `RealtimeDogfoodSession` using the Phase 6 factory, configures the selected provider session, records outbound provider client messages for internal diagnostics, accepts raw provider events from an internal harness, and streams only normalized public SSE envelopes produced by `SophiaRealtimeTurnRuntime.public_events()`.

Internal dogfood endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /dogfood/realtime/sessions` | Start a provider event-pump session for the selected experimental runtime. |
| `POST /dogfood/realtime/sessions/{session_id}/input/text` | Send text into the provider session using the adapter's documented client-message helper. |
| `POST /dogfood/realtime/sessions/{session_id}/provider-events` | Ingest one raw provider event/message from an internal harness. The response does not echo the raw payload. |
| `GET /dogfood/realtime/sessions/{session_id}/events` | Stream normalized `sophia.*` SSE payloads. |
| `DELETE /dogfood/realtime/sessions/{session_id}` | Close the dogfood session and provider event pump. |

Provider credentials are now validated when the experimental runtime is selected. OpenAI dogfood requires `OPENAI_API_KEY`. Gemini dogfood requires `GOOGLE_API_KEY` or `GEMINI_API_KEY`. The existing global/provider double opt-in still applies:

| Runtime | Required configuration |
|---|---|
| OpenAI GPT-Realtime-2 | `SOPHIA_VOICE_RUNTIME_MODE=openai_realtime`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED=true`, `OPENAI_API_KEY` |
| Gemini Live | `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, `GOOGLE_API_KEY` or `GEMINI_API_KEY` |

This is not a production browser-audio implementation. Browser microphone capture still uses Stream/Vision Agents only in `legacy_cascade`. Phase 7 is intentionally scoped to the provider-session lifecycle and normalized event pump so internal testers can exercise real or recorded provider messages while keeping raw provider wire names out of frontend consumers. Phase 8A and Phase 8B add separate browser dogfood connectors, but they do not replace `/voice/connect` or `useStreamVoiceSession`.

## Phase 8A OpenAI Browser WebRTC + Server Sideband Dogfood

Phase 8A adds the first truthful browser-audio OpenAI dogfood path without changing the production default. Normal `/voice/connect` sessions still use Stream/Vision Agents, Deepgram, DeerFlow, Cartesia, SmartTurn, and `ConversationFlowCoordinator` under `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`. The OpenAI browser path is separate, internal, and still requires all OpenAI experimental gates plus `OPENAI_API_KEY` on the trusted backend.

The runtime shape is:

`Browser microphone/speaker -> OpenAI Realtime WebRTC -> Sophia backend OpenAI sideband -> OpenAI adapter -> ProviderEvent -> SophiaEventNormalizer -> public sophia.* SSE`

New voice-server dogfood endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /dogfood/realtime/openai/browser-sessions` | Start a dogfood session and mint an OpenAI ephemeral client secret with the official `POST /v1/realtime/client_secrets` body shape. |
| `POST /dogfood/realtime/openai/browser-sessions/{session_id}/sideband` | Attach the trusted backend sideband WebSocket to the `rtc_*` call id returned by the browser SDP exchange `Location` header. |
| `DELETE /dogfood/realtime/openai/browser-sessions/{session_id}` | Close the OpenAI sideband and the dogfood session. |
| `GET /dogfood/realtime/sessions/{session_id}/events` | Reuses the Phase 7 normalized SSE stream. |

The authenticated Gateway and Next proxy surface mirrors the internal dogfood flow under `/api/sophia/{user_id}/voice/dogfood/openai/*`. The frontend connector in `frontend/src/app/lib/openai-browser-webrtc-dogfood.ts` starts the protected session, uses only the ephemeral `client_secret.value` in the browser, posts the SDP offer directly to OpenAI `POST /v1/realtime/calls`, extracts the `rtc_*` call id from the `Location` header, and asks the backend to attach sideband. The standard `OPENAI_API_KEY` never crosses into browser code or client-side environment variables.

The sideband manager lives in `voice/realtime/openai_browser_dogfood.py`. Its WebSocket reader feeds raw OpenAI server messages into the existing `DogfoodRawEventStream`, so OpenAI wire names are still translated by `OpenAIRealtimeEventMapper` and then normalized by `SophiaEventNormalizer`. Public consumers continue to see only `sophia.*` payloads.

This phase intentionally keeps OpenAI dogfood separate from the Stream voice hook. `frontend/src/app/hooks/useStreamVoiceSession.ts` and `/api/sophia/{user_id}/voice/connect` remain production legacy-cascade paths.

## Phase 8B Gemini Browser Live WebSocket + Backend Relay Dogfood

Phase 8B adds the Gemini sibling to Phase 8A without copying OpenAI's sideband assumption. Normal `/voice/connect` sessions still use Stream/Vision Agents, Deepgram, DeerFlow, Cartesia, SmartTurn, and `ConversationFlowCoordinator` under `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`. The Gemini browser path is separate, internal, and requires all Gemini experimental gates plus `GOOGLE_API_KEY` or `GEMINI_API_KEY` on the trusted backend.

The runtime shape is:

`Browser microphone/speaker -> Gemini Live WebSocket with ephemeral auth token -> browser-captured provider messages -> authenticated backend relay -> Gemini adapter -> ProviderEvent -> SophiaEventNormalizer -> public sophia.* SSE`

There is no OpenAI-style backend sideband in this path. The browser owns the Live WebSocket. The backend mints an ephemeral Google Live auth token, locks the setup payload used by the dogfood session, and accepts only browser-captured Gemini server messages for normalized observation.

New voice-server dogfood endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /dogfood/realtime/gemini/browser-sessions` | Start a Gemini dogfood session, mint an ephemeral Google Live auth token through `v1alpha/auth_tokens`, and return the locked `setup` payload plus constrained WebSocket URL metadata. |
| `POST /dogfood/realtime/gemini/browser-sessions/{session_id}/provider-events` | Ingest one browser-captured Gemini Live server message. Client audio messages such as `realtimeInput` are rejected; only documented server message shapes feed the adapter. |
| `DELETE /dogfood/realtime/gemini/browser-sessions/{session_id}` | Close the Gemini dogfood session. |
| `GET /dogfood/realtime/sessions/{session_id}/events` | Reuses the Phase 7 normalized SSE stream. |

The authenticated Gateway and Next proxy surface mirrors the internal dogfood flow under `/api/sophia/{user_id}/voice/dogfood/gemini/*`. The frontend connector in `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts` starts the protected session, opens the Google Live WebSocket directly with the ephemeral token in the `access_token` query parameter, sends `setup` first, waits for `setupComplete`, streams microphone audio as base64 PCM16 at 16 kHz, relays server messages back through `/relay`, and plays raw PCM16 24 kHz output audio on a best-effort browser `AudioContext` path.

The standard Google/Gemini API key never crosses into browser code or client-side environment variables. The browser receives only the ephemeral token returned by the auth-token mint endpoint. Gemini wire messages are never emitted directly on public SSE; `GeminiLiveEventMapper` and `SophiaEventNormalizer` remain the boundary.

This phase intentionally keeps Gemini dogfood separate from the Stream voice hook. `frontend/src/app/hooks/useStreamVoiceSession.ts` and `/api/sophia/{user_id}/voice/connect` remain production legacy-cascade paths.

## Phase 9 Comparative Dogfood Evaluation Layer

Phase 9 adds the proof layer after Phase 8A and Phase 8B transport completion: repeatable manual comparison, run-recording, and a compact event-evidence summary helper. It does not change provider transport, does not add production rollout, and does not change the default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade` behavior.

The manual protocol lives in `docs/testing/sophia-realtime-comparative-dogfood-phase-9.md`. It compares OpenAI browser WebRTC + trusted backend sideband against Gemini browser Live WSS + trusted backend relay under the same scenario matrix. The matrix covers core voice flow, Sophia-specific emotional behavior, interruption/silence/recovery, tool/artifact-shaped event observation, provider error simulation, and session close/recovery.

Run records live under the template/schema pair:

- `docs/testing/templates/sophia-realtime-dogfood-run-template.md`
- `docs/testing/schemas/sophia-realtime-dogfood-run.schema.json`

The internal helper in `voice/realtime/dogfood_evaluation.py` summarizes already-normalized public dogfood payloads. It counts `sophia.*` events, records first timestamps when present, flags public provider-event leaks, checks for `agent_started` / `agent_ended`, final transcript and artifact presence, interruption markers, provider error markers, close reason, and missing required turn evidence. The helper is not analytics infrastructure and does not inspect raw provider traffic.

Providers remain non-default because manual evaluation has not yet established migration readiness. A provider that sounds natural still fails the proof layer if public event correctness, structured artifact evidence, interruption behavior, sideband/relay health, or session recovery is weak.

## Phase 10.9 Gemini Backend Tool Loop Bridge

Phase 10.9 extends the Gemini browser Live path without changing its ownership model. The browser still owns the Gemini Live WebSocket for microphone input and audio output. The backend still owns Sophia business logic. The bridge between those responsibilities is the existing authenticated provider-event relay.

The runtime shape is now:

`Browser microphone/speaker -> Gemini Live WSS -> browser-captured toolCall -> backend relay/tool executor -> client_actions.gemini_tool_response -> browser sends toolResponse -> Gemini resumes`

The Gemini setup payload now declares a narrow dogfood-safe tool subset:

- `emit_artifact`, the existing Sophia companion artifact capability already modeled by `GeminiLiveEventMapper` and `SophiaEventNormalizer`.
- `sophia_tool_probe`, a dogfood-only diagnostic tool that returns backend runtime/session status and proves tool execution plus `toolResponse` send-back without side effects.

The backend bridge lives in `voice/realtime/gemini_tool_loop.py` and is called from `voice/realtime/gemini_browser_dogfood.py`. It validates function-call ids, names, and JSON arguments; rejects unsupported tools clearly; suppresses responses for tool-call ids already cancelled by `toolCallCancellation`; and returns a client action shaped as the official Live API `toolResponse.functionResponses[]` message. The browser helper sends only that returned payload over the existing WSS and surfaces compact diagnostics on `/debug/realtime/gemini`.

This phase was a transport proof. It intentionally used a temporary diagnostic tool to prove backend execution and `toolResponse` send-back before promoting real Sophia capabilities.

## Phase 11.0-11.3 Gemini Sophia Prompt And Existing Tool Coverage

Phase 11.0 keeps the same browser-owned Gemini transport and backend relay, but removes the temporary probe from the real live tool surface. Gemini setup now declares only existing Sophia backend capabilities that are actually executable through the relay path.

Prompt-source alignment:

- `voice/realtime/sophia_prompt.py` assembles Gemini Live setup instructions from canonical Sophia sources rather than a Gemini-specific compact persona.
- The source list includes `skills/public/sophia/soul.md`, `voice.md`, `techniques.md`, `AGENTS.md`, platform guidance from `PlatformContextMiddleware`, the selected context/ritual prompt files when present, and the voice artifact contract from `ArtifactMiddleware`.
- The Gemini browser-session route no longer accepts an arbitrary instruction override, so ordinary debug sessions use the same Sophia prompt assembly by default.

Existing-tool coverage:

- `voice/realtime/sophia_backend_tools.py` derives the Gemini `emit_artifact` declaration from the dependency-safe backend contract `deerflow.sophia.tools.emit_artifact_contract`, which contains the shared `ArtifactInput` schema and result contract without importing LangChain.
- The LangChain-decorated backend tool `deerflow.sophia.tools.emit_artifact` wraps that same contract for the companion graph, so the Gemini declaration remains aligned with the real existing Sophia tool without forcing the voice runtime to import backend-only tool implementation dependencies.
- Relayed Gemini `emit_artifact` calls validate and execute the backend-owned `emit_artifact` signal contract and return a Live API `toolResponse.functionResponses[]` client action for the browser to send over the active WSS.
- Phase 11.2 adds the existing builder/lifecycle surface: `start_builder_task`, `check_async_task`, `update_async_task`, `cancel_async_task`, and `list_async_tasks`. Their declarations come from `deerflow.sophia.tools.builder_lifecycle_contract`, a lightweight contract mirroring the real companion/deepagents tool schemas.
- The Gemini relay executes builder/lifecycle calls through a backend-owned LangGraph HTTP bridge because the voice runtime intentionally does not import `deepagents`, `langgraph_sdk`, or LangChain tool implementation modules. The bridge launches real `sophia_builder` runs and stores session-scoped `async_tasks` keyed by builder thread id.
- `start_builder_task` uses the authenticated dogfood session user id as the trusted identity. A model-supplied `user_id` argument is diagnostic-only and cannot override the session user.
- Phase 11.3 hardens task-id chaining. `start_builder_task` is the first builder tool for a fresh build/create/generate/research request and returns the real task id. `check_async_task`, `update_async_task`, and `cancel_async_task` must only use ids returned by `start_builder_task` or recovered from `list_async_tasks` in the current trusted session. Unknown ids are not converted into false success and never cross session boundaries.
- When a lifecycle call references an unknown task id, the backend keeps rejecting it as tool execution but returns a Gemini-compatible `toolResponse.functionResponses[]` payload with `ok:false`, `error_type: "unknown_task_id"`, the rejected id, currently tracked ids, and recovery guidance. The browser still sends that `toolResponse` over the existing Gemini WSS, and the debug page distinguishes `Execution rejected` from relay degradation or provider transport failure.
- Assistant transcript and tool channels are isolated. Structured Gemini `toolCall` messages may become internal `TOOL_CALL_REQUESTED`, artifact payload, or builder candidate events, but raw pseudo-tool text such as `try{emit_artifact{...}}`, JSON-ish calls, or function expressions must not become public `sophia.transcript`.
- Unsupported Gemini function names are rejected by the backend executor and do not receive a tool response.

Declaration and execution stay separate. Gemini setup consumes a lightweight declaration contract; backend-owned relay execution remains real; the browser still only sends the returned `toolResponse` over the active Gemini WSS.

Remaining migration gaps:

- The full companion middleware chain still does not run inside the Gemini Live session; this phase imports prompt sources and selected existing tool contracts, not the entire LangGraph turn runtime.
- Mem0 writes, full skill routing, offline pipeline side effects, and production `/voice/connect` routing remain deferred.
- Normalized `sophia.*` events remain observability; they do not replace the provider `toolResponse` send-back required by Gemini Live.

## Phase 11.4 Gemini Production Readiness Gap Closure

Phase 11.4 keeps the default runtime at `legacy_cascade` and keeps Gemini Live on the internal dogfood route. The phase addresses readiness evidence and production-replacement gaps without switching the production browser voice path.

Debug evidence fix:

- `/debug/realtime/gemini` now preserves durable tool-loop session state separately from its capped recent diagnostic list.
- `Last start task id` remains visible after later lifecycle calls push the original `start_builder_task` diagnostic out of the display log.
- Rejected lifecycle ids are shown as rejected ids and recovery guidance, but they are not promoted into trusted tracked task ids unless the backend explicitly returns them as tracked ids or task-list entries.

Lifecycle validation status:

- Live Phase 11.3 evidence proved `start_builder_task` and `check_async_task` with real task id `019e41f8-51b3-7022-bf06-3ccf7dfe7464`.
- Phase 11.4 adds deterministic frontend send-back coverage for `update_async_task`, `list_async_tasks`, and `cancel_async_task` and backend HTTP request-shape coverage for the same lifecycle tools.
- `list_async_tasks`, `update_async_task`, and `cancel_async_task` still need live dogfood evidence. Fast builder completion can make manual update/cancel hard to catch, so live smokes should use longer-running builder work.

Production replacement status:

- The current production path still runs through `frontend/src/app/hooks/useStreamVoiceSession.ts`, gateway `/voice/connect`, voice-server `/calls/{call_id}/sessions`, Stream/Vision Agents, Deepgram, SmartTurn/SophiaTurnDetection, `ConversationFlowCoordinator`, `SophiaLLM`, Cartesia `SophiaTTS`, and `VoiceEventBroker` SSE.
- Gemini dogfood has proven browser-owned WSS setup/audio, ephemeral-token auth, normalized `sophia.*` event observation, backend-owned `emit_artifact`, builder start/check, and toolResponse send-back.
- Gemini has not yet replaced production route admission, production hook state, warmup, teardown, fallback, full companion middleware side effects, mobile/iOS permission behavior, or telemetry parity.

The detailed production gap audit is in `docs/audits/gemini-production-replacement-readiness-phase-11-4.md`. The next safe cutover phase should be a default-off Gemini production-route candidate with a `useGeminiLiveVoiceSession` hook shaped like the current Stream hook, internal pilot gating, live lifecycle proof, session lifetime handling, and a one-step rollback to `legacy_cascade`.

## Phase 12.0 Gemini Production Route Candidate

Phase 12.0 begins production-route integration without making Gemini unconditional. `/api/sophia/{user_id}/voice/connect` remains the admission point. The default path is still `legacy_cascade`, returning the existing Stream token/call payload and dispatching `/calls/{call_id}/sessions` exactly as before.

Gemini is selected only when all production gates are present:

| Gate | Required value |
|---|---|
| Runtime selector | `SOPHIA_VOICE_RUNTIME_MODE=gemini_live` |
| Global experimental gate | `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true` |
| Provider adapter gate | `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true` |
| Production route promotion | `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true` |
| Provider credential | `GOOGLE_API_KEY` or `GEMINI_API_KEY` on the trusted voice service |

When selected, the gateway does not mint Stream credentials. It proxies `POST /production/realtime/gemini/browser-sessions` on the voice service, receives a browser Live bootstrap, rewrites the public URLs to authenticated Next aliases under `/api/sophia/voice/gemini/*`, and returns `runtime: "gemini_live"` plus the ephemeral-token setup payload. Missing promotion or provider configuration fails closed with an explicit 409/502-style error; it does not silently fall back to legacy.

The voice service production wrapper lives in `voice/realtime/gemini_production_session.py`. It reuses the already-tested Gemini browser dogfood manager for ephemeral-token minting, relay ingestion, normalized `sophia.*` events, and toolResponse client actions, but exposes production URLs under `/production/realtime/gemini/*` and requires the production promotion flag.

The frontend keeps `useStreamVoiceSession` as the production hook. It branches only after `/voice/connect` returns `runtime: "gemini_live"`: legacy responses still join Stream, while Gemini responses open the browser-owned Live WebSocket with `connectGeminiBrowserLiveFromBootstrap`, relay provider server messages through `/api/sophia/voice/gemini/relay`, and consume the normalized SSE stream from `/api/sophia/voice/gemini/events`. Automatic preconnect is explicitly marked as `preconnect: true`; the gateway refuses it for Gemini so a Live session is not opened before user intent.

Rollback remains one step: unset `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED` or set `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`. The legacy cascade code path, Stream credentials, `/calls/{call_id}/sessions`, Deepgram, SmartTurn, DeerFlow, Cartesia, and existing SSE contract remain in place.

## Phase 12.1 Runtime-Aware Session Telemetry

Phase 12.1 makes the real Session UI telemetry panel runtime-aware. The source of truth is the runtime selected by the production admission path, not a frontend environment guess: `/voice/connect` returns `runtime` / `voice_runtime` as `"legacy_cascade"` for Stream/Vision Agents sessions and `"gemini_live"` for Gemini bootstraps, and the frontend hook carries that selection as `runtime` plus `runtimeTelemetry`.

The metrics builder now has a runtime summary union:

| Runtime | Panel behavior |
|---|---|
| `legacy_cascade` | Keeps the existing Stream/Vision Agents cascade metrics: Stream join latency, remote participant readiness, backend/TTS diagnostic timings, commit-boundary checks, legacy bottleneck cards, and existing regression markers. |
| `gemini_live` | Shows Gemini production telemetry: Gemini WSS stage/setup state, public SSE state, relay status/diagnostics, provider event count, output audio observations, tool-loop counts, artifacts, public diagnostics, and provider-neutral microphone/counter data. Legacy-only Stream join and raw backend/TTS latency labels are hidden. |

The Gemini production branch in `useStreamVoiceSession` now wires the helper's production-safe callbacks into telemetry: `onStage`, `onRelayStatus`, `onProviderEvent`, `onRelayDiagnostic`, `onWebSocketDiagnostic`, `onToolLoopDiagnostic`, and `onOutputAudio`. Public browser consumers still receive only normalized `sophia.*` events; provider-native payloads remain below the helper/relay boundary and are summarized as status/count metadata for the panel.

The telemetry panel is mounted in the real Session UI and displays an explicit runtime badge: `Runtime: Legacy Cascade` or `Runtime: Gemini Live`. This makes production dogfood evidence comparable without pretending both runtimes expose the same low-level latency surface.

## Phase 12.2 Production Session UI Parity

Phase 12.2 aligns the real `/session` product UI with the normalized Gemini production event stream. The transport remains the Phase 12.0 browser-owned Gemini Live route, and telemetry remains the Phase 12.1 runtime-aware surface. This phase only changes frontend event ingestion at the Session boundary.

Transcript behavior:

- `sophia.transcript` assistant partials remain cumulative, not deltas.
- Partial assistant transcripts update `partialReply` and now also enter the Session assistant-message path.
- Final assistant transcripts still set `finalReply`, clear `partialReply`, and append to the voice store once.
- `appendVoiceAssistantMessage` replaces the last voice assistant message as text grows, so partial-to-final transcript rendering updates one visible message rather than duplicating bubbles.

Artifact behavior:

- Live voice `sophia.artifact` payloads now pass through the same `parseArtifactsPayload` adapter used by text stream artifact parts.
- The adapter unwraps `{ artifact: { ... } }`, `{ payload: { ... } }`, and accidental double `{ data: { ... } }` envelopes when the outer object has no canonical top-level artifact fields.
- Companion artifacts remain separate from builder document artifacts. Builder outputs still use `builder_result`, `builder_artifact`, or `builderArtifact` and the builder artifact parser.

The detailed audit and smoke plan are in `docs/audits/gemini-production-session-ui-parity-phase-12-2.md`.

## Phase 12.3 Gemini Production Experience Hardening

Phase 12.3 hardens the first real Gemini production Session run without changing the default runtime. `legacy_cascade` remains the default; Gemini still requires the Phase 12.0 production promotion gates.

Interruption behavior:

- Gemini Live owns speech activity detection and emits `serverContent.interrupted` when user activity interrupts model output.
- The browser connector treats that message as authoritative local playback control: it stops all scheduled PCM output sources, clears the playback queue, and avoids scheduling audio from the interrupted event.
- `useStreamVoiceSession` records `gemini-interruption`, increments interruption/audio-flush telemetry, clears stale speaking UI, and returns presence to listening.
- No OpenAI-style `response.cancel` message is sent for this path.

Transcript behavior:

- Gemini `outputTranscription` remains the source of assistant text, but it is not assumed to be audio-synchronous.
- Gemini production partial assistant transcripts are paced before entering the Session assistant-message path, so delayed word-by-word fragments do not churn the visible transcript.
- Final `sophia.transcript` events still flush exact final text, clear the local partial, append to voice history once, and update the Session message path.
- Legacy cascade transcript handling keeps immediate partial behavior.

Builder and artifact truthfulness:

- Successful Gemini builder lifecycle tool executions now publish a `builder_task_payload` provider event, which the normalizer emits as public `sophia.builder_task` for the existing Session builder UI.
- `sophia.artifact` remains the only public companion artifact count. `artifactCount: 0` is therefore truthful event evidence, not a hidden UI fallback.
- Gemini telemetry now separately counts artifact tool calls, builder tool calls, backend execution rejections, and provider tool-call cancellations. This distinguishes model contract misses from relay/normalizer failures.

The detailed audit and validation notes are in `docs/audits/gemini-production-experience-hardening-phase-12-3.md`.

## Normalization Behavior

`SophiaEventNormalizer` in `voice/realtime/normalizer.py` defines the Phase 1 mapping:

| Provider event | Public Sophia event |
|---|---|
| `user_transcript_partial` | No public event in Phase 1 |
| `user_transcript_final` | `sophia.user_transcript`, then `sophia.turn` with `phase: user_ended` |
| `response_started` | `sophia.turn` with `phase: agent_started` |
| `assistant_audio_started` | `sophia.turn` with `phase: agent_started` |
| `assistant_text_delta` | Accumulated `sophia.transcript` with `is_final: false` |
| `assistant_text_final` | `sophia.transcript` with `is_final: true` |
| `artifact_payload` | `sophia.artifact`, optionally through an artifact validator hook |
| `builder_task_payload` | `sophia.builder_task` |
| `response_ended` | `sophia.turn` with `phase: agent_ended` |
| `assistant_audio_ended` | `sophia.turn` with `phase: agent_ended` |
| `response_cancelled` | `sophia.turn` with `phase: agent_ended`, then `sophia.turn_diagnostic` |
| `response_interrupted` | `sophia.turn` with `phase: agent_ended`, then `sophia.turn_diagnostic` |
| `provider_error` | `sophia.turn` with `phase: agent_ended` if a response is active, then `sophia.turn_diagnostic` |
| `provider_metric` | `sophia.turn_diagnostic` |
| tool/candidate events | Internal-only in Phase 1 |

The normalizer guards duplicate `agent_started` and `agent_ended` emissions per response id so a provider can emit both response and audio lifecycle events without double-flipping the frontend stage.

Public assistant transcript payloads are replaceable current snapshots, not raw provider chunks. `sophia.transcript.data.text` is the full current assistant transcript for the active response/segment at that point; `is_final: false` is a replaceable partial snapshot, and `is_final: true` replaces/finalizes the last partial. Frontend reducers must replace the active assistant text instead of appending public transcript payloads together.

Provider adapters may still emit true `assistant_text_delta` events internally when the provider contract guarantees deltas. If provider semantics are uncertain, the adapter should mark the event with `transcript_assembly: "auto"` and let `SophiaEventNormalizer` merge the provider text safely before public emission. The auto path handles duplicate chunks, cumulative snapshots, revised snapshots, suffix/prefix overlap, and whitespace-safe fragment appends.

Assistant transcript buffers reset on response cancellation/interruption, and response end clears the active segment pointer. Providers that split one apparent answer around tool calls may supply an internal `segment_id`; the normalizer uses it to keep tool-adjacent continuations from being merged with pre-tool text. Segment ids are internal assembly metadata and are not part of the public `sophia.transcript` payload.

## Future Adapter Requirements

Future adapters must:

- Implement `RealtimeProviderSession` without emitting `sophia.*` events directly.
- Map provider wire events into `ProviderEventType` values.
- Fill `ProviderCapabilities` from verified provider behavior, not assumptions.
- Preserve structured tool semantics for `emit_artifact`, builder task events, and tool results.
- Map provider voice controls from `DeliveryIntent` through provider-specific delivery code.
- Route provider errors and cancellation into normalized diagnostics.
- Keep raw provider event names out of frontend consumers.

OpenAI is now the reference implementation for those requirements, but it is not the active production runtime.

## Out Of Scope For Phase 1

- No OpenAI API integration.
- No Gemini API integration.
- No `voice/server.py` runtime switch.
- No legacy cascade adapter wrapper.
- No frontend behavior changes.
- No gateway API changes.
- No replacement of existing artifact validation in `SophiaLLM`.

## Out Of Scope For Phase 3

- No OpenAI API integration.
- No Gemini API integration.
- No active runtime switch in `voice/server.py`.
- No routing of production turns through `SophiaRealtimeTurnRuntime`.
- No frontend, gateway, SSE broker, Stream, Deepgram, Cartesia, SmartTurn, or `ConversationFlowCoordinator` behavior changes.
- No public shadow events. Shadow parity diagnostics stay in process and logs.
- No change to Deepgram, Cartesia, SmartTurn, or `ConversationFlowCoordinator`.

## Out Of Scope For Phase 4

- No active runtime switch in `voice/server.py`.
- No production sessions routed through OpenAI Realtime.
- No OpenAI SDK, WebSocket, or WebRTC transport dependency added to the voice service.
- No change to default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
- No frontend, gateway, Stream, Deepgram, Cartesia, SmartTurn, or `ConversationFlowCoordinator` behavior changes.

## Out Of Scope For Phase 5

- No active runtime switch in `voice/server.py`.
- No production sessions routed through Gemini Live.
- No Google SDK, WebSocket, or WebRTC transport dependency added to the voice service.
- No change to default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
- No frontend, gateway, Stream, Deepgram, Cartesia, SmartTurn, or `ConversationFlowCoordinator` behavior changes.
- No claim that Gemini Live replaces DeerFlow companion turns, builder routing, or artifact validation yet.

## Out Of Scope For Phase 6

- No change to default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
- No production rollout of OpenAI or Gemini realtime providers.
- No OpenAI SDK, Google SDK, WebSocket, or WebRTC transport dependency added to the voice service.
- No removal of Deepgram, Cartesia, SmartTurn, `SophiaLLM`, or `ConversationFlowCoordinator`.
- No public provider-native event names emitted to the frontend.
- No shadow parity on experimental provider modes; Phase 3 shadow parity remains legacy-cascade only.

## Out Of Scope For Phase 7

- No change to default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
- No production rollout of OpenAI or Gemini realtime providers.
- No full browser microphone/audio routing to OpenAI WebRTC or Gemini Live WebSocket.
- No removal of Stream, Vision Agents, Deepgram, Cartesia, SmartTurn, `SophiaLLM`, or `ConversationFlowCoordinator`.
- No raw provider event names emitted on the dogfood SSE stream or existing frontend contract.
- No provider-native shadow parity; dogfood sessions stream normalized public events and remain separate from legacy shadow diagnostics.

## Out Of Scope For Phase 8A

- No change to default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
- No production rollout of OpenAI Realtime.
- No modification of `/voice/connect`, `useStreamVoiceSession`, Stream, Deepgram, Cartesia, SmartTurn, `SophiaLLM`, or `ConversationFlowCoordinator`.
- No Gemini browser transport.
- No raw OpenAI event names on public SSE or frontend state APIs.
- No browser exposure of `OPENAI_API_KEY`; the browser receives only the ephemeral OpenAI client secret.

## Out Of Scope For Phase 8B

- No change to default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
- No production rollout of Gemini Live.
- No modification of `/voice/connect`, `useStreamVoiceSession`, Stream, Deepgram, Cartesia, SmartTurn, `SophiaLLM`, or `ConversationFlowCoordinator`.
- No OpenAI-style Gemini backend sideband claim.
- No raw Gemini event names on public SSE or frontend state APIs.
- No browser exposure of `GOOGLE_API_KEY` or `GEMINI_API_KEY`; the browser receives only the ephemeral Google Live auth token.

## Out Of Scope For Phase 9

- No change to default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
- No production rollout or provider promotion.
- No provider transport redesign.
- No replacement of `/voice/connect`, `useStreamVoiceSession`, Stream, Deepgram, Cartesia, SmartTurn, `SophiaLLM`, or `ConversationFlowCoordinator`.
- No claim that OpenAI or Gemini is better before manual run records exist.
- No broad analytics or dashboard system. The Phase 9 helper is an internal summary utility over normalized public payloads only.

## Out Of Scope For Phase 10.9

- No change to default `SOPHIA_VOICE_RUNTIME_MODE=legacy_cascade`.
- No production rollout of Gemini Live.
- No backend ownership of the Gemini Live WebSocket.
- No broad Sophia tool registry, builder-task execution, memory writes, or production companion-runtime claim.
- No browser-side execution of tools. The browser only sends the backend-returned `toolResponse` payload to Gemini.

## Phase 2 Compatibility Validation

Focused bridge tests live in `voice/tests/test_realtime_legacy_cascade_bridge.py`. They cover successful cascade turns, builder task preservation, cancellation/interruption, stage errors, duplicate lifecycle markers, artifact validator compatibility, and existing turn diagnostic payloads. They are intentionally isolated from the live voice service so production behavior remains unchanged.

## Phase 3 Shadow Validation

Focused Phase 3 tests live in `voice/tests/test_realtime_runtime_selection.py`, `voice/tests/test_realtime_shadow_parity.py`, and the shadow-related cases in `voice/tests/test_sophia_llm_streaming.py`. They prove runtime mode parsing and rejection, diagnostic result taxonomy, stable-field comparison, dynamic-field tolerance, disabled-by-default behavior, and unchanged public event emission when the shadow flag is enabled.

## Phase 4 OpenAI Adapter Validation

Focused Phase 4 tests live in `voice/tests/test_openai_realtime_provider_adapter.py`. They cover capability declaration, explicit feature-flag construction, raw OpenAI GA event mapping through `SophiaEventNormalizer`, structured `emit_artifact` function-call handling, `response.done` fallback tool-call parsing, builder task tool-result mapping, cancellation diagnostics, and outbound client event shapes. Phase 6 config and runtime-selection tests prove the adapter flag does not promote OpenAI into an active runtime by itself.

## Phase 5 Gemini Adapter Validation

Focused Phase 5 tests live in `voice/tests/test_gemini_live_provider_adapter.py`. They cover capability declaration, explicit feature-flag construction, raw Gemini Live message mapping through `SophiaEventNormalizer`, structured `emit_artifact` function-call handling, tool-call cancellation diagnostics, transcript-surface deduplication, setup/client-message outbound shapes, and the one-setup-per-connection guard. Phase 6 config and runtime-selection tests prove the adapter flag does not promote Gemini into an active runtime by itself.

## Phase 6 Runtime Activation Validation

Focused Phase 6 tests live in `voice/tests/test_realtime_runtime_selection.py`, `voice/tests/test_realtime_runtime_factory.py`, and `voice/tests/test_config.py`. They prove default legacy selection, experimental double opt-in, provider adapter flag requirements, shadow-parity rejection on provider-native modes, factory construction for selected sessions, and comparative smoke coverage for legacy, OpenAI, and Gemini through the same public `sophia.*` normalizer boundary.

## Phase 7 Dogfood Validation

Focused Phase 7 tests live in `voice/tests/test_realtime_dogfood_session.py`, plus updated coverage in `voice/tests/test_config.py` and `voice/tests/test_server_readiness.py`. They prove legacy dogfood rejection, OpenAI and Gemini dogfood event pumps, provider credential requirements, the Google/Gemini API key alias, and the legacy-only guard on the Stream/Vision Agents session route.

## Phase 8A Browser Dogfood Validation

Focused Phase 8A tests live in `voice/tests/test_openai_browser_dogfood.py`, `frontend/src/__tests__/openai-browser-webrtc-dogfood.test.ts`, and the OpenAI route case in `frontend/src/__tests__/api/voice-session-proxy.route.test.ts`. They prove OpenAI `rtc_*` call-id validation, backend-only standard key use, ephemeral client-secret payload shape, sideband messages flowing through adapter plus normalizer, safe endpoint failure for legacy runtime, frontend SDP/sideband sequencing, and authenticated proxy routing.

## Phase 8B Browser Dogfood Validation

Focused Phase 8B tests live in `voice/tests/test_gemini_browser_dogfood.py`, `frontend/src/__tests__/gemini-browser-live-websocket-dogfood.test.ts`, the Gemini cases in `frontend/src/__tests__/api/voice-session-proxy.route.test.ts`, and the Gemini gateway cases in `backend/tests/test_voice_gateway.py`. They prove backend-only standard key use, ephemeral auth-token payload shape, setup/setupComplete sequencing, browser-relayed Gemini messages flowing through adapter plus normalizer, rejection of client audio relay payloads, safe endpoint failure for legacy runtime, and authenticated proxy routing.

## Phase 9 Comparative Evaluation Validation

Focused Phase 9 helper tests live in `voice/tests/test_dogfood_evaluation.py`. They prove complete normalized event summaries, missing required event detection, interruption/provider-error marker detection, and public provider-event leak detection. The manual Phase 9 protocol and run template are documentation artifacts and are not unit-tested as static markdown.

## Phase 12.4B Gemini Production Reliability Correlation

Phase 12.4B keeps the Gemini production route behind the same explicit gates: `SOPHIA_VOICE_RUNTIME_MODE=gemini_live`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true`, `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true`, and a backend Google/Gemini key. The route remains browser-owned Gemini Live WebSocket plus authenticated backend relay; the public browser contract remains normalized `sophia.*` events only.

The reliability surface now records correlation evidence across the full production path:

- Browser provider-message categories: `setupComplete`, `serverContent`, input/output transcription, model-turn audio/text, tool calls, tool-call cancellation, GoAway, session resumption, usage metadata, and provider errors.
- Browser relay traces with correlation id, attempt/success/failure counts, HTTP status, duration, response kind, client-action count, tool-diagnostic count, and safe backend diagnostics snapshots.
- Browser tool-call ledger entries keyed by Gemini function-call id, tracking received, cancelled, relay started/completed, backend accepted, toolResponse prepared/sent, stale-send suppression, and final state.
- Backend relay diagnostics for accepted provider events, provider categories, extracted function calls, cancellation ids, tool execution phases, provider events pushed into the mapper, mapper output counts, and emitted public `sophia.*` counts.

Official Google Live API semantics confirmed the minimal behavior fixes. `toolCallCancellation` means a previously issued tool call should not have been executed and should be cancelled; the browser now suppresses stale `toolResponse` send-back for ids already cancelled. Backend execution tracks cancellations that arrive before execution and while execution is in flight; if a side effect completed after cancellation, diagnostics say so honestly and the stale client action is not returned. With automatic VAD enabled, manual mic pause sends `audioStreamEnd`; the Gemini connector gates outgoing audio frames while muted and the Session hook keeps user mute intent durable across stage callbacks and soft barge-in UI transitions.

This phase does not rewrite Sophia prompts, replace the runtime, add SSE replay, or fake public continuity counts. Missing public transcripts, artifacts, or builder events must be investigated by comparing provider category counts, mapper outputs, and public `sophia.*` emissions rather than treating healthy WSS/audio as sufficient proof.

## Phase 12.4C Voice Telemetry Export Scoping

Phase 12.4C narrows the default Session voice telemetry download to a current-run diagnostic report. The export remains available from the Session telemetry panel as `reportType: "voice-telemetry-report"`, but schema version `2` intentionally excludes broad persisted app state.

The default report keeps:

- Report metadata: `reportType`, `version`, `source`, and `exportedAt`.
- Runtime summary and metrics, including runtime label, stage, health/bottleneck/regression summary, session ids, timing metrics, microphone/audio counters, transcript/artifact/builder counters, and Phase 12.4B Gemini correlation counters.
- A scoped `captureBundle` containing only the active run window: the last `start-talking-requested` event onward when present, current-session-id events as a fallback, or a bounded recent window as a final fallback.
- Phase 12.4B diagnostic events such as `gemini-provider-event-correlation`, `gemini-relay-trace`, and `gemini-tool-call-ledger`, with the existing capture cap preserved.
- A minimized snapshot with current session/thread/run ids, compact session status, microphone summary, debug status, presence labels, and UI counts needed by the metrics builder.

The default report intentionally excludes:

- Persisted localStorage/Zustand state such as `sophia-session-store`, `sophia-recap`, `sophia-session-history`, conversation history, connectivity queues, and snapshot stores.
- Archived Session records and prior conversation/message arrays not tied to the active diagnostic run.
- Persisted recap artifacts, old prepare/text session metadata, and prior artifact history.
- Raw rendered transcript text and rendered artifact text from the snapshot. Current-run normalized event payloads remain available when they are part of the scoped capture window.

Credential hygiene is part of the export boundary. Auth-bearing transport material such as Gemini Live `access_token` WebSocket query values, `auth_tokens/...` segments, bearer tokens, API keys, client secrets, and token/secret-shaped diagnostic fields are redacted in downloaded telemetry while preserving transport type, host/path, and non-sensitive status/counter evidence.

No advanced full-debug export mode is currently exposed. The previous broad snapshot had diagnostic convenience, but it mixed unrelated persisted app history into the default report and made Gemini production reliability exports noisy and risky to share. Reintroduce a full snapshot only behind an explicit developer/debug affordance with a clear history/privacy warning.

## Phase 12.4E User Transcript Continuity And Builder State Surfacing

Phase 12.4E keeps the Gemini production route behind the same explicit gates and does not make Gemini the default runtime. The route is still browser-owned Gemini Live WebSocket plus authenticated backend relay, and the public Session contract is still normalized `sophia.*` SSE only.

Gemini `serverContent.inputTranscription` is public continuity evidence only after it becomes `sophia.user_transcript`. The mapper now accepts the observed provider category through the documented object shape and narrow aliases: `text`, `transcript`, or a string transcription value. Empty values still produce no public event. The normalizer remains the only layer that emits `sophia.user_transcript` and the paired `sophia.turn` `user_ended` phase.

Durable Session events now survive late public SSE subscribers. `RealtimeDogfoodSession` keeps its normalized public payload history; new subscribers replay only the durable state events `sophia.user_transcript` and `sophia.builder_task`. This avoids replaying assistant transcript finals while closing the race where Gemini WSS/microphone startup or backend lifecycle execution can publish user transcript or builder state before the browser EventSource is attached or after a transient reconnect.

Builder lifecycle surfacing remains event-based. Successful Gemini `start_builder_task`, `check_async_task`, `update_async_task`, and `cancel_async_task` executions publish trusted `sophia.builder_task` payloads with the existing task id/status fields. The Session UI and telemetry must count builder visibility from those public events, not from Gemini `builderToolCallCount` alone. Builder artifact storage/download behavior is unchanged; artifacts remain on the existing builder artifact path, while this phase only makes lifecycle state visible.

Telemetry health now distinguishes a provider/public continuity gap from a microphone gap. If Gemini provider telemetry shows `inputTranscription` but the current run has zero `sophia.user_transcript` events, the bottleneck is classified as public continuity/transport rather than microphone capture. Public transcript and builder counts remain actual normalized-event counts only; no optimistic counters were added.

## Phase 12.4F Gemini Output Transcript Assembly Correctness

Phase 12.4F keeps Gemini behind the same explicit production gates and does not make it the default runtime. The route remains browser-owned Gemini Live WebSocket plus authenticated backend relay, and the public Session contract remains normalized `sophia.*` SSE only.

The observed malformed assistant text was an output-transcript assembly problem, not a prompt rewrite problem. Gemini `serverContent.outputTranscription` is documented as model output transcription, but its messages are independent of other server messages and should not be treated as guaranteed append-only deltas. The previous mapper labeled every output transcription text chunk as `is_delta: true`, so the normalizer blindly appended provider text and could produce overlaps such as joined words, duplicated phrases, or revised partials pasted after older partials.

Gemini output transcription now enters the normalizer with `transcript_assembly: "auto"` and internal segment metadata. `SophiaEventNormalizer` owns public assembly: cumulative snapshots replace prior text, duplicates/subsets are ignored, overlapping fragments merge by suffix/prefix overlap, likely revised snapshots replace the old partial, and only true fragments append with safe whitespace boundaries. Plain `serverContent.modelTurn.parts[].text` remains a normal explicit delta path.

The public `sophia.transcript` payload shape did not change. Session consumers still receive `{ text, is_final }`; `text` is a full replaceable current snapshot, never an instruction to append. Gemini partial pacing in `useStreamVoiceSession` still coalesces partial snapshots before rendering and flushes exact final text. `appendVoiceAssistantMessage` continues to replace the active voice assistant message so cumulative snapshots do not create duplicate bubbles.

Turn-boundary hygiene is part of the fix. Cancellation/interruption clears assistant transcript buffers for the active response, response end clears the active segment pointer, and tool-call-adjacent Gemini continuations use an internal segment id so post-tool text does not inherit pre-tool transcript state.

The detailed audit and validation notes are in `docs/audits/gemini-output-transcript-assembly-phase-12-4f.md`.

## Phase 12.4G-A Gemini Assistant Transcript Corruption Forensics

Phase 12.4G-A was investigation-only after fresh production Session evidence still showed assistant transcript word-order corruption after Phase 12.4F. No transcript behavior fix was applied.

The forensic finding is that public transcript correctness requires source-order preservation, not only smarter text merging. The browser currently receives Gemini WebSocket messages in callback order, assigns local relay trace correlation ids, then launches relay POSTs fire-and-forget. The relay body carries the raw provider event but not the browser's provider receive sequence, provider receive timestamp, or local correlation id. The backend therefore maps and normalizes events in HTTP arrival/processing order. `GeminiLiveEventMapper.sequence` is assigned after backend processing and cannot recover the original provider order.

The Phase 12.4F auto assembler remains useful for cumulative snapshots, duplicates, overlaps, and simple revisions, but it is order-sensitive for non-overlapping fragments. Read-only simulations showed that the current merge helper can produce observed corruption prefixes such as `Yeah, loud and clear. to lock You ready your game?`, `tell I can't It has you that.`, and `Focus on staying When calm. pressure"I'm better...` when clean fragments are processed out of order.

The runtime contract gap is now explicit: Gemini transcript-bearing provider events need a source-order contract across browser relay, backend mapping, normalizer mutation, public SSE emission, and Session application. Until that exists, segment ids and replacement snapshots reduce duplication but do not prevent stale or reordered chunks from mutating the active assistant transcript.

The detailed forensic audit and next-phase recommendation are in `docs/audits/gemini-assistant-transcript-corruption-forensics-phase-12-4g-a.md`.

## Phase 12.4G-B Gemini Sequence-Safe Transcript Relay

Phase 12.4G-B implements the source-order contract identified by the 12.4G-A forensics while keeping Gemini behind the same production gates and keeping `sophia.*` as the only public frontend event surface.

The browser Gemini connector now assigns provider receive metadata at the WebSocket message boundary: `provider_receive_sequence`, `provider_received_at`, stable `relay_correlation_id`, and provider categories. Relayed messages also carry a contiguous `provider_relay_sequence` so the backend can order only the subset of provider messages that actually cross the relay. Continuity-critical relays use an ordered browser lane; cancellation still updates the browser ledger immediately.

The backend relay schema accepts this metadata beside the raw provider `event` instead of mutating the Gemini payload. `GeminiBrowserDogfoodSessionManager` validates source metadata, applies relayed events by contiguous relay sequence, buffers out-of-order arrivals until the missing predecessor arrives, rejects stale duplicate/lower sequences, and pushes the raw provider event into the session before long-running tool execution can delay transcript/boundary observation. The raw event stream stores metadata as internal context, and `GeminiLiveEventMapper` stamps resulting `ProviderEvent` values with source metadata such as `source_sequence` and `provider_relay_sequence`.

`SophiaEventNormalizer` now guards assistant transcript mutation with per-response/segment source-sequence state. Older transcript snapshots and late snapshots after cancellation/interruption/response boundaries become compact `sophia.turn_diagnostic` events rather than mutating the active transcript buffer. When source metadata exists, public transcript snapshots include non-breaking `source_sequence`, `response_id`, and `segment_id` fields; legacy/unsequenced payloads remain `{ text, is_final }`.

The frontend Session ingestion layer treats `sophia.transcript.data.text` as the current replaceable snapshot and additionally rejects stale snapshots for the same response/segment when `source_sequence` is present. Ignored stale snapshots are captured as diagnostics so visible transcript rendering has a final local guard even if an upstream layer regresses.

The expected user-visible effect is that clean provider fragments cannot be applied in inverted order to form phrases such as `to lock You ready`, `tell I can't It has you that`, or stale prior-response prefixes contaminating the next assistant answer. The detailed implementation audit is in `docs/audits/gemini-sequence-safe-transcript-relay-phase-12-4g-b.md`.

## Phase 12.4H-A Gemini Native Audio Output Forensics

Phase 12.4H-A does not change the public `sophia.*` event contract and does not promote Gemini as the default runtime. It clarifies that Phase 12.4G-B's source-order guarantees apply to relayed transcript/lifecycle events, not to browser-local native PCM audio chunks.

Gemini native output audio remains a browser-owned surface. Pure `serverContent.modelTurn.parts[].inlineData` audio messages are intentionally skipped by backend relay as `local_only`, decoded as raw PCM16 little-endian at 24 kHz, and scheduled through Web Audio in the browser. Because those chunks do not pass through the backend reorder buffer, transcript correctness cannot be used as proof of spoken-audio correctness.

The browser Gemini connector now exposes bounded `gemini-output-audio-chunk` diagnostics in current-run capture. These diagnostics carry non-raw chunk evidence: provider receive metadata when available, compact chunk hash, estimated byte length, chunk index, duplicate ordinal, decode timestamps, scheduled start time, duration, queue state before/after scheduling, and active source counts. Raw audio bytes are never exported. Provider-event correlation telemetry also carries bounded input/output transcription text previews so future reports can distinguish raw Gemini `outputTranscription.text` fragments from backend normalizer assembly artifacts.

The clarified runtime requirement is that any future Gemini native-audio correctness fix must preserve provider callback order before scheduling PCM playback. Assign receive metadata at WebSocket callback entry or serialize the parse/schedule lane, then schedule chunks by source order and reject stale post-interruption work. Backend transcript order protection alone is insufficient because pure audio does not cross that boundary.

The detailed forensic audit and next implementation recommendation are in `docs/audits/gemini-native-audio-output-forensics-phase-12-4h-a.md`.

## Phase 12.4H-B Gemini Over-Continuation And Turn Policy Forensics

Phase 12.4H-B is investigation-only. It does not change prompt files, Gemini setup, frontend rendering, runtime behavior, `soul.md`, or `lead_agent/`.

The audit narrows the double-reply class after the Phase 12.4H-A report. The captured hearing-check turn has no tool calls, no tool cancellations, no interruptions, and no playback flushes; the over-continuation is already present in public assistant transcript snapshots. A separate recommendation/focus example shows the same duplicate-intent shape outside greetings, so this must not be treated as a greeting-only issue.

The runtime contract gap is that Gemini Live native audio receives the full canonical Sophia companion prompt, but there is no Gemini-specific spoken-response policy that outranks the rest of the prompt and requires one main conversational intent, at most one question, and an immediate stop after the user's simple intent is satisfied. Existing short-response and one-question guidance remains useful, but it is too diffuse inside the larger identity, context, ritual, builder, and artifact prompt stack for Live native audio.

The recommended next phase is a narrow Gemini Live spoken turn policy overlay, tested against hearing checks, greetings, recommendation/focus asks, gaming focus, prepare ritual, life context, builder-adjacent asks, and pause-heavy utterances. VAD tuning, generation length controls, context slimming, classifiers, frontend presentation changes, and transcript/audio suppression are deferred until the overlay test matrix proves what remains.

The detailed forensic audit and root-cause report are in `docs/audits/gemini-over-continuation-turn-policy-phase-12-4h-b-audit.md`.

## Phase 12.4H-C Gemini Live Spoken Turn Policy Overlay

Phase 12.4H-C implements the narrow prompt-policy fix recommended by the 12.4H-B audit. It does not change `soul.md`, canonical Sophia skill files, context or ritual prompts, frontend transcript rendering, audio/transcript filters, Gemini relay infrastructure, runtime defaults, or the legacy cascade.

Gemini Live setup now uses `voice/realtime/sophia_prompt.py::build_gemini_live_realtime_instructions`, which preserves the canonical Sophia prompt assembly and appends a Gemini-specific `<gemini_live_spoken_turn_policy>` overlay. The base `build_sophia_realtime_instructions` path remains overlay-free so unrelated prompt paths are not silently changed.

The overlay is the spoken response contract for Gemini native audio:

- Speak as live audio and stop cleanly.
- Choose one main conversational intent per assistant turn.
- Answer the user's immediate intent first.
- Ask at most one question total in the spoken reply.
- Do not stack opener questions or ask the same clarification in different words.
- Hearing and connection checks get a brief acknowledgement, then stop or one light next-step prompt.
- Recommendation and focus prompts choose either one missing-context question or one concise recommendation.
- Emotional and coaching turns give one clear point and one optional next step rather than reframing the same point several ways.
- Artifact and builder/tool obligations stay structured; artifact fields, session goals, tone estimates, ritual phases, and internal bookkeeping are not narrated aloud.

The overlay sits after the voice artifact contract in the fully rendered Gemini `systemInstruction`. That placement keeps Sophia's identity and structured tool obligations intact while making the final spoken-output rule explicit for the provider that directly generates native speech. Config tuning remains deferred: VAD thresholds, `maxOutputTokens`, temperature/top-p, first-turn UI presentation, Gemini-specific prompt slimming, and intent classifiers should only be considered after the manual smoke matrix shows what policy alone did not solve.

Focused validation lives in `voice/tests/test_sophia_prompt.py` and the Gemini browser dogfood prompt assertions in `voice/tests/test_gemini_browser_dogfood.py`. Manual production Session smokes should cover hearing checks, simple greeting, recommendation/focus, gaming focus, calm-under-pressure coaching, and tool-adjacent reflection while watching for duplicate opener/clarifier stacking.

## Phase 12.4I Gemini Turn Capture And Intent Continuity Forensics

Phase 12.4I is investigation-only after a reported short but wrong-intent Gemini reflection reply: the user asked Gemini to `reflect briefly on what I just said`, and Gemini replied with a clarification shaped like `want me to focus on?` before the user clarified the intended antecedent was `I'm in control`.

The phase does not tune VAD, change `realtimeInputConfig`, edit the prompt overlay, modify Builder/storage UI, change default runtime selection, or apply a broad runtime fix. The exact telemetry archive for the bad turn was not available locally, so the result is a code-level and protocol-level root-cause classification rather than an event-id-accurate reconstruction.

The contract clarification is that Gemini production setup currently does not set `realtimeInputConfig`. Activity detection, pause tolerance, start-of-activity interruption behavior, and turn coverage are provider defaults. The browser sends continuous `realtimeInput.audio` while unmuted and sends `audioStreamEnd` on manual mute; normal hesitations and fillers are not local turn-boundary markers. Public `sophia.user_transcript` is observability after Gemini emits input transcription, not a same-turn context repair mechanism for the active Live model.

The leading suspect is therefore turn capture and intent continuity under provider-default automatic activity detection plus incremental realtime input, especially for pause-heavy or deictic utterances such as `what I just said`. Existing relay ordering, stale transcript guards, and tool-call-cancellation suppression make public transcript ordering, stale toolResponse, and Builder/storage UI lower-probability explanations unless future telemetry proves otherwise.

The recommended next phase is a narrow Gemini turn-capture evidence harness. It should capture ordered input/output transcription previews, interruption and turn-boundary flags, tool-call cancellation ids, mic mute/unmute and `audioStreamEnd` markers, public `sophia.*` payloads, and Session stage transitions for a small manual matrix around antecedent references, pauses, interruptions, and mute boundaries. VAD tuning or another prompt change should wait until that evidence identifies the failing layer.

The detailed forensic audit and next-phase decision table are in `docs/audits/gemini-turn-capture-intent-continuity-phase-12-4i.md`.

## Phase 12.4J Gemini Turn-Capture Evidence Harness

Phase 12.4J adds a compact, current-run scoped evidence harness for Gemini production Session telemetry exports. It does not tune VAD, change `realtimeInputConfig`, alter the Gemini spoken-turn policy, edit prompts, change tool/artifact behavior, promote Gemini as the default runtime, or implement Builder storage/output UI.

The harness lives at the Session telemetry boundary instead of the provider behavior boundary. `frontend/src/app/lib/turn-capture-diagnostics.ts` builds `turnCaptureDiagnostics.version = 1` from the already scoped current-run capture stream. The exported timeline correlates user input activity, sampled browser microphone frame sends, actual `audioStreamEnd` sends, provider input/output transcription previews, public `sophia.user_transcript` and `sophia.transcript` events, interruptions, turn boundaries, tool-call ledgers, artifact calls/cancellations, manual mute events, derived Session stage transitions, and public `sophia.*` event counts. It is bounded and sanitized: no raw audio bytes, no provider websocket credentials, no persisted session history, and no broad localStorage/Zustand snapshots.

The Gemini browser connector now emits `gemini-input-audio-activity` capture events from the microphone pipeline. These events are compact and sampled: early frames and periodic frames carry only local sequence, frame duration, estimated PCM16 byte length, represented frame count, mic state, and whether an `audioStreamEnd` was sent. Manual mute/unmute and stream-end markers are explicit. This proves whether a bad turn was preceded by local audio frames, a manual mute boundary, or an actual `audioStreamEnd` without exporting audio data.

The public normalizer now preserves optional provider source metadata on `sophia.user_transcript` when the Gemini mapper has it: `source_sequence`, `provider_relay_sequence`, `provider_received_at`, and `relay_correlation_id`. This makes provider input transcription and visible user transcript evidence joinable by sequence/correlation id, matching the assistant transcript source-order contract already introduced in Phase 12.4G-B.

Manual interpretation rule: use the harness to answer where the wrong-intent reply started before changing behavior. If provider input transcription is partial before an assistant output begins, suspect capture/VAD/turn segmentation. If provider input transcription is complete but the public `sophia.user_transcript` is absent or lacks matching source metadata, suspect mapper/normalizer/SSE continuity. If an interruption or `toolCallCancellation` precedes missing artifact/tool evidence, inspect cancellation order and ledger suppression. If `audioStreamEnd` appears at the failure point, check manual mute or stream boundary. Aggregate counters alone are not enough; read the ordered timeline and recent previews.

The detailed implementation note and manual smoke plan are in `docs/audits/gemini-turn-capture-evidence-harness-phase-12-4j.md`.

## Phase 12.4L Gemini Spoken Intent And Deictic Policy

Phase 12.4L is a Gemini Live-only prompt-policy hardening pass after the Phase 12.4J evidence run. It does not change Gemini `realtimeInputConfig`, VAD thresholds, activity handling, turn coverage, relay throughput/order, frontend transcript suppression, tool execution, Builder storage/output UI, runtime defaulting, or canonical Sophia identity files.

The existing `<gemini_live_spoken_turn_policy>` overlay now includes stricter spoken intent rules for native audio:

- Hearing and connection checks get a brief acknowledgement, then stop or one neutral next-step prompt.
- Generic greetings and hearing checks must not trigger gaming, work, ritual, lock-in, or session-prep assumptions unless the user explicitly introduced that context in the current turn or the immediately preceding user context.
- Recommendation/focus prompts choose one path: ask one missing-context clarifier or give one concise recommendation. Gemini should not stack context classification, improvement-target, work/gaming, and `tell me more` prompts in one spoken turn.
- Deictic reflection requests such as `what I just said`, `that`, or `what I just told you` bind to the latest complete user utterance or latest clearly stated phrase, not the whole broader conversation.
- Filler/setup phrases such as `quick question before I go`, `um`, `like`, `one more thing`, or `before I leave` are skipped when looking for the meaningful antecedent if the user continues with an actionable request.
- Structured artifact/tool obligations stay in tool calls and must not expand spoken output or narrate artifact/session-goal bookkeeping.

The base `build_sophia_realtime_instructions()` path remains overlay-free. Dogfood and production Gemini setup continue to use `build_gemini_live_realtime_instructions()` so the overlay is present in `systemInstruction.parts[0].text` for Gemini Live only.

VAD and turn tuning remain deferred. Official Gemini Live docs confirm `realtimeInput` is processed incrementally for fast response starts and that `realtimeInputConfig` can configure automatic activity detection, activity handling, and turn coverage; this phase intentionally leaves those setup fields unset because the targeted failure class can still be reduced by clearer spoken policy without changing capture behavior.

The detailed implementation note and manual smoke plan are in `docs/audits/gemini-spoken-intent-deictic-policy-phase-12-4l.md`.

## Phase 12.4M Gemini Memory Parity And Artifact Contract Hardening

Phase 12.4M closes two product-parity gaps in the default-off Gemini Live production candidate without changing VAD, `realtimeInputConfig`, relay throughput/order, runtime defaulting, Builder storage UI, or canonical Sophia identity files.

Legacy cascade voice turns already call DeerFlow `sophia_agent` through `runs/stream` with trusted `configurable.user_id`, `platform`, `context_mode`, and `ritual`. That path receives stored context through `UserIdentityMiddleware`, `SessionStateMiddleware`, and `Mem0MemoryMiddleware`. Gemini Live does not run the full LangGraph companion middleware chain inside the native audio session, and Gemini setup is first-message-only, so profile and memory context must be assembled before the Live setup payload is minted.

The Gemini production and browser dogfood session managers now build a setup-time `<gemini_live_user_context>` block from the authenticated session user id. The block may include a preferred name inferred from the stored user identity/handoff files, a bounded `identity.md` excerpt, a bounded latest handoff excerpt, and up to four bounded Mem0 memory snippets from the same `deerflow.sophia.mem0_client.search_memories()` path used by the companion middleware. The prompt block never uses a model-supplied user id, and diagnostics expose only compact presence/count/category/length/status metadata, not raw memory text.

The context block is inserted after the canonical Sophia realtime instructions and before the Gemini Live spoken-turn policy overlay. The overlay remains the final Gemini-specific policy layer, while the context block gives Live enough continuity to avoid generic `User` phrasing and answer direct memory questions from concrete stored context when available.

Artifact hardening now treats `reflection: "null"`, `"none"`, `"undefined"`, `"n/a"`, or an empty string as absent at multiple boundaries: the backend `emit_artifact` contract, the Sophia artifact middleware capture path, the Gemini provider artifact mapper, the live stream artifact parser, the artifact merge/status helpers, the presence artifact panel, and the recap artifact adapter. Real reflection questions still pass through normally.

The detailed implementation note and manual smoke plan are in `docs/audits/gemini-memory-parity-artifact-contract-phase-12-4m.md`.

## Phase 12.4K-B Gemini Transcript Coalescing Correctness Hotfix

Phase 12.4K-B restores Gemini transcript correctness after the failed Phase 12.4K live smoke. It does not change Gemini spoken policy, Mem0 behavior, artifact contracts, VAD, `realtimeInputConfig`, runtime defaulting, or the Phase 12.4G-B source-order guarantees.

The 12.4K live smoke proved that the coalescing assumption was unsafe. Spoken audio remained good, but visible captions became sparse and scrambled while telemetry reported high `transcriptPartialsCoalesced` and `transcriptPartialsDropped`. Provider preview telemetry showed clean ordered fragments such as `You're asking`, `for a`, `deeper`, and `understanding`, which means the raw non-final `serverContent.outputTranscription` stream behaved like delta-like semantic fragments in that run. Dropping pending raw fragments destroyed meaning before the backend normalizer could assemble the transcript.

Raw assistant `outputTranscription` fragments are now treated as non-droppable ordered critical relay events. The explicit ordered browser relay queue remains, provider receive metadata remains assigned at WebSocket callback time, `provider_relay_sequence` remains assigned only at send time, and backend/frontend stale sequence guards remain intact. `transcriptPartialsSent` still measures raw assistant partial throughput, while `transcriptPartialsCoalesced` and `transcriptPartialsDropped` stay zero for raw provider output transcription.

Throughput telemetry now carries `transcriptCoalescingDisabledReason: "provider_output_transcription_is_delta_like"` so current-run reports make the disabled coalescing policy explicit. Final transcript/turn-boundary events, user transcripts, tool calls, tool-call cancellations, interruptions, setup/lifecycle messages, errors, and turn boundaries remain non-droppable critical events.

Future caption-latency work should not reintroduce raw-fragment dropping. The safe path is a source-ordered browser accumulator that consumes every raw provider fragment, produces an app-assembled cumulative local snapshot, marks the payload as app-assembled, and only then coalesces replaceable local snapshots. That design remains deferred.

The detailed implementation note and manual smoke plan are in `docs/audits/gemini-transcript-coalescing-correctness-phase-12-4k-b.md`.

## Phase 12.4K Gemini Ordered Relay And Caption Throughput Cleanup

Phase 12.4K improves Gemini assistant caption freshness after Phase 12.4M without changing Gemini spoken policy, Mem0 behavior, artifact contracts, VAD, `realtimeInputConfig`, runtime defaulting, or the Phase 12.4G-B source-order guarantees.

The root cause was believed to be browser-side relay backlog, not backend transcript assembly. Phase 12.4K assumed Gemini `serverContent.outputTranscription` partials were replaceable snapshots, but Phase 12.4K-B later proved this unsafe for observed production output.

The browser Gemini connector now uses an explicit ordered relay queue with latest-snapshot coalescing for non-final assistant `outputTranscription` partials only. Superseded pending partials are dropped before relay and never receive a `provider_relay_sequence`. Relay sequence numbers are assigned at send time, so the backend still sees a contiguous relayed sequence and its Phase 12.4G-B reorder buffer cannot wait for a skipped local-only partial. Provider receive sequences may have gaps, and the normalizer intentionally accepts increasing non-contiguous `source_sequence` values while rejecting stale lower ones.

Final assistant transcript boundary events, user input transcription, tool calls, tool-call cancellations, interruptions, turn boundaries, errors, and setup/lifecycle events remain non-droppable. Cancellation is now part of the ordered critical relay lane so backend observation stays sequenced with surrounding transcript/tool events, while the browser-side tool ledger still records cancellation immediately for local send-back suppression.

Gemini Session caption pacing is reduced only on the Gemini path now that stale partials are coalesced before relay. Final assistant text still flushes exactly, and non-Gemini runtimes keep their existing transcript ingestion behavior.

Telemetry now reports relay throughput and coalescing counters in connector traces, Session runtime telemetry, derived developer metrics, and the scoped telemetry export: ordered queue depth, oldest queued age, partials coalesced/dropped/sent, final/non-droppable sends, transcript relay latency, p95 relay latency, and coalescing by segment. Coalescing diagnostics are captured separately as `gemini-transcript-partial-coalesced` current-run events.

The detailed implementation note and manual smoke plan are in `docs/audits/gemini-ordered-relay-caption-throughput-phase-12-4k.md`.

## Validation

Contract fixtures live in `voice/tests/test_realtime_normalizer.py` and cover:

- Legacy cascade-shaped event streams.
- Synthetic OpenAI-style realtime-shaped streams.
- Synthetic Gemini-style realtime-shaped streams.
- Artifact pass-through through a validator hook.
- Builder task pass-through.
- Cancellation/interruption mapping.
- Provider error mapping.
- Public event envelope preservation.