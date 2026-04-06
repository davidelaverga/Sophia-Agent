/**
 * useInterrupt Hook
 * Phase 2 - Sprint 1 Week 2
 * 
 * Manages interrupt state and resume functionality:
 * - Parses interrupt metadata from streamed responses
 * - Handles resume requests when user selects an option
 * - Stores pending interrupts for reload recovery
 * - Manages interrupt card visibility
 * - Stores thread_id in message-metadata-store
 */

import { useState, useCallback, useRef, useEffect } from 'react';

import { logger } from '../lib/error-logger';
import type { 
  InterruptPayload, 
  PendingInterrupt,
  ResolvedInterrupt,
  ResumePayload,
  ContextMode,
  PresetType,
} from '../lib/session-types';
import { emitTiming } from '../lib/telemetry';
import { useMessageMetadataStore } from '../stores/message-metadata-store';
import { useUiStore as useUiToastStore } from '../stores/ui-store';

// ============================================================================
// CONSTANTS
// ============================================================================

const METADATA_MARKER = '__SOPHIA_META__';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const STORAGE_KEY = 'sophia_pending_interrupt';

function hasStorageSessionKey(sessionId: string): boolean {
  return typeof sessionId === 'string' && sessionId.trim().length > 0;
}

function mapOptionIdToResumeAction(optionId: string): ResumePayload['resume']['action'] {
  if (optionId === 'accept' || optionId === 'here') return 'accept';
  if (optionId === 'snooze' || optionId === 'later') return 'snooze';
  if (optionId === 'decline' || optionId === 'busy' || optionId === 'dismiss') return 'dismiss';
  return 'select';
}

function getDismissOptionId(interrupt: InterruptPayload): string {
  const fallbackDismissIds = ['decline', 'busy', 'dismiss'];
  const matched = interrupt.options.find((option) => fallbackDismissIds.includes(option.id));
  return matched?.id || 'decline';
}

// ============================================================================
// NORMALIZATION HELPERS
// ============================================================================

function normalizeInterruptPayload(raw: Record<string, unknown>): InterruptPayload {
  const normalized = { ...raw } as Record<string, unknown>;

  if (normalized.snooze === undefined && normalized.snooze_enabled !== undefined) {
    normalized.snooze = normalized.snooze_enabled;
  }

  if (normalized.expiresAt === undefined && normalized.expires_at !== undefined) {
    normalized.expiresAt = normalized.expires_at;
  }

  if (normalized.dialogKind === undefined && normalized.dialog_kind !== undefined) {
    normalized.dialogKind = normalized.dialog_kind;
  }

  return normalized as InterruptPayload;
}

// ============================================================================
// MOCK EMOTION DETECTION (for demo - remove when backend sends emotion)
// ============================================================================

const EMOTION_KEYWORDS: Record<string, string[]> = {
  frustrated: ['frustrado', 'frustrada', 'frustrated', 'tilteado', 'tilted', 'harto', 'cansado', 'no puedo'],
  angry: ['enojado', 'enojada', 'angry', 'furioso', 'rabia', 'odio', 'mierda'],
  sad: ['triste', 'sad', 'deprimido', 'solo', 'sola', 'lonely', 'mal'],
  anxious: ['ansioso', 'ansiosa', 'anxious', 'nervioso', 'stressed', 'estresado', 'preocupado'],
  happy: ['feliz', 'happy', 'contento', 'alegre', 'bien', 'genial', 'increíble', 'amazing'],
  excited: ['emocionado', 'excited', 'gané', 'won', 'victoria', 'logré'],
  calm: ['tranquilo', 'calm', 'relajado', 'peaceful', 'en paz'],
};

function detectEmotionFromText(text: string): string | null {
  const lowerText = text.toLowerCase();
  
  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
    if (keywords.some(kw => lowerText.includes(kw))) {
      return emotion;
    }
  }
  
  return null;
}

// ============================================================================
// TYPES
// ============================================================================

interface UseInterruptOptions {
  sessionId: string;
  threadId?: string;
  presetContext?: ContextMode;
  sessionType?: PresetType;
  onResumeSuccess?: (response: string) => void;
  onResumeError?: (error: Error) => void;
  /** Called when artifacts are parsed from message metadata */
  onArtifacts?: (artifacts: {
    takeaway?: string;
    reflection_candidate?: { prompt?: string; why?: string };
    memory_candidates?: Array<{ content: string; tags?: string[] }>;
  }) => void;
}

