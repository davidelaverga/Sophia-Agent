import { describe, expect, it } from 'vitest';

import { isArtifactRegistryLibraryVisibleCandidate } from '../../app/lib/artifact-registry';

describe('artifact registry library visibility candidates', () => {
  it('keeps requested deliverables visible for backfill', () => {
    expect(isArtifactRegistryLibraryVisibleCandidate({
      localPath: 'mnt/user-data/outputs/durable-registry-smoke-markdown.md',
      title: 'Durable registry smoke markdown',
      artifactType: 'markdown',
      rendererKind: 'markdown',
    })).toBe(true);

    expect(isArtifactRegistryLibraryVisibleCandidate({
      localPath: 'mnt/user-data/outputs/interactive-launch-page.html',
      title: 'Interactive launch page',
      artifactType: 'webpage',
      rendererKind: 'html',
    })).toBe(true);
  });

  it('skips wrapper and support files during local index backfill', () => {
    expect(isArtifactRegistryLibraryVisibleCandidate({
      localPath: 'mnt/user-data/outputs/create-a-real-markdown-artifact-file-nam.html',
      title: 'Durable Artifact Registry Smoke Test - Handoff Wrapper',
      artifactType: 'html',
      rendererKind: 'html',
    })).toBe(false);

    expect(isArtifactRegistryLibraryVisibleCandidate({
      localPath: 'mnt/user-data/outputs/visuals/chart.png',
      title: 'Support chart',
      artifactType: 'image',
      rendererKind: 'image',
    })).toBe(false);
  });
});
