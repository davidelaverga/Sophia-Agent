import { type NextRequest } from 'next/server';

import { proxyArtifactRegistryRequest } from '../_lib/proxy';

export async function POST(req: NextRequest) {
  return proxyArtifactRegistryRequest(req, '/upsert', {
    method: 'POST',
    body: await req.text(),
  });
}
