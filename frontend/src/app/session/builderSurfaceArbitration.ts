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

type BuilderSurfaceSharedFlags = Pick<
  BuilderSurfaceArbitrationResult,
  | 'legacyBuilderSurfaceHidden'
  | 'builderReadyPillSuppressed'
  | 'duplicateBuilderSurfaceSuppressed'
  | 'resumedBuilderSurfaceResolved'
>;

function computeBuilderSurfaceSharedFlags(
  input: BuilderSurfaceArbitrationInput,
  reviewRoomActive: boolean,
): BuilderSurfaceSharedFlags {
  const suppressesLegacy = reviewRoomActive
    || input.buildRunning
    || input.completedBuilderAvailable
    || input.secondaryFileRowsAvailable
    || input.selectedBuilderArtifactPathExists;
  const legacyBuilderSurfaceHidden = input.legacyCompletionAvailable && suppressesLegacy;
  const builderReadyPillSuppressed = reviewRoomActive
    || input.completedBuilderAvailable
    || input.secondaryFileRowsAvailable
    || input.selectedBuilderArtifactPathExists;
  return {
    legacyBuilderSurfaceHidden,
    builderReadyPillSuppressed,
    duplicateBuilderSurfaceSuppressed: legacyBuilderSurfaceHidden || builderReadyPillSuppressed,
    resumedBuilderSurfaceResolved: input.selectedBuilderArtifactPathExists && suppressesLegacy,
  };
}

function builderSurfaceResult(
  builderSurfaceMode: BuilderSurfaceMode | null,
  canonicalBuilderSurface: CanonicalBuilderSurface,
  sharedFlags: BuilderSurfaceSharedFlags,
): BuilderSurfaceArbitrationResult {
  return {
    builderSurfaceMode,
    canonicalBuilderSurface,
    showActiveBuildSteps: builderSurfaceMode === 'active_build_steps',
    showCanonicalCompletedBuilder: builderSurfaceMode === 'canonical_completed_builder',
    showLegacyCompletionFallback: builderSurfaceMode === 'legacy_completion_fallback',
    ...sharedFlags,
  };
}

export function resolveBuilderSurface(input: BuilderSurfaceArbitrationInput): BuilderSurfaceArbitrationResult {
  const reviewRoomActive = input.artifactStageActive || (input.coreviewArtifactUpdateActive ?? false);
  const flags = computeBuilderSurfaceSharedFlags(input, reviewRoomActive);

  if (reviewRoomActive) {
    return builderSurfaceResult('artifact_review_room', 'artifact_review_room', flags);
  }
  if (input.buildRunning) {
    return builderSurfaceResult('active_build_steps', 'active_build_steps', flags);
  }
  if (input.completedBuilderAvailable) {
    return builderSurfaceResult('canonical_completed_builder', 'canonical_completed_builder', flags);
  }
  if (input.secondaryFileRowsAvailable || input.selectedBuilderArtifactPathExists) {
    return builderSurfaceResult(
      input.legacyCompletionAvailable ? 'legacy_completion_hidden' : null,
      input.secondaryFileRowsAvailable ? 'secondary_file_library_rows' : 'canonical_completed_builder',
      flags,
    );
  }
  if (input.legacyCompletionAvailable) {
    return builderSurfaceResult('legacy_completion_fallback', 'legacy_completion_fallback', flags);
  }
  return builderSurfaceResult(null, 'none', flags);
}
