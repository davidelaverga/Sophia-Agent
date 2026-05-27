# Sophia Voice — Context Engineering Spec

**Version:** 1.0 · **Status:** Draft for sign-off · **Date:** 2026-05-21
**Doc 3 of 4** in the Sophia Voice spec set (decomposed from `sophia_gpt_realtime_experiment_spec_v1_3.md`, now superseded).
**Siblings:** Doc 1 — Runtime & Tools · Doc 2 — System Prompt · Doc 4 — Spec Map
**Hard dependencies:** `sophia_artifact_traces_architecture_v1.md` (the artifact trail as in-context substrate); `sophia_memory_upgrades_spec_v2_1.md` (hybrid retrieval, the offline pipeline).
**Owner:** Davide + Luis · **Co-owner:** Jorge (offline pipeline, Mem0)

---

## 0. Required Reading

**OpenAI Realtime documentation** (gpt-realtime-2):
- *Realtime conversations* (`platform.openai.com/docs/guides/realtime-conversations`) — the server-side **default conversation**, items, how the model attends to accumulated context, function-call items, truncation behavior.
- *Realtime* cost/context section — `truncation` (`retention_ratio`), prompt caching behavior on the audio model, what counts toward the context window.
- *Realtime models prompting* — long-context structuring guidance (how to lay out injected context so the model uses it).
- *Realtime sessions API reference* — `session.update` for `instructions` and `truncation`; `conversation.item.create` for injected items.

**Internal source files:**
- `voice/server.py` — session start (where the seed is applied) and `bind_session_context`.
- `sophia/offline_pipeline.py` — the 7-step session-end pipeline (smart opener, handoff, identity) that produces the seed inputs and is the cross-session write path.
- `sophia/smart_opener.py`, `sophia/handoffs.py`, `sophia/identity.py` — the seed content producers.
- `sophia/mem0_client.py` — the Mem0 wrapper + LRU cache the seed and `retrieve_memories` both read through.
- `memory_middleware.py` — the text companion's write-queue middleware (does **not** run in voice; §3 explains the consequence).

**Internal specs:**
- `sophia_memory_upgrades_spec_v2_1.md` — hybrid retrieval (categories are metadata, not filters), prefetch design (text companion), the 10th `goal_structure` category.
- `sophia_artifact_traces_architecture_v1.md` — `emit_artifact` items as the within-session trail; the builder `latest_artifact_summary`.
- Doc 1 §3 (reconnection mechanics, 60-min cap), §4.1 (truncation params live there).

---

## 1. What This Document Covers

This doc answers one question: **what is in the model's context window at any moment, and how did it get there?** It covers how `gpt-realtime-2` handles conversation context natively, the two memory paths (write and read) and why they diverge from the text companion in the voice runtime, the session-start seed, the minimal per-turn injection, the truncation/compaction strategy, caching, and the reconnection re-seed.

It does **not** contain the prompt text (Doc 2) or the runtime wiring (Doc 1). The session-config *values* (truncation ratio, etc.) live in Doc 1 §4.1; this doc owns the *strategy and rationale*.

A reconciliation up front: Doc 1 §7.3 gates `retrieve_memories` to explicit recall and refers to a "per-turn prefetch." In the voice runtime there is **no per-turn memory prefetch** (§3 explains why). The gating conclusion is unchanged — retrieve only on explicit recall — but the reason is sharper: the **session seed already loaded the relevant memory set, and the model retains the whole conversation natively within the session.** Read Doc 1 §7.3 with that substitution.

---

## 2. How gpt-realtime-2 Handles Conversation Context (and What It Means for Us)

This section is the conceptual foundation. The voice context model is genuinely different from the text companion's, and getting the mental model right prevents a class of mistakes.

### 2.1 The native model: a stateful server-side conversation

A realtime connection maintains a single stateful **"default conversation"** on OpenAI's side. Every item appends to it: the user's transcribed audio, the model's spoken responses, function calls *and their outputs*, and any items we inject. On each response, the model attends to the **entire accumulated conversation natively** — we do not replay history, we do not pass a message array, we do not run a checkpointer. The connection *is* the memory. (Reference: *Realtime conversations → the conversation and items*.)

