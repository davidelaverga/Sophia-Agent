/**
 * Sessions Proxy API Route
 * Proxies /api/sessions/* -> backend /api/v1/sessions/*
 */

import { type NextRequest, NextResponse } from 'next/server';

import { getUserScopedAuthHeader } from '../../../lib/auth/server-auth';
import { debugLog } from '../../../lib/debug-logger';
import { getPrimaryGatewayUrl } from '../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();

async function proxyRequest(req: NextRequest, pathSegments: string[]) {
  const path = pathSegments.join('/');
  const url = new URL(`${BACKEND_URL}/api/v1/sessions/${path}`);
  const authHeader = await getUserScopedAuthHeader();

  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  
  debugLog('sessions proxy', 'Request', { method: req.method, path, url: url.toString() });

  // Preserve query params
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  // 🔒 SECURITY: Read token from httpOnly cookie server-side
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'Authorization': authHeader,
  };

  const method = req.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await req.text();

  const backendResponse = await fetch(url.toString(), {
    method,
    headers,
    body,
  });

  const responseText = await backendResponse.text();
  
  debugLog('sessions proxy', 'Response', {
    status: backendResponse.status,
    preview: responseText.slice(0, 200),
  });

  return new NextResponse(responseText, {
    status: backendResponse.status,
    headers: {
      'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
    },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyRequest(req, path || []);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyRequest(req, path || []);
}
