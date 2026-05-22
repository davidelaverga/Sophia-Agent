# Phase 12.5A - Realtime Context Value And Middleware Parity Decision Report

Date: 2026-05-21
Status: decision report only; no implementation
Source branch: `fix/gemini-transcript-coalescing-correctness-phase-12-4k-b`
Working branch: `audit/realtime-context-value-decision-phase-12-5a`
Audience: Davide and Sophia product/technical team

## Executive Summary For Davide

Yes, Gemini Live is still missing full legacy cascade parity. That does not mean the right move is to copy the whole DeerFlow/Sophia middleware stack into Gemini Live or GPT Realtime.

The current recommendation is **hybrid selective realtime parity**, not full middleware parity inside the native realtime model. Keep trusted identity, preferred name, compact profile/handoff context, and a small number of relevant memories in setup. Add deeper memory/profile retrieval as explicit on-demand tools. Handle memory writeback, recap, and session-state persistence asynchronously after finalized turns. Keep artifact and builder bookkeeping structured and out of spoken prompt context. Avoid putting the full cascade in the critical audio path unless product explicitly chooses determinism over realtime feel.

The main strategic risk is optimizing for theoretical 1:1 parity and accidentally making voice worse. Native realtime models are sensitive to prompt bloat, competing instructions, tool overload, stale memories, and blocking calls. Prior Gemini phases already showed this: rich canonical Sophia context plus artifact/builder/session instructions helped parity, but without a Gemini-specific spoken-turn overlay it also produced over-continuation, duplicate openers, and deictic confusion.

What should be implemented next: a small realtime memory/profile tool phase, shared across Gemini Live and GPT Realtime where possible, with strict trusted-user-id binding, bounded outputs, privacy-minimized diagnostics, and manual smoke tests for explicit memory questions. After that, add sideband memory writeback/session recap from finalized public transcripts so memory improves without blocking speech.

What should be avoided for now: full Mem0 dumps, full per-turn Sophia middleware execution before every realtime answer, broad tool registry exposure, artifact/builder/session bookkeeping injected as natural-language context, VAD tuning as a substitute for missing evidence, and making Gemini the default runtime before this context policy is staged and measured.

## Phase Safety And Git State

Required git safety was performed before edits:

- Source branch before this phase: `fix/gemini-transcript-coalescing-correctness-phase-12-4k-b`.
- Current branch for this report: `audit/realtime-context-value-decision-phase-12-5a`.
- `main` was not checked out, edited, committed to, or pushed.
- The migration worktree was already broadly dirty before this phase, including Gemini realtime code, frontend tests, user runtime artifacts, `COMPOUND_LOG.md`, `docs/common-pitfalls.md`, and `docs/architecture/sophia-realtime-runtime-contract.md`.
- This phase is docs-only. It does not modify middleware, memory tools, prompt identity files, VAD, Gemini spoken policy, artifact behavior, relay/caption behavior, runtime defaults, or canonical Sophia identity files.
- No commit or push is part of this phase.

## Evidence Base Read

Docs reviewed:

- `COMPOUND_LOG.md`
- `docs/common-pitfalls.md`
- `docs/architecture/sophia-realtime-runtime-contract.md`
- `docs/audits/gemini-memory-parity-artifact-contract-phase-12-4m.md`
- `docs/audits/gemini-live-spoken-turn-policy-phase-12-4h-c.md`
- `docs/audits/gemini-spoken-intent-deictic-policy-phase-12-4l.md`
- `docs/audits/gemini-transcript-coalescing-correctness-phase-12-4k-b.md`
- `docs/audits/gemini-turn-capture-evidence-harness-phase-12-4j.md`
- `docs/audits/gemini-native-audio-output-forensics-phase-12-4h-a.md`
- `docs/audits/gemini-over-continuation-turn-policy-phase-12-4h-b-audit.md`
- `docs/audits/gemini-sequence-safe-transcript-relay-phase-12-4g-b.md`
- `docs/audits/gemini-turn-capture-intent-continuity-phase-12-4i.md`
- `docs/testing/sophia-gemini-browser-live-dogfood-phase-8b.md`
- `docs/testing/sophia-openai-browser-webrtc-dogfood-phase-8a.md`
- `docs/testing/sophia-realtime-comparative-dogfood-phase-9.md`
- `docs/debug/gemini-live-fully-rendered-sophia-prompt.md`

Code areas reviewed:

- Legacy cascade: `backend/app/gateway/routers/voice.py`, `voice/server.py`, `voice/adapters/deerflow.py`, `voice/sophia_llm.py`, `voice/realtime/legacy_cascade.py`.
- Gemini Live: `voice/realtime/sophia_prompt.py`, `voice/realtime/gemini_memory_context.py`, `voice/realtime/gemini_live.py`, `voice/realtime/gemini_browser_dogfood.py`, `voice/realtime/gemini_production_session.py`, `voice/realtime/gemini_tool_loop.py`, `voice/realtime/sophia_backend_tools.py`, `voice/realtime/normalizer.py`.
- GPT Realtime/OpenAI: `voice/realtime/openai_realtime.py`, `voice/realtime/openai_browser_dogfood.py`.
- DeerFlow Sophia companion: `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`, `state.py`, and the middleware files for crisis, platform, user identity, session state, tone guidance, context adaptation, ritual, skill routing, Mem0 memory, artifact, build awareness, builder command, and prompt assembly.
- Artifact contracts: `backend/packages/harness/deerflow/sophia/tools/emit_artifact_contract.py`, `emit_artifact.py`, and `middlewares/artifact.py`.
- Memory/session/profile: `backend/packages/harness/deerflow/sophia/mem0_client.py`, `offline_pipeline.py`, `handoffs.py`, `identity.py`, `tools/retrieve_memories.py`, `tools/start_builder_task.py`.

## Current State