This is the opposite of two models Sophia already runs:
- **The stateless completions pattern** (e.g., the Claude-in-artifacts API) where every call resends the full history.
- **The text companion's LangGraph pattern**, where a checkpointer persists thread state and middleware **re-injects** context (memory, identity, tone) into the system prompt on *every turn*, because a fresh prompt is assembled each turn.

In the realtime model, neither applies *within a session*. The model holds it.

### 2.2 Four consequences for Sophia

1. **Within a session, we do almost no context management.** The conversation, Sophia's `emit_artifact` items, tool calls and outputs are all natively present. The within-session artifact-trail anchoring from the artifact-traces spec (Sophia reading her own prior predictions/reflections) **works for free** — those artifacts are conversation items the model already sees. We do not re-inject the trail.

2. **The context is ephemeral — it dies with the connection.** There is no persistence across connections. Cross-session continuity, *and* continuity across a mid-session reconnection (Doc 1 §3.3), is **entirely ours** — produced by the offline pipeline and re-applied as a seed. The model remembers nothing on its own between connections.

3. **The 128k window + 60-min cap bound the native context.** Within those bounds the model carries everything. Overflow is handled by native truncation (drop-oldest), which on a 128k window rarely fires inside a 60-minute session (§6). We tune the ratio; we do not hand-manage history in v1.

4. **The injection model inverts.** The text companion *pushes* context every turn (middleware re-injection). The voice model is *seeded once* and then *pulls* on demand (`retrieve_memories`, `web_search`, `check_async_task`). Push-every-turn becomes seed-once-plus-pull. This is the single most important shift in this document.

### 2.3 Why this is the right fit for a voice companion

Push-every-turn injection costs latency — fatal in a real-time audio loop. Seed-once-plus-pull spends the latency once (at session start, hidden behind the greeting) and then lets the model decide when it needs more, using the full conversational context to make that decision. It also aligns with the standing principle: the harness sets up the field (the seed) and enforces structure; the model decides, within that field, what semantic content (which memory, when) it needs.

---

## 3. The Two Memory Paths

Memory has a **write** path and a **read** path. In the text companion both are LangGraph middleware. In the voice runtime, the per-turn middleware does not run — so the two paths must be re-grounded.

### 3.1 Write path — preserved, unchanged

The text companion writes via the async queue (`memory_middleware.py` → `get_memory_queue()`) and the offline pipeline at session end. The voice runtime triggers the **same offline pipeline** via the gateway end-session endpoint (`POST /api/sophia/{user_id}/end-session`). The voice session's transcript and trace feed the pipeline's extraction step exactly as a text session would.

**Nothing about the write path needs to change for voice.** Extraction → Mem0 (`status=pending_review`), handoff, identity update, smart-opener generation all run at session end, off the hot path. (Reference: `offline_pipeline.py`; backend map → offline pipeline steps.) The only requirement: the voice session must produce a transcript/trace the pipeline can consume — which it does via the output/input transcription events (Doc 1 §4.1).

### 3.2 Read path — re-grounded as seed + on-demand

The text companion *reads* memory via per-turn retrieve-and-inject middleware (the prefetch at middleware position 3, awaited and injected at position 14 — `sophia_memory_upgrades_spec_v2_1.md`). **That middleware does not run in the voice runtime.** The read path becomes two mechanisms:

- **Session-start seed (§4):** at session open, retrieve the memory set relevant to this session's intent and place it in the seed. This is the bulk of what the text companion's per-turn prefetch would have surfaced, gathered once.
- **On-demand pull (`retrieve_memories`, Doc 1 §7.3):** during the session, the model retrieves specific memories on explicit recall cues. The hybrid weighted scoring (`sophia_memory_upgrades_spec_v2_1.md`) runs inside the shared core; the model supplies only a query.

### 3.3 What we deliberately do NOT do in v1

We do **not** port the per-turn frame-based prefetch into the voice loop. Doing so would require a synchronous Mem0 retrieval before each response — re-introducing exactly the per-turn latency the native model lets us avoid. If Phase-1 audits show the seed-plus-pull model misses relevant memory (the model fails to realize it should retrieve), the v2 enhancement is **asynchronous out-of-band injection**: inject a retrieved memory as a `conversation.item.create` *between* turns, never blocking a response. That is a deliberate v2 design with its own latency budget, not a v1 default.

---

## 4. Session-Start Seed

### 4.1 The structured template

