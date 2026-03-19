# Sophia Build Plan
## 6-Week Three-Track Execution Plan
**Version:** 7.0 · March 2026
**Team:** Davide (Product/Architecture), Jorge (Backend), Luis (Voice + Frontend)
**Target:** 5 weeks core companion + 1 week polish, GEPA, and Capacitor iOS = 6 weeks total
---
## Build Philosophy
Three parallel tracks. Backend and voice/frontend build simultaneously against defined API contracts. Tracks never block each other.
**Key change from v6.0:** Scope tightened to the emotional intelligence foundation. Heartbeat proactivity and Telegram integration deferred to a future expansion phase. Week 6 now delivers Capacitor iOS instead of beginning a separate 2-week phase. Result: a sharper, more shippable 6-week plan with no throwaway infrastructure.
**Key change from v4.0:** Builder is DeerFlow subagent (task() pattern), not two-graph switch. Companion stays live during build. Artifact via tool_use, not text parsing. `runs/stream` always, not `runs/wait`. Mem0 via Python SDK with LRU cache, not MCP.
**Trace logging starts Week 2 and runs continuously.** By Week 6: 4+ weeks of data for GEPA. Logging includes platform and ritual fields for cross-context analysis.
---
## API Contracts (Define Week 1 — both tracks build against these)
```json
// DeerFlow → SophiaLLM response (streams via SSE)
// Text tokens stream as messages-tuple events
// emit_artifact tool call arrives after text:
{
  "type": "messages-tuple",
  "data": {
    "type": "tool",
    "name": "emit_artifact",
    "content": "{\"tone_estimate\": 1.4, \"voice_emotion_primary\": \"sympathetic\", ...}"
  }
}
// Memory candidates endpoint (existing, add edit support)
GET /api/sophia/{user_id}/memories/recent?status=pending_review
→ { memories: [{id, content, category, confidence, metadata, created_at}] }
PUT /api/sophia/{user_id}/memories/{id}
body: { text?: string, metadata?: {category?, status?} }
// Reflect endpoint
POST /api/sophia/{user_id}/reflect
body: { query: string, period: "this_week"|"this_month"|"overall" }
→ { voice_context: string, visual_parts: [...] }
```
---
## Week 1: Foundation + Voice Proof-of-Life
### Jorge + Davide (Backend)
**Day 1–2: Fork + Scaffold**
1. Fork DeerFlow repository
2. Create `backend/src/agents/sophia_agent/` alongside `lead_agent/`
3. Create `backend/src/sophia/` services directory
4. Create `skills/public/sophia/` — copy all existing skill files
5. Register `sophia_companion` in `langgraph.json` (points to sophia_agent/graph.py)
6. Register `sophia_builder` in `langgraph.json` (points to lead_agent/graph.py unchanged)
7. Write `SophiaState` TypedDict in `state.py`
**Day 2–3: Minimal sophia_companion**
1. Write `make_sophia_agent()` with minimal chain: ThreadData → FileInjection(soul+voice) → emit_artifact tool
2. Confirm `emit_artifact` tool_use fires correctly and ArtifactMiddleware reads it
3. **Test:** HTTP POST with `runs/stream` → Sophia response + artifact JSON, both received correctly
4. Measure: first token latency, total response time
**Day 3–4: Mem0 Setup**
1. Configure 9 custom categories + custom instructions + graph memory + entity partitioning
2. Write `mem0_client.py` with LRU cache wrapper
3. Write `Mem0MemoryMiddleware` — before-phase only (after-phase comes Week 3)
4. **Test:** 20 real messages → verify categories auto-classify correctly
**Day 4–5: Verify Builder Pattern**
1. Register `switch_to_builder` tool — confirm `task()` invocation reaches `lead_agent`
2. Verify companion receives task() result as tool result message
3. Verify companion stays live while builder runs (SSE events continue)
4. **Decision:** if task() pattern confirmed → proceed. Document in `API_CONTRACTS.md`
**Day 5: Define API Contracts**
1. Document exact SSE event format for Luis (text streaming + artifact tool call)
2. Document memory endpoints format
3. Share `API_CONTRACTS.md` — Luis builds against this from now on
### Luis (Voice + Frontend)
**Day 1–2: Vision Agents Proof-of-Life**
1. `pip install vision-agents` in repo
2. Create Stream account, get API credentials
3. Write `voice/server.py` — basic Agent with Deepgram STT + Cartesia TTS + Smart Turn
4. For LLM: use direct Claude call initially (DeerFlow not ready)
5. **Test:** speak → hear AI response. Tune `buffer_in_seconds` and `confidence_threshold`
**Day 3–4: Connect to DeerFlow (runs/stream)**
1. Write `voice/sophia_llm.py` using `runs/stream` (not `runs/wait`)
2. Pipe text tokens to Cartesia as they arrive
3. Handle `emit_artifact` tool call arrival separately (updates next TTS call's emotion)
4. **Test:** speak → STT → streams to DeerFlow → text pipes to Cartesia → hear Sophia
5. Measure: TTFT + DeerFlow time + TTS start time. **Target: < 3 seconds total**
**Day 5: Memory Candidates (existing — add edit)**
1. Add edit mode to existing memory candidate cards
2. Add category badges (colored by type from existing 9 categories)
3. **Test:** existing delete flow + new edit flow work correctly
### Convergence (End of Week 1)
- [ ] sophia_companion responds via runs/stream with personality + artifact JSON
- [ ] emit_artifact tool call received and parsed (not text split)
- [ ] Voice loop: speak → hear Sophia via Vision Agents
- [ ] Turn detection tuned to feel natural
- [ ] Builder delegation verified via task() pattern
- [ ] Mem0 categories auto-classify correctly
- [ ] Memory candidates: delete + edit working
- [ ] API contracts documented and shared
---
## Week 2: Voice Emotion + Middleware Chain + Trace Logging
### Jorge + Davide (Backend)
**Day 1–2: Full Middleware Chain Phase 1**
1. `CrisisCheckMiddleware` — keyword scan, force_skill, skip_expensive
2. `PlatformContextMiddleware` — sets platform in state from configurable (`"voice"`, `"text"`, `"ios_voice"`)
3. `ToneGuidanceMiddleware` — parse tone_guidance.md into 5 band sections at startup, inject 1 band per turn
4. `ContextAdaptationMiddleware` — loads work/gaming/life context files
5. **Test:** different tone values → different band injections. Platform=text → shorter response guidance.
**Day 3: Trace Logging — STARTS NOW**
```json
{
  "turn_id": "sess_{id}_turn_{n}",
  "tone_before": 0.0, "tone_after": 0.0, "tone_delta": 0.0,
  "voice_emotion_primary": "sympathetic",
  "skill_loaded": "active_listening",
  "active_tone_band": "grief_fear",
  "platform": "voice", "ritual": null, "context_mode": "life"
}
```
Write to `users/{user_id}/traces/{session_id}.json`
**Day 4–5: Skill Router**
1. `SkillRouterMiddleware` — full cascade with `skill_session_data` in LangGraph state
2. Track: `sessions_total`, `trust_established`, `complaint_signatures`, `skill_history`
3. **Test:** crisis language → crisis_redirect. Low tone + vulnerability → vulnerability_holding. Same complaint 3× + trust → challenging_growth.
### Luis (Voice + Frontend)
**Day 1–3: Voice Emotion Mapping**
1. Write `voice/sophia_tts.py` — extends Cartesia TTS
2. Read `voice_emotion_primary`, `voice_emotion_secondary`, `voice_speed` from artifact
3. Map speed labels to Cartesia values (slow=0.8, gentle=0.9, normal=1.0, engaged=1.05, energetic=1.15)
4. Apply to NEXT TTS call (artifact arrives after text — next turn uses it)
5. **Test:** real conversations across emotional range. Does "sympathetic" sound right during vulnerability?
**Day 4–5: Text Mode + Platform Detection**
1. Add text input alongside voice in web app
2. Pass `platform: "text"` vs `platform: "voice"` in DeerFlow config
3. Confirm middleware responds differently (response length, artifact instructions)
4. **Test:** same message on voice vs text → different prompt → different response length
### Convergence (End of Week 2)
- [ ] Full middleware chain Phase 1 running (crisis, platform, tone, context, skill)
- [ ] Trace logs writing from every session
- [ ] Voice emotion: Sophia sounds different per emotional context
- [ ] Text mode working alongside voice mode
- [ ] Platform signal confirmed end-to-end
---
## Week 3: Continuity + Rituals + Journal
### Jorge + Davide (Backend)
**Day 1–2: Session Continuity**
1. `RitualMiddleware` — loads ritual files, maintains ritual_phase in state (BEFORE SkillRouter in chain)
2. `SessionStateMiddleware` — reads latest.md, injects smart opener on first turn
3. **Test:** set ritual=debrief in configurable → ritual file loaded → ritual_phase tracked across turns
**Day 3–5: Offline Pipeline Phase 1**
1. Session end detection: inactivity timeout (10min) + disconnect signal from SophiaLLM
2. Handoff write: read artifacts + session Mem0 memories → claude-haiku + session_state_assembly.md → write `users/{user_id}/handoffs/latest.md`
3. Smart opener generation: → claude-haiku + smart_opener_assembly.md → write to handoff frontmatter
4. Mem0 extraction: conversation + artifacts → claude-haiku + mem0_extraction.md → write with `pending_review`
5. In-app notification: signal frontend (memory candidates pending review)
6. **Test:** session ends (wait 10min or disconnect) → handoff written → smart opener present → memories extracted → in-app notification fires
### Luis (Voice + Frontend)
**Day 1–3: Sophia Journal Phase 1**
1. Build Journal page: browsable memories by category
2. Connect to Mem0 API: get_all by category, search by keyword
3. Category tabs with type badges, importance dots
4. Memory cards with edit/delete (reuse expanded memory candidate components)
5. **Test:** Journal shows real categorized memories from Mem0
**Day 4–5: Journal Phase 2 + Voice Polish Pass 1**
1. Timeline view in Journal: memories ordered chronologically
2. Search working across all categories
3. Loading states, empty states, error states
4. First voice polish: review early trace logs → tune Smart Turn thresholds → adjust barge-in sensitivity
5. **Test:** Journal fully functional with real data. Voice feels natural across short and long utterances.
### Convergence (End of Week 3)
- [ ] Rituals working: prepare, debrief, vent, reset each load correct file and track phase
- [ ] Smart opener injected on first turn of new session (test with real session → next session)
- [ ] Offline pipeline: handoff write → smart opener → extraction → in-app notification
- [ ] Journal: real memories browsable by category, timeline, search
- [ ] Voice: Smart Turn thresholds tuned, barge-in reliable
---
## Week 4: Full Personality + Identity + Visual Artifacts
### Jorge + Davide (Backend)
**Day 1–3: Remaining Middlewares**
1. `UserIdentityMiddleware` — reads identity.md, empty block if not yet created
2. `ArtifactMiddleware` full implementation — platform-conditional injection, previous artifact conditional injection
3. `TitleMiddleware` — ritual-aware title prompt
4. `SummarizationMiddleware` — enhanced with artifact arc extraction
5. Full 14-middleware chain test: all loading, correct order, token budget validated
6. **Test:** crisis detected → CrisisCheckMiddleware fires → skip_expensive → crisis_redirect loads only
**Day 4–5: Visual Artifact Backends**
1. `GET /api/sophia/{user_id}/visual/weekly` — tone trajectory from Mem0 session metadata
2. `GET /api/sophia/{user_id}/visual/decisions` — decision-category memories as cards
3. `GET /api/sophia/{user_id}/visual/commitments` — commitment-category memories with status
4. Each endpoint queries Mem0 with category + time filters, formats as typed JSON for Luis
### Luis (Voice + Frontend)
**Day 1–3: Visual Artifacts**
1. Build 3 deterministic visual flows as HTML pages:
   - "Your Emotional Week" — tone trajectory from Mem0 session metadata
   - "Decisions That Mattered" — decision memories as cards with dates
   - "Progress on Your Goals" — commitment tracking with status
2. Each generated from Jorge's backend visual endpoints
3. **Test:** complete sessions → visual artifacts render real Mem0 data
**Day 4–5: Visual Artifact Polish + In-App Notifications**
1. Consistent visual styling across all three artifact types
2. Refresh behaviour on new session data
3. Artifact saving to Journal under Insights tab
4. In-app notification UI: banner + badge for memory candidates pending review
5. In-app notification tap → deep link to Journal memory candidates screen
6. **Test:** session ends → notification appears → tap → lands on correct screen
### Convergence (End of Week 4)
- [ ] Full 14-middleware chain operational
- [ ] Crisis path tested and confirmed fast (<200ms savings)
- [ ] Summarization with artifact arc extraction working
- [ ] Three visual artifacts rendering real Mem0 data
- [ ] In-app notifications: memory candidates + artifact ready
- [ ] Identity file generates after 10 sessions (test with mock session count)
---
## Week 5: Reflect Flow + Identity + Polish
### Jorge + Davide (Backend)
**Day 1–3: Reflect Flow**
1. `POST /api/sophia/{user_id}/reflect` endpoint in gateway
2. Intent classification: period + theme from user query
3. Multi-query Mem0 retrieval: patterns + feelings + lessons + tone trajectory
4. Claude Haiku + reflect_prompt.md → narrative + visual_parts JSON
5. Return: `voice_context` (spoken by Sophia) + `visual_parts` (rendered by Luis)
6. **Test:** "reflect on my week" → Sophia narrates + visual data returns correctly
**Day 4–5: Identity File System**
1. Offline pipeline step 6: identity file update trigger condition
2. Claude Haiku + identity_file_update.md → `users/{user_id}/identity.md`
3. `UserIdentityMiddleware` reads and injects on session start
4. **Test:** simulate 10 sessions → identity generates from real Mem0 data → loads in prompt next session
### Luis (Voice + Frontend)
**Day 1–3: Reflect Flow UX**
1. "Reflect" button in session interface
2. Loading state during reflect query (3-8 seconds expected)
3. Sophia speaks the `voice_context` via normal voice pipeline
4. Visual artifact appears simultaneously (tone trajectory + pattern cards)
5. Saved to Journal under Insights tab
6. **Test:** full reflect flow voice + visual
**Day 4–5: Voice Polish Pass 2**
1. Review 3 weeks of trace logs — which emotion labels correlated with positive tone delta?
2. Fine-tune primary emotions that land best with the selected Cartesia voice
3. Test voice emotion across all 5 tone bands
4. Test barge-in reliability across devices and browsers
5. Edge cases: background noise, very short utterances, masked emotional states
### Convergence (End of Week 5)
- [ ] Reflect flow: query → multi-Mem0 queries → narrative + visual returned
- [ ] Identity file generates and loads in prompt
- [ ] Voice emotion polished across emotional range
- [ ] Barge-in reliable on target devices
---
## Week 6: GEPA + Builder + Capacitor iOS + Hardening
### Jorge + Davide (Backend)
**Day 1–2: BootstrapFewShot**
1. Scan 4 weeks of traces for golden turns (tone_delta >= +0.5)
2. Select top 3-5 by delta — include voice_emotion data
3. Inject as examples into `voice.md` as "Real Session Examples"
4. A/B test original vs enriched voice.md on 10+ real sessions
**Day 3–4: GEPA First Pass**
1. Synthetic eval dataset from `voice.md` + real traces
2. GEPA optimization: tone_delta (primary) × Claude-isms (secondary) × ritual coherence (tertiary)
3. Constraint gates: no tone regression, no Claude-isms increase, human review
4. Deploy approved variant
**Day 5: Builder Integration Test + Final Hardening**
1. Full end-to-end builder test: user requests document → companion delegates → builder builds → companion speaks result
2. Confirm companion stays live during build
3. Confirm clarification-before-delegation pattern works in voice
4. Final backend hardening: error handling, session timeout edge cases, Mem0 retry logic
5. Load test: concurrent users, cold-start latency
### Luis (Voice + Frontend)
**Day 1–3: Full Integration Polish**
1. Memory candidates: smooth edit flow, auto-promotion indicator
2. Journal: timeline view, search, loading/empty states — final pass
3. Visual artifacts: consistent styling, refresh on new data, saving to Insights
4. Voice: final Smart Turn threshold tuning per emotional context
5. Integration testing: full voice loop + text mode + Journal + visual artifacts
**Day 4–5: Capacitor iOS Wrapper**
1. Install Capacitor into existing Next.js project:
   ```bash
   npm install @capacitor/core @capacitor/cli
   npx cap init "Sophia" "com.sophia.app" --web-dir=out
   npx cap add ios
   npx cap sync ios
   ```
2. Configure app icon, splash screen, display name in Xcode project
3. Build to simulator + physical device via Xcode
4. Verify: full web experience works in WKWebView (voice live mode, text mode, journal, artifacts)
5. Verify: **microphone permission is one-time system grant** — not per-session Safari prompt
6. Final smoke test: entire Sophia experience end-to-end on iPhone
### Convergence (End of Week 6 — Phase 1 Done)
- [ ] GEPA produces measurably improved voice.md
- [ ] BootstrapFewShot golden turns injected (with voice emotion data)
- [ ] Builder mode works end-to-end on voice (companion stays live)
- [ ] iOS app installable via TestFlight — full Sophia experience on iPhone
- [ ] Microphone permission: one-time native grant confirmed
- [ ] All features polished and integration-tested
- [ ] Core companion production-ready for real users
---
## Phase 2: Expansion (Future)
- External channel integrations (social platforms, messaging apps)
- Proactive outreach system (heartbeat, scheduled check-ins, event awareness)
- iOS push notifications + voice push delivery
- Native Swift iOS app with Stream iOS SDK (full WebRTC, native audio session management)
- Wake word detection (Picovoice Porcupine — "Hey Sophia")
- Background audio mode with iOS entitlements
- Dynamic silence thresholds via SophiaTurn (tone_estimate → Smart Turn parameters)
- Experience bank: extract strategies from paired golden/poor turns
- GEPA on `tone_guidance.md`, then ritual files
- Lock-screen voice push playback (iOS notification service extension)
- iOS widget showing Sophia's last insight or emotional state indicator
---
## Critical Dependencies
| Dependency | When | Mitigation |
|-----------|------|-----------|
| Vision Agents works as documented | Week 1 | Test basic example Day 1. Fallback: Silero VAD in browser + direct Cartesia WebSocket |
| DeerFlow task() works for builder | Week 1 | Test Week 1 Day 4-5. Fallback: manual subgraph wiring |
| Mem0 categories auto-classify well | Week 1 | Test with 20 messages. Tune custom_instructions before proceeding |
| Voice latency acceptable (< 3s total) | Week 1 | Measure STT + DeerFlow + TTS Day 1. Optimize Mem0 cache if needed |
| emit_artifact tool_use reliable | Week 1 | Day 1 test — guaranteed by Anthropic's tool_use schema compliance |
| Cartesia emotion rendering quality | Week 2 | Test all emotions with selected voice. Fallback to primary set only if needed |
| Smart Turn quality for emotional conversations | Week 2 | Test with real emotional content. Adjust buffer_in_seconds |
| Trace volume sufficient for GEPA | Week 6 | Logging starts Week 2 → 4 weeks minimum. BootstrapFewShot works with fewer |
| Capacitor WebRTC in WKWebView | Week 6 | Test Day 4 — WebRTC supported since iOS 14.5+. Fallback: message mode only on iOS |
---
## What "Done" Looks Like at Week 6
- sophia_companion with full 14-middleware chain
- Vision Agents: voice emotion, conversation mode, barge-in
- All 4 rituals (prepare, debrief, vent, reset) fully functional
- Context modes (work, gaming, life) functional
- Text mode alongside voice in web app
- Mem0 with 9 categories, timestamp, graph, extraction
- Smart opener: next session opens aware of where user left off
- Builder: Sophia builds things while staying present in conversation
- emit_artifact tool_use on every turn
- Trace logging from Week 2 (including voice emotion fields)
- Offline pipeline: handoff → smart opener → extraction → in-app notification
- Memory candidates: review, edit, delete, auto-promotion
- Sophia Journal: browsable memories, timeline, search
- 3 visual artifact flows rendering real data
- Reflect flow: voice narrative + visual artifact
- Identity file: generates and loads from Week 5+
- BootstrapFewShot + first GEPA pass on voice.md
- iOS app (Capacitor): full Sophia experience on iPhone, one-time microphone permission
- iOS app installable via TestFlight