interface UseInterruptReturn {
  // State
  pendingInterrupt: InterruptPayload | null;
  interruptQueue: InterruptPayload[];
  resolvedInterrupts: ResolvedInterrupt[];
  isResuming: boolean;
  threadId: string | null;
  detectedEmotion: string | null;
  
  // Actions
  parseMessageForInterrupt: (content: string, messageId?: string) => string;
  handleInterruptSelect: (optionId: string) => Promise<void>;
  handleInterruptSnooze: () => void;
  handleInterruptDismiss: () => void;
  setInterrupt: (interrupt: InterruptPayload | null) => void;
  clearInterrupt: () => void;
  clearResolvedInterrupts: () => void;
}

// ============================================================================
// STORAGE HELPERS
// ============================================================================

function saveInterruptToStorage(sessionId: string, interrupt: PendingInterrupt | null): void {
  if (typeof window === 'undefined') return;
  if (!hasStorageSessionKey(sessionId)) return;
  
  try {
    if (interrupt) {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      stored[sessionId] = interrupt;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } else {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      delete stored[sessionId];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    }
  } catch (e) {
    logger.logError(e, { component: 'useInterrupt', action: 'storage_write' });
  }
}

interface StorageLoadResult {
  pending: PendingInterrupt | null;
  wasExpired: boolean;
}

