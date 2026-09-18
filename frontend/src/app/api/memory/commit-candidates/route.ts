/**
 * Memory Commit Candidates API Route
 * Phase 3 - Week 3
 *
 * POST /api/memory/commit-candidates
 *
 * Commits recap-reviewed memory candidates through the Sophia gateway.
 *
 * MEM00-C2 WP1 contract: upstream results are joined by exact candidate
 * identity plus the requested action, never by position. Every response is
 * no-store, and the original command key is echoed back content-free so a lost
 * successful response is recovered from the existing command-receipt route
 * instead of being re-submitted. An outcome that cannot be joined exactly is
 * reported `ambiguous`, which is distinct from a definite `error`: ambiguous
 * means "committed state unknown, go read the receipt", never "retry".
 */

import { type NextRequest, NextResponse } from 'next/server';

import { voiceLabOrdinaryProductBoundaryResponse } from '@/server/voice-lab/ordinary-route-isolation';

import { logger } from '../../../lib/error-logger';
import { fetchSophiaApi, resolveSophiaUserId } from '../../_lib/sophia';

// =============================================================================
// TYPES
// =============================================================================

interface CommitDecision {
  candidate_id: string;
  decision: 'approve' | 'discard';
  text: string;
  category?: string;
  source: 'recap';
  metadata?: {
    session_type?: string;
    preset?: string;
  };
  expected_candidate_revision?: number;
  idempotency_key?: string;
}

interface CommitRequest {
  session_id: string;
  thread_id?: string;
  decisions: CommitDecision[];
  user_id?: string;
}

