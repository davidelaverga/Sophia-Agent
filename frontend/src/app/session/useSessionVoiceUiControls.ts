import { useCallback } from 'react';

type VoiceStatus = 'ready' | 'listening' | 'thinking' | 'speaking';

type VoiceStage = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

type VoiceStateControls = {
  stage: VoiceStage;
  startTalking: () => Promise<void>;
  stopTalking: () => Promise<void>;
  /** Mute the mic without tearing down the session (call + agent stay alive). */
  muteMic?: () => Promise<void>;
  /** Unmute the mic. Falls back to startTalking if no live call. */
  unmuteMic?: () => Promise<void>;
  /** True if mic is currently muted via muteMic. */
  isMuted?: boolean;
  /** True if WebRTC call is JOINED (agent session alive on server). */
  hasLiveCall?: boolean;
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
    // While actively listening: mute mic (keeps session alive) instead of
    // tearing everything down. Prevents progressive latency accumulation
    // when the user toggles the mic multiple times within a session.
    if (voiceState.stage === 'listening') {
      if (voiceState.muteMic) {
        void voiceState.muteMic();
      } else {
        void voiceState.stopTalking();
      }
      return;
    }

    // Connecting: user wants to cancel — full stop (no live call to mute yet).
    if (voiceState.stage === 'connecting') {
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

    // Idle with a live call + muted → just unmute (cheap toggle).
    if (voiceState.hasLiveCall && voiceState.isMuted && voiceState.unmuteMic) {
      void voiceState.unmuteMic();
      return;
    }

    // No live call → full startTalking (initial connect).
    void voiceState.startTalking();
  }, [voiceState]);

  const setVoiceStatusCompat = useCallback((status: VoiceStatus) => {
    if (status !== 'ready') return;

    if (voiceState.stage === 'listening') {
      if (voiceState.muteMic) {
        void voiceState.muteMic();
      } else {
        void voiceState.stopTalking();
      }
      return;
    }

    if (voiceState.stage === 'connecting') {
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
