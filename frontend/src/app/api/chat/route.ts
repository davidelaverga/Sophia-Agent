export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';

import { handleChatPost } from './_lib/post-handler';

export async function POST(req: NextRequest) {
  return handleChatPost(req);
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin');

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
