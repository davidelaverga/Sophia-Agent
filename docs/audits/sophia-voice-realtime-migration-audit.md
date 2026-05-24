# Sophia Voice Realtime Migration Audit

Date: 2026-05-17
Scope: audit only, no production implementation
Target migration: deprecate the current cascade voice stack and prepare a provider-neutral realtime runtime that can support OpenAI GPT-Realtime-2 and Gemini Live / Gemini native realtime audio.

## 1. Executive Verdict

Sophia is currently a custom cascade voice system running inside a Vision Agents harness. Vision Agents supplies the session runner, Stream WebRTC edge, and plugin interfaces, but Sophia's actual behavior is created by repo-local orchestration across Deepgram STT, custom SmartTurn extensions, a custom DeerFlow text-stream bridge, Cartesia TTS, custom flow repair, custom event mirroring, and frontend event interpretation.

The system is not ready for a provider swap by changing a single plugin. The provider-specific choices are embedded across `voice/server.py`, `voice/sophia_llm.py`, `voice/sophia_tts.py`, `voice/sophia_turn.py`, `voice/conversation_flow.py`, `voice/voice_delivery_profile.py`, `voice/adapters/deerflow.py`, `backend/app/gateway/routers/voice.py`, and `frontend/src/app/hooks/useStreamVoiceSession.ts`.

The safest migration path is not to point the browser directly at a realtime provider. Keep the voice service as the server-owned runtime boundary, preserve the existing browser-facing `sophia.*` event contract, and introduce a new provider-neutral realtime session layer behind that contract. That layer should normalize OpenAI and Gemini realtime semantics into Sophia events, tool calls, artifacts, builder task events, diagnostics, and lifecycle controls.

The reusable asset is the public contract: `sophia.user_transcript`, `sophia.turn`, `sophia.transcript`, `sophia.artifact`, `sophia.builder_task`, and `sophia.turn_diagnostic`. The least reusable asset is the cascade internals: Deepgram STT, Cartesia TTS, SmartTurn repair timing, and cascade-specific latency accounting.

## 2. Scope, Evidence, and Non-Goals

This audit inspected the current voice service, backend gateway, frontend consumers, adapters, tests, and voice-specific docs. Representative evidence includes:

- `voice/server.py`: session endpoints, SSE stream endpoint, warmup endpoint, Vision Agents runtime construction, Deepgram/STT wiring, Cartesia/TTS wiring, custom turn detection, flow coordinator, rhythm, runtime observers, and Stream join.
- `voice/sophia_llm.py`: backend text stream bridge, event emission, artifact validation, artifact normalization, background event scheduling, diagnostics, and TTS hooks.
- `voice/sophia_tts.py`: Cartesia emotion and speed mapping, warmup, transcript hinting, echo guard, audio interruption.
- `voice/sophia_turn.py`: SmartTurn subclass, adaptive silence, echo suppression, transcript-aware stabilization, fragment/continuation handling.
- `voice/conversation_flow.py`: cancel-and-merge, late continuation recovery, backend stall timers, acknowledgment playback, rhythm recording hooks.
- `voice/adapters/base.py`, `voice/adapters/deerflow.py`, `voice/adapters/shim.py`: normalized text-backend seam and DeerFlow `runs/stream` parsing.
- `backend/app/gateway/routers/voice.py`: public `/voice/connect`, `/voice/events`, `/voice/warmup`, and `/voice/disconnect` contracts.
- `frontend/src/app/hooks/useStreamVoiceSession.ts`, `frontend/src/app/hooks/useStreamVoice.ts`, `frontend/src/app/companion-runtime/voice-runtime.ts`, `frontend/src/app/session/stream-contract-adapters.ts`, and `frontend/src/app/lib/voice-runtime-metrics.ts`: browser lifecycle, EventSource consumption, Stream fallback, voice state, artifacts, builder tasks, and telemetry.
- Tests under `voice/tests/` and `frontend/src/__tests__/` covering streaming order, artifacts, TTS mapping, turn detection, flow repair, SSE, DeerFlow adapter payloads, voice startup, event dedupe, and telemetry.
- Voice plans and incident reports under `docs/plans/` and `docs/solutions/` explaining why the current custom behavior exists.

