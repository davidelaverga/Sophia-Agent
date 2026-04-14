import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}));

vi.mock('../../../app/components/onboarding', () => ({
  OnboardingTipGuard: () => null,
}));

import { ArtifactsPanel } from '../../../app/components/session/ArtifactsPanel';

describe('ArtifactsPanel builder deliverables', () => {
  it('renders download links for the builder primary file', () => {
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
      />,
    );

    expect(screen.getByText('Sprint brief')).toBeInTheDocument();
    expect(screen.getByLabelText('Download sprint-brief.md')).toHaveAttribute(
      'href',
      '/api/threads/thread-123/artifacts/mnt/user-data/outputs/sprint-brief.md?download=true',
    );
  });
});