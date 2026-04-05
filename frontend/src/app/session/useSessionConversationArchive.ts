import { useEffect, useRef } from 'react';
import { archiveConversation } from '../lib/conversation-history';
import { isVerboseDebugEnabled } from '../lib/debug';
import { debugLog } from '../lib/debug-logger';

type SessionArchiveMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

type UseSessionConversationArchiveOptions = {
  sessionId: string;
  messages: SessionArchiveMessage[];
  intervalMs?: number;
};

const toHistoryRole = (role: 'user' | 'assistant'): 'user' | 'sophia' =>
  role === 'assistant' ? 'sophia' : 'user';

const toHistoryMessages = (messages: SessionArchiveMessage[]) =>
  messages.map((message) => ({
    id: message.id,
    role: toHistoryRole(message.role),
    content: message.content,
    createdAt: new Date(message.createdAt).getTime(),
  }));

export function useSessionConversationArchive({
  sessionId,
  messages,
  intervalMs = 30000,
}: UseSessionConversationArchiveOptions) {
  const messagesRef = useRef(messages);
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const autoSaveInterval = setInterval(() => {
      const conversationId = sessionIdRef.current;
      const currentMessages = messagesRef.current;

      if (!conversationId || conversationId === 'default-session' || currentMessages.length < 2) return;

      const chatMessages = toHistoryMessages(currentMessages);
      archiveConversation(conversationId, chatMessages);

      if (isVerboseDebugEnabled()) {
        debugLog('SessionPage', 'Auto-saved conversation', {
          conversationId,
          messageCount: chatMessages.length,
        });
      }
    }, intervalMs);

    return () => clearInterval(autoSaveInterval);
  }, [intervalMs]);

  useEffect(() => {
    return () => {
      const conversationId = sessionIdRef.current;
      const currentMessages = messagesRef.current;

      if (!conversationId || conversationId === 'default-session' || currentMessages.length < 2) return;

      const chatMessages = toHistoryMessages(currentMessages);
      archiveConversation(conversationId, chatMessages);

      if (isVerboseDebugEnabled()) {
        debugLog('SessionPage', 'Archived conversation on unmount', {
          conversationId,
          messageCount: chatMessages.length,
        });
      }
    };
  }, []);
}
