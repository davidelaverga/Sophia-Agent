import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, request } = vi.hoisted(() => ({ auth: { user: { id: 'user-123' } as { id: string } | null, loading: false, authScope: {} }, request: vi.fn() }));
vi.mock('../../app/providers', () => ({ useAuth: () => auth }));
vi.mock('../../app/hooks/useVisualTier', () => ({ useVisualTier: () => ({ tier: 'low', dprCap: 1, reducedMotion: true }) }));
vi.mock('../../app/hooks/useHaptics', () => ({ haptic: vi.fn() }));
vi.mock('../../app/lib/error-logger', () => ({ logger: { logError: vi.fn() } }));

import { JournalPageClient } from '../../app/journal/JournalPageClient';
import { readJournalCommandReferences } from '../../app/lib/journal-command-recovery';
import { inventoryRecord } from '../lib/inventory-fixture';
import { lifecycleResult } from '../lib/lifecycle-fixture';
import { poolFixture } from '../lib/pool-fixture';

const memory = inventoryRecord();
const initialEntry = { id: memory.id, content: 'INITIAL_CANONICAL_TEXT', category: 'fact', created_at: memory.created_at,
  metadata: { authority: 'sophia_canonical', lifecycle: 'active', scope: 'global', tier: 'none', projection_state: 'unavailable', content_revision: 2, memory_governance_revision: 3 } };
