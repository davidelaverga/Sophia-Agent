import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../../lib/error-logger';
import { fetchSophiaApi, resolveSophiaUserId } from '../../_lib/sophia';

type GatewayMemory = {
  id?: string;
  content?: string;
  memory?: string;
  category?: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};

type NormalizedMemory = {
  id: string;
  text: string;
  category?: string;
  created_at?: string;
  confidence?: number;
  reason?: string;
  metadata?: Record<string, unknown> | null;
};

const FALLBACK_WINDOW_BEFORE_MS = 10 * 60 * 1000;
const FALLBACK_WINDOW_AFTER_MS = 30 * 60 * 1000;

function createUnavailableRecentMemoriesResponse() {
  return NextResponse.json({ memories: [], count: 0, fallbackApplied: true, unavailable: true });
}

function getMemoryStatus(memory: NormalizedMemory): string | null {
  return typeof memory.metadata?.status === 'string'
    ? memory.metadata.status
    : null;
}

function getMemorySessionId(memory: NormalizedMemory): string | null {
  return typeof memory.metadata?.session_id === 'string'
    ? memory.metadata.session_id
    : typeof memory.metadata?.source_session_id === 'string'
      ? memory.metadata.source_session_id
      : null;
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeGatewayMemory(memory: GatewayMemory): NormalizedMemory | null {
  const text = typeof memory.content === 'string'
    ? memory.content.trim()
    : typeof memory.memory === 'string'
      ? memory.memory.trim()
      : '';

  if (!text || typeof memory.id !== 'string' || memory.id.trim().length === 0) {
    return null;
  }

  const metadata = memory.metadata && typeof memory.metadata === 'object'
    ? memory.metadata
    : null;

  const confidence = typeof metadata?.confidence === 'number'
    ? metadata.confidence
    : undefined;

  const reason = typeof metadata?.reason === 'string'
    ? metadata.reason
    : typeof metadata?.source === 'string'
      ? metadata.source
      : undefined;

  return {
    id: memory.id,
    text,
    category: typeof memory.category === 'string'
      ? memory.category
      : typeof metadata?.category === 'string'
        ? metadata.category
        : undefined,
    created_at: typeof memory.created_at === 'string' ? memory.created_at : undefined,
    confidence,
    reason,
    metadata,
  };
}

async function fetchMemoryList(userId: string, status?: string | null): Promise<Response> {
  const params = new URLSearchParams();
  if (status) {
    params.set('status', status);
  }

  const query = params.toString();
  const suffix = query ? `?${query}` : '';

  return fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/memories/recent${suffix}`,
    { method: 'GET' },
  );
}

function selectFallbackMemories(
  memories: NormalizedMemory[],
  sessionId: string | null,
  startedAt: string | null,
  endedAt: string | null,
): NormalizedMemory[] {
  if (sessionId) {
    const bySession = memories.filter((memory) => getMemorySessionId(memory) === sessionId);

    if (bySession.length > 0) {
      return bySession;
    }

    memories = memories.filter((memory) => getMemorySessionId(memory) === null);

    if (memories.length === 0) {
      return [];
    }
  }

  const startTs = parseIsoTimestamp(startedAt);
  const endTs = parseIsoTimestamp(endedAt);

  if (startTs === null && endTs === null) {
    return [];
  }

  const lowerBound = (startTs ?? endTs ?? 0) - FALLBACK_WINDOW_BEFORE_MS;
  const upperBound = (endTs ?? startTs ?? 0) + FALLBACK_WINDOW_AFTER_MS;

  return memories.filter((memory) => {
    const createdAtTs = parseIsoTimestamp(memory.created_at);
    return createdAtTs !== null && createdAtTs >= lowerBound && createdAtTs <= upperBound;
  });
}

export async function GET(request: NextRequest) {
  try {
    const status = request.nextUrl.searchParams.get('status');
    const userId = await resolveSophiaUserId();
    if (!userId) {
      if (status === 'pending_review') {
        return createUnavailableRecentMemoriesResponse();
      }

      return NextResponse.json(
        { error: 'Unable to resolve user_id' },
        { status: 401 },
      );
    }

    const sessionId = request.nextUrl.searchParams.get('session_id');
    const startedAt = request.nextUrl.searchParams.get('started_at');
    const endedAt = request.nextUrl.searchParams.get('ended_at');

    const filteredResponse = await fetchMemoryList(userId, status);
    const filteredText = await filteredResponse.text();

    if (!filteredResponse.ok) {
      if (status === 'pending_review' && [401, 403, 503].includes(filteredResponse.status)) {
        return createUnavailableRecentMemoriesResponse();
      }

      return new NextResponse(filteredText, {
        status: filteredResponse.status,
        headers: {
          'Content-Type': filteredResponse.headers.get('content-type') || 'application/json',
        },
      });
    }

    const filteredPayload = filteredText
      ? JSON.parse(filteredText) as { memories?: GatewayMemory[]; count?: number }
      : { memories: [], count: 0 };

    const filteredMemories = Array.isArray(filteredPayload.memories)
      ? filteredPayload.memories.map(normalizeGatewayMemory).filter((memory): memory is NormalizedMemory => memory !== null)
      : [];

    const scopedFilteredMemories = status === 'pending_review'
      ? selectFallbackMemories(filteredMemories, sessionId, startedAt, endedAt)
        .filter((memory) => {
          const memoryStatus = getMemoryStatus(memory);
          return memoryStatus === null || memoryStatus === 'pending_review';
        })
      : filteredMemories;

    if (status !== 'pending_review' || scopedFilteredMemories.length > 0) {
      return NextResponse.json({
        memories: (status === 'pending_review' ? scopedFilteredMemories : filteredMemories)
          .map(({ metadata: _metadata, ...memory }) => memory),
        count: status === 'pending_review' ? scopedFilteredMemories.length : filteredMemories.length,
        fallbackApplied: false,
      });
    }

    const unfilteredResponse = await fetchMemoryList(userId);
    const unfilteredText = await unfilteredResponse.text();

    if (!unfilteredResponse.ok) {
      return NextResponse.json({ memories: [], count: 0, fallbackApplied: true });
    }

    const unfilteredPayload = unfilteredText
      ? JSON.parse(unfilteredText) as { memories?: GatewayMemory[]; count?: number }
      : { memories: [], count: 0 };

    const allMemories = Array.isArray(unfilteredPayload.memories)
      ? unfilteredPayload.memories.map(normalizeGatewayMemory).filter((memory): memory is NormalizedMemory => memory !== null)
      : [];

    const scopedMemories = selectFallbackMemories(allMemories, sessionId, startedAt, endedAt)
      .filter((memory) => {
        const memoryStatus = getMemoryStatus(memory);
        return memoryStatus === null || memoryStatus === 'pending_review';
      });

    return NextResponse.json({
      memories: scopedMemories.map(({ metadata: _metadata, ...memory }) => memory),
      count: scopedMemories.length,
      fallbackApplied: true,
    });
  } catch (error) {
    logger.logError(error, { component: 'api/memory/recent', action: 'list_recent_memories' });
    return NextResponse.json(
      { error: 'Failed to fetch recent memories' },
      { status: 500 },
    );
  }
}