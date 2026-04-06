/**
 * Feedback Store
 * Sprint 1+ - Persist user feedback for learning loop
 * 
 * Stores feedback locally and queues for backend sync.
 * Uses offline queue for reliable delivery.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { logger } from '../lib/error-logger';
import { queueFeedback } from '../lib/offline-queue';
import type { FeedbackType, MessageFeedback } from '../types/sophia-ui-message';

// =============================================================================
// STORE INTERFACE
// =============================================================================

interface FeedbackState {
  // Feedback indexed by message_id
  feedbackByMessage: Record<string, FeedbackType>;
  
  // Queue of feedback to sync to backend
  pendingSync: MessageFeedback[];
  
  // Actions
  setFeedback: (messageId: string, feedback: FeedbackType) => void;
  getFeedback: (messageId: string) => FeedbackType | undefined;
  clearFeedback: (messageId: string) => void;
  
  // Sync actions
  markSynced: (messageIds: string[]) => void;
  getPendingSync: () => MessageFeedback[];
}

// =============================================================================
// STORE IMPLEMENTATION
// =============================================================================

export const useFeedbackStore = create<FeedbackState>()(
  persist(
    (set, get) => ({
      feedbackByMessage: {},
      pendingSync: [],
      
      setFeedback: (messageId, feedback) => {
        const feedbackEntry: MessageFeedback = {
          message_id: messageId,
          feedback_type: feedback,
          created_at: new Date().toISOString(),
        };
        
        set((state) => ({
          feedbackByMessage: {
            ...state.feedbackByMessage,
            [messageId]: feedback,
          },
          pendingSync: [
            ...state.pendingSync.filter(f => f.message_id !== messageId),
            feedbackEntry,
          ],
        }));
        
        // Queue for offline-resilient delivery
        const helpful = feedback === 'helpful';
        queueFeedback(messageId, helpful);
      },
      
      getFeedback: (messageId) => {
        return get().feedbackByMessage[messageId];
      },
      
      clearFeedback: (messageId) => {
        set((state) => {
          const nextFeedbackByMessage = { ...state.feedbackByMessage };
          delete nextFeedbackByMessage[messageId];
          return {
            feedbackByMessage: nextFeedbackByMessage,
            pendingSync: state.pendingSync.filter(f => f.message_id !== messageId),
          };
        });
      },
      
      markSynced: (messageIds) => {
        set((state) => ({
          pendingSync: state.pendingSync.filter(
            f => !messageIds.includes(f.message_id)
          ),
        }));
      },
      
      getPendingSync: () => {
        return get().pendingSync;
      },
    }),
    {
      name: 'sophia.feedback.v1',
      partialize: (state) => ({
        feedbackByMessage: state.feedbackByMessage,
        pendingSync: state.pendingSync,
      }),
    }
  )
);

// =============================================================================
// SYNC HELPER (call when backend is available)
// =============================================================================

export async function syncFeedbackToBackend(): Promise<{ synced: number; failed: number }> {
  const store = useFeedbackStore.getState();
  const pending = store.getPendingSync();
  
  if (pending.length === 0) {
    return { synced: 0, failed: 0 };
  }
  
  try {
    // TODO: Uncomment when backend endpoint is available
    // const response = await fetch('/api/v1/feedback/batch', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ feedback: pending }),
    // });
    // 
    // if (response.ok) {
    //   store.markSynced(pending.map(f => f.message_id));
    //   return { synced: pending.length, failed: 0 };
    // }
    
    // For now, just log
    logger.debug('Feedback', 'Would sync to backend', { itemCount: pending.length });
    return { synced: 0, failed: 0 };
  } catch (error) {
    logger.logError(error, { component: 'FeedbackStore', action: 'sync' });
    return { synced: 0, failed: pending.length };
  }
}

// =============================================================================
// SELECTORS
// =============================================================================

export const selectFeedback = (messageId: string) => 
  (state: FeedbackState) => state.feedbackByMessage[messageId];

export const selectPendingCount = (state: FeedbackState) => 
  state.pendingSync.length;
