import { type NextRequest } from 'next/server';

import { authorizeGeminiProductionUser, proxyGeminiProductionResponse } from '../_lib';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authorizeGeminiProductionUser();

  if ('response' in auth) {
    return auth.response;
  }

  return proxyGeminiProductionResponse(
    `/api/sophia/${encodeURIComponent(auth.userId)}/voice/gemini/relay${req.nextUrl.search}`,
    {
      method: 'POST',
      body: await req.text(),
    },
  );
}