Non-goals for this document:

- No production code changes.
- No provider SDK selection.
- No API key or deployment changes.
- No change to `lead_agent/` or immutable Sophia constraints.
- No recommendation to weaken `emit_artifact`, platform signaling, builder task routing, or offline memory boundaries.

## 3. Target Spec Availability

Repository search did not find target-specific specs named for GPT-Realtime-2, Gemini Live, Gemini native realtime audio, provider-neutral realtime, or a newer frontend voice architecture spec. Searches for `GPT-Realtime`, `Realtime-2`, `Gemini Live`, `native realtime audio`, `provider-neutral`, and related file-name patterns returned no matching target specification files.

The repo does contain older and current voice architecture material for Vision Agents, Deepgram, Cartesia, SSE browser bridging, startup hardening, turn diagnostics, and latency work. Examples include:

- `docs/specs/04_backend_integration.md`
- `docs/specs/05_frontend_ux.md`
- `docs/specs/06_implementation_spec.md`
- `docs/plans/2026-04-06-001-feat-voice-sse-browser-bridge-plan.md`
- `docs/solutions/sophia-voice-mode-improvements-report-2026-04-12.md`
- `docs/solutions/sophia-voice-backend-findings-report-2026-04-13.md`
- `docs/solutions/integration-issues/sophia-voice-fragmented-turns-2026-04-01.md`
- `docs/solutions/integration-issues/sophia-voice-degraded-transcript-mapping-and-turn-closure-2026-04-02.md`

This audit therefore compares the current code against the migration direction supplied in the user request, not against a checked-in OpenAI/Gemini realtime spec. Any future implementation should begin by adding an explicit target runtime contract before touching production behavior.

## 4. Current End-To-End Runtime

Current live voice flow:

1. Browser calls the Next voice connect route.
2. Next proxies to the gateway `/api/sophia/{user_id}/voice/connect` route.
3. Gateway creates a Stream call id and token, then asks the voice service to start an agent session.
4. Voice service starts a Vision Agents session for the call.
5. Voice service binds platform, context mode, ritual, companion session id, and thread id to `SophiaLLM`.
6. Browser joins Stream WebRTC and opens an EventSource if `stream_url` is returned.
7. Vision Agents handles audio ingress through Stream.
8. Deepgram STT transcribes speech.
9. `SophiaTurnDetection` and `ConversationFlowCoordinator` decide when to submit or repair a turn.
10. `SophiaLLM` sends the finalized user text to the configured backend adapter.
11. `DeerFlowBackendAdapter` calls LangGraph `/threads/{thread_id}/runs/stream` with `assistant_id=sophia_companion`.
12. `SophiaLLM` emits browser-facing text events while the backend streams text.
13. Cartesia TTS speaks streamed text through `SophiaTTS`.
14. The backend eventually emits or exposes `emit_artifact`; `SophiaLLM` validates and normalizes it.
15. The same normalized event is fanned out through Stream custom events and the SSE broker.
16. Frontend consumes `sophia.*` events, updates voice state, ingests artifacts, and records metrics.

The important architectural fact is that audio, text, artifacts, and UI events are not one provider session. They are a cascade assembled by code in `voice/server.py` and repaired by several repo-local modules.

Code anchors:

- Session start and context binding live in `voice/server.py` around `start_sophia_session`.
- Browser-facing SSE is exposed by `stream_sophia_session_events` in `voice/server.py` and proxied by `voice_events` in `backend/app/gateway/routers/voice.py`.
- Runtime construction happens in `create_agent` in `voice/server.py`, which instantiates Deepgram STT, `SophiaTTS`, `SophiaLLM`, `SophiaTurnDetection`, `RhythmTracker`, and `ConversationFlowCoordinator`.
- The frontend opens EventSource and registers `sophia.*` listeners in `frontend/src/app/hooks/useStreamVoiceSession.ts`.

## 5. Vision Agents Harness Boundaries

Vision Agents is the session and media harness, not a provider-neutral Sophia runtime abstraction.

What Vision Agents currently provides:

