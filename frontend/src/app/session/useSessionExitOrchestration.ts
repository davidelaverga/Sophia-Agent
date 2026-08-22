import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type { ContextMode, PresetType, RitualArtifacts } from '../types/session';

import { useSessionExitFlow } from './useSessionExitFlow';
import { useSessionExitProtection } from './useSessionExitProtection';

type ExitGuardMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  source?: 'voice' | 'text';
  incomplete?: boolean;
};

type PersistedSessionMessage = ExitGuardMessage & {
  incomplete?: boolean;
};

type UseSessionExitOrchestrationParams = {
  isReadOnly: boolean;
  isSophiaResponding: boolean;
  stopStreaming: () => void;
  stopVoiceTransport?: () => Promise<void> | void;
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
  currentArtifacts?: RitualArtifacts | null;
  currentBuilderArtifact?: BuilderArtifactV1 | null;
  userId?: string;
  persistedThreadId?: string;
  threadId?: string;
  greetingMessageId?: string;
  persistedSessionId?: string;
  responseMode: 'text' | 'voice';
  messages: ExitGuardMessage[];
  updateMessages: (messages: PersistedSessionMessage[]) => void;
  flushSessionTranscript?: () => Promise<number>;
  getSessionTranscriptRevision?: () => number;
  isEnding: boolean;
};

export function useSessionExitOrchestration({
  isReadOnly,
  isSophiaResponding,
  stopStreaming,
  stopVoiceTransport,
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
  currentArtifacts,
  currentBuilderArtifact,
  userId,
  persistedThreadId,
  threadId,
  greetingMessageId,
  persistedSessionId,
  responseMode,
  messages,
  updateMessages,
  flushSessionTranscript,
  getSessionTranscriptRevision,
  isEnding,
}: UseSessionExitOrchestrationParams) {
  const {
    showExitConfirm,
    showDebriefOffer,
    showEmergence,
    debriefData,
    isNavigatingToRecap,
    openExitConfirm,
    handleEndSession,
    handleVoiceEndSession,
    handleCancelExit,
    handleStartDebrief,
    handleSkipToRecap,
    handleEmergenceComplete,
    handleAbruptExit,
  } = useSessionExitFlow({
    isReadOnly,
    isSophiaResponding,
    stopStreaming,
    stopVoiceTransport,
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
    currentArtifacts,
    currentBuilderArtifact,
    userId,
    persistedThreadId,
    threadId,
    greetingMessageId,
    messages,
    flushSessionTranscript,
    getSessionTranscriptRevision,
  });

  useSessionExitProtection({
    sessionId: persistedSessionId,
    responseMode,
    isSophiaResponding,
    messages,
    updateMessages,
    openExitConfirm,
    isExitInProgress: isEnding || isNavigatingToRecap || showDebriefOffer || showEmergence,
  });

  return {
    showExitConfirm,
    showDebriefOffer,
    showEmergence,
    debriefData,
    isNavigatingToRecap,
    handleEndSession,
    handleVoiceEndSession,
    handleCancelExit,
    handleStartDebrief,
    handleSkipToRecap,
    handleEmergenceComplete,
    handleAbruptExit,
  };
}
