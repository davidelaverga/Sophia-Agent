# Session History Restoration Investigation
**Date:** April 23, 2026  
**Status:** Erratic/Flaky - Multiple Race Conditions Identified

---

## Executive Summary

Session history restoration is **inconsistent** due to **multiple critical race conditions** between:
1. **Zustand store hydration** (synchronous)
2. **Session page component mounting** (synchronous) 
3. **Message API loading** (async, fire-and-forget)
4. **Chat initialization** (useEffect-based, dependency-dependent)

The system has **no await guarantees** when switching to a session - messages load asynchronously while the UI renders immediately with just the greeting.

---

## Root Cause: The Critical Race

### Current Flow (Broken)

```
User clicks "Open Session" from dashboard
          ↓
DashboardSidebar calls: restoreOpenSession(sessionInfo, userId)
          ↓
session-store.restoreOpenSession():
  ├─ set({ session: restored }) ← SYNCHRONOUS, IMMEDIATE
  │
  └─ try {
       await useChatStore.getState().loadSession(sessionId, userId)
       ↑ ASYNC, fire-and-forget, errors silently caught
     } catch { logger.warn(...) }
          ↓
Zustand store updates trigger re-render of SessionPage
          ↓
useSessionPageContext reads from store:
  ├─ session = restored ✓
  └─ storedMessages = session.messages ← EMPTY AT THIS POINT
          ↓
useSessionChatInitialization runs useEffect():
  ├─ if (storedMessages.length > 0) → NO, messages not here yet
  │     return; // SKIPS to next branch
  │
  └─ → Shows ONLY initialGreeting (welcome message)
          ↓
~200-2000ms later, messages finally load from API:
  └─ loadSession() completes:
       ├─ getSessionMessages(sessionId, userId) → Success
       └─ updateMessages(sessionMessages) ← Too late, chat already rendered
```

**The problem:** `loadSession()` is **not awaited** by the page, so the page renders before messages arrive.

---

## Detailed Analysis

### 1. Message Loading Call Sites

