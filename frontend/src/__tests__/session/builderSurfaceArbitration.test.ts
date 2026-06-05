import { describe, expect, it } from 'vitest';

import { resolveBuilderSurface } from '../../app/session/builderSurfaceArbitration';

const baseInput = {
  artifactStageActive: false,
  buildRunning: false,
  completedArtifactEntryAvailable: false,
  secondaryFileRowsAvailable: false,
  legacyCompletionAvailable: false,
  selectedBuilderArtifactPathExists: false,
};

describe('resolveBuilderSurface', () => {
  it('prioritizes active step-based build progress over stale completion UI', () => {
    const surface = resolveBuilderSurface({
      ...baseInput,
      buildRunning: true,
      legacyCompletionAvailable: true,
    });

    expect(surface.builderSurfaceMode).toBe('active_build_steps');
    expect(surface.canonicalBuilderSurface).toBe('active_build_steps');
    expect(surface.showActiveBuildSteps).toBe(true);
    expect(surface.showLegacyCompletionFallback).toBe(false);
    expect(surface.legacyBuilderSurfaceHidden).toBe(true);
    expect(surface.duplicateBuilderSurfaceSuppressed).toBe(true);
  });

  it('uses the compact completed artifact entry instead of the old completion card', () => {
    const surface = resolveBuilderSurface({
      ...baseInput,
      completedArtifactEntryAvailable: true,
      legacyCompletionAvailable: true,
    });

    expect(surface.builderSurfaceMode).toBe('completed_artifact_entry');
    expect(surface.showCompletedArtifactEntry).toBe(true);
    expect(surface.showLegacyCompletionFallback).toBe(false);
    expect(surface.legacyBuilderSurfaceHidden).toBe(true);
  });

  it('hides old completion surfaces while ArtifactStage is active', () => {
    const surface = resolveBuilderSurface({
      ...baseInput,
      artifactStageActive: true,
      completedArtifactEntryAvailable: true,
      legacyCompletionAvailable: true,
    });

    expect(surface.builderSurfaceMode).toBe('artifact_review_room');
    expect(surface.canonicalBuilderSurface).toBe('artifact_review_room');
    expect(surface.showCompletedArtifactEntry).toBe(false);
    expect(surface.showLegacyCompletionFallback).toBe(false);
    expect(surface.duplicateBuilderSurfaceSuppressed).toBe(true);
  });

  it('resolves resumed selected artifacts without resurrecting the old card', () => {
    const surface = resolveBuilderSurface({
      ...baseInput,
      selectedBuilderArtifactPathExists: true,
      legacyCompletionAvailable: true,
    });

    expect(surface.builderSurfaceMode).toBe('legacy_completion_hidden');
    expect(surface.canonicalBuilderSurface).toBe('completed_artifact_entry');
    expect(surface.showLegacyCompletionFallback).toBe(false);
    expect(surface.resumedBuilderSurfaceResolved).toBe(true);
  });

  it('falls back to the legacy completion card only when no canonical surface exists', () => {
    const surface = resolveBuilderSurface({
      ...baseInput,
      legacyCompletionAvailable: true,
    });

    expect(surface.builderSurfaceMode).toBe('legacy_completion_fallback');
    expect(surface.canonicalBuilderSurface).toBe('legacy_completion_fallback');
    expect(surface.showLegacyCompletionFallback).toBe(true);
    expect(surface.legacyBuilderSurfaceHidden).toBe(false);
  });
});
