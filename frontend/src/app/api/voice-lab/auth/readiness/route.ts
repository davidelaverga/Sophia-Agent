import { createHash } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { ensureBetterAuthSchema } from '@/server/better-auth/migrations';
import { assertVoiceLabAuthLedgerReady } from '@/server/voice-lab/session-ledger';
import {
  assertNoVoiceLabRequestBody,
  getCurrentFrontendBuild,
  getVoiceLabControlGates,
  getVoiceLabPrincipalConfig,
  verifyFrontendCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';
import { readDedicatedVoiceLabPrincipalState } from '@/server/voice-lab/principal-provision-store';

export const dynamic = 'force-dynamic';

const READINESS_SCHEMA = 'sophia_voice_lab_auth_readiness_v1';

function failure(error: unknown): NextResponse {
  if (error instanceof VoiceLabCapabilityError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
  }
  return NextResponse.json({ ok: false, error: 'voice_lab_readiness_failed' }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    await assertNoVoiceLabRequestBody(request);
    const grant = verifyFrontendCapability(
      request.headers.get(VOICE_LAB_CAPABILITY_HEADER),
      'auth:readiness',
    );
    const config = getVoiceLabPrincipalConfig();
    const gates = getVoiceLabControlGates();
    const configuredName = process.env.SOPHIA_VOICE_LAB_TEST_NAME?.trim();
    if (!configuredName || configuredName.length > 100) {
      throw new VoiceLabCapabilityError('voice_lab_configuration_invalid', 503);
    }
    await ensureBetterAuthSchema();
    const ledgerReadiness = await assertVoiceLabAuthLedgerReady();
    const principalState = await readDedicatedVoiceLabPrincipalState({
      principalId: config.principalId,
      email: config.email,
      name: configuredName,
    });

    const frontendBuild = getCurrentFrontendBuild();
    const response = NextResponse.json({
      schema: READINESS_SCHEMA,
      ok: true,
      ready: principalState.provisioned,
      provisioned: principalState.provisioned,
      principal_record_present: principalState.principalRecordPresent,
      principal_record_provisioned: principalState.principalRecordProvisioned,
      provider_account_provisioned: principalState.providerAccountProvisioned,
      provider_account_count: principalState.providerAccountCount,
      active_session_count: principalState.activeSessionCount,
      voice_lab_enabled: gates.voiceLabEnabled,
      kill_switch_engaged: gates.killSwitchEngaged,
      provisioning_enabled: gates.provisioningEnabled,
      control_adapter_enabled: gates.controlAdapterEnabled,
      auth_ledger_ready: ledgerReadiness.ready,
      auth_ledger_migration_sha256: ledgerReadiness.migrationSha256,
      frontend_build: frontendBuild,
      test_run_id: grant.test_run_id,
      cleanup_obligation_id: grant.cleanup_obligation_id,
      environment: grant.environment,
      expected_deployment: { ...grant.expected_deployment },
      deployment_identity: { frontend: frontendBuild },
      capability_jti_sha256: createHash('sha256')
        .update(grant.jti, 'utf8')
        .digest('hex'),
      principal_id_sha256: createHash('sha256')
        .update(config.principalId, 'utf8')
        .digest('hex'),
    });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Pragma', 'no-cache');
    return response;
  } catch (error) {
    return failure(error);
  }
}