Gemini Live has improved substantially. It has real browser-owned Live WSS transport, setupComplete gating, user transcripts, source-ordered transcript relay, sequence-safe public transcript assembly, native audio diagnostics, tool cancellation suppression, bounded setup-time user context, `emit_artifact` execution, selected builder lifecycle tools, and runtime-aware public `sophia.*` events.

The remaining gap is architectural. Legacy cascade is a finalized-turn backend agent path. Gemini Live is a native realtime session that receives setup once, owns audio turn formation, and calls backend tools through a relay. These are different systems. Treating parity as "run every cascade middleware inside Gemini every turn" would likely damage the reason realtime providers are attractive in the first place: low-latency natural speech.

## Why Full Parity Is Risky

Full cascade parity sounds attractive because the legacy stack already knows Sophia: identity, session state, Mem0, tone bands, rituals, active skills, artifacts, builder state, and public events. But native realtime has different failure modes:

- **Latency:** blocking every voice response on memory search, prompt assembly, agent routing, and tool/state refresh can add hundreds of milliseconds to seconds.
- **Prompt bloat:** full identity, full handoff, full tone files, full artifact contract, full tool contract, and many memories compete for instruction priority.
- **Over-continuation:** prior Gemini phases showed that rich context plus artifact/builder obligations can cause multiple spoken intents unless a provider-specific spoken policy constrains it.
- **Tool instability:** too many tools increase accidental calls, cancellations, stale tool responses, and pseudo-tool speech leakage.
- **Stale context:** setup-time or cached context can be old; per-turn retrieval can be fresh but costly and distracting.
- **Privacy exposure:** dumping memory/profile context into prompt or telemetry increases the chance that sensitive details are spoken, logged, or shared.
- **Debuggability:** a full cascade-in-the-loop creates two agents shaping one spoken response, making failures harder to classify.

Higher parity is not automatically better in realtime voice. The goal is Sophia-like behavior with realtime stability, not a literal internal topology clone.

## Legacy Cascade Capability Map

### Legacy Flow Diagram

```text
Browser voice UI
  -> gateway /api/sophia/{user_id}/voice/connect
  -> voice server /calls/{call_id}/sessions
  -> Stream/Vision Agents call session
  -> browser microphone through Stream SDK
  -> Deepgram STT and Sophia turn detection
  -> SophiaLLM.simple_response(finalized user text)
  -> DeerFlowBackendAdapter
  -> LangGraph /threads/{thread_id}/runs/stream
  -> sophia_agent middleware chain
  -> memory/session/profile/context/tool prompt assembly
  -> Claude companion response + structured tools
  -> DeerFlow SSE messages/values/custom events
  -> SophiaLLM transcript/artifact/builder public events
  -> Cartesia TTS using artifact emotion/speed
  -> public sophia.* SSE and Stream custom events
```

### Legacy Capabilities

| Capability | Code / owner | Type | Timing | Prompt text | Reads data | Writes data | Artifact effect | Tool effect | Spoken/public behavior |
|---|---|---|---|---|---|---|---|---|---|
| User identity | `UserIdentityMiddleware` | Middleware | Per run/turn | Yes: `<user_identity>` | `users/{user_id}/identity.md` | No | Indirect | No | Personal continuity and user-specific context. |
| Preferred/display name | Identity file + stored handoff/memories | Prompt/repository | Per run/turn when identity exists | Yes | User files | Offline identity update | Indirect | No | Lets Sophia address the person naturally. |
| User profile | Identity, Mem0, handoff | Middleware/repository | Per run/turn plus offline | Yes | Files/Mem0 | Offline identity update | Indirect | No | Stable personalization and continuity. |
| Session state / smart opener | `SessionStateMiddleware` | Middleware | First turn only | Yes | `handoffs/latest.md` | Offline handoff later | Indirect | No | Opens from last session when appropriate. |
| Conversation history | LangGraph thread state + summarization | Runtime/middleware | Per turn | Yes, through messages/summary | Thread state | Checkpointer/state | Indirect | Tool context | Maintains local conversation continuity. |
| Recap/context compression | `SophiaSummarizationMiddleware`, offline recap | Middleware/offline | Triggered/asynchronous | Yes for summaries | Thread/users files | Recap JSON | Indirect | No | Keeps long threads usable and recap UI hydrated. |
| Platform context | `PlatformContextMiddleware` | Middleware | Per run/turn | Yes | Request configurable | State only | Indirect | No | Voice: 1-3 sentences; text: 2-5 sentences. |
| Ritual/context mode | `ContextAdaptationMiddleware`, `RitualMiddleware` | Middleware | Per run/turn | Yes | Skill files | State | Indirect | Biases skill/memory | Work/gaming/life/prepare/debrief/vent/reset behavior. |
| Tone guidance | `ToneGuidanceMiddleware` | Middleware | Per run/turn | Yes, one band | Previous artifact | State | Yes | Biases skill | Emotional calibration based on previous turn. |
| Skill routing | `SkillRouterMiddleware` | Middleware | Per run/turn | Yes, one skill | Current user text, tone, ritual, session data | `skill_session_data` | Yes | Biases memory/tool choice | Vulnerability, trust, challenge, crisis, etc. |
| Crisis fast path | `CrisisCheckMiddleware` + skill router | Middleware | Per run/turn before expensive context | Yes, minimal | Current user text | State flags | Indirect | Restricts downstream | Fast crisis redirect and context skipping. |
| Mem0 retrieval | `Mem0MemoryMiddleware`, `search_memories()` | Middleware/repository | Per run/turn, voice cache | Yes: `<memories>` | Mem0 | Cache only | Indirect | Builder enrichment | Relevant memory recall. |
| On-demand memories | `retrieve_memories` tool | Tool | Model-chosen | Tool result | Mem0 | No | Indirect | Tool | Answers explicit memory/reflect questions. |
| Mem0 writeback | `offline_pipeline`, extraction, `add_memories()` | Offline pipeline | After session | No live prompt | Thread state/messages/artifacts | Mem0 + review metadata | Long-term continuity | No live tool | Memory grows without in-turn latency. |
| Artifact contract | `ArtifactMiddleware`, `emit_artifact` | Middleware/tool | Every companion turn | Yes, contract | Previous artifact/builder result | State | Primary owner | Requires tool call | TTS emotion, session goal, next step, public artifact. |
| Artifact public events | `SophiaLLM`, `SophiaEventNormalizer` | Runtime/public event | During/after response | No | Backend events | Browser state | Direct | Tool result | Presence/Artifact panel and telemetry. |
| Builder state | `start_builder_task`, AsyncSubAgentMiddleware, BuildAwareness | Tools/middleware | Model-chosen + per turn status prompt | Bounded blocks | LangGraph async tasks | `async_tasks` | Builder synthesis | Lifecycle tools | Background build progress and completion. |
| Tool registry | `make_sophia_agent` tools list | Runtime/tooling | Agent construction | Tool schemas | Config/tool contracts | Tool side effects | Direct/indirect | Direct | `emit_artifact`, builder, memories, optional web tools. |
| Tool permissions | Tool wrappers and trusted runtime user id | Tooling | Per tool call | Minimal | Runtime config/state | Tool side effects | Direct/indirect | Direct | Prevents user_id/tool-id spoofing. |
| Telemetry/diagnostics | `SophiaLLM`, turn diagnostics, logs | Runtime | Per turn | No | Runtime timings/events | Logs/public diagnostics | Indirect | No | Debuggability, latency breakdown, stage health. |
| Error handling/recovery | Backend adapter, normalizer, voice server | Runtime | Per turn/session | No | Errors | Public diagnostics | Indirect | May cancel tools | User-visible failure states and recovery. |

