# Multi-Session Feature Plan

Branch: `feat/multi-session`
Base: `voice-transport-migration`

## Goal

Let users have multiple open sessions simultaneously — like ChatGPT's conversation list. If the user leaves a session without ending it, that session stays open and resumable. The user can switch between sessions, start new ones, and pick up where they left off.

---

## What exists today

### Frontend

| Component | State | Notes |
|---|---|---|
| `session-store.ts` | Single `session: SessionClientStore \| null` | One active session at a time. Persists to `sophia-session-store` localStorage. |
| `session-history-store.ts` | `SessionHistoryEntry[]` (max 50) | Stores *ended* sessions only. Used by the session sidebar. No thread resumption. |
| `conversation-store.ts` | `ConversationListItem[]` | Chat-route conversations. Supports list, load, switch, archive. Persists to `sophia-conversation-store`. |
| `conversation-loader.ts` | `loadConversation()`, `startNewConversation()` | Loads chat-route conversations from localStorage or backend. |
| `conversation-history.ts` | `ArchivedConversation` in localStorage | Chat messages stored per conversation in `sophia-chat-history-{id}`. |
| `DashboardSidebar.tsx` | Left sidebar = session history, Right sidebar = conversation list | Session cards are read-only (view recap). Conversation list supports switching. |
| `chat/page.tsx` | Chat route — free text | Uses conversation store for multi-conversation. |
| `session/page.tsx` | Session route — voice + ritual | Single session model. No URL-based thread routing. |
| `message-metadata-store.ts` | Thread ID, session ID per message | Tracks current thread/session/run but doesn't persist across session switches. |

### Backend

| Component | State | Notes |
|---|---|---|
| `sessions.py` router | `POST /start`, `GET /active`, `POST /end` | `/active` is a stub that always returns `has_active_session: false`. |
| `_create_langgraph_thread()` | Creates a real LangGraph thread | Returns UUID. Thread persists via LangGraph checkpointer. |
| `inactivity_watcher.py` | In-memory `_active_threads` dict | Tracks per-thread activity. Triggers offline pipeline after 10-min inactivity. Resets on restart. |
| LangGraph checkpointer | Thread state persistence | Messages, artifacts, sandbox state survive across calls. Thread can be resumed by ID. |
| `langgraph.json` | `sophia_companion` graph | Checkpointer configured — threads are already resumable at the graph level. |

### Key insight

LangGraph threads are already resumable by ID. The backend *can* do multi-session. The gap is entirely in the frontend lifecycle and the session management endpoints.

---

## Architecture

### Data model

```
┌─────────────────────────────────────┐
│         SessionRecord               │
│  (persisted per user, backend DB)   │
├─────────────────────────────────────┤
│ session_id    : UUID (PK)           │
│ thread_id     : UUID (LangGraph)    │
│ user_id       : string              │
│ status        : open | ended        │
│ title         : string | null       │
│ preset_type   : PresetType          │
│ context_mode  : ContextMode         │
│ platform      : voice|text|ios      │
│ message_count : int                 │
│ last_message  : string | null       │
│ created_at    : ISO timestamp       │
│ updated_at    : ISO timestamp       │
│ ended_at      : ISO timestamp|null  │
└─────────────────────────────────────┘
```

### Storage options for v1

Two viable options for persisting sessions:

**Option A — File-based (consistent with current `users/` pattern)**
- Store session records as JSON in `users/{user_id}/sessions/`
- One file per session: `users/{user_id}/sessions/{session_id}.json`
- Index file: `users/{user_id}/sessions/index.json` (ordered list, cached)
- Pro: No new dependency, consistent with existing `builder_tasks/`, `recaps/`, `handoffs/` patterns
- Con: File I/O, no query capability

**Option B — SQLite (better for queries)**
- Single file: `users/{user_id}/sophia.db`
- Pro: Fast queries, pagination, ordering, filtering
- Con: New dependency, migration path

**Recommendation**: Option A for v1. The session list is small (tens to low hundreds per user) and the existing codebase already uses file-based user data extensively. Upgrade to SQLite later if needed.

---

## Implementation phases

