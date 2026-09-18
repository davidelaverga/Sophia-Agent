import { beforeEach, expect, it, vi } from 'vitest';
import { readChatMemoryAuthority } from '../../../app/api/chat/_lib/memory-authority';

const fetchMock = vi.fn();
const response = { schema: 'mem00.chat-authority.v1', owner_id: 'owner', authority: 'governed', observation_only: true };
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
it.each(['governed', 'legacy'])('accepts only an exact current %s observation for the authenticated owner', async authority => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...response, authority })));
  expect(await readChatMemoryAuthority('owner', 'synthetic-token', 'https://gateway.invalid')).toBe(authority);
  expect(fetchMock).toHaveBeenCalledWith('https://gateway.invalid/api/sophia-auth/memory-authority', expect.objectContaining({
    method: 'GET', cache: 'no-store', redirect: 'error', headers: { Authorization: 'Bearer synthetic-token', Accept: 'application/json' },
  }));
});
it.each([null, {}, { ...response, owner_id: 'wrong' }, { ...response, authority: 'unknown' },
  { ...response, observation_only: false }, { ...response, extra: 'PRIVATE' }])('denies malformed observation %j', async value => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(value)));
  await expect(readChatMemoryAuthority('owner', 'synthetic-token', 'https://gateway.invalid')).rejects.toThrow('memory_authority_unavailable');
});
it.each([302, 401, 404, 503])('does not infer legacy from HTTP%s', async status => {
  fetchMock.mockResolvedValue(new Response('PRIVATE', { status }));
  await expect(readChatMemoryAuthority('owner', 'synthetic-token', 'https://gateway.invalid')).rejects.toThrow('memory_authority_unavailable');
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('does not reuse a previous observation after outage', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response))).mockRejectedValueOnce(new Error('PRIVATE'));
  expect(await readChatMemoryAuthority('owner', 'synthetic-token', 'https://gateway.invalid')).toBe('governed');
  await expect(readChatMemoryAuthority('owner', 'synthetic-token', 'https://gateway.invalid')).rejects.toThrow('memory_authority_unavailable');
});
it('bounds the authority body and refuses absent credentials before fetch', async () => {
  await expect(readChatMemoryAuthority('owner', null, 'https://gateway.invalid')).rejects.toThrow('memory_authority_unavailable');
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValue(new Response(' '.repeat(4097)));
  await expect(readChatMemoryAuthority('owner', 'synthetic-token', 'https://gateway.invalid')).rejects.toThrow('memory_authority_unavailable');
});