## Gemini Live Current Capability Map

### Gemini Flow Diagram

```text
Gateway /voice/connect with Gemini gates
  -> voice production Gemini session manager
  -> build Gemini Live instructions once
       canonical Sophia prompt sources
       + bounded authenticated user context
       + Gemini spoken-turn overlay
       + selected function declarations
  -> mint ephemeral Google Live auth token
  -> browser opens Gemini Live WSS
  -> browser sends setup, waits for setupComplete
  -> browser streams microphone PCM16 to Gemini
  -> Gemini emits native audio, transcripts, tool calls, cancellations
  -> browser plays PCM audio locally
  -> browser relays server messages to backend
  -> backend source-order buffer + tool bridge
  -> ProviderEvent mapper
  -> SophiaEventNormalizer
  -> public sophia.* SSE
  -> Session UI / telemetry
```

### Gemini Capabilities After Recent Phases

| Capability | Gemini status | Evidence / behavior | Gap |
|---|---|---|---|
| Canonical Sophia prompt sources | Setup-time partial parity | `sophia_prompt.py` reads `soul.md`, `voice.md`, `techniques.md`, `AGENTS.md`, platform prompt, context file, optional ritual, artifact contract. | Not dynamic middleware execution. |
| Gemini spoken-turn policy | Gemini-specific | Overlay enforces one intent, one question, deictic handling, tool/artifact non-verbalization. | Gemini-only today; GPT needs its own verified policy. |
| Preferred name | Setup-time partial parity | `gemini_memory_context.py` extracts from trusted identity or handoff. | Only at setup; fallback if absent. |
| Identity/profile | Setup-time bounded parity | Identity excerpt max 1200 chars. | Not full profile; not refreshed mid-session. |
| Handoff/session context | Setup-time bounded parity | Latest handoff excerpt max 900 chars. | First setup only; no in-session refresh. |
| Mem0 snippets | Setup-time bounded parity | Up to four snippets, max 240 chars each, trusted user id, diagnostics without raw text. | No per-turn semantic retrieval; no full dump. |
| Mem0 writeback | Missing in realtime path | Legacy writes are offline after session; Gemini does not write memories directly. | Needs sideband/offline integration. |
| Session state/current goal | Partial via artifact/tool/public UI | Gemini gets setup handoff and artifact contract; public artifact can carry goals. | No full cascade state/checkpointer parity. |
| Conversation history | Provider-internal + current browser session | Gemini Live socket is stateful. | No full LangGraph conversation recap injection. |
| Platform context | Setup-time partial parity | Platform prompt is rendered into setup. | Not middleware-refreshed. |
| Ritual/context mode | Setup-time partial parity | Context/ritual files included if selected. | Can contribute to over-continuation if too heavy. |
| Tone band guidance | Mostly missing | Artifact contract names bands; full ToneGuidanceMiddleware is not run. | No per-turn band injection from previous artifact. |
| Skill routing | Missing | No SkillRouterMiddleware in Live session. | No active skill file selected per turn. |
| Crisis fast path | Missing/unknown | No Gemini-side deterministic pre-response crisis middleware in current Live path. | Needs a separate safety design; do not improvise in this phase. |
| Artifact contract | Tool-bridge partial parity | `emit_artifact` declaration comes from dependency-safe contract; tool calls execute backend-owned contract; public `sophia.artifact` emits. | Model may still miss tool call; not full companion enforcement. |
| Artifact null hardening | Full at contract boundaries | `reflection: "null"` normalized as absent across backend/provider/frontend. | None for null class. |
| Builder lifecycle tools | Tool-bridge partial parity | Gemini exposes start/check/update/cancel/list via backend HTTP bridge and session-scoped task ids. | Not full builder artifact/storage UI parity; live update/cancel evidence still limited. |
| Tool registry | Selected subset | `emit_artifact` and builder lifecycle only for Gemini. | No broad Sophia tool registry, no memory tool yet. |
| Tool permissions | Strong for current tools | Trusted session user id; model `user_id` ignored/diagnostic; unknown task ids fail closed. | Must remain strict if tools expand. |
| Public events | Public-event parity | ProviderEvent -> `SophiaEventNormalizer` -> `sophia.*`. | Events are observability; not provider tool response. |
| Transcript sequence safety | Strong for relayed text | Browser receive/relay sequences, backend buffer, stale guards, frontend stale rejection. | Raw native audio remains browser-local. |
| Turn-capture diagnostics | Diagnostic parity | Current-run telemetry captures provider/public transcript, mic activity, interruptions, tool ledgers. | Diagnostics do not repair provider context. |
| Telemetry export | Compact parity | Current-run scoped, redacted, no raw memory text. | Not broad history. |

