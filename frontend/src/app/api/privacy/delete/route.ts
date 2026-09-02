/**
 * Memory-only privacy deletion.
 *
 * Under MEM00, Sophia's canonical store is the authority. Each active
 * canonical memory is fenced first with an owner/revision-bound operation;
 * provider deletion remains an independently reported projection outcome.
 * The legacy pre-cutover route is retained only as a compatibility lane and
 * can never be reported as a verified canonical deletion.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { getUserScopedAuthHeader } from '../../../lib/auth/server-auth';
import { logger } from '../../../lib/error-logger';
import { fetchSophiaApi, resolveSophiaUserId } from '../../_lib/sophia';

type GatewayMemory = {
  id?: unknown;
  metadata?: Record<string, unknown> | null;
};

type GatewayMemoryList = {
  memories?: GatewayMemory[];
  source?: unknown;
};

type PrivacyReceipt = {
  status: 'accepted_and_fenced' | 'partial_failure' | 'unsupported' | 'failed';
  canonical_memory_fence: string;
  provider_purge: string;
  source_transcript: 'not_deleted';
  derived_artifacts: string;
  cache_invalidation: string;
  other_account_data: 'not_covered_by_mem00';
  memory_count: number;
  fenced_count: number;
  failed_count: number;
  pending_candidate_count: number;
  rejected_candidate_count: number;
  details?: Array<{ memory_ref: string; status: string }>;
};

function receiptResponse(receipt: PrivacyReceipt, status: number) {
  return NextResponse.json(receipt, {
    status,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

function safeMemoryRef(index: number): string {
  return `memory-${index + 1}`;
}

async function legacyDelete(userId: string, authorization: string): Promise<NextResponse> {
  const backendUrl = process.env.BACKEND_API_URL;
  if (!backendUrl) {
    return receiptResponse({
      status: 'unsupported',
      canonical_memory_fence: 'unavailable_before_cutover',
      provider_purge: 'not_attempted',
      source_transcript: 'not_deleted',
      derived_artifacts: 'not_invalidated',
      cache_invalidation: 'not_verified',
      other_account_data: 'not_covered_by_mem00',
      memory_count: 0,
      fenced_count: 0,
      failed_count: 0,
      pending_candidate_count: 0,
      rejected_candidate_count: 0,
    }, 501);
  }

  const legacyResponse = await fetch(
    `${backendUrl}/mem0/${encodeURIComponent(userId)}/memories`,
    { method: 'DELETE', headers: { Authorization: authorization } },
  );
  if (legacyResponse.status === 404) {
    return receiptResponse({
      status: 'unsupported',
      canonical_memory_fence: 'unsupported_legacy_contract',
      provider_purge: 'route_missing_not_success',
      source_transcript: 'not_deleted',
      derived_artifacts: 'not_invalidated',
      cache_invalidation: 'not_verified',
      other_account_data: 'not_covered_by_mem00',
      memory_count: 0,
      fenced_count: 0,
      failed_count: 0,
      pending_candidate_count: 0,
      rejected_candidate_count: 0,
    }, 501);
  }
  if (!legacyResponse.ok) {
    return receiptResponse({
      status: 'failed',
      canonical_memory_fence: 'not_committed',
      provider_purge: 'failed',
      source_transcript: 'not_deleted',
      derived_artifacts: 'not_invalidated',
      cache_invalidation: 'not_verified',
      other_account_data: 'not_covered_by_mem00',
      memory_count: 0,
      fenced_count: 0,
      failed_count: 1,
      pending_candidate_count: 0,
      rejected_candidate_count: 0,
    }, 502);
  }
  return receiptResponse({
    status: 'partial_failure',
    canonical_memory_fence: 'unsupported_legacy_contract',
    provider_purge: 'request_accepted_unverified',
    source_transcript: 'not_deleted',
    derived_artifacts: 'not_invalidated',
    cache_invalidation: 'not_verified',
    other_account_data: 'not_covered_by_mem00',
    memory_count: 0,
    fenced_count: 0,
    failed_count: 0,
    pending_candidate_count: 0,
    rejected_candidate_count: 0,
  }, 202);
}

export async function DELETE(request: NextRequest) {
  const userId = await resolveSophiaUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const listResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/recent?status=approved`,
      { method: 'GET', cache: 'no-store' },
    );
    if (!listResponse.ok) {
      return receiptResponse({
        status: listResponse.status === 404 ? 'unsupported' : 'failed',
        canonical_memory_fence: 'not_committed',
        provider_purge: 'not_attempted',
        source_transcript: 'not_deleted',
        derived_artifacts: 'not_invalidated',
        cache_invalidation: 'not_verified',
        other_account_data: 'not_covered_by_mem00',
        memory_count: 0,
        fenced_count: 0,
        failed_count: 0,
        pending_candidate_count: 0,
        rejected_candidate_count: 0,
      }, listResponse.status === 404 ? 501 : 502);
    }

    const payload = await listResponse.json().catch(() => null) as GatewayMemoryList | null;
    if (payload?.source !== 'sophia_canonical') {
      return legacyDelete(userId, authHeader);
    }

    const [forgottenResponse, pendingResponse] = await Promise.all([
      fetchSophiaApi(
        `/api/sophia/${encodeURIComponent(userId)}/memories/recent?status=forgotten`,
        { method: 'GET', cache: 'no-store' },
      ),
      fetchSophiaApi(
        `/api/sophia/${encodeURIComponent(userId)}/memories/recent?status=pending_review`,
        { method: 'GET', cache: 'no-store' },
      ),
    ]);
    const forgottenPayload = forgottenResponse.ok
      ? await forgottenResponse.json().catch(() => null) as GatewayMemoryList | null
      : null;
    const pendingPayload = pendingResponse.ok
      ? await pendingResponse.json().catch(() => null) as GatewayMemoryList | null
      : null;
    if (
      !forgottenResponse.ok
      || !pendingResponse.ok
      || forgottenPayload?.source !== 'sophia_canonical'
      || pendingPayload?.source !== 'sophia_candidate_ledger'
    ) {
      return receiptResponse({
        status: 'failed',
        canonical_memory_fence: 'not_committed',
        provider_purge: 'not_attempted',
        source_transcript: 'not_deleted',
        derived_artifacts: 'not_invalidated',
        cache_invalidation: 'not_verified',
        other_account_data: 'not_covered_by_mem00',
        memory_count: 0,
        fenced_count: 0,
        failed_count: 1,
        pending_candidate_count: 0,
        rejected_candidate_count: 0,
      }, 502);
    }

    const canonicalById = new Map<string, GatewayMemory>();
    for (const memory of [
      ...(Array.isArray(payload.memories) ? payload.memories : []),
      ...(Array.isArray(forgottenPayload.memories) ? forgottenPayload.memories : []),
    ]) {
      if (typeof memory.id === 'string') canonicalById.set(memory.id, memory);
    }
    const memories = [...canonicalById.values()];
    const pendingCandidates = Array.isArray(pendingPayload.memories) ? pendingPayload.memories : [];
    const details: Array<{ memory_ref: string; status: string }> = [];
    let fencedCount = 0;
    let purgePending = false;
    let rejectedCandidateCount = 0;

    if (pendingCandidates.length > 0) {
      const rejectItems = pendingCandidates.map((candidate) => ({
        id: candidate.id,
        action: 'discard',
        expected_candidate_revision: candidate.metadata?.candidate_revision,
        idempotency_key: `privacy-clear-candidate:${String(candidate.id)}:${String(candidate.metadata?.candidate_revision)}`,
      }));
      if (rejectItems.some((item) => typeof item.id !== 'string' || !Number.isInteger(item.expected_candidate_revision))) {
        details.push({ memory_ref: 'pending-candidates', status: 'invalid_candidate_manifest' });
      } else {
        const rejectResponse = await fetchSophiaApi(
          `/api/sophia/${encodeURIComponent(userId)}/memories/bulk-review`,
          { method: 'POST', body: JSON.stringify({ items: rejectItems }) },
        );
        const rejectPayload = await rejectResponse.json().catch(() => null) as {
          results?: Array<{ status?: unknown }>;
        } | null;
        if (rejectResponse.ok && Array.isArray(rejectPayload?.results)) {
          rejectedCandidateCount = rejectPayload.results.filter((item) => item.status === 'ok').length;
        }
        if (rejectedCandidateCount !== pendingCandidates.length) {
          details.push({ memory_ref: 'pending-candidates', status: 'candidate_rejection_incomplete' });
        }
      }
    }

    for (const [index, memory] of memories.entries()) {
      const memoryId = typeof memory.id === 'string' ? memory.id : '';
      const revision = memory.metadata?.memory_governance_revision;
      if (!memoryId || !Number.isInteger(revision) || (revision as number) < 1) {
        details.push({ memory_ref: safeMemoryRef(index), status: 'invalid_canonical_manifest' });
        continue;
      }
      const deleteResponse = await fetchSophiaApi(
        `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}/permanent-delete`,
        {
          method: 'POST',
          body: JSON.stringify({
            expected_governance_revision: revision,
            idempotency_key: `privacy-clear:${memoryId}:${revision}`,
          }),
        },
      );
      const deleteReceipt = await deleteResponse.json().catch(() => null) as Record<string, unknown> | null;
      if (!deleteResponse.ok || deleteReceipt?.canonical_memory_fence !== 'committed') {
        details.push({ memory_ref: safeMemoryRef(index), status: `fence_failed_${deleteResponse.status}` });
        continue;
      }
      fencedCount += 1;
      purgePending ||= deleteReceipt.provider_purge !== 'purge_verified';
      details.push({ memory_ref: safeMemoryRef(index), status: String(deleteReceipt.provider_purge || 'purge_pending') });
    }

    const failedCount = (memories.length - fencedCount) + (pendingCandidates.length - rejectedCandidateCount);
    return receiptResponse({
      status: failedCount === 0 ? 'accepted_and_fenced' : 'partial_failure',
      canonical_memory_fence: failedCount === 0 ? 'committed' : 'partial',
      provider_purge: memories.length === 0 ? 'not_observed' : purgePending ? 'purge_pending' : 'purge_verified',
      source_transcript: 'not_deleted',
      derived_artifacts: memories.length === 0 ? 'not_required' : 'invalidation_required',
      cache_invalidation: memories.length === 0 ? 'not_required' : 'revocation_epoch_advanced',
      other_account_data: 'not_covered_by_mem00',
      memory_count: memories.length,
      fenced_count: fencedCount,
      failed_count: failedCount,
      pending_candidate_count: pendingCandidates.length,
      rejected_candidate_count: rejectedCandidateCount,
      details,
    }, failedCount === 0 ? 202 : 207);
  } catch (error) {
    logger.logError(error, { component: 'api/privacy/delete', action: 'delete_memory_data', request });
    return receiptResponse({
      status: 'failed',
      canonical_memory_fence: 'not_committed',
      provider_purge: 'not_attempted',
      source_transcript: 'not_deleted',
      derived_artifacts: 'not_invalidated',
      cache_invalidation: 'not_verified',
      other_account_data: 'not_covered_by_mem00',
      memory_count: 0,
      fenced_count: 0,
      failed_count: 1,
      pending_candidate_count: 0,
      rejected_candidate_count: 0,
    }, 500);
  }
}
