import { getPrimaryGatewayUrl } from '@/app/api/_lib/gateway-url';
import { VoiceLabCapabilityError } from '@/server/voice-lab/capability';

type GatewayReadiness = {
  voice_lab_admission_ready?: unknown;
  voice_lab_retention_reaper?: { status?: unknown; running?: unknown };
};

export const VOICE_LAB_RETENTION_ADMISSION_TIMEOUT_MS = 15_000;

/** Fail before Better Auth allocation when durable cleanup is not authoritative. */
export async function assertVoiceLabRetentionAdmissionReady(): Promise<void> {
  try {
    const response = await fetch(`${getPrimaryGatewayUrl()}/ready`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      // Match the privileged frontend-operation ceiling. Cross-region cold
      // starts can legitimately exceed three seconds even when the signed
      // Gateway retention fence is healthy; the caller still fails closed
      // after this bounded deadline.
      signal: AbortSignal.timeout(VOICE_LAB_RETENTION_ADMISSION_TIMEOUT_MS),
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
