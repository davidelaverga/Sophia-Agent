# Sophia Voice — Runtime & Tools Spec

**Version:** 1.0 · **Status:** Draft for sign-off · **Date:** 2026-05-21
**Doc 1 of 4** in the Sophia Voice spec set (decomposed from `sophia_gpt_realtime_experiment_spec_v1_3.md`, now superseded).
**Siblings:** Doc 2 — System Prompt · Doc 3 — Context Engineering · Doc 4 — Spec Map
**Hard dependency:** `sophia_artifact_traces_architecture_v1.md` (the artifact substrate this runtime emits and consumes).
**Owner:** Luis (voice implementation) · **Co-owner:** Jorge (backend tools, builder coordination)

---

## 0. Required Reading

No implementation decision in this doc should be made without reading the corresponding source. This is the anti-guesswork contract: each section below cites the exact reference at the point of decision.

**OpenAI Realtime documentation** (gpt-realtime-2):
- Realtime prompting guide — *Realtime models prompting* (`platform.openai.com/docs/guides/realtime-models-prompting`). Reasoning effort, message channels (commentary vs final), preambles, tool-use behavior, the `wait_for_user` no-op pattern.
- Realtime conversations — *Realtime conversations* (`platform.openai.com/docs/guides/realtime-conversations`). Server-side conversation state, items, turn detection (`semantic_vad`, `eagerness`, `idle_timeout`, `interrupt_response`, `create_response`), function calling, truncation.
- Realtime session object — *Realtime sessions API reference* (`platform.openai.com/docs/api-reference/realtime-sessions`). Exact key paths for `session.update`.
- Managing context & cost — *Realtime* cost/context section. Truncation (`retention_ratio`), prompt caching behavior on the audio model.

**Internal source files** (in repo):
- `voice/server.py` — current session lifecycle and agent construction (what is preserved vs cut).
- `vision_agents/plugins/openai/openai_realtime.py` — the Realtime plugin: function registration, background tool execution, default model/voice/VAD, `update_tools`, reconnection TODO.
- `vision_agents/plugins/openai/tool_utils.py` — function-format conversion for realtime.
- `voice/config.py` — current `VoiceSettings` (most cascade fields retire here).
- `voice/sse_broker.py` — `VoiceEventBroker` (preserved verbatim).
- `voice/turn_diagnostics.py` — rewritten, not ported (§9).
- `voice/rhythm.py` — repurposed to an eagerness signal (§5.4).
- `sophia/tools/start_builder_task.py` + `middlewares/build_awareness.py` — the native builder machinery the voice tools reuse.
- `sophia_coordination_stabilization_spec.md` — the companion↔builder contract and deterministic guard inventory.
- `retrieve_memories.py` — the memory tool being modified (§7.3).

**Internal specs:**
- `sophia_artifact_traces_architecture_v1.md` — `emit_artifact` schema, `check_async_task` enrichment.
- `sophia_memory_upgrades_spec_v2_1.md` — hybrid retrieval (why `retrieve_memories` drops the category param).
- `sophia_coordination_stabilization_spec.md` — invariants, intent→tool matrix, three-file split.

---

## 1. What This Document Covers

The voice runtime is migrating from a **cascaded pipeline** (Deepgram STT → Claude Haiku → Cartesia TTS, stitched together by hand-rolled turn detection and a cancel-and-merge coordinator) to an **end-to-end speech-to-speech model**, `gpt-realtime-2`, reached through the **Vision Agents** `Realtime` plugin over WebRTC.

This doc specifies the runtime topology, the session configuration, the turn-detection treatment, and the complete tool surface. It does **not** contain the system prompt (Doc 2) or the context-window management strategy (Doc 3); it cross-references both where they couple.

The governing principle is unchanged from every prior spec: **the harness controls flow, structural metadata, and enforcement; the model controls semantic content.** The migration removes a large amount of hand-rolled harness machinery because the model now subsumes it — but where an invariant must hold 100% of the time, it stays in code, not in a prompt sentence.

---

## 2. Topology

### 2.1 Before and after

