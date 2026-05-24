import { describe, expect, it, vi } from 'vitest';

async function getContentSecurityPolicy(): Promise<string> {
  vi.resetModules();
  const nextConfigModule = await import('../../next.config.js');
  const nextConfig = nextConfigModule.default ?? nextConfigModule;
  const headerEntries = await nextConfig.headers();
  const rootHeaders = headerEntries.find((entry: { source: string }) => entry.source === '/(.*)')?.headers ?? [];
  const policy = rootHeaders.find((header: { key: string }) => header.key === 'Content-Security-Policy')?.value;

  if (typeof policy !== 'string') {
    throw new Error('Content-Security-Policy header was not found.');
  }

  return policy;
}

describe('frontend security headers', () => {
  it('allows the direct OpenAI Realtime browser call without widening connect-src beyond the required origin', async () => {
    const policy = await getContentSecurityPolicy();

    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain('https://api.openai.com');
    expect(policy).not.toContain('https://*.openai.com');
    expect(policy).toContain('http://localhost:8000');
    expect(policy).toContain('http://localhost:8001');
    expect(policy).toContain('https://api.cartesia.ai');
  });

  it('allows the direct Gemini Live browser WebSocket without widening connect-src beyond the required origin', async () => {
    const policy = await getContentSecurityPolicy();

    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain('wss://generativelanguage.googleapis.com');
    expect(policy).not.toContain('wss://*.googleapis.com');
  });
});