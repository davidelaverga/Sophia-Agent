/**
 * Bootstrap Proxy API Route
 * Proxies /api/bootstrap/* -> backend /api/v1/bootstrap/*
 * 
 * Endpoints:
 * - GET /api/bootstrap/opener - Get pre-computed session opener
 * - GET /api/bootstrap/status - Check if opener is available
 * - GET /api/bootstrap/health - Health check
 */

import { type NextRequest, NextResponse } from 'next/server';

import { getServerAuthHeader } from '../../../lib/auth/server-auth';
import { debugLog } from '../../../lib/debug-logger';
import { logger } from '../../../lib/error-logger';

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8001';

async function proxyRequest(req: NextRequest, pathSegments: string[]) {
  const path = pathSegments.join('/');
  const url = new URL(`${BACKEND_URL}/api/v1/bootstrap/${path}`);
  
  debugLog('bootstrap proxy', 'Request', { method: req.method, path, url: url.toString() });

  // Preserve query params
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  // 🔒 SECURITY: Read token from httpOnly cookie server-side
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'Authorization': await getServerAuthHeader(),
  };

  try {
    const backendResponse = await fetch(url.toString(), {
      method: req.method,
      headers,
    });

    const responseText = await backendResponse.text();
    
    debugLog('bootstrap proxy', 'Response', {
      status: backendResponse.status,
      preview: responseText.slice(0, 200),
    });

    return new NextResponse(responseText, {
      status: backendResponse.status,
      headers: {
        'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    logger.logError(error, { component: 'api/bootstrap', action: 'proxy_request' });
    return NextResponse.json(
      { error: 'Failed to connect to backend', has_opener: false },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyRequest(req, path || []);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyRequest(req, path || []);
}