const response = (value: unknown, status = 200, owner = 'user-123', view?: 'active' | 'forgotten') => {
  const list = value as { entries?: typeof initialEntry[] };
  return new Response(JSON.stringify(Array.isArray(list.entries) ? poolFixture(list.entries, owner,
    view ?? (list.entries[0]?.metadata.lifecycle === 'forgotten' ? 'forgotten' : 'active')) : value), { status });
};
function commandResult(key: string, state = 'active') {
  const unavailable = state === 'unavailable' || state === 'not_found';
  return { schema: 'mem00.command-result.v1', owner_id: 'user-123', command_key: key, status: 'committed', historical_result_only: true,
    receipt: { event_id: '20000000-0000-4000-8000-000000000001', operation_id: 'original-edit-operation', event_type: 'memory_edited',
      resulting_lifecycle: 'active', memory_id: memory.id, content_revision: 3, memory_governance_revision: 4,
      user_catalog_generation: 4, user_revocation_epoch: 0, idempotent_replay: true },
    current_view: { schema: 'mem00.current-memory.v1', owner_id: 'user-123', memory_id: memory.id,
      status: unavailable ? state : 'available', lifecycle: unavailable ? null : state,
      content_revision: unavailable ? null : 4, memory_governance_revision: unavailable ? null : 6,
      memory: state === 'active' ? { ...memory, content: 'LATER_CANONICAL_TEXT', revision: 4, memory_governance_revision: 6 } : null,
      provider_state_queried: false, current_view_only: true } };
}
async function beginEdit() {
  await screen.findByRole('button', { name: 'List view' });
  fireEvent.click(screen.getByRole('button', { name: 'List view' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getAllByRole('textbox', { name: /Edit .*memory/ })[0], { target: { value: 'TRANSIENT_PRIVATE_DRAFT' } });
}
const save = () => fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
async function openLifecycle(action: 'forget' | 'restore' | 'delete') {
  const view = render(<JournalPageClient />);
  await screen.findByRole('button', { name: 'List view' });
  fireEvent.click(screen.getByRole('button', { name: 'List view' }));
  if (action !== 'forget') {
    request.mockResolvedValueOnce(response({ entries: [{ ...initialEntry, metadata: { ...initialEntry.metadata, lifecycle: 'forgotten' } }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Forgotten' }));
    await screen.findByRole('button', { name: 'Restore' });
  }
  if (action === 'delete') fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }));
  return view;
}
function submitLifecycle(action: 'forget' | 'restore' | 'delete') {
  fireEvent.click(screen.getAllByRole('button', { name: { forget: 'Forget', restore: 'Restore', delete: 'Delete memory' }[action] })[0]);
}

beforeEach(() => {
  auth.user = { id: 'user-123' }; auth.loading = false; auth.authScope = {}; request.mockReset(); vi.stubGlobal('fetch', request);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  request.mockResolvedValueOnce(response({ entries: [initialEntry] }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ordinary Journal command/current-state boundary', () => {
  it('does not reuse a late edit or draft across same-owner authentication rotation', async () => {
    let finish!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    request.mockResolvedValue(response({ error: 'recovery temporarily unavailable' }, 503));
    const view = render(<JournalPageClient />); await beginEdit(); save();
    const original = JSON.parse(request.mock.calls[1][1].body);
    auth.authScope = {}; view.rerender(<JournalPageClient />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
    await act(async () => finish(response(commandResult(original.idempotency_key))));
    expect(screen.queryByText('LATER_CANONICAL_TEXT')).not.toBeInTheDocument();
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([, options]) => options.method === 'PUT')).toHaveLength(1);
    expect(request.mock.calls[2][0]).toContain(encodeURIComponent(original.idempotency_key));
  });

  it('retires an old Pool request when the same owner receives a new authentication session', async () => {
    let finish!: (value: Response) => void;
    request.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response({ entries: [] }));
    const view = render(<JournalPageClient />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    auth.authScope = {}; view.rerender(<JournalPageClient />);
    await act(async () => finish(response({ entries: [initialEntry] })));
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
  });

  it.each(['storage', 'same-tab'])('fences Pool plaintext and drafts during an uncertain clear (%s)', async kind => {
    render(<JournalPageClient />); await beginEdit();
    const key = 'sophia.memory.clear-reference.v1:user-123';
    const notify = () => fireEvent(window, kind === 'storage' ? new StorageEvent('storage', { key })
      : new CustomEvent('sophia-memory-clear-reference', { detail: 'user-123' }));
    try {
      localStorage.setItem(key, 'clear-original-uncertain');
      notify();
      expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
      expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(1);
      fireEvent(window, new Event('focus'));
      expect(request).toHaveBeenCalledTimes(1);
      request.mockResolvedValueOnce(response({ entries: [] }));
      localStorage.removeItem(key); notify();
      await screen.findByText('No saved memories yet');
      expect(request).toHaveBeenCalledTimes(2);
      expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
    } finally { localStorage.removeItem(key); }
  });
  it('denies initial Pool loading when an unresolved clear reference exists', async () => {
    const key = 'sophia.memory.clear-reference.v1:user-123';
    try {
      localStorage.setItem(key, 'malformed-reference-is-still-a-fence');
      render(<JournalPageClient />);
      await screen.findByText('Journal unavailable');
      expect(request).not.toHaveBeenCalled();
    } finally { localStorage.removeItem(key); }
  });
  it('rejects a late pre-clear Pool response even when fetch ignores abort', async () => {
    const key = 'sophia.memory.clear-reference.v1:user-123';
    let finish!: (value: Response) => void;
    request.mockReset().mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    render(<JournalPageClient />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    try {
      localStorage.setItem(key, 'clear-original');
      fireEvent(window, new StorageEvent('storage', { key }));
      await act(async () => { finish(response({ entries: [initialEntry] })); });
      expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
      expect(screen.getByText(/Memory-clear recovery is pending/)).toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(1);
    } finally { localStorage.removeItem(key); }
  });
  it('fences a late response from before page suspension even for the same owner', async () => {
    let finish!: (value: Response) => void;
    request.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<JournalPageClient />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event('pagehide'));
    request.mockResolvedValueOnce(response({ entries: [{ ...initialEntry, content: 'FRESH_PAGE_RETURN' }] }));
    fireEvent(window, new Event('pageshow'));
    fireEvent.click(await screen.findByRole('button', { name: 'List view' }));
    await screen.findAllByText('FRESH_PAGE_RETURN');
    await act(async () => finish(response({ entries: [initialEntry] })));
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
    expect(screen.getAllByText('FRESH_PAGE_RETURN').length).toBeGreaterThan(0);
  });
  it('recovers a lost edit on page return by original-key GET, not another PUT', async () => {
    request.mockResolvedValueOnce(response({ error: 'lost response' }, 503));
    render(<JournalPageClient />); await beginEdit(); save();
    await screen.findAllByText("Couldn't update this memory right now.");
    const key = JSON.parse(request.mock.calls[1][1].body).idempotency_key;
    fireEvent(window, new Event('pagehide'));
    request.mockResolvedValueOnce(response({ status: 'committed', historical_result_only: true, receipt: commandResult(key).receipt }));
    request.mockResolvedValueOnce(response({ entries: [] }));
    fireEvent(window, new Event('pageshow'));
    await screen.findByText('No saved memories yet');
    expect(request.mock.calls[2][0]).toBe('/api/memory/commands/' + key);
    expect(request.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
    expect(readJournalCommandReferences('user-123')).toEqual([]);
    expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
  });
  it('ignores another owner storage notification without discarding this draft', async () => {
    render(<JournalPageClient />); await beginEdit();
    fireEvent(window, new StorageEvent('storage', { key: 'sophia.memory.journal-command.v1:other-owner:any-command' }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getAllByDisplayValue('TRANSIENT_PRIVATE_DRAFT').length).toBeGreaterThan(0);
  });
  it('denies the initial offline read instead of rendering cached memory', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<JournalPageClient />);
    await screen.findByText('Journal unavailable');
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
  });
  it.each(['pagehide', 'offline'])('withholds text and draft on %s and rereads current authority on return', async event => {
    render(<JournalPageClient />); await beginEdit();
    fireEvent(window, new Event(event));
    expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
    request.mockResolvedValueOnce(response({ entries: [{ ...initialEntry, content: 'REENTRY_CANONICAL_TEXT' }] }));
    fireEvent(window, new Event(event === 'pagehide' ? 'pageshow' : 'online'));
    await screen.findAllByText('REENTRY_CANONICAL_TEXT');
    expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
    expect(screen.getByText(/Unsaved memory edit cleared/)).toBeInTheDocument();
    expect(request.mock.calls.every(([, options]) => options.method === 'GET' && options.cache === 'no-store')).toBe(true);
  });
  it('revalidates an owned cross-tab command notification using GET rather than trusting its payload', async () => {
    render(<JournalPageClient />); await beginEdit();
    request.mockResolvedValueOnce(response({ entries: [] }));
    fireEvent(window, new StorageEvent('storage', { key: 'sophia.memory.journal-command.v1:user-123:any-command',
      newValue: '{"memory":"UNTRUSTED_NOTIFICATION_TEXT"}' }));
    await screen.findByText('No saved memories yet');
    expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
    expect(screen.queryByText('UNTRUSTED_NOTIFICATION_TEXT')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['owner', 'view', 'partial', 'duplicate', 'missing_text', 'flat', 'filtered'])('withholds the entire %s Pool response before ordinary rendering', async fault => {
    const value = poolFixture([initialEntry]);
    if (fault === 'owner') value.owner_id = 'other-owner';
    if (fault === 'view') { value.view = 'forgotten'; value.entries[0].metadata.lifecycle = 'forgotten'; }
    if (fault === 'partial') value.snapshot_count = 2;
    if (fault === 'duplicate') { value.entries.push(value.entries[0]); value.count = value.snapshot_count = 2; }
    if (fault === 'missing_text') value.entries[0].content = '';
    if (fault === 'filtered') value.filters.category = 'fact';
    request.mockReset().mockResolvedValueOnce(new Response(JSON.stringify(fault === 'flat' ? { entries: [initialEntry] } : value)));
    render(<JournalPageClient />);
    await screen.findByText('Journal unavailable');
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
  describe.each(['forget', 'restore', 'delete'] as const)('%s lifecycle', action => {
    it('rejects a reloaded list contradicting the recovered receipt', async () => {
      const first = await openLifecycle(action);
      request.mockResolvedValueOnce(response({ error: 'lost response' }, 503));
      submitLifecycle(action);
      await screen.findAllByText("Couldn't " + action + " this memory right now.");
      const original = JSON.parse(request.mock.calls.at(-1)[1].body);
      first.unmount(); request.mockReset();
      request.mockResolvedValueOnce(response({ status: 'committed', historical_result_only: true, receipt: lifecycleResult(action, original.idempotency_key, 'tombstoned').receipt }));
      request.mockResolvedValueOnce(response({ entries: [initialEntry] }));
      render(<JournalPageClient />);
      await screen.findByText('Journal unavailable');
      expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
      expect(readJournalCommandReferences('user-123')).toHaveLength(1);
    });
    it.each(['active', 'forgotten', 'tombstoned', 'not_found', 'unavailable'])('uses only %s current state after an original receipt', async state => {
      await openLifecycle(action);
      request.mockImplementationOnce(async (_url, options) => response(lifecycleResult(action, JSON.parse(options.body).idempotency_key, state)));
      submitLifecycle(action);
      await waitFor(() => expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument());
      const matchesShelf = action === 'forget' ? state === 'active' : action === 'restore' && state === 'forgotten';
      if (matchesShelf) expect(screen.getAllByText('LATER_CANONICAL_TEXT').length).toBeGreaterThan(0);
      else expect(screen.queryByText('LATER_CANONICAL_TEXT')).not.toBeInTheDocument();
      if (action === 'delete' && state === 'tombstoned') {
        expect(screen.getByText(/Original canonical fence confirmed/)).toHaveTextContent(/not verified here/);
        expect(screen.getByText(/Original canonical fence confirmed/)).toHaveTextContent(/Source transcripts are not deleted/);
      }
    });
    it('reuses the exact original key and revision after response loss', async () => {
      await openLifecycle(action);
      const start = request.mock.calls.length;
      request.mockResolvedValueOnce(response({ error: 'lost response' }, 503));
      submitLifecycle(action);
      await screen.findAllByText("Couldn't " + action + " this memory right now.");
      expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
      request.mockImplementationOnce(async (_url, options) => response(lifecycleResult(action, JSON.parse(options.body).idempotency_key, 'tombstoned')));
      fireEvent.click(screen.getByRole('button', { name: 'Retry original memory action' }));
      await screen.findByLabelText('Recovered memory actions');
      expect(JSON.parse(request.mock.calls[start][1].body)).toEqual(JSON.parse(request.mock.calls[start + 1][1].body));
      expect(readJournalCommandReferences('user-123')).toEqual([]);
    });
    it('recovers by original-key GET after remount and never resubmits', async () => {
      const first = await openLifecycle(action);
      request.mockResolvedValueOnce(response({ error: 'lost response' }, 503));
      submitLifecycle(action);
      await screen.findAllByText("Couldn't " + action + " this memory right now.");
      const original = JSON.parse(request.mock.calls.at(-1)[1].body);
      expect(readJournalCommandReferences('user-123')[0].action).toBe(action);
      first.unmount(); request.mockReset();
      request.mockResolvedValueOnce(response({ status: 'committed', historical_result_only: true, receipt: lifecycleResult(action, original.idempotency_key, 'tombstoned').receipt }));
      request.mockResolvedValueOnce(response({ entries: [] }));
      render(<JournalPageClient />);
      await screen.findByLabelText('Recovered memory actions');
      expect(request.mock.calls[0][0]).toBe('/api/memory/commands/' + original.idempotency_key);
      expect(request.mock.calls.every(([, options]) => options.method === 'GET' && options.cache === 'no-store')).toBe(true);
      expect(readJournalCommandReferences('user-123')).toEqual([]);
      expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
    });
    it('discards a late response after the owner changes', async () => {
      const view = await openLifecycle(action);
      let finish!: (value: Response) => void;
      request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      submitLifecycle(action);
      const original = JSON.parse(request.mock.calls.at(-1)[1].body);
      request.mockResolvedValueOnce(response({ entries: [] }, 200, 'other-owner', action === 'forget' ? 'active' : 'forgotten'));
      auth.user = { id: 'other-owner' }; view.rerender(<JournalPageClient />);
      await screen.findByText(action === 'forget' ? 'No saved memories yet' : 'Forgotten shelf is empty');
      await act(async () => finish(response(lifecycleResult(action, original.idempotency_key, 'active'))));
      expect(screen.queryByText('LATER_CANONICAL_TEXT')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Recovered memory actions')).not.toBeInTheDocument();
      expect(readJournalCommandReferences('user-123')).toHaveLength(1);
    });
  });
  it.each(['active', 'tombstoned', 'unavailable', 'not_found'])('renders only the %s current view after edit replay', async (state) => {
    request.mockImplementationOnce(async (_url, options) => response(commandResult(JSON.parse(options.body).idempotency_key, state)));
    render(<JournalPageClient />); await beginEdit(); save();
    await waitFor(() => expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument());
    if (state === 'active') expect(screen.getAllByText('LATER_CANONICAL_TEXT').length).toBeGreaterThan(0);
    else expect(screen.queryByText('LATER_CANONICAL_TEXT')).not.toBeInTheDocument();
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
    const persisted = Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)));
    expect(JSON.stringify(persisted)).not.toMatch(/TRANSIENT_PRIVATE_DRAFT|LATER_CANONICAL_TEXT|INITIAL_CANONICAL_TEXT/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reuses the original transient command key after an unknown response', async () => {
    request.mockResolvedValueOnce(response({ error: 'unavailable' }, 503));
    request.mockImplementationOnce(async (_url, options) => response(commandResult(JSON.parse(options.body).idempotency_key)));
    render(<JournalPageClient />); await beginEdit(); save();
    await screen.findAllByText("Couldn't update this memory right now.");
    save(); await screen.findAllByText('LATER_CANONICAL_TEXT');
    const first = JSON.parse(request.mock.calls[1][1].body);
    const replay = JSON.parse(request.mock.calls[2][1].body);
    expect(replay).toEqual(first);
    expect(first.idempotency_key).toMatch(/^journal-edit-/);
  });

  it('discards a late edit response after account switch and clears the draft', async () => {
    let finish!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    request.mockResolvedValueOnce(response({ entries: [] }, 200, 'other-owner'));
    const view = render(<JournalPageClient />); await beginEdit(); save();
    const key = JSON.parse(request.mock.calls[1][1].body).idempotency_key;
    auth.user = { id: 'other-owner' }; view.rerender(<JournalPageClient />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await act(async () => finish(response(commandResult(key))));
    expect(screen.queryByText('LATER_CANONICAL_TEXT')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
  });

  it('discards a late list response after logout without another request', async () => {
    let finish!: (value: Response) => void;
    request.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<JournalPageClient />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    auth.user = null; view.rerender(<JournalPageClient />);
    await act(async () => finish(response({ entries: [initialEntry] })));
    expect(screen.getByText('Sign in to view your journal.')).toBeInTheDocument();
    expect(screen.queryByText('INITIAL_CANONICAL_TEXT')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not revive an old edit when the same account returns after a switch', async () => {
    let finish!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    request.mockResolvedValueOnce(response({ entries: [] }, 200, 'other-owner'));
    request.mockResolvedValueOnce(response({ status: 'committed', historical_result_only: true, receipt: commandResult('unused').receipt }));
    request.mockResolvedValueOnce(response({ entries: [{ ...initialEntry, content: 'FRESH_RETURN_TEXT', metadata: { ...initialEntry.metadata, content_revision: 4, memory_governance_revision: 6 } }] }));
    const view = render(<JournalPageClient />); await beginEdit(); save();
    const key = JSON.parse(request.mock.calls[1][1].body).idempotency_key;
    auth.user = { id: 'other-owner' }; view.rerender(<JournalPageClient />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    auth.user = { id: 'user-123' }; view.rerender(<JournalPageClient />);
    await screen.findAllByText('FRESH_RETURN_TEXT');
    await act(async () => finish(response(commandResult(key))));
    expect(screen.queryByText('LATER_CANONICAL_TEXT')).not.toBeInTheDocument();
    expect(screen.getAllByText('FRESH_RETURN_TEXT').length).toBeGreaterThan(0);
  });

  it.each(['committed', 'tombstoned', 'not_found', 'outage', 'wrong_target', 'wrong_type', 'current_outage'])(
    'recovers %s after a lost edit response and reload without storing or replaying the draft', async (state) => {
      request.mockResolvedValueOnce(response({ error: 'lost committed response' }, 503));
      const first = render(<JournalPageClient />); await beginEdit(); save();
      await screen.findAllByText("Couldn't update this memory right now.");
      const original = JSON.parse(request.mock.calls[1][1].body);
      const references = readJournalCommandReferences('user-123');
      expect(references).toHaveLength(1);
      expect(references[0].command_key).toBe(original.idempotency_key);
      expect(Object.keys(references[0]).sort()).toEqual(['action', 'command_key', 'memory_id', 'owner_id', 'schema']);
      const persisted = Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)));
      expect(JSON.stringify(persisted)).not.toMatch(/TRANSIENT_PRIVATE_DRAFT|INITIAL_CANONICAL_TEXT/);
      first.unmount();
      request.mockReset();
      const receipt = commandResult(original.idempotency_key).receipt;
      if (state === 'wrong_target') receipt.memory_id = inventoryRecord(2).id;
      if (state === 'wrong_type') receipt.event_type = 'memory_manual_created';
      request.mockResolvedValueOnce(response(state === 'not_found'
        ? { status: 'not_found', historical_result_only: true, receipt: null }
        : { status: 'committed', historical_result_only: true, receipt }, state === 'outage' ? 503 : 200));
      request.mockResolvedValueOnce(response({ entries: state === 'tombstoned' ? [] : [{ ...initialEntry, content: 'RELOADED_CANONICAL_TEXT', metadata: { ...initialEntry.metadata, content_revision: 4, memory_governance_revision: 6 } }] }, state === 'current_outage' ? 503 : 200));
      render(<JournalPageClient />);
      const unavailable = ['outage', 'wrong_target', 'wrong_type', 'current_outage'].includes(state);
      if (unavailable) {
        await screen.findByText('Journal unavailable');
        expect(readJournalCommandReferences('user-123')).toHaveLength(1);
        expect(screen.queryByText('RELOADED_CANONICAL_TEXT')).not.toBeInTheDocument();
      } else {
        await screen.findByLabelText('Recovered memory actions');
        expect(readJournalCommandReferences('user-123')).toHaveLength(0);
        if (state === 'not_found') expect(screen.getByText(/No admitted edit was found/)).toBeInTheDocument();
        else expect(screen.getByText(/original-edit-operation/)).toBeInTheDocument();
      }
      expect(screen.queryByDisplayValue('TRANSIENT_PRIVATE_DRAFT')).not.toBeInTheDocument();
      expect(request.mock.calls[0][0]).toBe(`/api/memory/commands/${original.idempotency_key}`);
      expect(request.mock.calls.every(([, options]) => options.method === 'GET' && options.cache === 'no-store')).toBe(true);
    },
  );

  it('does not submit an edit when its recovery reference cannot be persisted', async () => {
    render(<JournalPageClient />); await beginEdit();
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('synthetic unavailable storage'); });
    save(); await screen.findAllByText("Couldn't update this memory right now.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(readJournalCommandReferences('user-123')).toEqual([]);
  });
});
