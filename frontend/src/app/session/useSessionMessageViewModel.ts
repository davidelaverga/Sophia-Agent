import { useCallback, useEffect, useMemo, useRef } from 'react';
import { extractTextFromUiMessageStreamDump } from '../lib/ui-message-stream-parser';
import { debugLog } from '../lib/debug-logger';
import type { UIMessage } from '../components/session';

type ChatMessagePart = {
  type?: string;
  text?: string;
};

type ChatMessageLike = {
  id: string;
  role: string;
  parts: ChatMessagePart[];
};

interface UseSessionMessageViewModelParams {
  chatMessages: ChatMessageLike[];
  greetingAnchorId: string | null;
  markOffline: () => void;
  debugEnabled?: boolean;
  memoryHighlightsCount?: number;
}

export function useSessionMessageViewModel({
  chatMessages,
  greetingAnchorId,
  markOffline,
  debugEnabled = false,
  memoryHighlightsCount = 0,
}: UseSessionMessageViewModelParams) {
  const messageTimestampsRef = useRef<Map<string, string>>(new Map());
  const detectedOfflineModeRef = useRef(false);
  const memoryHighlightsGateLogRef = useRef<string | null>(null);

  const setMessageTimestamp = useCallback((id: string, createdAt: string) => {
    messageTimestampsRef.current.set(id, createdAt);
  }, []);

  const getMessageText = useCallback((msg: ChatMessageLike) => {
    const rawText = msg.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');

    const finalText = extractTextFromUiMessageStreamDump(rawText);

    if (finalText.includes("(Note: I'm in offline mode right now)")) {
      detectedOfflineModeRef.current = true;
    }

    return finalText;
  }, []);

  useEffect(() => {
    if (detectedOfflineModeRef.current) {
      markOffline();
      detectedOfflineModeRef.current = false;
    }
  });

  const messages: UIMessage[] = useMemo(() => {
    const mapped = chatMessages.map((msg) => {
      if (!messageTimestampsRef.current.has(msg.id)) {
        messageTimestampsRef.current.set(msg.id, new Date().toISOString());
      }

      const isVoiceUserMessage = msg.id.startsWith('voice-user-');
      const isVoiceAssistantMessage = msg.id.startsWith('voice-assistant-');

      return {
        id: msg.id,
        role: msg.role as 'user' | 'assistant',
        content: getMessageText(msg),
        createdAt: messageTimestampsRef.current.get(msg.id) || new Date().toISOString(),
        isNew: false,
        voiceTranscript: isVoiceUserMessage,
        voiceResponse: isVoiceAssistantMessage,
        incomplete: false,
      };
    });

    const deduped: UIMessage[] = [];
    for (const message of mapped) {
      const previous = deduped[deduped.length - 1];
      const sameConsecutiveUserMessage =
        previous &&
        previous.role === 'user' &&
        message.role === 'user' &&
        previous.content.trim() === message.content.trim();

      if (sameConsecutiveUserMessage) {
        deduped[deduped.length - 1] = message;
        continue;
      }

      deduped.push(message);
    }

    return deduped.map((message, index) => ({
      ...message,
      isNew: index === deduped.length - 1 && message.role === 'assistant',
    }));
  }, [chatMessages, getMessageText]);

  const hasGreetingAnchorMessage = useMemo(() => {
    if (!greetingAnchorId) return false;
    return messages.some((msg) => msg.id === greetingAnchorId);
  }, [greetingAnchorId, messages]);

  useEffect(() => {
    if (!debugEnabled) return;

    const gate = {
      hasGreetingAnchorId: !!greetingAnchorId,
      hasGreetingMessage: hasGreetingAnchorMessage,
      hasMemoryHighlights: memoryHighlightsCount > 0,
      memoryCount: memoryHighlightsCount,
    };
    const signature = JSON.stringify(gate);
    if (memoryHighlightsGateLogRef.current === signature) return;
    memoryHighlightsGateLogRef.current = signature;

    if (gate.hasGreetingAnchorId && gate.hasGreetingMessage && gate.hasMemoryHighlights) {
      debugLog('SessionPage', 'memory highlights render gate: ready', gate);
    } else {
      debugLog('SessionPage', 'memory highlights render gate: blocked', gate);
    }
  }, [debugEnabled, greetingAnchorId, hasGreetingAnchorMessage, memoryHighlightsCount]);

  const latestAssistantMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant') {
        return {
          id: message.id,
          content: message.content,
        };
      }
    }

    return null;
  }, [messages]);

  return {
    messages,
    hasGreetingAnchorMessage,
    latestAssistantMessage,
    setMessageTimestamp,
  };
}