OpenAI's long-context guidance is to lay injected context out in labeled sections so the model can locate and weight it. Sophia's seed uses three tiers, ordered by how load-bearing they are (which also sets truncation priority — §6):

```
## Current State
- Smart opener: <pre-generated first line for this session>     (smart_opener.py)
- Session intent: ritual=<…>, context_mode=<work|gaming|life>   (bind_session_context)
- Recent handoff: <2–4 line summary of the last session>        (handoffs/latest.md)
- Active build: <task_id + one-line status, if any in-flight>   (async_tasks via thread_id)

## Authoritative (stable facts — treat as ground truth about the user)
- Identity: <who they are, durable facts, how they relate to Sophia>   (identity.md)
- Active goals / commitments: <current goal_structure entries>         (Mem0 goal_structure)
- Relevant memories for this intent: <top N from the seed retrieval>   (mem0_client)

## Background (lower priority — first to be dropped under truncation)
- Broader patterns, preferences, and history surfaced by the seed retrieval
```

(Reference: prompting guide → long-context structuring; the producers are `smart_opener.py`, `handoffs.py`, `identity.py`, `mem0_client.py`.)

### 4.2 Where the seed lives, and the cache boundary

The seed is **dynamic per session** but **static within a session** (it does not change turn to turn). Placement, relative to Doc 2's cache split:

- The **stable block** (soul/voice/techniques, the coordination files, the tone framework) is identical across all sessions and all users → it is the cacheable prefix.
- The **seed** is per-user, per-session → it goes *after* the stable prefix, in the instructions, set once at session start. It is not cacheable across sessions (it differs every time), but it is stable *within* the session, so it does not bust the cache turn-to-turn.

The boundary matters: anything that changes *within* a session (ambient time — §5) must not sit in the seed or the stable block, or it would invalidate the cache on every turn. It goes in a turn-tail item instead.

### 4.3 The seed retrieval

The seed's "relevant memories" come from a single Mem0 retrieval at session start, keyed on the session intent (ritual + context_mode + the smart opener's implied topic). This is the one place we spend retrieval latency eagerly — and it is hidden behind the greeting/opener, so the user never feels it. Cap the seed memory set to a token budget (Background is the first thing trimmed if over budget).

---

## 5. Per-Turn Injection (Minimal in v1)

Within a session the model holds context natively, so per-turn injection is deliberately near-zero. Two exceptions:

### 5.1 Ambient time — cache-safe placement

Time changes continuously and the model has no clock. Inject the current time, but **never into the seed or the stable instructions** (that would bust the prompt cache every turn — §4.2). Inject it as a short turn-tail item (e.g., a system note appended just before the response is generated) or rely on the `get_current_time` tool (Doc 1 §7.2) for precise reads. The ambient injection gives Sophia a rough "it's evening" sense without a tool call; the tool gives an exact read when one matters. (Reference: cost/context → caching; place mutable content outside the cached prefix.)

### 5.2 Builder status — pulled, not pushed

In-flight builder status is **not** pushed every turn. The model pulls it via `check_async_task` when the user asks or it is relevant (Doc 1 §7.5). The active-build line in the seed's Current State (§4.1) covers the session-open snapshot; thereafter the model checks on cue. This honors the coordination invariant "no timer-based polling."

---

## 6. Truncation & Compaction Strategy

### 6.1 Native truncation — what it is and isn't

`gpt-realtime-2` truncation is **drop-oldest**, not summarization. When the conversation exceeds the configured threshold, the oldest items are dropped. With `retention_ratio: 0.8` (Doc 1 §4.1), it drops a bit extra past the threshold so it fires less often (each truncation busts cache, so frequent small truncations are worse than occasional larger ones). On a 128k window, this **rarely fires inside a 60-minute session** — the parameter is correctness insurance, not an active management lever. **Do not set `truncation: disabled`** (it errors rather than degrading gracefully). (Reference: cost/context → truncation.)

### 6.2 What we deliberately do NOT do

- **No roll-your-own summarization for truncation.** We do not delete items and insert a summary mid-session. The native drop-oldest is sufficient given the window size, and self-summarization mid-session adds latency and risk for a case that rarely arises.
- **No opaque compaction item.** OpenAI's first-class compaction (an encrypted, opaque conversation item) is a Responses-API feature, not on the Realtime path — and we would reject it regardless, because an opaque blob violates the standing principle that *our files are the source of truth* for what Sophia knows. We never want context Sophia can't inspect, version, or feed to GEPA.

