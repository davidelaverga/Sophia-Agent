import { type NextRequest, NextResponse } from 'next/server';

import { logger } from '../../../lib/error-logger';
import { fetchSophiaApi, resolveSophiaUserId } from '../../_lib/sophia';

type GatewayMemory = {
  id?: string;
  session_id?: string;
  content?: string;
  memory?: string;
  category?: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};

type NormalizedMemory = {
  id: string;
  sessionId?: string;
  text: string;
  category?: string;
  created_at?: string;
  updated_at?: string;
  confidence?: number;
  reason?: string;
  metadata?: Record<string, unknown> | null;
  candidate_revision?: number;
  review_state?: string;
  projection_state?: string;
  authority?: string;
};

type GatewayMemoryListPayload = {
  memories?: GatewayMemory[];
  count?: number;
  source?: string;
  candidate_count?: number;
  session_id_received?: boolean;
  local_overlay_count?: number;
  skipped_mem0_hydration_for_session_scope?: boolean;
  empty_reason?: string | null;
  trace_id?: string;
};

const FALLBACK_WINDOW_BEFORE_MS = 10 * 60 * 1000;
const FALLBACK_WINDOW_AFTER_MS = 30 * 60 * 1000;

function createUnavailableRecentMemoriesResponse(sessionId?: string | null) {
  return NextResponse.json({
    memories: [],
    count: 0,
    fallbackApplied: true,
    unavailable: true,
    ...buildSafeRecentDiagnostics({
      count: 0,
      fallbackApplied: true,
      gatewayPayload: null,
      sessionId,
      sourceOverride: 'error',
      unavailable: true,
    }),
  });
}

function getMemoryStatus(memory: NormalizedMemory): string | null {
  return typeof memory.metadata?.status === 'string'
    ? memory.metadata.status
    : null;
}

function getMemorySessionId(memory: NormalizedMemory): string | null {
  return typeof memory.sessionId === 'string'
    ? memory.sessionId
    : typeof memory.metadata?.session_id === 'string'
    ? memory.metadata.session_id
    : typeof memory.metadata?.source_session_id === 'string'
      ? memory.metadata.source_session_id
      : null;
}

function matchesRequestedStatus(memory: NormalizedMemory, status: string | null): boolean {
  const memoryStatus = getMemoryStatus(memory);

  if (!status) {
    return true;
  }

  if (status === 'pending_review') {
    return memoryStatus === null || memoryStatus === 'pending_review';
  }

  return memoryStatus === status;
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
    sessionId: typeof memory.session_id === 'string' ? memory.session_id : undefined,
    text,
    category: typeof memory.category === 'string'
      ? memory.category
      : typeof metadata?.category === 'string'
        ? metadata.category
        : undefined,
    created_at: typeof memory.created_at === 'string'
      ? memory.created_at
      : typeof memory.updated_at === 'string'
        ? memory.updated_at
        : undefined,
    updated_at: typeof memory.updated_at === 'string' ? memory.updated_at : undefined,
    confidence,
    reason,
    metadata,
    candidate_revision: typeof metadata?.candidate_revision === 'number'
      ? metadata.candidate_revision
      : undefined,
    review_state: typeof metadata?.review_state === 'string'
      ? metadata.review_state
      : undefined,
    projection_state: typeof metadata?.projection_state === 'string'
      ? metadata.projection_state
      : undefined,
    authority: typeof metadata?.authority === 'string' ? metadata.authority : undefined,
  };
}

