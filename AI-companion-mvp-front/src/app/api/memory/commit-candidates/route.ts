/**
 * Memory Commit Candidates API Route
 * Phase 3 - Week 3
 * 
 * POST /api/memory/commit-candidates
 * 
 * Commits user-approved memory candidates to Mem0 via backend.
 * Handles batch operations and partial failures.
 */

import { NextRequest, NextResponse } from 'next/server';
import { debugLog, debugWarn } from '../../../lib/debug-logger';
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
}

interface CommitResponse {
  committed: string[];
  discarded: string[];
  errors: Array<{
    candidate_id: string;
    message: string;
  }>;
}

// =============================================================================
// MOCK RESPONSES (for development)
// =============================================================================

function getMockResponse(request: CommitRequest): CommitResponse {
  const committed: string[] = [];
  const discarded: string[] = [];
  const errors: Array<{ candidate_id: string; message: string }> = [];
  
  for (const decision of request.decisions) {
    // Simulate occasional errors (10% chance)
    if (Math.random() < 0.1) {
      errors.push({
        candidate_id: decision.candidate_id,
        message: 'Simulated error for testing',
      });
      continue;
    }
    
    if (decision.decision === 'approve') {
      committed.push(decision.candidate_id);
    } else {
      discarded.push(decision.candidate_id);
    }
  }
  
  return { committed, discarded, errors };
}

// =============================================================================
// ROUTE HANDLER
// =============================================================================

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
    
    // Try to call backend
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    
    if (apiUrl) {
      try {
        const backendResponse = await fetch(
          `${apiUrl}/api/v1/memory/commit-candidates`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000), // 10s timeout
          }
        );
        
        if (backendResponse.ok) {
          const data = await backendResponse.json();
          return NextResponse.json(data);
        }
        
        // If backend returns error, fall through to mock
        debugWarn('API memory commit-candidates', 'Backend commit-candidates failed', {
          status: backendResponse.status,
          body: await backendResponse.text().catch(() => 'No body'),
        });
        
      } catch (error) {
        debugWarn('API memory commit-candidates', 'Backend commit-candidates error', { error });
        // Fall through to mock
      }
    }
    
    // 🔒 SECURITY: Mock responses are dev-only — return error in production
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Memory commit service unavailable' },
        { status: 503 }
      );
    }

    debugLog('API memory commit-candidates', 'Using mock commit-candidates response');
    await new Promise(resolve => setTimeout(resolve, 500));
    const mockResponse = getMockResponse(body);
    return NextResponse.json(mockResponse);
    
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
