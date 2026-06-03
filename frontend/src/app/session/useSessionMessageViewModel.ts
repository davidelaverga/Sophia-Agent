import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { UIMessage } from '../components/session';
import { debugLog } from '../lib/debug-logger';
import { extractTextFromUiMessageStreamDump } from '../lib/ui-message-stream-parser';
import { reconcileVoiceTranscript } from '../lib/voice-transcript-reconciliation';

type ChatMessagePart = {
  type?: string;
  text?: string;
};

type ChatMessageLike = {
  id: string;
  role: string;
  parts: ChatMessagePart[];
};

type SessionMessageDedupeResult = {
  messages: UIMessage[];
  duplicateIds: string[];
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
  const duplicateMessageIdsLogRef = useRef<string | null>(null);

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

  const messageModel = useMemo(() => {
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

    const { messages: uniqueMapped, duplicateIds } = dedupeMappedMessagesById(mapped);
    const deduped: UIMessage[] = [];
    for (const message of uniqueMapped) {
      const previous = deduped[deduped.length - 1];
      const overlappingVoiceUserTranscript =
        previous?.role === 'user' &&
        previous.voiceTranscript === true &&
        message.role === 'user' &&
        message.voiceTranscript === true;

      if (overlappingVoiceUserTranscript) {
        const reconciledTranscript = reconcileVoiceTranscript(previous.content, message.content);
        if (reconciledTranscript.incremental) {
          if (reconciledTranscript.changed) {
            deduped[deduped.length - 1] = {
              ...previous,
              content: reconciledTranscript.text,
            };
          }
          continue;
        }
      }

      const sameConsecutiveUserMessage =
        previous?.role === 'user' &&
        message.role === 'user' &&
        previous.content.trim() === message.content.trim();

      if (sameConsecutiveUserMessage) {
        deduped[deduped.length - 1] = message;
        continue;
      }

      deduped.push(message);
    }

    return {
      duplicateIds,
      messages: deduped.map((message, index) => ({
        ...message,
        isNew: index === deduped.length - 1 && message.role === 'assistant',
      })),
    };
  }, [chatMessages, getMessageText]);
  const messages = messageModel.messages;

  useEffect(() => {
    if (!debugEnabled || messageModel.duplicateIds.length === 0) return;

    const signature = messageModel.duplicateIds.join('|');
    if (duplicateMessageIdsLogRef.current === signature) return;
    duplicateMessageIdsLogRef.current = signature;

    debugLog('SessionPage', 'duplicate UI message ids suppressed', {
      duplicateIdCount: messageModel.duplicateIds.length,
      duplicateIds: messageModel.duplicateIds.slice(0, 5),
      rawMessageCount: chatMessages.length,
      renderedMessageCount: messages.length,
    });
  }, [chatMessages.length, debugEnabled, messageModel.duplicateIds, messages.length]);

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

function dedupeMappedMessagesById(messages: UIMessage[]): SessionMessageDedupeResult {
  const indexById = new Map<string, number>();
  const duplicateIds = new Set<string>();
  const uniqueMessages: UIMessage[] = [];

  for (const message of messages) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      indexById.set(message.id, uniqueMessages.length);
      uniqueMessages.push(message);
      continue;
    }

    duplicateIds.add(message.id);
    uniqueMessages[existingIndex] = preferMoreCompleteMessage(uniqueMessages[existingIndex], message);
  }

  return {
    messages: uniqueMessages,
    duplicateIds: [...duplicateIds],
  };
}

function preferMoreCompleteMessage(existing: UIMessage, candidate: UIMessage): UIMessage {
  if (existing.role !== candidate.role) {
    return existing;
  }

  const existingScore = messageCompletenessScore(existing);
  const candidateScore = messageCompletenessScore(candidate);

  if (candidateScore <= existingScore) {
    return existing;
  }

  return {
    ...candidate,
    createdAt: existing.createdAt || candidate.createdAt,
  };
}

function messageCompletenessScore(message: UIMessage): number {
  const contentLength = message.content.trim().length;
  let score = Math.min(contentLength, 100_000);

  if (contentLength > 0) {
    score += 100_000;
  }
  if (message.incomplete !== true) {
    score += 1_000;
  }

  return score;
}
