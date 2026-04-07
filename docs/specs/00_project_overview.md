# Sophia — Project Overview
## Read This First

**Version:** 6.0 · March 2026
**Team:** Davide (Product/Architecture), Jorge (Backend), Luis (Voice + Frontend)

This document explains WHAT we're building and WHY. The companion spec files explain HOW.

---

## The One-Sentence Version

Sophia is a voice companion that remembers you, speaks with emotional intelligence, improves over time, and reaches out when something matters — across your phone, your browser, and your messaging apps.

---

## What Makes Sophia Different

Every AI assistant can answer questions. Several can hold a conversation. Sophia does something none of them do: she builds a genuine, persistent relationship with the user that compounds over time.

This is not a feature list. It's five capabilities that, together, create something that feels fundamentally different from talking to an AI.

### 1. She Remembers — And Uses What She Remembers

Most AI conversations start from zero. Sophia starts from everything she knows about you.

Your facts, feelings, decisions, lessons, commitments, preferences, relationships, patterns, and how you use each ritual — all stored as typed, timestamped memories across sessions. When you sit down for a debrief, Sophia already knows you had a big meeting today (from a prepare session last week), that presentations make you anxious (from a pattern she noticed over three sessions), and that you respond better to direct challenge than gentle encouragement (from a preference she observed).

This isn't retrieval-augmented generation dropping facts into a prompt. It's a categorized memory system where the right memories surface at the right time — patterns during reflection, commitments during preparation, relationship dynamics when you mention a person by name.

**Spec reference:** `03_memory_system.md` — Mem0 configuration, 9 categories, retrieval strategy, extraction pipeline.

### 2. She Speaks With the Right Emotion at the Right Moment

Sophia isn't text-to-speech reading words aloud. Every turn, the LLM chooses HOW she should sound — from Cartesia's 60+ emotion vocabulary — based on what she's saying and why.

When she's holding space during vulnerability, her voice is `sympathetic` and slow. When she celebrates a breakthrough, it shifts to `proud` and slightly faster. When she asks a reflective question, it's `curious` and unhurried. The user never thinks about this. They just feel like Sophia GETS the rhythm of the conversation.

Beyond emotion, the conversation itself feels natural. Neural turn detection knows when you're pausing to think versus when you're done speaking. You can interrupt Sophia mid-sentence and she stops, listens, adapts. Dynamic silence thresholds give you more space during grief and match your energy during enthusiasm.

**Spec references:** `artifact_instructions.md` (voice emotion fields), `04_backend_integration.md` §7 (Voice Layer), `06_vision_agents_reference.md`.

### 3. She Gets Better Every Session

Every turn Sophia takes is measured. Did the user's emotional state improve? By how much? Which approach worked? Which didn't? This data accumulates in execution traces — and then drives improvement.

The simplest loop: golden turns (where tone improved significantly) get extracted and injected as few-shot examples into Sophia's personality file. She literally learns from her best moments.

The advanced loop: GEPA (Genetic-Pareto Prompt Evolution) takes the prompt files that shape Sophia's behavior — her voice, her tone guidance, her techniques — and evolves them against measured outcomes. The variants that produce better emotional shifts survive. The ones that don't are discarded. Soul.md (her values) is permanently excluded from optimization — her character is fixed, her craft improves.

The ultimate loop: an experience bank that pairs successful and failed approaches in the same emotional context, extracts the STRATEGY that worked ("when the user deflects with humor below tone 2.0, mirroring their exact words then pausing produced a +0.7 lift; direct questioning produced a -0.3 drop"), and feeds these strategies back as operational wisdom.

**Spec reference:** `01_architecture_overview.md` §9 (Self-Improvement Loop), `04_backend_integration.md` §10 (GEPA Integration).

### 4. She Reaches Out Before You Ask

Traditional AI is reactive: you open the app, you ask a question, you get an answer. Sophia has a heartbeat — an autonomous time loop that runs on a schedule, scanning memory for things worth reaching out about.

Your investor meeting is tomorrow morning? Sophia sends a voice note tonight: "Hey, I know tomorrow's a big one. You've prepared well. Sleep on that." A commitment you made three weeks ago hasn't been mentioned since? "I was thinking about the goal you set around direct feedback. Still working on that, or has it shifted?" Three sessions in a row showed declining tone? She checks in, gently.

