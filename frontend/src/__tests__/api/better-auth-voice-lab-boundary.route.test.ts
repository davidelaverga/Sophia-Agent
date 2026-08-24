import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  getSession: vi.fn(),
  ensureSchema: vi.fn(),
  getHandler: vi.fn(),
  postHandler: vi.fn(),
}));

vi.mock('@/app/lib/auth/dev-bypass', () => ({ authBypassEnabled: false }));
vi.mock('next/headers', () => ({ cookies: (...args: unknown[]) => mocks.cookies(...args) }));
vi.mock('@/server/better-auth', () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
}));
vi.mock('@/server/better-auth/migrations', () => ({
  ensureBetterAuthSchema: (...args: unknown[]) => mocks.ensureSchema(...args),
}));
vi.mock('@/server/better-auth/config', () => ({
  auth: { handler: Symbol('better-auth-handler') },
}));
vi.mock('better-auth/next-js', () => ({
  toNextJsHandler: () => ({
    GET: (...args: unknown[]) => mocks.getHandler(...args),
    POST: (...args: unknown[]) => mocks.postHandler(...args),
  }),
}));

import { GET, POST } from '@/app/api/auth/[...all]/route';

describe('Better Auth dedicated Voice Lab boundary', () => {
  const originalPrincipal = process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL = 'voice-lab-user-1';
    mocks.cookies.mockResolvedValue({ has: () => false });
    mocks.getSession.mockResolvedValue({ user: { id: 'ordinary-user-1' } });
    mocks.getHandler.mockResolvedValue(Response.json({ ok: true }));
    mocks.postHandler.mockResolvedValue(Response.json({ ok: true }));
  });

  it.each([
    ['GET', GET, '/api/auth/callback/google'],
    ['POST', POST, '/api/auth/sign-in/social'],
  ])('denies marker-free dedicated identity on %s %s before schema or handler', async (
    _method,
    handler,
    pathname,
  ) => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'voice-lab-user-1' } });

    const response = await handler(new Request(`https://www.sophia-ei.com${pathname}`, {
      method: _method,
    }));

    expect(response.status).toBe(403);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.getHandler).not.toHaveBeenCalled();
    expect(mocks.postHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', GET, '/api/auth/get-session'],
    ['GET', GET, '/api/auth/session'],
    ['POST', POST, '/api/auth/sign-out'],
  ])('preserves exact governed %s %s without opening other Better Auth operations', async (
    method,
    handler,
    pathname,
  ) => {
    const response = await handler(new Request(`https://www.sophia-ei.com${pathname}`, { method }));

    expect(response.status).toBe(200);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.ensureSchema).toHaveBeenCalledTimes(1);
    expect(method === 'GET' ? mocks.getHandler : mocks.postHandler).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary Better Auth compatibility', async () => {
    const response = await POST(new Request(
      'https://www.sophia-ei.com/api/auth/sign-in/social',
      { method: 'POST' },
    ));

    expect(response.status).toBe(200);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSchema).toHaveBeenCalledTimes(1);
    expect(mocks.postHandler).toHaveBeenCalledTimes(1);
  });

  it('fails closed before Better Auth allocation when dedicated-principal lookup is unavailable', async () => {
    mocks.getSession.mockRejectedValueOnce(new Error('better-auth unavailable'));

    const response = await POST(new Request(
      'https://www.sophia-ei.com/api/auth/sign-in/social',
      { method: 'POST' },
    ));

    expect(response.status).toBe(403);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.postHandler).not.toHaveBeenCalled();
  });

  afterAll(() => {
    if (originalPrincipal === undefined) {
      delete process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL;
    } else {
      process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL = originalPrincipal;
    }
  });
});
