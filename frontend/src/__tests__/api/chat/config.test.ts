import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadChatConfig() {
  vi.resetModules();
  return import('../../../app/api/chat/_lib/config');
}

describe('chat config', () => {
  const originalSophiaBaseUrl = process.env.SOPHIA_LANGGRAPH_BASE_URL;
  const originalPublicBaseUrl = process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL;

  afterEach(() => {
    if (originalSophiaBaseUrl === undefined) {
      delete process.env.SOPHIA_LANGGRAPH_BASE_URL;
    } else {
      process.env.SOPHIA_LANGGRAPH_BASE_URL = originalSophiaBaseUrl;
    }

    if (originalPublicBaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL = originalPublicBaseUrl;
    }
  });

  it('defaults to the nginx langgraph proxy endpoint', async () => {
    delete process.env.SOPHIA_LANGGRAPH_BASE_URL;
    delete process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL;

    const { BACKEND_URL } = await loadChatConfig();

    expect(BACKEND_URL).toBe('http://localhost:2026/api/langgraph');
  });

  it('prefers the server-side langgraph override when provided', async () => {
    process.env.SOPHIA_LANGGRAPH_BASE_URL = 'http://127.0.0.1:2024';
    process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL = 'http://localhost:2026/api/langgraph';

    const { BACKEND_URL } = await loadChatConfig();

    expect(BACKEND_URL).toBe('http://127.0.0.1:2024');
  });

  it('falls back to the public langgraph override before the default', async () => {
    delete process.env.SOPHIA_LANGGRAPH_BASE_URL;
    process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL = 'https://example.com/api/langgraph';

    const { BACKEND_URL } = await loadChatConfig();

    expect(BACKEND_URL).toBe('https://example.com/api/langgraph');
  });
});