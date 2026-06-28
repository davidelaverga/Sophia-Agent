import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}));

vi.mock('../../../app/components/onboarding', () => ({
  OnboardingTipGuard: () => null,
}));

import { ArtifactsPanel } from '../../../app/components/session/ArtifactsPanel';

describe('ArtifactsPanel builder deliverables', () => {
  it('renders canvas, open, and download actions for the builder primary file', () => {
    const onSelectedBuilderArtifactPathChange = vi.fn();

    render(
      <ArtifactsPanel
        artifacts={null}
        builderArtifact={{
          artifactTitle: 'Sprint brief',
          artifactType: 'document',
          artifactPath: 'mnt/user-data/outputs/sprint-brief.md',
          decisionsMade: [],
          companionSummary: 'The brief is ready to review.',
        }}
        threadId="thread-123"
        onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
      />,
    );

    expect(screen.getByText('Sprint brief')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View sprint-brief.md in canvas' }));
    expect(onSelectedBuilderArtifactPathChange).toHaveBeenCalledWith('mnt/user-data/outputs/sprint-brief.md');
    expect(screen.getByLabelText('Open sprint-brief.md in new tab')).toHaveAttribute(
      'href',
      '/api/threads/thread-123/artifacts/mnt/user-data/outputs/sprint-brief.md',
    );
    expect(screen.getByLabelText('Open sprint-brief.md in new tab')).toHaveAttribute('target', '_blank');
    expect(screen.getByLabelText('Download sprint-brief.md')).toHaveAttribute(
      'href',
      '/api/threads/thread-123/artifacts/mnt/user-data/outputs/sprint-brief.md?download=true',
    );
  });

  it('does not list a deck .preview.pdf as a downloadable row', () => {
    // Regression (prod 019f0b8a): the .preview.pdf is a render-only canvas aid;
    // it must never appear as a second downloadable file alongside the .pptx.
    render(
      <ArtifactsPanel
        artifacts={null}
        builderArtifact={{
          artifactTitle: 'Research deck',
          artifactType: 'presentation',
          artifactPath: 'mnt/user-data/outputs/research_deck.pptx',
          artifactPreviewFilename: 'research_deck.preview.pdf',
          supportingFiles: ['mnt/user-data/outputs/research_deck.preview.pdf'],
          decisionsMade: [],
          companionSummary: 'The deck is ready.',
        }}
        threadId="thread-123"
        onSelectedBuilderArtifactPathChange={vi.fn()}
      />,
    );

    // The .pptx is downloadable…
    expect(screen.getByLabelText('Download research_deck.pptx')).toHaveAttribute(
      'href',
      '/api/threads/thread-123/artifacts/mnt/user-data/outputs/research_deck.pptx?download=true',
    );
    // …the preview PDF is not offered as a download row.
    expect(screen.queryByLabelText('Download research_deck.preview.pdf')).toBeNull();
    expect(screen.queryByText('research_deck.preview.pdf')).toBeNull();
  });
});
