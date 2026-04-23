import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BuilderReadyPill } from '../../../app/components/session/BuilderReadyPill';

describe('BuilderReadyPill', () => {
  it('renders the deliverable title and wires open/download actions', () => {
    const onOpen = vi.fn();
    const onDownload = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
    });

    render(
      <BuilderReadyPill
        title="Launch brief final"
        onOpen={onOpen}
        downloadHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true"
        onDownload={onDownload}
        isNew={true}
      />,
    );

    expect(screen.getByText('deliverable complete')).toBeInTheDocument();
    expect(screen.getByText('Launch brief final')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    const downloadLink = screen.getByRole('link', { name: /download/i });
    expect(downloadLink).toHaveAttribute('href', '/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true');
    fireEvent.click(downloadLink);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('keeps the dismiss control visible in compact multi-file mode', () => {
    render(
      <BuilderReadyPill
        title="Smash burger grill cleaning guide"
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
        downloadHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/grill-cleaning-guide.pdf?download=true"
        itemCount={3}
        compact={true}
      />,
    );

    expect(screen.getByRole('button', { name: /dismiss deliverable/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByText('3 files')).toBeInTheDocument();
  });

  it('does not replay the reveal animation for the same download target when only the title changes', () => {
    vi.useFakeTimers();

    const href = '/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true';
    const { container, rerender } = render(
      <BuilderReadyPill
        title="Builder deliverable"
        onOpen={vi.fn()}
        downloadHref={href}
        isNew={true}
      />,
    );

    expect(container.firstChild).toHaveClass('animate-[builder-reveal_360ms_ease-out]');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.firstChild).not.toHaveClass('animate-[builder-reveal_360ms_ease-out]');

    rerender(
      <BuilderReadyPill
        title="Launch brief final"
        onOpen={vi.fn()}
        downloadHref={href}
        isNew={true}
      />,
    );

    expect(container.firstChild).not.toHaveClass('animate-[builder-reveal_360ms_ease-out]');

    vi.useRealTimers();
  });
});