import type { StreamArtifactsPayload } from '../session/stream-contract-adapters';
import type { InterruptPayload, RitualArtifacts } from '../types/session';
import type { SophiaMessageMetadata } from '../types/sophia-ui-message';

import type { CompanionRouteProfile, CompanionRouteProfileId } from './route-profiles';

export type CompanionArtifactSource = 'stream' | 'interrupt' | 'companion' | 'voice';

export type UseCompanionChatRuntimeParams = {
  chatRequestBody?: Record<string, unknown>;
  handleDataPart: (dataPart: unknown) => void;
  handleFinish: (options: { message: { id: string } }) => void;
  showUsageLimitModal: (info: unknown) => void;
  recordConnectivityFailure: () => void;
  showToast: (args: {
    message: string;
    variant: 'warning' | 'error' | 'info' | 'success';
    durationMs?: number;
  }) => void;
};

export type UseCompanionStreamContractParams = {
  ingestArtifacts: (incoming: StreamArtifactsPayload, source: CompanionArtifactSource) => void;
  setInterrupt: (interrupt: InterruptPayload) => void;
  setCurrentContext: (threadId: string, sessionId: string, runId?: string) => void;
  setMessageMetadata: (messageId: string, metadata: Partial<SophiaMessageMetadata>) => void;
  sessionId: string;
  activeSessionId?: string;
  activeThreadId?: string;
};

export type UseCompanionArtifactsRuntimeParams = {
  sessionId?: string;
  artifacts?: RitualArtifacts | null;
  storeArtifacts: (artifacts: RitualArtifacts, summary?: string) => void;
  updateSession: (updates: { artifacts?: RitualArtifacts; summary?: string }) => void;
};

export type CompanionVoiceRetryState = { transcript: string; message: string } | null;

export type UseCompanionVoiceRuntimeOptions = {
  userId?: string;
  sessionId?: string;
  onUserTranscriptFallback: (text: string) => void;
  appendAssistantMessage: (text: string, suppressAssistantResponse: boolean) => void;
  ingestArtifacts: (artifacts: StreamArtifactsPayload, source: 'voice' | 'interrupt') => void;
  onRateLimitError: (payload: {
    message: string;
    remaining?: number;
    estimatedSeconds?: number;
  }) => void;
  sendMessage: (params: { text: string }) => Promise<void>;
  latestAssistantMessage: { id: string; content: string } | null;
  isTyping: boolean;
};

export type UseCompanionRuntimeParams = {
  routeProfile: CompanionRouteProfileId | CompanionRouteProfile;
  chat: UseCompanionChatRuntimeParams;
  stream: UseCompanionStreamContractParams;
  artifacts: UseCompanionArtifactsRuntimeParams;
  voice: UseCompanionVoiceRuntimeOptions;
};