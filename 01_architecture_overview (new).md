# Sophia Architecture Overview
## Technical Specification for Implementation

**Version:** 7.0 · March 2026
**Status:** Implementation-ready
**Intelligence:** DeerFlow fork (bytedance/deer-flow)
**Voice:** Vision Agents (getstream/vision-agents) + Cartesia Sonic-3 + Deepgram
**Memory:** Mem0 Platform (9 categories, graph, timestamps, entity partitioning)
**Mobile:** Capacitor (iOS wrapper)

---

## 1. What Sophia Is

Sophia is an AI voice companion that demonstrates genuine continuity, emotional attunement, and measurable growth over time. She is not a therapist, not a coach, not an assistant. She is a companion — someone who remembers, notices, and sometimes surprises.

Five defining properties:
- **Emotional intelligence**: Sophia calibrates her approach based on where the user is emotionally, using a 5-band tone scale. She meets users where they are and lifts them half a point — never more.
- **Genuine continuity**: She remembers across sessions through Mem0's 9-category typed memory, session handoffs, and a persistent identity file. She opens every session aware of where the user left off.
- **Emotionally calibrated voice**: Her voice carries the right emotion for what she's saying — chosen per turn from Cartesia's vocabulary by the LLM, not by rules.
- **Self-improvement**: Every prompt file shaping her behavior is measurable against tone delta and optimizable via BootstrapFewShot and GEPA.
- **Physical presence**: She lives on the user's phone as a native-feeling app — always one tap away, with one-time microphone permission and the full companion experience.

---

## 2. Three Platforms, One Intelligence

Sophia exists on three platforms across two interaction types: **conversations** (bidirectional, sustained) and **text** (typed input). The intelligence layer is identical across all three. What adapts is the delivery.

### Conversation Platforms

| Platform | Interaction | Response length | Artifact | Voice emotion |
|----------|------------|-----------------|----------|---------------|
| **Voice (web app)** | Real-time WebRTC, hands-free | 1–3 sentences | Full 13-field | Full (drives Cartesia TTS) |
| **Voice (iOS app)** | Real-time WebRTC via Capacitor | 1–3 sentences | Full 13-field | Full (drives Cartesia TTS) |
| **Text (web app)** | In-app text chat | 2–5 sentences | Full 13-field | Tracked, not delivered |

The `PlatformContextMiddleware` sets `state["platform"]` on every request. Valid platform values: `"voice"`, `"text"`, `"ios_voice"`. Downstream middlewares adapt based on this signal — response length, artifact depth, and delivery format all adjust per platform.

---

## 3. User-Controlled Session Structure

The user drives every session. There is no ambiguous intent detection for session mode.

**Context selection (3 options, app setting):**
- Work — strategic ally, professional stakes, grounded confidence
- Gaming — teammate and coach, higher energy, faster rhythm
- Life — deepest register, patient, willing to wait

**Session type (user choice at session start):**
- Free conversation — no ritual, Sophia follows the user's lead
- Prepare ritual — structured intention-setting for what's ahead
- Debrief ritual — processing what happened
- Vent ritual — holding space, no agenda
- Reset ritual — grounding when overwhelmed

Ritual and context are passed as `configurable` parameters to the LangGraph server. The middleware chain reads them — never guesses them.

---

## 4. The Two-Service Architecture

