import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => sentry);

import { logger } from '../../app/lib/error-logger';
import { ordinaryServerErrorSinkAllowed } from '../../app/lib/synthetic-isolation-policy';

function request(cookie?: string): Request {
  return new Request('https://sophia.example.test/api/usage/backend', {
    headers: cookie ? { cookie } : undefined,
  });
}

describe('server request error-reporting isolation', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@example.test/1');
    sentry.addBreadcrumb.mockReset();
    sentry.captureException.mockReset();
    sentry.setUser.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('preserves the ordinary server Sentry path when no synthetic marker exists', () => {
    const ordinaryRequest = request('ordinary=value');
    expect(ordinaryServerErrorSinkAllowed(ordinaryRequest)).toBe(true);
    vi.stubGlobal('window', undefined);

    logger.error(new Error('ordinary-server-error'), {
      component: 'ordinary-api',
      request: ordinaryRequest,
    });
    logger.addBreadcrumb('ordinary-server-breadcrumb', undefined, ordinaryRequest);
    logger.setUser('ordinary-server-user', undefined, undefined, ordinaryRequest);

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(sentry.setUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    '__Host-sophia-voice-lab-context=signed-context',
    '__Host-sophia-voice-lab-run-binding=signed-binding',
    'ordinary=value; __Host-sophia-voice-lab-context=malformed',
  ])('drops synthetic and fail-closed server errors before Sentry allocation: %s', (cookie) => {
    const syntheticRequest = request(cookie);
    expect(ordinaryServerErrorSinkAllowed(syntheticRequest)).toBe(false);
    vi.stubGlobal('window', undefined);

    logger.error(new Error('synthetic-server-error'), {
      component: 'synthetic-api',
      request: syntheticRequest,
    });
    logger.addBreadcrumb('synthetic-server-breadcrumb', undefined, syntheticRequest);
    logger.setUser('synthetic-server-user', undefined, undefined, syntheticRequest);

    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentry.setUser).not.toHaveBeenCalled();
  });

  it('drops marker-free server errors for the known dedicated principal', () => {
    vi.stubEnv('SOPHIA_VOICE_LAB_TEST_PRINCIPAL', 'voice-lab-user-1');
    const markerFreeRequest = request('ordinary=value');
    expect(ordinaryServerErrorSinkAllowed(markerFreeRequest, 'voice-lab-user-1')).toBe(false);
    vi.stubGlobal('window', undefined);

    logger.error(new Error('marker-free-dedicated-error'), {
      component: 'synthetic-api',
      userId: 'voice-lab-user-1',
      request: markerFreeRequest,
    });
    logger.addBreadcrumb(
      'marker-free-dedicated-breadcrumb',
      undefined,
      markerFreeRequest,
      'voice-lab-user-1',
    );
    logger.setUser('voice-lab-user-1', undefined, undefined, markerFreeRequest);

    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentry.setUser).not.toHaveBeenCalled();
  });

  it('preserves marker-free ordinary server reporting with a configured lab principal', () => {
    vi.stubEnv('SOPHIA_VOICE_LAB_TEST_PRINCIPAL', 'voice-lab-user-1');
    const ordinaryRequest = request('ordinary=value');
    expect(ordinaryServerErrorSinkAllowed(ordinaryRequest, 'ordinary-user-1')).toBe(true);
    vi.stubGlobal('window', undefined);

    logger.error(new Error('ordinary-server-error'), {
      component: 'ordinary-api',
      userId: 'ordinary-user-1',
      request: ordinaryRequest,
    });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
