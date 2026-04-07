import { useEffect, useRef } from 'react';

import { useConnectivityStore, type ConnectivityStatus } from '../stores/connectivity-store';

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

type ChatMessagePart = {
  type?: string;
  text?: string;
};

type ChatMessageLike = {
  id: string;
  role?: string;
  parts?: ChatMessagePart[];
};

interface UseSessionQueueSyncParams {
  connectivityStatus: ConnectivityStatus;
  sessionId: string;
  getQueuedMessages: (sessionId: string) => QueuedMessage[];
  getQueuedMemoryApprovals: (sessionId: string) => QueuedMemoryApproval[];
  getChatMessages: () => ChatMessageLike[];
  sendMessage: (input: { text: string }) => Promise<void> | void;
  getChatStatus: () => string;
  removeFromQueue: (messageId: string) => void;
  incrementRetry: (messageId: string) => void;
  removeMemoryApprovalFromQueue: (approvalId: string) => void;
  incrementMemoryApprovalRetry: (approvalId: string) => void;
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessageLike[]>>;
  showToast: ToastFn;
}

function extractMessageText(message: ChatMessageLike): string {
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .filter((part) => part?.type === 'text')
    .map((part) => String(part?.text ?? ''))
    .join('')
    .trim();
}

function normalizeMessageText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[!?.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAvailabilityPing(value: string): boolean {
  const normalized = normalizeMessageText(value);
  if (!normalized) return false;

  const exactPings = new Set([
    'hey',
    'hello',
    'hi',
    'hey sophia',
    'hello sophia',
    'sophia',
    'you there',
    'are you there',
    'are you there sophia',
    'sophia are you there',
    'how are you',
    'how are you sophia',
    'sophia how are you',
  ]);

  if (exactPings.has(normalized)) return true;

  return (
    /^hey(\s+sophia)?$/.test(normalized) ||
    /^hello(\s+sophia)?$/.test(normalized) ||
    /^sophia\s*are\s*you\s*there$/.test(normalized) ||
    /^are\s*you\s*there(\s+sophia)?$/.test(normalized)
  );
}

export function useSessionQueueSync({
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
}: UseSessionQueueSyncParams) {
  const isMessageSyncInProgressRef = useRef(false);
  const inFlightQueuedMessageIdsRef = useRef<Set<string>>(new Set());
  const queuedMessagesForSession = useConnectivityStore((state) =>
    state.messageQueue.filter((message) => message.sessionId === sessionId)
  );
  const queuedApprovalsForSession = useConnectivityStore((state) =>
    state.memoryApprovalQueue.filter((approval) => approval.sessionId === sessionId)
  );

  const waitForCondition = async (
    predicate: () => boolean,
    timeoutMs: number,
    intervalMs = 120
  ): Promise<boolean> => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return false;
  };

  useEffect(() => {
    if (connectivityStatus !== 'online') return;

    const queuedMessages = queuedMessagesForSession;
    const queuedApprovals = queuedApprovalsForSession;

    if (queuedMessages.length > 0) {
      const deliveredByContent = new Set(
        getChatMessages()
          .filter((message) => message.role === 'user' && !message.id.startsWith('queued-'))
          .map((message) => extractMessageText(message))
          .filter((text) => text.length > 0)
      );

      const staleQueued = queuedMessages.filter((queuedMsg) => deliveredByContent.has(queuedMsg.content));
      if (staleQueued.length > 0) {
        staleQueued.forEach((queuedMsg) => {
          removeFromQueue(queuedMsg.id);
          inFlightQueuedMessageIdsRef.current.delete(queuedMsg.id);
        });

        setChatMessages((prev) =>
          prev.filter((message) => {
            if (!message.id.startsWith('queued-') || message.role !== 'user') return true;
            const bubbleText = extractMessageText(message);
            return !deliveredByContent.has(bubbleText);
          })
        );
      }
    }

    if (queuedMessages.length > 0) {
      const syncQueuedMessages = async () => {
        if (isMessageSyncInProgressRef.current) {
          return;
        }

        isMessageSyncInProgressRef.current = true;
        let sentCount = 0;
        try {
          await new Promise((resolve) => setTimeout(resolve, 800));

          for (let queuedIndex = 0; queuedIndex < queuedMessages.length; queuedIndex += 1) {
            const queuedMsg = queuedMessages[queuedIndex];
            if (inFlightQueuedMessageIdsRef.current.has(queuedMsg.id)) {
              continue;
            }

            if (isAvailabilityPing(queuedMsg.content)) {
              const hasNewerEquivalentPing = queuedMessages
                .slice(queuedIndex + 1)
                .some((candidate) => isAvailabilityPing(candidate.content));

              if (hasNewerEquivalentPing) {
                removeFromQueue(queuedMsg.id);
                setChatMessages((prev) =>
                  prev.filter((message) => message.id !== `queued-${queuedMsg.id}`)
                );
                continue;
              }
            }

            const stillOnline = useConnectivityStore.getState().status === 'online';
            if (!stillOnline) {
              break;
            }

            const alreadyDelivered = getChatMessages().some((message) => {
              if (message.role !== 'user') return false;
              if (message.id.startsWith('queued-')) return false;
              const text = extractMessageText(message);
              return text === queuedMsg.content;
            });

            if (alreadyDelivered) {
              removeFromQueue(queuedMsg.id);
              setChatMessages((prev) =>
                prev.filter((message) => {
                  if (message.id === `queued-${queuedMsg.id}`) return false;
                  const isQueuedBubble = message.id.startsWith('queued-') && message.role === 'user';
                  if (!isQueuedBubble) return true;
                  return extractMessageText(message) !== queuedMsg.content;
                })
              );
              continue;
            }

            inFlightQueuedMessageIdsRef.current.add(queuedMsg.id);

            const readyForSend = await waitForCondition(() => getChatStatus() === 'ready', 8000);
            if (!readyForSend) {
              incrementRetry(queuedMsg.id);
              inFlightQueuedMessageIdsRef.current.delete(queuedMsg.id);
              continue;
            }

            try {
              await Promise.resolve(sendMessage({ text: queuedMsg.content }));

              const started = await waitForCondition(() => {
                const status = getChatStatus();
                return status === 'submitted' || status === 'streaming' || status === 'error';
              }, 4000);

              if (!started || getChatStatus() === 'error') {
                incrementRetry(queuedMsg.id);
                inFlightQueuedMessageIdsRef.current.delete(queuedMsg.id);
                continue;
              }

              removeFromQueue(queuedMsg.id);
              const staleSameContent = getQueuedMessages(sessionId).filter((candidate) => {
                if (candidate.id === queuedMsg.id) return false;
                if (candidate.content !== queuedMsg.content) return false;

                const queuedTimestamp = queuedMsg.timestamp ? Date.parse(queuedMsg.timestamp) : NaN;
                const candidateTimestamp = candidate.timestamp ? Date.parse(candidate.timestamp) : NaN;

                if (Number.isNaN(queuedTimestamp) || Number.isNaN(candidateTimestamp)) {
                  return false;
                }

                return candidateTimestamp <= queuedTimestamp;
              });

              staleSameContent.forEach((duplicate) => removeFromQueue(duplicate.id));

              setChatMessages((prev) =>
                prev.filter((message) => {
                  if (message.id === `queued-${queuedMsg.id}`) return false;

                  const isQueuedBubble = message.id.startsWith('queued-') && message.role === 'user';
                  if (!isQueuedBubble) return true;

                  const bubbleText = extractMessageText(message);
                  return bubbleText !== queuedMsg.content;
                })
              );
              sentCount += 1;

              await waitForCondition(() => {
                const status = getChatStatus();
                return status === 'ready' || status === 'error';
              }, 45000);

              await new Promise((resolve) => setTimeout(resolve, 450));
            } catch {
              incrementRetry(queuedMsg.id);
            } finally {
              inFlightQueuedMessageIdsRef.current.delete(queuedMsg.id);
            }
          }

          const remainingQueuedMessages = getQueuedMessages(sessionId).length;

          if (sentCount > 0 && remainingQueuedMessages === 0) {
            showToast({
              message:
                sentCount === 1
                  ? "I'm back online — I sent your queued message."
                  : `I'm back online — I sent your ${sentCount} queued messages.`,
              variant: 'success',
              durationMs: 3200,
            });
            return;
          }
        } finally {
          isMessageSyncInProgressRef.current = false;
        }
      };

      void syncQueuedMessages();
    }

    if (queuedApprovals.length > 0) {
      const syncQueuedApprovals = async () => {
        let syncedCount = 0;
        let failedCount = 0;

        for (const queuedApproval of queuedApprovals) {
          try {
            const response = await fetch('/api/memory/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                memory_text: queuedApproval.memoryText,
                category: queuedApproval.category,
                session_id: queuedApproval.sessionId,
              }),
            });

            if (response.ok) {
              removeMemoryApprovalFromQueue(queuedApproval.id);
              syncedCount += 1;
            } else {
              incrementMemoryApprovalRetry(queuedApproval.id);
              failedCount += 1;
            }
          } catch {
            incrementMemoryApprovalRetry(queuedApproval.id);
            failedCount += 1;
          }
        }

        if (syncedCount > 0 && failedCount === 0) {
          showToast({
            message:
              syncedCount === 1
                ? "I'm back online — I saved the memory you queued."
                : `I'm back online — I saved your ${syncedCount} queued memories.`,
            variant: 'success',
            durationMs: 3600,
          });
          return;
        }

        if (syncedCount > 0 && failedCount > 0) {
          showToast({
            message: `I saved ${syncedCount} queued ${syncedCount === 1 ? 'memory' : 'memories'}, but ${failedCount} still need to sync.`,
            variant: 'warning',
            durationMs: 4200,
          });
          return;
        }

        if (failedCount > 0) {
          showToast({
            message: "I'm back online, but I couldn't sync your queued memories yet. I'll keep trying.",
            variant: 'warning',
            durationMs: 4200,
          });
        }
      };

      void syncQueuedApprovals();
    }
  }, [
    connectivityStatus,
    sessionId,
    queuedMessagesForSession,
    queuedApprovalsForSession,
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
  ]);
}
