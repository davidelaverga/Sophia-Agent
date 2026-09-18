import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), owner: vi.fn(), auth: vi.fn(), refresh: vi.fn(), log: vi.fn(), denied: vi.fn() }));
vi.mock('../../app/lib/auth/server-auth', () => ({ getAuthenticatedUserId: mocks.owner, getUserScopedAuthHeader: mocks.auth, refreshUserScopedAuthHeader: mocks.refresh }));
vi.mock('../../app/lib/debug-logger', () => ({ debugLog: mocks.log }));
vi.mock('../../server/voice-lab/ordinary-route-isolation', () => ({ voiceLabOrdinaryProductBoundaryResponse: mocks.denied }));
vi.mock('../../server/voice-lab/capability', () => ({
  getVoiceLabSessionReadCapability: vi.fn(async () => null), getVoiceLabSessionCreateCapability: vi.fn(async () => null),
  getVoiceLabEndSessionCapability: vi.fn(async () => null), VOICE_LAB_CAPABILITY_HEADER: 'x-voice-lab-capability',
  VoiceLabCapabilityError: class extends Error {},
}));
import { GET, POST, DELETE, PATCH, PUT } from '../../app/api/sessions/[...path]/route';

const session = '20000000-0000-4000-8000-000000000001';
const thread = '30000000-0000-4000-8000-000000000001';
const action = { thread_id: thread, message_id: 'source-message-first', command_key: 'source-action-first', expected_clear_epoch: 0, content: 'SYNTHETIC SOURCE TEXT' };
const receipt = { schema: 'mem00.source-action.v1', owner_id: 'intake-owner', session_id: session, thread_id: thread,
  command_key: action.command_key, event_id: '40000000-0000-4000-8000-000000000001', message_id: action.message_id,
  source_row_id: '50000000-0000-4000-8000-000000000001', source_version: '60000000-0000-4000-8000-000000000001',
  sequence: 1, created_at: '2026-09-09T00:00:00+00:00', memory_clear_epoch: 0, transcript_revision: 1,
  content_ref: `hmac-sha256:source-action-content:${'a'.repeat(64)}`, historical_result_only: true, idempotent_replay: false,
  status: 'source_recorded', memory_approval: 'not_granted', current_extraction_eligibility: 'not_verified_in_this_response' };
const send = (body: unknown = action) => POST(new NextRequest(`http://localhost/api/sessions/${session}/memory-source-actions`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
}), { params: Promise.resolve({ path: [session, 'memory-source-actions'] }) });
const read = (path: string[], query = '') => GET(new NextRequest(`http://localhost/api/sessions/${path.join('/')}${query}`), { params: Promise.resolve({ path }) });

