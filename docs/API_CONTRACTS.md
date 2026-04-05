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
