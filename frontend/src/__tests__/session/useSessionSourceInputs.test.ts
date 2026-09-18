import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type { SourceProfile } from '../../app/lib/memory-source-contract';
import { useSessionOutboundSend, useSessionSendActions } from '../../app/session/useSessionSendActions';
import { useSessionSourceInputs } from '../../app/session/useSessionSourceInputs';
import { useConnectivityStore } from '../../app/stores/connectivity-store';

const session = '20000000-0000-4000-8000-000000000001', thread = '30000000-0000-4000-8000-000000000001';
const profile: SourceProfile = { schema: 'mem00.source-profile.v1', owner_id: 'owner', session_id: session, thread_id: thread,
  authority: 'governed', observation_only: true, boundary: { schema: 'mem00.source-boundary.v1', owner_id: 'owner',
    session_id: session, thread_id: thread, memory_clear_epoch: 2, transcript_revision: 3 } };
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
  localStorage.clear(); useConnectivityStore.setState({ messageQueue: [] });
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(profile)));
});

it('holds unknown profile, then captures exact original identities before any network send', async () => {
  const { result } = renderHook(() => useSessionSourceInputs('owner', session, thread));
  expect(() => result.current.captureSourceInput('SYNTHETIC')).toThrow('memory_source_profile_unavailable');
  await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
  const first = result.current.captureSourceInput('SYNTHETIC SAME');
  const second = result.current.captureSourceInput('SYNTHETIC SAME');
  expect(first.sourceIntent.action.message_id).not.toBe(second.sourceIntent.action.message_id);
  expect(first.sourceIntent.action.expected_clear_epoch).toBe(2);
  expect(useConnectivityStore.getState().getQueuedMessages(session)).toEqual([]);
  expect(useConnectivityStore.getState().messageQueue).toHaveLength(2);
  expect(JSON.parse(localStorage.getItem('sophia-connectivity')).state.messageQueue[0].sourceIntent).toEqual(first.sourceIntent);
  expect(fetchMock).toHaveBeenCalledTimes(1); // Only preloaded profile, no acceptance/model.
  expect(() => result.current.validateSourceInput({ text: 'SYNTHETIC SAME' })).toThrow('memory_source_action_required');
});

it('reload retry resolves exact message ID and retains original epoch after a fresh observation', async () => {
  const firstHook = renderHook(() => useSessionSourceInputs('owner', session, thread));
  await waitFor(() => expect(firstHook.result.current.sourceProfileReady).toBe(true));
  const original = firstHook.result.current.captureSourceInput('SYNTHETIC ORIGINAL');
  const originalId = original.sourceIntent.action.message_id;
  firstHook.unmount();
  expect(() => firstHook.result.current.captureSourceInput('SYNTHETIC LATE')).toThrow();
  const saved = localStorage.getItem('sophia-connectivity');
  useConnectivityStore.setState({ messageQueue: [] }); localStorage.setItem('sophia-connectivity', saved);
  await useConnectivityStore.persist.rehydrate();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...profile, boundary: { ...profile.boundary, memory_clear_epoch: 3 } })));
  const { result } = renderHook(() => useSessionSourceInputs('owner', session, thread));
  await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
  expect(result.current.retrySourceInput('SYNTHETIC ORIGINAL', originalId)).toEqual(original);
  expect(() => result.current.retrySourceInput('SYNTHETIC ORIGINAL', null)).toThrow();
  expect(() => result.current.retrySourceInput('SYNTHETIC EDIT', originalId)).toThrow();
  expect(result.current.captureSourceInput('SYNTHETIC NEW').sourceIntent.action.expected_clear_epoch).toBe(3);
  expect(fetchMock.mock.calls.every(([url]) => url.includes('memory-source-profile'))).toBe(true);
});

