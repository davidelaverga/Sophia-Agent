import { type NextRequest, NextResponse } from 'next/server';

import { auth } from '@/server/better-auth/config';
import { ensureBetterAuthSchema } from '@/server/better-auth/migrations';
import {
  assertNoVoiceLabRequestBody,
  getVoiceLabPrincipalConfig,
  mintGatewayContinuationCapability,
  projectVoiceLabD02OwnershipClaims,
  verifyFrontendCapability,
  verifyVoiceLabRunBinding,
  VOICE_LAB_CAPABILITY_HEADER,
  VOICE_LAB_CONTEXT_COOKIE,
  VOICE_LAB_RUN_BINDING_COOKIE,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

export const dynamic = 'force-dynamic';

function failure(error: unknown): NextResponse {
  if (error instanceof VoiceLabCapabilityError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
  }
  return NextResponse.json({ ok: false, error: 'voice_lab_continue_failed' }, { status: 500 });
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
    await assertNoVoiceLabRequestBody(request);
    const grant = verifyFrontendCapability(
      request.headers.get(VOICE_LAB_CAPABILITY_HEADER),
      'session:continue',
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

    const gatewayCapability = mintGatewayContinuationCapability(grant);
    const maxAge = Math.max(1, grant.exp - Math.floor(Date.now() / 1000));
    const response = NextResponse.json({
      ok: true,
      test_run_id: grant.test_run_id,
      cleanup_obligation_id: grant.cleanup_obligation_id,
      ...(projectVoiceLabD02OwnershipClaims(grant) ?? {}),
      expires_at: grant.exp,
      session_preserved: true,
      allowed_ops: ['session:create', 'session:read', 'session:finalize'],
    });
    response.headers.set('Cache-Control', 'no-store');
    response.cookies.set(VOICE_LAB_CONTEXT_COOKIE, gatewayCapability, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
