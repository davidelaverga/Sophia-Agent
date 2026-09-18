/**
 * Recap Store
 * Phase 3 - Week 3
 * 
 * Manages recap artifacts and memory decisions.
 * Memory-bearing state is transient and must be revalidated after refresh.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { logger } from '../lib/error-logger';
import { commandStatusSchema } from '../lib/memory-command-receipt';
import type { 
  RecapArtifactsV1, 
  MemoryDecisionState, 
  MemoryDecision,
  MemoryDecisionStatus,
  CommitMemoriesResponse,
} from '../lib/recap-types';

// =============================================================================
// LOST-RESPONSE RECOVERY
// =============================================================================

type ReceiptRecovery = { committed: string[]; notFound: string[]; unknown: string[] };

/**
 * Recover the ORIGINAL committed outcome for decisions whose response was lost
 * or could not be joined exactly.
 *
 * Reuses the existing content-free command-receipt route bound to the original
 * idempotency key, so a successful response that never reached the browser is
 * recovered instead of re-submitted. A receipt is history only: it never
 * authorizes a new provider projection, a fresh approval, or a claim that the
 * text is currently saved. `notFound` is a definite "not committed" (safe to
 * retry); `unknown` stays unresolved rather than being reported as a failure.
 */
async function recoverDecisionReceipts(
  pending: Array<{ candidateId: string; idempotencyKey?: string }>,
): Promise<ReceiptRecovery> {
  const recovery: ReceiptRecovery = { committed: [], notFound: [], unknown: [] };
  for (const item of pending) {
    if (!item.idempotencyKey) {
      recovery.unknown.push(item.candidateId);
      continue;
    }
    try {
      const response = await fetch(
        `/api/memory/commands/${encodeURIComponent(item.idempotencyKey)}`,
        { method: 'GET', cache: 'no-store' },
      );
      if (!response.ok) {
        recovery.unknown.push(item.candidateId);
        continue;
      }
      const status = commandStatusSchema.safeParse(await response.json());
      if (!status.success) {
        recovery.unknown.push(item.candidateId);
      } else if (status.data.status === 'committed') {
        recovery.committed.push(item.candidateId);
      } else {
        recovery.notFound.push(item.candidateId);
      }
    } catch {
      recovery.unknown.push(item.candidateId);
    }
  }
  return recovery;
}

// =============================================================================
// TYPES
// =============================================================================

interface RecapState {
  /** Artifacts keyed by sessionId */
  artifacts: Record<string, RecapArtifactsV1>;
  
  /** Memory decisions keyed by sessionId */
  decisions: Record<string, MemoryDecisionState[]>;
  
  /** Commit status for each session */
  commitStatus: Record<string, 'idle' | 'committing' | 'committed' | 'error'>;
  
  /** Actions */
  setArtifacts: (sessionId: string, artifacts: RecapArtifactsV1) => void;
  getArtifacts: (sessionId: string) => RecapArtifactsV1 | undefined;
  clearArtifacts: (sessionId: string) => void;
  invalidateSession: (sessionId: string) => void;
  
  /** Memory decision actions */
  setDecision: (
    sessionId: string, 
    candidateId: string, 
    decision: MemoryDecision, 
    editedText?: string
  ) => void;
  getDecisions: (sessionId: string) => MemoryDecisionState[];
  clearDecisions: (sessionId: string) => void;
  
  /** Get decision for a specific candidate */
  getDecisionForCandidate: (sessionId: string, candidateId: string) => MemoryDecisionState | undefined;
  
  /** Check if all candidates have been reviewed */
  allCandidatesReviewed: (sessionId: string) => boolean;
  
  /** Get approved/edited candidates ready for commit */
  getApprovedCandidates: (sessionId: string) => MemoryDecisionState[];
  
  /** Update decision status (for commit flow) */
  updateDecisionStatus: (
    sessionId: string,
    candidateId: string,
    status: MemoryDecisionStatus,
    errorMessage?: string
  ) => void;
  
  /** Commit memories to backend */
  commitMemories: (
    sessionId: string,
    threadId?: string,
    isCurrent?: () => boolean
  ) => Promise<CommitMemoriesResponse>;
  
  /** Get commit status for session */
  getCommitStatus: (sessionId: string) => 'idle' | 'committing' | 'committed' | 'error';
}

// =============================================================================
// STORE
// =============================================================================

