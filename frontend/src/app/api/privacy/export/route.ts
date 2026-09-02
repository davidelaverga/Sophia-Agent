/** Memory-only privacy export from Sophia's active authority. */

import { type NextRequest, NextResponse } from 'next/server';

import { getUserScopedAuthHeader } from '../../../lib/auth/server-auth';
import { logger } from '../../../lib/error-logger';
import { fetchSophiaApi, resolveSophiaUserId } from '../../_lib/sophia';

type MemoryList = {
  memories?: unknown[];
  source?: string;
};

async function fetchList(userId: string, status: string): Promise<{ response: Response; payload: MemoryList | null }> {
  const response = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/memories/recent?status=${encodeURIComponent(status)}`,
    { method: 'GET', cache: 'no-store' },
  );
  const payload = response.ok ? await response.json().catch(() => null) as MemoryList | null : null;
  return { response, payload };
}

export async function GET(request: NextRequest) {
  const userId = await resolveSophiaUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!await getUserScopedAuthHeader()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const active = await fetchList(userId, 'approved');
    if (!active.response.ok || !active.payload) {
      return NextResponse.json(
        { error: 'Memory export authority unavailable', status: active.response.status === 404 ? 'unsupported' : 'failed' },
        { status: active.response.status === 404 ? 501 : 502 },
      );
    }

    let memories = Array.isArray(active.payload.memories) ? active.payload.memories : [];
    const authority = active.payload.source || 'legacy_unknown';
    if (authority === 'sophia_canonical') {
      const [forgotten, pending] = await Promise.all([
        fetchList(userId, 'forgotten'),
        fetchList(userId, 'pending_review'),
      ]);
      if (!forgotten.response.ok || !pending.response.ok || !forgotten.payload || !pending.payload) {
        return NextResponse.json({ error: 'Memory export incomplete', status: 'failed' }, { status: 502 });
      }
      memories = [
        ...memories,
        ...(Array.isArray(forgotten.payload.memories) ? forgotten.payload.memories : []),
        ...(Array.isArray(pending.payload.memories) ? pending.payload.memories : []),
      ];
    }

    const exportData = {
      export_date: new Date().toISOString(),
      user_id: userId,
      scope: 'memory_only',
      data: {
        memories,
        conversations: [],
        preferences: {},
      },
      metadata: {
        format_version: 'mem00.1',
        authority,
        source_transcripts_included: false,
        other_account_data_included: false,
      },
    };

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename=sophia-memory-${userId.slice(0, 8)}.json`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    logger.logError(error, { component: 'api/privacy/export', action: 'export_memory_data', request });
    return NextResponse.json({ error: 'Failed to export memory data', status: 'failed' }, { status: 500 });
  }
}