- `AgentLauncher`, `Runner`, and FastAPI runner integration in `voice/server.py`.
- `Agent`, `StreamEdge`, and Stream call join/finish lifecycle.
- Plugin interfaces for STT, TTS, LLM, and turn detection.
- Event hooks for STT partial/final transcript, STT error, TTS synthesis start, and TTS audio.
- Stream custom event transport through `agent.send_custom_event`.

What Sophia adds outside generic Vision Agents behavior:

- Deepgram STT is explicitly instantiated in `create_agent`; STT turn detection is disabled so Sophia can own SmartTurn boundaries.
- `SophiaTurnDetection` subclasses Vision Agents SmartTurn and adds echo suppression, adaptive silence, transcript-aware fragment handling, stabilization plans, and diagnostics.
- `SophiaLLM` is not a normal LLM provider plugin. It is a bridge to a separate text agent over DeerFlow/LangGraph SSE and owns artifacts, diagnostics, and browser events.
- `SophiaTTS` subclasses Cartesia TTS and injects Cartesia-specific emotion/speed configuration.
- `ConversationFlowCoordinator` owns behavior that most native realtime providers also try to own: barge-in recovery, turn repair, cancellation, and backend stall fallback.

Migration implication:

- A provider-neutral realtime runtime can reuse Vision Agents only if Vision Agents remains a media/session shell and the new provider adapter can still control audio, turn, tool, and event semantics precisely.
- If OpenAI or Gemini native realtime sessions own VAD, interruption, response generation, tool calls, and audio output, the current Vision Agents plugin split becomes an awkward fit. The new runtime should be modeled around realtime session semantics first, then optionally hosted inside Vision Agents only if that does not duplicate turn ownership.

## 6. Backend Text Agent Contract

The current `BackendAdapter` seam is useful, but it is a text-backend seam, not a realtime-provider seam.

Current shape in `voice/adapters/base.py`:

- `BackendRequest`: text, user id, platform, ritual, context mode, session id, thread id.
- `BackendEvent`: `text`, `artifact`, `builder_task`, or `error`.
- `BackendAdapter.stream_events`: yields normalized events for one assistant turn.
- `BackendAdapter.warmup`: optional prewarm for upcoming turn.

`DeerFlowBackendAdapter` implements that seam by calling `/threads/{thread_id}/runs/stream` with:

- `assistant_id` from settings.
- `input.messages` with one user text message.
- `config.configurable.user_id`, `platform`, `ritual`, `context_mode`, and `thread_id`.
- `stream_mode` of `messages-tuple`, `values`, and `custom`.
- `on_disconnect` set to `cancel`.
- `multitask_strategy` set to `rollback`.

That contract preserves important Sophia invariants:

- Every companion voice call passes `platform="voice"`.
- Companion responses come from `sophia_companion`.
- Artifacts are extracted from `emit_artifact` tool calls or final values.
- Builder task events are forwarded as normalized `BackendEvent.builder_task` payloads.
- Abandoned voice turns should cancel/rollback instead of lingering.

Why this is not enough for realtime provider migration:

- It assumes the user turn is text before the backend call starts.
- It assumes assistant text streams before TTS.
- It assumes artifact arrives after text completion.
- It has no representation for bidirectional audio streams, provider-native VAD, audio deltas, tool-call lifecycle, response cancellation, audio playback state, session configuration updates, or provider interruptions.
- It has no provider capability model. `voice/config.py` only supports `shim` and `deerflow` backend modes.

Migration implication:

- Keep `BackendAdapter` as a legacy text-agent bridge during transition.
- Add a separate `RealtimeProviderSession` abstraction for provider-native sessions. Do not overload `BackendAdapter` with audio/session semantics.
- The new abstraction should normalize provider events into Sophia's public `sophia.*` events and internal artifact/tool/diagnostic events.

## 7. Browser and Gateway Event Contract

The browser-facing event contract is the strongest reusable boundary in the current stack.

Current public events:

- `sophia.user_transcript`: finalized user text plus `utterance_id`; consumed as the authoritative visible user turn.
- `sophia.turn`: phase transitions such as `user_ended`, `agent_started`, and `agent_ended`; drives frontend `thinking`, `speaking`, and `listening` states.
- `sophia.transcript`: assistant text, partial and final; drives partial/final assistant UI messages.
- `sophia.artifact`: companion artifact payload; feeds session artifacts and TTS next-turn settings.
- `sophia.builder_task`: builder progress and terminal task state.
- `sophia.turn_diagnostic`: timing, duplicate phase counts, false-end counts, backend timings, and terminal reason.