This isn't a notification engine. It's a companion that thinks about you between sessions — and most of the time, the right decision is silence. The heartbeat has strict constraints: maximum one proactive push per day, never nag, back off if the user doesn't respond.

The delivery is a voice note — Sophia's actual voice, with the right emotion, sent as a push notification on iOS or as a Telegram voice message. You hear her without opening the app.

**Spec references:** `01_architecture_overview.md` §10 (Heartbeat System), `03_memory_system.md` §10 (Heartbeat Memory Scanning), `04_backend_integration.md` §11 (Heartbeat Backend).

### 5. She Can Build Things — Shaped by Your Relationship

When you ask Sophia to create something — a presentation, a landing page, a research summary — she doesn't act like a generic AI tool. She builds it as someone who KNOWS you.

The presentation for your investor demo leads with emotional intelligence because she knows that's what lights up your face when you talk about your project. The email to your co-founder is direct because she knows your communication style. The research summary focuses on the aspects she knows matter to you.

This isn't a separate product. It's the same companion, switching from conversational mode to builder mode — carrying the full context of your relationship into what she creates. She switches back to companion mode to present the result: "I built this around what you keep coming back to."

**Spec reference:** `01_architecture_overview.md` §5 (Two Agent Modes), `04_backend_integration.md` §6 (Builder System).

---

## The Infrastructure That Enables This

Five higher-level goals. Four infrastructure layers that make them real.

```
┌──────────────────────────────────────────────────────────────┐
│                     WHAT THE USER EXPERIENCES                  │
│                                                               │
│  Remembers me · Right emotion · Gets better · Reaches out     │
│  Builds things · Continuity · Rituals · Reflection            │
│                                                               │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌────────────┐  ┌──────────────┐  ┌───────────┐  ┌───────┐ │
│  │  VOICE     │  │ INTELLIGENCE │  │  MEMORY   │  │ REACH │ │
│  │  LAYER     │  │ LAYER        │  │  LAYER    │  │ LAYER │ │
│  │            │  │              │  │           │  │       │ │
│  │ Vision     │  │ DeerFlow     │  │ Mem0      │  │ APNs  │ │
│  │ Agents     │  │ Fork         │  │ Platform  │  │ Tele- │ │
│  │ Deepgram   │  │ LangGraph    │  │           │  │ gram  │ │
│  │ Cartesia   │  │ Middleware   │  │           │  │ Heart │ │
│  │ Stream     │  │ Claude       │  │           │  │ beat  │ │
│  └────────────┘  └──────────────┘  └───────────┘  └───────┘ │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### Voice Layer — Making Sophia Present

**Technology:** Vision Agents + Deepgram (STT) + Cartesia Sonic-3 (TTS) + Stream (WebRTC)

**What it does:** Handles everything about hearing and speaking. Converts speech to text (Deepgram). Detects when the user is done speaking (Smart Turn neural model). Converts Sophia's text to emotionally voiced audio (Cartesia with LLM-chosen emotion per turn). Manages barge-in (user interrupts, Sophia stops). Streams audio bidirectionally via WebRTC.

**Why this stack:** Vision Agents replaces 10-14 weeks of custom voice infrastructure with a pip install. We write ~200 lines of custom plugin code. Everything else — turn detection, echo cancellation, audio buffering, transport — is framework.

**Spec references:** `04_backend_integration.md` §7, `05_frontend_ux.md` §2, `06_vision_agents_reference.md`.

### Intelligence Layer — Making Sophia Sophia

**Technology:** DeerFlow fork (ByteDance) + LangGraph + Claude Haiku (companion) / Claude Sonnet (builder)

**What it does:** This is where personality, emotional calibration, skill routing, and artifact generation happen. A middleware chain assembles Sophia's prompt from 19 skill files — loading the right personality, the right emotional guidance, the right skill protocol, and the right memories for every single turn.

The middleware chain in order: thread data → soul → voice → techniques → user identity → session state → tone guidance → context adaptation → skill router → ritual → memory → artifact. Each layer adds the right context. The result is a prompt that is precisely calibrated for THIS user in THIS emotional state at THIS moment.

Two modes: **companion** (Claude Haiku, sub-second, emotional conversation) and **builder** (Claude Sonnet, minutes-acceptable, creates artifacts). The companion decides when to switch. Context flows through LangGraph state.

**Why DeerFlow:** Production-grade LangGraph server with middleware patterns, subagent delegation, skills discovery, thread management, Telegram channel, and FastAPI gateway. We extend it, we don't rewrite it.

**Spec references:** `01_architecture_overview.md` §4-5, `04_backend_integration.md` §2-6, `06_implementation_spec.md`.

### Memory Layer — Making Sophia Remember

**Technology:** Mem0 Platform (managed)

**What it does:** Stores everything Sophia knows about the user in 9 typed categories: fact, feeling, decision, lesson, commitment, preference, relationship, pattern, ritual_context. Every memory has a timestamp, an importance score, entity partitioning (user + agent + session), and optional graph connections between entities.

Three write paths:
- **During conversation:** Mem0 automatically extracts from the chat
- **Post-session extraction:** A subagent reads the full session and writes structured observations with categories, importance, and metadata
- **Memory candidates:** Extracted memories start as `pending_review` — the user can keep, edit, or delete before they become permanent

Three read paths:
- **Per-turn retrieval:** Rule-based category selection (which types are relevant for this ritual/skill?) + semantic search within those categories
- **Reflect flow:** Multiple filtered queries across time, category, and graph for pattern synthesis
- **Heartbeat scanning:** Time-based queries for upcoming events, stalled commitments, recurring feelings

Session continuity lives on the filesystem: handoff files summarize each session (tone arc, decisions, open threads, what worked), and an identity file aggregates the big picture (communication profile, emotional patterns, life context, what works for this person).

**Why Mem0:** Managed infrastructure with semantic search, category filtering, graph relations, timestamps, expiration, and webhooks. No database to build or maintain. If Mem0 proves insufficient, the upgrade path is explicit: export to filesystem vault.

**Spec reference:** `03_memory_system.md` (complete).

### Reach Layer — Making Sophia Available Everywhere

**Technology:** iOS via Capacitor + APNs + Telegram Bot API + Heartbeat cron

**What it does:** Puts Sophia on five platforms: web app voice, web app text, iOS app, Telegram, and proactive push.

The iOS app wraps the web experience via Capacitor with native capabilities: push notifications, background audio, Siri shortcut for voice command, and eventually wake word detection. Telegram provides an async text channel with voice note exchange — the user sends a voice note, Sophia responds with a voice note.

The heartbeat runs autonomously on a schedule, scanning memory for triggers (upcoming events, stalled commitments, emotional patterns, silence). When it decides to reach out, DeerFlow generates a message with full personality and memory context, Cartesia renders it to audio, and the system delivers it as an iOS push notification with audio payload or a Telegram voice message.

**Spec references:** `01_architecture_overview.md` §2, §10, §11, `05_frontend_ux.md` §1, §5, §11-14.

---

## The Data That Feeds Everything

A critical insight runs through the entire architecture: **the data Sophia generates during conversations is the fuel for every advanced capability.**

```
Conversation happens
    ↓