interface CommitResponse {
  committed: string[];
  discarded: string[];
  errors: Array<{
    candidate_id: string;
    message: string;
  }>;
  /**
   * Committed state could not be joined exactly. The caller must read the
   * original command receipt; it must not re-submit the decision.
   */
  ambiguous: string[];
  /**
   * Content-free references bound to the original command key, so recovery
   * survives a lost response and a reload without persisting memory text.
   */
  commands: Array<{
    candidate_id: string;
    idempotency_key: string;
    expected_candidate_revision: number;
  }>;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function noStore(json: unknown, status = 200) {
  return NextResponse.json(json, { status, headers: NO_STORE });
}

/** Only the requested action confirms a decision; an echoed mismatch is not a join. */
function requestedAction(decision: CommitDecision): 'approve' | 'discard' {
  return decision.decision === 'discard' ? 'discard' : 'approve';
}

export async function POST(request: NextRequest) {
  const voiceLabDenied = await voiceLabOrdinaryProductBoundaryResponse();
  if (voiceLabDenied) {
    voiceLabDenied.headers.set('Cache-Control', 'no-store');
    return voiceLabDenied;
  }

  try {
    const body = await request.json() as CommitRequest;

    // Validate request
    if (!body.session_id) {
      return noStore({ error: 'session_id is required' }, 400);
    }

    const userId = await resolveSophiaUserId();
    if (!userId) {
      return noStore({ error: 'Unable to resolve user_id' }, 401);
    }

    if (!body.decisions || !Array.isArray(body.decisions) || body.decisions.length === 0) {
      return noStore({ error: 'decisions array is required and must not be empty' }, 400);
    }

    // Validate each decision. The canonical ledger requires an exact revision
    // and command key; fail the whole request truthfully rather than letting
    // the upstream return a per-item error that hides the missing binding.
    const seen = new Set<string>();
    for (const decision of body.decisions) {
      if (!decision.candidate_id) {
        return noStore({ error: 'Each decision must have a candidate_id' }, 400);
      }
      if (!['approve', 'discard'].includes(decision.decision)) {
        return noStore({ error: `Invalid decision value: ${decision.decision}` }, 400);
      }
      const revision = decision.expected_candidate_revision;
      if (!Number.isInteger(revision) || (revision ?? 0) <= 0) {
        return noStore({ error: 'Each decision must carry a positive expected_candidate_revision' }, 400);
      }
      const key = decision.idempotency_key;
      if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
        return noStore({ error: 'Each decision must carry an idempotency_key of 8-200 characters' }, 400);
      }
      if (seen.has(decision.candidate_id)) {
        // Two decisions for one candidate cannot be joined unambiguously.
        return noStore({ error: `Duplicate candidate_id in one review: ${decision.candidate_id}` }, 400);
      }
      seen.add(decision.candidate_id);
    }

    const response = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/bulk-review`,
      {
        method: 'POST',
        body: JSON.stringify({
          items: body.decisions.map((decision) => ({
            id: decision.candidate_id,
            action: requestedAction(decision),
            expected_candidate_revision: decision.expected_candidate_revision,
            reviewed_text: decision.text.trim() || undefined,
            category: decision.category || 'fact',
            scope: 'global',
            tier: 'none',
            idempotency_key: decision.idempotency_key,
          })),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Commit failed: ${response.status}`);
    }
    const payload = await response.json() as {
      results?: Array<{ id?: string; action?: string; status?: string; error?: string }>;
    };

    const result: CommitResponse = {
      committed: [],
      discarded: [],
      errors: [],
      ambiguous: [],
      commands: body.decisions.map((decision) => ({
        candidate_id: decision.candidate_id,
        idempotency_key: decision.idempotency_key as string,
        expected_candidate_revision: decision.expected_candidate_revision as number,
      })),
    };

    // Join by exact identity. A repeated or non-string upstream id means the
    // joined ordering contract is not guaranteed, so nothing is claimed.
    const joined = new Map<string, { action?: string; status?: string; error?: string }>();
    let joinIntegrity = Array.isArray(payload.results);
    for (const item of Array.isArray(payload.results) ? payload.results : []) {
      if (typeof item?.id !== 'string' || joined.has(item.id)) {
        joinIntegrity = false;
        continue;
      }
      joined.set(item.id, item);
    }

    for (const decision of body.decisions) {
      const item = joinIntegrity ? joined.get(decision.candidate_id) : undefined;
      if (item === undefined) {
        // Not a definite failure: the decision may already be committed.
        result.ambiguous.push(decision.candidate_id);
        continue;
      }
      if (item.status === 'ok' && item.action === requestedAction(decision)) {
        if (decision.decision === 'discard') result.discarded.push(decision.candidate_id);
        else result.committed.push(decision.candidate_id);
        continue;
      }
      if (item.status === 'ok') {
        // Acknowledged, but for a different action than this decision asked
        // for. Never present it as this decision's outcome.
        result.ambiguous.push(decision.candidate_id);
        continue;
      }
      result.errors.push({
        candidate_id: decision.candidate_id,
        message: item.error || 'Unknown error',
      });
    }

    return noStore(result);

  } catch (error) {
    logger.logError(error, { component: 'api/memory/commit-candidates', action: 'commit_candidates', request });

    return noStore({
      error: 'Failed to commit memories',
    }, 500);
  }
}

// =============================================================================
// GET - Info endpoint
// =============================================================================

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/memory/commit-candidates',
    method: 'POST',
    description: 'Commit user review decisions to the canonical memory authority',
    body: {
      session_id: 'string (required)',
      thread_id: 'string (optional)',
      decisions: [
        {
          candidate_id: 'string (required)',
          decision: "'approve' | 'discard' (required)",
          text: 'string (required)',
          category: 'string (optional)',
          source: "'recap' (required)",
          metadata: {
            session_type: 'string (optional)',
            preset: 'string (optional)',
          },
          expected_candidate_revision: 'number (required after MEM00 cutover)',
          idempotency_key: 'string (required after MEM00 cutover)',
        },
      ],
    },
    response: {
      committed: 'string[] - IDs of successfully committed memories',
      discarded: 'string[] - IDs of discarded candidates',
      errors: 'Array<{ candidate_id: string, message: string }> - definite failures',
      ambiguous: 'string[] - outcome not exactly joinable; read GET /api/memory/commands/{key}, never re-submit',
      commands: 'Array<{ candidate_id, idempotency_key, expected_candidate_revision }> - content-free recovery references',
      headers: 'Cache-Control: no-store on every success and error response',
    },
  });
}