Delivery paths:

- `SophiaLLM._emit_call_event` sends Stream custom events through `agent.send_custom_event`.
- `voice/server.py` attaches a runtime emitter that also publishes the same payload to `VoiceEventBroker`.
- `VoiceEventBroker` formats SSE frames with `event: <type>` and JSON `type/data` envelope.
- `backend/app/gateway/routers/voice.py` proxies the voice service SSE stream to `/api/sophia/{user_id}/voice/events`.
- `frontend/src/app/api/sophia/[userId]/voice/events/route.ts` proxies the gateway SSE stream to the browser.
- `frontend/src/app/hooks/useStreamVoiceSession.ts` prefers SSE when available and ignores duplicate Stream custom delivery after SSE opens.

The frontend is already designed around this event contract, not around raw provider messages. `handleSophiaEvent` in `frontend/src/app/hooks/useStreamVoiceSession.ts` maps `sophia.transcript`, `sophia.user_transcript`, `sophia.artifact`, `sophia.builder_task`, and `sophia.turn` into app state. `frontend/src/app/lib/voice-runtime-metrics.ts` also derives pipeline metrics from the same events.

Migration implication:

- Preserve the `sophia.*` browser contract as the public compatibility layer.
- Providers should never leak raw event names directly into the frontend.
- New provider-specific events should terminate at a normalizer in the voice service.
- If the new runtime needs additional detail, add internal provider events and public diagnostic extensions deliberately, not as ad hoc frontend branches.

## 8. Session Lifecycle, Warmup, and Cleanup

Current lifecycle is split across browser, Next proxy, gateway, voice service, Vision Agents, Stream, backend warmup, TTS warmup, and active-session maps.

Key lifecycle surfaces:

- Gateway `/voice/connect` creates Stream credentials, closes any previous active voice session in the background, starts a voice agent session, and returns `thread_id`, `stream_url`, and `session_id`.
- Gateway `/voice/events` proxies the voice-service SSE stream.
- Gateway `/voice/warmup` schedules backend and TTS warmup for an active session.
- Gateway `/voice/disconnect` asks the voice service to close the agent session and removes active-session tracking.
- Voice service `/calls/{call_id}/sessions` starts a Vision Agents session and binds runtime context.
- Voice service `/calls/{call_id}/sessions/{session_id}/events` streams events from `VoiceEventBroker`.
- Voice service `/warmup` schedules `SophiaLLM.start_backend_warmup()` and `SophiaTTS.start_warmup()`.
- Voice service close paths call `launcher.request_close_session` and `voice_event_broker.close_session`.
- Frontend preconnects, reuses prepared credentials, opens EventSource, triggers warmup, joins Stream, binds remote audio, enables the microphone after join, and cleans up on stop/barge-in/unmount.

This is a mature lifecycle, but it is cascade-specific in places:

- Warmup has separate DeerFlow thread/run setup and Cartesia TTS priming.
- Startup readiness depends on Stream remote participant session ids.
- Cleanup assumes a Vision Agents session id and Stream call id.
- Disconnect cleanup does not know about provider-native realtime sessions yet.

Migration implication:

- Keep the public lifecycle API shape where possible: connect, events, warmup, disconnect.
- Extend connect response with provider/runtime metadata only after the new runtime contract is explicit.
- Rework warmup as provider-neutral `prepare_session` with provider-specific internals: provider session creation, model/session config upload, optional audio voice warmup, and Sophia context prefetch.
- Ensure disconnect cancels provider realtime responses, closes provider sockets/WebRTC sessions, closes Stream or future media surfaces, and emits a terminal diagnostic.

## 9. Turn Detection, Barge-In, and Flow Repair

Turn behavior is one of the highest-risk migration areas because current logic duplicates responsibilities that native realtime providers often own.

Current turn stack:

