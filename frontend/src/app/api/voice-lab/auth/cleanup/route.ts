import { type NextRequest, NextResponse } from 'next/server';

import { auth } from '@/server/better-auth/config';
import { ensureBetterAuthSchema } from '@/server/better-auth/migrations';
import { revokeVoiceLabSessions } from '@/server/voice-lab/session-ledger';
import {
  assertNoVoiceLabRequestBody,
  getVoiceLabPrincipalConfig,
  verifyFrontendCapability,
  verifyVoiceLabRunBinding,
  VOICE_LAB_CAPABILITY_HEADER,
  VOICE_LAB_CONTEXT_COOKIE,
  VOICE_LAB_RUN_BINDING_COOKIE,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

export const dynamic = 'force-dynamic';

type BetterAuthCookieConfig = {
  name: string;
  attributes: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: boolean | 'lax' | 'strict' | 'none';
    path?: string;
    domain?: string;
  };
};

function normalizeSameSite(value: BetterAuthCookieConfig['attributes']['sameSite']): 'lax' | 'strict' | 'none' {
  return typeof value === 'string' ? value : 'lax';
}

function failure(error: unknown): NextResponse {
  if (error instanceof VoiceLabCapabilityError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
  }
  return NextResponse.json({ ok: false, error: 'voice_lab_cleanup_failed' }, { status: 500 });
}

function incomingCookieNames(request: NextRequest): string[] {
  return (request.headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim().split('=', 1)[0])
    .filter(Boolean);
}

function requestCookie(request: NextRequest, name: string): string | undefined {
  return (request.headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export async function POST(request: NextRequest) {
  try {
    assertNoVoiceLabRequestBody(request);
    const grant = verifyFrontendCapability(
      request.headers.get(VOICE_LAB_CAPABILITY_HEADER),
      'session:cleanup',
    );
    const config = getVoiceLabPrincipalConfig();
    await ensureBetterAuthSchema();
    const session = await auth.api.getSession({ headers: request.headers });
    if (
      !session?.session?.token
      || !session.user
      || session.user.id !== config.principalId
      || session.user.email?.trim().toLowerCase() !== config.email
    ) {
      throw new VoiceLabCapabilityError('voice_lab_authenticated_principal_required', 403);
    }
    verifyVoiceLabRunBinding(
      requestCookie(request, VOICE_LAB_RUN_BINDING_COOKIE),
      grant,
      session.session.token,
    );

    const authContext = await auth.$context;
    const revokedSessionCount = await revokeVoiceLabSessions(config.principalId, grant);

    const response = NextResponse.json({
      ok: true,
      session_revoked: true,
      test_run_id: grant.test_run_id,
      cleanup_obligation_id: grant.cleanup_obligation_id,
      cleaned_at: new Date().toISOString(),
      cookies_cleared: true,
      revoked_scope: 'dedicated_principal',
      revoked_session_count: revokedSessionCount,
    });
    response.headers.set('Cache-Control', 'no-store');

    const authCookieConfigs = Object.values(authContext.authCookies) as BetterAuthCookieConfig[];
    const requestCookieNames = incomingCookieNames(request);
    for (const cookieConfig of authCookieConfigs) {
      const names = new Set([
        cookieConfig.name,
        ...requestCookieNames.filter((name) => name.startsWith(`${cookieConfig.name}.`)),
      ]);
      for (const name of names) {
        response.cookies.set(name, '', {
          httpOnly: cookieConfig.attributes.httpOnly ?? true,
          secure: cookieConfig.attributes.secure ?? true,
          sameSite: normalizeSameSite(cookieConfig.attributes.sameSite),
          path: cookieConfig.attributes.path ?? '/',
          ...(cookieConfig.attributes.domain ? { domain: cookieConfig.attributes.domain } : {}),
          maxAge: 0,
        });
      }
    }
    response.cookies.set(VOICE_LAB_CONTEXT_COOKIE, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    });
    response.cookies.set(VOICE_LAB_RUN_BINDING_COOKIE, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    });
    response.cookies.set('sophia-backend-token', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
