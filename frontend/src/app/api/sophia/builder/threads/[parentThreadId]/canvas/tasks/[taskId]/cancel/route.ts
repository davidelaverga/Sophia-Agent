import { type NextRequest, NextResponse } from 'next/server';

import {
  getVoiceLabEndSessionCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../../../../../_lib/sophia';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ parentThreadId: string; taskId: string }> },
) {
  const { parentThreadId, taskId } = await params;
  const userId = await resolveSophiaUserId({ voiceLabAccess: 'governed' });
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  let capability: string | null;
  try {
    capability = await getVoiceLabEndSessionCapability(userId);
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    throw error;
  }
  const response = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/threads/${encodeURIComponent(parentThreadId)}/builder-canvas/tasks/${encodeURIComponent(taskId)}/cancel`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: capability
        ? { [VOICE_LAB_CAPABILITY_HEADER]: capability }
        : undefined,
    },
    { voiceLabAccess: 'governed' },
  );
  const payload = await response.json().catch(() => ({}));
  return NextResponse.json(payload, { status: response.status });
}