it('retains original action after automatic queue removal and exhausted retries', async () => {
  const { result } = renderHook(() => useSessionSourceInputs('owner', session, thread));
  await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
  const original = result.current.captureSourceInput('SYNTHETIC QUEUED');
  const state = useConnectivityStore.getState();
  const id = state.queueMessage(original.text, session, original.sourceIntent);
  expect(state.getQueuedMessages(session)).toHaveLength(1);
  state.removeFromQueue(id);
  expect(state.getQueuedMessages(session)).toHaveLength(0);
  expect(result.current.retrySourceInput(original.text, id)).toEqual(original);
  state.queueMessage(original.text, session, original.sourceIntent);
  for (let index = 0; index < 5; index++) state.incrementRetry(id);
  expect(state.getQueuedMessages(session)).toHaveLength(0);
  expect(result.current.retrySourceInput(original.text, id)).toEqual(original);
  state.clearQueue();
  expect(() => result.current.retrySourceInput(original.text, id)).toThrow();
});

it('rejects owner changes and late callbacks without letting the old profile authorize the new owner', async () => {
  const { result, rerender } = renderHook(({ owner }) => useSessionSourceInputs(owner, session, thread), { initialProps: { owner: 'owner' } });
  await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
  const oldCapture = result.current.captureSourceInput, oldValidate = result.current.validateSourceInput;
  const original = oldCapture('SYNTHETIC OLD');
  fetchMock.mockImplementation(() => new Promise(() => undefined));
  rerender({ owner: 'new-owner' });
  expect(() => oldCapture('SYNTHETIC LATE')).toThrow();
  expect(() => oldValidate(original)).toThrow();
  expect(() => result.current.validateSourceInput(original)).toThrow();
  expect(() => result.current.captureSourceInput('SYNTHETIC NEW')).toThrow();
});

it.each([401, 404, 503])('profile HTTP%s cannot become legacy or allow submit', async status => {
  fetchMock.mockImplementation(async () => new Response('{}', { status }));
  const { result } = renderHook(() => useSessionSourceInputs('owner', session, thread));
  await act(async () => undefined);
  expect(result.current.sourceProfileReady).toBe(false);
  expect(() => result.current.captureSourceInput('SYNTHETIC')).toThrow();
  expect(() => result.current.validateSourceInput({ text: 'SYNTHETIC' })).toThrow();
});

it('permits text-only input only for an explicit current legacy profile', async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...profile, authority: 'legacy', boundary: null })));
  const { result } = renderHook(() => useSessionSourceInputs('owner', session, thread));
  await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
  expect(result.current.captureSourceInput('SYNTHETIC')).toEqual({ text: 'SYNTHETIC' });
  expect(result.current.retrySourceInput('SYNTHETIC', null)).toEqual({ text: 'SYNTHETIC' });
  expect(() => result.current.validateSourceInput({ text: 'SYNTHETIC' })).not.toThrow();
  expect(useConnectivityStore.getState().messageQueue).toEqual([]);
});

it('a full source outbox holds new action capture without evicting original retry identity', async () => {
  const { result } = renderHook(() => useSessionSourceInputs('owner', session, thread));
  await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
  const first = result.current.captureSourceInput('SYNTHETIC FIRST');
  for (let index = 1; index < 50; index++) result.current.captureSourceInput(`SYNTHETIC ${index}`);
  expect(() => result.current.captureSourceInput('SYNTHETIC OVERFLOW')).toThrow('memory_source_outbox_full');
  expect(result.current.retrySourceInput(first.text, first.sourceIntent.action.message_id)).toEqual(first);
  expect(useConnectivityStore.getState().messageQueue).toHaveLength(50);
});

it('refresh invalidates old capture callbacks but does not rewrite existing actions', async () => {
  const { result } = renderHook(() => useSessionSourceInputs('owner', session, thread));
  await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
  const original = result.current.captureSourceInput('SYNTHETIC ORIGINAL');
  const oldCapture = result.current.captureSourceInput;
  act(() => result.current.refreshSourceProfile());
  expect(() => oldCapture('SYNTHETIC LATE')).toThrow();
  await waitFor(() => expect(result.current.sourceProfileReady).toBe(true));
  expect(result.current.retrySourceInput(original.text, original.sourceIntent.action.message_id)).toEqual(original);
});