```
┌─────────────────────────────────────────────────────────┐
│  VOICE LAYER — Vision Agents                             │
│  "The ears, mouth, and presence"                         │
│                                                          │
│  User ↔ WebRTC (Stream) ↔ Vision Agents server          │
│  Clients: Web app (React SDK) · iOS app (Capacitor)     │
│                                                          │
│  STT: Deepgram Nova-2                                    │
│  Turn Detection: Smart Turn (neural)                     │
│  Barge-in: Automatic                                     │
│  TTS: Cartesia Sonic-3 (LLM-chosen emotion per turn)    │
│                                                          │
│  Plugins: SophiaLLM · SophiaTTS · SophiaTurn (future)  │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP — text + artifact metadata
                         │ Streaming (runs/stream)
┌────────────────────────┴────────────────────────────────┐
│  INTELLIGENCE LAYER — DeerFlow fork                      │
│  "The brain, memory, and personality"                    │
│                                                          │
│  LangGraph server (port 2024)                            │
│  sophia_companion graph — 14-middleware chain            │
│  sophia_builder — DeerFlow lead_agent as subagent        │
│  Mem0 Platform — 9-category typed persistent memory      │
│  Offline pipeline — handoffs, extraction, identity, GEPA │
└─────────────────────────────────────────────────────────┘
```

**Voice layer** handles: WebRTC transport, STT, turn detection, barge-in, TTS with emotion injection. It knows nothing about Sophia's personality. Both web and iOS clients connect to the same Vision Agents server — the iOS Capacitor app uses WebRTC inside WKWebView identically to the web app.

**Intelligence layer** handles: personality, emotional calibration, memory, ritual routing, skill selection, artifact generation, and self-improvement. It knows nothing about audio transport.

They communicate via HTTP. Vision Agents uses `runs/stream` (not `runs/wait`) to pipe text tokens to Cartesia as they arrive — Sophia's voice starts after TTFT, not after full generation. Artifact metadata arrives via the `emit_artifact` tool call result, after the text stream completes.

---

## 5. The Two Agent Modes

### Companion Mode (Primary)
The core experience. Emotionally calibrated, ritual-aware, voice-first.

- Model: Claude Haiku 4.5 (sub-second TTFT at typical prompt size)
- Peak prompt: ~9,100 tokens (see §6 budget)
- Tools: `emit_artifact` (required every turn), `switch_to_builder` (delegation), `retrieve_memories` (targeted deep retrieval)
- All 14 companion middlewares active (see 04_backend_integration.md)

### Builder Mode (Subagent Delegation)
Triggered when the user asks Sophia to CREATE something. Runs as a DeerFlow subagent via the `task()` pattern — the companion stays live in the conversation while the builder works in the background.

- Graph: `sophia_builder` = DeerFlow `lead_agent` graph (unmodified)
- Model: Claude Sonnet 4.6
- Tools: Full DeerFlow toolset (bash, file ops, web search, present_files)
- Middlewares: 7-step lean chain (no emotional middleware, no artifact system)
- Companion relays progress: *"Still working, on step 2 of 3..."*
- Clarification happens BEFORE `task()` call in the companion, not inside the builder

**Mode switching:**
1. User says something that implies building ("make me a one-pager")
2. Companion's LLM calls `switch_to_builder` tool
3. `switch_to_builder` invokes `task("build X", agent="sophia_builder", context={...})`
4. Companion responds immediately to user while builder runs asynchronously
5. Builder completes, returns result via tool result message
6. Companion synthesizes result in Sophia's voice

---

## 6. Prompt Token Budget (Companion, Voice Platform)

| Component | Tokens | Loading strategy |
|-----------|--------|-----------------|
| soul.md | ~450 | Always |
| voice.md | ~1,440 | Always |
| techniques.md | ~963 | Always |
| **Always-loaded subtotal** | **~2,853** | |
| Tone guidance (1 band of 5) | ~726 | Per-turn (partial injection) |
| Context adaptation (1 of 3) | ~130 | Per-turn |
| Ritual file (if active) | ~600 | When ritual is set |
| artifact_instructions.md | ~2,760 | Voice + text platforms |
| User identity summary | ~650 | When file exists |
| Session handoff | ~375 | When file exists |
| Smart opener instruction | ~50 | First turn only |
| Mem0 memories (filtered) | ~750 | Per-turn |
| Previous artifact | ~200 | Turn 2+ (conditional) |
| Active emotional skill | ~650 | When skill loaded |
| **Typical peak (voice, with skill)** | **~9,144** | |

