import { useCompanionArtifactsRuntime } from './artifacts-runtime';
import { useCompanionChatRuntime } from './chat-runtime';
import { getCompanionRouteProfile } from './route-profiles';
import { useCompanionStreamContract } from './stream-contract';
import type { UseCompanionRuntimeParams } from './types';
import { useCompanionVoiceRuntime } from './voice-runtime';

export function useCompanionRuntime({
  routeProfile,
  chat,
  stream,
  artifacts,
  voice,
}: UseCompanionRuntimeParams) {
  const resolvedRouteProfile = getCompanionRouteProfile(routeProfile);

  const chatRuntime = useCompanionChatRuntime(chat);
  const streamContract = useCompanionStreamContract(stream);
  const artifactsRuntime = useCompanionArtifactsRuntime(artifacts);
  const voiceRuntime = useCompanionVoiceRuntime(voice);

  return {
    routeProfile: resolvedRouteProfile,
    chatRuntime,
    streamContract,
    artifactsRuntime,
    voiceRuntime,
  };
}