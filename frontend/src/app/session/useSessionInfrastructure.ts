import { useMemo } from 'react';

import { useConnectivity } from '../hooks/useConnectivity';
import { useConnectivityStore } from '../stores/connectivity-store';
import { useFeedbackStore } from '../stores/feedback-store';
import { useMessageMetadataStore } from '../stores/message-metadata-store';
import { useUiStore as useUiToastStore } from '../stores/ui-store';
import { useUsageLimitStore } from '../stores/usage-limit-store';

export function useSessionInfrastructure() {
  useConnectivity();

  const setMessageMetadata = useMessageMetadataStore((state) => state.setMessageMetadata);
  const setCurrentContext = useMessageMetadataStore((state) => state.setCurrentContext);
  const showToast = useUiToastStore((state) => state.showToast);

  const connectivityStatus = useConnectivityStore((state) => state.status);
  const queueMessage = useConnectivityStore((state) => state.queueMessage);
  const getQueuedMessages = useConnectivityStore((state) => state.getQueuedMessages);
  const removeFromQueue = useConnectivityStore((state) => state.removeFromQueue);
  const incrementRetry = useConnectivityStore((state) => state.incrementRetry);
  const queueMemoryApproval = useConnectivityStore((state) => state.queueMemoryApproval);
  const getQueuedMemoryApprovals = useConnectivityStore((state) => state.getQueuedMemoryApprovals);
  const removeMemoryApprovalFromQueue = useConnectivityStore((state) => state.removeMemoryApprovalFromQueue);
  const incrementMemoryApprovalRetry = useConnectivityStore((state) => state.incrementMemoryApprovalRetry);
  const markOffline = useConnectivityStore((state) => state.setOffline);
  const recordConnectivityFailure = useConnectivityStore((state) => state.recordFailure);

  const isOffline = useMemo(() => (
    connectivityStatus === 'offline' || connectivityStatus === 'degraded'
  ), [connectivityStatus]);

  const limitModalOpen = useUsageLimitStore((state) => state.isOpen);
  const limitInfo = useUsageLimitStore((state) => state.limitInfo);
  const closeLimitModal = useUsageLimitStore((state) => state.closeModal);
  const showUsageLimitModal = useUsageLimitStore((state) => state.showModal);

  const setFeedback = useFeedbackStore((state) => state.setFeedback);
  const feedbackByMessage = useFeedbackStore((state) => state.feedbackByMessage);

  return {
    setMessageMetadata,
    setCurrentContext,
    showToast,
    connectivityStatus,
    isOffline,
    queueMessage,
    getQueuedMessages,
    removeFromQueue,
    incrementRetry,
    queueMemoryApproval,
    getQueuedMemoryApprovals,
    removeMemoryApprovalFromQueue,
    incrementMemoryApprovalRetry,
    markOffline,
    recordConnectivityFailure,
    limitModalOpen,
    limitInfo,
    closeLimitModal,
    showUsageLimitModal,
    setFeedback,
    feedbackByMessage,
  };
}