### Phase 1 — Backend session persistence (foundation)

**Goal**: Real session CRUD that survives restarts.

#### 1.1 Session file store

New module: `backend/packages/harness/deerflow/sophia/session_store.py`

```python
class SessionRecord(BaseModel):
    session_id: str
    thread_id: str
    user_id: str
    status: Literal["open", "ended"]
    title: str | None = None
    preset_type: str = "open"
    context_mode: str = "life"
    platform: str = "text"
    message_count: int = 0
    last_message_preview: str | None = None
    created_at: str
    updated_at: str
    ended_at: str | None = None

class SessionStore:
    def __init__(self, base_path: Path):
        ...
    
    def create(self, record: SessionRecord) -> SessionRecord
    def get(self, user_id: str, session_id: str) -> SessionRecord | None
    def update(self, user_id: str, session_id: str, **updates) -> SessionRecord
    def list_open(self, user_id: str) -> list[SessionRecord]
    def list_recent(self, user_id: str, limit: int = 30) -> list[SessionRecord]
    def end(self, user_id: str, session_id: str) -> SessionRecord
```

File layout:
```
users/{user_id}/sessions/{session_id}.json
```

#### 1.2 Upgrade session endpoints

Replace stubs in `backend/app/gateway/routers/sessions.py`:

| Endpoint | Current | After |
|---|---|---|
| `POST /start` | Creates LangGraph thread, returns hardcoded greeting | Creates LangGraph thread + SessionRecord. Returns full session metadata. |
| `GET /active` | Stub: always `false` | Returns all open sessions for the authenticated user. |
| `POST /end` | Stub: returns zeros | Marks session as ended, updates timestamp and stats. |
| `GET /sessions` (new) | — | Paginated list of all sessions (open + ended). |
| `GET /sessions/{id}` (new) | — | Single session detail with thread_id for resumption. |
| `PATCH /sessions/{id}` (new) | — | Update title or metadata. |

#### 1.3 Session title generation

After the first assistant turn, generate a session title from the conversation content. Use Haiku for a 3-5 word title.

- Trigger: After first assistant message in a new session
- Store: Update `SessionRecord.title`
- Fallback: `"{PresetType} · {ContextMode}"` until generated

#### 1.4 Message count tracking

Increment `message_count` and update `last_message_preview` on each user message through the chat endpoint. Touch `updated_at`.

Hook location: `post-handler.ts` already passes `session_id` to the backend — the gateway can intercept and update the session record.

---

### Phase 2 — Frontend session list and switching

**Goal**: Users see their open sessions and can switch between them.

#### 2.1 Session list API integration

New module: `frontend/src/app/lib/session-api.ts`

```typescript
export async function fetchSessions(status?: 'open' | 'ended'): Promise<SessionRecord[]>
export async function fetchSession(sessionId: string): Promise<SessionRecord>
export async function endSession(sessionId: string): Promise<void>
export async function updateSessionTitle(sessionId: string, title: string): Promise<void>
```

#### 2.2 Upgrade session store for multi-session

Current `useSessionStore` holds a single session. Extend it:

```typescript
interface SessionState {
  // Current active session (the one being displayed)
  activeSessionId: string | null;
  
  // All open sessions
  openSessions: SessionRecord[];
  
  // Actions
  switchToSession: (sessionId: string) => Promise<void>;
  createNewSession: (opts: CreateSessionOpts) => Promise<SessionRecord>;
  endSession: (sessionId: string) => Promise<void>;
  refreshOpenSessions: () => Promise<void>;
}
```

#### 2.3 Session switching flow

When a user switches sessions:

1. **Pause current**: Save current scroll position, draft text, voice state.
2. **Clear UI state**: Reset `useChatStore` messages, `useMessageMetadataStore`, builder state.
3. **Load target**: Use the target session's `thread_id` to resume the LangGraph thread.
4. **Restore messages**: Fetch message history from the LangGraph thread state or from a local cache.
5. **Resume voice** (if applicable): Reconnect to voice with the target thread_id.

Critical question: **Where do messages live during a session switch?**

