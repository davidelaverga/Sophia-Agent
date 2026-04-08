# Sophia Frontend & UX
## Voice Experience, Text Mode, iOS App, Memory Candidates, Journal, Visual Artifacts

**Version:** 7.0 · March 2026
**Owner:** Luis (Voice + Frontend/UX)
**Voice Stack:** Vision Agents + Stream WebRTC SDK + Deepgram + Cartesia
**Web Stack:** Next.js (existing)
**iOS Stack:** Capacitor (wraps existing web app as native iOS app)

---

## 1. Three Platforms, One Sophia

Sophia exists on three platforms across two interaction types. The intelligence layer is identical across all three. What changes is how messages arrive, how responses are delivered, and what the artifact system produces.

| Platform | Interaction | Response length | Artifact | Voice emotion |
|----------|------------|-----------------|----------|---------------|
| **Voice (web app)** | Real-time WebRTC | 1–3 sentences | Full 13-field | Drives Cartesia TTS |
| **Voice (iOS app)** | Real-time WebRTC via Capacitor | 1–3 sentences | Full 13-field | Drives Cartesia TTS |
| **Text (web app)** | In-app text chat | 2–5 sentences | Full 13-field | Tracked, not delivered |

**Critical:** Always pass `platform` in the DeerFlow `configurable` parameter. The middleware chain adapts its token budget, artifact depth, and response length guidance based on this signal.

```typescript
// Voice turn (web or iOS)
config: { configurable: { user_id, platform: "voice", ritual, context_mode } }

// iOS voice turn (identical behaviour to voice)
config: { configurable: { user_id, platform: "ios_voice", ritual, context_mode } }

// Text turn
config: { configurable: { user_id, platform: "text", ritual, context_mode } }
```

---

## 2. The Voice Experience — Primary Differentiator

The voice experience is what makes Sophia feel real. It's Luis's highest-priority deliverable.

### 2.1 Two Conversation Modes

**Message Mode (Push-to-Talk):**
Current interaction model. User taps mic icon, speaks, releases. Audio sends to backend. Sophia responds. Simple, reliable, works in noisy environments. Kept as fallback.

Implementation: WebSocket audio as currently built.

**Conversation Mode (Live — NEW):**
Mic stays open. Smart Turn's neural model detects when the user finishes speaking. Sophia responds automatically. User can interrupt (barge-in). Hands-free.

Implementation: Vision Agents via Stream WebRTC SDK.

**Toggle in UI:**
```
┌──────────────────────────────┐
│  [💬 Message] [🎙️ Live]      │  ← toggle at top of chat
└──────────────────────────────┘
```

Default: Message mode. User opts into Live mode. Live mode shows a subtle audio level indicator to confirm the mic is active.

### 2.2 Stream WebRTC Integration

In Live mode, the frontend uses Stream's JavaScript SDK:

```typescript
import { StreamCall } from '@stream-io/video-react-sdk';

const call = client.call('default', callId);
await call.join();
// Audio flows via WebRTC — Vision Agents handles STT → DeerFlow → TTS → audio back
```

The web app doesn't do STT or TTS. It just sends and receives audio via WebRTC. The iOS Capacitor app uses the same WebRTC connection inside WKWebView — identical pipeline.

### 2.3 SophiaLLM — Use runs/stream, Not runs/wait

**This is the most important technical requirement for Luis.** Use `runs/stream`, not `runs/wait`. Text tokens pipe to Cartesia as they arrive. Sophia's voice starts after TTFT (~600ms), not after full generation (~1,200ms). This is the difference between hitting the 3-second target or missing it.

```typescript
// WRONG — waits for complete response before TTS starts
POST /threads/{id}/runs/wait

// CORRECT — pipes tokens to TTS immediately as they stream
POST /threads/{id}/runs/stream
```

The `emit_artifact` tool call arrives after the text stream completes. It does not block TTS. It updates the emotion for the **next** TTS call.

### 2.4 Handling the Artifact in SophiaLLM

The artifact is no longer appended text with `ARTIFACTS_JSON:` — it is a guaranteed tool_use call. Parse it from the SSE stream:

