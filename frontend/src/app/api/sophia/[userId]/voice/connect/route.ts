import { NextRequest, NextResponse } from 'next/server';

import { getServerAuthHeader } from '../../../../../lib/auth/server-auth';

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8001';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const url = new URL(`${BACKEND_URL}/api/sophia/${encodeURIComponent(userId)}/voice/connect`);

  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const backendResponse = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getServerAuthHeader(),
    },
    body: await req.text(),
  });

  const responseText = await backendResponse.text();

  return new NextResponse(responseText, {
    status: backendResponse.status,
    headers: {
      'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
    },
  });
}