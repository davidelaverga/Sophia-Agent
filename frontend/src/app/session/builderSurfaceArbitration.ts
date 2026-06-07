export type BuilderSurfaceMode =
  | 'active_build_steps'
  | 'artifact_review_room'
  | 'canonical_completed_builder'
  | 'legacy_completion_hidden'
  | 'legacy_completion_fallback';

export type CanonicalBuilderSurface =
  | BuilderSurfaceMode
  | 'secondary_file_library_rows'
  | 'none';

export type BuilderSurfaceArbitrationInput = {
  artifactStageActive: boolean;
  coreviewArtifactUpdateActive?: boolean;
  buildRunning: boolean;
  completedBuilderAvailable: boolean;
  secondaryFileRowsAvailable: boolean;
  legacyCompletionAvailable: boolean;
  selectedBuilderArtifactPathExists: boolean;
};

export type BuilderSurfaceArbitrationResult = {
  builderSurfaceMode: BuilderSurfaceMode | null;
  canonicalBuilderSurface: CanonicalBuilderSurface;
  showActiveBuildSteps: boolean;
  showCanonicalCompletedBuilder: boolean;
  showLegacyCompletionFallback: boolean;
  legacyBuilderSurfaceHidden: boolean;
  builderReadyPillSuppressed: boolean;
  duplicateBuilderSurfaceSuppressed: boolean;
  resumedBuilderSurfaceResolved: boolean;
};

export function resolveBuilderSurface({
  artifactStageActive,
  coreviewArtifactUpdateActive = false,
  buildRunning,
  completedBuilderAvailable,
  secondaryFileRowsAvailable,
  legacyCompletionAvailable,
  selectedBuilderArtifactPathExists,
}: BuilderSurfaceArbitrationInput): BuilderSurfaceArbitrationResult {
  const reviewRoomActive = artifactStageActive || coreviewArtifactUpdateActive;
  const suppressesLegacy = reviewRoomActive
    || buildRunning
    || completedBuilderAvailable
    || secondaryFileRowsAvailable
    || selectedBuilderArtifactPathExists;
  const legacyBuilderSurfaceHidden = legacyCompletionAvailable && suppressesLegacy;
  const builderReadyPillSuppressed = reviewRoomActive
    || completedBuilderAvailable
    || secondaryFileRowsAvailable
    || selectedBuilderArtifactPathExists;
  const duplicateBuilderSurfaceSuppressed = legacyBuilderSurfaceHidden || builderReadyPillSuppressed;
  const resumedBuilderSurfaceResolved = selectedBuilderArtifactPathExists && suppressesLegacy;

  if (reviewRoomActive) {
    return {
      builderSurfaceMode: 'artifact_review_room',
      canonicalBuilderSurface: 'artifact_review_room',
      showActiveBuildSteps: false,
      showCanonicalCompletedBuilder: false,
      showLegacyCompletionFallback: false,
      legacyBuilderSurfaceHidden,
      builderReadyPillSuppressed,
      duplicateBuilderSurfaceSuppressed,
      resumedBuilderSurfaceResolved,
    };
  }

  if (buildRunning) {
    return {
      builderSurfaceMode: 'active_build_steps',
      canonicalBuilderSurface: 'active_build_steps',
      showActiveBuildSteps: true,
      showCanonicalCompletedBuilder: false,
      showLegacyCompletionFallback: false,
      legacyBuilderSurfaceHidden,
      builderReadyPillSuppressed,
      duplicateBuilderSurfaceSuppressed,
      resumedBuilderSurfaceResolved,
    };
  }

  if (completedBuilderAvailable) {
    return {
      builderSurfaceMode: 'canonical_completed_builder',
      canonicalBuilderSurface: 'canonical_completed_builder',
      showActiveBuildSteps: false,
      showCanonicalCompletedBuilder: true,
      showLegacyCompletionFallback: false,
      legacyBuilderSurfaceHidden,
      builderReadyPillSuppressed,
      duplicateBuilderSurfaceSuppressed,
      resumedBuilderSurfaceResolved,
    };
  }

  if (secondaryFileRowsAvailable || selectedBuilderArtifactPathExists) {
    return {
      builderSurfaceMode: legacyCompletionAvailable ? 'legacy_completion_hidden' : null,
      canonicalBuilderSurface: secondaryFileRowsAvailable
        ? 'secondary_file_library_rows'
        : 'canonical_completed_builder',
      showActiveBuildSteps: false,
      showCanonicalCompletedBuilder: false,
      showLegacyCompletionFallback: false,
      legacyBuilderSurfaceHidden,
      builderReadyPillSuppressed,
      duplicateBuilderSurfaceSuppressed,
      resumedBuilderSurfaceResolved,
    };
  }

  if (legacyCompletionAvailable) {
    return {
      builderSurfaceMode: 'legacy_completion_fallback',
      canonicalBuilderSurface: 'legacy_completion_fallback',
      showActiveBuildSteps: false,
      showCanonicalCompletedBuilder: false,
      showLegacyCompletionFallback: true,
      legacyBuilderSurfaceHidden: false,
      builderReadyPillSuppressed: false,
      duplicateBuilderSurfaceSuppressed: false,
      resumedBuilderSurfaceResolved: false,
    };
  }

  return {
    builderSurfaceMode: null,
    canonicalBuilderSurface: 'none',
    showActiveBuildSteps: false,
    showCanonicalCompletedBuilder: false,
    showLegacyCompletionFallback: false,
    legacyBuilderSurfaceHidden: false,
    builderReadyPillSuppressed: false,
    duplicateBuilderSurfaceSuppressed: false,
    resumedBuilderSurfaceResolved: false,
  };
}
