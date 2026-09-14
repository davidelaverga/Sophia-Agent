/**
 * Connectivity Store
 * Sprint 1+ - Offline Resilience
 * 
 * Tracks backend connectivity status and manages:
 * - Online/offline state
 * - Message queue for offline messages
 * - Retry logic
 * 
 * Enables graceful degradation when backend is unavailable.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { sourceSendIntentSchema, type SourceSendIntent } from '../lib/memory-source-client';

// ============================================================================
// TYPES
// ============================================================================

export type ConnectivityStatus = 'online' | 'offline' | 'checking' | 'degraded';

interface QueuedMessage {
  id: string;
  content: string;
  sessionId: string;
  timestamp: string;
  retryCount: number;
  sourceIntent?: SourceSendIntent;
  delivery?: 'queued' | 'manual';
}

interface QueuedMemoryApproval {
  id: string;
  memoryText: string;
  sessionId: string;
  category?: string;
  timestamp: string;
  retryCount: number;
}

interface ConnectivityState {
  // Status
  status: ConnectivityStatus;
  lastChecked: string | null;
  lastOnline: string | null;
  
  // Message queue (for offline resilience)
  messageQueue: QueuedMessage[];
  memoryApprovalQueue: QueuedMemoryApproval[];
  
  // Stats
  failedAttempts: number;
  
  // Actions
  setOnline: () => void;
  setOffline: () => void;
  setChecking: () => void;
  setDegraded: () => void;
  
  // Queue management
  queueMessage: (content: string, sessionId: string, sourceIntent?: SourceSendIntent) => string;
  rememberSourceIntent: (intent: SourceSendIntent) => void;
  findSourceIntent: (owner: string, session: string, thread: string, messageId: string, content: string) => SourceSendIntent;
  removeFromQueue: (messageId: string) => void;
  clearQueue: () => void;
  getQueuedMessages: (sessionId: string) => QueuedMessage[];
  incrementRetry: (messageId: string) => void;

  // Memory approvals queue (for offline resilience)
  queueMemoryApproval: (memoryText: string, sessionId: string, category?: string) => string;
  removeMemoryApprovalFromQueue: (approvalId: string) => void;
  getQueuedMemoryApprovals: (sessionId: string) => QueuedMemoryApproval[];
  incrementMemoryApprovalRetry: (approvalId: string) => void;
  
  // Health check
  recordFailure: () => void;
  recordSuccess: () => void;
  
  // Selectors
  isOnline: () => boolean;
  hasQueuedMessages: () => boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_QUEUE_SIZE = 50;
const MAX_RETRIES = 3;

// ============================================================================
// STORE
// ============================================================================

export const useConnectivityStore = create<ConnectivityState>()(
  persist(
    (set, get) => ({
      // Initial state - default to online to avoid false offline indicators
      status: 'online',
      lastChecked: null,
      lastOnline: null,
      messageQueue: [],
      memoryApprovalQueue: [],
      failedAttempts: 0,
      // Status setters
      setOnline: () => set({
        status: 'online',
        lastChecked: new Date().toISOString(),
        lastOnline: new Date().toISOString(),
        failedAttempts: 0,
      }),
      
      setOffline: () => set({
        status: 'offline',
        lastChecked: new Date().toISOString(),
      }),
      
      setChecking: () => set({
        status: 'checking',
      }),
      
      setDegraded: () => set({
        status: 'degraded',
        lastChecked: new Date().toISOString(),
      }),
      
      // Queue management
      rememberSourceIntent: (value) => {
        const intent = sourceSendIntentSchema.parse(value);
        const existing = get().messageQueue.find(item => item.sourceIntent?.action.message_id === intent.action.message_id);
        if (existing) {
          if (JSON.stringify(existing.sourceIntent) !== JSON.stringify(intent)) throw new Error('memory_source_retry_conflict');
          return;
        }
        // Never evict the original identity of an uncertain governed action.
        if (get().messageQueue.length >= MAX_QUEUE_SIZE) throw new Error('memory_source_outbox_full');
        set(state => ({ messageQueue: [...state.messageQueue, { id: intent.action.message_id, content: intent.action.content,
          sessionId: intent.session_id, timestamp: new Date().toISOString(), retryCount: 0, sourceIntent: intent, delivery: 'manual' }] }));
      },
      findSourceIntent: (owner, session, thread, messageId, content) => {
        const matches = get().messageQueue.filter(item => item.sourceIntent?.action.message_id === messageId);
        if (matches.length !== 1) throw new Error('memory_source_retry_unavailable');
        const intent = sourceSendIntentSchema.parse(matches[0].sourceIntent);
        if (intent.owner_id !== owner || intent.session_id !== session || intent.action.thread_id !== thread || intent.action.content !== content) {
          throw new Error('memory_source_retry_unavailable');
        }
        return intent;
      },
      queueMessage: (content, sessionId, sourceIntent) => {
        const intent = sourceIntent ? sourceSendIntentSchema.parse(sourceIntent) : undefined;
        if (intent && (intent.session_id !== sessionId || intent.action.content !== content)) throw new Error('memory_source_queue_scope_invalid');
        if (intent) {
          get().rememberSourceIntent(intent);
          set(state => ({ messageQueue: state.messageQueue.map(item => item.sourceIntent?.action.message_id === intent.action.message_id
            ? { ...item, delivery: 'queued' } : item) }));
          return intent.action.message_id;
        }
        if (get().messageQueue.length >= MAX_QUEUE_SIZE && get().messageQueue.some(item => item.sourceIntent)) throw new Error('memory_source_outbox_full');
        const id = `queued_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const message: QueuedMessage = {
          id,
          content,
          sessionId,
          timestamp: new Date().toISOString(),
          retryCount: 0,
          ...(intent ? { sourceIntent: intent } : {}),
        };
        
        set(state => ({
          messageQueue: [...state.messageQueue, message].slice(-MAX_QUEUE_SIZE),
        }));
        
        return id;
      },
      
      removeFromQueue: (messageId) => set(state => ({
        // Leaving automatic delivery is not proof that a model run completed.
        // Keep exact original identity for explicit retry; clearQueue owns erase.
        messageQueue: state.messageQueue.flatMap(m => m.id !== messageId ? [m] : m.sourceIntent ? [{ ...m, delivery: 'manual' as const }] : []),
      })),
      
      clearQueue: () => set({ messageQueue: [] }),
      
      getQueuedMessages: (sessionId) => {
        return get().messageQueue.filter(m => m.sessionId === sessionId && m.delivery !== 'manual');
      },
      
      incrementRetry: (messageId) => set(state => ({
        messageQueue: state.messageQueue.map(m => 
          m.id === messageId 
            ? { ...m, retryCount: m.retryCount + 1, ...(m.sourceIntent && m.retryCount >= MAX_RETRIES ? { delivery: 'manual' as const } : {}) }
            : m
        ).filter(m => m.sourceIntent || m.retryCount <= MAX_RETRIES),
      })),

      queueMemoryApproval: (memoryText, sessionId, category) => {
        const id = `memq_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const item: QueuedMemoryApproval = {
          id,
          memoryText,
          sessionId,
          category,
          timestamp: new Date().toISOString(),
          retryCount: 0,
        };

        set(state => ({
          memoryApprovalQueue: [...state.memoryApprovalQueue, item].slice(-MAX_QUEUE_SIZE),
        }));

        return id;
      },

      removeMemoryApprovalFromQueue: (approvalId) => set(state => ({
        memoryApprovalQueue: state.memoryApprovalQueue.filter(item => item.id !== approvalId),
      })),

      getQueuedMemoryApprovals: (sessionId) => {
        return get().memoryApprovalQueue.filter(item => item.sessionId === sessionId);
      },

      incrementMemoryApprovalRetry: (approvalId) => set(state => ({
        memoryApprovalQueue: state.memoryApprovalQueue.map(item =>
          item.id === approvalId
            ? { ...item, retryCount: item.retryCount + 1 }
            : item
        ).filter(item => item.retryCount <= MAX_RETRIES),
      })),
      
      // Health tracking
      recordFailure: () => set(state => {
        const newFailures = state.failedAttempts + 1;
        return {
          failedAttempts: newFailures,
          status: newFailures >= 3 ? 'offline' : 'degraded',
          lastChecked: new Date().toISOString(),
        };
      }),
      
      recordSuccess: () => set({
        status: 'online',
        failedAttempts: 0,
        lastChecked: new Date().toISOString(),
        lastOnline: new Date().toISOString(),
      }),
      
      // Selectors
      isOnline: () => get().status === 'online',
      hasQueuedMessages: () => get().messageQueue.some(m => m.delivery !== 'manual'),
    }),
    {
      name: 'sophia-connectivity',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        messageQueue: state.messageQueue,
        memoryApprovalQueue: state.memoryApprovalQueue,
        lastOnline: state.lastOnline,
      }),
    }
  )
);

// ============================================================================
// SELECTORS
// ============================================================================

export const selectIsOnline = (state: ConnectivityState) => state.status === 'online';
export const selectStatus = (state: ConnectivityState) => state.status;
export const selectQueueCount = (state: ConnectivityState) => state.messageQueue.filter(m => m.delivery !== 'manual').length;
export const selectHasQueue = (state: ConnectivityState) => state.messageQueue.some(m => m.delivery !== 'manual');