function loadInterruptFromStorage(sessionId: string): StorageLoadResult {
  if (typeof window === 'undefined') return { pending: null, wasExpired: false };
  if (!hasStorageSessionKey(sessionId)) return { pending: null, wasExpired: false };
  
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const pending = stored[sessionId];
    
    // Check if expired (interrupts expire after 10 minutes)
    if (pending?.receivedAt) {
      const receivedAt = new Date(pending.receivedAt).getTime();
      const now = Date.now();
      const tenMinutes = 10 * 60 * 1000;
      
      if (now - receivedAt > tenMinutes) {
        // Expired - clean up
        delete stored[sessionId];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        return { pending: null, wasExpired: true };
      }
    }
    
    return { pending: pending || null, wasExpired: false };
  } catch (e) {
    logger.logError(e, { component: 'useInterrupt', action: 'storage_read' });
    return { pending: null, wasExpired: false };
  }
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useInterrupt({
  sessionId,
  threadId: initialThreadId,
  presetContext: _presetContext,
  sessionType: _sessionType,
  onResumeSuccess,
  onResumeError,
  onArtifacts,
}: UseInterruptOptions): UseInterruptReturn {
    // Store onArtifacts callback in ref to avoid stale closures without causing re-renders
    const onArtifactsRef = useRef(onArtifacts);
    useEffect(() => {
      onArtifactsRef.current = onArtifacts;
    }, [onArtifacts]);

  const [pendingInterrupt, setPendingInterrupt] = useState<InterruptPayload | null>(null);
  const [interruptQueue, setInterruptQueue] = useState<InterruptPayload[]>([]);
  const [resolvedInterrupts, setResolvedInterrupts] = useState<ResolvedInterrupt[]>([]);
  const [isResuming, setIsResuming] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId || null);
  const [detectedEmotion, setDetectedEmotion] = useState<string | null>(null);
  
  // Track which messages have been parsed to avoid re-processing
  const parsedMessagesRef = useRef<Set<string>>(new Set());
  
  // Reset per-session state and rehydrate pending interrupt for the active session.
  useEffect(() => {
    setPendingInterrupt(null);
    setInterruptQueue([]);
    setResolvedInterrupts([]);
    setDetectedEmotion(null);
    parsedMessagesRef.current.clear();

    if (!hasStorageSessionKey(sessionId)) {
      setThreadId(initialThreadId || null);
      return;
    }

    setThreadId(initialThreadId || null);
    
    const { pending, wasExpired } = loadInterruptFromStorage(sessionId);
    
    if (wasExpired) {
      // Show toast for expired interrupt
      useUiToastStore.getState().showToast({
        message: 'A previous offer has expired',
        variant: 'info',
        durationMs: 3000,
      });
    } else if (pending?.interrupt) {
      logger.debug('useInterrupt', 'Restored pending interrupt from storage');
      setPendingInterrupt(pending.interrupt);
    }
  }, [sessionId, initialThreadId]);

  // Dev-only: log pending interrupt updates
  useEffect(() => {
    if (IS_PRODUCTION) return;
    logger.debug('useInterrupt', 'pendingInterrupt updated', {
      has_interrupt: !!pendingInterrupt,
      kind: pendingInterrupt?.kind,
      title: pendingInterrupt?.title,
    });
  }, [pendingInterrupt]);
  
  /**
   * Parse message content for embedded interrupt metadata.
   * Returns the clean message text (without metadata).
   * Only processes each message ID once to prevent re-triggering interrupts.
   */
  const parseMessageForInterrupt = useCallback((content: string, messageId?: string): string => {
    const markerIndex = content.indexOf(METADATA_MARKER);
    
    if (markerIndex === -1) {
      // No metadata, return as-is
      return content;
    }
    
    // Extract text before marker
    const cleanText = content.slice(0, markerIndex).trim();
    
    // If we've already parsed this message, just return the clean text
    if (messageId && parsedMessagesRef.current.has(messageId)) {
      return cleanText;
    }
    
    // Extract and parse metadata
    const metaJson = content.slice(markerIndex + METADATA_MARKER.length);
    
    try {
      const rawMetadata = JSON.parse(metaJson);

      const normalizeMetadata = (raw: unknown): Record<string, unknown> | null => {
        if (!raw || typeof raw !== 'object') return null;
        const root = raw as Record<string, unknown>;
        const nested = root.sophia_meta || root.sophia_metadata || root.meta || root.metadata;
        if (nested && typeof nested === 'object') {
          return nested as Record<string, unknown>;
        }
        return root;
      };

      const metadata = normalizeMetadata(rawMetadata) || {};
      const rawRoot = (rawMetadata && typeof rawMetadata === 'object')
        ? (rawMetadata as Record<string, unknown>)
        : {};
      const candidates: Array<Record<string, unknown> | undefined> = [
        metadata,
        rawRoot,
        rawRoot.sophia_meta as Record<string, unknown> | undefined,
        rawRoot.sophia_metadata as Record<string, unknown> | undefined,
        rawRoot.meta as Record<string, unknown> | undefined,
        rawRoot.metadata as Record<string, unknown> | undefined,
      ];

      const findKey = (key: string, altKey?: string): unknown => {
        for (const candidate of candidates) {
          if (!candidate) continue;
          if (candidate[key] !== undefined) return candidate[key];
          if (altKey && candidate[altKey] !== undefined) return candidate[altKey];
        }
        return undefined;
      };

      const rawPendingInterrupt = findKey('pending_interrupt', 'pendingInterrupt');
      const resolvedThreadId = findKey('thread_id', 'threadId') as string | undefined;
      const metadataHasSophiaMeta = markerIndex !== -1;
      const artifactsPayload = (metadata.artifacts || metadata.ritual_artifacts) as Record<string, unknown> | undefined;
      const memoryCandidates = (artifactsPayload?.memory_candidates as unknown[]) || [];
      // Mark as parsed only AFTER successful parse
      if (messageId) {
        parsedMessagesRef.current.add(messageId);
      }
      
      logger.debug('useInterrupt', 'Parsed metadata', { keys: Object.keys(metadata) });
      if (!IS_PRODUCTION) {
        logger.debug('useInterrupt', 'Parsed __SOPHIA_META__', {
          has_sophia_meta: metadataHasSophiaMeta,
          artifacts_keys_count: artifactsPayload ? Object.keys(artifactsPayload).length : 0,
          artifacts_keys: artifactsPayload ? Object.keys(artifactsPayload) : [],
          memory_candidates_count: Array.isArray(memoryCandidates) ? memoryCandidates.length : 0,
          raw_memory_candidates: artifactsPayload?.memory_candidates,
        });
      }

      // Extract and pass artifacts to callback (for real-time artifact updates)
      // Use setTimeout to avoid setState during render
      // Use ref to get latest callback without causing dependency issues
      if (artifactsPayload && onArtifactsRef.current) {
        logger.debug('useInterrupt', 'Received artifacts from chat', { 
          hasTakeaway: !!artifactsPayload.takeaway,
          hasReflection: !!artifactsPayload.reflection_candidate,
        });
        const artifactsCallback = onArtifactsRef.current;
        setTimeout(() => artifactsCallback(artifactsPayload), 0);
      }
      
      const runId = typeof metadata.run_id === 'string' ? metadata.run_id : undefined;
      const skillUsed = typeof metadata.skill_used === 'string' ? metadata.skill_used : undefined;
      const emotionDetected = typeof metadata.emotion_detected === 'string' ? metadata.emotion_detected : undefined;

      // Update thread ID if present
      if (resolvedThreadId) {
        setThreadId(resolvedThreadId);
        
        // Also store in message-metadata-store for persistence
        if (messageId) {
          useMessageMetadataStore.getState().setCurrentContext(
            resolvedThreadId,
            sessionId,
            runId
          );
        }
      }
      
      // Store per-message metadata if we have a message ID
      if (messageId && (resolvedThreadId || skillUsed || emotionDetected)) {
        useMessageMetadataStore.getState().setMessageMetadata(messageId, {
          session_id: sessionId,
          thread_id: resolvedThreadId || '',
          run_id: runId,
          skill_used: skillUsed,
          emotion_detected: emotionDetected,
        });
      }
      
      // Update detected emotion if present (from backend or mock)
      if (emotionDetected) {
        logger.debug('useInterrupt', 'Detected emotion', { emotion: emotionDetected });
        setDetectedEmotion(emotionDetected);
      } else {
        // MOCK: Detect emotion from user's last message for demo purposes
        // TODO: Remove when backend consistently sends emotion_detected
        const mockEmotion = detectEmotionFromText(cleanText);
        if (mockEmotion) {
          logger.debug('useInterrupt', 'Mock detected emotion', { emotion: mockEmotion });
          setDetectedEmotion(mockEmotion);
        }
      }
      
      // Dev-only instrumentation for parsed metadata
      if (!IS_PRODUCTION) {
        logger.debug('useInterrupt', 'Parsed metadata keys', {
          keys: Object.keys(metadata),
          has_pending_interrupt: !!rawPendingInterrupt,
        });
      }

      const pendingInterruptPayload = rawPendingInterrupt && typeof rawPendingInterrupt === 'object'
        ? normalizeInterruptPayload(rawPendingInterrupt as Record<string, unknown>)
        : null;

      // Set interrupt if present (queue if one is already showing)
      if (pendingInterruptPayload) {
        logger.debug('useInterrupt', 'Received interrupt', { kind: pendingInterruptPayload.kind });
        
        // Use functional update to access latest state
        setPendingInterrupt(current => {
          if (current) {
            // Queue it if there's already one showing
            setInterruptQueue(prev => [...prev, pendingInterruptPayload]);
            return current; // Keep the current one
          } else {
            // No current interrupt, show this one
            saveInterruptToStorage(sessionId, {
              interrupt: pendingInterruptPayload,
              receivedAt: new Date().toISOString(),
            });
            return pendingInterruptPayload;
          }
        });
      }
    } catch (e) {
      logger.logError(e, { component: 'useInterrupt', action: 'parse_metadata' });
    }
    
    return cleanText;
  }, [sessionId]);
  
  /**
   * Handle user selecting an option on the interrupt card.
   * Sends resume request to backend and streams the response.
   */
  const handleInterruptSelect = useCallback(async (optionId: string): Promise<void> => {
    if (!pendingInterrupt || isResuming) return;

    const resumeStartedAt = Date.now();
    
    setIsResuming(true);
    
    try {
      logger.debug('useInterrupt', 'Sending resume', {
        threadId,
        kind: pendingInterrupt.kind,
        optionId,
      });
      let fullResponse = '';

      if (!threadId) {
        throw new Error('Resume failed: missing thread_id');
      }

      const response = await fetch('/api/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread_id: threadId,
          session_id: sessionId,
          resume: {
            kind: pendingInterrupt.kind,
            action: mapOptionIdToResumeAction(optionId),
            option_id: optionId,
            extra: {
              language: 'en',
            },
          },
        }),
      });

      if (!response.ok) {
        let responseCode: string | null = null;
        try {
          const responsePayload = await response.json();
          if (responsePayload && typeof responsePayload === 'object') {
            const code = (responsePayload as Record<string, unknown>).code;
            if (typeof code === 'string') {
              responseCode = code;
            }
          }
        } catch {
          responseCode = null;
        }

        if (
          response.status === 410 ||
          responseCode === 'INTERRUPT_EXPIRED' ||
          responseCode === 'INTERRUPT_INVALID'
        ) {
          throw new Error('INTERRUPT_EXPIRED');
        }

        throw new Error(`Resume failed: ${response.status}`);
      }

      // Read streamed response
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullResponse += decoder.decode(value, { stream: true });
        }
      } else {
        fullResponse = await response.text();
      }

      // Defensive: if the backend accidentally returns JSON (as text), extract the user-facing string
      // and drop metadata fields like emotion/session type.
      const trimmed = fullResponse.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const record = parsed as Record<string, unknown>;
            const extracted =
              (typeof record.response === 'string' && record.response.trim().length > 0 ? record.response : null) ||
              (typeof record.assistant_message === 'string' && record.assistant_message.trim().length > 0 ? record.assistant_message : null) ||
              (typeof record.message === 'string' && record.message.trim().length > 0 ? record.message : null);
            if (extracted) {
              fullResponse = extracted;
            }
          }
        } catch {
          // ignore parse failures, keep raw text
        }
      }
      
      // Track as resolved for UI history
      const selectedOption = pendingInterrupt.options.find(o => o.id === optionId);
      if (selectedOption) {
        setResolvedInterrupts(prev => [...prev, {
          kind: pendingInterrupt.kind,
          title: pendingInterrupt.title,
          selectedOption,
          resolvedAt: new Date().toISOString(),
        }]);
      }
      
      // Clear current and shift queue if there are more
      // Use functional update to avoid stale closure
      setInterruptQueue(currentQueue => {
        if (currentQueue.length > 0) {
          const [next, ...rest] = currentQueue;
          setPendingInterrupt(next);
          saveInterruptToStorage(sessionId, {
            interrupt: next,
            receivedAt: new Date().toISOString(),
          });
          return rest;
        } else {
          setPendingInterrupt(null);
          saveInterruptToStorage(sessionId, null);
          return currentQueue;
        }
      });
      
      // Notify success with the response text
      onResumeSuccess?.(fullResponse);
      emitTiming('session.resume.turn_ms', resumeStartedAt, {
        session_id: sessionId,
        interrupt_kind: pendingInterrupt.kind,
        option_id: optionId,
      });
      
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error('Resume failed');

      if (normalizedError.message === 'INTERRUPT_EXPIRED') {
        setInterruptQueue(currentQueue => {
          if (currentQueue.length > 0) {
            const [next, ...rest] = currentQueue;
            setPendingInterrupt(next);
            saveInterruptToStorage(sessionId, {
              interrupt: next,
              receivedAt: new Date().toISOString(),
            });
            return rest;
          }

          setPendingInterrupt(null);
          saveInterruptToStorage(sessionId, null);
          return currentQueue;
        });
      }

      logger.logError(normalizedError, { component: 'useInterrupt', action: 'resume' });
      onResumeError?.(normalizedError);
    } finally {
      setIsResuming(false);
    }
  }, [pendingInterrupt, threadId, sessionId, isResuming, onResumeSuccess, onResumeError]);
  
  /**
   * Handle snooze - hide for now, will resurface later
   */
  const handleInterruptSnooze = useCallback(() => {
    if (!pendingInterrupt || isResuming) return;
    logger.debug('useInterrupt', 'Interrupt snoozed');
    void handleInterruptSelect('snooze');
  }, [pendingInterrupt, isResuming, handleInterruptSelect]);
  
  /**
   * Handle dismiss - permanently remove this interrupt
   */
  const handleInterruptDismiss = useCallback(() => {
    if (!pendingInterrupt || isResuming) return;
    logger.debug('useInterrupt', 'Interrupt dismissed');
    void handleInterruptSelect(getDismissOptionId(pendingInterrupt));
  }, [pendingInterrupt, isResuming, handleInterruptSelect]);
  
  /**
   * Manually set an interrupt (e.g., from backend active-or-last endpoint)
   */
  const setInterrupt = useCallback((interrupt: InterruptPayload | null) => {
    setPendingInterrupt(interrupt);
    if (interrupt) {
      saveInterruptToStorage(sessionId, {
        interrupt,
        receivedAt: new Date().toISOString(),
      });
    } else {
      saveInterruptToStorage(sessionId, null);
    }
  }, [sessionId]);
  
  /**
   * Clear interrupt without side effects
   */
  const clearInterrupt = useCallback(() => {
    setPendingInterrupt(null);
    saveInterruptToStorage(sessionId, null);
  }, [sessionId]);
  
  /**
   * Clear resolved interrupts history
   */
  const clearResolvedInterrupts = useCallback(() => {
    setResolvedInterrupts([]);
  }, []);
  
  return {
    pendingInterrupt,
    interruptQueue,
    resolvedInterrupts,
    isResuming,
    threadId,
    detectedEmotion,
    parseMessageForInterrupt,
    handleInterruptSelect,
    handleInterruptSnooze,
    handleInterruptDismiss,
    setInterrupt,
    clearInterrupt,
    clearResolvedInterrupts,
  };
}

export default useInterrupt;
