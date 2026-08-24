import { type NextRequest, NextResponse } from 'next/server';

import {
  getVoiceLabSessionReadCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

import {
  getAuthenticatedUserId,
  getUserScopedAuthHeader,
  refreshUserScopedAuthHeader,
} from '../../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  const contentType = source.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }
  return headers;
}

async function proxyArtifactListRequest(
  req: NextRequest,
  threadId: string,
): Promise<Response> {
  const authenticatedUserId = await getAuthenticatedUserId({ voiceLabAccess: 'governed' });
  if (!authenticatedUserId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  let capability: string | null;
  try {
    capability = await getVoiceLabSessionReadCapability(authenticatedUserId);
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    throw error;
  }
  const capabilityOnly = Boolean(capability);
  const authHeader = capabilityOnly
    ? ''
    : await getUserScopedAuthHeader({ voiceLabAccess: 'governed' });
  if (!capabilityOnly && !authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const url = new URL(`${BACKEND_URL}/api/threads/${encodeURIComponent(threadId)}/artifacts`);
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const execute = (authorization?: string) => fetch(url.toString(), {
    method: 'GET',
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(capability ? { [VOICE_LAB_CAPABILITY_HEADER]: capability } : {}),
    },
    cache: 'no-store',
  });

  let backendResponse = await execute(authHeader || undefined);

  if (!capabilityOnly && backendResponse.status === 401) {
    const refreshedAuthHeader = await refreshUserScopedAuthHeader({ voiceLabAccess: 'governed' });
    if (refreshedAuthHeader && refreshedAuthHeader !== authHeader) {
      backendResponse = await execute(refreshedAuthHeader);
    }
  }

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    headers: copyResponseHeaders(backendResponse.headers),
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  return proxyArtifactListRequest(req, threadId);
}
