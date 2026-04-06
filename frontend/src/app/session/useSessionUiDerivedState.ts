import { useMemo } from 'react';

import type { UIMessage } from '../components/session';
import type { RitualArtifacts } from '../lib/session-types';
import { getPresenceDisplay, getContextualPlaceholder } from '../lib/sophia-presence';
import type { ContextMode, PresetType } from '../types/session';

interface UseSessionUiDerivedStateParams {
  isTyping: boolean;
  messages: UIMessage[];
  artifacts: RitualArtifacts | null;
  isStreaming: boolean;
  isReflectionVoiceFlowActive: boolean;
  userOpenedArtifacts: boolean;
  voiceStatus: 'ready' | 'listening' | 'thinking' | 'speaking';
  isReflectionTtsActive: boolean;
  sessionPresetType?: PresetType;
  sessionContextMode?: ContextMode;
}

export function useSessionUiDerivedState({
  isTyping,
  messages,
  artifacts,
  isStreaming,
  isReflectionVoiceFlowActive,
  userOpenedArtifacts,
  voiceStatus,
  isReflectionTtsActive,
  sessionPresetType,
  sessionContextMode,
}: UseSessionUiDerivedStateParams) {

  const hasArtifactsContent = useMemo(() => {
    const takeaway = artifacts?.takeaway?.trim();
    const reflection = artifacts?.reflection_candidate?.prompt?.trim();
    const memoriesCount = artifacts?.memory_candidates?.length ?? 0;
    return Boolean(takeaway || reflection || memoriesCount > 0);
  }, [artifacts]);

  const isVoiceThinking = voiceStatus === 'thinking';
  const showThinkingIndicator = (isTyping || isVoiceThinking) && !isReflectionTtsActive;

  const inputPlaceholder = useMemo(() => {
    if (!sessionPresetType || !sessionContextMode) return "What's on your mind?";
    return getContextualPlaceholder(sessionPresetType, sessionContextMode, messages.length);
  }, [messages.length, sessionContextMode, sessionPresetType]);

  const presenceStatus = useMemo(() => {
    if (!sessionPresetType) return undefined;

    const state = isTyping
      ? 'thinking'
      : voiceStatus === 'listening'
        ? 'listening'
        : voiceStatus === 'speaking'
          ? 'speaking'
          : 'ready';

    const display = getPresenceDisplay(state, sessionPresetType, messages.length);
    return display.status;
  }, [isTyping, messages.length, sessionPresetType, voiceStatus]);

  const showArtifactsUi = useMemo(() => {
    return hasArtifactsContent || isStreaming || voiceStatus === 'speaking' || voiceStatus === 'thinking' || userOpenedArtifacts;
  }, [hasArtifactsContent, isStreaming, voiceStatus, userOpenedArtifacts]);

  const showCompanionRail = useMemo(() => {
    return messages.length >= 2 && !isTyping && !!sessionContextMode;
  }, [messages.length, isTyping, sessionContextMode]);

  const isSophiaResponding = useMemo(() => {
    return !isReflectionVoiceFlowActive && (
      isStreaming ||
      voiceStatus === 'thinking' ||
      (voiceStatus === 'speaking' && !isReflectionTtsActive)
    );
  }, [isReflectionVoiceFlowActive, isStreaming, voiceStatus, isReflectionTtsActive]);

  const exitProtectionResponseMode = useMemo<'text' | 'voice'>(() => {
    if (isStreaming) return 'text';
    if (voiceStatus === 'thinking') return 'voice';
    if (voiceStatus === 'speaking' && !isReflectionTtsActive) return 'voice';
    return 'text';
  }, [isStreaming, voiceStatus, isReflectionTtsActive]);

  return {
    hasArtifactsContent,
    showArtifactsUi,
    showCompanionRail,
    isSophiaResponding,
    exitProtectionResponseMode,
    isVoiceThinking,
    showThinkingIndicator,
    inputPlaceholder,
    presenceStatus,
  };
}
