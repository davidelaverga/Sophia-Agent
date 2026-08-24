import { type NextRequest } from 'next/server';

import {
  authorizeGeminiProductionUser,
  geminiProductionVoiceLabFailure,
  geminiProductionVoiceLabHeaders,
  proxyGeminiProductionResponse,
} from '../_lib';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authorizeGeminiProductionUser();

  if ('response' in auth) {
    return auth.response;
  }

  try {
    return proxyGeminiProductionResponse(
      `/api/sophia/${encodeURIComponent(auth.userId)}/voice/gemini/relay${req.nextUrl.search}`,
      {
        method: 'POST',
        headers: await geminiProductionVoiceLabHeaders(auth.userId, 'mutate'),
        body: await req.text(),
      },
    );
  } catch (error) {
    const failure = geminiProductionVoiceLabFailure(error);
    if (failure) return failure;
    throw error;
  }
}
