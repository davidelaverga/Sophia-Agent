import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => 'https://gateway.test',
}));

import {
  assertVoiceLabRetentionAdmissionReady,
  VOICE_LAB_RETENTION_ADMISSION_TIMEOUT_MS,
} from '../../server/voice-lab/retention-admission';

describe('Voice Lab retention admission', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('permits principal bootstrap while the retention plane is ready and product mutations remain closed', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const targetFetch = vi.fn(async () => new Response(JSON.stringify({
      voice_lab_admission_ready: true,
      voice_lab_mutation_ready: false,
      voice_lab_enabled: false,
      voice_lab_kill_switch_engaged: true,
      voice_lab_retention_reaper: { status: 'ready', running: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', targetFetch);

    await expect(assertVoiceLabRetentionAdmissionReady()).resolves.toBeUndefined();
    expect(targetFetch).toHaveBeenCalledWith('https://gateway.test/ready', expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
    }));
    expect(timeoutSpy).toHaveBeenCalledWith(VOICE_LAB_RETENTION_ADMISSION_TIMEOUT_MS);
  });

  it('fails closed when the protected retention admission fence is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      voice_lab_admission_ready: false,
      voice_lab_mutation_ready: false,
      voice_lab_retention_reaper: { status: 'ready', running: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(assertVoiceLabRetentionAdmissionReady()).rejects.toMatchObject({
      code: 'voice_lab_retention_plane_not_ready',
      status: 503,
    });
  });
});
