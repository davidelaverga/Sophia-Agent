import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppVersionFreshness } from '../../app/hooks/useAppVersionFreshness';

const ORIGINAL_FETCH = globalThis.fetch;

describe('useAppVersionFreshness', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      build_id: 'development',
      deployment_id: 'deployment-1',
    }), { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('checks the same-origin app version endpoint on mount', async () => {
    renderHook(() => useAppVersionFreshness({
      enabled: true,
      showToast: vi.fn(),
      sessionId: 'session-1',
      threadId: 'thread-1',
      canAutoReload: false,
    }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/app-version', { cache: 'no-store' }));
  });

  it('warns the user when the loaded client build is stale', async () => {
    const showToast = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      build_id: 'server-build',
      deployment_id: 'deployment-2',
    }), { status: 200 })) as typeof fetch;

    const { result } = renderHook(() => useAppVersionFreshness({
      enabled: true,
      showToast,
      sessionId: 'session-1',
      threadId: 'thread-1',
      canAutoReload: false,
    }));

    await act(async () => {
      const fresh = await result.current.checkFreshness({ reason: 'test' });
      expect(fresh).toBe(false);
    });

    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Sophia updated. Refresh to continue.',
      variant: 'warning',
      action: expect.objectContaining({ label: 'Refresh' }),
    }));
  });
});
