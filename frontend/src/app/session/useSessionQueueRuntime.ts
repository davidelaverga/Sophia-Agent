import { useCallback, useEffect, useRef } from 'react';
import type { ConnectivityStatus } from '../stores/connectivity-store';

type ChatMessagePart = {
  type?: string;
  text?: string;
};

type ChatMessageLike = {
  id: string;
  role?: string;
  parts?: ChatMessagePart[];
};

interface UseSessionQueueRuntimeParams {
  chatStatus: string;
  chatMessages: ChatMessageLike[];
  connectivityStatus: ConnectivityStatus;
  onReconnectOnline?: () => void;
}

export function useSessionQueueRuntime({
  chatStatus,
  chatMessages,
  connectivityStatus,
  onReconnectOnline,
}: UseSessionQueueRuntimeParams) {
  const chatStatusRef = useRef(chatStatus);
  const chatMessagesRef = useRef(chatMessages);
  const previousConnectivityStatusRef = useRef(connectivityStatus);

  useEffect(() => {
    chatStatusRef.current = chatStatus;
  }, [chatStatus]);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(() => {
    const wasOfflineLike =
      previousConnectivityStatusRef.current === 'offline' ||
      previousConnectivityStatusRef.current === 'degraded';
    const isNowOnline = connectivityStatus === 'online';

    if (wasOfflineLike && isNowOnline) {
      onReconnectOnline?.();
    }

    previousConnectivityStatusRef.current = connectivityStatus;
  }, [connectivityStatus, onReconnectOnline]);

  const getChatStatus = useCallback(() => chatStatusRef.current, []);
  const getChatMessages = useCallback(() => chatMessagesRef.current, []);

  return {
    getChatStatus,
    getChatMessages,
  };
}