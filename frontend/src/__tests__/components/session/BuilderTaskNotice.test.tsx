import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BuilderTaskNotice } from '../../../app/components/session/BuilderTaskNotice';

describe('BuilderTaskNotice', () => {
  it('renders determinate progress when step counts are available', () => {
    render(
      <BuilderTaskNotice
        task={{
          phase: 'running',
          label: 'drafting launch brief',
          progressPercent: 50,
          totalSteps: 4,
          completedSteps: 2,
          inProgressSteps: 1,
          activeStepTitle: 'Refine recommendation',
          todos: [
            { id: 1, title: 'Collect notes', status: 'completed' },
            { id: 2, title: 'Shape outline', status: 'completed' },
            { id: 3, title: 'Refine recommendation', status: 'in-progress' },
          ],
        }}
      />,
    );

    const progressbar = screen.getByRole('progressbar', { name: 'Builder progress' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('2 of 4 steps | 1 active')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('active: Refine recommendation')).toBeInTheDocument();
    expect(screen.getAllByText('Refine recommendation').length).toBeGreaterThan(0);
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

  it('surfaces a stalled builder state explicitly', () => {
    render(
      <BuilderTaskNotice
        task={{
          phase: 'running',
          progressPercent: 25,
          totalSteps: 4,
          completedSteps: 1,
          stuck: true,
          stuckReason: 'No visible builder progress for 2m 40s. It may be blocked on a tool or looping without advancing the deliverable.',
          idleMs: 160000,
        }}
      />,
    );

    expect(screen.getByText('stalled')).toBeInTheDocument();
    expect(screen.getAllByText(/No visible builder progress for 2m 40s/i).length).toBeGreaterThan(0);
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('infers a stalled builder from stale timestamps even before a new payload arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T04:43:54.399Z'));

    try {
      render(
        <BuilderTaskNotice
          task={{
            phase: 'running',
            label: 'Builder: one-page brief',
            progressSource: 'none',
            startedAt: '2026-04-15T04:43:30.559766Z',
            lastUpdateAt: '2026-04-15T04:43:32.866153Z',
            lastProgressAt: '2026-04-15T04:43:32.864136Z',
            heartbeatMs: 21209,
            idleMs: 21211,
            stuck: false,
          }}
        />,
      );

      act(() => {
        vi.advanceTimersByTime(150_000);
      });

      expect(screen.getByText('stalled')).toBeInTheDocument();
      expect(screen.getAllByText(/No visible builder progress for 2m/i).length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});