async function fetchMemoryList(userId: string, status?: string | null, sessionId?: string | null): Promise<Response> {
  const params = new URLSearchParams();
  if (status) {
    params.set('status', status);
  }
  if (sessionId) {
    params.set('session_id', sessionId);
  }

  const query = params.toString();
  const suffix = query ? `?${query}` : '';

  return fetchSophiaApi(
    `/api/sophia/${encodeURIComponent(userId)}/memories/recent${suffix}`,
    { method: 'GET' },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

function normalizeSource(value: string | null, fallbackApplied: boolean, count: number): string {
  switch (value) {
    case 'local_review_overlay':
    case 'global_hydration':
    case 'mem0':
    case 'none':
    case 'error':
      return value;
    default:
      if (fallbackApplied) {
        return 'global_hydration';
      }
      return count > 0 ? 'mem0' : 'none';
  }
}

function buildSafeRecentDiagnostics({
  count,
  fallbackApplied,
  gatewayPayload,
  sessionId,
  sourceOverride,
  unavailable = false,
}: {
  count: number;
  fallbackApplied: boolean;
  gatewayPayload: GatewayMemoryListPayload | null;
  sessionId?: string | null;
  sourceOverride?: string;
  unavailable?: boolean;
}) {
  const gatewayRecord = asRecord(gatewayPayload);
  const source = normalizeSource(
    sourceOverride ?? readString(gatewayRecord, 'source'),
    fallbackApplied,
    count,
  );
  const diagnostics = {
    source,
    candidate_count: count,
    session_id_received: Boolean(sessionId),
    next_proxy_forwarded_session_id: Boolean(sessionId),
    gateway_received_session_id: readBoolean(gatewayRecord, 'session_id_received') === true,
    local_overlay_count: readNumber(gatewayRecord, 'local_overlay_count') ?? 0,
    skipped_mem0_hydration_for_session_scope:
      readBoolean(gatewayRecord, 'skipped_mem0_hydration_for_session_scope') ?? false,
    trace_id: readString(gatewayRecord, 'trace_id'),
    empty_reason: count > 0
      ? null
      : sessionId
        ? 'no_session_candidates'
        : 'no_results',
    unavailable,
  };

  return {
    ...diagnostics,
    debug: diagnostics,
  };
}

function isSessionScopedPendingReviewTerminalEmpty(
  payload: GatewayMemoryListPayload,
  sessionId: string | null,
  status: string | null,
): boolean {
  if (!sessionId || status !== 'pending_review') {
    return false;
  }

  const record = asRecord(payload);
  const count = readNumber(record, 'candidate_count') ?? readNumber(record, 'count') ?? 0;
  const emptyReason = readString(record, 'empty_reason');
  const source = readString(record, 'source');

  return count === 0 && (
    emptyReason === 'no_session_candidates'
    || source === 'local_review_overlay'
    || source === 'none'
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
    const sessionId = request.nextUrl.searchParams.get('session_id');
    if (!userId) {
      if (status === 'pending_review') {
        return createUnavailableRecentMemoriesResponse(sessionId);
      }

      return NextResponse.json(
        { error: 'Unable to resolve user_id' },
        { status: 401 },
      );
    }

    const startedAt = request.nextUrl.searchParams.get('started_at');
    const endedAt = request.nextUrl.searchParams.get('ended_at');
    const shouldApplyScopedFilter = Boolean(status && (sessionId || startedAt || endedAt));

    const filteredResponse = await fetchMemoryList(userId, status, sessionId);
    const filteredText = await filteredResponse.text();

    if (!filteredResponse.ok) {
      if (status === 'pending_review' && [401, 403, 503].includes(filteredResponse.status)) {
        return createUnavailableRecentMemoriesResponse(sessionId);
      }

      return new NextResponse(filteredText, {
        status: filteredResponse.status,
        headers: {
          'Content-Type': filteredResponse.headers.get('content-type') || 'application/json',
        },
      });
    }

    const filteredPayload = filteredText
      ? JSON.parse(filteredText) as GatewayMemoryListPayload
      : { memories: [], count: 0 };

    const filteredMemories = Array.isArray(filteredPayload.memories)
      ? filteredPayload.memories.map(normalizeGatewayMemory).filter((memory): memory is NormalizedMemory => memory !== null)
      : [];

    if (!shouldApplyScopedFilter) {
      return NextResponse.json({
        memories: filteredMemories.map(({ metadata: _metadata, ...memory }) => memory),
        count: filteredMemories.length,
        fallbackApplied: false,
        ...buildSafeRecentDiagnostics({
          count: filteredMemories.length,
          fallbackApplied: false,
          gatewayPayload: filteredPayload,
          sessionId,
        }),
      });
    }

    const scopedFilteredMemories = selectFallbackMemories(filteredMemories, sessionId, startedAt, endedAt)
      .filter((memory) => matchesRequestedStatus(memory, status));

    if (scopedFilteredMemories.length > 0) {
      return NextResponse.json({
        memories: scopedFilteredMemories.map(({ metadata: _metadata, ...memory }) => memory),
        count: scopedFilteredMemories.length,
        fallbackApplied: false,
        ...buildSafeRecentDiagnostics({
          count: scopedFilteredMemories.length,
          fallbackApplied: false,
          gatewayPayload: filteredPayload,
          sessionId,
        }),
      });
    }

    if (isSessionScopedPendingReviewTerminalEmpty(filteredPayload, sessionId, status)) {
      return NextResponse.json({
        memories: [],
        count: 0,
        fallbackApplied: false,
        ...buildSafeRecentDiagnostics({
          count: 0,
          fallbackApplied: false,
          gatewayPayload: filteredPayload,
          sessionId,
        }),
      });
    }

    const unfilteredResponse = await fetchMemoryList(userId, null, sessionId);
    const unfilteredText = await unfilteredResponse.text();

    if (!unfilteredResponse.ok) {
      return NextResponse.json({
        memories: [],
        count: 0,
        fallbackApplied: true,
        ...buildSafeRecentDiagnostics({
          count: 0,
          fallbackApplied: true,
          gatewayPayload: null,
          sessionId,
          sourceOverride: 'error',
        }),
      });
    }

    const unfilteredPayload = unfilteredText
      ? JSON.parse(unfilteredText) as GatewayMemoryListPayload
      : { memories: [], count: 0 };

    const allMemories = Array.isArray(unfilteredPayload.memories)
      ? unfilteredPayload.memories.map(normalizeGatewayMemory).filter((memory): memory is NormalizedMemory => memory !== null)
      : [];

    const scopedMemories = selectFallbackMemories(allMemories, sessionId, startedAt, endedAt)
      .filter((memory) => matchesRequestedStatus(memory, status));

    return NextResponse.json({
      memories: scopedMemories.map(({ metadata: _metadata, ...memory }) => memory),
      count: scopedMemories.length,
      fallbackApplied: true,
      ...buildSafeRecentDiagnostics({
        count: scopedMemories.length,
        fallbackApplied: true,
        gatewayPayload: unfilteredPayload,
        sessionId,
      }),
    });
  } catch (error) {
    logger.logError(error, { component: 'api/memory/recent', action: 'list_recent_memories', request });
    return NextResponse.json(
      { error: 'Failed to fetch recent memories' },
      { status: 500 },
    );
  }
}
