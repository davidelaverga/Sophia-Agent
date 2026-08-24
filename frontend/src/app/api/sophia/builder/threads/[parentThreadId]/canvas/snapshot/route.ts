import { type NextRequest, NextResponse } from 'next/server';

import {
  getVoiceLabSessionReadCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../../../_lib/sophia';

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 12) : null;
}

function correlationId(): string {
  return Math.random().toString(36).slice(2, 12);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ parentThreadId: string }> },
) {
  const { parentThreadId } = await params;
  const requestId = correlationId();
  const userId = await resolveSophiaUserId({ voiceLabAccess: 'governed' });
  if (!userId) {
    console.warn('[builder-canvas-proxy] snapshot auth failed', {
      route: 'snapshot',
      correlation_id: requestId,
      parent_thread_id: shortId(parentThreadId),
      auth_present: false,
    });
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  console.log('[builder-canvas-proxy] snapshot forwarding', {
    route: 'snapshot',
    correlation_id: requestId,
    parent_thread_id: shortId(parentThreadId),
    user_id: shortId(userId),
    auth_present: true,
  });
  let capability: string | null;
  try {
    capability = await getVoiceLabSessionReadCapability(userId);
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    throw error;
  }
  const response = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/threads/${encodeURIComponent(parentThreadId)}/builder-canvas/snapshot`,
    {
      method: 'GET',
      cache: 'no-store',
      headers: capability
        ? { [VOICE_LAB_CAPABILITY_HEADER]: capability }
        : undefined,
    },
    { voiceLabAccess: 'governed' },
  );
  const payload = await response.json().catch(() => ({}));
  console.log('[builder-canvas-proxy] snapshot response', {
    route: 'snapshot',
    correlation_id: requestId,
    parent_thread_id: shortId(parentThreadId),
    upstream_status: response.status,
    content_type: response.headers.get('Content-Type'),
  });
  return NextResponse.json(payload, { status: response.status });
}
