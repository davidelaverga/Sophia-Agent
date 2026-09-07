import { NextResponse } from 'next/server';

import { sanitizeMemoryObservation } from '../../../lib/memory-observability';
import { fetchSophiaApi, resolveSophiaUserId } from '../../_lib/sophia';

export async function GET() {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const owner = await resolveSophiaUserId();
    if (!owner) return NextResponse.json({ available: false }, { status: 401, headers });
    const response = await fetchSophiaApi(`/api/sophia/${encodeURIComponent(owner)}/memory-observability`, { method: 'GET', cache: 'no-store' });
    if (!response.ok) {
      const status = [401, 403, 404].includes(response.status) ? response.status : 503;
      return NextResponse.json({ available: false }, { status, headers });
    }
    const observation = sanitizeMemoryObservation(await response.json());
    if (observation.available) return NextResponse.json(observation.snapshot, { headers });
  } catch { /* Do not forward raw upstream diagnostics or credentials. */ }
  return NextResponse.json({ available: false }, { status: 503, headers });
}
