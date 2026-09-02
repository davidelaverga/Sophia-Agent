import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordCaptureMock = vi.fn();

vi.mock('../../app/lib/session-capture', () => ({
  recordSophiaCaptureEvent: (...args: unknown[]) => recordCaptureMock(...args),
}));

import { useVoiceLabControlAdapter } from '../../app/hooks/useVoiceLabControlAdapter';

const receipt = {
  ok: true,
  schema: 'sophia_voice_lab_control_adapter_v1',
  action: 'session-start',
  test_run_id: 'run-control-001',
  scenario_id: 'V-P01',
  scenario_version: 'vt00.scenarios.v1',
  cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
  expected_deployment: {
    frontend: 'a'.repeat(40),
    backend: 'a'.repeat(40),
    voice: 'a'.repeat(40),
  },
  control_epoch_sha256: 'b'.repeat(64),
  expires_at: Math.floor(Date.now() / 1000) + 120,
  ordinary_user_access: false,
};

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useVoiceLabControlAdapter', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('invokes the existing action exactly once after an exact server authorization', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const invoke = vi.fn().mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useVoiceLabControlAdapter('session-start', invoke));
    await settle();
    rerender();
    await settle();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/voice-lab/control/session-start', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    }));
    expect(recordCaptureMock).toHaveBeenCalledWith(expect.objectContaining({
      category: 'voice-lab-control',
      name: 'authorized-action',
    }));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps authorization alive across callback identity changes and invokes the latest exact action once', async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = vi.fn().mockReturnValue(pendingFetch);
    const firstInvoke = vi.fn();
    const latestInvoke = vi.fn().mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ invoke }) => useVoiceLabControlAdapter('voice-start', invoke),
      { initialProps: { invoke: firstInvoke } },
    );
    await settle();
    const signal = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.signal;

    rerender({ invoke: latestInvoke });
    await settle();

    expect(signal?.aborted).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify({ ...receipt, action: 'voice-start' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await settle();

    expect(firstInvoke).not.toHaveBeenCalled();
    expect(latestInvoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ordinary/default-disabled response', new Response('{}', { status: 404 })],
    ['wrong action', new Response(JSON.stringify({ ...receipt, action: 'voice-start' }), { status: 200 })],
    ['expired receipt', new Response(JSON.stringify({ ...receipt, expires_at: 1 }), { status: 200 })],
  ])('does not invoke for %s', async (_label, response) => {
    globalThis.fetch = vi.fn().mockResolvedValue(response);
    const invoke = vi.fn();

    renderHook(() => useVoiceLabControlAdapter('session-start', invoke));
    await settle();

    expect(invoke).not.toHaveBeenCalled();
    expect(recordCaptureMock).not.toHaveBeenCalled();
  });

  it('aborts authorization on unmount and never invokes from a stale response', async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = vi.fn().mockReturnValue(pendingFetch);
    const invoke = vi.fn();

    const { unmount } = renderHook(() => useVoiceLabControlAdapter('session-start', invoke));
    const signal = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.signal;

    unmount();
    expect(signal?.aborted).toBe(true);

    resolveFetch(new Response(JSON.stringify(receipt), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await settle();

    expect(invoke).not.toHaveBeenCalled();
    expect(recordCaptureMock).not.toHaveBeenCalled();
  });

  it('does not publish or invoke when unmounted while receipt parsing is pending', async () => {
    let resolveReceipt!: (value: unknown) => void;
    const pendingReceipt = new Promise<unknown>((resolve) => {
      resolveReceipt = resolve;
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => pendingReceipt,
    } as Response);
    const invoke = vi.fn();

    const { unmount } = renderHook(() => useVoiceLabControlAdapter('session-start', invoke));
    await settle();
    unmount();
    resolveReceipt(receipt);
    await settle();

    expect(invoke).not.toHaveBeenCalled();
    expect(recordCaptureMock).not.toHaveBeenCalled();
  });
});