### 6.3 Our actual compaction is the offline pipeline

Sophia *does* compact — but across sessions, not within one, and not via the model. The offline pipeline is the compaction engine, and it follows the persistence-layer-transformation principle (each layer transforms the one below):

```
raw conversation (ephemeral, dies with the connection)
   → session trace + transcript        (trace_logger)
   → extracted memories                (extraction → Mem0)
   → handoff summary                   (handoffs/latest.md)
   → identity                          (identity.md)
```

The 60-minute connection boundary is a hard reset of the *native* context; continuity across it is re-established from these compacted layers via the seed (§4) or the reconnection re-seed (§7). This is the correct place for compaction: deliberate, inspectable, curated, off the hot path — not a mid-call summarization scramble.

---

## 7. Reconnection Re-Seed (Content)

The reconnection *mechanism* is Doc 1 §3.3 (detect drop / token refresh near 29 min / re-establish connection). This section specifies the *content* of the re-seed, because a reconnected connection starts with an **empty server-side conversation** — everything the model held is gone.

The re-seed is the session-start seed (§4) **plus** one element the session start doesn't need: a brief **in-session continuity summary** — 3–6 lines capturing what this session has covered so far, the current emotional register, and the latest `emit_artifact` state (current `session_goal`, `active_goal`, last `predicted_user_trajectory`).

This is the **one place in v1 where we summarize a live conversation**, and it is justified: it is rare (only at reconnection), off the response hot path (generated during the reconnect gap), and necessary for the continuity to feel seamless rather than amnesiac. Source it from the just-ended connection's transcript + the last artifact item. Pair with the spoken bridge (Doc 1 §3.3).

Because reconnection is Phase 2 (Doc 1 §10), this re-seed content is specified now but built then.

---

## 8. The Artifact Trail as In-Context Substrate

Per `sophia_artifact_traces_architecture_v1.md`, every `emit_artifact` call is a **commentary-channel function call** — which means it is a **conversation item**. Within a session, the model's own prior artifacts are therefore natively in context. Consequences:

- **Within-session anchoring works for free.** When the artifact-traces design has Sophia read turn N's `predicted_user_trajectory` and reflect on it in turn N+1's `previous_turn_reflection`, the turn-N artifact is already a visible item. No re-injection.
- **Across a reconnection it is lost** (empty conversation) — which is exactly why the re-seed (§7) carries the latest artifact state forward.
- **The frontend and GEPA read the trail via the SSE `sophia.artifact.emitted` events** (Doc 1 §8), not from the model's context — those are independent capture paths. The model's native access and the external capture are two separate consumers of the same emitted artifacts.

---

## 9. Risks & Open Questions

- **Seed-plus-pull vs. proactive surfacing** (§3.3) — does the model reliably realize when to `retrieve_memories`? Phase-1 audit; v2 fallback is async out-of-band injection.
- **Seed token budget** (§4.3) — the Authoritative + Background tiers must fit a budget that leaves ample room for the conversation; measure typical seed size against the 128k window and the cache economics.
- **Ambient-time placement** (§5.1) — confirm the turn-tail injection path that adds a mutable note without busting the cached prefix; verify against the plugin's `session.update` / `conversation.item.create` behavior.
- **Reconnection summary quality** (§7) — the in-session continuity summary must be faithful; a bad summary makes the reconnect feel worse than a clean restart. Phase-2 concern.
- **Transcript fidelity for the write path** (§3.1) — confirm the realtime transcription events produce a transcript complete enough for the offline pipeline's extraction quality.

---

## 10. Cross-References

- **Doc 1 — Runtime & Tools:** session config values (§4.1 truncation, transcription), reconnection mechanics (§3.3), the tool surface that does the on-demand pulling, SSE artifact events.
- **Doc 2 — System Prompt:** the cache split (stable prefix vs dynamic), where the seed sits in the assembled prompt, `retrieve_memories` when-to-call phrasing, ambient-time framing.
- **Doc 4 — Spec Map:** reading order; repo structure.
- **`sophia_artifact_traces_architecture_v1.md`:** the artifact items that form the in-context trail; the builder `latest_artifact_summary`.
- **`sophia_memory_upgrades_spec_v2_1.md`:** hybrid retrieval internals, the offline pipeline, `goal_structure`.
