import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { createSourceSendIntent, loadSourceProfile, recordSourceSendIntent } from '../../app/lib/memory-source-client';
import type { SourceProfile } from '../../app/lib/memory-source-contract';
import { useSessionOutboundSend } from '../../app/session/useSessionSendActions';
import { useConnectivityStore } from '../../app/stores/connectivity-store';

const session = '20000000-0000-4000-8000-000000000001', thread = '30000000-0000-4000-8000-000000000001';
const profile: SourceProfile = { schema: 'mem00.source-profile.v1', owner_id: 'owner', session_id: session, thread_id: thread,
  authority: 'governed', observation_only: true, boundary: { schema: 'mem00.source-boundary.v1', owner_id: 'owner',
    session_id: session, thread_id: thread, memory_clear_epoch: 2, transcript_revision: 3 } };
const fetchMock = vi.fn();
it('C2 refuses optional upload selections before creating a source action', () => {
  expect(() => createSourceSendIntent(profile, 'SYNTHETIC INPUT', [{}])).toThrow('memory_source_upload_unavailable');
});
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); useConnectivityStore.setState({ messageQueue: [] }); });
function actionReceipt(intent: NonNullable<ReturnType<typeof createSourceSendIntent>>) {
  return { schema: 'mem00.source-action.v1', owner_id: 'owner', session_id: session, thread_id: thread,
    command_key: intent.action.command_key, message_id: intent.action.message_id,
    event_id: '40000000-0000-4000-8000-000000000001', source_row_id: '50000000-0000-4000-8000-000000000001',
    source_version: '60000000-0000-4000-8000-000000000001', sequence: 4, transcript_revision: 4,
    memory_clear_epoch: 2, created_at: '2026-09-09T00:00:00Z', content_ref: `hmac-sha256:source-action-content:${'a'.repeat(64)}`,
    historical_result_only: true, idempotent_replay: false, status: 'source_recorded', memory_approval: 'not_granted',
    current_extraction_eligibility: 'not_verified_in_this_response' };
}
it('captures distinct deliberate occurrences, freezes the old epoch and never refreshes on retry', async () => {
  const first = createSourceSendIntent(profile, 'SYNTHETIC SAME');
  const second = createSourceSendIntent(profile, 'SYNTHETIC SAME');
  expect(first.action.command_key).not.toBe(second.action.command_key);
  expect(first.action.message_id).not.toBe(second.action.message_id);
  expect(Object.isFrozen(first.action)).toBe(true);
  fetchMock.mockRejectedValueOnce(new Error('SYNTHETIC LOST REPLY'));
  await expect(recordSourceSendIntent(first)).rejects.toThrow('memory_source_action_unavailable');
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...actionReceipt(first), idempotent_replay: true })));
  expect((await recordSourceSendIntent(first)).idempotent_replay).toBe(true);
  expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([first.action, first.action]);
  expect(fetchMock.mock.calls.every(([url]) => url.endsWith('/memory-source-actions'))).toBe(true);
});
it('preserves queue action identity and rejects edited queue text', () => {
  const intent = createSourceSendIntent(profile, 'SYNTHETIC QUEUE');
  const state = useConnectivityStore.getState();
  const id = state.queueMessage(intent.action.content, session, intent);
  state.incrementRetry(id);
  expect(useConnectivityStore.getState().messageQueue[0].sourceIntent).toEqual(intent);
  expect(() => state.queueMessage('SYNTHETIC EDIT', session, intent)).toThrow('memory_source_queue_scope_invalid');
});
it.each([503, 404, 401])('does not infer a legacy profile from HTTP%s', async status => {
  fetchMock.mockResolvedValue(new Response('SYNTHETIC PRIVATE ERROR', { status }));
  await expect(loadSourceProfile('owner', session, thread)).rejects.toThrow('memory_source_profile_unavailable');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('requires a scope-bound profile and does not create governed actions for positively declared legacy', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(profile)));
  expect(await loadSourceProfile('owner', session, thread)).toEqual(profile);
  expect(createSourceSendIntent({ ...profile, authority: 'legacy', boundary: null }, 'SYNTHETIC')).toBeNull();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...profile, owner_id: 'wrong' })));
  await expect(loadSourceProfile('owner', session, thread)).rejects.toThrow('memory_source_profile_unavailable');
});
it('actual outbound hook records first and sends the canonical source ID through the full-message SDK overload', async () => {
  const intent = createSourceSendIntent(profile, 'SYNTHETIC OUTBOUND');
  const receipt = actionReceipt(intent);
  fetchMock.mockResolvedValue(new Response(JSON.stringify(receipt)));
  const sendChatMessage = vi.fn(async () => { expect(fetchMock).toHaveBeenCalledTimes(1); });
  const { result } = renderHook(() => useSessionOutboundSend({ chatStatus: 'ready', sendChatMessage,
    hasValidBackendSessionId: true, chatRequestBody: { user_id: 'owner', session_id: session, thread_id: thread },
    debugEnabled: false, markStreamTurnStarted: vi.fn(), showToast: vi.fn() }));
  await act(async () => result.current({ text: intent.action.content, sourceIntent: intent }));
  expect(sendChatMessage).toHaveBeenCalledWith({ id: intent.action.message_id, role: 'user', parts: [{ type: 'text', text: intent.action.content }] },
    { body: { user_id: 'owner', session_id: session, thread_id: thread, memory_source_action: intent.action } });
  expect(fetchMock).toHaveBeenCalledTimes(1); // No unguarded session touch upsert.
});
it.each(['submitted', 'streaming', 'initializing'] as const)('a governed %s no-op cannot resolve as successful delivery', async status => {
  const intent = createSourceSendIntent(profile, 'SYNTHETIC HELD');
  const sendChatMessage = vi.fn(async () => undefined);
  const { result } = renderHook(() => useSessionOutboundSend({
    chatStatus: status === 'initializing' ? 'ready' : status, sendChatMessage,
    hasValidBackendSessionId: status !== 'initializing',
    chatRequestBody: { user_id: 'owner', session_id: session, thread_id: thread },
    debugEnabled: false, markStreamTurnStarted: vi.fn(), showToast: vi.fn(),
  }));
  await expect(result.current({ text: intent.action.content, sourceIntent: intent })).rejects.toThrow(
    status === 'initializing' ? 'memory_source_session_unavailable' : 'memory_source_dispatch_busy');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(sendChatMessage).not.toHaveBeenCalled();
});
it('source outage prevents chat dispatch and an immediate retry preserves the original action', async () => {
  const intent = createSourceSendIntent(profile, 'SYNTHETIC RETRY');
  const sendChatMessage = vi.fn(async () => undefined);
  const { result } = renderHook(() => useSessionOutboundSend({ chatStatus: 'ready', sendChatMessage,
    hasValidBackendSessionId: true, chatRequestBody: { user_id: 'owner', session_id: session, thread_id: thread },
    debugEnabled: false, markStreamTurnStarted: vi.fn(), showToast: vi.fn() }));
  fetchMock.mockRejectedValueOnce(new Error('SYNTHETIC OUTAGE'));
  await act(async () => { await expect(result.current({ text: intent.action.content, sourceIntent: intent })).rejects.toThrow('memory_source_action_unavailable'); });
  expect(sendChatMessage).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...actionReceipt(intent), idempotent_replay: true })));
  await act(async () => result.current({ text: intent.action.content, sourceIntent: intent }));
  expect(sendChatMessage).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([intent.action, intent.action]);
});
it('a persisted action from another owner cannot reach source or chat dispatch after account change', async () => {
  const intent = createSourceSendIntent(profile, 'SYNTHETIC OLD OWNER');
  const sendChatMessage = vi.fn(async () => undefined);
  const { result } = renderHook(() => useSessionOutboundSend({ chatStatus: 'ready', sendChatMessage,
    hasValidBackendSessionId: true, chatRequestBody: { user_id: 'new-owner', session_id: session, thread_id: thread },
    debugEnabled: false, markStreamTurnStarted: vi.fn(), showToast: vi.fn() }));
  await act(async () => { await expect(result.current({ text: intent.action.content, sourceIntent: intent })).rejects.toThrow('memory_source_action_scope_invalid'); });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(sendChatMessage).not.toHaveBeenCalled();
});
it.each([false, true])('account change while source acceptance is in flight fences the later SDK send, return=%s', async returnToOwner => {
  const intent = createSourceSendIntent(profile, 'SYNTHETIC IN FLIGHT');
  let finish: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const sendChatMessage = vi.fn(async () => undefined);
  const { result, rerender } = renderHook(({ owner }) => useSessionOutboundSend({ chatStatus: 'ready', sendChatMessage,
    hasValidBackendSessionId: true, chatRequestBody: { user_id: owner, session_id: session, thread_id: thread },
    debugEnabled: false, markStreamTurnStarted: vi.fn(), showToast: vi.fn() }), { initialProps: { owner: 'owner' } });
  const pending = result.current({ text: intent.action.content, sourceIntent: intent });
  rerender({ owner: 'new-owner' });
  if (returnToOwner) rerender({ owner: 'owner' });
  finish(new Response(JSON.stringify(actionReceipt(intent))));
  await expect(pending).rejects.toThrow('memory_source_action_scope_changed');
  expect(sendChatMessage).not.toHaveBeenCalled();
});
