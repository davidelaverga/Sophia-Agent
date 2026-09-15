import { NextResponse } from 'next/server';
import { z } from 'zod';

import { canonicalCommandResponse } from './memory-command-response';
import { fetchSophiaApi } from './sophia';

const lifecyclePayload = z.object({ expected_governance_revision: z.number().int().safe().positive(),
  idempotency_key: z.string().min(8).max(200) }).strict();
const events = { forget: 'memory_forgotten', restore: 'memory_restored', 'permanent-delete': 'memory_tombstoned' } as const;

export async function forwardCanonicalLifecycle(owner: string, memoryId: string, action: keyof typeof events, body: unknown) {
  const headers = { 'Cache-Control': 'no-store' };
  const parsed = lifecyclePayload.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid memory lifecycle command' }, { status: 400, headers });
  try {
    const response = await fetchSophiaApi(`/api/sophia/${encodeURIComponent(owner)}/memories/${encodeURIComponent(memoryId)}/${action}`,
      { method: 'POST', body: JSON.stringify(parsed.data) });
    return canonicalCommandResponse(response, owner, parsed.data.idempotency_key, events[action], memoryId);
  } catch {
    return NextResponse.json({ error: 'Memory lifecycle command unavailable' }, { status: 503, headers });
  }
}