it.each(['online', 'offline'])('actual submit/profile/outbox/outbound hooks preserve one action while %s', async connectivityStatus => {
  let posted: Record<string, unknown> | undefined;
  fetchMock.mockImplementation(async (url, options) => {
    if (url.includes('memory-source-profile')) return new Response(JSON.stringify(profile));
    expect(url).toBe(`/api/sessions/${session}/memory-source-actions`);
    posted = JSON.parse(options.body);
    return new Response(JSON.stringify({ schema: 'mem00.source-action.v1', owner_id: 'owner', session_id: session, thread_id: thread,
      command_key: posted.command_key, message_id: posted.message_id,
      event_id: '40000000-0000-4000-8000-000000000001', source_row_id: '50000000-0000-4000-8000-000000000001',
      source_version: '60000000-0000-4000-8000-000000000001', sequence: 4, transcript_revision: 4,
      memory_clear_epoch: 2, created_at: '2026-09-09T00:00:00Z', content_ref: `hmac-sha256:source-action-content:${'a'.repeat(64)}`,
      historical_result_only: true, idempotent_replay: false, status: 'source_recorded', memory_approval: 'not_granted',
      current_extraction_eligibility: 'not_verified_in_this_response' }));
  });
  const sendChatMessage = vi.fn(async () => undefined), setInput = vi.fn(), setLastUserMessageId = vi.fn();
  let pending: Promise<void> | undefined;
  const { result } = renderHook(() => {
    const source = useSessionSourceInputs('owner', session, thread);
    const outbound = useSessionOutboundSend({ chatStatus: 'ready', sendChatMessage, hasValidBackendSessionId: true,
      chatRequestBody: { user_id: 'owner', session_id: session, thread_id: thread }, debugEnabled: false,
      markStreamTurnStarted: vi.fn(), showToast: vi.fn() });
    const submit = useSessionSendActions({ input: 'SYNTHETIC COMPOSED', setInput, isTyping: false, isReadOnly: false,
      captureSourceInput: source.captureSourceInput, sendMessage: input => { source.validateSourceInput(input); pending = outbound(input); return pending; },
      connectivityStatus, queueMessage: useConnectivityStore.getState().queueMessage, sessionId: session, chatMessagesLength: 0,
      setChatMessages: vi.fn(), showToast: vi.fn(), voiceStatus: 'ready', setVoiceStatus: vi.fn(), setShowScaffold: vi.fn(),
      setJustSent: vi.fn(), setDismissedError: vi.fn(), setLastUserMessageContent: vi.fn(), setLastUserMessageId,
      setCancelledMessageId: vi.fn(), stopStreaming: vi.fn(), voiceState: { stage: 'ready', resetVoiceState: vi.fn() },
      queueVoiceRetryFromCancel: vi.fn(), cancelledRetryMessage: '' });
    return { source, submit, outbound };
  });
  await waitFor(() => expect(result.current.source.sourceProfileReady).toBe(true));
  await act(async () => { result.current.submit.handleSubmit(); await pending; });
  const retained = useConnectivityStore.getState().messageQueue[0].sourceIntent;
  expect(setInput).toHaveBeenCalledWith('');
  expect(retained.action.expected_clear_epoch).toBe(2);
  if (connectivityStatus === 'offline') {
    expect(posted).toBeUndefined();
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(useConnectivityStore.getState().getQueuedMessages(session)[0].sourceIntent).toEqual(retained);
    await act(async () => result.current.outbound({ text: retained.action.content, sourceIntent: retained }));
  } else expect(setLastUserMessageId).toHaveBeenCalledWith(retained.action.message_id);
  expect(posted).toEqual(retained.action);
  expect(sendChatMessage).toHaveBeenCalledWith({ id: retained.action.message_id, role: 'user', parts: [{ type: 'text', text: retained.action.content }] },
    { body: { user_id: 'owner', session_id: session, thread_id: thread, memory_source_action: retained.action } });
});
