import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactLibraryPanel } from '../../app/components/dashboard/ArtifactLibraryPanel';
import type { ArtifactRegistryRecord } from '../../app/lib/artifact-registry';

const baseArtifact: ArtifactRegistryRecord = {
  artifact_id: 'artifact-1',
  user_id: 'user-1',
  thread_id: 'thread-1',
  session_id: 'session-1',
  parent_thread_id: null,
  task_id: 'task-1',
  run_id: 'run-1',
  trace_id: null,
  logical_artifact_id: 'logical-1',
  version_id: 'logical-1::v1',
  parent_version_id: null,
  title: 'Launch Page',
  filename: 'launch.html',
  artifact_type: 'html',
  renderer_kind: 'html',
  mime_type: 'text/html',
  safe_summary: 'Safe summary',
  source: 'builder',
  local_path: 'mnt/user-data/outputs/launch.html',
  storage_provider: 'local',
  storage_bucket: null,
  storage_object_path: null,
  size_bytes: 1200,
  content_hash: 'hash-not-rendered',
  storage_status: 'available',
  artifact_role: 'primary',
  is_library_visible: true,
  created_at: '2026-06-01T10:00:00+00:00',
  updated_at: '2026-06-02T10:00:00+00:00',
  last_opened_at: null,
  opened_count: 0,
  raw_content_excluded: true,
  signed_url_excluded: true,
  deleted_at: null,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchMock() {
  return vi.mocked(global.fetch);
}

describe('ArtifactLibraryPanel', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    fetchMock().mockReset();
  });

  it('renders dashboard artifacts from the registry', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ artifacts: [baseArtifact], total: 1 }));

    render(<ArtifactLibraryPanel />);

    expect(await screen.findByText('Launch Page')).toBeInTheDocument();
    const row = screen.getByTestId('artifact-library-row');
    expect(screen.getByTestId('artifact-library-count')).toHaveTextContent('1 total');
    expect(within(row).getByText('launch.html')).toBeInTheDocument();
    expect(within(row).getByText('HTML')).toBeInTheDocument();
    expect(within(row).getByText('Builder')).toBeInTheDocument();
  });

  it('renders one dashboard row for duplicate builder and backfill records', async () => {
    const backfillArtifact: ArtifactRegistryRecord = {
      ...baseArtifact,
      artifact_id: 'artifact-backfill',
      logical_artifact_id: 'logical-backfill',
      version_id: 'logical-backfill::v1',
      source: 'file_library_backfill',
      updated_at: '2026-06-03T10:00:00+00:00',
    };
    fetchMock().mockResolvedValueOnce(jsonResponse({
      artifacts: [backfillArtifact, baseArtifact],
      total: 2,
    }));

    render(<ArtifactLibraryPanel />);

    expect(await screen.findByText('Launch Page')).toBeInTheDocument();
    const row = screen.getByTestId('artifact-library-row');
    expect(screen.getAllByTestId('artifact-library-row')).toHaveLength(1);
    expect(screen.getByTestId('artifact-library-count')).toHaveTextContent('1 total');
    expect(within(row).getByText('Builder')).toBeInTheDocument();
    expect(within(row).queryByText('Backfill')).not.toBeInTheDocument();
  });

  it('does not render wrapper records leaked by an old registry response', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({
      artifacts: [
        {
          ...baseArtifact,
          artifact_id: 'artifact-wrapper',
          title: 'Durable Artifact Registry Smoke Test - Handoff Wrapper',
          filename: 'create-a-real-markdown-artifact-file-nam.html',
          local_path: 'mnt/user-data/outputs/create-a-real-markdown-artifact-file-nam.html',
          source: 'backfill',
          artifact_role: 'primary',
          is_library_visible: true,
        },
        baseArtifact,
      ],
      total: 2,
    }));

    render(<ArtifactLibraryPanel />);

    expect(await screen.findByText('Launch Page')).toBeInTheDocument();
    expect(screen.queryByText('Durable Artifact Registry Smoke Test - Handoff Wrapper')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('artifact-library-row')).toHaveLength(1);
  });

  it('updates query filters and search', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ artifacts: [], total: 0 }));
    const user = userEvent.setup();

    render(<ArtifactLibraryPanel />);

    await waitFor(() => {
      expect(fetchMock()).toHaveBeenCalledWith('/api/artifacts?sort=updated', expect.any(Object));
    });

    await user.selectOptions(screen.getByLabelText('Type'), 'pdf');
    await waitFor(() => {
      expect(fetchMock()).toHaveBeenLastCalledWith('/api/artifacts?artifact_type=pdf&sort=updated', expect.any(Object));
    });

    fireEvent.change(screen.getByLabelText('Search artifacts'), { target: { value: 'finance' } });
    await waitFor(() => {
      expect(fetchMock()).toHaveBeenLastCalledWith(
        '/api/artifacts?artifact_type=pdf&search=finance&sort=updated',
        expect.any(Object),
      );
    });
  });

  it('opens an artifact inline without navigating to session', async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ artifacts: [baseArtifact], total: 1 }))
      .mockResolvedValueOnce(jsonResponse({
        artifact: baseArtifact,
        canvas_target: {
          artifact_id: baseArtifact.artifact_id,
          thread_id: baseArtifact.thread_id,
          session_id: baseArtifact.session_id,
          artifact_path: baseArtifact.local_path,
          renderer_kind: baseArtifact.renderer_kind,
          mime_type: baseArtifact.mime_type,
          title: baseArtifact.title,
          review_room_supported: true,
        },
      }));

    render(<ArtifactLibraryPanel />);

    await screen.findByText('Launch Page');
    await userEvent.click(screen.getByRole('button', { name: /open launch page inline/i }));

    await waitFor(() => {
      expect(fetchMock()).toHaveBeenCalledWith('/api/artifacts/artifact-1/open', expect.objectContaining({
        method: 'POST',
      }));
    });
    const detail = await screen.findByTestId('artifact-library-detail');
    expect(detail).toHaveTextContent('Launch Page');
    expect(detail).toHaveTextContent('launch.html');
    expect(screen.getByTestId('artifact-library-html-preview')).toHaveAttribute(
      'src',
      '/api/artifacts/artifact-1/content',
    );
    expect(window.sessionStorage.getItem('sophia:artifact-library-open:v1')).toBeNull();
  });

  it('does not render session handoff actions from the artifact library', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ artifacts: [baseArtifact], total: 1 }));

    render(<ArtifactLibraryPanel />);

    await screen.findByText('Launch Page');
    expect(screen.queryByRole('button', { name: /session canvas/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Session$/u)).not.toBeInTheDocument();
    expect(screen.queryByText('Session Canvas')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('sophia:artifact-library-open:v1')).toBeNull();
  });

  it('loads markdown previews through the artifact id content endpoint', async () => {
    const markdownArtifact: ArtifactRegistryRecord = {
      ...baseArtifact,
      artifact_id: 'artifact-markdown',
      title: 'Research Notes',
      filename: 'research-notes.md',
      artifact_type: 'markdown',
      renderer_kind: 'markdown',
      mime_type: 'text/markdown',
      local_path: 'mnt/user-data/outputs/research-notes.md',
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ artifacts: [markdownArtifact], total: 1 }))
      .mockResolvedValueOnce(jsonResponse({
        artifact: markdownArtifact,
        canvas_target: {
          artifact_id: markdownArtifact.artifact_id,
          thread_id: markdownArtifact.thread_id,
          session_id: markdownArtifact.session_id,
          artifact_path: markdownArtifact.local_path,
          renderer_kind: markdownArtifact.renderer_kind,
          mime_type: markdownArtifact.mime_type,
          title: markdownArtifact.title,
          review_room_supported: true,
        },
      }))
      .mockResolvedValueOnce(new Response('# Research Notes\n\nA safe preview.', {
        status: 200,
        headers: { 'Content-Type': 'text/markdown' },
      }));

    render(<ArtifactLibraryPanel />);

    await screen.findByText('Research Notes');
    await userEvent.click(screen.getByRole('button', { name: /open research notes inline/i }));

    await waitFor(() => {
      expect(fetchMock()).toHaveBeenCalledWith('/api/artifacts/artifact-markdown/content', expect.objectContaining({
        cache: 'no-store',
      }));
    });
    expect(await screen.findByTestId('artifact-library-markdown-preview')).toHaveTextContent('A safe preview.');
  });

  it('fails markdown preview safely when artifact content is unavailable', async () => {
    const markdownArtifact: ArtifactRegistryRecord = {
      ...baseArtifact,
      artifact_id: 'artifact-missing',
      title: 'Missing Notes',
      filename: 'missing-notes.md',
      artifact_type: 'markdown',
      renderer_kind: 'markdown',
      mime_type: 'text/markdown',
      local_path: 'mnt/user-data/outputs/missing-notes.md',
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ artifacts: [markdownArtifact], total: 1 }))
      .mockResolvedValueOnce(jsonResponse({
        artifact: markdownArtifact,
        canvas_target: {
          artifact_id: markdownArtifact.artifact_id,
          thread_id: markdownArtifact.thread_id,
          session_id: markdownArtifact.session_id,
          artifact_path: markdownArtifact.local_path,
          renderer_kind: markdownArtifact.renderer_kind,
          mime_type: markdownArtifact.mime_type,
          title: markdownArtifact.title,
          review_room_supported: true,
        },
      }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    render(<ArtifactLibraryPanel />);

    await screen.findByText('Missing Notes');
    await userEvent.click(screen.getByRole('button', { name: /open missing notes inline/i }));

    expect(await screen.findByTestId('artifact-library-preview-unavailable')).toHaveTextContent('Unable to load preview');
  });

  it('uses the artifact id endpoint for downloads', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ artifacts: [baseArtifact], total: 1 }));

    render(<ArtifactLibraryPanel />);

    await screen.findByText('Launch Page');
    expect(screen.getByRole('link', { name: /download launch page/i })).toHaveAttribute(
      'href',
      '/api/artifacts/artifact-1/download',
    );
  });

  it('deletes an artifact after confirmation and removes the row', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ artifacts: [baseArtifact], total: 1 }))
      .mockResolvedValueOnce(jsonResponse({
        artifact: {
          ...baseArtifact,
          is_library_visible: false,
          deleted_at: '2026-06-04T10:00:00+00:00',
        },
        canvas_target: {
          artifact_id: baseArtifact.artifact_id,
          thread_id: baseArtifact.thread_id,
          session_id: baseArtifact.session_id,
          artifact_path: baseArtifact.local_path,
          renderer_kind: baseArtifact.renderer_kind,
          mime_type: baseArtifact.mime_type,
          title: baseArtifact.title,
          review_room_supported: true,
        },
      }));

    render(<ArtifactLibraryPanel />);

    await screen.findByText('Launch Page');
    await userEvent.click(screen.getByRole('button', { name: /delete launch page/i }));

    await waitFor(() => {
      expect(fetchMock()).toHaveBeenCalledWith('/api/artifacts/artifact-1', expect.objectContaining({
        method: 'DELETE',
      }));
    });
    expect(confirmSpy).toHaveBeenCalledWith('Hide "Launch Page" from the artifact dashboard?');
    await waitFor(() => {
      expect(screen.queryByText('Launch Page')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('artifact-library-empty')).toHaveTextContent('No artifacts yet');

    fetchMock().mockResolvedValueOnce(jsonResponse({ artifacts: [], total: 0 }));
    await userEvent.click(screen.getByRole('button', { name: /refresh artifacts/i }));
    await waitFor(() => {
      expect(screen.getByTestId('artifact-library-empty')).toHaveTextContent('No artifacts yet');
    });
  });

  it('renders a polished empty state', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ artifacts: [], total: 0 }));

    render(<ArtifactLibraryPanel />);

    expect(await screen.findByTestId('artifact-library-empty')).toHaveTextContent('No artifacts yet');
  });

  it('does not render raw content, hashes, signed URLs, or local paths', async () => {
    const artifactWithUnsafeExtras = {
      ...baseArtifact,
      raw_content: '<main>private</main>',
      signed_url: 'https://signed.example/private',
    };
    fetchMock().mockResolvedValueOnce(jsonResponse({
      artifacts: [artifactWithUnsafeExtras],
      total: 1,
    }));

    render(<ArtifactLibraryPanel />);

    const panel = await screen.findByTestId('artifact-library-panel');
    expect(panel.textContent).toContain('Launch Page');
    expect(panel.textContent).not.toContain('<main>');
    expect(panel.textContent).not.toContain('signed.example');
    expect(panel.textContent).not.toContain('hash-not-rendered');
    expect(panel.textContent).not.toContain('mnt/user-data/outputs');
  });
});