**4.6% of Claude Haiku's 200k context at voice peak.** Well within limits.

---

## 7. Memory Architecture

Full detail in 03_memory_system.md. Key points:

**Mem0 Platform** is the single memory backend. 9 custom categories: `fact`, `feeling`, `decision`, `lesson`, `commitment`, `preference`, `relationship`, `pattern`, `ritual_context`.

**Per-turn retrieval:** Rule-based category selection (zero latency) → Mem0 semantic search within selected categories → inject ~750 tokens. LRU cache (60s TTL) hits ~70% of turns within a session.

**No MCP for Mem0:** Python SDK direct call is faster than MCP (one fewer network hop). Rule-based category selection stays in Python where it belongs. MCP not appropriate for per-turn critical-path retrieval.

**Agentic retrieval via tool:** `retrieve_memories` tool available to agent for targeted deep dives (reflect flow, specific person queries). Not used for baseline per-turn injection.

**Offline pipeline** (fires on session end):
1. Smart opener generation
2. Handoff file write (`users/{user_id}/handoffs/latest.md`)
3. Mem0 extraction (categorized, `pending_review`)
4. In-app notification (memory candidates ready for review)
5. Trace aggregation
6. Identity file update (every 10 sessions or on structural memory change)
7. Visual artifact check (weekly, if 3+ sessions)

---

## 8. The Smart Opener System

At session end, the offline pipeline generates a **smart opener**: a single warm, context-aware sentence Sophia will use to start the next session — before the user says anything.

Generated from: handoff `next_steps`, `open_threads`, `tone_estimate_final`, `feeling`, elapsed time since last session, and any Mem0 memories written since then.

Stored in `handoffs/latest.md` YAML frontmatter: `smart_opener: "..."`.

Injected by `SessionStateMiddleware` on first turn only as a `FIRST TURN INSTRUCTION` in the system prompt. Sophia adapts the phrasing naturally but delivers the intent.

