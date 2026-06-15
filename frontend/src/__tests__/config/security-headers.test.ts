import { describe, expect, it } from 'vitest';

// next.config.js is CommonJS at the frontend root.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = require('../../../next.config.js');

type HeaderKV = { key: string; value: string };
type HeaderEntry = { source: string; headers: HeaderKV[] };

function headerValue(entry: HeaderEntry, key: string): string | undefined {
  return entry.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
}

describe('next.config security headers — artifact preview framing (PR #131 P2)', () => {
  it('lets the artifact preview content route be framed same-origin', async () => {
    const entries: HeaderEntry[] = await nextConfig.headers();

    const contentEntry = entries.find(
      (e) => e.source === '/api/artifacts/:artifactId/content',
    );
    expect(contentEntry, 'dedicated content-route header entry must exist').toBeDefined();

    // Same-origin framing allowed (the Observatory frames its own preview)…
    expect(headerValue(contentEntry, 'X-Frame-Options')).toBe('SAMEORIGIN');
    const contentCsp = headerValue(contentEntry, 'Content-Security-Policy') ?? '';
    expect(contentCsp).toContain("frame-ancestors 'self'");
    // …but cross-origin embedding stays blocked.
    expect(contentCsp).not.toContain("frame-ancestors 'none'");

    // The content route must still carry the rest of the hardening headers.
    expect(headerValue(contentEntry, 'X-Content-Type-Options')).toBe('nosniff');
    expect(contentCsp).toContain("default-src 'self'");
  });

  it('keeps every other route fully frame-denied and excludes the content route', async () => {
    const entries: HeaderEntry[] = await nextConfig.headers();

    const catchAll = entries.find(
      (e) => e.source.startsWith('/(') && headerValue(e, 'X-Frame-Options') !== undefined,
    );
    expect(catchAll, 'catch-all security entry must exist').toBeDefined();

    expect(headerValue(catchAll, 'X-Frame-Options')).toBe('DENY');
    expect(headerValue(catchAll, 'Content-Security-Policy') ?? '').toContain(
      "frame-ancestors 'none'",
    );

    // The catch-all must no longer be a bare wildcard — it has to exclude the
    // content route so the relaxed entry above is the only one that matches it
    // (no header-precedence ambiguity).
    expect(catchAll.source).not.toBe('/(.*)');
    expect(catchAll.source).toContain('?!api/artifacts');
  });
});