```typescript
// voice/sophia_llm.py (simplified)
async for line in response.aiter_lines():
    if not line.startswith("data: "):
        continue
    event = json.loads(line[6:])

    # Text tokens → pipe to Cartesia immediately
    if event["type"] == "messages-tuple" and event["data"]["type"] == "ai":
        chunk = event["data"].get("content", "")
        if chunk:
            await tts.stream_chunk(chunk)

    # Artifact → tool call result (arrives after text)
    if (event["type"] == "messages-tuple"
            and event["data"]["type"] == "tool"
            and event["data"].get("name") == "emit_artifact"):
        artifact = json.loads(event["data"]["content"])
        tts.update_from_artifact(artifact)  # affects NEXT turn's emotion
```

The artifact is guaranteed valid JSON — Anthropic's tool_use schema compliance means no more fragile string parsing.

### 2.5 Voice Emotion System

Every turn, the LLM chooses how Sophia SOUNDS. The artifact includes:

- `voice_emotion_primary` — dominant emotion from Cartesia's vocabulary. Chosen by LLM based on intent and content of the response.
- `voice_emotion_secondary` — fallback from the primary set (neutral, excited, content, sad, scared).
- `voice_speed` — slow / gentle / normal / engaged / energetic → maps to Cartesia speed (0.8–1.15).

`SophiaTTS` reads these and injects before Cartesia synthesis:

```python
# voice/sophia_tts.py
async def stream_audio(self, text, *args, **kwargs):
    ssml = f'<emotion value="{self.emotion_primary}"/><speed ratio="{self.speed}"/>'
    return await super().stream_audio(f"{ssml}{text}", *args, **kwargs)
```

The artifact from turn N drives the emotion for turn N+1's TTS. This is correct — the artifact arrives after the text has already started streaming. The emotion calibration is forward-looking.

### 2.6 Voice Emotion Feedback (Visual)

While Sophia speaks, subtle visual feedback based on artifact metadata:
- Gentle color shift in chat background matching the emotional tone
- Audio level indicator pulses with Sophia's speech rhythm
- Small emotion label visible in debug/dev mode only

This is Week 5–6 polish, not Week 1–2 priority.

### 2.7 Barge-In UX

When the user starts speaking while Sophia is talking:
1. Sophia's audio stops immediately (Vision Agents handles server-side)
2. Frontend stops visual playback animation
3. UI switches to "listening" state
4. No explicit user action — just start talking

### 2.8 Latency Targets

| Stage | Target | Notes |
|-------|--------|-------|
| STT (Deepgram) | 200–400ms | Real-time streaming |
| Turn detection | 200–500ms | Smart Turn neural model |
| DeerFlow TTFT | 400–600ms | Haiku on ~9k token prompt |
| TTS first audio (Cartesia) | 200–400ms | Streaming, starts at TTFT |
| **Total turn-around (Live mode)** | **1.2–2.0s** | End of speech → first audio |

If Live mode exceeds 3 seconds consistently: check Mem0 cache miss rate first (target: >70% cache hits within session), then check DeerFlow middleware overhead.

---

## 3. Text Mode (In-App)

Text mode is a first-class platform, not a fallback. Users who prefer typing, or who are in a public place, use text mode directly in the web app.

### 3.1 Implementation

Same DeerFlow backend as voice. Different `platform` parameter:

```typescript
// Text turn — same LangGraph API, different configurable
const response = await fetch(`/api/langgraph/threads/${threadId}/runs/stream`, {
  method: 'POST',
  body: JSON.stringify({
    assistant_id: 'sophia_companion',
    input: { messages: [{ role: 'user', content: userMessage }] },
    config: { configurable: {
      user_id: userId,
      platform: 'text',    // ← key difference from voice
      ritual: activeRitual,
      context_mode: contextMode,
    }}
  })
});
```

### 3.2 What Changes vs Voice

- Response length: 2–5 sentences (vs 1–3 on voice). The middleware injects different guidance based on `platform: "text"`.
- No TTS. No voice emotion delivery. Artifact still generated and stored for tone continuity and trace logging — but not used for audio.
- Smart opener still delivers on first turn of new session — as a typed message from Sophia before the user says anything.

### 3.3 UI

Text mode sits alongside voice mode in the chat interface. The same toggle that switches between Message and Live voice modes includes a Text option:

```
┌──────────────────────────────────────┐
│  [💬 Message] [🎙️ Live] [⌨️ Text]   │
└──────────────────────────────────────┘
```

In Text mode: no mic, no audio UI. Standard chat input field. Sophia's responses appear as text messages.

---

