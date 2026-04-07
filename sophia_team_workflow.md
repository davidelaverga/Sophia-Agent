# Sophia — 6-Week Team Workflow & Compound Engineering Plan

**Version:** 2.0 · March 2026 (aligned with Spec v7.0)
**Team:** Davide (Product/Architecture) · Jorge (Backend) · Luis (Voice + Frontend)
**Tools:** Claude Code (Jorge + Davide) · VSCode Copilot (Luis)
**Plugin:** compound-engineering by EveryInc — installed on all three machines

---

## Table of Contents

1. [Philosophy](#1-philosophy)
2. [Compound Engineering — What It Is and Why](#2-compound-engineering--what-it-is-and-why)
3. [Installation by Platform](#3-installation-by-platform)
4. [The Five Commands](#4-the-five-commands)
5. [Team Responsibilities](#5-team-responsibilities)
6. [The Three-Gate PR Process](#6-the-three-gate-pr-process)
7. [The Compound Step — The Ritual That Makes Everything Compound](#7-the-compound-step--the-ritual-that-makes-everything-compound)
8. [CLAUDE.md Foundation — Required Before Day One](#8-claudemd-foundation--required-before-day-one)
9. [Week-by-Week Build Plan](#9-week-by-week-build-plan)
10. [Compound Log Format](#10-compound-log-format)
11. [Definition of Done — Week 6](#11-definition-of-done--week-6)

---

## 1. Philosophy

**Each unit of engineering work should make the next unit easier — not harder.**

Traditional development accumulates technical debt. Compound engineering inverts this. Every bug, every code review finding, every architectural lesson gets documented and fed back into the system so future agents — and future humans — start from a higher baseline.

For Sophia specifically, this matters in two dimensions:

- **Code quality compounding:** every merged PR updates `CLAUDE.md` with Sophia-specific patterns. After 6 weeks, opening Claude Code on this repo means the agent already knows about DeerFlow's retry behavior, Mem0's category nuances, and the soul.md constraint — without being briefed.
- **AI behavior compounding:** every prompt file (`voice.md`, `tone_guidance.md`, `session_state_assembly.md`) that changes during the sprint feeds the GEPA log. By Week 6, that log becomes the experience bank for the first automated GEPA optimization pass.

The compound loop is not overhead. It is the mechanism that turns a 6-week sprint into a self-improving system.

---

## 2. Compound Engineering — What It Is and Why

Compound engineering is a four-step loop:

```
Brainstorm → Plan → Work → Review → Compound → Repeat
```

The critical insight is the **80/20 rule**: 80% of effort goes into planning and review, only 20% into execution and documenting learnings. When plans are thorough and reviews are rigorous, execution is fast and changes are rare.

**What compound engineering enables for Sophia:**

| Without it | With it |
|---|---|
| Jorge starts each component from zero context | Jorge's `/ce:plan` reads commit history + existing DeerFlow patterns first |
| Code reviews catch surface bugs only | `/ce:review` finds middleware sequencing issues, Mem0 trust boundary violations, bad retry logic |
| Learnings live in Slack threads | Learnings live in CLAUDE.md, skill files, and the GEPA log |
| Week 6 GEPA pass starts from scratch | Week 6 GEPA draws on 4 weeks of documented prompt changes and trace observations |
| Luis builds against assumed API shape | `/ce:brainstorm` surfaces contract assumptions before implementation |
| Davide reviews code drift from spec | Three-gate PR process catches drift structurally every time |

---

## 3. Installation by Platform

### Jorge and Davide — Claude Code

```bash
# Inside Claude Code, paste this prompt:
/plugin marketplace add EveryInc/compound-engineering-plugin
/plugin install compound-engineering
```

Commit the plugin to the Sophia repo so it travels with a `git clone`:

```bash
cp -Rf ~/.claude/skills/compound-engineering .claude/skills/compound-engineering
```

### Luis — VSCode Copilot

```bash
# In terminal, one command:
bunx @every-env/compound-plugin install compound-engineering --to copilot
```

This converts all commands to Copilot's native format automatically. Luis gets the identical workflow, different tool underneath.

### Verify all three are working

Each person should confirm by running `/ce:brainstorm` on a simple prompt. If it responds with structured requirements exploration, the plugin is live.

---

## 4. The Five Commands

These are cognitive modes. Each one tells the AI what kind of brain to use right now.

### `/ce:brainstorm`
**Use before planning anything ambiguous.**

Collaborative dialogue that clarifies requirements and compares approaches before committing. Ask it: "What are the failure modes of injecting identity_summary into every turn?" or "What are the tradeoffs for tone_guidance band injection?" It explores, challenges, and sharpens the brief before any code is written.

**Who uses it most:** Davide (pre-implementation alignment), Luis (before any UX decision), Jorge (before any new middleware component).

---

### `/ce:plan`
**Use at the start of every component.**

Reads the current codebase and commit history, searches for relevant patterns, and produces a detailed implementation plan: architecture notes, edge cases, failure modes, test approach. For Sophia, this means the plan phase will surface:
- How the component fits the 14-middleware chain and what its position affects
- What Mem0 schema implications it has (category, metadata fields, extraction timing)
- What LangGraph state fields it reads and writes
- What `soul.md` constraints bind it

**Davide's check:** every plan should reference its spec document. If it can't, the spec needs updating first.

---

### `/ce:work`
**Execute against the plan.**

The agent implements according to the plan. Code gets written here — not architecture decisions. Those belong in plan.

---

### `/ce:review`
**Run before opening any PR.**

Multi-agent code review. For Sophia's backend (Jorge), this looks for:
- Middleware sequencing violations (wrong order in the 14-chain)
- Mem0 writes outside the extraction pipeline (should never happen in-turn)
- soul.md constraint leakage into the implementation layer
- N+1 queries in Mem0 retrieval or LRU cache misuse
- LangGraph state mutations that break the downstream chain

For Sophia's frontend (Luis), this looks for:
- `runs/wait` used anywhere it should be `runs/stream`
- Platform signal missing from DeerFlow `configurable`
- Voice emotion applied in the current turn rather than the next
- Artifact parsing that could silently fail on partial tool_use events

**Rule:** no PR opens without `/ce:review` running first on the author's own branch.

---

### `/ce:compound`
**Run after every merge. This is the magic.**

Documents learnings into three persistent locations: `CLAUDE.md`, skills files, and the GEPA log. Full details in Section 7.

---

## 5. Team Responsibilities

### Davide — Product Lead & Architecture

**Platform:** Claude Code
**Primary commands:** `/ce:brainstorm`, pre-plan alignment, manual PR review
**Gate role:** Product Vision Gate — every PR passes through Davide before merge
**Owns:** spec documents, soul.md, CLAUDE.md foundation, GEPA log architecture

**Daily pattern:**
1. Before any ambiguous component starts → `/ce:brainstorm` with Jorge or Luis
2. When spec gap is found → update spec first, then approve implementation
3. On every PR → review diff against the relevant spec document, not just code correctness
4. After every merge → rotate `/ce:compound` ownership

**The one rule:** if implementation diverges from spec, update the spec first (Davide's call), then implement. Never compound a pattern that drifts from product vision.

---

### Jorge — Backend Engineer

**Platform:** Claude Code
**Track A:** DeerFlow fork · 14-middleware chain · Mem0 services · extraction pipeline · offline pipeline · GEPA
**Primary commands:** `/ce:plan`, `/ce:work`, `/ce:review` (own branch + Luis's backend surfaces)

**Daily pattern:**
1. Start component → `/ce:plan` (reads existing DeerFlow patterns + Sophia spec first)
2. Implement → `/ce:work` against the plan
3. Before PR → `/ce:review` on own branch, fix all findings
4. Cross-review → review Luis's PRs for API shape, latency assumptions, Mem0 query patterns
5. After merge → run `/ce:compound`, write to `COMPOUND_LOG.md`

**Jorge's specific compound targets:**
- DeerFlow fork patterns and gotchas → CLAUDE.md
- Mem0 category classification behavior (what works, what drifts) → skills entry
- Middleware chain sequencing discoveries → CLAUDE.md
- Any changes to prompt files (voice.md, tone_guidance.md, etc.) → GEPA log entry

---

### Luis — Frontend, Voice, UX

**Platform:** VSCode Copilot
**Track B:** Vision Agents voice layer · web app (voice + text modes) · iOS Capacitor app · visual artifacts · Journal · Memory Candidates UI
**Primary commands:** `/ce:brainstorm` (heavy use), `/ce:plan`, `/ce:work`, `/ce:review` (own branch + Jorge's user-facing outputs)

**Daily pattern:**
1. Before any UX or integration decision → `/ce:brainstorm` to surface edge cases
2. Start component → `/ce:plan`
3. Implement → `/ce:work`
4. Before PR → `/ce:review` focused on UX consistency, voice tone, platform signal correctness
5. Cross-review → review Jorge's PRs for any surface that touches the user (response format, timing)
6. After merge → run `/ce:compound`, log voice and UX pattern observations

**Luis's specific compound targets:**
- Vision Agents configuration sweet spots (`buffer_in_seconds`, `confidence_threshold` per ritual context) → skills entry
- Voice emotion rendering quality (which Cartesia labels work, which feel mechanical) → skills entry + GEPA candidate
- Capacitor WebRTC configuration for WKWebView → skills entry
- Platform-specific UX patterns discovered in testing → CLAUDE.md

---

## 6. The Three-Gate PR Process

Every PR requires three approvals before merge. The order matters.

```
PR opened
    │
    ▼
Gate 1: Engineering review (peer, /ce:review)
    │   Jorge reviews Luis's PRs for backend correctness, API shape
    │   Luis reviews Jorge's PRs for any user-facing surface
    │
    ▼
Gate 2: Product Vision review (Davide, manual)
    │   Diff reviewed against spec document
    │   soul.md constraint respected?
    │   Session boundary works as designed?
    │   Response text sounds like Sophia, not a generic AI?
    │
    ▼
Gate 3: UX/Design review (opposite track, /ce:review)
    │   User-facing surfaces consistent with established patterns?
    │   Platform signal handled correctly end-to-end?
    │   Voice emotion applied at the right moment (next turn, not current)?
    │
    ▼
Merge to main
    │
    ▼
/ce:compound (rotating ownership)
    └── CLAUDE.md update + skills entry + GEPA log (if prompt file changed)
```

### Gate 2 checklist (Davide's product review)

- [ ] Component matches its spec document (Architecture, Build Plan, Memory System, Backend, Frontend, or Implementation spec)
- [ ] soul.md constraint respected — no personality hardcoded in implementation layer
- [ ] Memory writes go through extraction pipeline only, never in-turn
- [ ] If a prompt file changed → GEPA log entry planned for compound step
- [ ] Platform signal flows correctly: `configurable.platform` set, middleware reads it
- [ ] Response text (if any) sounds like Sophia — warm, specific, non-clinical

### Gate timing expectation

- Gates 1 and 3: same-day turnaround (async)
- Gate 2 (Davide): next morning at latest — reviewed at start of day

---

## 7. The Compound Step — The Ritual That Makes Everything Compound

After every merge, the component owner (or rotating assignment) runs `/ce:compound`. This is not optional and not vague. It produces three specific outputs every time.

### Output 1: CLAUDE.md update

What did this component teach us that wasn't already there? Specific, evidence-based observations. Examples:

> "DeerFlow node retry conflicts with middleware timeout — add 500ms buffer to all extraction nodes."

> "Mem0 `feeling` category silently drops memories without `tone_estimate` in metadata — always include it."

> "Smart Turn `buffer_in_seconds=0.4` is too tight for vent ritual — use 0.6 when `ritual=vent` in configurable."

These go into CLAUDE.md immediately. Next time anyone opens Claude Code on Sophia, that knowledge is already context.

### Output 2: Skills entry

For any non-trivial pattern that was figured out during implementation. A skills entry is a `SKILL.md` file documenting: when to use this pattern, the procedure, known pitfalls, and how to verify it worked. Examples:

- How to write a Mem0 query that respects the 9-category schema with correct metadata fields
- How to test a LangGraph middleware node without triggering the full 14-chain
- How to structure `emit_artifact` so both voice layer and text mode parse it correctly
- How to configure Capacitor for WebRTC in WKWebView without losing mic permissions

Skills live in `.claude/skills/sophia/` and are searchable by all three team members.

### Output 3: GEPA log entry (prompt files only)

For every PR that touches a prompt file (`voice.md`, `tone_guidance.md`, `session_state_assembly.md`, any ritual file, any pipeline prompt in `sophia/prompts/`), write a GEPA log entry:

```markdown
## YYYY-MM-DD · [filename] · PR #[number]
What changed: [one sentence]
Why: [observed problem that triggered the change]
Before behavior: [what Sophia did, observable]
After behavior: [what Sophia does now]
tone_estimate delta: [measured from trace logs if available]
GEPA candidate: YES / NO
Trace pair available: YES / NO
```

By Week 6, this log is the experience bank for the GEPA automated pass. You will not be starting cold.

---

## 8. CLAUDE.md Foundation — Required Before Day One

Before implementation starts, a Sophia-specific `CLAUDE.md` must exist in the repo root. This is not the compound-engineering default. It is Sophia's institutional memory.

```markdown
# Sophia — AI Context for Claude Code

## What Sophia Is
AI voice companion with genuine continuity, emotional attunement, and measurable growth.
Not a therapist, not a coach, not an assistant. Three platforms: web voice, web text, iOS voice.
soul.md defines who she is. It is immutable.

## Architecture
- Intelligence: DeerFlow fork (sophia_companion + sophia_builder via task() pattern)
- Voice: Vision Agents + Deepgram Nova-2 + Cartesia Sonic-3 + Smart Turn
- Memory: Mem0 Platform (9 custom categories, graph, timestamps, entity partitioning)
- Mobile: Capacitor iOS wrapper (wraps existing web app — WebRTC in WKWebView)

## Hard Constraints
- soul.md IS IMMUTABLE. Never modify or propose modifying it.
- Single memory authority: Mem0 only. No LangGraph checkpointer running in parallel.
- Extraction only post-session. Never write to Mem0 in-turn.
- emit_artifact via tool_use on every turn — never via text parsing.
- runs/stream always for companion. Never runs/wait for voice turns.
- Platform signal MUST be in DeerFlow configurable on every request.

## Mem0 Categories (9)
fact · feeling · decision · lesson · commitment · preference · relationship · pattern · ritual_context
Every feeling memory requires tone_estimate in metadata.
Pattern memories require evidence from 2+ sessions.

## 14-Middleware Chain (order is law)
CrisisCheck → PlatformContext → UserIdentity → SessionState → ToneGuidance →
ContextAdaptation → Ritual → SkillRouter → Mem0Memory → ArtifactMiddleware →
FileInjection → SophiaLLM → Title → Summarization

## Platform Values
"voice" · "text" · "ios_voice"
Set in configurable. PlatformContextMiddleware reads it. Everything downstream adapts.

## Spec Documents (source of truth)
- docs/specs/01_architecture_overview.md
- docs/specs/02_build_plan.md
- docs/specs/03_memory_system.md
- docs/specs/04_backend_integration.md
- docs/specs/05_frontend_ux.md
- docs/specs/06_implementation_spec.md

## Compound Log
COMPOUND_LOG.md — append after every merged PR.
```

---

## 9. Week-by-Week Build Plan

### Week 1 — Foundation + Voice Proof-of-Life

**Jorge (Track A)**
- Fork DeerFlow, scaffold `sophia_agent/` alongside `lead_agent/`, create `sophia/` services directory
- Write `SophiaState` TypedDict, register `sophia_companion` + `sophia_builder` in `langgraph.json`
- Write minimal `make_sophia_agent()`: ThreadData → FileInjection(soul+voice) → `emit_artifact` tool
- Configure Mem0: 9 categories + custom instructions + graph memory + entity partitioning
- Write `mem0_client.py` with LRU cache wrapper; `Mem0MemoryMiddleware` before-phase only
- Verify `task()` pattern: companion stays live while builder runs
- Write and share `API_CONTRACTS.md` for Luis (SSE event format + memory endpoints)

**Compound targets this week:** DeerFlow fork scaffold patterns · Mem0 category behavior from first 20 test messages

**Luis (Track B)**
- Vision Agents proof-of-life: speak → hear AI response (direct Claude call, DeerFlow not ready)
- Connect to DeerFlow via `runs/stream`, pipe text tokens to Cartesia as they arrive
- Handle `emit_artifact` tool call separately — it updates the **next** TTS call's emotion
- Tune `buffer_in_seconds` and `confidence_threshold` for natural turn detection
- Add edit mode + category badges to existing memory candidate cards

**Compound targets this week:** Vision Agents configuration baseline · STT/TTS latency measurement

**Davide (Track C)**
- Validate API contracts before Luis builds against them
- Test 20 Mem0 messages with Jorge — does classification look right?
- Convergence review at week end

**Convergence checklist — Week 1:**
- [ ] sophia_companion responds via `runs/stream` with personality + artifact JSON
- [ ] emit_artifact received and parsed (not text-split)
- [ ] Voice loop: speak → hear Sophia via Vision Agents (target: < 3s total)
- [ ] Turn detection feels natural
- [ ] Builder delegation confirmed via `task()`, companion stays live
- [ ] Mem0 categories auto-classify correctly on test messages
- [ ] Memory candidates: edit + delete working with category badges
- [ ] API contracts documented and shared

---

### Week 2 — Voice Emotion + Middleware Phase 1 + Trace Logging

**Jorge (Track A)**
- `CrisisCheckMiddleware` — keyword scan, `force_skill`, `skip_expensive` flag
- `PlatformContextMiddleware` — sets `platform` in state from configurable (`voice`, `text`, `ios_voice`)
- `ToneGuidanceMiddleware` — parse `tone_guidance.md` into 5 bands at startup, inject 1 band per turn
- `ContextAdaptationMiddleware` — loads work/gaming/life context files
- **Trace logging starts now** — write to `users/{user_id}/traces/{session_id}.json` every turn:
  ```json
  { "turn_id": "sess_{id}_turn_{n}", "tone_before": 0.0, "tone_after": 0.0,
    "tone_delta": 0.0, "voice_emotion_primary": "sympathetic",
    "skill_loaded": "active_listening", "active_tone_band": "grief_fear",
    "platform": "voice", "ritual": null, "context_mode": "life" }
  ```
- `SkillRouterMiddleware` — full cascade with `skill_session_data` in LangGraph state

**Compound targets this week:** Middleware Phase 1 sequencing discoveries · First trace log field observations

**Luis (Track B)**
- Write `voice/sophia_tts.py` — read `voice_emotion_primary`, `voice_emotion_secondary`, `voice_speed` from artifact
- Map speed labels to Cartesia values: slow=0.8, gentle=0.9, normal=1.0, engaged=1.05, energetic=1.15
- Apply emotion to **next** TTS call, not current (artifact arrives after text generation)
- Add text input alongside voice in web app — pass `platform: "text"` vs `platform: "voice"` in configurable
- Verify middleware responds differently to each platform signal (response length adapts)

**Compound targets this week:** Which Cartesia emotion labels land naturally · Platform signal end-to-end verification

**Davide (Track C)**
- Listen to early voice sessions — does emotion rendering feel right?
- Validate tone_guidance band injection: does low-tone input trigger the grief_fear band?
- First CLAUDE.md update entries from Week 1 compound steps

**Convergence checklist — Week 2:**
- [ ] Middleware Phase 1 running: CrisisCheck, PlatformContext, ToneGuidance, ContextAdaptation, SkillRouter
- [ ] Trace logs writing from every session (all fields present)
- [ ] Voice emotion: Sophia sounds noticeably different per emotional context
- [ ] Text mode working alongside voice mode
- [ ] Platform signal confirmed end-to-end: `platform` set → middleware reads → response adapts

---

### Week 3 — Continuity + Rituals + Journal

**Jorge (Track A)**
- `RitualMiddleware` — loads ritual files, maintains `ritual_phase` in state (before SkillRouter)
- `SessionStateMiddleware` — reads `latest.md`, injects smart opener on first turn of new session
- Offline pipeline Phase 1:
  - Session end detection: 10min inactivity + disconnect signal
  - Handoff write: artifacts + session memories → Claude Haiku + `session_state_assembly.md` → `users/{user_id}/handoffs/latest.md`
  - Smart opener: Claude Haiku + `smart_opener_assembly.md` → written to handoff frontmatter
  - Mem0 extraction: conversation + artifacts → Claude Haiku + `mem0_extraction.md` → write with `pending_review` status
  - In-app notification signal: POST to frontend on extraction complete

**Compound targets this week:** Offline pipeline timing edge cases · Extraction prompt quality (what classifies correctly)

**Luis (Track B)**
- Build Journal page: browsable memories by category, connect to Mem0 API
- Category tabs with type badges, importance dots, edit/delete reusing memory candidate components
- Timeline view: memories ordered chronologically
- Search across all categories
- Loading, empty, and error states for all Journal views
- Voice polish pass 1: review early trace logs → tune Smart Turn thresholds → adjust barge-in sensitivity

**Compound targets this week:** Journal UX patterns · Voice timing observations from first real sessions

**Davide (Track C)**
- Run full session → wait → start new session: does smart opener feel genuinely aware?
- Test all four ritual entries (prepare, debrief, vent, reset): does the right file load?
- Validate in-app notification fires reliably after session end

**Convergence checklist — Week 3:**
- [ ] Rituals: all four load correct file and track `ritual_phase` across turns
- [ ] Smart opener injected on first turn of new session (tested with real sessions)
- [ ] Offline pipeline: handoff write → smart opener → extraction → notification all fire
- [ ] Journal: real memories browsable by category, timeline, and search
- [ ] Voice: Smart Turn thresholds tuned, barge-in reliable

---

### Week 4 — Full Personality + Identity + Visual Artifacts

**Jorge (Track A)**
- `UserIdentityMiddleware` — reads `identity.md`, empty block if not yet generated
- `ArtifactMiddleware` full implementation — platform-conditional injection, previous artifact conditional injection
- `TitleMiddleware` — ritual-aware title prompt (adapted from DeerFlow)
- `SummarizationMiddleware` — enhanced with artifact arc extraction
- Full 14-middleware chain test: correct order, token budget validated, crisis skip-path confirmed fast
- Visual artifact backends:
  - `GET /api/sophia/{user_id}/visual/weekly` — tone trajectory from session metadata
  - `GET /api/sophia/{user_id}/visual/decisions` — decision-category memories as cards
  - `GET /api/sophia/{user_id}/visual/commitments` — commitment memories with status

**Compound targets this week:** Full chain token budget behavior · Crisis path latency measurement

**Luis (Track B)**
- Build 3 deterministic visual artifact flows:
  - "Your Emotional Week" — tone trajectory
  - "Decisions That Mattered" — decision memories as cards with dates
  - "Progress on Your Goals" — commitment tracking with status
- Each rendered from Jorge's visual endpoints using real Mem0 data
- In-app notification UI: banner + badge for memory candidates pending review
- Notification tap → deep link to Journal memory candidates screen

**Compound targets this week:** Visual artifact rendering patterns · In-app notification reliability

**Davide (Track C)**
- Full 14-middleware chain review: read the chain implementation against the spec order
- Validate visual artifacts: does the data feel like Sophia surfacing insight, not a dashboard?
- Test in-app notification flow end-to-end

**Convergence checklist — Week 4:**
- [ ] Full 14-middleware chain operational in correct order
- [ ] Crisis path confirmed fast (< 200ms overhead savings)
- [ ] Summarization with artifact arc extraction working
- [ ] Three visual artifacts rendering real Mem0 data
- [ ] In-app notifications: candidates + artifact ready, tap → correct screen
- [ ] Identity file trigger condition set (generates after 10 sessions)

---

### Week 5 — Reflect Flow + Identity File + Voice Polish

**Jorge (Track A)**
- `POST /api/sophia/{user_id}/reflect` endpoint:
  - Intent classification from user query (period + theme)
  - Multi-query Mem0 retrieval: patterns + feelings + lessons + tone trajectory
  - Claude Haiku + `reflect_prompt.md` → `voice_context` (spoken by Sophia) + `visual_parts` JSON
- Identity file system:
  - Offline pipeline step: trigger after 10 sessions, update incrementally thereafter
  - Claude Haiku + `identity_file_update.md` → `users/{user_id}/identity.md`
  - `UserIdentityMiddleware` reads and injects on session start

**Compound targets this week:** Reflect query quality · Identity file generation accuracy after 10 test sessions

**Luis (Track B)**
- Reflect flow UX: "Reflect" button in session interface
- Loading state during query (3–8s expected)
- Sophia speaks `voice_context` via normal voice pipeline simultaneously with visual artifact render
- Artifact saved to Journal under Insights tab
- Voice polish pass 2: review 3 weeks of trace logs — which emotion labels correlated with positive tone_delta? Fine-tune primary emotions for the selected Cartesia voice.
- Test barge-in reliability across browsers and devices
- Edge cases: background noise, very short utterances, masked emotional states

**Compound targets this week:** Reflect UX timing · Voice emotion correlation findings from trace log analysis

**Davide (Track C)**
- Full reflect flow test: does the narrative feel like Sophia has been paying attention?
- Validate identity file content after 10 test sessions: accurate, specific, not generic?
- Review GEPA log entries from Weeks 3–5 — identify strongest candidates for Week 6 pass

**Convergence checklist — Week 5:**
- [ ] Reflect flow: query → multi-Mem0 retrieval → voice narrative + visual artifact
- [ ] Reflect artifact saved to Journal Insights tab
- [ ] Identity file generates from real Mem0 data and loads in prompt on next session
- [ ] Voice emotion polished across all 5 tone bands
- [ ] Barge-in reliable on target devices and browsers

---

### Week 6 — GEPA + Builder + Capacitor iOS + Hardening

**Jorge (Track A)**
- BootstrapFewShot:
  - Scan 4 weeks of traces for golden turns (`tone_delta >= +0.5`)
  - Select top 3–5 by delta, include `voice_emotion_primary` data
  - Inject as "Real Session Examples" into `voice.md`
  - A/B test original vs enriched `voice.md` on 10+ real sessions
- GEPA first pass on `voice.md`:
  - Synthetic eval dataset from `voice.md` + real traces
  - Optimize: tone_delta (primary) × Claude-isms reduction (secondary) × ritual coherence (tertiary)
  - Constraint gates: no tone regression, no Claude-isms increase, human review before deploy
- Builder integration test:
  - Full end-to-end: user requests document → companion delegates → builder builds → companion speaks result
  - Confirm companion stays live during build
  - Confirm clarification-before-delegation pattern works in voice
- Final hardening: error handling, session timeout edge cases, Mem0 retry logic, load test

**Compound targets this week:** GEPA pass findings · BootstrapFewShot selection patterns (what makes a golden turn)

**Luis (Track B)**
- Full integration polish: memory candidates, Journal, visual artifacts — final pass
- Voice: final Smart Turn threshold tuning per ritual context
- End-to-end integration test: full voice loop + text mode + Journal + visual artifacts + reflect flow
- Capacitor iOS wrapper:
  ```bash
  npm install @capacitor/core @capacitor/cli
  npx cap init "Sophia" "com.sophia.app" --web-dir=out
  npx cap add ios
  npx cap sync ios
  ```
  - Configure app icon, splash screen, display name in Xcode
  - Build to simulator + physical device
  - Verify full web experience in WKWebView: voice live mode, text mode, Journal, artifacts
  - Verify **microphone permission is one-time system grant** — not per-session Safari prompt
  - Final smoke test: entire Sophia experience end-to-end on iPhone
  - TestFlight distribution setup

**Compound targets this week:** Capacitor WebRTC configuration for future reference · GEPA cycle learnings

**Davide (Track C)**
- Review GEPA output: is the new `voice.md` measurably better and unmistakably Sophia?
- Full Phase 1 convergence review against all checklist items
- Ship decision: TestFlight distribution to first real users

**Convergence checklist — Week 6:**
- [ ] GEPA produces measurably improved `voice.md` (tone_delta up, no Claude-isms increase)
- [ ] BootstrapFewShot golden turns injected with voice emotion data
- [ ] Builder mode works end-to-end on voice: companion stays live during delegation
- [ ] iOS app installable via TestFlight — full Sophia experience on iPhone
- [ ] Microphone permission: one-time native grant confirmed
- [ ] All features polished and integration-tested across web voice, web text, iOS
- [ ] Core companion production-ready for real users

---

## 10. Compound Log Format

Every compound step appends an entry to `COMPOUND_LOG.md` at the repo root.

```markdown
## YYYY-MM-DD · [component name] · PR #[number]

**Author:** [Jorge / Luis / Davide]
**Track:** [A / B / C]
**Spec reference:** [which spec document this component maps to]

### What changed
One paragraph. What was built or modified.

### What we learned
Specific, evidence-based bullet observations.
- [Component]: [what was discovered, not what was expected]

### CLAUDE.md updates
- Added: [specific pattern or constraint written to CLAUDE.md]

### Skills created or updated
- [skill name]: [what it documents and when to use it]

### GEPA log entry
GEPA candidate: YES / NO
If YES:
  Prompt file: [voice.md / tone_guidance.md / etc.]
  Change: [what changed]
  Before behavior: [observable, specific]
  After behavior: [observable, specific]
  tone_estimate delta: [measured from traces if available]
  Trace pair available: YES / NO
```

---

## 11. Definition of Done — Week 6

- sophia_companion with full 14-middleware chain in correct order
- Vision Agents: voice emotion, conversation mode (live), barge-in
- All 4 rituals (prepare, debrief, vent, reset) fully functional
- Context modes (work, gaming, life) functional
- Text mode alongside voice in web app
- Mem0: 9 categories, timestamps, graph, entity partitioning, post-session extraction
- Smart opener: every session opens aware of where the user left off
- Builder: Sophia delegates to DeerFlow lead_agent and stays present in conversation
- emit_artifact tool_use on every turn
- Trace logging from Week 2 (tone, emotion, skill, platform, ritual fields)
- Offline pipeline: handoff → smart opener → extraction → in-app notification
- Memory candidates: review, edit, delete, auto-promotion
- Sophia Journal: browsable memories by category, timeline, search
- 3 visual artifact flows rendering real Mem0 data
- Reflect flow: voice narrative + visual artifact simultaneously
- Identity file: generates after 10 sessions, loads in prompt
- BootstrapFewShot: golden turns (with voice emotion) injected into `voice.md`
- GEPA first pass on `voice.md`: measurably improved and approved
- iOS app: Capacitor wrapper installable via TestFlight, one-time microphone permission
- 6 weeks of `COMPOUND_LOG.md` with GEPA candidates identified and ready for future automated pass

---

## Quick Reference — Who Does What

| Situation | Who | Command |
|---|---|---|
| About to start an ambiguous component | Anyone | `/ce:brainstorm` |
| Starting any new component | Anyone | `/ce:plan` |
| Implementing from a plan | Anyone | `/ce:work` |
| Before opening any PR | Author | `/ce:review` (own branch) |
| PR opened on Track A | Luis | `/ce:review` (engineering gate) |
| PR opened on Track B | Jorge | `/ce:review` (engineering gate) |
| Any PR, engineering gate passed | Davide | Manual review (product gate) |
| Any PR, product gate passed | Opposite track | `/ce:review` (UX/design gate) |
| After every merge | Rotating | `/ce:compound` → CLAUDE.md + skills + GEPA log |
| Spec diverges from implementation | Davide | Update spec first, then approve PR |
| Any prompt file changed | Jorge or Luis | Write GEPA log entry in compound step |
| Voice behavior feels off after a change | Luis + Davide | Check GEPA log for last `voice.md` change |

---

*This document is a living artifact. Update it as patterns are discovered. The compound loop matures every week — by Week 6 this file itself should reflect what was actually learned, not just what was planned.*
