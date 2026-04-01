/**
 * Offline Sync Queue
 * Cola persistente para operaciones offline con retry exponencial
 */

import { logger } from './error-logger';

// ============================================================================
// Types
// ============================================================================

export type QueueItemStatus = 'pending' | 'processing' | 'failed' | 'completed';

export type QueueItemPriority = 'high' | 'normal' | 'low';

export interface QueueItem<T = unknown> {
  /** Unique identifier */
  id: string;
  /** Operation type for routing */
  type: string;
  /** Payload data */
  payload: T;
  /** Current status */
  status: QueueItemStatus;
  /** Priority level */
  priority: QueueItemPriority;
  /** Number of retry attempts */
  retryCount: number;
  /** Maximum retries allowed */
  maxRetries: number;
  /** Timestamp when created */
  createdAt: number;
  /** Timestamp of last attempt */
  lastAttemptAt: number | null;
  /** Next scheduled retry time */
  nextRetryAt: number | null;
  /** Error message from last failure */
  lastError: string | null;
  /** Metadata for tracking */
  metadata?: Record<string, unknown>;
}

export interface QueueConfig {
  /** Storage key for persistence */
  storageKey?: string;
  /** Maximum items in queue */
  maxQueueSize?: number;
  /** Default max retries per item */
  defaultMaxRetries?: number;
  /** Base delay for exponential backoff (ms) */
  baseRetryDelay?: number;
  /** Maximum delay between retries (ms) */
  maxRetryDelay?: number;
  /** Jitter factor (0-1) for randomizing delays */
  jitterFactor?: number;
  /** Auto-process when online */
  autoProcessOnOnline?: boolean;
  /** Process interval when online (ms) */
  processInterval?: number;
}

export type ProcessorFn<T = unknown> = (
  item: QueueItem<T>
) => Promise<{ success: boolean; error?: string }>;

// ============================================================================
// Offline Sync Queue Class
// ============================================================================

export class OfflineSyncQueue<T = unknown> {
  private queue: QueueItem<T>[] = [];
  private processors: Map<string, ProcessorFn<T>> = new Map();
  private isProcessing = false;
  private processIntervalId: ReturnType<typeof setInterval> | null = null;
  private config: Required<QueueConfig>;
  private listeners: Set<(queue: QueueItem<T>[]) => void> = new Set();

  constructor(config: QueueConfig = {}) {
    this.config = {
      storageKey: config.storageKey ?? 'sophia_offline_queue',
      maxQueueSize: config.maxQueueSize ?? 100,
      defaultMaxRetries: config.defaultMaxRetries ?? 5,
      baseRetryDelay: config.baseRetryDelay ?? 1000,
      maxRetryDelay: config.maxRetryDelay ?? 60000,
      jitterFactor: config.jitterFactor ?? 0.2,
      autoProcessOnOnline: config.autoProcessOnOnline ?? true,
      processInterval: config.processInterval ?? 5000,
    };

    this.loadFromStorage();
    this.setupOnlineListener();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Add an item to the queue
   */
  enqueue(
    type: string,
    payload: T,
    options: {
      priority?: QueueItemPriority;
      maxRetries?: number;
      metadata?: Record<string, unknown>;
    } = {}
  ): QueueItem<T> {
    // Check queue size limit
    if (this.queue.length >= this.config.maxQueueSize) {
      // Remove oldest low-priority completed/failed items
      this.pruneQueue();
    }

    const item: QueueItem<T> = {
      id: this.generateId(),
      type,
      payload,
      status: 'pending',
      priority: options.priority ?? 'normal',
      retryCount: 0,
      maxRetries: options.maxRetries ?? this.config.defaultMaxRetries,
      createdAt: Date.now(),
      lastAttemptAt: null,
      nextRetryAt: null,
      lastError: null,
      metadata: options.metadata,
    };

    // Insert based on priority
    const insertIndex = this.findInsertIndex(item.priority);
    this.queue.splice(insertIndex, 0, item);

    this.saveToStorage();
    this.notifyListeners();

    // Try to process immediately if online
    if (this.isOnline()) {
      this.processQueue();
    }

    return item;
  }

  /**
   * Register a processor for a specific operation type
   */
  registerProcessor(type: string, processor: ProcessorFn<T>): void {
    this.processors.set(type, processor);
  }

  /**
   * Remove a processor
   */
  unregisterProcessor(type: string): void {
    this.processors.delete(type);
  }

  /**
   * Get all items in queue
   */
  getQueue(): QueueItem<T>[] {
    return [...this.queue];
  }

  /**
   * Get items by status
   */
  getItemsByStatus(status: QueueItemStatus): QueueItem<T>[] {
    return this.queue.filter((item) => item.status === status);
  }

  /**
   * Get pending count
   */
  getPendingCount(): number {
    return this.queue.filter(
      (item) => item.status === 'pending' || item.status === 'processing'
    ).length;
  }

  /**
   * Remove an item from queue
   */
  remove(id: string): boolean {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index === -1) return false;

    this.queue.splice(index, 1);
    this.saveToStorage();
    this.notifyListeners();
    return true;
  }

