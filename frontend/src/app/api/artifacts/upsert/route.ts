import { type NextRequest } from 'next/server';

import { proxyArtifactRegistryRequest } from '../_lib/proxy';
import { voiceLabOrdinaryProductBoundaryResponse } from '@/server/voice-lab/ordinary-route-isolation';

export async function POST(req: NextRequest) {
  const voiceLabDenied = await voiceLabOrdinaryProductBoundaryResponse();
  if (voiceLabDenied) return voiceLabDenied;
  return proxyArtifactRegistryRequest(req, '/upsert', {
    method: 'POST',
    body: await req.text(),
  });
}
