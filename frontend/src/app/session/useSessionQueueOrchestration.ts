import type React from 'react';
import type { ConnectivityStatus } from '../stores/connectivity-store';
import { useSessionQueueRuntime } from './useSessionQueueRuntime';
import { useSessionQueueSync } from './useSessionQueueSync';

type ChatMessagePart = {
  type?: string;
  text?: string;
};

type ChatMessageLike = {
  id: string;
  role?: string;
  parts?: ChatMessagePart[];
};

type QueuedMessage = {
  id: string;
  content: string;
  timestamp?: string;
  retryCount?: number;
};

type QueuedMemoryApproval = {
  id: string;
  memoryText: string;
  sessionId: string;
  category?: string;
};

type ToastFn = (input: {
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}) => void;

interface UseSessionQueueOrchestrationParams {
  chatStatus: string;
  chatMessages: ChatMessageLike[];
  connectivityStatus: ConnectivityStatus;
  onReconnectOnline?: () => void;
  sessionId: string;
  getQueuedMessages: (sessionId: string) => QueuedMessage[];
  getQueuedMemoryApprovals: (sessionId: string) => QueuedMemoryApproval[];
  sendMessage: (input: { text: string }) => Promise<void> | void;
  removeFromQueue: (messageId: string) => void;
  incrementRetry: (messageId: string) => void;
  removeMemoryApprovalFromQueue: (approvalId: string) => void;
  incrementMemoryApprovalRetry: (approvalId: string) => void;
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessageLike[]>>;
  showToast: ToastFn;
}

export function useSessionQueueOrchestration({
  chatStatus,
  chatMessages,
  connectivityStatus,
  onReconnectOnline,
  sessionId,
  getQueuedMessages,
  getQueuedMemoryApprovals,
  sendMessage,
  removeFromQueue,
  incrementRetry,
  removeMemoryApprovalFromQueue,
  incrementMemoryApprovalRetry,
  setChatMessages,
  showToast,
}: UseSessionQueueOrchestrationParams) {
  const {
    getChatMessages,
    getChatStatus,
  } = useSessionQueueRuntime({
    chatStatus,
    chatMessages,
    connectivityStatus,
    onReconnectOnline,
  });

  useSessionQueueSync({
    connectivityStatus,
    sessionId,
    getQueuedMessages,
    getQueuedMemoryApprovals,
    getChatMessages,
    sendMessage,
    getChatStatus,
    removeFromQueue,
    incrementRetry,
    removeMemoryApprovalFromQueue,
    incrementMemoryApprovalRetry,
    setChatMessages,
    showToast,
  });
}