  /**
   * Retry a failed item immediately
   */
  retry(id: string): boolean {
    const item = this.queue.find((item) => item.id === id);
    if (!item || item.status !== 'failed') return false;

    item.status = 'pending';
    item.nextRetryAt = null;
    this.saveToStorage();
    this.notifyListeners();

    if (this.isOnline()) {
      this.processQueue();
    }

    return true;
  }

  /**
   * Retry all failed items
   */
  retryAllFailed(): number {
    let count = 0;
    this.queue.forEach((item) => {
      if (item.status === 'failed') {
        item.status = 'pending';
        item.nextRetryAt = null;
        count++;
      }
    });

    if (count > 0) {
      this.saveToStorage();
      this.notifyListeners();
      if (this.isOnline()) {
        this.processQueue();
      }
    }

    return count;
  }

  /**
   * Clear completed items
   */
  clearCompleted(): number {
    const initialLength = this.queue.length;
    this.queue = this.queue.filter((item) => item.status !== 'completed');
    const removed = initialLength - this.queue.length;

    if (removed > 0) {
      this.saveToStorage();
      this.notifyListeners();
    }

    return removed;
  }

  /**
   * Clear all items
   */
  clearAll(): void {
    this.queue = [];
    this.saveToStorage();
    this.notifyListeners();
  }