| Concern | Cascade (current) | Realtime (target) |
|---|---|---|
| Speech-in | DeepgramSTT (flux-general-en) | gpt-realtime-2 native audio in |
| Reasoning/response | Claude Haiku via SophiaLLM | gpt-realtime-2 |
| Speech-out | SophiaTTS (Cartesia sonic-3) | gpt-realtime-2 native audio out (voice `marin`) |
| Turn-taking | SophiaTurnDetection (3-layer custom) | `semantic_vad` (server-side) |
| Barge-in / merge | ConversationFlowCoordinator | native truncation + `interrupt_response` |
| Transport | WebRTC via Stream (getstream Edge) | **unchanged** — WebRTC via Stream |
| Session lifecycle | `voice/server.py` endpoints | **unchanged** — same endpoints |
| Browser events | `VoiceEventBroker` SSE | **unchanged** — same broker |

### 2.2 The function-tool decision (settled)

gpt-realtime-2 supports three tool types: **function** (the app executes), **MCP with `server_url`** (OpenAI calls our gateway), and **MCP with `connector_id`** (OpenAI built-ins). Sophia's voice surface uses **function tools** exclusively. Reasoning, in order of weight:

1. **Latency.** A function tool runs in our process; an MCP `server_url` tool adds an OpenAI→gateway network hop on every call. In a real-time voice loop that hop is felt.
2. **Startup.** MCP servers incur an `mcp_list_tools` exchange at session open. Function tools are declared inline in `session.update` — no round trip.
3. **Trust boundary.** Function tools need no public execution endpoint. The builder, memory, and time tools resolve `user_id` from trusted bound session context, never from a network-exposed surface.
4. **Async co-location.** The Vision Agents plugin already dispatches function execution to a background task (`_run_tool_in_background`, `openai_realtime.py`), so long-running tools never block the audio loop. We get async for free, in-process.

The earlier "durable state ⇒ MCP" framing in v1.3 was a category error: **where state lives is independent of how the call reaches it.** The builder's state lives in the LangGraph `async_tasks` channel; the voice tools reach it in-process via the bound `thread_id` (§7.5). The MCP gateway remains in use for the text companion and the frontend — it is not removed, it is simply not on the voice hot path. (Reference: *Realtime conversations → Function calling*; `openai_realtime.py` lines registering `@llm.register_function` and `_run_tool_in_background`.)

### 2.3 Component fates

**Preserved (do not touch):**
- `voice/server.py` session endpoints: `POST /calls/{call_id}/sessions`, `GET …/events` (SSE), `POST …/warmup`, `DELETE …/{session_id}`, `POST …/close` (beacon).
- `SophiaStartSessionRequest` fields, including the load-bearing `thread_id` (LangGraph thread reused by the voice session — §7.5 depends on it).
- `VoiceEventBroker` (`sse_broker.py`) and the emitter wiring (`_attach_agent_event_emitter`, `_bind_agent_session_context`).
- Warmup endpoints (repurposed: backend/Mem0 warmup still valuable; TTS warmup becomes a no-op or is removed since Cartesia is gone).

**Cut entirely:**
- `SophiaLLM` (cascade LLM), `SophiaTTS`, `DeepgramSTT` wiring.
- `SophiaTurnDetection` (`sophia_turn.py`) — semantic_vad subsumes it (§5).
- `ConversationFlowCoordinator` (`conversation_flow.py`) — native truncation + barge-in subsumes it.
- The `_stabilized_simple_response` wrapper, the cancel-and-merge layer, the fragile-window stabilization, the continuation-recovery machinery in `server.py` (lines ~605–745). All of it was an approximation of semantic turn detection.
- Most of `config.py`: `deepgram_*`, `cartesia_*`, `smart_turn_*`, `adaptive_silence_*`, `fragile_window_ms`, `merge_min_new_words`, `same_turn_repeat_debounce_ms`, `backend_stall_timeout_ms`. (Retain `langgraph_base_url`, `assistant_id`, `agent_user_*`, `backend_mode`, `platform`, `context_mode`, `ritual`.)

**Repurposed:**
- `RhythmTracker` (`rhythm.py`) → a coarse per-user eagerness signal (low ↔ medium), not a millisecond silence offset (§5.4). Kept as a GEPA input.
- `turn_diagnostics.py` → rewritten for the new turn shape (§9). The cascade stage timings (STT→LLM→TTS) no longer exist; the new shape is `speech_stopped → first_audio` plus reasoning and tool latency.

### 2.4 Agent construction (target shape)

The current `create_agent` (`server.py` line ~537) wires STT + TTS + LLM + turn_detection + coordinator + rhythm. The target collapses to:

