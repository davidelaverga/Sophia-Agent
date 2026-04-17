import { fireEvent, render, screen } from '@testing-library/react';
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
});