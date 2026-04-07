/**
 * Message Metadata Store
 * Sprint 1+ - Persist metadata without prompt bloat
 * 
 * Stores UI-only metadata (thread_id, run_id, etc.) separately from messages.
 * This metadata NEVER goes to the model - it's for UI and tracing only.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { asRecord, readString } from '../lib/record-parsers';
import type { SophiaMessageMetadata, EmotionalWeather } from '../types/sophia-ui-message';

// =============================================================================
// STORE INTERFACE
// =============================================================================

interface MessageMetadataState {
  // Metadata indexed by message_id (Partial since SSE only sends some fields)
  metadataByMessage: Record<string, Partial<SophiaMessageMetadata>>;
  
  // Current session context (cached from latest message)
  currentThreadId: string | null;
  currentSessionId: string | null;
  currentRunId: string | null;
  
  // Emotional weather (from bootstrap or latest turn)
  emotionalWeather: EmotionalWeather | null;
  
  // Actions
  setMessageMetadata: (messageId: string, metadata: Partial<SophiaMessageMetadata>) => void;
  getMessageMetadata: (messageId: string) => Partial<SophiaMessageMetadata> | undefined;
  
  // Context actions
  setCurrentContext: (threadId: string, sessionId: string, runId?: string) => void;
  getCurrentThreadId: () => string | null;
  
  // Emotional weather
  setEmotionalWeather: (weather: EmotionalWeather) => void;
  
  // Cleanup
  clearSession: (sessionId: string) => void;
  clearAll: () => void;
}

// =============================================================================
// STORE IMPLEMENTATION
// =============================================================================

export const useMessageMetadataStore = create<MessageMetadataState>()(
  persist(
    (set, get) => ({
      metadataByMessage: {},
      currentThreadId: null,
      currentSessionId: null,
      currentRunId: null,
      emotionalWeather: null,
      
      setMessageMetadata: (messageId, metadata) => {
        set((state) => ({
          metadataByMessage: {
            ...state.metadataByMessage,
            [messageId]: metadata,
          },
          // Update current context from latest metadata
          currentThreadId: metadata.thread_id || state.currentThreadId,
          currentSessionId: metadata.session_id || state.currentSessionId,
          currentRunId: metadata.run_id || state.currentRunId,
        }));
      },
      
      getMessageMetadata: (messageId) => {
        return get().metadataByMessage[messageId];
      },
      
      setCurrentContext: (threadId, sessionId, runId) => {
        set({
          currentThreadId: threadId,
          currentSessionId: sessionId,
          currentRunId: runId || null,
        });
      },
      
      getCurrentThreadId: () => {
        return get().currentThreadId;
      },
      
      setEmotionalWeather: (weather) => {
        set({ emotionalWeather: weather });
      },
      
      clearSession: (sessionId) => {
        set((state) => {
          // Remove all metadata for this session
          const filtered = Object.entries(state.metadataByMessage)
            .filter(([_, meta]) => meta.session_id !== sessionId)
            .reduce((acc, [id, meta]) => ({ ...acc, [id]: meta }), {});
          
          // Clear current context if it matches
          const clearContext = state.currentSessionId === sessionId;
          
          return {
            metadataByMessage: filtered,
            currentThreadId: clearContext ? null : state.currentThreadId,
            currentSessionId: clearContext ? null : state.currentSessionId,
            currentRunId: clearContext ? null : state.currentRunId,
          };
        });
      },
      
      clearAll: () => {
        set({
          metadataByMessage: {},
          currentThreadId: null,
          currentSessionId: null,
          currentRunId: null,
          emotionalWeather: null,
        });
      },
    }),
    {
      name: 'sophia.message-metadata.v1',
      partialize: (state) => ({
        metadataByMessage: state.metadataByMessage,
        currentThreadId: state.currentThreadId,
        currentSessionId: state.currentSessionId,
        emotionalWeather: state.emotionalWeather,
        // Don't persist currentRunId (ephemeral)
      }),
    }
  )
);

// =============================================================================
// SELECTORS
// =============================================================================

export const selectCurrentThreadId = (state: MessageMetadataState) => 
  state.currentThreadId;

export const selectCurrentSessionId = (state: MessageMetadataState) => 
  state.currentSessionId;

export const selectEmotionalWeather = (state: MessageMetadataState) => 
  state.emotionalWeather;

export const selectMetadataForMessage = (messageId: string) => 
  (state: MessageMetadataState) => state.metadataByMessage[messageId];

// =============================================================================
// HELPER: Extract metadata from backend response
// =============================================================================

function readEnumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = readString(record, key);
  if (!value) return undefined;
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function readMemorySources(record: Record<string, unknown>): SophiaMessageMetadata['memory_sources_used'] | undefined {
  const raw = record.memory_sources_used;
  if (!Array.isArray(raw)) return undefined;

  const allowed = new Set(['flash', 'mem0', 'openmemory']);
  const normalized = raw.filter(
    (source): source is 'flash' | 'mem0' | 'openmemory' => typeof source === 'string' && allowed.has(source)
  );

  return normalized.length > 0 ? normalized : undefined;
}

export function extractMetadataFromResponse(
  response: Record<string, unknown>
): Partial<SophiaMessageMetadata> | null {
  // Check common locations for metadata in backend responses
  const metadata = response.metadata || response.meta || response._metadata;

  const meta = asRecord(metadata);
  if (!meta) {
    return null;
  }

  return {
    thread_id: readString(meta, 'thread_id'),
    run_id: readString(meta, 'run_id'),
    session_id: readString(meta, 'session_id'),
    session_type: readEnumValue(meta, 'session_type', ['prepare', 'debrief', 'reset', 'vent', 'open']),
    preset_context: readEnumValue(meta, 'preset_context', ['gaming', 'work', 'life']),
    invoke_type: readEnumValue(meta, 'invoke_type', ['text', 'voice']),
    artifacts_status: readEnumValue(meta, 'artifacts_status', ['none', 'pending', 'complete', 'error']),
    memory_sources_used: readMemorySources(meta),
    computed_at: readString(meta, 'computed_at'),
  };
}