```python
# Pseudocode — confirm exact plugin constructor against installed openai_realtime.py
from vision_agents.plugins.openai import Realtime
from vision_agents.plugins.getstream import Edge as StreamEdge

llm = Realtime(
    model="gpt-realtime-2",
    # session config per §4; voice, VAD, truncation, transcription, reasoning
    session_options=SOPHIA_SESSION_CONFIG,   # §4.1
)

register_voice_tools(llm)   # §7 — all function tools, including the 5 native builder tools

agent = Agent(
    edge=StreamEdge(),
    llm=llm,
    agent_user=User(id=settings.agent_user_id, name=settings.agent_user_name),
    instructions=SOPHIA_SYSTEM_PROMPT,  # Doc 2 assembles this
)

# Preserved binding + emitter wiring (server.py):
llm.attach_call_emitter(_emit)            # SSE bridge (§8)
llm.bind_session_context(                 # platform/context_mode/ritual/session_id/thread_id
    platform=..., context_mode=..., ritual=..., session_id=..., thread_id=...,
)
```

The `Agent` no longer receives `stt`, `tts`, or `turn_detection` — the `Realtime` LLM owns all three. (Reference: `openai_realtime.py` — the plugin presents a single `Realtime` object that internally manages audio in/out and server-side VAD.)

---

## 3. Transport & Session Lifecycle

### 3.1 WebRTC (unchanged)

Transport stays WebRTC via Stream (`getstream` Edge). The browser's `getUserMedia` constraints are now load-bearing for echo handling (§5.3) — `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true`. This is a frontend obligation; flag to the frontend plan.

### 3.2 The 60-minute session cap

A single `gpt-realtime-2` realtime connection has a **hard 60-minute lifetime** (OpenAI; Azure deployments cap at 30). There is no server parameter to extend it. Sophia sessions that approach the cap must **refresh the ephemeral token (~at 29 min) and reconnect**, re-seeding context (Doc 3 §reconnection). (Reference: *Realtime conversations → session limits*.)

Implication for `server.py`: the session lifecycle must tolerate a mid-call reconnect that preserves `session_id`, `call_id`, and `thread_id`. The browser-facing SSE stream and the LangGraph thread survive the reconnect; only the OpenAI realtime connection is re-established.

### 3.3 Reconnection is ours to build

The Vision Agents plugin carries an explicit TODO: *"Reconnection is currently not easy"* (`openai_realtime.py` line ~43). **The plugin does not handle reconnection for us.** Sophia must implement:

- Detecting connection loss (transport drop, token expiry, the 60-min cap).
- Re-establishing the realtime connection with a fresh ephemeral token.
- Re-seeding the conversation (the new connection starts with an empty server-side conversation — see Doc 3 on why the prior context does **not** carry over automatically).
- A spoken bridge if the gap is user-perceptible ("give me one second — I'm still here").

This is the single largest piece of net-new runtime code in the migration. It is **Phase 2**, not Phase 1 (§10): Phase 1 sessions can run to the cap and end gracefully.

### 3.4 Warmup