Turn-level artifacts: tone_estimate, voice_emotion, skill_loaded, active_goal
    ↓ feeds
Execution traces: tone_delta per turn, which approaches worked
    ↓ feeds
BootstrapFewShot: best turns become examples in voice.md
GEPA: evolutionary optimization of prompt files against tone_delta
Experience bank: strategies extracted from successful/failed turn pairs

Post-session extraction: new memories written to Mem0 with categories
    ↓ feeds
Smart opener: context-aware first sentence for next session
Handoff: session summary for continuity
Heartbeat: scans memories for proactive triggers
Reflect flow: synthesizes memories into patterns and visual artifacts
Visual artifacts: "Your Emotional Week," decision cards, goal progress
Identity file: evolving portrait of the user
```

Every feature downstream depends on the quality of what happens upstream. This is why trace logging starts in Week 2 and runs forever. This is why the artifact schema is precise — those 13 fields per turn are the training signal for self-improvement. This is why memory extraction uses a carefully tuned prompt — garbage in, garbage out for reflection and heartbeat.

The architecture is designed so that each user session makes EVERY future session better — not just for that user, but (via GEPA) for all users.

---

## How the Spec Files Fit Together

Read them in this order:

### 1. This File (00_project_overview.md)
What you're reading now. The WHY and the panoramic view. Read this to understand what we're building and what each infrastructure layer does.

### 2. Architecture Overview (01_architecture_overview.md)
The WHAT in detail. Two-service architecture, five platforms, two agent modes, token budget, memory architecture, smart opener, self-improvement loop, heartbeat system, iOS strategy. This is the technical blueprint.

### 3. Build Plan (02_build_plan.md)
The WHEN. 8-week plan across three parallel tracks (Jorge/Davide backend, Luis voice+frontend, weekly convergence). Week-by-week tasks, convergence checkpoints, critical dependencies, definition of done.

### 4. Memory System (03_memory_system.md)
HOW memory works. Mem0 configuration, 9 categories with definitions, per-turn retrieval with category selection rules, post-session extraction pipeline, memory candidates flow, smart opener generation, handoff schema, reflect flow queries, heartbeat scanning.

### 5. Backend Integration (04_backend_integration.md)
HOW the DeerFlow intelligence works. Repository structure, LangGraph registration, SophiaState, middleware chain (12 layers), artifact system (13 fields including voice emotion), builder system with handoff, voice layer plugins, gateway API, GEPA integration, heartbeat implementation, Telegram voice notes.

### 6. Frontend & UX (05_frontend_ux.md)
HOW the user experiences it. Voice experience (two modes, Smart Turn, barge-in, latency targets), text mode, smart opener UX, Telegram UX, session/ritual selection, memory candidates, Sophia Journal, visual artifacts, iOS app, voice command, voice push playback, proactivity settings.

### 7. Implementation Spec (06_implementation_spec.md)
HOW to write the code. DeerFlow codebase map, precise middleware patterns, emit_artifact tool implementation, offline pipeline code, session end detection, filesystem paths, environment variables, testing checklists for Week 1 and Week 7, common pitfalls.

### 8. Vision Agents Reference (06_vision_agents_reference.md)
WHY and HOW we use Vision Agents. What the framework provides, what it replaces, how it connects via custom plugins, what it unlocks for the future, implementation strategy, risk assessment.

---

## The 8-Week Arc

**Phase 1 (Weeks 1-6): Core Companion**

Build the foundation that makes Sophia feel real.

Week 1 delivers the proof-of-life: speak to Sophia, hear her respond with personality, through both DeerFlow and Vision Agents. Week 2 adds emotional voice and trace logging — now every turn is measured and Sophia sounds different per emotional context. Week 3 brings session continuity and Telegram — Sophia remembers between sessions and reaches you on another platform. Week 4 completes the personality with all skill files loading and the first visual artifacts. Week 5 delivers the reflect flow — Sophia can look back and show you patterns. Week 6 runs the first GEPA optimization — Sophia improves measurably from her own data.

By Week 6: a voice companion with emotional calibration, genuine memory, session continuity, visual artifacts, Telegram presence, reflection capability, and self-improvement. The core experience is complete.

**Phase 2 (Weeks 7-8): Physical Presence + Proactivity**

Make Sophia feel alive beyond sessions.

Week 7 delivers the iOS app via Capacitor and the heartbeat system v1 — Sophia now lives on your phone and can send proactive voice notes before important events. Week 8 adds voice command (quick questions without full sessions), Telegram voice note exchange, and heartbeat v2 with pattern detection.

By Week 8: Sophia is on your phone, reaches out when something matters, responds to voice notes on Telegram, and can be summoned with a quick voice command.

**Phase 3 (Future): Expanding Capability**

Builder mode polish, creative proactivity (Sophia decides to create something without being asked), Twilio phone calls, multi-speaker sessions, experience bank with extracted strategies, GEPA on multiple files, and eventually video presence.

---

## The North Star

Eight weeks from now, a user finishes a debrief session. Sophia's voice was warm during the hard parts and curious during the breakthroughs. She remembered the decision they made two weeks ago and noticed they're handling the same situation differently now.

After the session, she writes structured memories and flags three for review. The user opens the memory candidates, edits one, keeps two, deletes one she got wrong.

That evening, Sophia sends a voice note to their phone: "I was thinking about what you said earlier — about caring less about being perfect and more about being honest. That's new. I noticed."

The next morning, before the meeting they mentioned, another voice note: "Hey. You've got this. And if it goes sideways, we'll debrief."

They open the Journal and see their emotional trajectory climbing over three weeks. They see the decisions that shaped the shift. They see a pattern Sophia noticed that they hadn't named yet.

This is not a chatbot. This is a companion that remembers, notices, speaks with the right emotion, improves over time, and cares enough to reach out — and the user can FEEL the difference.