  /**
   * Subscribe to queue changes
   */
  subscribe(listener: (queue: QueueItem<T>[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start automatic processing
   */
  startAutoProcess(): void {
    if (this.processIntervalId) return;

    this.processIntervalId = setInterval(() => {
      if (this.isOnline()) {
        this.processQueue();
      }
    }, this.config.processInterval);
  }

  /**
   * Stop automatic processing
   */
  stopAutoProcess(): void {
    if (this.processIntervalId) {
      clearInterval(this.processIntervalId);
      this.processIntervalId = null;
    }
  }

  /**
   * Process queue manually
   */
  async processQueue(): Promise<void> {
    if (this.isProcessing || !this.isOnline()) return;

    this.isProcessing = true;

    try {
      const now = Date.now();
      const itemsToProcess = this.queue.filter(
        (item) =>
          item.status === 'pending' ||
          (item.status === 'failed' &&
            item.nextRetryAt !== null &&
            item.nextRetryAt <= now)
      );

      for (const item of itemsToProcess) {
        await this.processItem(item);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Check if currently online
   */
  isOnline(): boolean {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stopAutoProcess();
    this.listeners.clear();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async processItem(item: QueueItem<T>): Promise<void> {
    const processor = this.processors.get(item.type);
    if (!processor) {
      logger.warn(`No processor registered for type: ${item.type}`, {
        component: 'OfflineQueue',
        action: 'process_item',
      });
      return;
    }

    item.status = 'processing';
    item.lastAttemptAt = Date.now();
    this.notifyListeners();

    try {
      const result = await processor(item);

      if (result.success) {
        item.status = 'completed';
        item.lastError = null;
      } else {
        this.handleItemFailure(item, result.error || 'Unknown error');
      }
    } catch (error) {
      this.handleItemFailure(
        item,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }

    this.saveToStorage();
    this.notifyListeners();
  }

  private handleItemFailure(item: QueueItem<T>, error: string): void {
    item.retryCount++;
    item.lastError = error;

    if (item.retryCount >= item.maxRetries) {
      item.status = 'failed';
      item.nextRetryAt = null;
    } else {
      item.status = 'failed';
      item.nextRetryAt = this.calculateNextRetry(item.retryCount);
    }
  }

  private calculateNextRetry(retryCount: number): number {
    // Exponential backoff: baseDelay * 2^retryCount
    const exponentialDelay =
      this.config.baseRetryDelay * Math.pow(2, retryCount);
    const clampedDelay = Math.min(exponentialDelay, this.config.maxRetryDelay);

    // Add jitter to prevent thundering herd
    const jitter =
      clampedDelay * this.config.jitterFactor * (Math.random() * 2 - 1);
    const finalDelay = Math.max(0, clampedDelay + jitter);

    return Date.now() + finalDelay;
  }

  private findInsertIndex(priority: QueueItemPriority): number {
    const priorityOrder: Record<QueueItemPriority, number> = {
      high: 0,
      normal: 1,
      low: 2,
    };

    const targetPriority = priorityOrder[priority];

    for (let i = 0; i < this.queue.length; i++) {
      const itemPriority = priorityOrder[this.queue[i].priority];
      if (itemPriority > targetPriority) {
        return i;
      }
    }

    return this.queue.length;
  }

  private pruneQueue(): void {
    // Remove oldest completed items first
    const completedItems = this.queue
      .filter((item) => item.status === 'completed')
      .sort((a, b) => a.createdAt - b.createdAt);

    if (completedItems.length > 0) {
      this.remove(completedItems[0].id);
      return;
    }

    // Then remove oldest failed low-priority items
    const failedLowPriority = this.queue
      .filter((item) => item.status === 'failed' && item.priority === 'low')
      .sort((a, b) => a.createdAt - b.createdAt);

    if (failedLowPriority.length > 0) {
      this.remove(failedLowPriority[0].id);
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const stored = localStorage.getItem(this.config.storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as QueueItem<T>[];
        // Reset processing items to pending (app may have crashed)
        this.queue = parsed.map((item) => ({
          ...item,
          status: item.status === 'processing' ? 'pending' : item.status,
        }));
      }
    } catch (error) {
      logger.logError(error, { component: 'OfflineQueue', action: 'load_from_storage' });
      this.queue = [];
    }
  }

  private saveToStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      localStorage.setItem(this.config.storageKey, JSON.stringify(this.queue));
    } catch (error) {
      logger.logError(error, { component: 'OfflineQueue', action: 'save_to_storage' });
    }
  }

  private notifyListeners(): void {
    const queueCopy = this.getQueue();
    this.listeners.forEach((listener) => listener(queueCopy));
  }

  private handleOnline = (): void => {
    if (this.config.autoProcessOnOnline) {
      this.processQueue();
    }
  };

  private setupOnlineListener(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', this.handleOnline);

    if (this.config.autoProcessOnOnline) {
      this.startAutoProcess();
    }
  }
}

// ============================================================================
// Pre-configured Sophia Queue
// ============================================================================

export interface SophiaQueuePayload {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Pre-configured queue for Sophia API operations
 */
export const sophiaOfflineQueue = new OfflineSyncQueue<SophiaQueuePayload>({
  storageKey: 'sophia_offline_queue',
  maxQueueSize: 50,
  defaultMaxRetries: 5,
  baseRetryDelay: 2000,
  maxRetryDelay: 120000, // 2 minutes max
  jitterFactor: 0.3,
  autoProcessOnOnline: true,
  processInterval: 10000,
});

// Register default API processor
sophiaOfflineQueue.registerProcessor('api', async (item) => {
  const { endpoint, method, body, headers } = item.payload;
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
});

// ============================================================================
// React Hook
// ============================================================================

/**
 * Hook to use offline queue in React components
 */
export function useOfflineQueue<T = SophiaQueuePayload>(
  queue: OfflineSyncQueue<T> = sophiaOfflineQueue as unknown as OfflineSyncQueue<T>
) {
  // This would typically use useState/useEffect, but we keep it simple
  // to avoid React dependency in the core module
  return {
    enqueue: queue.enqueue.bind(queue),
    getQueue: queue.getQueue.bind(queue),
    getPendingCount: queue.getPendingCount.bind(queue),
    retry: queue.retry.bind(queue),
    retryAllFailed: queue.retryAllFailed.bind(queue),
    remove: queue.remove.bind(queue),
    clearCompleted: queue.clearCompleted.bind(queue),
    clearAll: queue.clearAll.bind(queue),
    subscribe: queue.subscribe.bind(queue),
    processQueue: queue.processQueue.bind(queue),
    isOnline: queue.isOnline.bind(queue),
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Queue an API call that will be retried when offline
 */
export function queueApiCall(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    headers?: Record<string, string>;
    priority?: QueueItemPriority;
    maxRetries?: number;
  } = {}
): QueueItem<SophiaQueuePayload> {
  return sophiaOfflineQueue.enqueue(
    'api',
    {
      endpoint,
      method: options.method ?? 'POST',
      body: options.body,
      headers: options.headers,
    },
    {
      priority: options.priority,
      maxRetries: options.maxRetries,
    }
  );
}

/**
 * Queue feedback submission (commonly needed offline)
 */
export function queueFeedback(
  turnId: string,
  helpful: boolean,
  tag?: 'clarity' | 'empathy' | 'grounding' | 'confusing' | 'slow'
): QueueItem<SophiaQueuePayload> {
  // Use local proxy — auth handled server-side (httpOnly cookie)
  return queueApiCall('/api/conversation/feedback', {
    method: 'POST',
    body: { turn_id: turnId, helpful, ...(tag ? { tag } : {}) },
    priority: 'low',
    maxRetries: 3,
  });
}

/**
 * Queue reflection creation
 */
export function queueReflection(
  sessionId: string,
  content: string,
  mood?: string
): QueueItem<SophiaQueuePayload> {
  return queueApiCall('/api/reflections/create', {
    method: 'POST',
    body: { session_id: sessionId, content, mood },
    priority: 'normal',
    maxRetries: 5,
  });
}