### What Gemini Does Not Have

- Full per-turn Sophia middleware execution.
- Per-turn dynamic Mem0 retrieval based on the latest spoken utterance.
- Full memory writeback parity.
- Full cascade session-state/checkpointer parity.
- Full builder artifact/download UI parity in every production case.
- Full tool registry parity.
- Full conversation recap/history injection.
- Full tone/skill/ritual routing inside native audio.
- Full crisis fast-path parity.
- Mutable Gemini setup context while the Live session is open.

## Defining Parity Levels

| Level | Name | Definition | Example | Realtime caution |
|---:|---|---|---|---|
| 0 | No parity | Capability absent. | No memory tool. | May be acceptable if low value or dangerous. |
| 1 | Setup-time parity | Included once before realtime session starts. | Preferred name, bounded identity, bounded handoff. | Stale in long sessions; Gemini setup is immutable. |
| 2 | On-demand tool parity | Model can request backend capability when needed. | Search memory, get profile, check builder state. | Tool calls add latency and cancellation complexity. |
| 3 | Sideband parity | Backend updates memory/context asynchronously outside speech path. | Memory writeback, recap, compact cache. | Eventual consistency; may lag one turn. |
| 4 | Per-turn middleware parity | Middleware-like pass runs on every finalized user turn. | Dynamic Mem0, session-state refresh. | Can block realtime response and duplicate provider context. |
| 5 | Full cascade-in-the-loop parity | Every realtime answer depends on full Sophia agent/cascade. | Gemini waits on DeerFlow companion before speaking. | Highest latency, double-agent risk, hardest debugging. |

Recommendation: most realtime context should live at levels 1-3. Level 4 should be experimental and shadow/sideband-first. Level 5 should not be the current production path.

## Value / Risk / Trade-Off Matrix