## 4. The Smart Opener — Sophia Speaks First

At the start of every new session (first turn, before the user says anything), Sophia opens with a context-aware line generated from the previous session's handoff.

### 4.1 What It Is

Not a generic greeting. A specific, warm opener derived from: the previous session's open threads, upcoming events, final tone, and elapsed time.

Examples:
- *"The investor pitch is tomorrow. How are you feeling going into it?"*
- *"You mentioned the conversation with Marco — did that happen?"*
- *"It's been a few days. Where are you at?"*
- *"Something shifted last time. How does it feel from the other side?"*

### 4.2 How It Arrives

The smart opener is injected by `SessionStateMiddleware` as a FIRST TURN INSTRUCTION in the system prompt. Sophia delivers it as her opening line. Luis doesn't need to do anything special to trigger it — it happens automatically on any session's first turn.

**What Luis does implement:** The UI flow that allows Sophia to send the first message before the user types.

### 4.3 UI Implementation

**Voice (web + iOS):** Sophia speaks her opener automatically when the session starts, without waiting for the user to speak first. The UI shows a "Sophia is speaking" state on open.

**Text:** Sophia's opener appears as the first chat bubble before the input field is active. It feels like Sophia is already present when the user opens the conversation.

```typescript
// On session start (all platforms):
// 1. Create/resume thread
// 2. Check if session has 0 turns (new session)
// 3. If new session, trigger a "start session" call with empty user message
//    OR: SessionStateMiddleware handles first-turn injection automatically on any first message
// 4. Sophia's response IS the opener — display it / speak it before user input
```

The simplest implementation: when the user opens the app and selects a ritual (or starts a free conversation), fire an initial empty message to DeerFlow. The smart opener instruction in the system prompt causes Sophia's first response to be the opener. Display it before the user's input field appears.

---

## 5. Session & Ritual Selection

Users choose their session type in the app before starting. This is always deterministic — Sophia never guesses the user's intent.

### 5.1 Session Start UI

```
┌─────────────────────────────────────────┐
│  What would you like to do?             │
│                                         │
│  [Just talk]                            │
│                                         │
│  [Prepare →] [Debrief →]               │
│  [Vent →]    [Reset →]                 │
│                                         │
│  Context: [Work] [Gaming] [Life]        │
└─────────────────────────────────────────┘
```

Selecting a ritual or context mode sets the `configurable` for all DeerFlow calls in that session. No mid-session switching.

### 5.2 Voice Ritual Trigger

In addition to tapping a button, the user can say the trigger phrase while in an active session:

*"Sophia, start a debrief"* / *"Let's do a prepare ritual"*

Luis detects this in `SophiaLLM` with lightweight keyword matching before the DeerFlow call:

```python
# voice/sophia_llm.py
RITUAL_TRIGGERS = {
    "debrief": ["start a debrief", "let's debrief", "do a debrief"],
    "prepare": ["start a prepare", "let's prepare", "prepare ritual"],
    "vent": ["i need to vent", "let me vent", "vent ritual"],
    "reset": ["need a reset", "let's reset", "reset ritual"],
}

def detect_ritual_trigger(text: str) -> str | None:
    text_lower = text.lower()
    for ritual, triggers in RITUAL_TRIGGERS.items():
        if any(t in text_lower for t in triggers):
            return ritual
    return None

# In generate():
detected_ritual = detect_ritual_trigger(last_message)
if detected_ritual:
    self.active_ritual = detected_ritual
    # Pass in next DeerFlow call's configurable
```

This runs before the DeerFlow call — the very first turn of the ritual loads the correct ritual file with no wasted turn.

---

## 6. Memory Candidates

The existing implementation handles delete. Version 7.0 adds edit and category display.

### 6.1 Card Design

```
┌──────────────────────────────────────┐
│  [feeling]                 ●●●○      │
│                                      │
│  Feels overlooked at work            │
│                                      │
│  Gets anxious when contributions     │
│  aren't acknowledged in team         │
│  meetings.                           │
│                                      │
│  debrief · Mar 18                    │
│                                      │
│  ┌──────┐  ┌──────┐  ┌──────┐      │
│  │ Keep │  │ Edit │  │Delete│      │
│  └──────┘  └──────┘  └──────┘      │
└──────────────────────────────────────┘
```

### 6.2 Category Badges

