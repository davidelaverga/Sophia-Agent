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
  const previousScrollSnapshotRef = useRef<{
    count: number;
    lastMessageId: string | null;
    lastMessageContent: string | null;
  } | null>(null);

  useEffect(() => {
    const latestMessage = messages[messages.length - 1];
    const nextSnapshot = {
      count: messages.length,
      lastMessageId: latestMessage?.id ?? null,
      lastMessageContent: latestMessage?.content ?? null,
    };
    const previousSnapshot = previousScrollSnapshotRef.current;
    previousScrollSnapshotRef.current = nextSnapshot;

    if (!latestMessage) {
      return;
    }

    const isNewMessage =
      previousSnapshot?.count !== nextSnapshot.count
      || previousSnapshot?.lastMessageId !== nextSnapshot.lastMessageId;
    const isStreamingUpdate =
      isTyping
      && previousSnapshot?.lastMessageId === nextSnapshot.lastMessageId
      && previousSnapshot?.lastMessageContent !== nextSnapshot.lastMessageContent;

    if (!isNewMessage && !isStreamingUpdate) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: isTyping ? 'auto' : 'smooth',
        block: 'end',
      });
    });

    return () => cancelAnimationFrame(frame);
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
