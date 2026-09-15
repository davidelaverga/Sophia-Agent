import { NextResponse } from 'next/server';

import { canonicalCommandResultSchema } from '../../lib/memory-command-result';

/** Current plaintext comes only from the exact current view, never the request. */
export async function canonicalCommandResponse(response: Response, owner: string, key: string, eventType: string, memoryId?: string) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (!response.ok) {
      return NextResponse.json({ error: 'Memory command unavailable' }, {
        status: [401, 403, 404, 409, 422].includes(response.status) ? response.status : 503, headers,
      });
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('Command response too large');
    const parsed = canonicalCommandResultSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.owner_id !== owner || parsed.data.command_key !== key
      || parsed.data.receipt.event_type !== eventType || (memoryId && parsed.data.receipt.memory_id !== memoryId)) {
      throw new Error('Command result unavailable');
    }
    return NextResponse.json(parsed.data, { headers });
  } catch {
    return NextResponse.json({ error: 'Memory command result unavailable' }, { status: 503, headers });
  }
}
