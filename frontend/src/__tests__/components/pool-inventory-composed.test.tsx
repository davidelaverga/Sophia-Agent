import { readFileSync } from 'node:fs';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }));
vi.mock('../../app/api/_lib/sophia', () => ({ fetchSophiaApi: upstream, resolveSophiaUserId: async () => 'inventory-owner' }));
vi.mock('../../app/providers', () => ({ useAuth: () => ({ user: { id: 'inventory-owner' }, loading: false }) }));
vi.mock('../../app/hooks/useVisualTier', () => ({ useVisualTier: () => ({ tier: 'low', dprCap: 1, reducedMotion: true }) }));
vi.mock('../../app/hooks/useHaptics', () => ({ haptic: vi.fn() }));
vi.mock('../../app/lib/error-logger', () => ({ logger: { logError: vi.fn() } }));
import { GET } from '../../app/api/journal/route';
import { JournalPageClient } from '../../app/journal/JournalPageClient';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe.skipIf(!process.env.MEM00_INVENTORY_COMPOSED_FIXTURE)('SQL -> Gateway -> Next -> ordinary complete Journal shelves', () => {
  it('renders all804active and201forgotten current rows, without implying indexing readiness', async () => {
    const payload = JSON.parse(readFileSync(process.env.MEM00_INVENTORY_COMPOSED_FIXTURE, 'utf8'));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    upstream.mockImplementation(async (path: string, options: RequestInit) => {
      expect(options.method).toBe('GET');
      const url = new URL(path, 'https://synthetic.invalid');
      expect(url.pathname).toBe('/api/sophia/inventory-owner/journal');
      return new Response(JSON.stringify(payload.pool_views.find((value: { view: string }) => value.view === (url.searchParams.get('status') ?? 'active'))));
    });
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      expect(options.method).toBe('GET'); expect(options.cache).toBe('no-store');
      const response = await GET(new NextRequest('https://synthetic.invalid' + path, options));
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      return response;
    }));
    render(<JournalPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'List view' }));
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(804);
    expect(screen.getByText(/Search indexing status unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forgotten' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(201));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByText(payload.pool_views[0].entries[0].content)).not.toBeInTheDocument();
    expect(screen.getAllByText(payload.pool_views[1].entries.at(-1).content).length).toBeGreaterThan(0);
    expect(JSON.stringify(Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index))))).not.toContain('CURRENT_CANONICAL_');
    expect(upstream).toHaveBeenCalledTimes(2);
  }, 20000);
});
