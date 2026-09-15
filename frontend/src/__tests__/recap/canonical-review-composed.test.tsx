import { readFileSync } from 'node:fs';

import { act, renderHook, waitFor } from '@testing-library/react';
import { type NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }));
vi.mock('../../app/api/_lib/sophia', () => ({ fetchSophiaApi: upstream, resolveSophiaUserId: async () => 'review-owner' }));
vi.mock('../../app/stores/session-history-store', () => ({ useSessionHistoryStore: { getState: () => ({ markRecapViewed: vi.fn(), getSession: () => undefined }) } }));
vi.mock('../../app/lib/error-logger', () => ({ logger: { logError: vi.fn() } }));

import { GET as recentGET } from '../../app/api/memory/recent/route';
import { GET } from '../../app/api/sophia/sessions/[sessionId]/recap/route';
import { useRecapArtifactsLoader } from '../../app/recap/[sessionId]/useRecapArtifactsLoader';

describe.skipIf(!process.env.MEM00_REVIEW_COMPOSED_FIXTURE)('actual SQL -> Gateway -> Next -> recap', () => {
  it('preserves the same complete snapshot through the scoped recent proxy, ignoring competing copies', async () => {
    const fixturePath = process.env.MEM00_REVIEW_COMPOSED_FIXTURE;
    if (!fixturePath) throw new Error('Synthetic composed fixture is required');
    const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    let cursor: string | null = null;
    const observed: unknown[] = [];
    upstream.mockReset();
    for (const page of payload.recent_pages) {
      upstream.mockImplementationOnce(async (url: string) => {
        const parsed = new URL(url, 'https://synthetic.invalid');
        expect(parsed.pathname).toBe('/api/sophia/review-owner/memories/recent');
        expect(parsed.searchParams.get('session_id')).toBe('review-session');
        expect(parsed.searchParams.get('cursor')).toBe(cursor);
        expect(parsed.searchParams.get('page_size')).toBe('100');
        return new Response(JSON.stringify({ ...page, memories: [{ id: 'untrusted-copy', content: 'COMPETING_PRIVATE_COPY' }] }));
      });
      const query = new URLSearchParams({ session_id: 'review-session', status: 'pending_review', page_size: '100' });
      if (cursor) query.set('cursor', cursor);
      const response = await recentGET({ nextUrl: new URL(`http://synthetic.invalid/api/memory/recent?${query}`) } as NextRequest);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain('COMPETING_PRIVATE_COPY');
      expect(body.memory_review.snapshot_id).toBe(page.memory_review.snapshot_id);
      expect(body.memory_review.candidates).toEqual(page.memory_review.candidates);
      observed.push(...body.memories.map((item: { id: string; candidate_revision: number }) => [item.id, item.candidate_revision]));
      cursor = body.memory_review.next_cursor;
    }
    expect(cursor).toBeNull();
    expect(observed).toHaveLength(1005);
    expect(observed).toEqual(payload.http_pages.flatMap((page: { memory_review: { candidates: Array<{ candidate_id: string; candidate_revision: number }> } }) =>
      page.memory_review.candidates.map((item) => [item.candidate_id, item.candidate_revision])));
    expect(upstream).toHaveBeenCalledTimes(11);
    upstream.mockReset();
  });
  it('preserves all 1005 exact revisions in one snapshot and never consults a derivative/provider fallback', async () => {
    const fixturePath = process.env.MEM00_REVIEW_COMPOSED_FIXTURE;
    if (!fixturePath) throw new Error('Synthetic composed fixture is required');
    const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const pages = payload.http_pages as Array<{ memory_review: { next_cursor: string | null; candidates: Array<{ candidate_id: string; candidate_revision: number }> } }>;
    const byCursor = new Map<string | null, unknown>([[null, pages[0]]]);
    for (let i = 1; i < pages.length; i++) byCursor.set(pages[i - 1].memory_review.next_cursor, pages[i]);
    upstream.mockImplementation(async (url: string) => {
      const parsed = new URL(url, 'https://synthetic.invalid');
      expect(parsed.pathname).toBe('/api/sophia/review-owner/sessions/review-session/recap');
      const page = byCursor.get(parsed.searchParams.get('cursor'));
      expect(page).toBeDefined();
      return new Response(JSON.stringify(page));
    });
    const fetchMock = vi.fn(async (url: string) => {
      const nextUrl = new URL(url, 'http://synthetic.invalid');
      expect(nextUrl.pathname).toBe('/api/sophia/sessions/review-session/recap');
      const result = await GET({ nextUrl } as NextRequest, { params: Promise.resolve({ sessionId: 'review-session' }) });
      expect(result.headers.get('cache-control')).toBe('no-store');
      return result;
    });
    vi.stubGlobal('fetch', fetchMock);
    const setArtifacts = vi.fn();
    const hook = renderHook(() => useRecapArtifactsLoader({ sessionId: 'review-session', artifacts: null, setArtifacts }));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe('ready'));
      expect(setArtifacts).toHaveBeenCalledTimes(1);
      const candidates = setArtifacts.mock.calls[0][1].memoryCandidates as Array<{ id: string; candidateRevision: number }>;
      expect(candidates.map((item) => [item.id, item.candidateRevision])).toEqual(pages.flatMap((page) => page.memory_review.candidates.map((item) => [item.candidate_id, item.candidate_revision])));
      expect(candidates).toHaveLength(1005);
      expect(fetchMock).toHaveBeenCalledTimes(11);
      expect(upstream).toHaveBeenCalledTimes(11);
    } finally {
      await act(async () => hook.unmount());
      vi.unstubAllGlobals();
    }
  });
});
