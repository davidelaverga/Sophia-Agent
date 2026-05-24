import { type NextRequest } from 'next/server';

import { authorizeOpenAIDogfoodUser, proxyOpenAIDogfoodResponse } from '../_lib';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const auth = await authorizeOpenAIDogfoodUser(userId);

  if ('response' in auth) {
    return auth.response;
  }

  return proxyOpenAIDogfoodResponse(
    `/api/sophia/${encodeURIComponent(userId)}/voice/dogfood/openai/browser-session${req.nextUrl.search}`,
    {
      method: 'POST',
      body: await req.text(),
    },
  );
}
