import { useCallback, useRef } from 'react';

import { isError, touchSession } from '../lib/api/sessions-api';
import { debugLog } from '../lib/debug-logger';
import { reconcileVoiceTranscript } from '../lib/voice-transcript-reconciliation';
import { useSessionStore } from '../stores/session-store';

type MessagePart = { type: 'text'; text: string };

type VoiceChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
};

interface UseSessionVoiceMessagesParams {
  setChatMessages: (
    updater: (prev: VoiceChatMessage[]) => VoiceChatMessage[]
  ) => void;
  setMessageTimestamp: (id: string, createdAt: string) => void;
}

export function useSessionVoiceMessages({
  setChatMessages,
  setMessageTimestamp,
}: UseSessionVoiceMessagesParams) {
  // Debounce touch calls — voice transcripts arrive incrementally
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncVoiceDescriptor = useCallback((text: string) => {
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    touchTimerRef.current = setTimeout(() => {
      void (async () => {
        const store = useSessionStore.getState();
        const session = store.session;
        if (!session?.sessionId || !session.userId) return;

        const preview = text.trim().replace(/\s+/g, ' ').slice(0, 200);
        if (!preview) return;

        // Optimistic local update
        store.recordOpenSessionActivity(session.sessionId, { messagePreview: preview });

        const result = await touchSession(session.sessionId, session.userId, preview);
        if (isError(result)) {
          debugLog('VoiceMessages', 'touch session failed (voice)', { status: result.status });
          return;
        }

        store.recordOpenSessionActivity(session.sessionId, {
          messagePreview: result.data.last_message_preview ?? preview,
          title: result.data.title,
          turnCount: result.data.turn_count,
          updatedAt: result.data.updated_at,
        });
      })();
    }, 1200); // Wait 1.2s after last transcript chunk
  }, []);

  const appendVoiceUserMessage = useCallback((text: string) => {
    const normalized = text.trim();
    if (!normalized) return;

    setChatMessages((prev) => {
      const last = prev[prev.length - 1];
      const textPart = last?.parts?.find((part) => part.type === 'text');
      const lastText =
        textPart && typeof textPart === 'object' && 'text' in textPart && typeof textPart.text === 'string'
          ? textPart.text.trim()
          : undefined;

      if (last?.role === 'user' && last.id.startsWith('voice-user-') && lastText) {
        const reconciledTranscript = reconcileVoiceTranscript(lastText, normalized);
        if (reconciledTranscript.incremental) {
          if (!reconciledTranscript.changed) {
            return prev;
          }

          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            parts: [{ type: 'text' as const, text: reconciledTranscript.text }],
          };
          return updated;
        }
      }

      if (last?.role === 'user' && lastText === normalized) {
        return prev;
      }

      const id = `voice-user-${Date.now()}`;
      setMessageTimestamp(id, new Date().toISOString());
      return [
        ...prev,
        {
          id,
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: normalized }],
        },
      ];
    });

    // Fire debounced touch so the backend generates a title from the transcript
    syncVoiceDescriptor(normalized);
  }, [setChatMessages, setMessageTimestamp, syncVoiceDescriptor]);

  const appendVoiceAssistantMessage = useCallback((text: string, isSuppressed: boolean) => {
    if (isSuppressed) {
      return;
    }

    const normalized = text.trim();
    if (!normalized) return;

    setChatMessages((prev) => {
      const last = prev[prev.length - 1];
      const textPart = last?.parts?.find((part) => part.type === 'text');
      const lastText =
        textPart && typeof textPart === 'object' && 'text' in textPart && typeof textPart.text === 'string'
          ? textPart.text.trim()
          : undefined;

      if (last?.role === 'assistant' && last.id.startsWith('voice-assistant-')) {
        if (lastText === normalized) {
          return prev;
        }

        const updated = [...prev];
        updated[updated.length - 1] = {
          ...last,
          parts: [{ type: 'text' as const, text: normalized }],
        };
        return updated;
      }

      if (last?.role === 'assistant' && lastText === normalized) {
        return prev;
      }

      const id = `voice-assistant-${Date.now()}`;
      setMessageTimestamp(id, new Date().toISOString());
      return [
        ...prev,
        {
          id,
          role: 'assistant' as const,
          parts: [{ type: 'text' as const, text: normalized }],
        },
      ];
    });
  }, [setChatMessages, setMessageTimestamp]);

  return {
    appendVoiceUserMessage,
    appendVoiceAssistantMessage,
  };
}
