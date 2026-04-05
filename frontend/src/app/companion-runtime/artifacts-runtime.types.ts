import type { RitualArtifacts } from '../types/session';
import type { ArtifactStatusType } from '../components/session';

export type ArtifactStatusState = {
  takeaway: ArtifactStatusType;
  reflection: ArtifactStatusType;
  memories: ArtifactStatusType;
};

export type UseCompanionArtifactsRuntimeParams = {
  sessionId?: string;
  artifacts?: RitualArtifacts | null;
  storeArtifacts: (artifacts: RitualArtifacts, summary?: string) => void;
  updateSession: (updates: { artifacts?: RitualArtifacts; summary?: string }) => void;
};