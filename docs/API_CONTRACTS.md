# Sophia API Contracts
**Version:** 1.0 · April 2026
**For:** Luis (Voice + Frontend)
**From:** Jorge (Backend)

---

## 1. Streaming Conversations via `runs/stream`

### Request

```bash
POST http://localhost:2024/threads/{thread_id}/runs/stream
Content-Type: application/json

{
  "assistant_id": "sophia_companion",
  "input": {
    "messages": [{"role": "user", "content": "I feel stuck at work"}]
  },
  "config": {
    "configurable": {
      "user_id": "user_123",
      "platform": "voice",
      "ritual": null,
      "context_mode": "work"
    }
  }
}
```

### Create a Thread First

```bash
POST http://localhost:2024/threads
Content-Type: application/json
{}
# Returns: {"thread_id": "uuid-here"}
```

Reuse the same `thread_id` for multi-turn conversations within a session.

### SSE Event Format

The response is a stream of Server-Sent Events. Key event types:

**Text chunks (AI response):**
```
data: {"type": "messages-tuple", "data": {"type": "ai", "content": "What's going on?"}}
```

**Tool call (emit_artifact):**
```
data: {"type": "messages-tuple", "data": {"type": "tool", "name": "emit_artifact", "content": "{\"tone_estimate\": 2.5, ...}"}}
```

**IMPORTANT:** The artifact arrives AFTER the text stream completes. It does NOT interleave with text chunks.

---

## 2. Parsing the Artifact

The `emit_artifact` tool call contains 13 fields as a JSON string in the `content` field:

```json
{
  "session_goal": "Help user process work frustration",
  "active_goal": "Name what's underneath the surface complaint",
  "next_step": "If they name the real issue, go deeper. If deflecting, try labeling.",
  "takeaway": "Burnout usually points to something specific, not everything at once.",
  "reflection": "What part of the job used to matter to you?",
  "tone_estimate": 2.0,
  "tone_target": 2.5,
  "active_tone_band": "anger_antagonism",
  "skill_loaded": "active_listening",
  "ritual_phase": "freeform.burnout",
  "voice_emotion_primary": "calm",
  "voice_emotion_secondary": "neutral",
  "voice_speed": "normal"
}
```

### Voice-Relevant Fields

| Field | Use | Values |
|-------|-----|--------|
| `voice_emotion_primary` | Cartesia emotion parameter | Any from the Cartesia vocabulary (see section 3) |
| `voice_emotion_secondary` | Fallback if primary sounds wrong | Primary set: neutral, angry, excited, content, sad, scared |
| `voice_speed` | Cartesia speed parameter | slow, gentle, normal, engaged, energetic |

### Timing

The artifact updates the emotion for the **NEXT** TTS call, not the current one. On the first turn, use `content` as the default emotion.

Flow:
1. User speaks → STT → text
2. Text sent to `runs/stream`
3. AI text chunks stream back → pipe to TTS immediately with CURRENT emotion
4. Artifact arrives after text → store for NEXT turn's TTS call

---

## 3. Voice Emotion → Cartesia Mapping

### Speed Values

| Sophia value | Cartesia speed |
|-------------|---------------|
| `slow` | 0.8 |
| `gentle` | 0.9 |
| `normal` | 1.0 |
| `engaged` | 1.05 |
| `energetic` | 1.15 |

### Primary Emotions (most reliable)

`neutral`, `angry`, `excited`, `content`, `sad`, `scared`

### Full Vocabulary

Pass `voice_emotion_primary` directly to Cartesia's emotion parameter. The full set:
`happy`, `excited`, `enthusiastic`, `elated`, `euphoric`, `triumphant`, `amazed`, `surprised`, `curious`, `content`, `peaceful`, `serene`, `calm`, `grateful`, `affectionate`, `trust`, `sympathetic`, `anticipation`, `mysterious`, `angry`, `frustrated`, `agitated`, `sad`, `melancholic`, `disappointed`, `hurt`, `guilty`, `tired`, `nostalgic`, `wistful`, `apologetic`, `hesitant`, `insecure`, `confused`, `resigned`, `anxious`, `panicked`, `alarmed`, `scared`, `neutral`, `proud`, `confident`, `contemplative`, `determined`

---

## 4. Configurable Parameters