| Capability | Current cascade behavior | Current Gemini behavior | User-facing value | Realtime risk | Latency impact | Prompt-bloat risk | Privacy/security risk | Tool/confusion risk | Spoken-output risk | Recommended treatment | Reasoning | If left out | If injected too much | Applies to | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Preferred name / display name | Identity/handoff/Mem0 can inform every turn. | Setup extraction from trusted files. | High | Low | None after setup | Low | Low if trusted | Low | Low | Always inject at setup | Tiny footprint, high personalization. | Generic "User" feel. | Minor unless mixed with private details. | Both | High |
| Basic identity/profile | Full identity file injected by middleware. | Bounded identity excerpt. | High | Medium | None after setup | Medium | Medium | Low | Medium | Inject bounded setup summary | Useful continuity, but should be curated. | Less continuity. | May reveal private/stale profile or bias every turn. | Both | High |
| Full profile dump | Full identity file in cascade prompt. | Not dumped beyond excerpt. | Medium | High | None after setup | High | High | Low | High | Do not add directly | Realtime does not need every profile line. | Some context missing. | Over-personalization and privacy exposure. | Both | High |
| Mem0 snippets | Per-turn retrieval, voice cache, category filters. | Setup-only, max 4 snippets. | High | Medium | Setup only | Medium | Medium | Low | Medium | Bounded setup snippets + on-demand search tool | Balanced continuity without full dump. | Misses deeper context. | Old/private memories spoken or irrelevant continuity. | Both | High |
| Full Mem0 dump | Not used; cascade searches. | Not used. | Medium in theory | Very high | High if large | Very high | Very high | Medium | Very high | Do not add directly | Search/summarize instead. | Some memory misses. | Prompt confusion, privacy risk, stale recall. | Both | High |
| Per-turn memory retrieval | Middleware calls Mem0 or voice cache. | Missing. | High | Medium-high | Medium-high if blocking | Low-medium | Medium | Low | Medium | Future on-demand tool or sideband cache; do not block every turn | Realtime turn-taking must stay fast. | Gemini misses latest-topic memory. | Latency and over-continuation. | Both | Medium-high |
| Memory writeback | Offline pipeline after session. | Missing in realtime. | High long-term | Medium | Should be none if sideband | None | High if unsafe | Low | Low | Sideband/asynchronous update | Memory should not block speech. | Realtime memories stagnate. | False/sensitive memories written too eagerly. | Both | High |
| Session handoff | First-turn middleware reads `latest.md`. | Bounded setup excerpt. | High | Medium | Setup only | Medium | Medium | Low | Medium | Bounded setup summary | Good continuity, setup-time fits Live. | Cold starts feel less continuous. | Old open threads dominate conversation. | Both | High |
| Conversation history/recap | Thread state plus summarization. | Provider state, no full recap injection. | Medium-high | Medium-high | Medium if refreshed | High | Medium | Low | High | Short setup recap; sideband refresh if needed | Enough continuity without full history. | Long sessions lose context. | Recap crowds immediate user intent. | Both | High |
| Platform context | Per-turn middleware. | Setup prompt. | High | Low | None after setup | Low | Low | Low | Low | Always setup inject minimal platform guidance | Directly shapes voice length. | Replies drift too long. | Too many platform details can sound internal. | Both | High |
| Context mode | Active file injected. | Active file injected at setup. | Medium | Medium | None after setup | Medium | Low | Low | Medium | Compact mode label + minimal hints | Useful if selected, risky if heavy. | Less domain fit. | Gaming/work/life assumptions leak into simple turns. | Both | High |
| Ritual | Active ritual file injected. | Optional setup injection. | Medium | Medium-high | None after setup | Medium-high | Low-medium | Low | High | Inject only when explicitly active; consider shorter realtime variant | Ritual helped Sophia but caused stacked prompts in Gemini. | Ritual flows weaker. | Over-continuation and session-agenda shifts. | Both | High |
| Tone guidance | One band per turn from previous artifact. | Missing except artifact schema/bands. | Medium-high | Medium | None if setup; high if per-turn | Medium | Low | Low | Medium | Defer direct injection; consider compact sideband or tool/state later | Per-turn band depends on previous artifact; not a setup-only fit. | Less emotional calibration. | Wrong/stale tone band can overfit speech. | Both | Medium |
| Skill routing | Deterministic per-turn SkillRouter. | Missing. | Medium-high | Medium-high | Medium if synchronous | Medium | Low | Medium | Medium-high | Do not add full router directly; evaluate shadow/sideband later | Skill choice depends on tone, ritual, message, session data. | Less specialized companion behavior. | More prompt conflict and wrong mode. | Both | Medium |
| Crisis detection | Deterministic fast path before expensive middleware. | Missing/unknown. | Very high safety | High if poorly done | Low if local/classifier | Low | High | Medium | Medium | Needs separate safety design, not full context dump | Safety is non-negotiable but must be deterministic/trusted. | Safety gap. | False positives/unsafe prompts or delayed response. | Both | Medium-high |
| Artifact contract | Required every turn via tool. | Tool bridge + setup contract. | High product state | Medium-high | Tool latency | Medium | Low | Medium | High if verbalized | Keep minimal structured contract; do not expand spoken prompt | Required for Presence/TTS but must stay non-verbal. | UI/TTS state missing. | Bookkeeping leaks into speech, over-continuation. | Both | High |
| Builder state | Async tasks, build awareness, lifecycle tools. | Selected builder tools and public events. | Medium-high | Medium-high | Tool latency/high for start | Medium | Medium | High | High | On-demand tool + UI surface, not always prompt | Users ask about builds, but constant state crowds speech. | Build progress unavailable in voice. | Model talks tasks unprompted or invents ids. | Both, with provider differences | High |
| Tool registry | Companion has artifact, builder, memories, optional web. | Gemini selected subset; OpenAI dogfood only limited. | Medium-high | High | Tool-dependent | Medium | High | High | High | Minimal high-value tools; permission-gated expansion | Too many tools confuse realtime model. | Missing explicit capabilities. | Accidental/cancelled/dangerous calls. | Both | High |
| Tool permissions | Trusted user id closures/runtime config. | Trusted session user id; model ids ignored. | Very high | Low | None | Low | High | Low | Low | Non-negotiable | Prevents prompt-injection identity/task spoofing. | Security gap. | If over-permissive, cross-user leakage. | Both | High |
| Telemetry/diagnostics | Turn diagnostics and logs. | Current-run scoped telemetry. | High for debugging | Low-medium | None to low | None | Medium | Low | Low | Keep outside prompt; export compact redacted diagnostics | Needed to classify failures. | Blind debugging. | App-state dumps and sensitive content leaks. | Both | High |
| Full middleware chain | Per-turn LangGraph companion. | Not in Live session. | High theoretical | Very high | Very high | Very high | Medium-high | High | Very high | Do not add to critical realtime path now | Would undermine native realtime advantages. | Some parity gaps remain. | Latency, double-agent behavior, brittle speech. | Both | High |

## Capability-by-Capability Analysis

### 1. Preferred Name / Display Name

What it does: gives Sophia the user's preferred name or display name from trusted stored context.

Why it helps: high emotional/product value for very little context. It prevents generic phrasing and makes the system feel continuous.

Why it may hurt: low risk if sourced only from authenticated profile/identity/handoff. Risk rises if the model can supply or override user id/name.

Recommendation: always setup-inject for Gemini Live and GPT Realtime from trusted authenticated context. If missing, fall back gracefully: avoid saying `User`; speak naturally without a name.

Do nothing: Gemini/GPT feel generic and may fail simple questions such as "what is my name?"

Add too much: if the name block drags in surrounding private profile details, privacy exposure increases without improving speech.

### 2. Basic Identity / Profile

What it does: captures stable user information, preferences, relationships, and broad continuity.

Why it helps: lets Sophia adapt without re-asking known facts.

Why it may hurt: full profile content can be stale, sensitive, or irrelevant to the current voice moment.

Recommendation: bounded setup summary only. Include preferred name, stable communication preferences, a few current commitments/open threads, and high-confidence facts. Exclude raw logs, low-confidence feelings, old transient states, internal file paths, review metadata, and broad relationship details unless they are relevant and non-sensitive.

Do nothing: realtime Sophia loses continuity.

Add too much: the model may over-personalize, mention private facts unprompted, or drag old context into simple turns.

### 3. Mem0 Memories

What it does: legacy cascade retrieves relevant memories through `Mem0MemoryMiddleware` and exposes deeper retrieval through `retrieve_memories`.

Why it helps: memory is central to Sophia's continuity.

Why it may hurt: full memory context can be stale, sensitive, and prompt-heavy. Per-turn search can block voice.

Recommendation: keep bounded setup snippets, relevance-ranked and category-filtered. Add a future on-demand memory/profile search tool for explicit memory questions. Do not inject full Mem0. Filter sensitive or low-confidence memories. Do not include raw memories in telemetry; export only counts/status/categories/lengths.

Do nothing: Gemini can answer some setup-memory questions but misses deeper, turn-specific context.

Add too much: the model may speak old/private details, confuse current intent, or sound like it is reciting a database.

### 4. Memory Writeback

