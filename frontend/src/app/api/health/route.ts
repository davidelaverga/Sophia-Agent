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

import { type NextRequest, NextResponse } from 'next/server';

import { getHealthTargetUrls } from '../_lib/gateway-url';

const BACKEND_HEALTH_PATHS = ['/health', '/ok'];

async function checkDeepHealth() {
  const targetUrls = getHealthTargetUrls();

  if (targetUrls.length === 0) {
    return {
      backend: 'unknown' as const,
      backendTarget: null,
    };
  }

  for (const baseUrl of targetUrls) {
    for (const healthPath of BACKEND_HEALTH_PATHS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const backendResponse = await fetch(`${baseUrl}${healthPath}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (backendResponse.ok) {
          return {
            backend: 'healthy' as const,
            backendTarget: `${baseUrl}${healthPath}`,
          };
        }
      } catch {
        // Try the next known health target.
      }
    }
  }

  return {
    backend: 'unhealthy' as const,
    backendTarget: null,
  };
}

export async function GET(req: NextRequest) {
  const deep = req.nextUrl.searchParams.get('deep') === 'true';
  
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    frontend: 'healthy',
    backendTarget: null as string | null,
    backend: 'unknown' as 'healthy' | 'unhealthy' | 'unknown',
  };
  
  if (deep) {
    const deepHealth = await checkDeepHealth();
    health.backend = deepHealth.backend;
    health.backendTarget = deepHealth.backendTarget;
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