| Parameter | Type | Values | Effect |
|-----------|------|--------|--------|
| `user_id` | string | Any valid identifier (alphanumeric + `-_`) | Scopes memories, identity, handoffs to this user |
| `platform` | string | `"voice"`, `"text"`, `"ios_voice"` | Controls response length and prompt style |
| `ritual` | string or null | `"prepare"`, `"debrief"`, `"vent"`, `"reset"`, `null` | Activates a structured conversational protocol |
| `context_mode` | string | `"work"`, `"gaming"`, `"life"` | Adjusts tone and prioritizes context-specific memories |

### Platform Effects

| Platform | Response length | TTS | Artifact |
|----------|----------------|-----|----------|
| `voice` | 1-3 sentences | Yes | Full 13-field |
| `text` | 2-5 sentences | No | Full 13-field |
| `ios_voice` | 1-3 sentences | Yes | Full 13-field |

---

## 5. Session Lifecycle

### Starting a Session

1. Create a thread: `POST /threads`
2. Send first message with configurable parameters
3. The middleware chain loads: soul.md, voice.md, techniques.md, identity file, memories, skill, tone guidance, context, ritual (if any), artifact instructions

### Multi-Turn

Reuse the same `thread_id`. State persists across turns:
- Tone tracking continues
- Skill routing adapts based on conversation flow
- Previous artifact is injected for context

### Ending a Session

**Option A — Explicit (from voice layer):**
```bash
POST http://localhost:8001/api/sophia/{user_id}/end-session
Content-Type: application/json
{"session_id": "unique-session-id", "thread_id": "the-thread-id"}
```
Returns immediately with `202 Accepted`. Pipeline runs in background.

**Option B — Inactivity timeout (automatic):**
If no messages arrive for 10 minutes, the gateway's inactivity watcher automatically fires the offline pipeline.

**Option C — WebRTC disconnect (voice layer):**
Call `end-session` from the `on_disconnect` handler in `SophiaLLM`.

### What the Offline Pipeline Does

1. Writes trace file (`users/{user_id}/traces/{session_id}.json`)
2. Extracts memories to Mem0 (with `status: pending_review`)
3. Generates smart opener for the next session
4. Writes handoff file (`users/{user_id}/handoffs/latest.md`)
5. Conditionally updates identity file
6. Logs notification intent

---

## 6. Gateway Endpoints (for frontend)

All at `http://localhost:8001/api/sophia/`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/{user_id}/memories/recent` | GET | List memories (optional `?status=pending_review`) |
| `/{user_id}/memories/{id}` | PUT | Update memory text/metadata |
| `/{user_id}/memories/{id}` | DELETE | Delete memory |
| `/{user_id}/memories/bulk-review` | POST | Batch approve/discard |
| `/{user_id}/reflect` | POST | Generate reflection (`{query, period}`) |
| `/{user_id}/journal` | GET | Browse all memories (optional `?category=...`) |
| `/{user_id}/visual/weekly` | GET | Tone trajectory (last 7 days) |
| `/{user_id}/visual/decisions` | GET | Decision memories |
| `/{user_id}/visual/commitments` | GET | Commitment memories |
| `/{user_id}/end-session` | POST | Trigger offline pipeline |

Full OpenAPI docs at `http://localhost:8001/docs`.

---

## 7. Voice Session & SSE Bridge

### Architecture

```
Frontend ──POST──▸ Gateway ──proxy──▸ Voice Service ──runs/stream──▸ LangGraph
   │                  │                     │
   │◂── SSE ──────────│◂── SSE ────────────│
   │  (browser)       │  (gateway proxy)    │  (voice service emits events)
```

The voice service owns the live turn loop: STT, `runs/stream`, TTS, and event emission.
The gateway proxies SSE events to the browser. The frontend never talks to the voice service directly.

### Voice Connect

```bash
POST http://localhost:8001/api/sophia/{user_id}/voice/connect
Content-Type: application/json

{
  "platform": "voice",          # or "ios_voice"
  "ritual": null,               # or "prepare" | "debrief" | "vent" | "reset"
  "context_mode": "life"        # or "work" | "gaming"
}
```

**Response:**
```json
{
  "call_id": "uuid-call-id",
  "session_id": "uuid-session-id",
  "thread_id": "uuid-thread-id",
  "stream_url": "/api/sophia/{user_id}/voice/events?call_id={call_id}&session_id={session_id}"
}
```

Use `call_id` + `session_id` to open the SSE stream.

**CRITICAL:** `thread_id` is the LangGraph conversation thread. The voice service MUST reuse this same `thread_id` for every `runs/stream` call within the session. Without it, Sophia loses conversation continuity — each turn would be a blank slate with no memory of what was just said. The connect endpoint creates the thread once; all subsequent turns in that voice session use the same thread.