What it does: legacy writes memories through the offline pipeline after session processing, not in the turn.

Why it helps: Sophia improves over time and remembers new facts.

Why it may hurt: direct realtime writes can create false memories from partial transcripts, interruptions, sarcasm, or unreviewed sensitive content.

Recommendation: sideband/asynchronous writeback from finalized public user transcripts and artifacts. It should not block speech. It should preserve confidence thresholds, review metadata, idempotency, and cache invalidation.

Do nothing: realtime memory stays mostly read-only.

Add too much: false or unsafe memories accumulate and become hard to unwind.

### 5. Session State / Current Goal

What it does: handoffs, smart openers, artifacts, and state fields track what the session is about.

Why it helps: voice can resume naturally and keep a coherent thread.

Why it may hurt: stale session goals can override the user's immediate intent. Artifact goals are internal product state, not spoken agenda.

Recommendation: small current-session state only. Setup should include a short handoff/open-thread summary. Artifact state should remain structured. Sideband can maintain a compact session cache for future turns.

Do nothing: sessions reset too much.

Add too much: Sophia sounds like it is forcing a plan or ritual onto simple conversation.

### 6. Conversation History / Recaps

What it does: cascade has thread state and summarization; offline pipeline writes recap envelopes and handoffs.

Why it helps: keeps long-running sessions coherent.

Why it may hurt: full history is too much for native voice setup and can make the model answer the previous topic instead of the latest user turn.

Recommendation: short bounded recap at setup, refreshed sideband if needed. No full history injection. If the user asks for history, use an on-demand tool.

Do nothing: long-session context degrades.

Add too much: realtime model over-continues from old context.

### 7. Platform Context

What it does: tells Sophia whether the channel is voice, iOS voice, or text, with length guidance.

Why it helps: this is small and directly affects spoken quality.

Why it may hurt: low risk, unless the prompt starts describing platform mechanics aloud.

Recommendation: always include minimal platform context in both Gemini and GPT Realtime setup.

Do nothing: responses drift too long or too text-like.

Add too much: the model may mention internal platform/channel details.

### 8. Ritual / Context Mode

What it does: work/gaming/life and active rituals shape Sophia's tone and question style.

Why it helps: domain fit is part of Sophia's product feel.

Why it may hurt: prior Gemini over-continuation analysis showed context/ritual prompts can collide: a recommendation prompt can trigger game context, ritual focus, and broad planning all at once.

Recommendation: include compact mode label and minimal behavior hints. Include fuller ritual prompt only when explicitly active. Consider realtime-specific shorter ritual summaries later.

Do nothing: Sophia loses domain flavor.

Add too much: simple greetings become session prep; one question becomes several.

### 9. Artifact Middleware

What it does: requires exactly one structured `emit_artifact` call per companion turn and uses artifact fields for TTS emotion, session continuity, and UI.

Why it helps: artifact is product-critical.

Why it may hurt: if artifact instructions live as normal spoken prompt pressure, the model may verbalize internal fields or make every reply sound like bookkeeping.

Recommendation: keep a minimal artifact contract in setup, keep details structured in tool schema/validation, and continue non-verbalization policy. Do not expand artifact prompt context in realtime. Track artifact misses through telemetry rather than hiding them.

Do nothing: UI/TTS state and continuity suffer.

Add too much: artifact/session/tone fields leak into speech and increase over-continuation.

### 10. Builder / Task State

What it does: legacy companion delegates builds and tracks async tasks; Gemini has a selected backend lifecycle bridge.

Why it helps: users can ask Sophia to create/research/build while continuing the conversation.

Why it may hurt: builder state is internal and task tools can be slow or cancelled. Always injecting task state risks unsolicited updates or invented ids.

Recommendation: expose builder state on demand and through UI/public `sophia.builder_task` events. Do not always inject builder state into spoken prompt. If a task completes, present it via structured UI/tool path, not a large prompt block.

Do nothing: realtime voice cannot manage build progress well.

Add too much: model talks about builds unprompted, invents task ids, or blocks speech on long tool calls.

### 11. Tool Registry / Permissions

What it does: defines what the realtime model can call.

Why it helps: tools recover parity without prompt bloat.

Why it may hurt: every tool adds decision surface, latency, cancellation, and security risk.

Recommendation: expose only minimal high-value tools: `emit_artifact`, memory/profile retrieval, and builder lifecycle where already wired. Gate dangerous/expensive tools. Bind user id server-side. Reject unknown ids. Expand gradually with tests.

Do nothing: model cannot answer explicit memory/tool needs.

Add too much: tool confusion, pseudo-tool speech, accidental side effects, and harder debugging.

### 12. Telemetry / Diagnostics

What it does: captures enough current-run evidence to classify provider, relay, tool, transcript, artifact, and audio failures.

Why it helps: prior phases depended on this to separate prompt, relay, tool, VAD, and UI issues.

Why it may hurt: raw prompts, memories, user history, credentials, or broad localStorage snapshots are privacy risks.

Recommendation: keep telemetry outside the prompt. Export compact current-run evidence only. Redact secrets. Keep memory diagnostics to counts/status/categories/lengths.

Do nothing: the team tunes blind.

Add too much: telemetry becomes unsafe to share and harder to interpret.

### 13. Full Middleware Chain

What it does: recreates the complete Sophia companion turn path for every response.

Why it helps: highest theoretical parity.

Why it may hurt: high latency, double-agent behavior, prompt bloat, stale or conflicting context, tool cancellation, provider interruption issues, and poor debugging.

Recommendation: do not put full middleware chain in the critical realtime path now. Consider shadow or sideband middleware passes only after setup+tools+sideband are proven insufficient.

Do nothing: selective parity gaps remain.

Add too much: realtime quality regresses while still not being truly deterministic, because native audio provider turn formation remains provider-owned.

## Gemini Live Vs GPT Realtime Considerations

