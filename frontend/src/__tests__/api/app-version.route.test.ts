import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../app/api/app-version/route';

describe('/api/app-version', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a no-store public build identifier', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_BUILD_ID', 'build-1234567890');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'deployment-1');

    const response = await GET();
    const payload = await response.json();

    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(payload).toEqual({
      build_id: 'build-1234567890',
      deployment_id: 'deployment-1',
      memory_contract_schema: 'mem00.v1',
      memory_supported_contract_epoch: 1,
    });
  });
});
