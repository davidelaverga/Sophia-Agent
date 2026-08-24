import { NextResponse } from 'next/server';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../_lib/sophia';
import {
  getVoiceLabEndSessionCapability,
  getVoiceLabSessionCreateCapability,
  VOICE_LAB_CAPABILITY_HEADER,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

type GeminiProductionAuthResult = { userId: string } | { response: NextResponse };

export async function authorizeGeminiProductionUser(): Promise<GeminiProductionAuthResult> {
  const userId = await resolveSophiaUserId({ voiceLabAccess: 'governed' });

  if (!userId) {
    return {
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }

  return { userId };
}

export async function geminiProductionVoiceLabHeaders(
  userId: string,
  operation: 'mutate' | 'finalize',
): Promise<Record<string, string>> {
  const capability = operation === 'mutate'
    ? await getVoiceLabSessionCreateCapability(userId)
    : await getVoiceLabEndSessionCapability(userId);
  return capability ? { [VOICE_LAB_CAPABILITY_HEADER]: capability } : {};
}

export function geminiProductionVoiceLabFailure(error: unknown): NextResponse | null {
  return error instanceof VoiceLabCapabilityError
    ? NextResponse.json({ error: error.code }, { status: error.status })
    : null;
}

function safePrefix(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, 24) : null;
}

function safeRelayRequestContext(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string' || !body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      session_id_prefix: safePrefix(parsed.session_id),
      relay_correlation_id: safePrefix(parsed.relay_correlation_id),
      provider_receive_sequence: parsed.provider_receive_sequence,
      provider_relay_sequence: parsed.provider_relay_sequence,
      provider_primary_category: parsed.provider_primary_category,
      provider_categories: Array.isArray(parsed.provider_categories)
        ? parsed.provider_categories.filter((item) => typeof item === 'string').slice(0, 6)
        : undefined,
    };
  } catch {
    return { request_body_parse_failed: true };
  }
}

function safeErrorDetail(responseText: string): string | null {
  if (!responseText) {
    return null;
  }
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const detail = parsed.detail;
    return typeof detail === 'string' ? detail.slice(0, 240) : null;
  } catch {
    return null;
  }
}

function safeRouteLabel(path: string): string {
  return path.split('?')[0].replace(/\/api\/sophia\/[^/]+\/voice\//, '/api/sophia/{user_id}/voice/');
}

export async function proxyGeminiProductionResponse(path: string, init: RequestInit): Promise<NextResponse> {
  const relayContext = path.includes('/voice/gemini/relay')
    ? safeRelayRequestContext(init.body)
    : {};
  const backendResponse = await fetchSophiaApi(path, init, { voiceLabAccess: 'governed' });
  const responseText = await backendResponse.text();

  if (path.includes('/voice/gemini/relay') && backendResponse.status >= 400) {
    console.warn('[sophia] gemini production relay failed', {
      route: safeRouteLabel(path),
      backend_status: backendResponse.status,
      ...relayContext,
      safe_detail: safeErrorDetail(responseText),
    });
  }

  return new NextResponse(responseText || null, {
    status: backendResponse.status,
    headers: responseText
      ? {
          'Content-Type': backendResponse.headers.get('content-type') ?? 'application/json',
        }
      : undefined,
  });
}
