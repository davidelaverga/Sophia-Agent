import { useCallback, useEffect, useRef, useState } from 'react';

import type { UIMessage } from '../components/session';

interface UseSessionUiInteractionsParams {
  messages: UIMessage[];
  isTyping: boolean;
  isReadOnly: boolean;
  showArtifacts: boolean;
  showArtifactsUi: boolean;
  mobileDrawerOpen: boolean;
  setShowArtifacts: (show: boolean) => void;
  setMobileDrawerOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setUserOpenedArtifacts: (opened: boolean) => void;
  setShowScaffold: (show: boolean) => void;
  triggerLightHaptic: () => void;
  onBaseMicClick: () => void;
}

export function useSessionUiInteractions({
  messages,
  isTyping,
  isReadOnly,
  showArtifacts,
  showArtifactsUi,
  mobileDrawerOpen,
  setShowArtifacts,
  setMobileDrawerOpen,
  setUserOpenedArtifacts,
  setShowScaffold,
  triggerLightHaptic,
  onBaseMicClick,
}: UseSessionUiInteractionsParams) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (isReadOnly) return;
        setComposerFocusToken((token) => token + 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isReadOnly]);

  useEffect(() => {
    if (!showArtifactsUi && showArtifacts) {
      setShowArtifacts(false);
    }
  }, [showArtifactsUi, showArtifacts, setShowArtifacts]);

  const handleMicClick = useCallback(() => {
    if (isReadOnly) return;
    setShowScaffold(false);
    onBaseMicClick();
  }, [isReadOnly, setShowScaffold, onBaseMicClick]);

  const focusComposer = useCallback(() => {
    if (isReadOnly) return;
    setComposerFocusToken((token) => token + 1);
  }, [isReadOnly]);

  const handleCloseArtifactsPanel = useCallback(() => {
    triggerLightHaptic();
    setShowArtifacts(false);
    setUserOpenedArtifacts(false);
  }, [setShowArtifacts, setUserOpenedArtifacts, triggerLightHaptic]);

  const handleOpenArtifactsPanel = useCallback(() => {
    setShowArtifacts(true);
    setUserOpenedArtifacts(true);
    triggerLightHaptic();
  }, [setShowArtifacts, setUserOpenedArtifacts, triggerLightHaptic]);

  const handleToggleMobileArtifactsTab = useCallback(() => {
    const next = !mobileDrawerOpen;
    setMobileDrawerOpen(next);
    setUserOpenedArtifacts(next);
    triggerLightHaptic();
  }, [mobileDrawerOpen, setMobileDrawerOpen, setUserOpenedArtifacts, triggerLightHaptic]);

  const handleToggleMobileDrawer = useCallback(() => {
    setMobileDrawerOpen((prev) => {
      const next = !prev;
      setUserOpenedArtifacts(next);
      return next;
    });
    triggerLightHaptic();
  }, [setMobileDrawerOpen, setUserOpenedArtifacts, triggerLightHaptic]);

  return {
    messagesEndRef,
    inputRef,
    composerFocusToken,
    handleMicClick,
    focusComposer,
    handleCloseArtifactsPanel,
    handleOpenArtifactsPanel,
    handleToggleMobileArtifactsTab,
    handleToggleMobileDrawer,
  };
}
