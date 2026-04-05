/**
 * useOfflineQueue Hook
 * Sprint 1+ - Offline Resilience
 * 
 * Manages message queuing during offline/online transitions:
 * - Queues messages when backend is unavailable
 * - Automatically sends queued messages when connection restores
 * - Provides feedback UI for queued state
 * - Handles retry logic with exponential backoff
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useConnectivityStore, selectStatus, selectIsOnline } from '../stores/connectivity-store';
import { useUiStore as useUiToastStore } from '../stores/ui-store';
import { logger } from '../lib/error-logger';

// ============================================================================
// TYPES
// ============================================================================

export interface QueuedMessage {
  id: string;
  content: string;
  sessionId: string;
  timestamp: string;
  retryCount: number;
}

export interface UseOfflineQueueOptions {
  /** Session ID to filter messages */
  sessionId: string;
  /** Callback when a queued message is being sent */
  onSendMessage: (content: string) => Promise<void>;
  /** Max retries before giving up */
  maxRetries?: number;
  /** Base delay for retry (ms) */
  retryDelayMs?: number;
}

export interface UseOfflineQueueReturn {
  /** Queue a message for later sending */
  queueMessage: (content: string) => void;
  /** Get number of queued messages */
  queuedCount: number;
  /** Whether we're currently processing the queue */
  isProcessingQueue: boolean;
  /** Whether currently offline */
  isOffline: boolean;
  /** Manually trigger queue processing */
  processQueue: () => Promise<void>;
  /** Clear all queued messages for this session */
  clearQueue: () => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useOfflineQueue(options: UseOfflineQueueOptions): UseOfflineQueueReturn {
  const { 
    sessionId, 
    onSendMessage, 
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;
  
  // Store access
  const connectivityStatus = useConnectivityStore(selectStatus);
  const isOnline = useConnectivityStore(selectIsOnline);
  const queueMessage = useConnectivityStore((state) => state.queueMessage);
  const removeFromQueue = useConnectivityStore((state) => state.removeFromQueue);
  const getQueuedMessages = useConnectivityStore((state) => state.getQueuedMessages);
  const incrementRetry = useConnectivityStore((state) => state.incrementRetry);
  const _clearQueueStore = useConnectivityStore((state) => state.clearQueue);
  const showToast = useUiToastStore((state) => state.showToast);
  
  // Processing state
  const isProcessingRef = useRef(false);
  const processTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Derived state
  const queuedMessages = getQueuedMessages(sessionId);
  const queuedCount = queuedMessages.length;
  const isOffline = connectivityStatus === 'offline' || connectivityStatus === 'degraded';
  
  /**
   * Add a message to the offline queue
   */
  const handleQueueMessage = useCallback((content: string) => {
    const id = queueMessage(content, sessionId);
    
    logger.debug('OfflineQueue', 'Message queued', { id, sessionId });
    
    // Show toast notification
    showToast({
      message: 'Message saved. Will send when back online.',
      variant: 'info',
      durationMs: 3000,
    });
    
    return id;
  }, [queueMessage, sessionId, showToast]);
  
  /**
   * Process all queued messages for this session
   */
  const processQueue = useCallback(async () => {
    if (isProcessingRef.current) {
      logger.debug('OfflineQueue', 'Already processing queue, skipping');
      return;
    }
    
    const messages = getQueuedMessages(sessionId);
    if (messages.length === 0) {
      return;
    }
    
    isProcessingRef.current = true;
    logger.debug('OfflineQueue', 'Processing queue', { count: messages.length });
    
    let successCount = 0;
    let failCount = 0;
    
    for (const msg of messages) {
      // Check if we're still online before each message
      if (!useConnectivityStore.getState().isOnline()) {
        logger.debug('OfflineQueue', 'Connection lost during processing, stopping');
        break;
      }
      
      // Check retry count
      if (msg.retryCount >= maxRetries) {
        logger.debug('OfflineQueue', 'Max retries reached, removing message', { id: msg.id });
        removeFromQueue(msg.id);
        failCount++;
        continue;
      }
      
      try {
        await onSendMessage(msg.content);
        removeFromQueue(msg.id);
        successCount++;
        logger.debug('OfflineQueue', 'Message sent successfully', { id: msg.id });
      } catch (error) {
        logger.debug('OfflineQueue', 'Failed to send message', { id: msg.id, error });
        incrementRetry(msg.id);
        failCount++;
        
        // Exponential backoff before next attempt
        const delay = retryDelayMs * Math.pow(2, msg.retryCount);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    isProcessingRef.current = false;
    
    // Show summary toast
    if (successCount > 0) {
      showToast({
        message: `${successCount} queued message${successCount > 1 ? 's' : ''} sent`,
        variant: 'success',
        durationMs: 3000,
      });
    }
    
    if (failCount > 0 && successCount === 0) {
      showToast({
        message: `Failed to send ${failCount} message${failCount > 1 ? 's' : ''}`,
        variant: 'error',
        durationMs: 4000,
      });
    }
  }, [sessionId, getQueuedMessages, onSendMessage, removeFromQueue, incrementRetry, maxRetries, retryDelayMs, showToast]);
  
  /**
   * Clear all queued messages for this session
   */
  const handleClearQueue = useCallback(() => {
    const messages = getQueuedMessages(sessionId);
    messages.forEach(msg => removeFromQueue(msg.id));
    logger.debug('OfflineQueue', 'Queue cleared', { sessionId });
  }, [sessionId, getQueuedMessages, removeFromQueue]);
  
  /**
   * Auto-process queue when coming back online
   */
  useEffect(() => {
    // Process queue when status changes to online and we have queued messages
    if (isOnline && queuedCount > 0) {
      // Small delay to ensure connection is stable
      processTimeoutRef.current = setTimeout(() => {
        processQueue();
      }, 1000);
    }
    
    return () => {
      if (processTimeoutRef.current) {
        clearTimeout(processTimeoutRef.current);
      }
    };
  }, [isOnline, queuedCount, processQueue]);
  
  return {
    queueMessage: handleQueueMessage,
    queuedCount,
    isProcessingQueue: isProcessingRef.current,
    isOffline,
    processQueue,
    clearQueue: handleClearQueue,
  };
}

export default useOfflineQueue;
