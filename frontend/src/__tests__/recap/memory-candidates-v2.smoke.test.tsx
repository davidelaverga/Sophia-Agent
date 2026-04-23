import { act } from '@testing-library/react';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/recap/test-session',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ sessionId: 'test-session' }),
}));

import { RecapMemoryOrbit } from '../../app/components/recap/RecapMemoryOrbit';
import { mapBackendArtifactsToRecapV1 } from '../../app/lib/artifacts-adapter';
import RecapPage from '../../app/recap/[sessionId]/page';
import { useRecapStore } from '../../app/stores/recap-store';

function createRenderTarget() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

async function flush() {
  await Promise.resolve();
}

async function renderInto(root: Root, element: React.ReactElement) {
  await act(async () => {
    root.render(element);
    await flush();
  });
}

async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await flush();
  });
}

async function clickButton(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await flush();
  });
}

async function waitForText(container: HTMLElement, text: string, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await advanceTimers(50);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

function findButtonByAria(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button as HTMLButtonElement;
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === text
  );
  if (!button) throw new Error(`Button not found with text: ${text}`);
  return button;
}

describe('Memory Candidates v2 smoke', () => {
  beforeEach(() => {
    useRecapStore.setState({
      artifacts: {},
      decisions: {},
      commitStatus: {},
    });
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('normalizes adapter payload with backward compatibility (text ?? memory, category default general)', () => {
    const mapped = mapBackendArtifactsToRecapV1(
      {
        session_id: 'test-session',
        takeaway: 'Takeaway',
        memory_candidates: [
          {
            id: 'mem-new',
            text: 'New shape memory',
            category: 'emotional_patterns',
            created_at: '2026-02-20T14:30:00Z',
          },
          {
            memory: 'Legacy shape memory',
          },
        ],
      },
      'test-session'
    );

    expect(mapped).not.toBeNull();
    expect(mapped?.memoryCandidates?.[0]).toMatchObject({
      id: 'mem-new',
      text: 'New shape memory',
      category: 'emotional_patterns',
      created_at: '2026-02-20T14:30:00Z',
    });
    expect(mapped?.memoryCandidates?.[1]).toMatchObject({
      text: 'Legacy shape memory',
      category: 'general',
    });
  });

  it('accept does not fire network and persists reviewed state after refresh; empty state message renders', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/sophia/sessions/test-session/recap') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            session_id: 'test-session',
            takeaway: 'Session takeaway',
            reflection_candidate: { prompt: 'Reflect', tag: 'growth' },
            memory_candidates: [
              { id: 'mem-1', text: 'I value calm focus', category: 'goals', created_at: '2026-02-20T14:30:00Z' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const firstRender = createRenderTarget();
    await renderInto(firstRender.root, <RecapPage />);

    await waitForText(firstRender.container, 'I value calm focus');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await clickButton(findButtonByAria(firstRender.container, 'Keep this memory'));
    await advanceTimers(1600);

    const fetchCountAfterAccept = fetchMock.mock.calls.length;
    expect(fetchCountAfterAccept).toBe(1);

    await act(async () => {
      firstRender.root.unmount();
      firstRender.container.remove();
      await flush();
    });

    const secondRender = createRenderTarget();
    await renderInto(secondRender.root, <RecapPage />);

    await waitForText(secondRender.container, 'All memories reviewed');
    // The second render reads persisted artifacts from the zustand store and
    // may perform at most one additional hydration fetch; the crucial invariant
    // is that the reviewed state persists across unmount/remount.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);

    await act(async () => {
      secondRender.root.unmount();
      secondRender.container.remove();
      await flush();
    });

    const emptyRender = createRenderTarget();
    await renderInto(
      emptyRender.root,
      <RecapMemoryOrbit
        candidates={[]}
        decisions={{}}
        onDecisionChange={() => {}}
      />
    );
    expect(emptyRender.container.textContent).toContain('No new memories from this session.');
  });

  it('discard persists review status for real ids, skips network for legacy candidate-* id, and shows retry UI on failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/api/sophia/sessions/test-session/recap') && method === 'GET') {
        return new Response(
          JSON.stringify({
            session_id: 'test-session',
            takeaway: 'Session takeaway',
            reflection_candidate: { prompt: 'Reflect', tag: 'growth' },
            memory_candidates: [
              { id: 'mem-real', text: 'Real memory candidate', category: 'identity' },
              { id: 'candidate-legacy-1', text: 'Legacy candidate', category: 'general' },
              { id: 'mem-fail', text: 'Will fail to delete', category: 'general' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/memories/mem-real') && method === 'PUT') {
        return new Response(JSON.stringify({ status: 'deleted' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.endsWith('/api/memories/mem-fail') && method === 'PUT') {
        return new Response(JSON.stringify({ error: 'failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const renderState = createRenderTarget();
    await renderInto(renderState.root, <RecapPage />);

    await waitForText(renderState.container, 'Real memory candidate');

    await clickButton(findButtonByAria(renderState.container, 'Let this memory go'));
    await advanceTimers(700);

    await waitForText(renderState.container, 'Legacy candidate');
    expect(renderState.container.textContent).not.toContain('Real memory candidate');

    const firstDiscardCalls = fetchMock.mock.calls.filter(([request, init]) =>
      String(request).endsWith('/api/memories/mem-real') && (init?.method || 'GET') === 'PUT'
    );
    expect(firstDiscardCalls).toHaveLength(1);
    expect(firstDiscardCalls[0]?.[1]).toMatchObject({
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(firstDiscardCalls[0]?.[1]?.body))).toEqual({
      metadata: {
        status: 'discarded',
        category: 'identity',
      },
    });

    await clickButton(findButtonByAria(renderState.container, 'Let this memory go'));
    await advanceTimers(700);

    const legacyDiscardCalls = fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes('/api/memories/candidate-legacy-1') && (init?.method || 'GET') === 'PUT'
    );
    expect(legacyDiscardCalls).toHaveLength(0);

    await waitForText(renderState.container, 'Will fail to delete');
    await clickButton(findButtonByAria(renderState.container, 'Let this memory go'));
    await advanceTimers(700);

    await waitForText(renderState.container, "Couldn't remove this memory. Try again?");
    expect(findButtonByText(renderState.container, 'Retry')).toBeTruthy();

    errorSpy.mockRestore();
  });
});
