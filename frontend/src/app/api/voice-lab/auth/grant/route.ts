import { createHmac } from 'node:crypto';

import { makeSignature } from 'better-auth/crypto';
import { type NextRequest, NextResponse } from 'next/server';

import { auth } from '@/server/better-auth/config';
import { ensureBetterAuthSchema } from '@/server/better-auth/migrations';
import {
  assertVoiceLabAuthLedgerReady,
  rotateVoiceLabSession,
} from '@/server/voice-lab/session-ledger';
import {
  assertNoVoiceLabRequestBody,
  getVoiceLabPrincipalConfig,
  getVoiceLabSessionTtlSeconds,
  mintGatewayCapability,
  mintVoiceLabRunBinding,
  projectVoiceLabD02OwnershipClaims,
  verifyFrontendGrant,
  VOICE_LAB_CAPABILITY_HEADER,
  VOICE_LAB_CONTEXT_COOKIE,
  VOICE_LAB_RUN_BINDING_COOKIE,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';
import { assertVoiceLabRetentionAdmissionReady } from '@/server/voice-lab/retention-admission';

export const dynamic = 'force-dynamic';

function failure(error: unknown): NextResponse {
  if (error instanceof VoiceLabCapabilityError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
  }
  return NextResponse.json({ ok: false, error: 'voice_lab_grant_failed' }, { status: 500 });
}

function deterministicSessionToken(
  secret: string,
  principalId: string,
  testRunId: string,
  cleanupObligationId: string,
  jti: string,
  nonce: string,
): string {
  return createHmac('sha256', secret)
    .update('sophia.voice-lab.auth-session.v1\0', 'utf8')
    .update(principalId, 'utf8')
    .update('\0', 'utf8')
    .update(testRunId, 'utf8')
    .update('\0', 'utf8')
    .update(cleanupObligationId, 'utf8')
    .update('\0', 'utf8')
    .update(jti, 'utf8')
    .update('\0', 'utf8')
    .update(nonce, 'utf8')
    .digest('base64url');
}

export async function POST(request: NextRequest) {
  try {
    await assertNoVoiceLabRequestBody(request);

    const grant = verifyFrontendGrant(request.headers.get(VOICE_LAB_CAPABILITY_HEADER));
    await assertVoiceLabRetentionAdmissionReady();
    const config = getVoiceLabPrincipalConfig();
    await ensureBetterAuthSchema();
    await assertVoiceLabAuthLedgerReady();

    const authContext = await auth.$context;
    const existingUser = await authContext.internalAdapter.findUserByEmail(config.email);
    const user = existingUser?.user;
    if (!user || user.id !== config.principalId || user.email.trim().toLowerCase() !== config.email) {
      throw new VoiceLabCapabilityError('voice_lab_test_principal_not_provisioned', 403);
    }

    const sessionTtlSeconds = getVoiceLabSessionTtlSeconds();
    const sessionExpiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
    // The configured principal is dedicated exclusively to the lab. A
    // database advisory lock serializes distinct grants, stores only JTI/nonce
    // hashes, and makes same-grant retries converge on one session row.
    const rawSessionToken = deterministicSessionToken(
      authContext.secret,
      config.principalId,
      grant.test_run_id,
      grant.cleanup_obligation_id,
      grant.jti,
      grant.nonce,
    );
    const session = await rotateVoiceLabSession(
      config.principalId,
      grant,
      rawSessionToken,
      sessionExpiresAt,
    );
    const signedSessionToken = `${session.token}.${await makeSignature(session.token, authContext.secret)}`;
    const gatewayCapability = mintGatewayCapability(grant);
    const runBinding = mintVoiceLabRunBinding(
      grant,
      session.token,
      session.expiresAt,
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const capabilityMaxAge = Math.max(1, grant.exp - nowSeconds);
    const sessionMaxAge = Math.max(
      1,
      Math.floor(session.expiresAt.getTime() / 1000) - nowSeconds,
    );

    const response = NextResponse.json({
      ok: true,
      test_run_id: grant.test_run_id,
      cleanup_obligation_id: grant.cleanup_obligation_id,
      ...(projectVoiceLabD02OwnershipClaims(grant) ?? {}),
      expires_at: grant.exp,
      session_expires_at: Math.floor(session.expiresAt.getTime() / 1000),
      prior_session_cleanup_verified: true,
      expired_lab_sessions_revoked: session.expiredLabSessionsRevoked,
      no_prior_conflicting_session: true,
      auth_session_state: session.idempotentReplay ? 'idempotent_replay' : 'created',
      idempotent_replay: session.idempotentReplay,
    });
    response.headers.set('Cache-Control', 'no-store');
    response.cookies.set(authContext.authCookies.sessionToken.name, signedSessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: sessionMaxAge,
    });
    response.cookies.set(VOICE_LAB_CONTEXT_COOKIE, gatewayCapability, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: capabilityMaxAge,
    });
    response.cookies.set(VOICE_LAB_RUN_BINDING_COOKIE, runBinding, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: sessionMaxAge,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
