import { useCallback } from 'react';

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
  }, [setChatMessages, setMessageTimestamp]);

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
