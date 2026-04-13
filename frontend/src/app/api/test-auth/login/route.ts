import { makeSignature } from 'better-auth/crypto';
import { type NextRequest, NextResponse } from 'next/server';

import { auth } from '@/server/better-auth/config';
import { ensureBetterAuthSchema } from '@/server/better-auth/migrations';

type TestAuthLoginRequest = {
  email?: string;
  name?: string;
  accountId?: string;
};

function isTestAuthEnabled(): boolean {
  return process.env.SOPHIA_E2E_TEST_AUTH === 'true';
}

function normalizeSameSite(value: unknown): 'lax' | 'strict' | 'none' {
  if (typeof value === 'string') {
    const normalizedValue = value.toLowerCase();
    if (normalizedValue === 'strict' || normalizedValue === 'none') {
      return normalizedValue;
    }
  }

  return 'lax';
}

function buildDefaultAccountId(email: string): string {
  return `google-e2e-${email.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'user'}`;
}

export async function POST(request: NextRequest) {
  if (!isTestAuthEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as TestAuthLoginRequest;
  const email = typeof body.email === 'string' && body.email.includes('@')
    ? body.email.trim().toLowerCase()
    : 'auth-smoke@example.com';
  const name = typeof body.name === 'string' && body.name.trim().length > 0
    ? body.name.trim()
    : 'Auth Smoke User';
  const accountId = typeof body.accountId === 'string' && body.accountId.trim().length > 0
    ? body.accountId.trim()
    : buildDefaultAccountId(email);

  await ensureBetterAuthSchema();

  const authContext = await auth.$context;
  const existingUser = await authContext.internalAdapter.findUserByEmail(email);
  const user = existingUser?.user ?? await authContext.internalAdapter.createUser({
    email,
    name,
    emailVerified: true,
    image: null,
  });

  const existingAccount = await authContext.internalAdapter.findAccount(accountId);
  if (!existingAccount) {
    await authContext.internalAdapter.createAccount({
      userId: user.id,
      providerId: 'google',
      accountId,
      scope: 'openid,profile,email',
    });
  }

  const session = await authContext.internalAdapter.createSession(user.id);
  const signedSessionToken = `${session.token}.${await makeSignature(session.token, authContext.secret)}`;

  const response = NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    accountId,
  });

  response.cookies.set(authContext.authCookies.sessionToken.name, signedSessionToken, {
    httpOnly: authContext.authCookies.sessionToken.attributes.httpOnly ?? true,
    secure: authContext.authCookies.sessionToken.attributes.secure ?? false,
    sameSite: normalizeSameSite(authContext.authCookies.sessionToken.attributes.sameSite),
    path: authContext.authCookies.sessionToken.attributes.path ?? '/',
    ...(typeof authContext.authCookies.sessionToken.attributes.maxAge === 'number'
      ? { maxAge: authContext.authCookies.sessionToken.attributes.maxAge }
      : {}),
  });

  return response;
}