Keep the backend/Mem0 warmup (it still shortens the first turn's memory prefetch). Remove or no-op the TTS warmup (`_schedule_agent_tts_warmup`) — there is no Cartesia connection to prewarm. Consider adding a realtime-connection prewarm if the plugin supports an idle connection, but do not assume it does — verify against the plugin.

---

## 4. Session Configuration

### 4.1 The authoritative config block

This is the single source of truth for session values. Doc 2 (prompt) and Doc 3 (context) reference these values; they do not redefine them. The exact JSON key paths shifted across realtime API versions (some settings moved under `audio.input` / `audio.output`); **confirm the precise nesting against the installed API version and the plugin's `session.update` construction in `openai_realtime.py`.** The *values and rationale* below are the spec; the *key paths* are to be verified.

| Setting | Value | Rationale | Reference |
|---|---|---|---|
| `model` | `gpt-realtime-2` | The 128k-context speech-to-speech model. (Plugin default, stated explicitly.) | prompting guide |
| `voice` | `marin` (primary), `cedar` (alternate) | Plugin default `marin`; `cedar` evaluated as alternate in Phase 1 voice-fidelity audit. | `openai_realtime.py` |
| output modality | audio | Sophia speaks. Model self-transcript arrives via output transcription events for the trace pipeline. | conversations |
| input transcription | `gpt-4o-mini-transcribe` | Plugin default. **Keep it** — the trace/artifact pipeline and frontend transcript depend on user-utterance text. Budget for its cost. | `openai_realtime.py` |
| `turn_detection.type` | `semantic_vad` | Model-side semantic endpointing; subsumes the entire custom turn stack (§5). | conversations → turn detection |
| `turn_detection.eagerness` | `low` | **Must be set explicitly — the plugin does not set it.** `low` = Sophia's patience; she waits rather than jumping in. (§5.2) | conversations |
| `turn_detection.idle_timeout` | **unset** | Do not let the API auto-prompt on user pauses. Sophia holds silence; `wait_for_user` (§7.11) is the deliberate alternative. (§5.2) | conversations |
| `turn_detection.interrupt_response` | `true` | Barge-in: user speech interrupts Sophia's audio. | conversations |
| `turn_detection.create_response` | `true` | Natural flow — model responds when the user finishes. (Note: `false` is the lever for out-of-band clean injection; deferred, Doc 3.) | conversations |
| `reasoning.effort` | `low` | Start low. Raise only if the model mishandles tool routing / state prediction. In-prompt steering (Doc 2) directs *when* to reason. | prompting guide → reasoning |
| `truncation.type` | `retention_ratio` | Native drop-oldest (NOT summarization). | cost/context |
| `truncation.retention_ratio` | `0.8` | Drop ~20% extra when the threshold trips, to reduce cache-busting frequency. **Do not set `truncation: disabled`** (errors vs. degrades gracefully). | cost/context |
| `tool_choice` | `auto` | Model decides when to call tools. | conversations |
| `tools` | §7 surface | All function tools, declared inline. | `tool_utils.py` |

The 128k window is large enough that truncation rarely fires inside a 60-min session; the parameter is correctness insurance, and the cross-session/compaction *strategy* lives in Doc 3.

### 4.2 What the plugin sets vs. what we must override

The plugin (`openai_realtime.py`) defaults: `model=gpt-realtime-2`, `voice=marin`, `turn_detection.type=semantic_vad`, transcription `gpt-4o-mini-transcribe`. It **does not** set `eagerness`, `idle_timeout`, `truncation`, or `reasoning.effort`. Those four are our explicit responsibility in `session_options`. Mid-session changes (e.g., tool surface updates) go through the plugin's `update_tools()` / `session.update` path.

---

## 5. Turn Detection

### 5.1 Why the custom stack is cut

The current stack is three hand-rolled layers (`sophia_turn.py`, `conversation_flow.py`, `rhythm.py`): echo suppression, adaptive silence by word-count, continuation/fragment regex detection, a turn-end guard, submission stabilization, and per-user pause learning. All of it approximates **semantic** turn detection — deciding whether the user is *done* versus *mid-thought*. `semantic_vad` does this natively from the audio and partial transcript. Keeping the custom stack on top would fight the model. It is cut. (Reference: `sophia_turn.py` for what was being approximated; *Realtime conversations → turn detection* for what replaces it.)

### 5.2 The patience settings

Sophia's defining voice trait is that she does not rush. Two settings encode it:
- `eagerness: low` — the model waits longer before deciding the user has finished, tolerating reflective pauses.
- `idle_timeout` **unset** — the model never spontaneously prompts a silent user. Silence is allowed to be silence; if Sophia chooses to hold it, she calls `wait_for_user` (§7.11) rather than the API forcing a turn.

These two together resolve the v1.3 "silence-holding" tension that the custom stack was built to manage.

### 5.3 Echo → client-side AEC

The custom echo suppression (TTS telling the turn detector when Sophia speaks, so the mic ignores her own voice) is gone. Its replacement is **client-side WebRTC acoustic echo cancellation**: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`.

**Open risk (audit in Phase 1):** on mobile / speakerphone, AEC is weaker and Sophia's own audio could leak into the mic and trigger a false barge-in (because `interrupt_response: true`). The Phase 1 turn audit must include a speakerphone pass. If false barge-in appears, mitigations are frontend-side (headset prompt, push-to-talk fallback) — not a return to server-side suppression. This is a frontend obligation; flag to the frontend plan.

### 5.4 Rhythm, repurposed

`RhythmTracker` no longer computes a millisecond silence offset (there is no silence timer to offset). It is repurposed to a coarse per-user **eagerness** signal: users who habitually pause long get `eagerness: low` (the default); users who are consistently terse and fast *may* warrant `medium`. Default everyone to `low`. Keep the per-user data as a GEPA signal. A dynamic eagerness-by-tone-band policy (grief → maximum patience; logistics → medium) is a v2 optimization, not Phase 1.

---

## 6. Tool Surface — Execution Model

### 6.1 Registration

Tools are declared inline in the session config and registered with the plugin via its function-registration path (`@llm.register_function` / `convert_tools_to_openai_format(for_realtime=True)`, `tool_utils.py`). No `strict` mode for realtime function tools (the plugin omits it). Each tool is a Python callable in the voice process.

### 6.2 Async semantics — the non-blocking guarantee

The plugin dispatches each tool call to a background task (`_run_tool_in_background`, `openai_realtime.py` ~line 302), awaits the function with a **30-second timeout**, then sends `function_call_output` + `response.create`. Consequences the spec relies on:

- **A tool call never blocks the audio event loop.** Sophia can keep listening while a tool runs.
- **Tools should return promptly.** Anything that can exceed ~30s must be modeled as fire-and-forget with status polling — which is exactly the builder pattern (§7.5): `start_builder_task` returns immediately with a `task_id`; progress is read later via `check_async_task`.
- **A spoken preamble covers perceptible latency.** For tools with >~700ms expected latency (memory cold-miss, web fetch), the prompt instructs a short preamble (Doc 2). The preamble is *commentary*-channel speech; the tool call is a *commentary*-channel tool call; neither is the final answer. (Reference: prompting guide → message channels.)

### 6.3 Tool-availability enforcement (no invention)

Observed failure in prior testing: the model referenced a tool/capability that did not exist. The runtime declares the exact tool set in §7; the prompt (Doc 2) carries an explicit "these are your only tools; do not claim or imply a capability you do not have" instruction. There is no code gate that can stop a model from *speaking* about a nonexistent capability mid-utterance, so this is **prompt-enforced** and audited (§9, web-tools/tool-availability audit).

---

## 7. Tool Surface — Per-Tool Contracts

The full surface, grouped. For each: signature the model sees, what it does, async/latency, eagerness/confirmation, and enforcement location. Tools marked **NEW** do not exist in the cascade runtime and must be built or adapted.

### 7.1 `consult_skill(skill_name)`
- **Sees:** `skill_name: enum` of the 8 skills (`active_listening`, `vulnerability_holding`, `crisis_redirect`, `trust_building`, `boundary_holding`, `challenging_growth`, `identity_fluidity_support`, `celebrating_breakthrough`).
- **Does:** returns the skill file body for in-context use this turn.
- **Latency:** local file read; negligible. No preamble.
- **Policy:** model-selected; no confirmation. Skill *selection* logic is prompt-side (Doc 2).
- **Enforcement:** harness returns the file; the model cannot fabricate skill content.

### 7.2 `get_current_time()` / `schedule_check()` — **NEW for voice**
- **Sees:** no args (`get_current_time`); `schedule_check` returns upcoming user-relevant time anchors if available.
- **Does:** returns current time in the user's timezone / ambient schedule context. Ambient time is *also* injected each turn (Doc 3, cache-safe placement); the tool is the on-demand precise read.
- **Latency:** negligible.
- **Policy:** model-selected; no confirmation; no preamble.
- **Enforcement:** harness-supplied; authoritative.

### 7.3 `retrieve_memories(query)` — **MODIFIED** (see `retrieve_memories.py`)

The repo tool is a LangChain `StructuredTool` built for the text companion. Four changes adapt it for the voice surface without forking logic:

1. **Shared core.** Extract `_retrieve_memories_core(user_id, query, …)`. The LangChain `StructuredTool` (text) and a new Vision Agents function tool (voice) both wrap this one core. Mem0 search lives in one place.
2. **`user_id` from trusted session context.** The text tool binds `user_id` by closure at construction. The voice tool resolves `user_id` at call time from the bound session context (`bind_session_context`, `server.py`), mirroring `start_builder_task._resolve_user_id` (trusted runtime identity wins; never an LLM-supplied arg; `user_id` is not in the voice signature).
3. **Signature = `query` only.** Drop the `categories` parameter from the model-facing signature. Per `sophia_memory_upgrades_spec_v2_1.md`, categories are descriptive metadata and retrieval is hybrid weighted scoring across all categories — an explicit category filter is redundant, and gpt-realtime-2 rarely picks the right category. Category weighting stays internal to `_retrieve_memories_core`.
4. **Cap at ~5, gated description, preamble.** Cap voice results at ~5 (not 15) — a spoken turn cannot weave fifteen memories and it bloats context. Rewrite the description to gate *when* to call: explicit recall only ("do you remember…", "what did I say about X last time"), **not** general context — the per-turn prefetch (Doc 3) already injects relevant memory, so a general-context call wastes a turn. A Mem0 cold-miss can run ~1–2s, so pair with a short preamble.
- **Latency:** ~1–2s cold, faster warm (LRU cache). Preamble required.
- **Policy:** model-selected on explicit-recall cue; no confirmation.
- **Enforcement:** `user_id` resolution is code-enforced; *when to call* is prompt-enforced (Doc 2) + audited.

### 7.4 `web_search(query)` / `web_fetch(url)`
- **Sees:** `query` / `url`.
- **Does:** search / fetch. Returns results for in-context grounding.
- **Latency:** seconds. Preamble required ("let me look that up").
- **Policy:** model-selected; no confirmation for search; `web_fetch` only on a URL the user supplied or a result already returned.
- **Enforcement:** async background; copyright/safety handling per the tool implementation.

### 7.5 Native async builder tools — **NEW for voice** (the five lifecycle tools)

The voice runtime exposes the **same five native deepagents lifecycle tools** the text companion uses — not custom wrappers, not reimplementations. (Reference: `sophia_coordination_stabilization_spec.md` §3–4; `start_builder_task.py`; `build_awareness.py`.)

| Tool | Signature (model sees) | Purpose |
|---|---|---|
| `start_builder_task` | `(description, task_type, user_id=None)` | First build. `user_id` arg is diagnostic-only; trusted identity wins. |
| `check_async_task` | `(task_id)` | Status. Returns enriched `latest_artifact_summary`. |
| `update_async_task` | `(task_id, instructions)` | Modify an in-flight build. |
| `cancel_async_task` | `(task_id)` | Stop a build. |
| `list_async_tasks` | `()` | Recall current/recent tasks. |

**They call the existing machinery.** Registered as Vision Agents function tools that invoke the real `start_builder_task.py` impl and the `build_awareness` refresh against the shared `async_tasks` channel, keyed by the voice session's bound **`thread_id`** (`SophiaStartSessionRequest.thread_id`, `server.py`). Because they reuse the impl, every deterministic guard in the coordination spec carries over for free:

- Duplicate-launch protection (`_has_active_builder_task` reads `async_tasks`, rejects a second launch).
- Terminal-status taxonomy (`_TERMINAL_TASK_STATUSES`, default-active semantics).
- Description enrichment (`_build_enriched_description` injects memories/tone/ritual/URLs).
- Trusted `user_id` resolution (`_resolve_user_id` priority chain).
- `tool_call_id` pre-validation (refuses to orphan a thread/run).
- Status refresh (`build_awareness._refresh_task_status`, 10s TTL cache).
- State-block selection (active → recently-terminal → none) and 30-min fade-out.

`check_async_task` returns the enriched `latest_artifact_summary` (`current_phase`, `turn_goal`, `progress_toward_session_goal`, `last_diagnosis`, `confidence`, minutes-elapsed) from `sophia_artifact_traces_architecture_v1.md` §builder-summary. Sophia translates these into natural language (mapping table in the artifact-traces spec; prompt usage in Doc 2).

> **Verify with Jorge (load-bearing assumption):** that the voice runtime, via the bound `thread_id`, reaches the same `async_tasks` channel through the DeerFlowClient / LangGraph SDK path that `start_builder_task.py` uses. The `thread_id` binding in `SophiaStartSessionRequest` strongly implies this is the intended design, but it is the assumption the entire builder-coordination path rests on, so it is verified at implementation, not assumed silently.

- **Latency:** all five return promptly (`start` returns a `task_id` immediately; the build runs out-of-band). No tool exceeds the 30s background timeout.
- **Policy:** `start_builder_task` requires user confirmation of the build intent (the build is a visible, consequential action); the other four are model-selected on the matching cue. Confirmation framing is prompt-side (Doc 2).

### 7.6 `wait_for_user()` — **NEW**
- **Sees:** no args.
- **Does:** a no-op tool that gives the model a valid *non-speaking* action. When the user is silent, ambient noise occurs, or Sophia chooses to hold space, the model calls `wait_for_user` instead of being pushed to speak.
- **Latency:** instant.
- **Policy:** model-selected; never spoken; pairs with `idle_timeout` unset (§5.2). (Reference: prompting guide → the wait/no-op pattern.)
- **Enforcement:** harness-provided; resolves the silence-holding tension structurally rather than by prompt plea alone.

### 7.7 `emit_artifact(...)` — **MODIFIED to 15 fields** (see `sophia_artifact_traces_architecture_v1.md`)
- **Sees:** the 15-field Sophia artifact, grouped: **OBSERVATION** (`tone_estimate`, `active_tone_band`, `user_emotional_reading`, `previous_turn_reflection?`), **APPROACH** (`skill_loaded`, `target_tone`, `response_register`), **PREDICTION** (`predicted_user_trajectory`, `recommended_register_next_turn`, `predicted_skill_transition`, `prediction_confidence`), **CONTINUITY** (`session_goal`, `active_goal`, `takeaway`, `lesson?`). (`?` = optional; null on routine turns.)
- **Does:** records the model's internal state as a *commentary*-channel tool call. **Never spoken, never shown to the user.** Drives the frontend emotion display, session continuity, the prediction loop, and GEPA.
- **Cut from the cascade artifact:** `voice_emotion_primary/secondary`, `voice_speed` — these drove Cartesia, which is gone; the model now voices itself from the prompt. Tone fields are retained (frontend display + prediction loop).
- **Latency:** instant.
- **Policy:** **required once per turn.** In the realtime path this is prompt-enforced (the harness cannot middleware-gate it mid-utterance), and it is the load-bearing post-condition for the builder invariant in §7.8. Field semantics are taught in Doc 2; the substrate authority is the artifact-traces spec.

### 7.8 Enforcement map — code vs. prompt

The migration moves several invariants from middleware-enforced (LangGraph text companion) to prompt-enforced (realtime voice), because the realtime harness cannot gate the model's tool sequencing mid-response. Luis must know what he is relying on the prompt for.

| Invariant | Text companion | Voice realtime |
|---|---|---|
| Duplicate-launch protection | code (middleware + impl) | **code** (tool impl reads `async_tasks`) |
| Trusted `user_id` resolution | code | **code** (`_resolve_user_id`) |
| Terminal-status / fade-out | code | **code** (reused impl) |
| One lifecycle tool per turn | middleware | **prompt** (`coordination_core.md`) |
| Never chain two lifecycle tools | middleware | **prompt** |
| No timer-based polling | middleware | **prompt** |
| Full `task_id` verbatim | middleware | **prompt** |
| `emit_artifact` once after a lifecycle tool | middleware | **prompt** |
| `retrieve_memories` when-to-call | n/a | **prompt** + audit |
| No tool invention | n/a | **prompt** + audit |

Everything in the "prompt" column is specified in Doc 2 and locked by the regression/audit suite (coordination spec §6; audits §9 here).

---

## 8. Frontend SSE Contract

The browser-facing event stream is unchanged in mechanism (`VoiceEventBroker`, the `_emit` bridge in `server.py`) and changes only in payload set. Events the frontend consumes:

| Event | When | Payload (core) |
|---|---|---|
| `sophia.turn.user_transcript` | user utterance transcribed | `text`, `is_final` |
| `sophia.turn.agent_transcript` | model output transcript | `text` |
| `sophia.artifact.emitted` | per turn after `emit_artifact` | the 15-field artifact (drives EmotionDisplay via `tone_estimate`/`active_tone_band`) |
| `sophia.builder.artifact_emitted` | builder step artifact available | builder summary fields |
| `sophia.tool.preamble` | tool call with spoken preamble | `tool_name` |
| `sophia.session.reconnecting` / `reconnected` | Phase 2 reconnection | — |

The frontend plan (`sophia_frontend_streaming_architecture_plan_v1.md`) needs updating for the artifact-trace payload shape; that is tracked separately and does not block this doc. (Detailed event schemas: Doc 2 references the artifact fields; the artifact-traces spec is authoritative for field types.)

---

## 9. Latency Targets & Diagnostics

### 9.1 Targets

| Metric | Target | Notes |
|---|---|---|
| `speech_stopped → first_audio` (TTFA) | < 800ms typical | The headline voice metric. Replaces the cascade's STT+LLM+TTS sum. |
| Reasoning overhead | bounded by `reasoning.effort: low` | Raise effort only if quality requires; re-measure. |
| Tool latency (memory/web) | covered by preamble | Preamble starts within TTFA; tool result lands during/after. |

### 9.2 `turn_diagnostics.py` — rewrite, not port

The current module times cascade stages (STT latency, LLM first-token, TTS synthesis start). None of those stages exist. The rewrite captures:
- `speech_stopped` timestamp (from the realtime VAD event).
- `first_audio` timestamp (first output audio frame).
- TTFA = the delta.
- reasoning span (if surfaced by the model events).
- per-tool latency and which tool.
- barge-in events and false-barge-in candidates (for the §5.3 audit).

Emit into the same diagnostics channel the GEPA pipeline reads. (Reference: `turn_diagnostics.py` for the existing metric-emission shape to preserve; replace the metric *definitions*.)

### 9.3 Phase-1 audits

- **Voice-fidelity audit:** `marin` vs `cedar`, naturalness, does the model honor the prompt's emotional register.
- **Turn audit (incl. speakerphone):** false barge-in on mobile/speakerphone (§5.3); does `eagerness: low` + `idle_timeout` unset produce the intended patience.
- **Tool-availability / web-tools audit:** no tool invention; `retrieve_memories` called only on explicit recall.
- **Builder-coordination audit:** the prompt-enforced invariants from §7.8 hold (one tool/turn, no chaining, verbatim `task_id`, `emit_artifact` after). Locked by the coordination spec §6 regression catalog.

---

## 10. Phasing

**Phase 1 — Single-connection voice (no reconnection).**
Realtime plugin wired; session config (§4); semantic_vad + patience settings (§5); the full tool surface (§7) including the five native builder tools and modified `retrieve_memories`; `emit_artifact` 15-field; SSE payloads; diagnostics rewrite; the four audits. Sessions run to the 60-min cap and end gracefully. This is the bulk of the migration and is independently shippable.

**Phase 2 — Reconnection & long sessions (§3.3).**
Token refresh near 29 min, reconnect, context re-seed (Doc 3), spoken bridge. Survives the 60-min cap transparently.

**Phase 3 — Optimizations (deferred).**
Dynamic eagerness by tone band (§5.4); out-of-band responses / `create_response: false` clean injection (Doc 3); mini-model cost paths; realtime-connection prewarm.

---

## 11. Risks & Open Questions

- **`thread_id` → `async_tasks` access** (§7.5) — the load-bearing builder assumption; verify with Jorge at implementation.
- **Mobile/speakerphone false barge-in** (§5.3) — audit in Phase 1; mitigations are frontend-side.
- **Exact `session.update` key paths** (§4.1) — verify nesting against the installed API version + plugin; values are spec, paths are to-confirm.
- **Reasoning-effort sufficiency** (§4.1) — `low` is the start; tool-routing/state-prediction quality decides whether to raise.
- **`reasoning.effort` placement on the realtime model** — confirm it is a valid session-level setting on `gpt-realtime-2` and not a per-response-only field.
- **Mem0 cold-start latency** (§7.3) — preamble covers it; warmup mitigates; measure in Phase 1.

---

## 12. Cross-References

- **Doc 2 — System Prompt:** message channels, preambles, reasoning steering, the coordination contract files (`coordination_core.md` + `companion_delegation.md`), `retrieve_memories` when-to-call, `wait_for_user` usage, `emit_artifact` field semantics, tool-availability instruction, builder result presentation.
- **Doc 3 — Context Engineering:** conversation context model (native server-side state, 60-min boundary, cross-session seeding), truncation/compaction strategy (params live here in §4.1), caching, ambient time injection, reconnection re-seed content.
- **Doc 4 — Spec Map:** reading order; the realtime voice repo structure.
- **`sophia_artifact_traces_architecture_v1.md`:** the artifact substrate emitted by `emit_artifact` and `check_async_task`.
- **`sophia_coordination_stabilization_spec.md`:** deterministic guard inventory, invariants, three-file split.