Gemini Live and GPT Realtime are different provider systems, but several product rules likely apply to both:

- Both are more sensitive than text agents to prompt overload and conflicting instructions.
- Both need a spoken-output policy that chooses one conversational move and stops cleanly.
- Both benefit from trusted setup identity and preferred name.
- Both can be harmed by full memory dumps.
- Both should use on-demand memory/profile tools for explicit deep context needs.
- Both should write memories sideband/asynchronously rather than blocking speech.
- Both need strict tool permission boundaries and trusted user id binding.
- Both should keep diagnostics outside prompt and privacy-minimized.

Provider differences matter:

- Gemini Live setup is effectively first-message setup; current code records `session_updates=False`, so setup-time context is load-bearing.
- OpenAI/GPT Realtime code records `session_updates=True` and uses `semantic_vad` in session config, so future context update strategies may be technically easier there, but this has not been product-proven in Sophia.
- Gemini currently has production-route candidate code and bounded setup memory context. OpenAI/GPT Realtime is still an internal dogfood path in this worktree, with only limited `emit_artifact` declaration in the browser dogfood setup unless instructions are provided.
- Gemini has a backend relay model. OpenAI/GPT Realtime uses browser WebRTC plus trusted sideband when attached.

Do not claim GPT Realtime will behave exactly like Gemini. The recommendation is to apply the same **context policy** to both, then verify provider-specific transport, VAD, session update, function-calling, and interruption behavior in a comparison gate.

## Architectural Options

### Option 1 - Setup-only context

Description: inject preferred name, small profile, bounded memory snippets, platform, and minimal mode/ritual context at session start.

Benefits: fast, simple, low latency, stable, low tool complexity.

Drawbacks: stale over long sessions, no dynamic retrieval, limited deep memory.

Best for: current Gemini baseline and first production candidate.

Verdict: keep as the baseline, but it is not enough alone for explicit memory questions.

### Option 2 - Setup context + on-demand memory/profile tools

Description: small setup context plus tools such as `search_memory`, `get_user_profile`, and `get_recent_context`.

Benefits: avoids prompt bloat, retrieves depth only when needed, supports "what do you remember?" questions.

Drawbacks: model must decide to call tools; tool latency and cancellations need careful handling.

Best for: explicit memory and context questions.

Verdict: recommended next implementation phase.

### Option 3 - Setup context + sideband memory/cache update

Description: backend observes finalized public user transcripts and asynchronously updates memory writeback or a compact context cache.

Benefits: does not block speech, keeps memory fresh, avoids full per-turn cascade latency.

Drawbacks: eventual consistency, may lag one turn, requires privacy/confidence controls.

Best for: memory writeback, session recaps, long-running sessions.

Verdict: recommended after the on-demand tool phase.

### Option 4 - Shadow middleware pass

Description: after each finalized user turn, run a lightweight Sophia middleware/context retrieval pass that does not generate the spoken answer, then make results available for future turns.

Benefits: closer to cascade; may reuse existing code.

Drawbacks: complexity, cost, race/stale data, temptation to make it synchronous.

Best for: future advanced parity only if setup+tools+sideband are insufficient.

Verdict: defer.

### Option 5 - Full cascade-in-the-loop

Description: every realtime turn depends on the full DeerFlow/Sophia agent chain before the model responds.

Benefits: highest theoretical internal parity.

Drawbacks: high latency, defeats native realtime advantages, complex interruption/barge-in, double-agent behavior, higher cost, harder debugging.

Best for: not the current realtime voice path unless product chooses determinism over live voice quality.

Verdict: do not pursue now.

### Option 6 - Hybrid selective parity

Description: setup identity + bounded memory + on-demand tools + sideband writeback + structured artifact/builder bridge.

Benefits: high product value, lower latency, avoids prompt overload, provider-agnostic policy.

Drawbacks: not true 1:1 parity, needs careful tool design, some context is delayed.

Best for: recommended production path.

Verdict: recommended staged strategy.

## Recommended Strategy

Recommended: **Hybrid Selective Realtime Parity**.

1. Keep trusted identity and preferred name in setup.
   - Benefit: high personalization, low latency.
   - Drawback: setup-only, can be stale.
   - Risk if not done: generic Sophia.
   - Risk if overdone: privacy leakage.

2. Keep bounded setup memory/profile/handoff context.
   - Benefit: continuity at session start.
   - Drawback: limited depth.
   - Risk if not done: memory parity gap.
   - Risk if overdone: prompt bloat and stale context.

3. Do not inject full Mem0 or full cascade output.
   - Benefit: protects latency and privacy.
   - Drawback: model misses some implicit context.
   - Risk if not done: generic or forgetful answers.
   - Risk if overdone: old/private facts spoken aloud.

4. Add on-demand memory/profile tools for explicit context needs.
   - Benefit: depth without bloat.
   - Drawback: tool latency and cancellation handling.
   - Risk if not done: explicit memory questions remain weak.
   - Risk if overdone: tool confusion and over-retrieval.

5. Add sideband memory writeback/recap after finalized turns.
   - Benefit: memory improves without blocking speech.
   - Drawback: eventual consistency.
   - Risk if not done: realtime sessions do not improve memory.
   - Risk if overdone: false memory writes.

6. Keep artifact/builder bookkeeping structured and out of spoken prompt.
   - Benefit: product state works without verbal leakage.
   - Drawback: requires strong tool/event tests.
   - Risk if not done: UI/TTS state gaps.
   - Risk if overdone: internal state spoken aloud.

7. Avoid full cascade-in-the-loop for now.
   - Benefit: preserves native realtime quality.
   - Drawback: not complete parity.
   - Risk if not done: some cascade capabilities remain missing.
   - Risk if overdone: realtime voice quality collapses under latency and prompt complexity.

