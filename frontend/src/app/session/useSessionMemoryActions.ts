import { useCallback } from 'react';

import { logger } from '../lib/error-logger';
import type { RitualArtifacts } from '../lib/session-types';
import { emitTelemetry } from '../lib/telemetry';

type ShowToastFn = (input: {
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}) => void;

interface UseSessionMemoryActionsParams {
  artifacts?: RitualArtifacts | null;
  applyMemoryCandidates: (nextCandidates: RitualArtifacts['memory_candidates']) => void;
  showToast: ShowToastFn;
  isOffline: boolean;
  queueMemoryApproval: (
    memory: string,
    sessionId: string,
    category?: RitualArtifacts['memory_candidates'][number]['category']
  ) => void;
  sessionId: string;
  backendSessionId?: string;
}

function formatMemorySnippet(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const maxLen = 72;
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

const MEMORY_REJECT_AVAILABLE = false;

export function useSessionMemoryActions({
  artifacts,
  applyMemoryCandidates,
  showToast,
  isOffline,
  queueMemoryApproval,
  sessionId,
  backendSessionId,
}: UseSessionMemoryActionsParams) {
  const updateMemoryCandidates = useCallback((nextCandidates: RitualArtifacts['memory_candidates']) => {
    applyMemoryCandidates(nextCandidates);
  }, [applyMemoryCandidates]);

  const handleMemoryApprove = useCallback(async (index: number) => {
    const candidate = artifacts?.memory_candidates?.[index];
    if (!candidate) return;

    if (isOffline) {
      queueMemoryApproval(candidate.memory, backendSessionId || sessionId, candidate.category);

      const remaining = (artifacts?.memory_candidates || []).filter((_, idx) => idx !== index);
      updateMemoryCandidates(remaining);

      showToast({
        message: `I'll hold this memory and sync it as soon as we're back online: “${formatMemorySnippet(candidate.memory)}”`,
        variant: 'info',
        durationMs: 2200,
      });
      return;
    }

    try {
      const response = await fetch('/api/memory/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_text: candidate.memory,
          category: candidate.category,
          session_id: backendSessionId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Memory save failed: ${response.status}`);
      }

      const remaining = (artifacts?.memory_candidates || []).filter((_, idx) => idx !== index);
      updateMemoryCandidates(remaining);

      showToast({
        message: `I'll remember this: “${formatMemorySnippet(candidate.memory)}”`,
        variant: 'success',
        durationMs: 2000,
      });
    } catch (error) {
      logger.logError(error, {
        component: 'SessionPage',
        action: 'memory_save',
      });
      showToast({
        message: "I couldn't save that memory just yet. Please try again.",
        variant: 'error',
        durationMs: 2600,
      });
    }
  }, [
    artifacts?.memory_candidates,
    isOffline,
    queueMemoryApproval,
    backendSessionId,
    sessionId,
    updateMemoryCandidates,
    showToast,
  ]);

  const handleMemoryReject = useCallback(async (index: number) => {
    const candidate = artifacts?.memory_candidates?.[index];
    if (!candidate) return;

    // TODO: Intentionally contained for the demo path. Backend reject support is
    // not guaranteed in current scope, so the frontend must not imply success.
    if (!MEMORY_REJECT_AVAILABLE) {
      emitTelemetry('memory.reject_blocked', {
        session_id: backendSessionId,
        category: candidate.category,
        reason: 'frontend_contained_demo_scope',
      });
      showToast({
        message: 'This demo only supports saving memories right now.',
        variant: 'warning',
        durationMs: 3200,
      });
      return;
    }

    try {
      const response = await fetch('/api/memory/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          memory_text: candidate.memory,
          category: candidate.category,
          session_id: backendSessionId,
        }),
      });

      if (!response.ok) {
        const status = response.status;
        emitTelemetry('memory.reject_failed', {
          status,
          session_id: backendSessionId,
          category: candidate.category,
          reason: 'non_ok_response',
        });

        const degraded = status === 404 || status === 501 || status === 503;
        const rejectErrorMessage = degraded
          ? "I couldn't confirm that rejection yet. Please try again in a moment."
          : "I couldn't confirm that rejection. Please try again.";
        showToast({
          message: rejectErrorMessage,
          variant: 'error',
          durationMs: 3200,
        });
        return;
      }

      const remaining = (artifacts?.memory_candidates || []).filter((_, idx) => idx !== index);
      updateMemoryCandidates(remaining);

      showToast({
        message: `Got it — I won't keep this one: “${formatMemorySnippet(candidate.memory)}”`,
        variant: 'info',
        durationMs: 2400,
      });
    } catch (error) {
      logger.logError(error, {
        component: 'SessionPage',
        action: 'memory_feedback_reject',
      });
      emitTelemetry('memory.reject_failed', {
        session_id: backendSessionId,
        category: candidate.category,
        reason: 'network_or_exception',
      });
      showToast({
        message: "I couldn't confirm that rejection yet. Please try again.",
        variant: 'error',
        durationMs: 3200,
      });
    }
  }, [artifacts?.memory_candidates, backendSessionId, updateMemoryCandidates, showToast]);

  return {
    handleMemoryApprove,
    handleMemoryReject,
  };
}