Examples by scenario:
- Upcoming event: *"The investor pitch is tomorrow. How are you feeling going into it?"*
- Unresolved thread: *"You mentioned the conversation with your co-founder — did that happen?"*
- After absence (3+ days): *"It's been a few days. Where are you at?"*
- Low close tone + no open threads: *"How are you doing today?"* (simple — don't overcomplicate a quiet return)
- Post-breakthrough session: *"Something shifted last time. How does it feel from the other side?"*

---

## 9. Self-Improvement Loop

Trace logging starts Week 2, runs permanently. Every turn writes a JSON trace including: `tone_before`, `tone_after`, `tone_delta`, `voice_emotion_primary`, `skill_loaded`, `active_tone_band`, `memory_injected`, `platform`, `ritual`.

**BootstrapFewShot (Week 6):** Collect golden turns (tone_delta >= +0.5). Select top 3-5. Inject as examples into `voice.md`. A/B test vs original.

**GEPA (Week 6+):** Evolutionary optimization of `voice.md` first, then `tone_guidance.md`, then ritual files. Optimization signal: tone_delta (primary) × Claude-isms absence (secondary) × ritual coherence (tertiary). `soul.md` is permanently excluded — architecturally blocked, never a GEPA target.

---

## 10. iOS via Capacitor

### 10.1 What It Is

The existing Next.js web app wrapped in a native iOS shell using Capacitor. Installable from the App Store (or TestFlight during beta). Appears as a native app — home screen icon, no browser chrome, system-level permissions.

### 10.2 Why Capacitor

- **Microphone permission solved.** Mobile Safari requires per-session mic approval. Capacitor grants one-time native iOS permission — user approves once, never asked again.
- **No Swift required.** Luis stays in TypeScript. The native shell is auto-generated.
- **Same voice quality.** WebRTC works in WKWebView. The full streaming pipeline (Deepgram → Smart Turn → DeerFlow → Cartesia) runs identically to the web app.
- **Full app experience.** Home screen icon, no browser chrome, native feel without native code.

### 10.3 What the iOS App Contains

**Full web experience (via WKWebView) — identical to web app:**
- Live conversation mode (WebRTC streaming)
- Message mode (push-to-talk)
- Text mode
- Memory candidates with edit
- Sophia Journal (Memories, Insights, Timeline)
- Visual artifacts
- Context and ritual selection

**Native addition (via Capacitor):**
- One-time microphone permission (system-level, not per-session Safari prompt)

### 10.4 iOS App Flow

```
User opens Sophia iOS app
  → WKWebView loads Next.js app
  → One-time mic permission already granted (system level)
  → Full voice experience: Deepgram STT → Smart Turn → DeerFlow → Cartesia TTS
  → Identical experience to web app, no Safari prompts
```

---

## 11. Team Structure

| Person | Role | Primary ownership |
|--------|------|------------------|
| Davide | Product / Architecture / Quality | Pairing, quality review, architecture decisions |
| Jorge | Backend Developer | DeerFlow middleware chain, Mem0, offline pipeline, GEPA, builder subagent |
| Luis | Voice + Frontend/UX | Vision Agents, voice emotion, memory candidates, Journal, visual artifacts, Capacitor iOS |

Three parallel tracks with weekly convergence. Weeks 1–5: core companion build. Week 6: polish, Capacitor iOS, GEPA first pass. Tracks never block each other. API contracts defined in Week 1 before parallel work begins.

---

## 12. Key Principles

1. **DeerFlow as foundation, not modification target** — `lead_agent/` stays untouched. Sophia lives in `sophia_agent/` and `sophia/` directories alongside it.
2. **Mem0-first** — Python SDK direct calls, no MCP for per-turn retrieval, LRU cache for latency.
3. **Vision Agents as voice layer** — thin plugins (`SophiaLLM`, `SophiaTTS`), no custom transport.
4. **Voice emotion from the LLM, not from rules** — the model that wrote the words chooses the voice.
5. **Streaming over waiting** — `runs/stream` for all conversations.
6. **Platform signal is structural** — `PlatformContextMiddleware` sets context early; every downstream layer adapts. Three platform values: `"voice"`, `"text"`, `"ios_voice"`.
7. **soul.md is immutable** — architecturally blocked from GEPA. Two enforcement mechanisms: filesystem read-only + GEPA exclusion list.
8. **Builder as subagent** — companion stays live during build. No two-graph switching. No dead silence on voice.
9. **Session end is inactivity, not explicit** — 10-minute timeout catches the real-world pattern. Offline pipeline is idempotent.
10. **Parallel tracks with weekly convergence** — Jorge and Luis build simultaneously against defined contracts.
11. **Capacitor before native** — iOS app ships as a wrapped web app. Same voice quality, zero Swift. Native iOS (Phase 2+) only after real user feedback.

---

## 13. Build Phases

**Phase 1 — Core Companion + iOS (Weeks 1–6):**
Voice experience, text mode, memory system, rituals, middleware chain, smart opener, offline pipeline, visual artifacts, Journal, reflect flow, builder subagent, identity file, BootstrapFewShot, first GEPA pass, Capacitor iOS wrapper.

**Phase 2 — Expansion (Future):**
External channel integrations, proactive outreach system, native Swift iOS app (Stream iOS SDK), wake word detection (Picovoice), background audio, experience bank (paired golden/poor turns), GEPA on additional prompt files, Twilio phone integration.

---

*Companion specs:*
- *`02_build_plan.md` — 6-week phased build, three parallel tracks*
- *`03_memory_system.md` — Mem0, categories, retrieval, handoffs, smart opener, reflection*
- *`04_backend_integration.md` — DeerFlow middleware chain, voice pipeline, offline flows, GEPA*
- *`05_frontend_ux.md` — Vision Agents, memory candidates, Journal, visual artifacts, Capacitor iOS*
- *`06_implementation_spec.md` — Codebase-specific implementation details for Jorge and Luis*
