import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ordinaryAnalyticsSinkAllowed,
  type SyntheticIsolationPolicy,
} from '../../app/lib/synthetic-isolation-policy';

const sentry = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => sentry);
vi.mock('../../app/stores/consent-store', () => ({
  useConsentStore: {
    getState: () => ({ analytics: true }),
  },
}));

const EXCLUDED_POLICY: SyntheticIsolationPolicy = {
  schema: 'sophia_synthetic_isolation_policy_v1',
  source: 'verified_voice_lab_context',
  synthetic: true,
  ordinary_product_analytics_excluded: true,
  ordinary_error_reporting_excluded: true,
  sink_allocation_allowed: false,
  reason: 'synthetic_isolation_policy',
};

const ORDINARY_POLICY: SyntheticIsolationPolicy = {
  schema: 'sophia_synthetic_isolation_policy_v1',
  source: 'ordinary_request',
  synthetic: false,
  ordinary_product_analytics_excluded: false,
  ordinary_error_reporting_excluded: false,
  sink_allocation_allowed: true,
  reason: null,
};

function installPolicy(policy: SyntheticIsolationPolicy | undefined | object): void {
  Object.defineProperty(window, '__SOPHIA_SYNTHETIC_ISOLATION_POLICY__', {
    configurable: true,
    writable: true,
    value: policy,
  });
}

describe('server-authored synthetic analytics isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv('NEXT_PUBLIC_TELEMETRY_URL', 'https://telemetry.example.test/events');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@example.test/1');
    vi.mocked(fetch).mockReset();
    sentry.addBreadcrumb.mockReset();
    sentry.captureException.mockReset();
    sentry.setUser.mockReset();
    window.localStorage.setItem(
      'sophia-consent-storage',
      JSON.stringify({ state: { analytics: true }, version: 0 }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete window.__SOPHIA_SYNTHETIC_ISOLATION_POLICY__;
    delete (window as Window & { emitTelemetry?: unknown }).emitTelemetry;
  });

  it('allows sinks only for the exact ordinary policy and fails closed on malformed state', () => {
    installPolicy(undefined);
    expect(ordinaryAnalyticsSinkAllowed()).toBe(false);

    installPolicy({ schema: 'unexpected' });
    expect(ordinaryAnalyticsSinkAllowed()).toBe(false);

    installPolicy(EXCLUDED_POLICY);
    expect(ordinaryAnalyticsSinkAllowed()).toBe(false);

    installPolicy(ORDINARY_POLICY);
    expect(ordinaryAnalyticsSinkAllowed()).toBe(true);
  });

  it('keeps persisted-consent preconnect, active, and terminal events out of every sink', async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: beacon,
    });
    const windowTelemetry = vi.fn();
    (window as Window & { emitTelemetry?: typeof windowTelemetry }).emitTelemetry = windowTelemetry;
    installPolicy(EXCLUDED_POLICY);

    const { emitTelemetry } = await import('../../app/lib/telemetry');
    const { logger } = await import('../../app/lib/error-logger');

    for (const phase of ['dashboard-preconnect', 'active-run', 'terminal-cleanup']) {
      emitTelemetry(`synthetic.${phase}`, { persisted_consent: true });
      logger.error(new Error(`synthetic-${phase}`), { component: phase });
      logger.addBreadcrumb(`synthetic-${phase}`);
      logger.setUser('voice-lab-user-1');
    }
    window.dispatchEvent(new Event('pagehide'));

    expect(vi.getTimerCount()).toBe(0);
    expect(beacon).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentry.setUser).not.toHaveBeenCalled();
    expect(windowTelemetry).not.toHaveBeenCalled();

    // A fresh ordinary server bootstrap after cleanup restores the unchanged
    // consented path. Exercise both beacon and fetch fallback behavior.
    installPolicy(ORDINARY_POLICY);
    emitTelemetry('ordinary.after-cleanup');
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(1);

    beacon.mockImplementation(() => {
      throw new Error('beacon unavailable');
    });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));
    emitTelemetry('ordinary.fetch-fallback');
    window.dispatchEvent(new Event('pagehide'));
    expect(fetch).toHaveBeenCalledTimes(1);

    logger.error(new Error('ordinary-error'), { component: 'ordinary' });
    logger.addBreadcrumb('ordinary-breadcrumb');
    logger.setUser('ordinary-user');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(sentry.setUser).toHaveBeenCalledTimes(1);
    expect(windowTelemetry).toHaveBeenCalledTimes(1);
  });
});
