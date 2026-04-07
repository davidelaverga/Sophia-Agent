import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorCopy } from '../../app/lib/error-copy';
import { logger } from '../../app/lib/error-logger';
import { useSessionInterruptRetryState } from '../../app/session/useSessionInterruptRetryState';
import { useSessionQueueRuntime } from '../../app/session/useSessionQueueRuntime';

describe('useSessionQueueRuntime', () => {
  it('mirrors latest chat status/messages through getter callbacks', () => {
    const onReconnectOnline = vi.fn();

    const { result, rerender } = renderHook(
      ({
        chatStatus,
        chatMessages,
        connectivityStatus,
      }: {
        chatStatus: string;
        chatMessages: Array<{ id: string; role?: string; parts?: Array<{ type?: string; text?: string }> }>;
        connectivityStatus: 'online' | 'offline' | 'degraded' | 'checking';
      }) =>
        useSessionQueueRuntime({
          chatStatus,
          chatMessages,
          connectivityStatus,
          onReconnectOnline,
        }),
      {
        initialProps: {
          chatStatus: 'ready',
          chatMessages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
          connectivityStatus: 'online',
        },
      }
    );

    expect(result.current.getChatStatus()).toBe('ready');
    expect(result.current.getChatMessages()).toHaveLength(1);

    rerender({
      chatStatus: 'streaming',
      chatMessages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'world' }] },
      ],
      connectivityStatus: 'online',
    });

    expect(result.current.getChatStatus()).toBe('streaming');
    expect(result.current.getChatMessages()).toHaveLength(2);
  });

  it('calls onReconnectOnline only when transitioning from offline-like to online', () => {
    const onReconnectOnline = vi.fn();

    const { rerender } = renderHook(
      ({ connectivityStatus }: { connectivityStatus: 'online' | 'offline' | 'degraded' | 'checking' }) =>
        useSessionQueueRuntime({
          chatStatus: 'ready',
          chatMessages: [],
          connectivityStatus,
          onReconnectOnline,
        }),
      { initialProps: { connectivityStatus: 'offline' } }
    );

    rerender({ connectivityStatus: 'degraded' });
    expect(onReconnectOnline).toHaveBeenCalledTimes(0);

    rerender({ connectivityStatus: 'online' });
    expect(onReconnectOnline).toHaveBeenCalledTimes(1);

    rerender({ connectivityStatus: 'online' });
    expect(onReconnectOnline).toHaveBeenCalledTimes(1);
  });
});

describe('useSessionInterruptRetryState', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('manages resume retry state transitions via helper actions', () => {
    const { result } = renderHook(() => useSessionInterruptRetryState());

    expect(result.current.resumeError).toBeNull();
    expect(result.current.resumeRetryOptionId).toBeNull();

    act(() => {
      result.current.setResumeError('temporary-error');
    });

    expect(result.current.resumeError).toBe('temporary-error');

    act(() => {
      result.current.prepareInterruptSelectRetry('opt-123');
    });

    expect(result.current.resumeRetryOptionId).toBe('opt-123');
    expect(result.current.resumeError).toBeNull();

    act(() => {
      result.current.setResumeError('another-error');
      result.current.clearResumeError();
    });

    expect(result.current.resumeError).toBeNull();
  });

  it('sets canonical resume error copy when resume fails', () => {
    const errorSpy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    const { result } = renderHook(() => useSessionInterruptRetryState());

    act(() => {
      result.current.handleResumeError(new Error('resume failed'));
    });

    expect(errorSpy).toHaveBeenCalled();
    expect(result.current.resumeError).toBe(errorCopy.resumeFailed);
  });

  it('runs interrupt select with retry pre-state and delegated handler', async () => {
    const { result } = renderHook(() => useSessionInterruptRetryState());
    const handleInterruptSelect = vi.fn(async () => undefined);

    await act(async () => {
      await result.current.runInterruptSelectWithRetry('opt-456', handleInterruptSelect);
    });

    expect(result.current.resumeRetryOptionId).toBe('opt-456');
    expect(result.current.resumeError).toBeNull();
    expect(handleInterruptSelect).toHaveBeenCalledWith('opt-456');
  });

  it('exposes hook-bound handleInterruptSelectWithRetry via bound handler', async () => {
    const delegatedHandler = vi.fn(async () => undefined);
    const { result } = renderHook(() => useSessionInterruptRetryState());

    act(() => {
      result.current.setInterruptSelectHandler(delegatedHandler);
    });

    await act(async () => {
      await result.current.handleInterruptSelectWithRetry('opt-789');
    });

    expect(result.current.resumeRetryOptionId).toBe('opt-789');
    expect(result.current.resumeError).toBeNull();
    expect(delegatedHandler).toHaveBeenCalledWith('opt-789');
  });

  it('retries resume via hook-owned handleResumeRetry when option exists', async () => {
    const delegatedHandler = vi.fn(async () => undefined);
    const { result } = renderHook(() => useSessionInterruptRetryState());

    act(() => {
      result.current.setInterruptSelectHandler(delegatedHandler);
      result.current.prepareInterruptSelectRetry('opt-resume');
    });

    await act(async () => {
      await result.current.handleResumeRetry();
    });

    expect(delegatedHandler).toHaveBeenCalledWith('opt-resume');
  });

  it('no-ops handleResumeRetry when no resume option exists', async () => {
    const delegatedHandler = vi.fn(async () => undefined);
    const { result } = renderHook(() => useSessionInterruptRetryState());

    act(() => {
      result.current.setInterruptSelectHandler(delegatedHandler);
    });

    await act(async () => {
      await result.current.handleResumeRetry();
    });

    expect(delegatedHandler).not.toHaveBeenCalled();
  });

  it('exposes sync resume retry press callback', async () => {
    const delegatedHandler = vi.fn(async () => undefined);
    const { result } = renderHook(() => useSessionInterruptRetryState());

    act(() => {
      result.current.setInterruptSelectHandler(delegatedHandler);
      result.current.prepareInterruptSelectRetry('opt-press');
    });

    await act(async () => {
      result.current.handleResumeRetryPress();
    });

    expect(delegatedHandler).toHaveBeenCalledWith('opt-press');
  });
});
