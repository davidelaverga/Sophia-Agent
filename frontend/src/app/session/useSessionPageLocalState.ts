import { useCallback, useEffect, useRef, useState } from 'react';

interface UseSessionPageLocalStateParams {
  sessionId?: string;
}

export function useSessionPageLocalState({
  sessionId,
}: UseSessionPageLocalStateParams) {
  const hasShownReconnectRef = useRef(false);

  const [input, setInput] = useState('');
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [userOpenedArtifacts, setUserOpenedArtifacts] = useState(false);
  const [justSent, setJustSent] = useState(false);
  const [showScaffold, setShowScaffold] = useState(true);
  const [dismissedError, setDismissedError] = useState(false);
  const [showFeedbackToast, setShowFeedbackToast] = useState<'helpful' | 'not_helpful' | null>(null);

  const handleReconnectOnline = useCallback(() => {
    setDismissedError(true);
  }, []);

  useEffect(() => {
    setUserOpenedArtifacts(false);
    setShowArtifacts(false);
    setMobileDrawerOpen(false);
  }, [sessionId]);

  return {
    hasShownReconnectRef,
    input,
    setInput,
    showArtifacts,
    setShowArtifacts,
    mobileDrawerOpen,
    setMobileDrawerOpen,
    userOpenedArtifacts,
    setUserOpenedArtifacts,
    justSent,
    setJustSent,
    showScaffold,
    setShowScaffold,
    dismissedError,
    setDismissedError,
    showFeedbackToast,
    setShowFeedbackToast,
    handleReconnectOnline,
  };
}
