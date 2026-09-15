import { type NextRequest, NextResponse } from 'next/server';

import { getAuthenticatedUserId, getUserScopedAuthHeader } from '@/app/lib/auth/server-auth';
import {
  sourceActionKey, sourceActionReceiptSchema, sourceActionSchema, sourceActionStatusSchema,
  sourceBoundarySchema, sourceProfileSchema, sourceUuid, type SourceAction,
} from '@/app/lib/memory-source-contract';
import { voiceLabOrdinaryProductBoundaryResponse } from '@/server/voice-lab/ordinary-route-isolation';

import { getPrimaryGatewayUrl } from './gateway-url';

const headers = { 'Cache-Control': 'no-store' };
const unavailable = (status: number) => NextResponse.json({ available: false }, { status, headers });

// Intercept even malformed source paths so they cannot fall into the generic
// session proxy's owner-body rewriting, response preview logging or retries.
export function isMemorySourcePath(path: string[]): boolean {
  return path.some(part => part.startsWith('memory-source-'));
}

async function boundedJson(body: ReadableStream<Uint8Array> | null, limit: number): Promise<unknown> {
  if (!body) throw new Error('source_body_missing');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('source_body_limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Exact source transport only; no implicit epoch refresh or action reissue. */
export async function proxyMemorySource(req: NextRequest, path: string[]): Promise<Response> {
  try {
    const denied = await voiceLabOrdinaryProductBoundaryResponse();
    if (denied) { denied.headers.set('Cache-Control', 'no-store'); return denied; }
    const owner = await getAuthenticatedUserId();
    if (!owner) return unavailable(401);
    if (path.includes('memory-source-uploads')) return unavailable(503); // C2 text-only: upload intake is not enabled.
    const method = req.method.toUpperCase();
    if (path.length !== 2) return unavailable(400);
    const lookup = path[0] === 'memory-source-actions' && sourceActionKey.safeParse(path[1]).success;
    const boundary = sourceUuid.safeParse(path[0]).success && path[1] === 'memory-source-boundary';
    const profile = sourceUuid.safeParse(path[0]).success && path[1] === 'memory-source-profile';
    const action = sourceUuid.safeParse(path[0]).success && path[1] === 'memory-source-actions';
    if (!lookup && !boundary && !profile && !action) return unavailable(400);
    if (method !== (action ? 'POST' : 'GET')) return unavailable(405);
    const query = Array.from(req.nextUrl.searchParams.entries());
    const thread = req.nextUrl.searchParams.get('thread_id');
    if ((boundary || profile) ? query.length !== 1 || query[0]?.[0] !== 'thread_id' || !sourceUuid.safeParse(thread).success : query.length !== 0) {
      return unavailable(400);
    }
    let command: SourceAction | undefined;
    if (action) {
      try {
        command = sourceActionSchema.parse(await boundedJson(req.body, 2 * 1024 * 1024));
      } catch { return unavailable(400); }
    }
    const authorization = await getUserScopedAuthHeader();
    if (!authorization) return unavailable(401);
    const url = new URL(`${getPrimaryGatewayUrl()}/api/v1/sessions/${path.map(encodeURIComponent).join('/')}`);
    if ((boundary || profile) && thread !== null) url.searchParams.set('thread_id', thread);
    const response = await fetch(url.toString(), {
      method, cache: 'no-store', redirect: 'error',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      ...(command ? { body: JSON.stringify(command) } : {}),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(15000)]),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return unavailable([400, 401, 403, 409, 413].includes(response.status) ? response.status : 503);
    }
    const payload = await boundedJson(response.body, 32 * 1024);
    if (profile) {
      const result = sourceProfileSchema.parse(payload);
      if (result.owner_id !== owner || result.session_id !== path[0] || result.thread_id !== thread) return unavailable(503);
      return NextResponse.json(result, { headers });
    }
    if (boundary) {
      const result = sourceBoundarySchema.parse(payload);
      if (result.owner_id !== owner || result.session_id !== path[0] || result.thread_id !== thread) return unavailable(503);
      return NextResponse.json(result, { headers });
    }
    if (command) {
      const result = sourceActionReceiptSchema.parse(payload);
      if (result.owner_id !== owner || result.session_id !== path[0] || result.thread_id !== command.thread_id
        || result.command_key !== command.command_key || result.message_id !== command.message_id
        || result.memory_clear_epoch !== command.expected_clear_epoch) return unavailable(503);
      return NextResponse.json(result, { headers });
    }
    const result = sourceActionStatusSchema.parse(payload);
    if (result.owner_id !== owner || result.command_key !== path[1]) return unavailable(503);
    return NextResponse.json(result, { headers });
  } catch { return unavailable(503); }
}