- LangGraph checkpointer stores the thread state including messages.
- The backend can expose `GET /threads/{thread_id}/state` to retrieve past messages.
- Frontend caches messages in memory during the active session, but does not need to persist them for resumption — the backend is the source of truth.

#### 2.4 Redesign sidebar

The current `DashboardSidebar` has left (session history) and right (conversations) panels. Merge into a single unified sidebar:

```
┌──────────────────────────┐
│ + New Session             │
│                           │
│ OPEN SESSIONS             │
│ ┌───────────────────────┐ │
│ │ 🟢 Debrief · Work     │ │ ← active (highlighted)
│ │   "We were talking..." │ │
│ │   5 min ago            │ │
│ ├───────────────────────┤ │
│ │ 💬 Chat · Life        │ │ ← open, not active
│ │   "The investor pi..." │ │
│ │   2h ago               │ │
│ └───────────────────────┘ │
│                           │
│ RECENT (ended)            │
│ ┌───────────────────────┐ │
│ │ ✓ Vent · Gaming       │ │
│ │   Yesterday            │ │
│ └───────────────────────┘ │
└──────────────────────────┘
```

Key behaviors:
- Clicking an open session switches to it (session route or chat route depending on mode).
- Clicking an ended session opens the recap view.
- The "New Session" button opens the session/chat creation flow.
- Open sessions show a green indicator.
- The currently active session is highlighted.

#### 2.5 URL routing (optional for v1)

Two options:

**Option A — No URL change (simpler, recommended for v1)**
- Session switching happens in-place on `/session` or `/chat`.
- The session ID is tracked in the store, not the URL.
- Pro: No routing changes. Simpler. Works with current architecture.
- Con: Can't deep-link to a specific session. Browser back doesn't work per-session.

**Option B — URL-based routing**
- Routes: `/session/{sessionId}`, `/chat/{conversationId}`
- Pro: Shareable, browser back works, proper history.
- Con: Requires dynamic routes, layout changes, more complex state.

**Recommendation**: Option A for v1. Add URL routing in v2 once the core switching works.

---

### Phase 3 — Session continuity and resumption

**Goal**: Switching back to an open session feels seamless.

#### 3.1 Message restoration from backend

New endpoint or use existing LangGraph API:

```
GET /api/v1/sessions/{session_id}/messages
  → returns thread messages in display order
```

Implementation: Read from LangGraph thread state, format for frontend consumption.

This provides the source of truth for session resumption. When a user switches to an open session, the frontend fetches this endpoint and populates the chat/message state.

#### 3.2 Smart opener on resume

When a user returns to an open session after being away:

- If < 5 minutes: No opener, just resume.
- If 5–60 minutes: Brief transition: "Welcome back. We were discussing {topic}."
- If > 60 minutes: Standard smart opener from the offline pipeline (if available).

The resume opener is generated by the backend when the frontend sends the first message after a gap.

#### 3.3 Voice session resume

When switching to an open session that was in voice mode:

1. Disconnect current voice connection (if any).
2. Connect to voice with the target session's `thread_id`.
3. The voice pipeline resumes with the correct thread context.

The existing voice connect/disconnect flow already supports thread_id — the change is making the switch seamless.

#### 3.4 Draft and scroll state preservation

Per-session local state to preserve on switch:

```typescript
interface SessionLocalState {
  sessionId: string;
  scrollPosition: number;
  draftText: string;
  draftAttachments: string[];
  lastViewedAt: number;
}
```

Store in memory (Map keyed by sessionId). No persistence needed — this is convenience, not critical state.

---

### Phase 4 — Polish and edge cases

#### 4.1 Session auto-title

After 2-3 turns, auto-generate a title if one doesn't exist. Use the first user message or a Haiku-generated summary.

Display in sidebar and in the session header.

#### 4.2 Session limits

- Max open sessions per user: 10 (configurable).
- When limit reached: Prompt to end the oldest open session or auto-end sessions idle > 24h.
- Sessions idle > 24h: Auto-end via a periodic backend task (extend inactivity_watcher).

#### 4.3 Session indicators in UI

- Badge on sidebar icon showing count of open sessions.
- Notification when a background session receives a builder completion.
- "X open sessions" indicator somewhere visible.

