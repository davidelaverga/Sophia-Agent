import { useSessionExitFlow } from './useSessionExitFlow';
import { useSessionExitProtection } from './useSessionExitProtection';
import type { ContextMode, PresetType } from '../types/session';

type ExitGuardMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

type PersistedSessionMessage = ExitGuardMessage & {
  incomplete?: boolean;
};

type UseSessionExitOrchestrationParams = {
  isReadOnly: boolean;
  isSophiaResponding: boolean;
  stopStreaming: () => void;
  setEnding: (isEnding: boolean) => void;
  sessionId: string;
  sessionStartedAt?: string;
  sessionPresetType?: PresetType;
  sessionContextMode?: ContextMode;
  messageCount: number;
  endSessionStore: () => void;
  clearSessionStore: () => void;
  clearBootstrap: () => void;
  navigateTo: (path: string) => void;
  promoteToDebriefMode: () => void;
  startDebriefWithLLM: (debriefData: {
    prompt: string;
    durationMinutes: number;
    takeaway?: string;
    sessionId: string;
  }) => void;
  persistedSessionId?: string;
  responseMode: 'text' | 'voice';
  messages: ExitGuardMessage[];
  updateMessages: (messages: PersistedSessionMessage[]) => void;
  isEnding: boolean;
};

export function useSessionExitOrchestration({
  isReadOnly,
  isSophiaResponding,
  stopStreaming,
  setEnding,
  sessionId,
  sessionStartedAt,
  sessionPresetType,
  sessionContextMode,
  messageCount,
  endSessionStore,
  clearSessionStore,
  clearBootstrap,
  navigateTo,
  promoteToDebriefMode,
  startDebriefWithLLM,
  persistedSessionId,
  responseMode,
  messages,
  updateMessages,
  isEnding,
}: UseSessionExitOrchestrationParams) {
  const {
    showExitConfirm,
    showDebriefOffer,
    showEmergence,
    showFeedback,
    debriefData,
    isNavigatingToRecap,
    openExitConfirm,
    handleEndSession,
    handleVoiceEndSession,
    handleCancelExit,
    handleStartDebrief,
    handleSkipToRecap,
    handleEmergenceComplete,
    handleFeedbackComplete,
    handleAbruptExit,
  } = useSessionExitFlow({
    isReadOnly,
    isSophiaResponding,
    stopStreaming,
    setEnding,
    sessionId,
    sessionStartedAt,
    sessionPresetType,
    sessionContextMode,
    messageCount,
    endSessionStore,
    clearSessionStore,
    clearBootstrap,
    navigateTo,
    promoteToDebriefMode,
    startDebriefWithLLM,
  });

  useSessionExitProtection({
    sessionId: persistedSessionId,
    responseMode,
    isSophiaResponding,
    messages,
    updateMessages,
    openExitConfirm,
    isExitInProgress: isEnding || isNavigatingToRecap || showDebriefOffer || showEmergence || showFeedback,
  });

  return {
    showExitConfirm,
    showDebriefOffer,
    showEmergence,
    showFeedback,
    debriefData,
    isNavigatingToRecap,
    handleEndSession,
    handleVoiceEndSession,
    handleCancelExit,
    handleStartDebrief,
    handleSkipToRecap,
    handleEmergenceComplete,
    handleFeedbackComplete,
    handleAbruptExit,
  };
}