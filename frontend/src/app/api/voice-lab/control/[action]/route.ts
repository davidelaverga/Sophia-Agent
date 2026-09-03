import { createHash } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { auth } from '@/server/better-auth/config';
import { ensureBetterAuthSchema } from '@/server/better-auth/migrations';
import {
  assertNoVoiceLabRequestBody,
  assertVoiceLabControlAdapterEnabled,
  getVoiceLabPrincipalConfig,
  verifyVoiceLabControlCapability,
  verifyVoiceLabRunBinding,
  VOICE_LAB_CONTEXT_COOKIE,
  VOICE_LAB_RUN_BINDING_COOKIE,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

export const dynamic = 'force-dynamic';

type ControlAction = 'session-start' | 'voice-start';

const OPERATION_BY_ACTION = {
  'session-start': 'session:create',
  'voice-start': 'voice:start',
} as const;

export const VOICE_LAB_CONTROL_RECEIPT_HEADER = 'X-Sophia-Voice-Lab-Control-Receipt';

function failure(error: unknown): NextResponse {
  if (error instanceof VoiceLabCapabilityError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
  }
  return NextResponse.json({ ok: false, error: 'voice_lab_control_adapter_failed' }, { status: 500 });
}

function requestCookie(request: NextRequest, name: string): string | undefined {
  return (request.headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function parseAction(value: string): ControlAction {
  if (value !== 'session-start' && value !== 'voice-start') {
    throw new VoiceLabCapabilityError('voice_lab_control_action_not_found', 404);
  }
  return value;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ action: string }> },
) {
  try {
    await assertNoVoiceLabRequestBody(request);
    assertVoiceLabControlAdapterEnabled();
    const action = parseAction((await context.params).action);
    const capability = verifyVoiceLabControlCapability(
      requestCookie(request, VOICE_LAB_CONTEXT_COOKIE),
      OPERATION_BY_ACTION[action],
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
    const binding = verifyVoiceLabRunBinding(
      requestCookie(request, VOICE_LAB_RUN_BINDING_COOKIE),
      capability,
      session.session.token,
    );
    const controlEpochSha256 = createHash('sha256')
      .update('sophia.voice-lab.control-adapter.v1\0', 'utf8')
      .update(binding.grant_jti_sha256, 'ascii')
      .update('\0', 'utf8')
      .update(action, 'ascii')
      .digest('hex');

    const receipt = {
      ok: true,
      schema: 'sophia_voice_lab_control_adapter_v1',
      action,
      test_run_id: capability.test_run_id,
      scenario_id: capability.scenario_id ?? null,
      scenario_version: capability.scenario_version ?? null,
      cleanup_obligation_id: capability.cleanup_obligation_id,
      expected_deployment: { ...capability.expected_deployment },
      control_epoch_sha256: controlEpochSha256,
      expires_at: Math.min(capability.exp, binding.exp),
      ordinary_user_access: false,
    } as const;
    const response = NextResponse.json(receipt);
    response.headers.set('Cache-Control', 'no-store');
    // The ordinary session route may remount while this response body is being
    // consumed. Mirror the same exact, bounded receipt in a navigation-stable
    // response header so both the page and the external observer can validate
    // authorization without inventing a second control path.
    response.headers.set(
      VOICE_LAB_CONTROL_RECEIPT_HEADER,
      encodeURIComponent(JSON.stringify(receipt)),
    );
    return response;
  } catch (error) {
    return failure(error);
  }
}