8. Re-evaluate after GPT Realtime comparison.
   - Benefit: avoids overfitting to Gemini.
   - Drawback: slower final provider decision.
   - Risk if not done: provider-specific mistakes become product architecture.
   - Risk if overdone: duplicated provider work without clear policy.

## Future Phases

### Phase 12.5B - Realtime Memory/Profile Tool

Purpose: allow Gemini/GPT Realtime to retrieve memory/profile on demand.

Recommended scope:

- Add a dependency-safe backend contract for memory/profile retrieval.
- Bind trusted user id server-side; no model-supplied user id override.
- Return bounded, summarized memories with categories and no raw diagnostics.
- Use for explicit questions: "What do you remember about me?", "What is my name?", "Do you remember what I'm working on?"

Risks: tool latency, cancellations, overuse, privacy.

Tests: explicit memory question, preferred-name fallback, missing Mem0, cancelled tool call, no raw memory telemetry.

### Phase 12.5C - Sideband Memory Writeback / Session Recap

Purpose: persist important new facts after finalized turns without blocking speech.

Recommended scope:

- Observe finalized `sophia.user_transcript`, assistant final transcript, artifact fields, and session close.
- Reuse offline extraction rules and review metadata semantics.
- Keep idempotency and false-memory controls.

Risks: privacy, false writes, eventual consistency, recap drift.

Tests: new preferred name, new commitment, no write on sarcasm/low confidence, replay/idempotency.

### Phase 12.5D - Builder/Artifact Product Surface Parity

Purpose: make builder outputs/storage visible and reliable in Session UI.

Recommended scope:

- Keep builder output access UI/tool-driven.
- Confirm start/check/list/update/cancel live under production Session, not only debug page.
- Keep companion artifacts separate from builder artifacts.

Risks: UI complexity, task-id confusion, cancellation edge cases.

### Phase 12.5E - GPT Realtime Comparison Gate

Purpose: compare Gemini Live and GPT Realtime using the same context policy.

Recommended scope:

- Same setup identity/memory policy.
- Same memory tool shape where possible.
- Same spoken-output smoke matrix.
- Provider-specific notes for session updates, sideband, VAD, interruption, and function calling.

Risks: duplicated provider-specific work; unknown GPT behavior.

### Phase 12.5F - Optional Shadow Middleware Pass

Purpose: only if selective parity is insufficient.

Recommended scope:

- Run after finalized turns.
- Do not block speech initially.
- Compare generated context to actual realtime behavior.

Risks: complexity, latency temptation, stale state races.

Recommended order: 12.5B, 12.5C, 12.5D, 12.5E, then 12.5F only if evidence demands it.

## Decision Table For Davide

| Decision | Recommendation | Why | Risk | When to revisit |
|---|---|---|---|---|
| Inject preferred name | Yes, setup | High value, low risk | Minimal | If auth/profile model changes. |
| Inject basic identity | Yes, bounded setup | Continuity without full profile dump | Medium privacy/staleness | After memory/profile tool exists. |
| Inject full identity/profile | No | Too much private/stale context | High | Only as curated summary, not dump. |
| Inject bounded Mem0 snippets | Yes, setup | Improves continuity | Medium | Tune count after smokes. |
| Inject full Mem0 | No | Prompt bloat and privacy | Very high | Do not revisit as raw dump. |
| Add memory search tool | Yes, staged | On-demand depth | Medium | Phase 12.5B. |
| Per-turn blocking memory search | No for now | Hurts realtime turn-taking | High | After sideband/cache experiments. |
| Memory writeback | Yes, sideband later | Improves continuity without blocking | Medium | Phase 12.5C. |
| Full ritual prompts | Only when explicitly active | Useful but can over-direct | Medium-high | Consider compact realtime variants. |
| Artifact contract | Yes, minimal structured | Product-critical | Medium | If artifact misses persist. |
| Artifact bookkeeping in speech | No | Causes leakage/over-continuation | High | Never as normal spoken text. |
| Builder state in prompt | No by default | UI/tool should own it | Medium-high | If users cannot recover task state. |
| Builder lifecycle tools | Yes, selected | Product value | Medium | Continue live proof. |
| Full tool registry | No | Tool confusion/security | High | Add tools gradually. |
| Full cascade every turn | No for now | Hurts realtime | Very high | If product chooses determinism over latency. |
| GPT Realtime same policy | Likely yes | Realtime models need bounded context | Unknown | After GPT comparison. |

## Risks To Avoid

- Do not overload realtime prompts with full cascade context.
- Do not dump full Mem0 into realtime sessions.
- Do not let artifact/builder bookkeeping leak into speech.
- Do not add every tool at once.
- Do not block realtime speech on slow memory retrieval.
- Do not write memories without clear confidence and safety rules.
- Do not assume Gemini conclusions automatically apply to GPT Realtime.
- Do not optimize for theoretical parity at the cost of live voice quality.
- Do not hide provider problems with frontend suppression.
- Do not remove Sophia identity to make realtime easier.

## Non-Negotiables

- Trusted user identity only.
- No model-supplied user id overrides.
- Bounded context by default.
- Privacy-preserving diagnostics.
- Tool permission boundaries.
- Structured tool calls for artifacts; no text parsing.
- Clear feature flags, staging, and rollback.
- Provider-specific evidence before provider-specific tuning.

## Final Recommendation

Proceed with selective realtime parity. Gemini Live should not become a clone of the legacy cascade middleware stack. It should receive the smallest high-value trusted setup context, use backend tools for explicit depth, and rely on asynchronous sideband processes for memory/session persistence. This gives Sophia meaningful continuity while preserving the low-latency, natural-turn advantages of native realtime audio.

The next implementation should be Phase 12.5B: a bounded on-demand memory/profile retrieval tool designed once and then adapted for Gemini Live and GPT Realtime. Do not implement full middleware parity, full Mem0 injection, or full cascade-in-the-loop before that tool and sideband roadmap have live evidence.