- Deepgram emits transcript events.
- `SophiaTurnDetection` wraps SmartTurn and adds echo suppression so Sophia's own TTS does not trigger VAD.
- `SophiaTurnDetection.update_transcript` adjusts trailing silence based on word count, continuation signals, fragment starts, finality, and rhythm offset.
- `get_submission_stabilization_plan` lets `voice/server.py` delay backend submission for short, non-final, fragment, or continuation-like transcripts.
- `ConversationFlowCoordinator.on_turn_ended` starts fragile-window and backend-stall state.
- `ConversationFlowCoordinator.on_partial_transcript` can cancel the current LLM/TTS path and queue merged continuation recovery.
- `recover_late_continuation` and `consume_pending_recovered_response` repair cases where the user continues after an early turn close.
- `SophiaTTS.stop_audio` aborts Cartesia response streams and starts echo cooldown.
- Frontend `softBargeIn` and `bargeIn` mutate browser state and stop or reset current audio/control paths.

Tests confirm this behavior is load-bearing:

- `voice/tests/test_sophia_turn.py` covers echo suppression, adaptive silence tiers, continuation signals, fragment starts, and submission stabilization.
- `voice/tests/test_conversation_flow.py` covers fragile-window cancel-and-merge, acknowledgment ordering, pending recovered turns, backend stall callbacks, repeat suppression, and late continuation recovery.
- `voice/tests/test_turn_diagnostics.py` covers duplicate phase suppression, false-end counting, final-text fallback, and cancel-and-merge timing re-anchoring.

Migration implication:

- Do not blindly layer provider-native VAD on top of `SophiaTurnDetection`; that risks double turn closure and double interruption.
- The new runtime needs a single turn authority mode per provider: provider-owned, Sophia-owned, or hybrid with clear responsibility boundaries.
- Preserve the user-visible semantics: finalized user transcript once, response cancellation on real barge-in, no duplicate assistant replies, and diagnosable turn closure.
- If a provider supplies native interruption and turn events, normalize them into `sophia.turn` and diagnostics, then retire equivalent cascade repair logic for that provider.
- Keep the old `ConversationFlowCoordinator` behind a legacy cascade adapter until parity tests prove provider-native turn handling is good enough.

## 10. Artifact, Voice Delivery, and Emotion Coupling

Artifacts are central to Sophia. They are also tightly coupled to the current cascade.

Current artifact contract:

- `REQUIRED_ARTIFACT_FIELDS` in `voice/adapters/base.py` requires 13 fields: `session_goal`, `active_goal`, `next_step`, `takeaway`, `reflection`, `tone_estimate`, `tone_target`, `active_tone_band`, `skill_loaded`, `ritual_phase`, `voice_emotion_primary`, `voice_emotion_secondary`, and `voice_speed`.
- `DeerFlowBackendAdapter` extracts artifacts from `emit_artifact` tool use and/or final values.
- `SophiaLLM._validate_artifact` fills safe neutral defaults for missing voice delivery fields, rejects missing core fields, then normalizes delivery.
- `SophiaLLM._normalize_artifact` can rewrite tone band, primary emotion, secondary emotion, and speed based on user transcript and assistant response intent.
- `SophiaTTS.update_from_artifact` queues voice settings for future speech.
- `SophiaTTS.hint_emotion_from_transcript` provides current-turn delivery hints before a real artifact exists.
- `resolve_voice_delivery` combines assistant text, queued artifact, transcript hints, user transcript classifiers, and safe family mapping to choose a Cartesia emotion and speed label.

Current provider lock-in:

- `SPEED_MAP` maps Sophia labels to Cartesia `generation_config.speed` floats.
- `CARTESIA_EMOTIONS` is a Cartesia-specific emotion vocabulary.
- The runtime assumes artifact voice fields influence the next TTS call, while current-turn speech may already have started from hints or prior artifact.

Migration implication:

- Keep the 13-field companion artifact as a Sophia semantic contract.
- Split `voice_emotion_primary`, `voice_emotion_secondary`, and `voice_speed` into provider-neutral delivery intent before mapping to provider-specific controls.
- Add per-provider delivery mappers: OpenAI realtime mapper, Gemini realtime mapper, legacy Cartesia mapper.
- Decide whether native realtime speech should use pre-response delivery hints, response-time provider instructions, or post-turn artifact-only metadata. The current next-turn Cartesia model does not map cleanly to provider-native audio that starts while the model is still deciding.
- Preserve `emit_artifact` as a tool call or equivalent structured provider tool event. Do not parse artifact JSON from assistant text.