#### 4.4 Keyboard shortcuts

- `Ctrl/Cmd + N`: New session.
- `Ctrl/Cmd + [1-9]`: Switch to session by position.
- `Ctrl/Cmd + W`: End current session.

---

## Files to create or modify

### Backend — new files

| File | Purpose |
|---|---|
| `backend/packages/harness/deerflow/sophia/session_store.py` | SessionRecord model + file-based CRUD |

### Backend — modify

| File | Change |
|---|---|
| `backend/app/gateway/routers/sessions.py` | Replace stubs with real implementation using SessionStore |
| `backend/app/gateway/inactivity_watcher.py` | Update session record on inactivity timeout (mark ended) |

### Frontend — new files

| File | Purpose |
|---|---|
| `frontend/src/app/lib/session-api.ts` | API client for session CRUD endpoints |

### Frontend — modify

| File | Change |
|---|---|
| `frontend/src/app/stores/session-store.ts` | Extend for multi-session: `openSessions[]`, `activeSessionId`, `switchToSession()` |
| `frontend/src/app/stores/session-history-store.ts` | Merge with or deprecate in favor of unified session list from backend |
| `frontend/src/app/components/dashboard/DashboardSidebar.tsx` | Redesign to show open + ended sessions in one panel |
| `frontend/src/app/session/page.tsx` | Support session switching without full page reload |
| `frontend/src/app/chat/page.tsx` | Align with session switching if chat route gets multi-session too |
| `frontend/src/app/session/useSessionRouteExperience.ts` | Handle session switch lifecycle (cleanup, load, restore) |
| `frontend/src/app/stores/conversation-store.ts` | Potentially merge with session store or keep as chat-only |

---

## Risks and decisions needed

| Risk | Mitigation |
|---|---|
| Message restoration latency on switch | Show skeleton/loading state. Cache recent messages in memory. |
| Voice reconnect delay on switch | Show "Reconnecting..." state. Keep it under 2s. |
| localStorage bloat from multiple sessions | Backend is source of truth. Frontend only caches active session messages. |
| Conflict between session-store and conversation-store | Decide: merge into one store? Keep separate for session vs chat routes? |
| Session title generation cost | Batch with first assistant response. Use Haiku (cheap). |
| Offline pipeline double-fires on switch | Inactivity watcher should track "paused" vs "abandoned". Only fire offline pipeline on true end or 24h timeout. |

## Decision needed before starting

**Unify session and chat routes or keep them separate?**

Currently:
- `/session` = ritual/voice sessions (session-store)
- `/chat` = free text conversations (conversation-store)

Options:
1. **Unify**: Every conversation is a "session" with optional voice. One store, one sidebar, one data model.
2. **Keep separate**: Multi-session only for `/session` route. Chat route keeps its own conversation model.
3. **Session wraps chat**: Sessions become the container. Chat-route conversations become sessions too, just with `preset_type: "chat"`.

**Recommendation**: Option 3. Sessions wrap everything. A chat is just a session with `preset_type: "chat"` and no ritual. This gives us one unified model without losing the ritual-specific features.

**Decision (April 15, 2026)**: Unified model adopted. All conversations are sessions.

**Decision (2026-04-15): UNIFIED.** Sessions wrap everything. Chat route conversations become sessions with `preset_type: "chat"`. One store, one sidebar, one backend model.

---

## Implementation order

```
Phase 1.1  SessionStore (backend)
Phase 1.2  Upgrade /sessions endpoints
Phase 1.3  Title generation hook
Phase 1.4  Message count tracking
Phase 2.1  Session API client (frontend)
Phase 2.2  Multi-session store
Phase 2.3  Session switching flow
Phase 2.4  Sidebar redesign
Phase 3.1  Message restoration
Phase 3.2  Smart opener on resume
Phase 3.3  Voice session resume
Phase 3.4  Draft preservation
Phase 4.1  Auto-title
Phase 4.2  Session limits
Phase 4.3  Indicators
Phase 4.4  Keyboard shortcuts
```

Phases 1 and 2 are the core MVP. Phases 3 and 4 are quality and polish.
