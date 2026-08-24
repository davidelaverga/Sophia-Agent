import { type NextRequest } from 'next/server';

import { proxyBuilderEvents } from '@/app/api/_lib/builder-events-proxy';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  return proxyBuilderEvents(request, threadId, 'last');
}