## 11. Observability, Benchmarks, and Tests

The current observability stack is unusually rich and should be preserved, but much of it measures cascade stages.

Current observable signals:

- `SophiaLLM` records backend request start, first backend event, first text, backend completion, final text, TTS audio, stage errors, duplicate phases, and terminal diagnostics.
- `TurnDiagnosticsTracker` emits `sophia.turn_diagnostic` payloads.
- `voice/adapters/deerflow.py` logs DeerFlow stream open and first backend event timings.
- `frontend/src/app/lib/voice-runtime-metrics.ts` computes startup, transport, microphone, pipeline, bottleneck, regression, and recent-turn summaries from captured events.
- Docs report live validation around startup, backend request start, first text, first audio, backend completion, and bottleneck classification.

Current test coverage to preserve:

- `voice/tests/test_sophia_llm_streaming.py`: text chunks before artifact, artifact required after text, event ordering, builder task forwarding, chunk splitting, artifact forwarding.
- `voice/tests/test_sophia_tts.py`: Cartesia emotion/speed mapping, warm default, artifact persistence, hinting, warmup.
- `voice/tests/test_sophia_turn.py`: echo suppression, adaptive silence, stabilization, continuation and fragment signals.
- `voice/tests/test_conversation_flow.py`: cancel-and-merge, late continuation, backend stall, repeat suppression.
- `voice/tests/test_sse_broker.py`: SSE frame formatting, publish/stream delivery, close-session behavior.
- `voice/tests/test_deerflow_adapter.py`: `/runs/stream` payload, text/artifact extraction, warmup, errors, explicit thread reuse, cancellation/rollback semantics.
- `voice/tests/test_config.py` and `voice/tests/test_adapter_selection.py`: backend mode limits and adapter selection.
- `frontend/src/__tests__/hooks/useStreamVoiceSession.test.ts`: startup readiness, EventSource open, SSE preferred over custom events, event handling, dedupe, stages.
- `frontend/src/__tests__/architecture/live-voice-artifact-contract.test.ts`: voice artifacts and final transcripts routed into canonical companion runtime.

Migration implication:

- Add provider-neutral contract tests before provider implementation.
- Reuse the existing `sophia.*` event tests as cross-provider compatibility tests.
- Add provider fixture streams for OpenAI and Gemini event shapes at the normalizer boundary.
- Split telemetry into provider-neutral phases and legacy cascade-only phases. For example, `requestStartToFirstTextMs` can remain, but `backendToFirstAudioMs` means something different when the provider itself emits audio.
- Keep old cascade tests as legacy adapter tests until the stack is fully removed.

## 12. Provider Lock-In and Reusable Seams

Provider lock-in map:

| Area | Current coupling | Reusable? | Migration treatment |
|---|---|---:|---|
| Audio ingress | Stream WebRTC plus Vision Agents media | Partial | Keep initially if provider can be server-mediated; revisit if provider requires direct browser media. |
| STT | Deepgram plugin instantiated directly in `create_agent` | Low | Replace with provider-native input transcript events or provider STT adapter. |
| Turn detection | SmartTurn subclass plus custom repair | Partial | Keep semantics and tests; do not keep implementation if provider owns turns. |
| LLM | `SophiaLLM` bridges text to DeerFlow | Partial | Keep Sophia event/artifact semantics; replace with realtime session bridge. |
| TTS | Cartesia subclass plus Cartesia emotions/speeds | Low | Replace with provider audio output or provider-specific delivery mapper. |
| Text backend | `BackendAdapter` for DeerFlow text stream | Partial | Keep as legacy text-agent bridge; do not expand into realtime. |
| Browser events | `sophia.*` over SSE/custom | High | Preserve as public compatibility contract. |
| Gateway lifecycle | connect/events/warmup/disconnect | High | Preserve route shape where possible. |
| Artifact schema | 13-field companion artifact | High | Preserve, but decouple delivery mapping from Cartesia. |
| Builder events | normalized builder task payloads | High | Preserve through provider tool/event normalizer. |
| Diagnostics | turn diagnostic payloads | High | Preserve, but rename/add provider-neutral timings. |
| Frontend metrics | cascade-stage calculations | Partial | Keep UI/report shape; refactor stage semantics for native realtime. |

