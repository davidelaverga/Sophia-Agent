/**
 * Health Check API Route
 * Sprint 1+ - Connectivity Monitoring
 * 
 * Simple endpoint for frontend to check if:
 * 1. Vercel/Next.js is responding
 * 2. Backend is reachable (optional deep check)
 * 
 * Used by useConnectivity hook for offline detection.
 */

import { NextRequest, NextResponse } from 'next/server';

// Backend URL for deep health check - check multiple env vars
const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || '';
const BACKEND_HEALTH = '/health'; // Backend uses /health not /api/v1/health

export async function GET(req: NextRequest) {
  const deep = req.nextUrl.searchParams.get('deep') === 'true';
  
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    frontend: 'healthy',
    backend: 'unknown' as 'healthy' | 'unhealthy' | 'unknown',
  };
  
  // Deep check: also ping backend
  if (deep && BACKEND_URL) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const backendResponse = await fetch(`${BACKEND_URL}${BACKEND_HEALTH}`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      health.backend = backendResponse.ok ? 'healthy' : 'unhealthy';
    } catch {
      health.backend = 'unhealthy';
    }
  }
  
  // If deep check and backend unhealthy, return 503
  if (deep && health.backend === 'unhealthy') {
    return NextResponse.json(health, { status: 503 });
  }
  
  return NextResponse.json(health, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
