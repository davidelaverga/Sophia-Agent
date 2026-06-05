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

  it('shows a completed green state without a completed progress bar', () => {
    render(
      <BuilderTaskNotice
        task={{
          phase: 'completed',
          detail: 'Deliverable ready.',
        }}
      />,
    );

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Deliverable ready.')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Builder progress' })).not.toBeInTheDocument();
    expect(screen.queryByText('Build complete')).not.toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });

  it('does not fabricate a percentage for a canvas-streamed running seed', () => {
    render(
      <BuilderTaskNotice
        task={{
          phase: 'running',
          canvasStreamed: true,
          detail: 'Researching sources',
          activityLog: [{ type: 'thinking', title: 'Researching sources', status: 'done' }],
        }}
      />,
    );

    expect(screen.queryByRole('progressbar', { name: 'Builder progress' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Researching sources').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show builder activity' }));
    expect(screen.getAllByText('Researching sources').length).toBeGreaterThan(0);
  });

  it('uses distinct canvas phase labels and collapses duplicate activity rows', () => {
    render(
      <BuilderTaskNotice
        task={{
          phase: 'running',
          canvasStreamed: true,
          detail: 'Creating artifact',
          activityLog: [
            { type: 'tool_call', title: 'Searching web', action: 'searching_web', status: 'done' },
            { type: 'tool_call', title: 'Writing file', action: 'writing_file', status: 'done' },
            { type: 'tool_call', title: 'Writing file', action: 'writing_file', status: 'done' },
            { type: 'tool_call', title: 'Running check', action: 'running_check', status: 'done' },
          ],
        }}
      />,
    );

    expect(screen.getByText('Creating artifact')).toBeInTheDocument();
    expect(screen.getByText('Searching web')).toBeInTheDocument();
    expect(screen.getByText('Writing file')).toBeInTheDocument();
    expect(screen.getByText('x2')).toBeInTheDocument();
    expect(screen.getByText('Running check')).toBeInTheDocument();
  });

  it('renders canonical completed artifact actions when artifact actions are available', () => {
    const onOpenArtifact = vi.fn();
    const onDownload = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
    });

    render(
      <BuilderTaskNotice
        task={{
          phase: 'completed',
          detail: 'Deliverable ready.',
        }}
        artifactTitle="Launch brief final"
        onOpenArtifact={onOpenArtifact}
        openHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md"
        downloadHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true"
        onDownload={onDownload}
      />,
    );

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Launch brief final')).toBeInTheDocument();
    expect(screen.getByText('Ready to review in canvas.')).toBeInTheDocument();
    expect(screen.queryByText('Deliverable ready.')).not.toBeInTheDocument();
    expect(screen.queryByText('Build complete')).not.toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Builder progress' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /view launch brief final in canvas/i }));
    expect(onOpenArtifact).toHaveBeenCalledTimes(1);

    const openLinks = screen.getAllByRole('link', { name: /open launch brief final in new tab/i });
    expect(openLinks).toHaveLength(1);
    expect(openLinks[0]).toHaveAttribute(
      'href',
      '/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md',
    );

    const downloadLinks = screen.getAllByRole('link', { name: /download launch brief final/i });
    expect(downloadLinks).toHaveLength(1);
    expect(downloadLinks[0]).toHaveAttribute(
      'href',
      '/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true',
    );
    fireEvent.click(downloadLinks[0]);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: /view launch brief final in canvas/i })).toHaveLength(1);
  });

  it('keeps fallback truth copy in the canonical completed state', () => {
    render(
      <BuilderTaskNotice
        task={{
          phase: 'completed',
          detail: 'I couldn’t finish the PowerPoint package, so I delivered a browser-viewable HTML fallback.',
        }}
        artifactTitle="Deck fallback"
        fallbackLabel="html fallback"
        onOpenArtifact={vi.fn()}
        openHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/deck.html"
        downloadHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/deck.html?download=true"
      />,
    );

    expect(screen.getByText('html fallback')).toBeInTheDocument();
    expect(screen.getByText('I couldn’t finish the PowerPoint package, so I delivered a browser-viewable HTML fallback.')).toBeInTheDocument();
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

    expect(screen.getByText('Stalled')).toBeInTheDocument();
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

      expect(screen.getByText('Stalled')).toBeInTheDocument();
      expect(screen.getAllByText(/No visible builder progress for 2m/i).length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
