import { createHash } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { ensureBetterAuthSchema } from '@/server/better-auth/migrations';
import {
  assertNoVoiceLabRequestBody,
  getCurrentFrontendBuild,
  getVoiceLabControlGates,
  getVoiceLabPrincipalConfig,
  verifyFrontendCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';
import { assertVoiceLabRetentionAdmissionReady } from '@/server/voice-lab/retention-admission';
import { ensureDedicatedVoiceLabPrincipal } from '@/server/voice-lab/principal-provision-store';

export const dynamic = 'force-dynamic';

const PROVISION_RESULT_SCHEMA = 'sophia_voice_lab_principal_provision_result_v1';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function failure(error: unknown): NextResponse {
  if (error instanceof VoiceLabCapabilityError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
  }
  return NextResponse.json({ ok: false, error: 'voice_lab_provisioning_failed' }, { status: 500 });
}

function assertProvisioningEnabled(): void {
  const gates = getVoiceLabControlGates();
  if (!gates.provisioningEnabled) {
    throw new VoiceLabCapabilityError('voice_lab_provisioning_disabled', 404);
  }
  if (!gates.killSwitchEngaged) {
    throw new VoiceLabCapabilityError('voice_lab_provisioning_kill_switch_required', 403);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertProvisioningEnabled();
    await assertNoVoiceLabRequestBody(request);
    const capability = verifyFrontendCapability(
      request.headers.get(VOICE_LAB_CAPABILITY_HEADER),
      'auth:provision',
    );
    await assertVoiceLabRetentionAdmissionReady();
    const config = getVoiceLabPrincipalConfig();
    const configuredName = process.env.SOPHIA_VOICE_LAB_TEST_NAME?.trim();
    if (!configuredName || configuredName.length > 100) {
      throw new VoiceLabCapabilityError('voice_lab_configuration_invalid', 503);
    }
    await ensureBetterAuthSchema();
    await ensureDedicatedVoiceLabPrincipal({
      principalId: config.principalId,
      email: config.email,
      name: configuredName,
    });

    const capabilityToken = request.headers.get(VOICE_LAB_CAPABILITY_HEADER);
    const frontendBuild = getCurrentFrontendBuild();
    const response = NextResponse.json({
      schema: PROVISION_RESULT_SCHEMA,
      ok: true,
      // This is a state assertion, not a per-attempt creation flag. A caller
      // replaying the same durable capability after response loss must receive
      // the same positive provisioning fact.
      provisioned: true,
      principal_id_sha256: sha256(capability.principal_id),
      capability_sha256: sha256(capabilityToken || ''),
      capability_jti_sha256: sha256(capability.jti),
      test_run_id_sha256: sha256(capability.test_run_id),
      cleanup_obligation_id_sha256: sha256(capability.cleanup_obligation_id),
      environment: capability.environment,
      frontend_build: frontendBuild,
      expected_deployment: { ...capability.expected_deployment },
    });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Pragma', 'no-cache');
    return response;
  } catch (error) {
    return failure(error);
  }
}
