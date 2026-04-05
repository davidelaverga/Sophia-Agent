/**
 * Tests for Offline Sync Queue
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OfflineSyncQueue,
  QueueItem,
  queueApiCall,
  queueFeedback,
  queueReflection,
} from '../../app/lib/offline-queue';

// Mock localStorage
const mockStorage: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => mockStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
  }),
};

Object.defineProperty(global, 'localStorage', { value: localStorageMock });

// Mock navigator.onLine
let mockOnline = true;
Object.defineProperty(navigator, 'onLine', {
  get: () => mockOnline,
  configurable: true,
});

describe('OfflineSyncQueue', () => {
  let queue: OfflineSyncQueue<{ data: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
    mockOnline = true;
    queue = new OfflineSyncQueue<{ data: string }>({
      storageKey: 'test_queue',
      maxQueueSize: 10,
      defaultMaxRetries: 3,
      baseRetryDelay: 100,
      maxRetryDelay: 1000,
      autoProcessOnOnline: false,
    });
  });

  afterEach(() => {
    queue.destroy();
  });

  // ==========================================================================
  // Enqueue
  // ==========================================================================
  describe('enqueue', () => {
    it('should add item to queue', () => {
      const item = queue.enqueue('test', { data: 'hello' });

      expect(item.id).toBeDefined();
      expect(item.type).toBe('test');
      expect(item.payload).toEqual({ data: 'hello' });
      expect(item.status).toBe('pending');
      expect(item.retryCount).toBe(0);
    });

    it('should set default priority to normal', () => {
      const item = queue.enqueue('test', { data: 'hello' });
      expect(item.priority).toBe('normal');
    });

    it('should respect custom priority', () => {
      const high = queue.enqueue('test', { data: '1' }, { priority: 'high' });
      const low = queue.enqueue('test', { data: '2' }, { priority: 'low' });

      expect(high.priority).toBe('high');
      expect(low.priority).toBe('low');
    });

    it('should order items by priority', () => {
      queue.enqueue('test', { data: 'normal1' }, { priority: 'normal' });
      queue.enqueue('test', { data: 'low' }, { priority: 'low' });
      queue.enqueue('test', { data: 'high' }, { priority: 'high' });
      queue.enqueue('test', { data: 'normal2' }, { priority: 'normal' });

      const items = queue.getQueue();
      expect(items[0].payload.data).toBe('high');
      expect(items[1].payload.data).toBe('normal1');
      expect(items[2].payload.data).toBe('normal2');
      expect(items[3].payload.data).toBe('low');
    });

    it('should persist to localStorage', () => {
      queue.enqueue('test', { data: 'hello' });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'test_queue',
        expect.any(String)
      );
    });

    it('should respect maxQueueSize by pruning completed items', async () => {
      const processor = vi.fn().mockResolvedValue({ success: true });
      queue.registerProcessor('test', processor);

      // Fill queue and complete some items
      for (let i = 0; i < 5; i++) {
        queue.enqueue('test', { data: `item${i}` });
      }
      await queue.processQueue(); // Mark as completed

      // Add more items
      for (let i = 5; i < 10; i++) {
        queue.enqueue('test', { data: `item${i}` });
      }

      expect(queue.getQueue().length).toBe(10);

      // Add one more - should prune a completed item
      queue.enqueue('test', { data: 'overflow' });
      expect(queue.getQueue().length).toBe(10);
    });

    it('should set custom maxRetries', () => {
      const item = queue.enqueue('test', { data: 'hello' }, { maxRetries: 10 });
      expect(item.maxRetries).toBe(10);
    });

    it('should include metadata', () => {
      const item = queue.enqueue(
        'test',
        { data: 'hello' },
        { metadata: { source: 'test' } }
      );
      expect(item.metadata).toEqual({ source: 'test' });
    });
  });

  // ==========================================================================
  // Processing
  // ==========================================================================
  describe('processQueue', () => {
    it('should process pending items', async () => {
      const processor = vi.fn().mockResolvedValue({ success: true });
      queue.registerProcessor('test', processor);

      queue.enqueue('test', { data: 'hello' });
      await queue.processQueue();

      expect(processor).toHaveBeenCalled();
      expect(queue.getQueue()[0].status).toBe('completed');
    });

    it('should not process when offline', async () => {
      mockOnline = false;
      const processor = vi.fn().mockResolvedValue({ success: true });
      queue.registerProcessor('test', processor);

      queue.enqueue('test', { data: 'hello' });
      await queue.processQueue();

      expect(processor).not.toHaveBeenCalled();
    });

    it('should handle processor failure', async () => {
      const processor = vi
        .fn()
        .mockResolvedValue({ success: false, error: 'API error' });
      queue.registerProcessor('test', processor);

      queue.enqueue('test', { data: 'hello' });
      await queue.processQueue();

      const item = queue.getQueue()[0];
      expect(item.status).toBe('failed');
      expect(item.lastError).toBe('API error');
      expect(item.retryCount).toBe(1);
    });

    it('should handle processor exception', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('Network error'));
      queue.registerProcessor('test', processor);

      queue.enqueue('test', { data: 'hello' });
      await queue.processQueue();

      const item = queue.getQueue()[0];
      expect(item.status).toBe('failed');
      expect(item.lastError).toBe('Network error');
    });

    it('should schedule retry with exponential backoff', async () => {
      const processor = vi
        .fn()
        .mockResolvedValue({ success: false, error: 'fail' });
      queue.registerProcessor('test', processor);

      queue.enqueue('test', { data: 'hello' }, { maxRetries: 5 });
      await queue.processQueue();

      const item = queue.getQueue()[0];
      expect(item.nextRetryAt).toBeDefined();
      expect(item.nextRetryAt).toBeGreaterThan(Date.now());
    });

    it('should mark as permanently failed after max retries', async () => {
      const processor = vi
        .fn()
        .mockResolvedValue({ success: false, error: 'fail' });
      queue.registerProcessor('test', processor);

      queue.enqueue('test', { data: 'hello' }, { maxRetries: 1 });

      // First attempt
      await queue.processQueue();
      expect(queue.getQueue()[0].status).toBe('failed');
      expect(queue.getQueue()[0].nextRetryAt).toBeNull(); // No more retries
    });

    it('should skip items without registered processor', async () => {
      const { logger } = await import('../../app/lib/error-logger');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      queue.enqueue('unknown_type', { data: 'hello' });
      await queue.processQueue();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No processor registered'),
        expect.any(Object)
      );
      expect(queue.getQueue()[0].status).toBe('pending');

      warnSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Retry
  // ==========================================================================
  describe('retry', () => {
    it('should reset failed item to pending status', async () => {
      const processor = vi.fn().mockResolvedValue({ success: false, error: 'fail' });
      queue.registerProcessor('test', processor);

      const item = queue.enqueue('test', { data: 'hello' }, { maxRetries: 1 });
      await queue.processQueue();

      expect(queue.getQueue()[0].status).toBe('failed');

      // Manual retry - should reset to pending
      const retried = queue.retry(item.id);
      expect(retried).toBe(true);
      expect(queue.getQueue()[0].status).toBe('pending');
      expect(queue.getQueue()[0].nextRetryAt).toBeNull();
    });

    it('should return false for non-existent item', () => {
      expect(queue.retry('non-existent')).toBe(false);
    });

    it('should return false for non-failed item', () => {
      const item = queue.enqueue('test', { data: 'hello' });
      expect(queue.retry(item.id)).toBe(false);
    });
  });

  describe('retryAllFailed', () => {
    it('should reset failed items to pending', () => {
      // Manually set up a failed item by manipulating the queue directly
      const item1 = queue.enqueue('test', { data: '1' }, { maxRetries: 1 });
      
      // Manually mark as failed (simulating what happens after processing)
      const queueItems = queue.getQueue();
      const foundItem = queueItems.find(i => i.id === item1.id);
      if (foundItem) {
        // Bypass status by modifying through reference
        (foundItem as { status: string }).status = 'failed';
      }

      const count = queue.retryAllFailed();
      expect(count).toBe(1);
      expect(queue.getQueue()[0].status).toBe('pending');
    });
  });

  // ==========================================================================
  // Remove / Clear
  // ==========================================================================
  describe('remove', () => {
    it('should remove item from queue', () => {
      const item = queue.enqueue('test', { data: 'hello' });
      expect(queue.getQueue().length).toBe(1);

      const removed = queue.remove(item.id);
      expect(removed).toBe(true);
      expect(queue.getQueue().length).toBe(0);
    });

    it('should return false for non-existent item', () => {
      expect(queue.remove('non-existent')).toBe(false);
    });
  });

  describe('clearCompleted', () => {
    it('should clear only completed items', async () => {
      const processor = vi.fn().mockResolvedValue({ success: true });
      queue.registerProcessor('test', processor);

      // Add first item
      queue.enqueue('test', { data: '1' });
      await queue.processQueue();
      
      // Add second item
      queue.enqueue('test', { data: '2' });
      await queue.processQueue();

      // Add a pending item (won't be processed since we register after)
      queue.unregisterProcessor('test');
      queue.enqueue('test', { data: '3' });

      // Verify we have at least 1 completed
      const completedCount = queue.getItemsByStatus('completed').length;
      expect(completedCount).toBeGreaterThanOrEqual(1);

      const cleared = queue.clearCompleted();
      expect(cleared).toBeGreaterThanOrEqual(1);
      
      // Should have only pending items left
      const remaining = queue.getQueue().filter(i => i.status !== 'pending');
      expect(remaining.length).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('should clear all items', () => {
      queue.enqueue('test', { data: '1' });
      queue.enqueue('test', { data: '2' });

      queue.clearAll();
      expect(queue.getQueue().length).toBe(0);
    });
  });

  // ==========================================================================
  // Getters
  // ==========================================================================
  describe('getItemsByStatus', () => {
    it('should filter by status', () => {
      // Add items
      const item1 = queue.enqueue('test', { data: '1' });
      const item2 = queue.enqueue('test', { data: '2' });
      queue.enqueue('test', { data: '3' });

      // Manually set statuses
      const items = queue.getQueue();
      const i1 = items.find(i => i.id === item1.id);
      const i2 = items.find(i => i.id === item2.id);
      if (i1) (i1 as { status: string }).status = 'completed';
      if (i2) (i2 as { status: string }).status = 'completed';

      expect(queue.getItemsByStatus('completed').length).toBe(2);
      expect(queue.getItemsByStatus('pending').length).toBe(1);
    });
  });

  describe('getPendingCount', () => {
    it('should count pending and processing items', () => {
      queue.enqueue('test', { data: '1' });
      queue.enqueue('test', { data: '2' });

      expect(queue.getPendingCount()).toBe(2);
    });
  });

  // ==========================================================================
  // Subscription
  // ==========================================================================
  describe('subscribe', () => {
    it('should notify listeners on changes', () => {
      const listener = vi.fn();
      queue.subscribe(listener);

      queue.enqueue('test', { data: 'hello' });

      expect(listener).toHaveBeenCalledWith(expect.any(Array));
    });

    it('should allow unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = queue.subscribe(listener);

      unsubscribe();
      queue.enqueue('test', { data: 'hello' });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Persistence
  // ==========================================================================
  describe('persistence', () => {
    it('should load queue from localStorage on init', () => {
      const savedQueue: QueueItem<{ data: string }>[] = [
        {
          id: 'saved-1',
          type: 'test',
          payload: { data: 'saved' },
          status: 'pending',
          priority: 'normal',
          retryCount: 0,
          maxRetries: 3,
          createdAt: Date.now(),
          lastAttemptAt: null,
          nextRetryAt: null,
          lastError: null,
        },
      ];

      localStorageMock.getItem.mockReturnValueOnce(JSON.stringify(savedQueue));

      const newQueue = new OfflineSyncQueue<{ data: string }>({
        storageKey: 'test_queue',
        autoProcessOnOnline: false,
      });

      expect(newQueue.getQueue().length).toBe(1);
      expect(newQueue.getQueue()[0].id).toBe('saved-1');

      newQueue.destroy();
    });

    it('should reset processing items to pending on load', () => {
      const savedQueue: QueueItem<{ data: string }>[] = [
        {
          id: 'processing-1',
          type: 'test',
          payload: { data: 'was processing' },
          status: 'processing',
          priority: 'normal',
          retryCount: 0,
          maxRetries: 3,
          createdAt: Date.now(),
          lastAttemptAt: Date.now(),
          nextRetryAt: null,
          lastError: null,
        },
      ];

      localStorageMock.getItem.mockReturnValueOnce(JSON.stringify(savedQueue));

      const newQueue = new OfflineSyncQueue<{ data: string }>({
        storageKey: 'test_queue',
        autoProcessOnOnline: false,
      });

      expect(newQueue.getQueue()[0].status).toBe('pending');

      newQueue.destroy();
    });
  });
});

// ==========================================================================
// Utility Functions
// ==========================================================================
describe('Queue Utility Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
  });

  describe('queueApiCall', () => {
    it('should queue an API call with defaults', () => {
      const item = queueApiCall('/api/test');

      expect(item.type).toBe('api');
      expect(item.payload.endpoint).toBe('/api/test');
      expect(item.payload.method).toBe('POST');
    });

    it('should accept custom options', () => {
      const item = queueApiCall('/api/test', {
        method: 'PUT',
        body: { key: 'value' },
        priority: 'high',
      });

      expect(item.payload.method).toBe('PUT');
      expect(item.payload.body).toEqual({ key: 'value' });
      expect(item.priority).toBe('high');
    });
  });

  describe('queueFeedback', () => {
    it('should queue feedback with correct payload', () => {
      const item = queueFeedback('turn-1', true);

      expect(item.payload.endpoint).toBe('/api/conversation/feedback');
      expect(item.payload.method).toBe('POST');
      expect(item.payload.body).toEqual({
        turn_id: 'turn-1',
        helpful: true,
      });
      expect(item.priority).toBe('low');
    });
  });

  describe('queueReflection', () => {
    it('should queue reflection with correct payload', () => {
      const item = queueReflection('session-1', 'My reflection', 'happy');

      expect(item.payload.endpoint).toBe('/api/reflections/create');
      expect(item.payload.method).toBe('POST');
      expect(item.payload.body).toEqual({
        session_id: 'session-1',
        content: 'My reflection',
        mood: 'happy',
      });
      expect(item.priority).toBe('normal');
    });
  });
});
