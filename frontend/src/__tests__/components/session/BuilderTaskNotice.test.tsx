import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BuilderTaskNotice } from '../../../app/components/session/BuilderTaskNotice';

describe('BuilderTaskNotice', () => {
  it('renders determinate progress when step counts are available', () => {
    render(
      <BuilderTaskNotice
        task={{
          phase: 'running',
          label: 'drafting launch brief',
          messageIndex: 3,
          totalMessages: 5,
        }}
      />,
    );

    const progressbar = screen.getByRole('progressbar', { name: 'Builder progress' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText('3 of 5 steps')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  it('shows a fully completed progress state when the deliverable is ready', () => {
    render(
      <BuilderTaskNotice
        task={{
          phase: 'completed',
          detail: 'Deliverable ready.',
        }}
      />,
    );

    const progressbar = screen.getByRole('progressbar', { name: 'Builder progress' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('deliverable assembled')).toBeInTheDocument();
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
  });

  it('renders the completion pill state when artifact actions are available', () => {
    const onOpenArtifact = vi.fn();

    render(
      <BuilderTaskNotice
        task={{
          phase: 'completed',
          detail: 'Deliverable ready.',
        }}
        artifactTitle="Launch brief final"
        onOpenArtifact={onOpenArtifact}
        downloadHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true"
      />,
    );

    expect(screen.getByText('deliverable ready')).toBeInTheDocument();
    expect(screen.getByText('Launch brief final')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(onOpenArtifact).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute(
      'href',
      '/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true',
    );
  });
});