import { getPrimaryGatewayUrl } from '@/app/api/_lib/gateway-url';
import { VoiceLabCapabilityError } from '@/server/voice-lab/capability';

type GatewayReadiness = {
  voice_lab_admission_ready?: unknown;
  voice_lab_retention_reaper?: { status?: unknown; running?: unknown };
};

/** Fail before Better Auth allocation when durable cleanup is not authoritative. */
export async function assertVoiceLabRetentionAdmissionReady(): Promise<void> {
  try {
    const response = await fetch(`${getPrimaryGatewayUrl()}/ready`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });
    const payload = await response.json() as GatewayReadiness;
    if (
      !response.ok
      || payload.voice_lab_admission_ready !== true
      || payload.voice_lab_retention_reaper?.status !== 'ready'
      || payload.voice_lab_retention_reaper?.running !== true
    ) {
      throw new Error('retention admission is not ready');
    }
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) throw error;
    throw new VoiceLabCapabilityError('voice_lab_retention_plane_not_ready', 503);
  }
}
