import { z } from 'zod';

const schema = z.strictObject({ schema: z.literal('mem00.chat-authority.v1'),
  owner_id: z.string().min(1), authority: z.enum(['legacy', 'governed']), observation_only: z.literal(true) });

/** Fresh routing observation only. Backend source/model admission remains mandatory. */
export async function readChatMemoryAuthority(owner: string, token: string | null, gateway: string, signal?: AbortSignal): Promise<'legacy' | 'governed'> {
  if (!owner || !token) throw new Error('memory_authority_unavailable');
  try {
    const response = await fetch(`${gateway}/api/sophia-auth/memory-authority`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('unavailable');
    }
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) throw new Error('unavailable');
        text += decoder.decode(chunk.value, { stream: true });
      }
      const result = schema.parse(JSON.parse(text + decoder.decode()));
      if (result.owner_id !== owner) throw new Error('owner');
      return result.authority;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  } catch { throw new Error('memory_authority_unavailable'); }
}
