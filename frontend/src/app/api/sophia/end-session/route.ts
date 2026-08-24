import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../../lib/error-logger';
import { fetchSophiaApi, resolveSophiaUserId } from '../../_lib/sophia';
import {
  getVoiceLabEndSessionCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const userId = await resolveSophiaUserId({ voiceLabAccess: 'governed' });

    if (!userId) {
      return NextResponse.json({ error: 'Unable to resolve user_id' }, { status: 401 });
    }

    const voiceLabCapability = await getVoiceLabEndSessionCapability(userId);

    const payload = { ...body };
    delete payload.user_id;
    const normalizedPayload = {
      ...payload,
      thread_id: typeof payload.thread_id === 'string' && payload.thread_id.trim().length > 0
        ? payload.thread_id
        : payload.session_id,
    };
    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/end-session`,
      {
        method: 'POST',
        headers: voiceLabCapability
          ? { [VOICE_LAB_CAPABILITY_HEADER]: voiceLabCapability }
          : undefined,
        body: JSON.stringify(normalizedPayload),
      },
      { voiceLabAccess: 'governed' },
    );

    const responseText = await backendResponse.text();

    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: {
        'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    logger.logError(error, { component: 'api/sophia/end-session', action: 'end_session', request });
    return NextResponse.json({ error: 'Failed to end Sophia session' }, { status: 500 });
  }
}
