import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BuilderReadyPill } from '../../../app/components/session/BuilderReadyPill';

describe('BuilderReadyPill', () => {
  it('renders the deliverable title and keeps view/open/download actions separated', () => {
    const onOpen = vi.fn();
    const onDownload = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
    });

    const { container } = render(
      <BuilderReadyPill
        title="Launch brief final"
        onOpen={onOpen}
        openHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md"
        downloadHref="/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true"
        onDownload={onDownload}
        isNew={true}
      />,
    );

    expect(screen.getByText('Build complete')).toBeInTheDocument();
    expect(screen.getByText('Launch brief final')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /view launch brief final in canvas/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    const openLink = screen.getByRole('link', { name: /open launch brief final in new tab/i });
    expect(openLink).toHaveAttribute('href', '/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md');
    expect(openLink).toHaveAttribute('target', '_blank');

    const downloadLink = screen.getByRole('link', { name: /download/i });
    expect(downloadLink).toHaveAttribute('href', '/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true');
    fireEvent.click(downloadLink);
    expect(onDownload).toHaveBeenCalledTimes(1);

    expect(container).not.toHaveTextContent(/Coreview|transport|websocket|fixture|runtime ingest|selected stage/i);
  });
});
