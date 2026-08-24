import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../../_lib/sophia';
import {
  getVoiceLabConnectCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

export const dynamic = 'force-dynamic';

async function authorizeVoiceConnect(userId: string) {
  const authenticatedUserId = await resolveSophiaUserId({ voiceLabAccess: 'governed' });

  if (!authenticatedUserId) {
    return { response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }

  if (authenticatedUserId !== userId) {
    return { response: NextResponse.json({ error: 'Token does not grant access to this user' }, { status: 403 }) };
  }

  return { ok: true };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const auth = await authorizeVoiceConnect(userId);

  if ('response' in auth) {
    return auth.response;
  }

  let capability: string | null;
  try {
    capability = await getVoiceLabConnectCapability(userId);
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: 'voice_lab_capability_validation_failed' }, { status: 500 });
  }

  const headers = capability
    ? { [VOICE_LAB_CAPABILITY_HEADER]: capability }
    : undefined;

  const backendResponse = await fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/voice/connect${req.nextUrl.search}`,
    {
      method: 'POST',
      body: await req.text(),
      headers,
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
}
