/**
 * Memory Commit Candidates API Route
 * Phase 3 - Week 3
 * 
 * POST /api/memory/commit-candidates
 * 
 * Commits recap-reviewed memory candidates through the Sophia gateway.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { fetchSophiaApi, isSyntheticMemoryId, resolveSophiaUserId } from '../../_lib/sophia';
import { logger } from '../../../lib/error-logger';

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
    
    const outcome = await Promise.allSettled(body.decisions.map(async (decision) => {
      if (decision.decision === 'discard') {
        if (!isSyntheticMemoryId(decision.candidate_id)) {
          const response = await fetchSophiaApi(
            `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(decision.candidate_id)}`,
            { method: 'DELETE' }
          );

          if (!response.ok && response.status !== 204) {
            throw new Error(`Discard failed: ${response.status}`);
          }
        }

        return { kind: 'discarded' as const, candidateId: decision.candidate_id };
      }

      if (!decision.text.trim()) {
        throw new Error('Missing memory text');
      }

      const metadata = {
        status: 'approved',
        source: decision.source,
        session_id: body.session_id,
        ...(decision.metadata || {}),
      };

      const response = !isSyntheticMemoryId(decision.candidate_id)
        ? await fetchSophiaApi(
            `/api/sophia/${encodeURIComponent(userId)}/memories/${encodeURIComponent(decision.candidate_id)}`,
            {
              method: 'PUT',
              body: JSON.stringify({
                text: decision.text,
                metadata,
              }),
            }
          )
        : await fetchSophiaApi(
            `/api/sophia/${encodeURIComponent(userId)}/memories`,
            {
              method: 'POST',
              body: JSON.stringify({
                text: decision.text,
                ...(decision.category ? { category: decision.category } : {}),
                metadata: {
                  ...metadata,
                  original_memory_id: decision.candidate_id,
                },
              }),
            }
          );

      if (!response.ok) {
        throw new Error(`Commit failed: ${response.status}`);
      }

      return { kind: 'committed' as const, candidateId: decision.candidate_id };
    }));

    const result: CommitResponse = {
      committed: [],
      discarded: [],
      errors: [],
    };

    outcome.forEach((item, index) => {
      const candidateId = body.decisions[index].candidate_id;
      if (item.status === 'fulfilled') {
        if (item.value.kind === 'committed') {
          result.committed.push(item.value.candidateId);
        } else {
          result.discarded.push(item.value.candidateId);
        }
        return;
      }

      result.errors.push({
        candidate_id: candidateId,
        message: item.reason instanceof Error ? item.reason.message : 'Unknown error',
      });
    });

    return NextResponse.json(result);
    
  } catch (error) {
    logger.logError(error, { component: 'api/memory/commit-candidates', action: 'commit_candidates' });
    
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
    description: 'Commit user-approved memory candidates to Mem0',
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