Most important reusable seam:

- The public event envelope: `{ "type": "sophia.*", "data": ... }`.

Most misleading seam:

- `BackendAdapter`. It looks like an adapter abstraction, but it only adapts text backend streams. Treat it as legacy-compatible, not provider-neutral.

## 13. OpenAI GPT-Realtime-2 Fit

Because no checked-in OpenAI realtime target spec was found, this section is based on the requested target category rather than repo-local API details.

Fit assessment:

- OpenAI realtime support should be implemented as a server-owned provider adapter, not as a frontend-only path.
- The adapter must expose bidirectional audio session lifecycle, provider session configuration, text/audio transcript events, response lifecycle events, provider tool calls, cancellation/interruption, and errors.
- The adapter must not leak raw provider events to the frontend. It should emit normalized internal events that the Sophia runtime converts to `sophia.*`.
- The adapter must support structured tool calls or an equivalent side channel for `emit_artifact`, builder task launch/progress, and memory retrieval if the native realtime model is acting as Sophia's conversational model.
- If DeerFlow remains the conversational brain for phase 1, OpenAI realtime would only replace STT/TTS/media and would still need a bridge to DeerFlow text. That is safer but does not fully use a native realtime conversational model.

Main compatibility gaps with current code:

- Current `SophiaLLM.simple_response` starts only after finalized text exists.
- Current TTS assumes Cartesia voice settings at synthesis time.
- Current artifact arrives after text; native realtime audio may start before a final artifact exists.
- Current turn repair assumes the server can cancel its own DeerFlow/TTS tasks; provider-native response cancellation must map cleanly to the same semantics.

OpenAI adapter acceptance tests should prove:

- One finalized user transcript produces one `sophia.user_transcript` event.
- Assistant text/audio start produces one `sophia.turn agent_started` event.
- Response completion produces final `sophia.transcript`, `sophia.artifact`, and `sophia.turn agent_ended` events in a stable order.
- Provider cancellation on user barge-in does not produce duplicate final transcripts or artifacts.
- Provider tool-call arguments for `emit_artifact` are validated through the same schema as DeerFlow artifacts.

## 14. Gemini Live Fit

Because no checked-in Gemini Live target spec was found, this section is also based on the requested target category rather than repo-local API details.

Fit assessment:

- Gemini Live should use the same server-owned `RealtimeProviderSession` abstraction as OpenAI.
- Gemini-specific event shapes, modality negotiation, audio format handling, session configuration, response lifecycle, and tool-call representation should stay inside a Gemini adapter.
- Public browser behavior should remain identical to the OpenAI path: `sophia.*` events plus existing lifecycle controls.
- Provider capabilities should be explicit. If Gemini supports a different set of voice controls than OpenAI or Cartesia, Sophia should map delivery intent to the closest supported controls and record the mapping in diagnostics.

Main compatibility gaps with current code:

- Current frontend readiness depends on a Stream remote participant id. A native Gemini session may not map to a Stream participant unless Stream remains the media shell.
- Current pipeline metrics assume separate STT, backend, and TTS phases. Gemini native audio collapses those phases.
- Current `voice/voice_delivery_profile.py` uses Cartesia-oriented emotion families and speed labels. Gemini will need a provider-specific mapper or a no-op/fallback when equivalent controls do not exist.
- Current warmup splits backend warmup and Cartesia warmup. Gemini will need provider session warmup, context upload, and maybe no separate TTS warmup.

Gemini adapter acceptance tests should prove:

- Gemini provider events normalize into the same `sophia.*` contract as OpenAI.
- Provider-native transcripts, assistant text, and audio lifecycle are sufficient for existing UI state transitions.
- Tool-call/artifact semantics remain structured and schema-validated.
- Missing or unsupported delivery controls degrade to safe companion delivery rather than intense or mismatched speech.

