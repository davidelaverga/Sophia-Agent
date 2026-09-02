/**
 * Memory Commit Candidates API Route
 * Phase 3 - Week 3
 * 
 * POST /api/memory/commit-candidates
 * 
 * Commits recap-reviewed memory candidates through the Sophia gateway.
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
}

export async function POST(request: NextRequest) {
  const voiceLabDenied = await voiceLabOrdinaryProductBoundaryResponse();
  if (voiceLabDenied) return voiceLabDenied;

  try {
    const body = await request.json() as CommitRequest;
    
    // Validate request
    if (!body.session_id) {
      return NextResponse.json(
        { error: 'session_id is required' },
        { status: 400 }
      );
    }

    const userId = await resolveSophiaUserId();
    if (!userId) {
      return NextResponse.json(
        { error: 'Unable to resolve user_id' },
        { status: 401 }
      );
    }
    
    if (!body.decisions || !Array.isArray(body.decisions) || body.decisions.length === 0) {
      return NextResponse.json(
        { error: 'decisions array is required and must not be empty' },
        { status: 400 }
      );
    }
    
    // Validate each decision
    for (const decision of body.decisions) {
      if (!decision.candidate_id) {
        return NextResponse.json(
          { error: 'Each decision must have a candidate_id' },
          { status: 400 }
        );
      }
      if (!['approve', 'discard'].includes(decision.decision)) {
        return NextResponse.json(
          { error: `Invalid decision value: ${decision.decision}` },
          { status: 400 }
        );
      }
    }
    
    const response = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/memories/bulk-review`,
      {
        method: 'POST',
        body: JSON.stringify({
          items: body.decisions.map((decision) => ({
            id: decision.candidate_id,
            action: decision.decision === 'discard' ? 'discard' : 'approve',
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
    };

    for (const [index, decision] of body.decisions.entries()) {
      const item = payload.results?.[index];
      if (item?.id === decision.candidate_id && item.status === 'ok') {
        if (decision.decision === 'discard') result.discarded.push(decision.candidate_id);
        else result.committed.push(decision.candidate_id);
      } else {
        result.errors.push({
          candidate_id: decision.candidate_id,
          message: item?.error || 'Unknown error',
        });
      }
    }

    return NextResponse.json(result);
    
  } catch (error) {
    logger.logError(error, { component: 'api/memory/commit-candidates', action: 'commit_candidates', request });
    
    return NextResponse.json(
      { 
        error: 'Failed to commit memories',
      },
      { status: 500 }
    );
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
      errors: 'Array<{ candidate_id: string, message: string }>',
    },
  });
}
