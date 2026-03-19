# Sophia — Claude Code Context
**Spec version:** 7.0 · March 2026
**Repo:** fork of bytedance/deer-flow
**Team:** Davide (product/architecture) · Jorge (backend) · Luis (voice + frontend)
Read the full specs in `docs/specs/` before making architectural decisions. This file gives you working context — it does not replace the specs.
---
## What Sophia Is
Sophia is an AI voice companion with genuine continuity, emotional attunement, and measurable self-improvement. She is not a therapist, not a coach, not an assistant. She remembers, notices, and sometimes surprises.
Five properties that define her:
- **Emotional intelligence** — calibrates to the user's tone using a 5-band scale, lifts them half a point, never more
- **Genuine continuity** — remembers across sessions via Mem0 9-category memory, session handoffs, and a persistent identity file
- **Emotionally calibrated voice** — the LLM chooses the right Cartesia emotion per turn, not a rules engine
- **Self-improvement** — every prompt file is measurable against tone delta and optimizable via GEPA
- **Physical presence** — native iOS app via Capacitor, one-time microphone permission, always one tap away
Three platforms, one intelligence layer: web voice, web text, iOS voice.
---
## Hard Constraints — Never Violate These
1. **soul.md is permanently immutable.** Never propose modifying it. It is architecturally excluded from GEPA. Two enforcement mechanisms: filesystem read-only + GEPA exclusion list.
2. **Mem0 is the single memory authority.** No LangGraph checkpointer running in parallel. No competing memory providers. One source of truth.
3. **Mem0 writes happen only in the offline pipeline, never in-turn.** The `Mem0MemoryMiddleware` after-phase queues extraction — it does not write per turn.
4. **emit_artifact is required on every companion turn, via tool_use.** Never via text parsing. Anthropic guarantees valid JSON on tool calls. Text parsing does not have this guarantee.
5. **`runs/stream` always for companion turns. Never `runs/wait` for voice.** Text tokens pipe to Cartesia immediately. `runs/wait` adds ~1.2s latency. This is the difference between hitting or missing the 3-second voice target.
6. **Platform signal is mandatory in every DeerFlow request.** Pass `platform` in `configurable` on every call. The entire middleware chain adapts on this signal.
7. **`lead_agent/` is never modified.** `sophia_builder` reuses it as-is. Sophia lives in `sophia_agent/` and `sophia/` only.
8. **Pipeline prompt templates are not skill files.** Files in `backend/src/sophia/prompts/` are pipeline inputs. They go to Claude Haiku in offline processing. They must never appear in the agent's per-turn context.
9. **RitualMiddleware must be at position 11 (before SkillRouter at 12).** Order is load-bearing. SkillRouter reads `active_ritual` from state — if Ritual hasn't run first, skill routing has no ritual context.
10. **The offline pipeline is idempotent.** Use the `processed_sessions` set to prevent double processing.
---
## Repository Structure
```
sophia/  (fork of bytedance/deer-flow)
├── backend/src/
│   ├── agents/
│   │   ├── lead_agent/              ← NEVER MODIFY — sophia_builder uses this unchanged
│   │   └── sophia_agent/            ← SOPHIA COMPANION (Jorge creates entirely)
│   │       ├── graph.py
│   │       ├── agent.py             ← make_sophia_agent()
│   │       ├── state.py             ← SophiaState TypedDict
│   │       └── middlewares/         ← 14 middleware files
│   └── sophia/                      ← SOPHIA SERVICES (Jorge creates entirely)
│       ├── mem0_client.py           ← SDK wrapper + LRU cache
│       ├── extraction.py
│       ├── handoffs.py
│       ├── smart_opener.py
│       ├── identity.py
│       ├── reflection.py
│       ├── offline_pipeline.py
│       ├── trace_logger.py
│       ├── golden_turns.py
│       ├── bootstrap.py
│       ├── gepa.py
│       └── prompts/                 ← NOT skill files — pipeline prompt templates only
│           ├── mem0_extraction.md
│           ├── session_state_assembly.md
│           ├── smart_opener_assembly.md
│           ├── identity_file_update.md
│           └── reflect_prompt.md
├── voice/                           ← VISION AGENTS LAYER (Luis)
│   ├── server.py
│   ├── sophia_llm.py
│   ├── sophia_tts.py
│   └── sophia_turn.py
├── skills/public/sophia/            ← SKILL FILES (read by agent at runtime)
│   ├── soul.md                      ← IMMUTABLE
│   ├── voice.md                     ← GEPA target (Week 6+)
│   ├── techniques.md
│   ├── tone_guidance.md             ← partial injection (1 band per turn)
│   ├── artifact_instructions.md
│   ├── context/work.md
│   ├── context/gaming.md
│   ├── context/life.md
│   ├── skills/                      ← 8 companion skill files
│   └── rituals/                     ← 4 ritual files (to create)
├── users/{user_id}/
│   ├── identity.md
│   ├── handoffs/latest.md           ← always overwritten, never accumulated
│   └── traces/{session_id}.json
├── gateway/routers/sophia.py
├── langgraph.json
├── config.yaml
└── .env
```
---
## The 14-Middleware Chain — Order Is Law
```python
middlewares = [
    # 1. Infrastructure
    ThreadDataMiddleware(),
    # 2. Crisis fast-path — BEFORE any expensive middleware
    CrisisCheckMiddleware(),
    # 3. Always-loaded identity files
    FileInjectionMiddleware(SKILLS_PATH / "soul.md"),
    FileInjectionMiddleware(SKILLS_PATH / "voice.md",       skip_on_crisis=True),
    FileInjectionMiddleware(SKILLS_PATH / "techniques.md",  skip_on_crisis=True),
    # 4. Platform signal — sets state["platform"] for all downstream
    PlatformContextMiddleware(),
    # 5–6. User context
    UserIdentityMiddleware(user_id),
    SessionStateMiddleware(user_id),
    # 7–9. Calibration — tone THEN context THEN ritual (this order matters)
    ToneGuidanceMiddleware(SKILLS_PATH / "tone_guidance.md"),
    ContextAdaptationMiddleware(SKILLS_PATH / "context", context_mode),
    RitualMiddleware(SKILLS_PATH / "rituals", ritual),   # ← MUST be before SkillRouter
    # 10. Skill routing — reads tone band + ritual from state
    SkillRouterMiddleware(SKILLS_PATH / "skills"),
    # 11. Memory — after ritual+skill set (retrieval biased by both)
    Mem0MemoryMiddleware(user_id),
    # 12. Artifact system
    ArtifactMiddleware(SKILLS_PATH / "artifact_instructions.md"),
    # 13–14. DeerFlow (adapted)
    SophiaTitleMiddleware(),
    SophiaSummarizationMiddleware(),
]
```
### Crisis fast-path
When `CrisisCheckMiddleware` detects crisis language, it sets `state["force_skill"] = "crisis_redirect"` and `state["skip_expensive"] = True`. All middlewares check this flag and short-circuit. Only soul.md + crisis_redirect.md are injected. Response time is ~200ms faster than normal.
Crisis signals: `"want to die"`, `"kill myself"`, `"end it all"`, `"don't want to be here"`, `"hurt myself"`, `"self harm"`, `"suicide"`, `"not worth living"`, `"can't go on"`, `"want to disappear"`.
### ToneGuidanceMiddleware — partial injection only
Parses `tone_guidance.md` into 5 band sections at **startup**, caches them. Injects **one band section per turn** (~726 tokens), not the full file (~3,630 tokens). Band selection is based on `state["previous_artifact"]["tone_estimate"]`.
Band ranges:
```
shutdown:          0.0–0.5
grief_fear:        0.5–1.5
anger_antagonism:  1.5–2.5
engagement:        2.5–3.5
enthusiasm:        3.5–4.0
```
---
## SophiaState — Key Fields
```python
class SophiaState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    # Platform and mode
    platform: str          # "voice" | "text" | "ios_voice"
    active_mode: str       # "companion" | "builder"
    turn_count: int        # first-turn logic gates on this
    # User context
    user_id: str
    context_mode: str      # "work" | "gaming" | "life"
    # Ritual
    active_ritual: str | None   # "prepare" | "debrief" | "vent" | "reset" | None
    ritual_phase: str | None    # e.g. "debrief.step2_what_worked"
    # Crisis
    force_skill: str | None     # set by CrisisCheckMiddleware
    skip_expensive: bool        # True = crisis path, most middlewares skip
    # Tone and skill
    active_tone_band: str       # band_id from tone_guidance
    active_skill: str           # skill name selected by SkillRouter
    skill_session_data: dict    # cross-turn counters (persisted via LangGraph checkpointer)
    # Artifacts
    current_artifact: dict | None
    previous_artifact: dict | None
    # Memory
    injected_memories: list[str]   # memory IDs for trace logging
    # Builder
    builder_task: dict | None
    builder_result: dict | None
```
---
## Mem0 — 9 Categories and Rules
```python
custom_categories = [
    {"fact":         "Static user info — name, job, location. High stability."},
    {"feeling":      "Emotional patterns. ALWAYS include tone_estimate in metadata."},
    {"decision":     "Genuine decisions made. Not considerations."},
    {"lesson":       "Insights the user articulated or realized."},
    {"commitment":   "Goals, deadlines, stated intentions."},
    {"preference":   "Communication style, how they want to be treated."},
    {"relationship": "People in the user's life — names, roles, dynamics."},
    {"pattern":      "Recurring behavioral observations. Require 2+ session evidence."},
    {"ritual_context": "How the user uses each ritual — what works, preferences."},
]
```
### Memory write — always include full metadata
```python
client.add(
    messages,
    user_id=user_id,
    agent_id="sophia_companion",
    run_id=session_id,
    timestamp=turn_timestamp,
    metadata={
        "tone_estimate": 1.4,           # REQUIRED for feeling category
        "ritual_phase": "debrief.step2",
        "importance": "structural",     # structural | potential | contextual
        "platform": "voice",
        "status": "pending_review",
        "context_mode": "work",
    }
)
```
### Retention
| Importance | Expires | Use when |
|---|---|---|
| structural (≥ 0.8) | permanent | facts, decisions, core relationships |
| potential (0.4–0.79) | long-term | preferences, feelings, single-session insights |
| contextual (< 0.4) | 7 days | routine observations, temporary states |
### LRU cache
60-second TTL. Cache hits ~70% of turns within a session. Call `invalidate_user_cache(user_id)` after any Mem0 write.
### Rule-based category selection (before semantic search)
```python
categories = ["fact", "preference"]  # always
if ritual in ["prepare", "debrief"]:
    categories += ["commitment", "decision"]
if ritual == "vent":
    categories += ["feeling", "relationship"]
if ritual == "reset":
    categories += ["feeling", "pattern"]
if active_skill in ["vulnerability_holding", "trust_building"]:
    categories += ["feeling", "relationship"]
if active_skill == "challenging_growth":
    categories += ["pattern", "lesson"]
if ritual:
    categories.append("ritual_context")
# + "relationship" if person mentioned, "feeling" if emotion signal
```
---
## Tools Available to Companion
```python
tools = [
    emit_artifact,       # REQUIRED every turn — carries TTS emotion + session continuity
    switch_to_builder,   # delegates to sophia_builder (lead_agent) via task()
    retrieve_memories,   # targeted deep retrieval (reflect flow, specific queries)
]
```
### emit_artifact — 13 required fields
`session_goal`, `active_goal`, `next_step`, `takeaway`, `reflection` (nullable), `tone_estimate` (0–4.0), `tone_target` (tone_estimate + 0.5, max 4.0), `active_tone_band`, `skill_loaded`, `ritual_phase`, `voice_emotion_primary`, `voice_emotion_secondary`, `voice_speed` (slow|gentle|normal|engaged|energetic).
Voice speeds → Cartesia values: slow=0.8, gentle=0.9, normal=1.0, engaged=1.05, energetic=1.15.
Artifact arrives **after** the text stream completes. It updates the emotion for the **next** TTS call.
### switch_to_builder
Companion asks all clarifying questions first, then calls `switch_to_builder` with complete specs. Builder cannot interrupt the parent graph for clarification. Companion stays live and relays progress while builder works asynchronously.
---
## Platform Values and Effects
| Value | Who sets it | What adapts downstream |
|---|---|---|
| `"voice"` | Luis (web) | 1–3 sentence responses, full 13-field artifact, Cartesia TTS |
| `"ios_voice"` | Luis (iOS) | identical to voice — same token budget, same artifact depth |
| `"text"` | Luis (web text) | 2–5 sentence responses, full 13-field artifact, no TTS |
Set in `configurable` on every DeerFlow request:
```python
config = {"configurable": {
    "user_id": user_id,
    "platform": "voice",    # or "text" or "ios_voice"
    "ritual": ritual,       # or None
    "context_mode": "life", # or "work" or "gaming"
}}
```
---
## Prompt Token Budget (Companion, Voice Peak)
| Component | Tokens |
|---|---|
| soul.md + voice.md + techniques.md | ~2,853 |
| Tone guidance (1 band) | ~726 |
| Context adaptation (1 file) | ~130 |
| Ritual file (when active) | ~600 |
| artifact_instructions.md | ~2,760 |
| User identity file | ~650 |
| Session handoff | ~375 |
| Smart opener instruction (turn 1 only) | ~50 |
| Mem0 memories (filtered, ~10 results) | ~750 |
| Previous artifact (conditional) | ~200 |
| Active skill file | ~650 |
| **Peak total** | **~9,144** |
4.6% of Claude Haiku's 200k context. No compression needed at normal operation.
Models:
- Companion: `claude-haiku-4-5-20251001`
- Builder: `claude-sonnet-4-6`
- Offline pipeline (all steps): `claude-haiku-4-5-20251001`
---
## Offline Pipeline — 7 Steps
Fires on WebRTC disconnect or 10-minute inactivity. Idempotent — safe to run twice.
```
Step 1: Smart opener generation
Step 2: Handoff write → users/{user_id}/handoffs/latest.md
Step 3: Mem0 extraction → all memories written with status="pending_review"
Step 4: In-app notification (memory candidates ready)
Step 5: Trace aggregation
Step 6: Identity update (every 10 sessions or on structural memory change)
Step 7: Visual artifact check (if 3+ sessions this week)
```
Smart opener is a single warm sentence injected by `SessionStateMiddleware` on `turn_count == 0` only. Stored in handoff YAML frontmatter: `smart_opener: "..."`. Examples of good openers:
- Upcoming event: `"The investor pitch is tomorrow. How are you feeling going into it?"`
- Unresolved thread: `"You mentioned the conversation with your co-founder — did that happen?"`
- After absence (3+ days): `"It's been a few days. Where are you at?"`
- Low tone, no open threads: `"How are you doing today?"` — don't overcomplicate a quiet return
- Post-breakthrough: `"Something shifted last time. How does it feel from the other side?"`
---
## Trace Schema (Every Turn, from Week 2)
```json
{
  "turn_id": "sess_{session_id}_turn_{n}",
  "timestamp": "ISO8601",
  "tone_before": 0.0,
  "tone_after": 0.0,
  "tone_delta": 0.0,
  "is_golden_turn": false,
  "voice_emotion_primary": "sympathetic",
  "voice_emotion_secondary": "calm",
  "voice_speed": "gentle",
  "skill_loaded": "vulnerability_holding",
  "active_tone_band": "grief_fear",
  "ritual": "debrief",
  "platform": "voice",
  "context_mode": "work",
  "memory_injected": ["mem_abc123", "mem_def456"],
  "prompt_versions": {
    "voice_md": 1,
    "tone_guidance_md": 1,
    "active_skill_md": 1
  }
}
```
Written to `users/{user_id}/traces/{session_id}.json`.
---
## GEPA Rules
1. `soul.md` is **never** a GEPA target — excluded by exclusion list, not just convention
2. Trace files are ground truth — never modified
3. Global/shared files require human (Davide) review before deployment
4. Tone regression is a hard block — no variant that performs worse than baseline is deployable
5. Schema version increments on any structural change to prompt files
First GEPA target (Week 6): `voice.md`. Golden turn threshold: `tone_delta >= +0.5`.
---
## iOS — Capacitor Wrapper (Week 6, Luis)
The existing Next.js web app wrapped in a native iOS shell. No Swift required.
```bash
npm install @capacitor/core @capacitor/cli
npx cap init "Sophia" "com.sophia.app" --web-dir=out
npx cap add ios
npm run build && npx cap sync ios
npx cap open ios  # Opens Xcode
```
Key test: after user taps Allow once, closing and reopening the app must NOT show the mic dialog again. If it does, something is wrong with the native permission flow.
The `ios/` directory generated by Capacitor is gitignored. Xcode project settings (icons, splash, capabilities) are configured in Xcode, not in code.
WebRTC requires: `allowsInlineMediaPlayback = true` and `mediaTypesRequiringUserActionForPlayback = []` in `WKWebViewConfiguration`. Capacitor sets these by default.
---
## Environment Variables
```bash
# Core (required)
ANTHROPIC_API_KEY=sk-ant-...
MEM0_API_KEY=m0-...
# Voice layer (required)
CARTESIA_API_KEY=...
SOPHIA_VOICE_ID=...         # Cartesia voice ID for Sophia
DEEPGRAM_API_KEY=...
STREAM_API_KEY=...
STREAM_API_SECRET=...
# Optional
SOPHIA_USER_ID=...          # single-user deployment; multi-user: per-request
MEM0_BASE_URL=...           # if self-hosting Mem0
SOPHIA_SKILLS_PATH=...      # override default skills path
```
---
## Gateway Endpoints
```
GET    /api/sophia/{user_id}/memories/recent?status=pending_review
PUT    /api/sophia/{user_id}/memories/{memory_id}
DELETE /api/sophia/{user_id}/memories/{memory_id}
POST   /api/sophia/{user_id}/memories/bulk-review
GET    /api/sophia/{user_id}/visual/weekly
GET    /api/sophia/{user_id}/visual/decisions
GET    /api/sophia/{user_id}/visual/commitments
POST   /api/sophia/{user_id}/reflect
       body: {query: str, period: "this_week"|"this_month"|"overall"}
       returns: {voice_context: str, visual_parts: [...]}
GET    /api/sophia/{user_id}/journal
```
---
## Common Pitfalls
### Jorge
- `RitualMiddleware` at position 11, `SkillRouterMiddleware` at position 12. Never swap them.
- `ToneGuidanceMiddleware` injects ONE band (~726 tokens), not the full file (~3,630 tokens). Always use band parsing.
- Handoff path is `users/{user_id}/handoffs/latest.md` — always overwritten, never accumulated.
- Pipeline prompts go in `backend/src/sophia/prompts/` — never in `skills/public/sophia/`.
- `soul.md` is excluded from GEPA. Add it to the exclusion list before running any optimization pass.
- Run the offline pipeline only once per session. Use the `processed_sessions` set.
- `smart_opener_assembly.md` must not reference `{cross_platform_memories}` — that placeholder was removed in v7.0.
### Luis
- `runs/stream` not `runs/wait` — always. The ~0.6s difference matters on voice.
- Artifact arrives after text. It updates the emotion for the **next** TTS call. Design `SophiaTTS` plugin accordingly.
- Always pass `platform` in `configurable`. The chain behaves differently per platform.
- Smart opener is injected on the **first turn** of a new session. Sophia delivers it before the user says anything — it's not a system message the user sees.
- If Live mode audio doesn't work on device, check WKWebView media playback settings in Capacitor config.
- `ios/` directory is gitignored.
---
## Spec Documents (source of truth)
All architectural decisions derive from these. When in doubt, read the spec before implementing.
```
docs/specs/01_architecture_overview.md   — system overview, platforms, iOS Capacitor
docs/specs/02_build_plan.md              — 6-week three-track execution plan
docs/specs/03_memory_system.md           — Mem0 config, retrieval, handoffs, smart opener
docs/specs/04_backend_integration.md     — middleware chain, voice pipeline, offline flows, GEPA
docs/specs/05_frontend_ux.md             — Vision Agents, Journal, visual artifacts, Capacitor
docs/specs/06_implementation_spec.md     — precise codebase details for Jorge and Luis
```
---
## Compound Log
Every merged PR appends an entry to `COMPOUND_LOG.md` at the repo root.
Format per entry:
```
## YYYY-MM-DD · [component] · PR #[N]
Author / Track / Spec reference
What changed · What we learned · CLAUDE.md updates · Skills created · GEPA log entry
```
If a prompt file changed, write a GEPA log entry with: before behavior, after behavior, tone_delta if measurable, and whether a trace pair is available.
