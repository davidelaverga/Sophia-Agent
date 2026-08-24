import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyntheticIsolationPolicy } from '../../app/lib/synthetic-isolation-policy';

const logger = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  setUser: vi.fn(),
}));
const usageStore = vi.hoisted(() => ({
  applyUsageInfo: vi.fn(),
  setPlanTier: vi.fn(),
  setUsageData: vi.fn(),
}));

vi.mock('../../app/providers', () => ({
  useAuth: () => ({
    user: { id: 'voice-lab-user-1', email: 'voice-lab@example.test', name: 'Voice Lab' },
  }),
}));
vi.mock('../../app/lib/error-logger', () => ({ logger }));
vi.mock('../../app/stores/usage-limit-store', () => ({
  useUsageLimitStore: { getState: () => usageStore },
}));

function installPolicy(policy: SyntheticIsolationPolicy): void {
  Object.defineProperty(window, '__SOPHIA_SYNTHETIC_ISOLATION_POLICY__', {
    configurable: true,
    writable: true,
    value: policy,
  });
}

describe('usage monitor synthetic isolation', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    logger.addBreadcrumb.mockReset();
    logger.setUser.mockReset();
    usageStore.applyUsageInfo.mockReset();
    usageStore.setPlanTier.mockReset();
    usageStore.setUsageData.mockReset();
  });

  it('does not allocate usage/Sentry work for synthetic pages and preserves fresh ordinary behavior', async () => {
    installPolicy({
      schema: 'sophia_synthetic_isolation_policy_v1',
      source: 'verified_voice_lab_context',
      synthetic: true,
      ordinary_product_analytics_excluded: true,
      ordinary_error_reporting_excluded: true,
      sink_allocation_allowed: false,
      reason: 'synthetic_isolation_policy',
    });
    const { useUsageMonitor } = await import('../../app/hooks/useUsageMonitor');
    const synthetic = renderHook(() => useUsageMonitor());

    expect(fetch).not.toHaveBeenCalled();
    expect(logger.setUser).not.toHaveBeenCalled();
    expect(logger.addBreadcrumb).not.toHaveBeenCalled();
    expect(usageStore.setUsageData).not.toHaveBeenCalled();
    synthetic.unmount();

    installPolicy({
      schema: 'sophia_synthetic_isolation_policy_v1',
      source: 'ordinary_request',
      synthetic: false,
      ordinary_product_analytics_excluded: false,
      ordinary_error_reporting_excluded: false,
      sink_allocation_allowed: true,
      reason: null,
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_tier: 'FREE',
        limits: { daily_voice_seconds: 600, daily_text_messages: 50 },
        today: { voice_seconds: 0, text_messages: 0 },
      }),
    } as Response);
    const ordinary = renderHook(() => useUsageMonitor());

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/usage/backend',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(logger.setUser).toHaveBeenCalledWith(
      'voice-lab-user-1',
      'voice-lab@example.test',
      'Voice Lab',
    );
    expect(logger.addBreadcrumb).toHaveBeenCalledTimes(1);
    ordinary.unmount();
  });
});
