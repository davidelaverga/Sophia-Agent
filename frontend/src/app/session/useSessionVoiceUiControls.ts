import { useCallback } from 'react';

type VoiceStatus = 'ready' | 'listening' | 'thinking' | 'speaking';

type VoiceStage = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

type VoiceStateControls = {
  stage: VoiceStage;
  startTalking: () => Promise<void>;
  stopTalking: () => Promise<void>;
  bargeIn: () => void;
  softBargeIn: () => void;
  resetVoiceState: () => void;
};

interface UseSessionVoiceUiControlsParams {
  voiceState: VoiceStateControls;
}

export function useSessionVoiceUiControls({
  voiceState,
}: UseSessionVoiceUiControlsParams) {
  const baseHandleMicClick = useCallback(() => {
    if (voiceState.stage === 'listening' || voiceState.stage === 'connecting') {
      void voiceState.stopTalking();
      return;
    }

    if (voiceState.stage === 'speaking') {
      voiceState.softBargeIn();
      return;
    }

    if (voiceState.stage === 'thinking') {
      return;
    }

    if (voiceState.stage === 'error') {
      voiceState.resetVoiceState();
    }

    void voiceState.startTalking();
  }, [voiceState]);

  const setVoiceStatusCompat = useCallback((status: VoiceStatus) => {
    if (status !== 'ready') return;

    if (voiceState.stage === 'listening' || voiceState.stage === 'connecting') {
      void voiceState.stopTalking();
      return;
    }

    if (voiceState.stage === 'thinking' || voiceState.stage === 'error') {
      voiceState.resetVoiceState();
    }
  }, [voiceState]);

  return {
    baseHandleMicClick,
    setVoiceStatusCompat,
  };
}
