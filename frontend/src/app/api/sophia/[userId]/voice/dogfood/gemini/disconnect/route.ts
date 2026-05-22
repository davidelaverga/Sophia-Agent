import { type NextRequest } from 'next/server';

import { authorizeGeminiDogfoodUser, proxyGeminiDogfoodResponse } from '../_lib';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const auth = await authorizeGeminiDogfoodUser(userId);

  if ('response' in auth) {
    return auth.response;
  }

  return proxyGeminiDogfoodResponse(
    `/api/sophia/${encodeURIComponent(userId)}/voice/dogfood/gemini/disconnect${req.nextUrl.search}`,
    {
      method: 'POST',
      body: await req.text(),
      keepalive: true,
    },
  );
}