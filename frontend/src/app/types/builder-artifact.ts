export type BuilderArtifactType =
  | 'presentation'
  | 'document'
  | 'webpage'
  | 'research_report'
  | 'visual_report'
  | 'code'
  | 'data_analysis'
  | 'unknown'
  | (string & {});

export interface BuilderArtifactV1 {
  artifactPath?: string;
  artifactType: BuilderArtifactType;
  artifactTitle: string;
  supportingFiles?: string[];
  stepsCompleted?: number;
  decisionsMade: string[];
  sourcesUsed?: string[];
  companionSummary?: string;
  companionToneHint?: string;
  userNextAction?: string;
  confidence?: number;
}

export interface BuilderArtifactFileV1 {
  path: string;
  name: string;
  label: string;
  isPrimary: boolean;
}

export interface BuilderArtifactLibraryItemV1 {
  path: string;
  name: string;
  sizeBytes?: number;
  mimeType?: string;
  modifiedAt?: string;
}