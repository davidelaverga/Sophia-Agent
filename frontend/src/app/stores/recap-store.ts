/**
 * Recap Store
 * Phase 3 - Week 3
 * 
 * Manages recap artifacts and memory decisions.
 * Persists to localStorage for refresh resilience.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { logger } from '../lib/error-logger';
import type { 
  RecapArtifactsV1, 
  MemoryDecisionState, 
  MemoryDecision,
  MemoryDecisionStatus,
  CommitMemoriesResponse,
} from '../lib/recap-types';

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
    threadId?: string
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
        }));
      },
      
      getArtifacts: (sessionId) => {
        return get().artifacts[sessionId];
      },
      
      clearArtifacts: (sessionId) => {
        set((state) => {
          const { [sessionId]: _, ...rest } = state.artifacts;
          return { artifacts: rest };
        });
      },
      
      setDecision: (sessionId, candidateId, decision, editedText) => {
        set((state) => {
          const currentDecisions = state.decisions[sessionId] || [];
          const existingIndex = currentDecisions.findIndex(d => d.candidateId === candidateId);
          
          const newDecision: MemoryDecisionState = {
            candidateId,
            decision,
            status: decision === 'idle' ? 'idle' : 
                    decision === 'discarded' ? 'discarded' :
                    decision === 'edited' ? 'edited' : 'approved',
            editedText,
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
          const { [sessionId]: _, ...rest } = state.decisions;
          return { decisions: rest };
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
      
      commitMemories: async (sessionId, _threadId) => {
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
        
        try {
          const saveRequests = approvedCandidates.map((decision) => {
            const candidate = artifacts?.memoryCandidates?.find(c => c.id === decision.candidateId);
            return {
              candidateId: decision.candidateId,
              payload: {
                memory_text: decision.editedText || candidate?.text || '',
                category: candidate?.category,
                session_id: sessionId,
                original_memory_id: candidate?.id || decision.candidateId,
              },
            };
          });

          const results = await Promise.allSettled(
            saveRequests.map(async (request) => {
              if (!request.payload.memory_text) {
                throw new Error('Missing memory text');
              }
              const response = await fetch('/api/memory/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request.payload),
              });

              if (!response.ok) {
                throw new Error(`Failed to save: ${response.status}`);
              }

              return request.candidateId;
            })
          );

          const result: CommitMemoriesResponse = {
            committed: [],
            discarded: discardedCandidates.map(d => d.candidateId),
            errors: [],
          };

          results.forEach((saveResult, index) => {
            const candidateId = saveRequests[index].candidateId;
            if (saveResult.status === 'fulfilled') {
              result.committed.push(candidateId);
            } else {
              result.errors.push({
                candidate_id: candidateId,
                message: saveResult.reason instanceof Error ? saveResult.reason.message : 'Unknown error',
              });
            }
          });
          
          // Update statuses based on response
          for (const id of result.committed) {
            get().updateDecisionStatus(sessionId, id, 'committed');
          }
          
          for (const error of result.errors) {
            get().updateDecisionStatus(sessionId, error.candidate_id, 'error', error.message);
          }
          
          // Update commit status
          const hasErrors = result.errors.length > 0;
          set((state) => ({
            commitStatus: { 
              ...state.commitStatus, 
              [sessionId]: hasErrors ? 'error' : 'committed',
            },
          }));
          
          return result;
          
        } catch (error) {
          logger.logError(error, { component: 'RecapStore', action: 'commit_memories' });
          
          // Mark all as error
          for (const decision of approvedCandidates) {
            get().updateDecisionStatus(
              sessionId, 
              decision.candidateId, 
              'error',
              error instanceof Error ? error.message : 'Unknown error'
            );
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
      // Only persist what we need
      partialize: (state) => ({
        artifacts: state.artifacts,
        decisions: state.decisions,
        commitStatus: state.commitStatus,
      }),
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
