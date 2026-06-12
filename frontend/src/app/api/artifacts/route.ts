import { type NextRequest } from 'next/server';

import { proxyArtifactRegistryRequest } from './_lib/proxy';

export async function GET(req: NextRequest) {
  return proxyArtifactRegistryRequest(req, '', { method: 'GET' });
}
