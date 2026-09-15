import { type NextRequest, NextResponse } from 'next/server';

import { commandStatusSchema } from '@/app/lib/memory-command-receipt';
import { voiceLabOrdinaryProductBoundaryResponse } from '@/server/voice-lab/ordinary-route-isolation';

import { fetchSophiaApi, resolveSophiaUserId } from '../../../_lib/sophia';

export async function GET(_request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const denied = await voiceLabOrdinaryProductBoundaryResponse();
    if (denied) {
      denied.headers.set('Cache-Control', 'no-store');
      return denied;
    }
    const owner = await resolveSophiaUserId();
    if (!owner) return NextResponse.json({ available: false }, { status: 401, headers });
    const { key } = await context.params;
    if (key.length < 8 || key.length > 200) {
      return NextResponse.json({ available: false }, { status: 400, headers });
    }
    const response = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(owner)}/memories/commands/${encodeURIComponent(key)}`,
      { method: 'GET', cache: 'no-store' },
    );
    if (!response.ok) {
      return NextResponse.json({ available: false }, { status: [401, 403, 404].includes(response.status) ? response.status : 503, headers });
    }
    const status = commandStatusSchema.safeParse(await response.json());
    if (status.success) return NextResponse.json(status.data, { headers });
  } catch { /* No raw upstream errors, text or request bodies in telemetry. */ }
  return NextResponse.json({ available: false }, { status: 503, headers });
}
