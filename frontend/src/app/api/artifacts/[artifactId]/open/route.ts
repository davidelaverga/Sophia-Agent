import { type NextRequest } from 'next/server';

import { proxyArtifactRegistryRequest } from '../../_lib/proxy';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const { artifactId } = await params;
  return proxyArtifactRegistryRequest(req, `/${encodeURIComponent(artifactId)}/open`, { method: 'POST' });
}
