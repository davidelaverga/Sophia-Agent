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

  it('opens an artifact in canvas through the handoff flow', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: /canvas/i }));

    await waitFor(() => {
      expect(fetchMock()).toHaveBeenCalledWith('/api/artifacts/artifact-1/open', expect.objectContaining({
        method: 'POST',
      }));
    });
    expect(window.sessionStorage.getItem('sophia:artifact-library-open:v1')).toContain('artifact-1');
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
