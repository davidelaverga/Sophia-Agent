import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import {
  middleware,
  voiceLabFrontendApiAccessAllowed,
} from '../../middleware';

const CONTEXT_COOKIE = '__Host-sophia-voice-lab-context=opaque';
const RUN_BINDING_COOKIE = '__Host-sophia-voice-lab-run-binding=opaque';

function request(path: string, method = 'POST', synthetic = true): NextRequest {
  return new NextRequest(`https://sophia.example.test${path}`, {
    method,
    headers: synthetic ? { cookie: CONTEXT_COOKIE } : undefined,
  });
}

describe('Voice Lab same-origin API default deny', () => {
  it.each([
    ['/api/ws-ticket', 'POST'],
    ['/api/memory/save', 'POST'],
    ['/api/memory/recent', 'GET'],
    ['/api/journal', 'GET'],
    ['/api/reflections/create', 'POST'],
    ['/api/conversation/feedback', 'POST'],
    ['/api/privacy/consent', 'POST'],
    ['/api/sophia/voice/dogfood/gemini/browser-session', 'POST'],
    ['/api/sophia/lab-user/voice/dogfood/openai/browser-session', 'POST'],
    ['/api/sophia/lab-user/voice/warmup', 'POST'],
    ['/api/sophia/voice/gemini/activate', 'GET'],
    ['/api/sophia/voice/gemini/events', 'POST'],
    ['/api/sophia/tasks/task-1/cancel', 'POST'],
    ['/api/sophia/lab-user/telegram/link', 'POST'],
    ['/api/threads/thread-1/uploads', 'POST'],
    ['/api/artifacts/upsert', 'POST'],
  ])('blocks %s before its route handler can allocate', async (path, method) => {
    const response = middleware(request(path, method));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'voice_lab_ordinary_product_route_forbidden',
    });
  });

  it.each([
    ['/api/sessions/start', 'POST'],
    ['/api/sophia/lab-user/voice/connect', 'POST'],
    ['/api/sophia/voice/gemini/relay', 'POST'],
    ['/api/sophia/voice/gemini/activate', 'POST'],
    ['/api/sophia/builder/threads/thread-1/canvas/snapshot', 'GET'],
    ['/api/threads/thread-1/artifacts/mnt/user-data/outputs/page.html', 'GET'],
    ['/api/voice-lab/auth/cleanup', 'POST'],
  ])('admits only a governed route for its downstream capability check: %s', (path, method) => {
    expect(voiceLabFrontendApiAccessAllowed(method, path)).toBe(true);
    expect(middleware(request(path, method)).status).toBe(200);
  });

  it('allows the exact post-grant Better Auth session probe and keeps legacy auth-me denied', async () => {
    const headers = {
      cookie: `${CONTEXT_COOKIE}; ${RUN_BINDING_COOKIE}`,
    };
    const governed = middleware(new NextRequest(
      'https://sophia.example.test/api/auth/get-session',
      { method: 'GET', headers },
    ));
    expect(governed.status).toBe(200);

    const legacy = middleware(new NextRequest(
      'https://sophia.example.test/api/auth/me',
      { method: 'GET', headers },
    ));
    expect(legacy.status).toBe(403);
    await expect(legacy.json()).resolves.toEqual({
      error: 'voice_lab_ordinary_product_route_forbidden',
    });
  });

  it('preserves ordinary API compatibility byte-for-byte at this boundary', () => {
    const response = middleware(request('/api/memory/save', 'POST', false));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