describe('exact source action through ordinary sessions proxy', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', mocks.fetch); mocks.owner.mockResolvedValue('intake-owner'); mocks.auth.mockResolvedValue('Bearer synthetic'); mocks.denied.mockResolvedValue(null); });
  it('refuses optional C2 upload intake without falling into the generic proxy', async () => {
    const response = await read([session, 'memory-source-uploads']);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it('preserves the original strict action without adding owner fields or logging receipts', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(receipt)));
    const response = await send();
    expect(response.status).toBe(200);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual(action);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.log).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(receipt);
  });
  it('rejects an owner-mismatched receipt instead of displaying another owner result', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ...receipt, owner_id: 'wrong-owner' })));
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('wrong-owner');
  });
  it('sanitizes upstream failures and does not turn a failed lookup into not_found', async () => {
    mocks.fetch.mockResolvedValue(new Response('SYNTHETIC RAW SQL ERROR', { status: 500 }));
    const response = await read(['memory-source-actions', action.command_key]);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('SYNTHETIC');
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it('returns exact boundary and lookup envelopes through authenticated no-store GETs', async () => {
    const boundary = { schema: 'mem00.source-boundary.v1', owner_id: 'intake-owner', session_id: session,
      thread_id: thread, memory_clear_epoch: 2, transcript_revision: 3 };
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify(boundary)));
    expect(await (await read([session, 'memory-source-boundary'], `?thread_id=${thread}`)).json()).toEqual(boundary);
    const status = { schema: 'mem00.source-action-status.v1', owner_id: 'intake-owner', command_key: action.command_key,
      historical_result_only: true, status: 'committed', receipt: { ...receipt, idempotent_replay: true } };
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify(status)));
    expect(await (await read(['memory-source-actions', action.command_key])).json()).toEqual(status);
    expect(mocks.fetch.mock.calls.every(([, options]) => options.cache === 'no-store' && options.redirect === 'error')).toBe(true);
    expect(mocks.fetch.mock.calls.every(([url]) => !url.includes('user_id'))).toBe(true);
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it('preserves historical replay without querying a newer boundary', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ...receipt, idempotent_replay: true })));
    expect(await (await send()).json()).toEqual({ ...receipt, idempotent_replay: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual(action);
  });
  it.each(['legacy', 'governed'])('returns a scoped %s profile as an observation, not permission', async authority => {
    const boundary = { schema: 'mem00.source-boundary.v1', owner_id: 'intake-owner', session_id: session,
      thread_id: thread, memory_clear_epoch: 2, transcript_revision: 3 };
    const profile = { schema: 'mem00.source-profile.v1', owner_id: 'intake-owner', session_id: session,
      thread_id: thread, authority, boundary: authority === 'governed' ? boundary : null, observation_only: true };
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(profile)));
    const result = await read([session, 'memory-source-profile'], `?thread_id=${thread}`);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(profile);
    expect(mocks.fetch.mock.calls[0][0]).toContain('memory-source-profile?thread_id=');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { authority: 'unknown' }, { owner_id: 'wrong' }, { observation_only: false },
    { authority: 'governed', boundary: null }, { boundary: {} },
  ])('rejects an unproven profile without legacy fallback %j', async change => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ schema: 'mem00.source-profile.v1', owner_id: 'intake-owner',
      session_id: session, thread_id: thread, authority: 'legacy', boundary: null, observation_only: true, ...change })));
    const result = await read([session, 'memory-source-profile'], `?thread_id=${thread}`);
    expect(result.status).toBe(503);
    expect(await result.text()).toBe('{"available":false}');
  });
  it.each([400, 401, 403, 404, 409, 413, 429, 500, 503, 202, 302])('has a bounded safe failure for upstream HTTP%s without automatic retry', async (status) => {
    mocks.refresh.mockResolvedValue('Bearer refreshed-but-not-used');
    mocks.fetch.mockResolvedValue(new Response('SYNTHETIC RAW FAILURE', { status }));
    const result = await send();
    expect(result.status).toBe([400, 401, 403, 409, 413].includes(status) ? status : 503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.text()).toBe('{"available":false}');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it.each([
    { owner_id: 'wrong-owner' }, { session_id: '20000000-0000-4000-8000-000000000099' },
    { thread_id: '30000000-0000-4000-8000-000000000099' }, { command_key: 'wrong-command-key' },
    { message_id: 'wrong-message-id' }, { memory_clear_epoch: 1 }, { historical_result_only: 1 },
    { historical_result_only: 1.0 }, { idempotent_replay: 'false' }, { sequence: true },
    { transcript_revision: 0 }, { content_ref: 'unknown' }, { created_at: '2026-09-09' },
    { memory_approval: 'granted' }, { current_extraction_eligibility: 'approved' },
    { content: 'SYNTHETIC LEAK' }, { schema: 'old-source-contract' }, { extra: 'SYNTHETIC LEAK' },
  ])('denies malformed or mismatched action receipts %j', async (change) => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ...receipt, ...change })));
    const result = await send();
    expect(result.status).toBe(503);
    expect(await result.text()).toBe('{"available":false}');
  });
  it.each([
    { expected_clear_epoch: true }, { expected_clear_epoch: '0' }, { expected_clear_epoch: -1 },
    { expected_clear_epoch: Number.MAX_SAFE_INTEGER + 1 }, { content: '' }, { content: ' old action ' },
    { content: 'bad\u0000source' }, { content: '🌱'.repeat(262145) }, { user_id: 'injected-owner' },
    { command_key: 'key:with:colon' }, { message_id: 'short' }, { thread_id: 'not-uuid' },
  ])('rejects invalid action before any upstream effect %j', async (change) => {
    const result = await send({ ...action, ...change });
    expect(result.status).toBe(400);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    [[session, 'memory-source-boundary'], ''],
    [[session, 'memory-source-boundary'], `?thread_id=${thread}&thread_id=${thread}`],
    [[session, 'memory-source-boundary'], `?thread_id=${thread}&user_id=wrong`],
    [['memory-source-actions', action.command_key], '?owner=wrong'],
    [['memory-source-actions', 'bad'], ''], [[session, 'memory-source-unknown'], ''],
    [[session, 'memory-source-boundary', 'unexpected'], ''],
  ] as [string[], string][])('denies malformed source paths/queries before generic proxy %j', async (path, query) => {
    expect((await read(path, query)).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it.each([[DELETE, 'DELETE'], [PATCH, 'PATCH'], [PUT, 'PUT']] as const)('denies unsupported source method %s', async (handler, method) => {
    const response = await handler(new NextRequest(`http://localhost/api/sessions/${session}/memory-source-actions`, { method }),
      { params: Promise.resolve({ path: [session, 'memory-source-actions'] }) });
    expect(response.status).toBe(405);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('denies synthetic voice context before ordinary auth/body/upstream work', async () => {
    mocks.denied.mockResolvedValue(new Response('{"error":"voice_lab_ordinary_product_route_forbidden"}', { status: 403 }));
    const result = await send();
    expect(result.status).toBe(403);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('does not fetch or parse upstream data without owner and auth', async () => {
    mocks.owner.mockResolvedValue(null);
    expect((await send()).status).toBe(401);
    mocks.owner.mockResolvedValue('intake-owner'); mocks.auth.mockResolvedValue('');
    expect((await send()).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'committed', receipt: null }, { status: 'not_found', receipt: { ...receipt, idempotent_replay: true } },
    { status: 'committed', receipt },
    { status: 'committed', receipt: { ...receipt, owner_id: 'foreign-owner', idempotent_replay: true } },
    { status: 'committed', receipt: { ...receipt, command_key: 'foreign-command', idempotent_replay: true } },
  ])('rejects inconsistent original-key status %j', async (body) => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ schema: 'mem00.source-action-status.v1',
      owner_id: 'intake-owner', command_key: action.command_key, historical_result_only: true, ...body })));
    expect((await read(['memory-source-actions', action.command_key])).status).toBe(503);
  });
  it('accepts explicit not_found only from a valid same-owner original-key envelope', async () => {
    const body = { schema: 'mem00.source-action-status.v1', owner_id: 'intake-owner', command_key: action.command_key,
      historical_result_only: true, status: 'not_found', receipt: null };
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await (await read(['memory-source-actions', action.command_key])).json()).toEqual(body);
  });
  it('closes on malformed JSON, oversized response and transport outage', async () => {
    for (const payload of ['not-json', JSON.stringify({ ...receipt, extra: 'x'.repeat(32768) })]) {
      mocks.fetch.mockResolvedValue(new Response(payload));
      expect((await send()).status).toBe(503);
    }
    mocks.fetch.mockRejectedValue(new Error('SYNTHETIC SOCKET FAILURE'));
    const result = await send(); expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('SYNTHETIC');
  });
});