## 15. Migration Architecture and Deprecation Plan

Recommended target architecture:

```text
Browser
  -> Next voice proxy
  -> Gateway voice API
  -> Voice Runtime Service
       -> RealtimeSessionRuntime
            -> OpenAIRealtimeProviderAdapter
            -> GeminiLiveProviderAdapter
            -> LegacyCascadeProviderAdapter
       -> SophiaEventNormalizer
       -> ArtifactValidator
       -> DeliveryIntentMapper
       -> BuilderTaskBridge
       -> TurnDiagnostics
  -> SSE/EventSource back to browser as sophia.*
```

Core interfaces to design before implementation:

- `RealtimeProviderSession`: connect, configure, send audio/control input, cancel response, close, stream provider events.
- `ProviderEvent`: normalized internal events for user transcript partial/final, assistant text delta/final, assistant audio start/end, response start/end, tool call, tool result, interruption, error, and metrics.
- `SophiaTurnRuntime`: owns public `sophia.*` emission, artifact validation, builder task forwarding, diagnostics, and session lifecycle.
- `DeliveryIntent`: provider-neutral speech intent with family, intensity, pace, and optional provider-specific hints.
- `ProviderCapabilities`: declares audio input/output modes, tool-call support, voice controls, cancellation support, session update support, and transcript support.

Deprecation sequence:

1. Freeze and document the current `sophia.*` event contract with fixture tests. This is the compatibility rail.
2. Add provider-neutral runtime interfaces and fixture-only normalizer tests. No provider traffic yet.
3. Wrap the current cascade as `LegacyCascadeProviderAdapter` behind the new runtime contract. Behavior should remain unchanged.
4. Split frontend metrics into provider-neutral fields and legacy cascade fields. Keep old panels working.
5. Implement OpenAI realtime adapter behind a feature flag and test with recorded provider fixtures first.
6. Implement Gemini Live adapter behind the same abstraction and the same public contract tests.
7. Run shadow or pilot sessions where provider output is captured and compared against cascade contract expectations without changing all users.
8. Promote one native realtime adapter for internal dogfooding.
9. Remove direct frontend assumptions that only make sense for Stream/Vision Agents readiness if the new media path changes.
10. Retire Deepgram, Cartesia, SmartTurn, and ConversationFlow legacy paths only after parity gates pass for transcripts, artifacts, builder tasks, barge-in, diagnostics, and latency.

Minimum parity gates before deprecating cascade:

- `sophia.user_transcript` remains single-path and idempotent.
- `sophia.turn` phases remain stable and do not duplicate under provider interruption.
- `sophia.transcript` partial/final behavior remains compatible with the companion runtime.
- `sophia.artifact` is still structured, validated, and emitted every companion turn.
- Builder task events still reach `frontend/src/app/session/stream-contract-adapters.ts` successfully.
- Voice delivery intent remains companion-safe across grief, excitement, challenge, reflective, and steady turns.
- Barge-in cancels active provider response without stale audio or duplicate assistant messages.
- Diagnostics distinguish provider session startup, user transcript finalization, response start, first audio/text, artifact completion, cancellation, and terminal errors.
- Gateway connect/events/warmup/disconnect continue to work for the selected runtime.

Highest-risk migration items:

- Artifact timing: native realtime audio may start before artifact metadata exists.
- Turn ownership: provider-native VAD and Sophia custom SmartTurn repair can conflict.
- Voice delivery: Cartesia emotion/speed controls are not portable.
- Frontend metrics: current bottleneck analysis assumes STT -> backend -> TTS cascade phases.
- Tool calls: `emit_artifact` must remain structured, required, and schema-validated.
- Session ownership: secrets, memory, builder tools, and artifacts belong server-side; browser-direct provider sessions would bypass too many Sophia boundaries unless heavily proxied.

Recommended first implementation ticket after this audit:

Create a provider-neutral realtime runtime contract and fixture test suite without changing the active runtime. Include one fixture stream for the legacy cascade, one synthetic OpenAI-style realtime stream, and one synthetic Gemini-style realtime stream. All three should normalize to the same `sophia.*` public events and artifact validation path. That gives the migration a real seam before any production provider is wired in.