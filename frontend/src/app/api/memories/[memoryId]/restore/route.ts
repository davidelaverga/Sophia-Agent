import { type NextRequest, NextResponse } from 'next/server';

import { forwardCanonicalLifecycle } from '../../../_lib/memory-lifecycle-response';
import { resolveSophiaUserId } from '../../../_lib/sophia';

export async function POST(req: NextRequest, { params }: { params: Promise<{ memoryId: string }> }) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const { memoryId } = await params;
    const owner = await resolveSophiaUserId();
    if (!memoryId || !owner) return NextResponse.json({ error: 'Memory owner unavailable' }, { status: 401, headers });
    return forwardCanonicalLifecycle(owner, memoryId, 'restore', await req.json().catch(() => null));
  } catch {
    return NextResponse.json({ error: 'Memory lifecycle command unavailable' }, { status: 503, headers });
  }
}