#### A. **session-store.ts:359** — `restoreOpenSession()`
**File:** [frontend/src/app/stores/session-store.ts](frontend/src/app/stores/session-store.ts#L359)

```typescript
restoreOpenSession: async (sessionInfo, userId) => {
  // ... session status validation ...
  
  set((state) => {
    // ✓ Set session synchronously
    return {
      session: restored,
      openSessions: upsertSessions(state.openSessions),
      recentSessions: upsertSessions(state.recentSessions),
      error: null,
    };
  });

  // ❌ CRITICAL: Messages loaded asynchronously, not awaited
  try {
    const { useChatStore } = await import('./chat-store');
    await useChatStore.getState().loadSession(resolvedSessionInfo.session_id, resolvedUserId);
    // ^^^ This Promise is NOT awaited by the caller
  } catch {
    logger.warn('SessionStore: Failed to restore messages for resumed session', {
      sessionId: resolvedSessionInfo.session_id,
    });
    // ^^^ Errors silently logged, caller doesn't know
  }
},
```

**Problem:**
- Session state updated **synchronously** (triggers re-render)
- Message loading is **async** and **not awaited** by caller
- No error propagation to caller
- Page can render between `set()` and `await loadSession()`

---

#### B. **session-store.ts:441** — `viewEndedSession()`
**File:** [frontend/src/app/stores/session-store.ts](frontend/src/app/stores/session-store.ts#L441)

```typescript
viewEndedSession: (sessionId, presetType, contextMode) => {
  // ... set session synchronously ...
  
  set({ session: restored, error: null });

  // ❌ Same issue: fire-and-forget async loading
  import('./chat-store')
    .then(({ useChatStore }) =>
      useChatStore.getState().loadSession(sessionId, session?.userId),
    )
    .catch(() => {
      logger.warn('SessionStore: Failed to load ended session messages', { sessionId });
    });
},
```

**Problem:** Messages load in background, no coordination with render cycle.

---

#### C. **chat-store.ts:330** — `loadSession()`
**File:** [frontend/src/app/stores/chat-store.ts](frontend/src/app/stores/chat-store.ts#L330)

```typescript
loadSession: async (sessionId: string, userId?: string) => {
  set({ isLoadingHistory: true, lastError: undefined })
  try {
    const { getSessionMessages } = await import("../lib/api/sessions-api")
    const result = await getSessionMessages(sessionId, userId)
    
    // ❌ CRITICAL: No validation of empty messages
    if (!result.success) {
      set({ isLoadingHistory: false, lastError: "error" in result ? result.error : "Unknown error" })
      return false
    }
    
    const restored: ChatMessage[] = result.data.messages.map((m) => ({
      id: m.id || createMessageId(),
      role: m.role === "user" ? "user" : "sophia",
      content: m.content,
      createdAt: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
      status: "complete" as const,
      source: "text" as const,
    }))
    
    // ❌ Updates chat-store (not session-store messages)
    set({
      messages: restored,
      conversationId: sessionId,
      isLoadingHistory: false,
      lastError: undefined,
    })

    // ✓ Also updates session-store
    const { useSessionStore } = await import("./session-store")
    const sessionMessages = result.data.messages.map((message) => ({
      id: message.id || createMessageId(),
      role: message.role === "user" ? "user" as const : "assistant" as const,
      content: message.content,
      createdAt: message.created_at || new Date().toISOString(),
    }))

    useSessionStore.getState().updateMessages(sessionMessages)
    useSessionStore.getState().updateSession({
      threadId: result.data.thread_id,
      ...(userId ? { userId } : {}),
    })

    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load session"
    set({ isLoadingHistory: false, lastError: msg })
    return false
  }
},
```

**Problems:**
- Loads to both chat-store AND session-store
- No return value validation — caller doesn't check if load succeeded
- Silent failures caught but not propagated
- If API fails, messages are never loaded
- No retry mechanism

---

### 2. Message Rendering: `useSessionChatInitialization.ts`
**File:** [frontend/src/app/session/useSessionChatInitialization.ts](frontend/src/app/session/useSessionChatInitialization.ts#L87)

```typescript
useEffect(() => {
  if (!session) return;

  // ✓ This branch should execute for restored sessions
  if (storedMessages && storedMessages.length > 0) {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      
      // Format and display messages
      setChatMessages(
        storedMessages.map((message) => ({
          id: message.id,
          role: message.role,
          parts: [{ type: 'text', text: message.content }],
        })),
      );
      
      setIsInitializingChat(false);
      return; // ← EXIT early, never reaches greeting code
    }
  }

  // ❌ PROBLEM: If storedMessages is empty, this runs instead
  if (initialGreetingSetRef.current) return;

  // Shows ONLY greeting message
  setChatMessages([
    {
      id: effectiveGreetingId,
      role: 'assistant',
      parts: [{ type: 'text', text: normalizedGreeting }],
    },
  ]);

  initialGreetingSetRef.current = true;
  setIsInitializingChat(false);
}, [
  session,
  storedMessages,  // ← Dependency on storedMessages
  initialGreeting,
  // ... more deps ...
]);
```

**Race Condition Timeline:**

| Time | Event | storedMessages | Chat Display |
|------|-------|-----------------|--------------|
| t=0  | Component mounts, first effect runs | `[]` (empty) | Shows greeting |
| t=0  | `restoreOpenSession()` called from dashboard | — | — |
| t=1  | `set({ session: restored })` in session-store | Still `[]` | **Still showing greeting** |
| t=2  | Component re-renders from session update | Still `[]` | **Still showing greeting** |
| t=100-500ms | `loadSession()` API call in-flight | `[]` | Greeting stuck on screen |
| t=500-2000ms | `getSessionMessages()` resolves | Still `[]` | Greeting still showing |
| t=2100ms | `updateMessages()` called by chat-store | Updated ✓ | **Too late** |
| t=2200ms | Effect runs again (dependency: storedMessages) | `[...messages]` | **FINALLY shows messages** |

**Worst case:** If `storedMessages` dependency doesn't trigger re-render, messages never display.

---

### 3. Boot-up Race: Zustand + useSessionPageContext
**File:** [frontend/src/app/session/useSessionPageContext.ts](frontend/src/app/session/useSessionPageContext.ts#L1)

```typescript
const session = useSessionStore(selectSession);
const storedMessages = useSessionStore(selectMessages);  // ← From store
```

**Problem:**
- Session selector reads from store
- Store hydration happens asynchronously (Zustand persist middleware)
- But `useSessionPageContext` runs synchronously on mount
- If store hasn't hydrated yet, `session` is `null`, messages don't load

---

### 4. Missing Awaits in Component Flow
**File:** [frontend/src/app/components/dashboard/DashboardSidebar.tsx](frontend/src/app/components/dashboard/DashboardSidebar.tsx#L257)

```typescript
const restoreOpenSession = useSessionStore((s) => s.restoreOpenSession);

// When user clicks session
void restoreOpenSession(s, resolvedUserId)
//   ↑ Not awaited, no error handling
```

**Problem:**
- `void` operator discards the Promise
- Any error in `loadSession()` is lost
- Caller has no way to know if messages loaded
- Router navigation happens immediately (in parallel page.tsx)

---

## 5. Specific Failure Modes

### Scenario A: Silent API Failure
1. `loadSession()` calls `getSessionMessages()`
2. API returns 404, 500, or timeout
3. Error caught in catch block → `set({ lastError: msg })`
4. But **useSessionPageContext reads from session.messages, not chat-store.lastError**
5. **Result:** User sees only greeting, doesn't know why

### Scenario B: Incomplete Dependency Array
If the effect's dependency array is wrong, it won't re-run when `storedMessages` updates.

```typescript
useEffect(() => {
  // ... chat initialization ...
}, [
  storedMessages,  // ✓ This MUST be included
  // ... other deps ...
]);
```

**Risk:** If this dependency is missing, second update to storedMessages won't re-render.

### Scenario C: Session Page Navigation Before Load
```
Timeline:
t=0  User clicks "Open Session" 
     → restoreOpenSession() called (async)
     → Navigation to /session?id=xxx (synchronous)
     
t=100ms  SessionPage mounts
         → useSessionPageContext reads store
         → storedMessages might still be empty
         → Shows greeting
         
t=500ms  loadSession() finally completes
         → updateMessages() called
         → But SessionPage already rendered
```

### Scenario D: Conversation History vs Session Messages
There are **two separate loading mechanisms:**

1. **chat-store.loadSession()** → loads to chat-store
2. **conversation-loader.ts** → loads to both stores

**Risk:** If page uses `conversation-loader` but messages come from `loadSession()`, they might not sync properly.

---

## 6. Current Error Handling
**File:** [frontend/src/app/stores/session-store.ts](frontend/src/app/stores/session-store.ts#L412)

```typescript
try {
  const { useChatStore } = await import('./chat-store');
  await useChatStore.getState().loadSession(resolvedSessionInfo.session_id, resolvedUserId);
} catch {
  logger.warn('SessionStore: Failed to restore messages for resumed session', {  // ← Only logs warning
    sessionId: resolvedSessionInfo.session_id,
  });
  // No user notification
  // No retry
  // No fallback
}
```

**Problems:**
- Errors are **silent** (only console warning)
- No **user notification**
- No **automatic retry**
- No **fallback UI** (e.g., "Click to retry")

---

## 7. API Call Details
**File:** [frontend/src/app/lib/api/sessions-api.ts](frontend/src/app/lib/api/sessions-api.ts#L453)

```typescript
export async function getSessionMessages(
  sessionId: string,
  userId?: string
): Promise<ApiResponse<SessionMessagesResponse>> {
  const params = new URLSearchParams();
  if (typeof userId === 'string' && userId.trim()) {
    params.set('user_id', userId.trim());
  }

  return fetchWithAuth<SessionMessagesResponse>(
    `${SESSIONS_BASE}/${sessionId}/messages${params.size > 0 ? `?${params.toString()}` : ''}`,
    { method: 'GET' }
  );
}
```

**Risks:**
- 15s timeout (from fetchWithAuth default)
- No retry on 5xx errors
- Empty response returns `{ success: true, data: { messages: [] } }` — indistinguishable from loaded-but-empty

---

## 8. Store Message Update Logic
**File:** [frontend/src/app/stores/session-store.ts](frontend/src/app/stores/session-store.ts#L830)

```typescript
updateMessages: (messages) => {
  const { session } = get();
  if (!session) return;  // ← Silently ignores if session is null
  
  set({
    session: {
      ...session,
      messages,
      lastActivityAt: new Date().toISOString(),
    },
  });
},
```

**Problem:** If called before session is set, update is lost.

---

## 9. Bootstrap vs Stored Messages
**File:** [frontend/src/app/hooks/useSessionBootstrap.ts](frontend/src/app/hooks/useSessionBootstrap.ts#L1)

The system has **two sources of greeting:**
1. **Bootstrap greeting** (from session start API)
2. **Session greeting** (from session metadata)

**Risk:** Confusing state with conflicting greetings from different sources.

---

## Recommended Fixes

### Fix 1: Make loadSession() Awaited
**Priority: Critical**

```typescript
// In session-store.ts restoreOpenSession()
const loadSuccess = await useChatStore.getState().loadSession(
  resolvedSessionInfo.session_id, 
  resolvedUserId
);

if (!loadSuccess) {
  // Show error to user or retry
  logger.error('Failed to load session messages', { sessionId });
}

return { success: loadSuccess };  // Return from async function
```

Then in the caller:
```typescript
const result = await restoreOpenSession(sessionInfo, userId);
if (!result.success) {
  showErrorToast('Failed to load conversation history');
  // OR automatic retry
}
```

---

### Fix 2: Wait for Messages Before Rendering Chat
**Priority: Critical**

Add an `isLoadingMessages` state and block chat rendering:

```typescript
const storedMessages = useSessionStore(selectMessages);
const isLoadingHistory = useChatStore((state) => state.isLoadingHistory);

// In chat initialization:
useEffect(() => {
  if (isLoadingHistory) {
    // Show loading UI, don't render greeting yet
    setIsInitializingChat(true);
    return;
  }
  
  if (storedMessages.length > 0) {
    // Messages loaded, render them
    setChatMessages(...)
  } else {
    // No messages, show greeting
    setChatMessages([greeting])
  }
}, [storedMessages, isLoadingHistory]);
```

---

### Fix 3: Validate Non-Empty Message List
**Priority: High**

```typescript
const result = await getSessionMessages(sessionId, userId);
if (!result.success) return false;

const messages = result.data.messages || [];

// ✓ Check if actually got messages
if (messages.length === 0) {
  logger.warn('Session has no messages', { sessionId });
  // Don't treat as error, but DO know it's empty
  return true; // Still "success" but empty
}

const restored = messages.map(...)
set({ messages: restored })
```

---

### Fix 4: Add Error UI and Retry
**Priority: High**

```typescript
// In useSessionChatInitialization
if (chatError || lastError) {
  return (
    <div className="message-load-error">
      Failed to load conversation history
      <button onClick={() => retryLoadMessages()}>Retry</button>
    </div>
  );
}

if (isLoadingHistory) {
  return <LoadingPlaceholder />;
}

// Normal rendering
```

---

### Fix 5: Synchronize Both Stores
**Priority: Medium**

Clarify which store is source-of-truth:

```typescript
// Option A: Use session-store as primary
const storedMessages = useSessionStore(selectMessages);

// Option B: Use chat-store as primary (current, confusing)
const chatMessages = useChatStore((state) => state.messages);

// ❌ Don't read from both
```

**Recommendation:** Use `session-store.messages` as the canonical source.

---

### Fix 6: Add Request Deduplication
**Priority: Medium**

Prevent multiple concurrent `loadSession()` calls for same sessionId:

```typescript
const loadingSessionsRef = useRef<Set<string>>(new Set());

loadSession: async (sessionId, userId) => {
  if (loadingSessionsRef.current.has(sessionId)) {
    return true; // Already loading
  }
  
  loadingSessionsRef.current.add(sessionId);
  try {
    // ... load messages ...
  } finally {
    loadingSessionsRef.current.delete(sessionId);
  }
}
```

---

### Fix 7: Better Error Classification
**Priority: Medium**

```typescript
type LoadSessionError = 
  | 'NOT_FOUND'        // 404 — session doesn't exist
  | 'UNAUTHORIZED'     // 401/403 — permission denied
  | 'TIMEOUT'          // Request timed out
  | 'NETWORK'          // Connection error
  | 'PARSE'            // Invalid JSON response
  | 'UNKNOWN';

if (result.code === 'NOT_FOUND') {
  // Show "Session not found" — not a temporary error
}
if (result.code === 'NETWORK') {
  // Show "Check your connection" — temporary
}
```

---

## Test Cases Needed

1. **Happy path:** Open session with 10+ messages → All messages display ✓
2. **Slow network:** Simulate 1s+ latency → Messages eventually load ✓
3. **API failure:** 500 error on messages endpoint → Error shown to user ✓
4. **Empty session:** Session exists but has 0 messages → Shows only greeting ✓
5. **Concurrent loads:** Click 2 sessions in rapid succession → No race condition ✓
6. **Refresh during load:** Refresh page while messages loading → Graceful recovery ✓
7. **Offline mode:** No network → Friendly error message ✓
8. **Large session:** 500+ messages → Pagination/virtualization works ✓

---

## Known Documented Issues

From [SESSION_HISTORY_FLOW.md](SESSION_HISTORY_FLOW.md#L409):

> **Issue 2: Messages Don't Load (Chat Empty on Session Open)**  
> **Problem**: `loadSession()` fails silently, user sees empty message history.

This confirms the issue is already known in the codebase.

---

## Summary Table

| Component | Problem | Impact | Fix Priority |
|-----------|---------|--------|--------------|
| `restoreOpenSession()` | Messages load async, not awaited | Chat shows greeting while loading | Critical |
| `loadSession()` | Errors caught but not propagated | Silent failures | Critical |
| `useSessionChatInitialization` | Runs before messages available | Race condition | Critical |
| `useSessionPageContext` | Reads empty storedMessages initially | No messages displayed | Critical |
| Error handling | Only console warnings | User doesn't know about failure | High |
| API timeout | 15s with no retry | Timeout feels like forever | High |
| Store synchronization | Two sources of messages (chat + session) | Confusing state | Medium |
| Message deduplication | No request dedup | Duplicate loads possible | Medium |
| Bootstrap greeting | Separate from session greeting | Potential conflicts | Low |

---

## Next Steps

1. **Implement Fix 1 & 2** (make loading await and add loading UI)
2. **Add error toast** (Fix 4) to show message loading failures
3. **Add tests** for race condition scenarios
4. **Monitor** in production for silent failures using error logger
5. **Consider conversation-loader** as alternative if simpler than fixing both paths

