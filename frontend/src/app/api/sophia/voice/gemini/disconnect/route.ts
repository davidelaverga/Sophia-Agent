import { type NextRequest, NextResponse } from 'next/server';

import {
  isOpaqueVoiceLabProviderCleanupToken,
  VOICE_LAB_PROVIDER_CLEANUP_HEADER,
} from '@/app/lib/voice-lab-provider-cleanup';

import {
  getVoiceLabPrincipalConfig,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

import {
  authorizeGeminiProductionUser,
  geminiProductionVoiceLabFailure,
  geminiProductionVoiceLabHeaders,
  proxyGeminiProductionResponse,
} from '../_lib';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const providerCleanupToken = req.headers?.get(
      VOICE_LAB_PROVIDER_CLEANUP_HEADER,
    ) ?? null;
    if (
      providerCleanupToken
      && !isOpaqueVoiceLabProviderCleanupToken(providerCleanupToken)
    ) {
      return NextResponse.json(
        { error: 'voice_lab_provider_cleanup_malformed' },
        { status: 401 },
      );
    }
    // The settlement-only authority deliberately outlives the interactive
    // context capability. Route it only to the configured dedicated
    // principal; the Gateway verifies the signed token and exact product
    // binding before the handler can mutate anything.
    const auth = providerCleanupToken
      ? { userId: getVoiceLabPrincipalConfig().principalId }
      : await authorizeGeminiProductionUser();
    if ('response' in auth) {
      return auth.response;
    }
    const headers = providerCleanupToken
      ? { [VOICE_LAB_PROVIDER_CLEANUP_HEADER]: providerCleanupToken }
      : await geminiProductionVoiceLabHeaders(auth.userId, 'finalize');
    return proxyGeminiProductionResponse(
      `/api/sophia/${encodeURIComponent(auth.userId)}/voice/gemini/disconnect${req.nextUrl.search}`,
      {
        method: 'POST',
        headers,
        body: await req.text(),
        keepalive: true,
      },
    );
  } catch (error) {
    const failure = geminiProductionVoiceLabFailure(error);
    if (failure) return failure;
    if (error instanceof VoiceLabCapabilityError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    throw error;
  }
}