### Voice Disconnect

```bash
POST http://localhost:8001/api/sophia/{user_id}/voice/disconnect
Content-Type: application/json

{
  "call_id": "uuid-call-id",
  "session_id": "uuid-session-id",
  "thread_id": "uuid-thread-id"
}
```

Returns `202 Accepted`. Fires offline pipeline in background (needs `thread_id` to read the conversation state for memory extraction, handoff generation, etc.). Closes all SSE subscribers for this session.

### SSE Event Stream (Browser-Facing)

```bash
GET http://localhost:8001/api/sophia/{user_id}/voice/events?call_id={call_id}&session_id={session_id}
Accept: text/event-stream
```

**Response:** `text/event-stream` with the following event types:

#### `sophia.user_transcript` — User speech recognized

```
event: sophia.user_transcript
data: {"type": "sophia.user_transcript", "data": {"text": "I feel stuck", "final": true}}
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Recognized speech text |
| `final` | boolean | `true` = final transcript, `false` = interim/partial |

#### `sophia.turn` — Turn lifecycle

```
event: sophia.turn
data: {"type": "sophia.turn", "data": {"turn_id": "turn_abc123", "status": "started"}}
```

| Field | Type | Description |
|-------|------|-------------|
| `turn_id` | string | Unique turn identifier |
| `status` | string | `"started"` or `"completed"` |

#### `sophia.transcript` — Sophia's response text

```
event: sophia.transcript
data: {"type": "sophia.transcript", "data": {"text": "What's going on?", "turn_id": "turn_abc123"}}
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Response text chunk (may arrive in multiple events) |
| `turn_id` | string | Which turn this text belongs to |

#### `sophia.artifact` — Turn metadata (arrives after text)

```
event: sophia.artifact
data: {"type": "sophia.artifact", "data": {"tone_estimate": 2.0, "tone_target": 2.5, "active_tone_band": "anger_antagonism", "voice_emotion_primary": "calm", "voice_emotion_secondary": "neutral", "voice_speed": "normal", "session_goal": "...", "active_goal": "...", "next_step": "...", "takeaway": "...", "reflection": null, "skill_loaded": "active_listening", "ritual_phase": "freeform.burnout"}}
```

Contains all 13 artifact fields (same schema as section 2). Arrives AFTER all `sophia.transcript` events for that turn.

#### Heartbeat

```
: heartbeat
```

Sent every ~30 seconds if no events. Keeps the connection alive through proxies.

### Frontend Integration Example

```typescript
// 1. Connect — returns call_id, session_id, thread_id, and SSE URL
const res = await fetch(`/api/sophia/${userId}/voice/connect`, {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({platform: "voice", ritual: null, context_mode: "life"}),
});
const {call_id, session_id, thread_id, stream_url} = await res.json();

// 2. Open SSE stream
const eventSource = new EventSource(stream_url);

eventSource.addEventListener("sophia.transcript", (e) => {
  const {text, turn_id} = JSON.parse(e.data).data;
  // Display Sophia's response text
});

eventSource.addEventListener("sophia.artifact", (e) => {
  const artifact = JSON.parse(e.data).data;
  // Update UI with tone, emotion, session context
});

eventSource.addEventListener("sophia.user_transcript", (e) => {
  const {text, final: isFinal} = JSON.parse(e.data).data;
  // Show user's speech-to-text
});

eventSource.addEventListener("sophia.turn", (e) => {
  const {turn_id, status} = JSON.parse(e.data).data;
  // Track turn lifecycle (started/completed)
});

// 3. Disconnect — pass thread_id so offline pipeline can process the conversation
await fetch(`/api/sophia/${userId}/voice/disconnect`, {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({call_id, session_id, thread_id}),
});
eventSource.close();
```

### Important Notes

1. **Audio stays on WebRTC.** SSE carries text events only. STT and TTS audio flows through Stream's WebRTC transport, not through SSE.
2. **Voice service owns the turn.** The SSE stream mirrors events the voice service already produces. It does not create new turn ownership.
3. **Artifact timing.** `sophia.artifact` always arrives after all `sophia.transcript` events for that turn. It updates the emotion for the NEXT turn's TTS.
4. **Cleanup.** When the browser closes the SSE connection, the gateway cleans up the subscriber. When `disconnect` is called, all subscribers are released and the offline pipeline fires.
5. **Dual delivery.** During migration, the voice service emits both Stream custom events AND SSE events. Both carry the same payload.