export const useRecapStore = create<RecapState>()(
  persist(
    (set, get) => ({
      artifacts: {},
      decisions: {},
      commitStatus: {},
      
      setArtifacts: (sessionId, artifacts) => {
        set((state) => ({
          artifacts: {
            ...state.artifacts,
            [sessionId]: artifacts,
          },
          decisions: {
            ...state.decisions,
            [sessionId]: (state.decisions[sessionId] || []).filter((decision) =>
              artifacts.memoryCandidates?.some((candidate) => candidate.id === decision.candidateId
                && Number.isInteger(candidate.candidateRevision) && (candidate.candidateRevision ?? 0) > 0
                && candidate.candidateRevision === decision.expectedCandidateRevision)
            ),
          },
          // A prior batch receipt does not establish completion of this fresh
          // candidate set. Version-matched individual decisions remain below.
          commitStatus: { ...state.commitStatus, [sessionId]: 'idle' },
        }));
      },
      
      getArtifacts: (sessionId) => {
        return get().artifacts[sessionId];
      },
      
      clearArtifacts: (sessionId) => {
        set((state) => {
          const nextArtifacts = { ...state.artifacts };
          delete nextArtifacts[sessionId];
          return { artifacts: nextArtifacts };
        });
      },

      invalidateSession: (sessionId) => {
        set((state) => {
          const artifacts = { ...state.artifacts };
          const decisions = { ...state.decisions };
          const commitStatus = { ...state.commitStatus };
          delete artifacts[sessionId];
          delete decisions[sessionId];
          delete commitStatus[sessionId];
          return { artifacts, decisions, commitStatus };
        });
      },
      
      setDecision: (sessionId, candidateId, decision, editedText) => {
        set((state) => {
          const currentDecisions = state.decisions[sessionId] || [];
          const existingIndex = currentDecisions.findIndex(d => d.candidateId === candidateId);
          
          const candidate = state.artifacts[sessionId]?.memoryCandidates?.find(item => item.id === candidateId);
          const sameRequest = existingIndex >= 0
            && currentDecisions[existingIndex].decision === decision
            && currentDecisions[existingIndex].editedText === editedText;
          const idempotencyKey = sameRequest
            ? currentDecisions[existingIndex].idempotencyKey
            : `recap:${sessionId}:${candidateId}:${candidate?.candidateRevision ?? 0}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          const newDecision: MemoryDecisionState = {
            candidateId,
            decision,
            status: decision === 'idle' ? 'idle' : 
                    decision === 'discarded' ? 'discarded' :
                    decision === 'edited' ? 'edited' : 'approved',
            editedText,
            expectedCandidateRevision: candidate?.candidateRevision,
            category: candidate?.category,
            idempotencyKey,
            timestamp: new Date().toISOString(),
          };
          
          let updatedDecisions: MemoryDecisionState[];
          if (existingIndex >= 0) {
            updatedDecisions = [...currentDecisions];
            updatedDecisions[existingIndex] = newDecision;
          } else {
            updatedDecisions = [...currentDecisions, newDecision];
          }
          
          return {
            decisions: {
              ...state.decisions,
              [sessionId]: updatedDecisions,
            },
          };
        });
      },
      
      getDecisions: (sessionId) => {
        return get().decisions[sessionId] || [];
      },
      
      clearDecisions: (sessionId) => {
        set((state) => {
          const nextDecisions = { ...state.decisions };
          delete nextDecisions[sessionId];
          return { decisions: nextDecisions };
        });
      },
      
      getDecisionForCandidate: (sessionId, candidateId) => {
        const decisions = get().decisions[sessionId] || [];
        return decisions.find(d => d.candidateId === candidateId);
      },
      
      allCandidatesReviewed: (sessionId) => {
        const artifacts = get().artifacts[sessionId];
        const decisions = get().decisions[sessionId] || [];
        
        if (!artifacts?.memoryCandidates?.length) return true;
        
        return artifacts.memoryCandidates.every(
          candidate => decisions.some(
            d => d.candidateId === candidate.id && d.decision !== 'idle'
          )
        );
      },
      
      getApprovedCandidates: (sessionId) => {
        const decisions = get().decisions[sessionId] || [];
        return decisions.filter(d => d.decision === 'approved' || d.decision === 'edited');
      },
      
      updateDecisionStatus: (sessionId, candidateId, status, errorMessage) => {
        set((state) => {
          const currentDecisions = state.decisions[sessionId] || [];
          const existingIndex = currentDecisions.findIndex(d => d.candidateId === candidateId);
          
          if (existingIndex < 0) return state;
          
          const updatedDecisions = [...currentDecisions];
          updatedDecisions[existingIndex] = {
            ...updatedDecisions[existingIndex],
            status,
            errorMessage,
            timestamp: new Date().toISOString(),
          };
          
          return {
            decisions: {
              ...state.decisions,
              [sessionId]: updatedDecisions,
            },
          };
        });
      },
      
      commitMemories: async (sessionId, threadId, isCurrent = () => true) => {
        const assertCurrent = () => { if (!isCurrent()) throw new Error('recap_action_context_changed'); };
        assertCurrent();
        const artifacts = get().artifacts[sessionId];
        const decisions = get().decisions[sessionId] || [];
        const approvedCandidates = decisions.filter(
          d => d.decision === 'approved' || d.decision === 'edited'
        );
        const discardedCandidates = decisions.filter(d => d.decision === 'discarded');
        
        if (approvedCandidates.length === 0) {
          return { committed: [], discarded: discardedCandidates.map(d => d.candidateId), errors: [] };
        }
        
        // Update commit status
        set((state) => ({
          commitStatus: { ...state.commitStatus, [sessionId]: 'committing' },
        }));
        
        // Mark all approved as committing
        for (const decision of approvedCandidates) {
          get().updateDecisionStatus(sessionId, decision.candidateId, 'committing');
        }

        // Exact command key per candidate, preserved across a lost response so
        // recovery reads the original receipt rather than re-deciding.
        const commandKeyOf = new Map(
          approvedCandidates.map((decision) => [decision.candidateId, decision.idempotencyKey]),
        );
        
        try {
          const response = await fetch('/api/memory/commit-candidates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: sessionId,
              ...(threadId ? { thread_id: threadId } : {}),
              decisions: approvedCandidates.map((decision) => {
                const candidate = artifacts?.memoryCandidates?.find(c => c.id === decision.candidateId);
                return {
                  candidate_id: decision.candidateId,
                  decision: 'approve',
                  text: (decision.editedText || candidate?.text || '').trim(),
                  category: decision.category || candidate?.category,
                  expected_candidate_revision: decision.expectedCandidateRevision ?? candidate?.candidateRevision,
                  idempotency_key: decision.idempotencyKey,
                  source: 'recap',
                  metadata: {
                    session_type: artifacts?.sessionType,
                    preset: artifacts?.contextMode,
                  },
                };
              }),
            }),
          });

          if (!response.ok) {
            throw new Error(`Failed to commit memories: ${response.status}`);
          }

          const result = await response.json() as CommitMemoriesResponse;
          assertCurrent();
          result.discarded = [
            ...new Set([...result.discarded, ...discardedCandidates.map(d => d.candidateId)]),
          ];

          // WP1: an unjoined outcome is unknown, not failed. Recover the
          // original committed decision from its own command receipt instead of
          // re-submitting, so there is no second mutation and no resurrection.
          const ambiguous = result.ambiguous ?? [];
          if (ambiguous.length > 0) {
            const recovered = await recoverDecisionReceipts(ambiguous.map((candidateId) => ({
              candidateId,
              idempotencyKey: commandKeyOf.get(candidateId),
            })));
            assertCurrent();
            result.committed = [...new Set([...result.committed, ...recovered.committed])];
            result.errors = [
              ...result.errors,
              ...recovered.notFound.map((candidate_id) => ({
                candidate_id,
                message: 'review_command_not_committed',
              })),
            ];
            // Still-unresolved outcomes stay ambiguous, never silent success.
            result.ambiguous = recovered.unknown;
          }

          // Update statuses based on response
          for (const id of result.committed) {
            get().updateDecisionStatus(sessionId, id, 'committed');
          }
          
          for (const error of result.errors) {
            get().updateDecisionStatus(sessionId, error.candidate_id, 'error', error.message);
          }
          
          // Update commit status
          const hasErrors = result.errors.length > 0 || (result.ambiguous?.length ?? 0) > 0;
          set((state) => ({
            commitStatus: { 
              ...state.commitStatus, 
              [sessionId]: hasErrors ? 'error' : 'committed',
            },
          }));
          
          return result;
          
        } catch (error) {
          assertCurrent();
          logger.logError(error, { component: 'RecapStore', action: 'commit_memories' });
          
          // The response was lost: these decisions may already be committed.
          // Recover from their own receipts rather than reporting a false
          // failure that would invite a duplicate submission.
          let recovered: ReceiptRecovery | null = null;
          try {
            recovered = await recoverDecisionReceipts(approvedCandidates.map((decision) => ({
              candidateId: decision.candidateId,
              idempotencyKey: commandKeyOf.get(decision.candidateId),
            })));
          } catch {
            recovered = null;
          }


          // A recovered receipt is historical: it confirms the original
          // decision landed, never that the text is currently saved.
          for (const decision of approvedCandidates) {
            const candidateId = decision.candidateId;
            if (recovered?.committed.includes(candidateId)) {
              get().updateDecisionStatus(sessionId, candidateId, 'committed');
            } else if (recovered?.notFound.includes(candidateId)) {
              get().updateDecisionStatus(sessionId, candidateId, 'error', 'review_command_not_committed');
            } else {
              get().updateDecisionStatus(
                sessionId,
                candidateId,
                'error',
                recovered ? 'review_outcome_unavailable'
                  : error instanceof Error ? error.message : 'Unknown error'
              );
            }
          }
          
          set((state) => ({
            commitStatus: { ...state.commitStatus, [sessionId]: 'error' },
          }));
          
          throw error;
        }
      },
      
      getCommitStatus: (sessionId) => {
        return get().commitStatus[sessionId] || 'idle';
      },
    }),
    {
      name: 'sophia-recap',
      storage: createJSONStorage(() => localStorage),
      // Retain only the existing key's migration plumbing. Never serialize
      // memory text, edited decisions or historical success as fresh authority.
      version: 1,
      partialize: () => ({}),
      migrate: () => ({}),
      merge: (_persisted, current) => current,
    }
  )
);

// =============================================================================
// SELECTORS
// =============================================================================

export const selectArtifacts = (sessionId: string) => (state: RecapState) => 
  state.artifacts[sessionId];

export const selectDecisions = (sessionId: string) => (state: RecapState) => 
  state.decisions[sessionId] || [];

export const selectCommitStatus = (sessionId: string) => (state: RecapState) =>
  state.commitStatus[sessionId] || 'idle';
