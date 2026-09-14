import { beforeEach, describe, expect, it, vi } from 'vitest';

import { acknowledgeJournalCommand, readJournalCommandReferences, recoverJournalCommands, rememberJournalCommand } from '../../app/lib/journal-command-recovery';

import { inventoryRecord } from './inventory-fixture';
import { lifecycleResult } from './lifecycle-fixture';

const command = 'journal-edit-20000000-0000-4000-8000-000000000001';
const memory = inventoryRecord().id;
const controller = () => new AbortController();
beforeEach(() => { localStorage.clear(); vi.mocked(fetch).mockReset(); });

describe('content-free Journal command references', () => {
  it.each(['forget', 'restore', 'delete'] as const)('recovers only the original %s event type', async action => {
    const key = command.replace('edit', action);
    rememberJournalCommand('owner', memory, key, action);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      status: 'committed', historical_result_only: true, receipt: lifecycleResult(action, key, 'tombstoned').receipt,
    })));
    expect((await recoverJournalCommands('owner', controller().signal))[0].reference.action).toBe(action);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });
  it.each(['wrong_action', 'missing_tombstone', 'false_fence'] as const)('denies corrupt lifecycle receipt %s', async fault => {
    const key = command.replace('edit', 'delete');
    rememberJournalCommand('owner', memory, key, 'delete');
    const value = lifecycleResult('delete', key, 'tombstoned');
    if (fault === 'wrong_action') value.receipt.event_type = 'memory_forgotten';
    if (fault === 'missing_tombstone') delete value.receipt.tombstone_id;
    if (fault === 'false_fence') value.receipt.status = 'complete';
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: 'committed', historical_result_only: true, receipt: value.receipt })));
    await expect(recoverJournalCommands('owner', controller().signal)).rejects.toThrow();
    expect(readJournalCommandReferences('owner')).toHaveLength(1);
  });
  it('does not replace unresolved forget with a different lifecycle action', () => {
    rememberJournalCommand('owner', memory, command.replace('edit', 'forget'), 'forget');
    expect(() => rememberJournalCommand('owner', memory, command.replace('edit', 'delete'), 'delete')).toThrow();
    expect(() => rememberJournalCommand('owner', inventoryRecord(2).id, command, 'restore')).toThrow();
    expect(readJournalCommandReferences('owner')).toHaveLength(1);
  });
  it('isolates owner partitions and acknowledges only the exact reference', () => {
    localStorage.setItem('unrelated-user-draft', 'UNRELATED_PRIVATE_DRAFT');
    const first = rememberJournalCommand('first-owner', memory, command);
    const second = rememberJournalCommand('second-owner', memory, command);
    expect(readJournalCommandReferences('first-owner')).toEqual([first]);
    expect(readJournalCommandReferences('second-owner')).toEqual([second]);
    acknowledgeJournalCommand(first);
    expect(readJournalCommandReferences('first-owner')).toEqual([]);
    expect(readJournalCommandReferences('second-owner')).toEqual([second]);
    expect(localStorage.getItem('unrelated-user-draft')).toBe('UNRELATED_PRIVATE_DRAFT');
  });

  it('retains independent memory commands without overwriting another record', () => {
    rememberJournalCommand('owner', memory, command);
    rememberJournalCommand('owner', inventoryRecord(2).id, command.replace(/1$/, '2'));
    expect(readJournalCommandReferences('owner')).toHaveLength(2);
    expect(localStorage.length).toBe(2);
  });

  it('rejects changed-target reuse and a new key for an unresolved edit', () => {
    rememberJournalCommand('owner', memory, command);
    expect(() => rememberJournalCommand('owner', inventoryRecord(2).id, command)).toThrow();
    expect(() => rememberJournalCommand('owner', memory, command.replace(/1$/, '2'))).toThrow();
    expect(readJournalCommandReferences('owner')).toHaveLength(1);
  });

  it.each(['owner', 'target', 'key', 'draft', 'oversize', 'invalid_json'])('denies corrupt %s references before a request', async (fault) => {
    const reference = rememberJournalCommand('owner', memory, command);
    const stored = localStorage.key(0);
    const raw: Record<string, unknown> = { ...reference };
    if (fault === 'owner') raw.owner_id = 'other-owner';
    if (fault === 'target') raw.memory_id = 'not-a-memory-id';
    if (fault === 'key') raw.command_key = 'replacement-command';
    if (fault === 'draft') raw.reviewed_text = 'PRIVATE_EDIT_NEVER_RECOVER';
    localStorage.setItem(stored, fault === 'oversize' ? 'X'.repeat(2049) : fault === 'invalid_json' ? '{' : JSON.stringify(raw));
    await expect(recoverJournalCommands('owner', controller().signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cannot acknowledge a substituted storage target', () => {
    const reference = rememberJournalCommand('owner', memory, command);
    const item = localStorage.key(0);
    localStorage.setItem(item, JSON.stringify({ ...reference, memory_id: inventoryRecord(2).id }));
    expect(() => acknowledgeJournalCommand(reference)).toThrow();
    expect(localStorage.length).toBe(1);
  });

  it('does not issue any request for an aborted recovery', async () => {
    rememberJournalCommand('owner', memory, command);
    const signal = controller(); signal.abort();
    await expect(recoverJournalCommands('owner', signal.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never submits edited text or a mutation when the original key was not admitted', async () => {
    rememberJournalCommand('owner', memory, command);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: 'not_found', historical_result_only: true, receipt: null })));
    const recovered = await recoverJournalCommands('owner', controller().signal);
    expect(recovered[0].status).toBe('fresh_review_required');
    expect(readJournalCommandReferences('owner')).toHaveLength(1); // Caller still needs a fresh current view.
    expect(fetch).toHaveBeenCalledWith(`/api/memory/commands/${command}`, expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();
  });
});
