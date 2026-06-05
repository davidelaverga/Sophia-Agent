export type BuilderSurfaceMode =
  | 'active_build_steps'
  | 'artifact_review_room'
  | 'completed_artifact_entry'
  | 'legacy_completion_hidden'
  | 'legacy_completion_fallback';

export type CanonicalBuilderSurface =
  | BuilderSurfaceMode
  | 'secondary_file_library_rows'
  | 'none';

export type BuilderSurfaceArbitrationInput = {
  artifactStageActive: boolean;
  buildRunning: boolean;
  completedArtifactEntryAvailable: boolean;
  secondaryFileRowsAvailable: boolean;
  legacyCompletionAvailable: boolean;
  selectedBuilderArtifactPathExists: boolean;
};

export type BuilderSurfaceArbitrationResult = {
  builderSurfaceMode: BuilderSurfaceMode | null;
  canonicalBuilderSurface: CanonicalBuilderSurface;
  showActiveBuildSteps: boolean;
  showCompletedArtifactEntry: boolean;
  showLegacyCompletionFallback: boolean;
  legacyBuilderSurfaceHidden: boolean;
  duplicateBuilderSurfaceSuppressed: boolean;
  resumedBuilderSurfaceResolved: boolean;
};

export function resolveBuilderSurface({
  artifactStageActive,
  buildRunning,
  completedArtifactEntryAvailable,
  secondaryFileRowsAvailable,
  legacyCompletionAvailable,
  selectedBuilderArtifactPathExists,
}: BuilderSurfaceArbitrationInput): BuilderSurfaceArbitrationResult {
  const suppressesLegacy = artifactStageActive
    || buildRunning
    || completedArtifactEntryAvailable
    || secondaryFileRowsAvailable
    || selectedBuilderArtifactPathExists;
  const legacyBuilderSurfaceHidden = legacyCompletionAvailable && suppressesLegacy;
  const duplicateBuilderSurfaceSuppressed = legacyBuilderSurfaceHidden;
  const resumedBuilderSurfaceResolved = selectedBuilderArtifactPathExists && suppressesLegacy;

  if (artifactStageActive) {
    return {
      builderSurfaceMode: 'artifact_review_room',
      canonicalBuilderSurface: 'artifact_review_room',
      showActiveBuildSteps: false,
      showCompletedArtifactEntry: false,
      showLegacyCompletionFallback: false,
      legacyBuilderSurfaceHidden,
      duplicateBuilderSurfaceSuppressed,
      resumedBuilderSurfaceResolved,
    };
  }

  if (buildRunning) {
    return {
      builderSurfaceMode: 'active_build_steps',
      canonicalBuilderSurface: 'active_build_steps',
      showActiveBuildSteps: true,
      showCompletedArtifactEntry: false,
      showLegacyCompletionFallback: false,
      legacyBuilderSurfaceHidden,
      duplicateBuilderSurfaceSuppressed,
      resumedBuilderSurfaceResolved,
    };
  }

  if (completedArtifactEntryAvailable) {
    return {
      builderSurfaceMode: 'completed_artifact_entry',
      canonicalBuilderSurface: 'completed_artifact_entry',
      showActiveBuildSteps: false,
      showCompletedArtifactEntry: true,
      showLegacyCompletionFallback: false,
      legacyBuilderSurfaceHidden,
      duplicateBuilderSurfaceSuppressed,
      resumedBuilderSurfaceResolved,
    };
  }

  if (secondaryFileRowsAvailable || selectedBuilderArtifactPathExists) {
    return {
      builderSurfaceMode: legacyCompletionAvailable ? 'legacy_completion_hidden' : null,
      canonicalBuilderSurface: secondaryFileRowsAvailable
        ? 'secondary_file_library_rows'
        : 'completed_artifact_entry',
      showActiveBuildSteps: false,
      showCompletedArtifactEntry: false,
      showLegacyCompletionFallback: false,
      legacyBuilderSurfaceHidden,
      duplicateBuilderSurfaceSuppressed,
      resumedBuilderSurfaceResolved,
    };
  }

  if (legacyCompletionAvailable) {
    return {
      builderSurfaceMode: 'legacy_completion_fallback',
      canonicalBuilderSurface: 'legacy_completion_fallback',
      showActiveBuildSteps: false,
      showCompletedArtifactEntry: false,
      showLegacyCompletionFallback: true,
      legacyBuilderSurfaceHidden: false,
      duplicateBuilderSurfaceSuppressed: false,
      resumedBuilderSurfaceResolved: false,
    };
  }

  return {
    builderSurfaceMode: null,
    canonicalBuilderSurface: 'none',
    showActiveBuildSteps: false,
    showCompletedArtifactEntry: false,
    showLegacyCompletionFallback: false,
    legacyBuilderSurfaceHidden: false,
    duplicateBuilderSurfaceSuppressed: false,
    resumedBuilderSurfaceResolved: false,
  };
}
