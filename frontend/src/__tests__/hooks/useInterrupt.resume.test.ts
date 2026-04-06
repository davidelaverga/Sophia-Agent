import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInterrupt } from '../../app/hooks/useInterrupt';
import type { InterruptPayload } from '../../app/types/session';

function buildInterrupt(kind: InterruptPayload['kind'] = 'DEBRIEF_OFFER'): InterruptPayload {
  if (kind === 'MICRO_DIALOG') {
    return {
      kind: 'MICRO_DIALOG',
      dialogKind: 'plan_choice',
      title: 'Quick question',
      message: 'Choose one',
      options: [
        { id: 'option_0', label: 'A', style: 'primary' },
        { id: 'option_1', label: 'B', style: 'secondary' },
      ],
    };
  }

  return {
    kind,
    title: 'Offer',
    message: 'Question',
    options: [
      { id: 'accept', label: 'Yes', style: 'primary' },
      { id: 'decline', label: 'Not now', style: 'secondary' },
    ],
    snooze: true,
  };
}

describe('useInterrupt resume payload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('sends nested resume payload with dismiss action for decline option', async () => {
    const onResumeSuccess = vi.fn();
    const onResumeError = vi.fn();

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('Backend streamed continuation', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    );

    const { result } = renderHook(() =>
      useInterrupt({
        sessionId: 'session-1',
        threadId: 'thread-1',
        onResumeSuccess,
        onResumeError,
      })
    );

    act(() => {
      result.current.setInterrupt(buildInterrupt('DEBRIEF_OFFER'));
    });

    await act(async () => {
      await result.current.handleInterruptSelect('decline');
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const fetchCall = fetchSpy.mock.calls[0];
    expect(fetchCall[0]).toBe('/api/resume');

    const init = fetchCall[1];
    const body = JSON.parse(String(init.body));

    expect(body).toMatchObject({
      thread_id: 'thread-1',
      session_id: 'session-1',
      resume: {
        kind: 'DEBRIEF_OFFER',
        action: 'dismiss',
        option_id: 'decline',
      },
    });

    expect(onResumeError).not.toHaveBeenCalled();
    expect(onResumeSuccess).toHaveBeenCalledWith('Backend streamed continuation');
  });

  it('clears pending interrupt and surfaces INTERRUPT_EXPIRED when resume is expired', async () => {
    const onResumeSuccess = vi.fn();
    const onResumeError = vi.fn();

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'INTERRUPT_EXPIRED' }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { result } = renderHook(() =>
      useInterrupt({
        sessionId: 'session-2',
        threadId: 'thread-2',
        onResumeSuccess,
        onResumeError,
      })
    );

    act(() => {
      result.current.setInterrupt(buildInterrupt('RESET_OFFER'));
    });

    await act(async () => {
      await result.current.handleInterruptSelect('accept');
    });

    expect(result.current.pendingInterrupt).toBeNull();
    expect(onResumeSuccess).not.toHaveBeenCalled();
    expect(onResumeError).toHaveBeenCalledTimes(1);
    expect(onResumeError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onResumeError.mock.calls[0][0] as Error).message).toBe('INTERRUPT_EXPIRED');
  });
});
