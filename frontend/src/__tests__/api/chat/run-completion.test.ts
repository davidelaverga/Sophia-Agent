import { afterEach, expect, it, vi } from 'vitest';

import { createRunCompletionCheck } from '../../../app/api/chat/_lib/run-completion';

const thread = '30000000-0000-4000-8000-000000000001', run = '40000000-0000-4000-8000-000000000001';
const other = '50000000-0000-4000-8000-000000000001';
const location = `/threads/${thread}/runs/${run}`;
const result = (status = 'success', extra = {}) => new Response(JSON.stringify({ run_id: run, thread_id: thread, status, ...extra }), {
  headers: { 'Content-Type': 'application/json' },
});
const check = (contentLocation: string | null = location, signal?: AbortSignal, token: string | null = 'synthetic-token') => createRunCompletionCheck({
  backendUrl: 'https://synthetic.invalid/proxy/threads', threadId: thread, token, signal,
  upstream: new Response('', { headers: contentLocation === null ? {} : { 'Content-Location': contentLocation } }),
});
afterEach(() => vi.unstubAllGlobals());

it('checks exact owner-authenticated run once, without following the header URL or reusing confirmation', async () => {
  const network = vi.fn().mockResolvedValue(result()); vi.stubGlobal('fetch', network);
  const confirm = check();
  expect(await confirm()).toBe(true); expect(await confirm()).toBe(false);
  expect(network).toHaveBeenCalledOnce();
  expect(network).toHaveBeenCalledWith(`https://synthetic.invalid/proxy/threads/${thread}/runs/${run}`, expect.objectContaining({
    method: 'GET', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', Authorization: 'Bearer synthetic-token' },
  }));
});
it.each([null, '', `https://another.invalid${location}`, `${location}?status=success`, `/threads/${other}/runs/${run}`, `${location}/stream`, '/threads/../runs/x'])(
  'missing or foreign stream location is unconfirmed without network: %s', async value => {
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    expect(await check(value)()).toBe(false); expect(network).not.toHaveBeenCalled();
  });
it.each(['error', 'timeout', 'interrupted', 'unknown'])('never confirms terminal %s', async status => {
  const network = vi.fn().mockResolvedValue(result(status)); vi.stubGlobal('fetch', network);
  expect(await check()()).toBe(false); expect(network).toHaveBeenCalledOnce();
});
it.each([{ run_id: other }, { thread_id: other }, { status: true }])('rejects wrong run/thread/status %j', async extra => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result('success', extra)));
  expect(await check()()).toBe(false);
});
it('allows bounded pending/running visibility to settle, not an unbounded poll', async () => {
  const network = vi.fn().mockImplementationOnce(async () => result('pending')).mockImplementationOnce(async () => result('running'))
    .mockImplementationOnce(async () => result()); vi.stubGlobal('fetch', network);
  expect(await check()()).toBe(true); expect(network).toHaveBeenCalledTimes(3);
  network.mockReset().mockImplementation(async () => result('running'));
  expect(await check()()).toBe(false); expect(network).toHaveBeenCalledTimes(3);
});
it.each([401, 403, 404, 503])('fails closed on owner/availability HTTP%s', async status => {
  const network = vi.fn().mockResolvedValue(new Response('SYNTHETIC PRIVATE ERROR', { status })); vi.stubGlobal('fetch', network);
  expect(await check()()).toBe(false); expect(network).toHaveBeenCalledOnce();
});
it('does not confirm after cancellation even if a transport ignores its signal', async () => {
  const abort = new AbortController();
  const network = vi.fn().mockImplementation(async () => { abort.abort(); return result(); }); vi.stubGlobal('fetch', network);
  expect(await check(location, abort.signal)()).toBe(false);
  network.mockClear(); expect(await check(location, abort.signal)()).toBe(false); expect(network).not.toHaveBeenCalled();
});
it('requires an authenticated owner token and refuses malformed/oversized JSON or transport failure', async () => {
  const network = vi.fn(); vi.stubGlobal('fetch', network);
  expect(await check(location, undefined, null)()).toBe(false); expect(network).not.toHaveBeenCalled();
  for (const text of ['not json', JSON.stringify({ run_id: run }), JSON.stringify({ padding: 'x'.repeat(16 * 1024 * 1024) })]) {
    network.mockResolvedValueOnce(new Response(text, { headers: { 'Content-Type': 'application/json' } }));
    expect(await check()()).toBe(false);
  }
  network.mockRejectedValueOnce(new Error('SYNTHETIC PRIVATE NETWORK'));
  expect(await check()()).toBe(false);
});