| Category | Color | Label |
|----------|-------|-------|
| fact | gray | FACT |
| feeling | purple | FEELING |
| decision | blue | DECISION |
| lesson | amber | LESSON |
| commitment | green | GOAL |
| preference | teal | PREFERENCE |
| relationship | pink | RELATIONSHIP |
| pattern | orange | PATTERN |
| ritual_context | indigo | RITUAL |

### 6.3 Edit Mode

Tap Edit → card expands with editable text field + category dropdown. Save calls `PUT /api/sophia/{user_id}/memories/{memory_id}` with updated text and/or category.

### 6.4 Auto-Promotion Indicator

Unreviewed memories auto-promote to active after 48 hours. Show a subtle countdown on each card: "Auto-saves in 36h" — so users know they don't have to review everything immediately.

### 6.5 API

```typescript
// Fetch pending
const memories = await fetch(
  `/api/sophia/${userId}/memories/recent?status=pending_review`
);

// Keep (set status active)
await fetch(`/api/sophia/${userId}/memories/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ metadata: { status: 'active' } })
});

// Edit
await fetch(`/api/sophia/${userId}/memories/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ text: editedText, metadata: { category: selected } })
});

// Delete
await fetch(`/api/sophia/${userId}/memories/${id}`, { method: 'DELETE' });
```

---

## 7. Sophia Journal

Where all of Sophia's knowledge and creations are visible and browsable. The answer to "what does Sophia know about me?" and "what has she noticed?"

### 7.1 Purpose

Three tabs:
- **Memories** — All Mem0 entries, filterable by category. Type badges, importance dots, edit button.
- **Insights** — Visual artifacts: weekly summaries, decision cards, goal progress, reflections.
- **Timeline** — Everything chronological: memories + artifacts interleaved, grouped by week.

Search across all memories via Mem0 search API.

### 7.2 Layout

The Memories tab shows cards by category with the same type badge system as memory candidates. Edit and delete inline.

The Insights tab shows generated visual artifacts — tone trajectory charts, decision cards, commitment trackers, reflect outputs.

The Timeline tab interleaves memories and visual artifacts chronologically. A week with 5 sessions, 12 memories, and one visual artifact shows all of them in sequence.

### 7.3 API

```typescript
// Memories by category
const memories = await fetch(
  `/api/sophia/${userId}/journal?type=feeling`
);

// Search
const results = await fetch(
  `/api/sophia/${userId}/journal?search=presentations`
);

// Visual artifacts
const weekly = await fetch(
  `/api/sophia/${userId}/visual/weekly`
);
```

---

## 8. Visual Artifacts

### 8.1 Three Deterministic Flows

Generated automatically from Mem0 data. Delivered as HTML pages linked from the Journal Insights tab.

**"Your Emotional Week"** — Tone trajectory across sessions. Trigger: 3+ sessions in a week.
Data source: `GET /api/sophia/{user_id}/visual/weekly` — tone metadata from session artifacts.

**"Decisions That Mattered"** — Decision memories as cards. Trigger: 5+ decisions accumulated.
Data source: `GET /api/sophia/{user_id}/visual/decisions` — decision-category Mem0 memories.

**"Progress on Your Goals"** — Commitment tracking. Trigger: 3+ commitments exist.
Data source: `GET /api/sophia/{user_id}/visual/commitments` — commitment-category Mem0 memories.

### 8.2 Reflect Flow Visual

When the reflect flow triggers, the visual artifact generates alongside Sophia's spoken narrative:

- Tone trajectory chart for the period
- Pattern cards (if patterns detected)
- Episode highlight (if a standout session exists)
- Growth indicator (if behavioral change traced)

Saved to Journal under Insights tab. Data comes from: `POST /api/sophia/{user_id}/reflect` → `visual_parts` array in response.

### 8.3 Delivery

Visual artifacts appear in the Journal Insights tab on both web and iOS apps. Accessible anytime. An in-app notification appears when a new artifact is ready — tap to open directly to the Insights tab.

---

## 9. Handoff Points with Backend

| What Luis Needs | When | What Jorge Provides |
|----------------|------|-------------------|
| sophia_companion responding via HTTP stream | Week 1 | LangGraph stream API at localhost:2024 |
| emit_artifact tool call in SSE stream (not appended text) | Week 1 | emit_artifact tool registered, guaranteed tool_use |
| `platform` configurable parameter respected | Week 1 | PlatformContextMiddleware reads it |
| Smart opener on session first turn | Week 3 | SessionStateMiddleware injects FIRST TURN INSTRUCTION |
| Memory list/update/delete endpoints | Week 1 | Gateway REST API |
| Visual artifact data endpoints | Week 4 | Mem0 queries formatted as JSON |
| Reflect flow endpoint | Week 5 | voice_context + visual_parts |
| In-app notification signal (memories ready) | Week 3 | Offline pipeline step 4 |

**Rule:** JSON shapes defined in Week 1. Luis builds against mock data. Jorge swaps mocks for real calls when ready.

---

## 10. iOS App via Capacitor

### 10.1 What It Is

The existing Next.js web app wrapped in a native iOS shell using Capacitor. Installable from TestFlight (beta) or App Store. Appears as a native app — home screen icon, no browser chrome, system-level permissions.

### 10.2 Setup

```bash
# Install Capacitor into existing Next.js project
npm install @capacitor/core @capacitor/cli
npx cap init "Sophia" "com.sophia.app" --web-dir=out
npx cap add ios

# Build web app and sync into native shell
npm run build
npx cap sync ios

# Open in Xcode for icon, splash, and device testing
npx cap open ios
```

Configure in Xcode: app icon, splash screen, display name, bundle identifier. Build to simulator or physical device. Submit to TestFlight for beta distribution.

### 10.3 Why Capacitor Solves the Mic Problem

Mobile Safari treats microphone access as a temporary, per-session permission. Every page reload or interaction can trigger the "Allow microphone?" prompt again. This is an Apple WebKit policy — it cannot be overridden in code.

Capacitor wraps the web app in a native shell. Microphone permission becomes a **one-time system grant** — the standard iOS dialog appears once ("Sophia would like to access the microphone"), the user taps Allow, and it's permanent. The permission is stored in iOS Settings → Sophia → Microphone, exactly like WhatsApp or Telegram.

This single change eliminates the most annoying friction point in the current mobile voice experience.

### 10.4 What Works Identically to Web

Everything in the WKWebView runs the same code as the web app:
- Live conversation mode (WebRTC via Stream SDK — supported in WKWebView since iOS 14.5+)
- Message mode (push-to-talk)
- Text mode
- Sophia Journal (Memories, Insights, Timeline)
- Memory candidates with edit/delete
- Visual artifacts
- Session and ritual selection
- Context mode selection
- Smart opener delivery

Luis does NOT need to rewrite any of these for iOS. The Capacitor shell runs the existing web app. The one-time microphone permission is the primary native addition in Phase 1.

---

## 11. What Success Looks Like

A user sits down in the morning and opens Sophia. Before they say a word, Sophia speaks: *"The investor pitch is tomorrow. How are you feeling going into it?"* Not a generic greeting — the opener is drawn from what they shared last time.

They tap Live. Sophia's voice is warm and grounded. Smart Turn gives them space. They talk for 10 minutes while making coffee, doing a prepare ritual.

The pitch happens. They open the app on the train home. *"Let's debrief."* Sophia opens: *"The pitch is behind you now. How did it go?"* They talk for another 10 minutes. The voice feels right — emotional calibration from the artifact system means her tone mirrors their state.

That evening, a notification appears in the app: *"I noticed a few things from our session. Want to review?"* They tap through to memory candidates — typed, categorized, editable. The session is captured.

On Sunday, they open the Journal. Everything is there — memories organized by type, a visual artifact showing the prepare→pitch→debrief arc, their emotional trajectory across the week, the commitments they set. Searchable. Organized by what matters. The full record of a companion that remembers.

They open the app on their iPhone. Same experience — home screen icon, no Safari prompts, one-time microphone permission. The voice experience is identical to web.

This is what Phase 1 delivers: a companion that remembers, opens every session aware of where you left off, speaks with the right emotion, and makes you feel genuinely seen.

---

*Companion specs:*
- *`01_architecture_overview.md` — System overview, platforms, iOS Capacitor*
- *`02_build_plan.md` — 6-week phased build, three parallel tracks*
- *`03_memory_system.md` — Mem0, categories, retrieval, handoffs, smart opener, reflection*
- *`04_backend_integration.md` — DeerFlow middleware chain, voice pipeline, offline flows, GEPA*
- *`06_implementation_spec.md` — Codebase-specific implementation details for Jorge and Luis*
