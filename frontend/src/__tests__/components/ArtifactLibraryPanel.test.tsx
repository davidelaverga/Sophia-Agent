import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerPushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import { ArtifactLibraryPanel } from '../../app/components/dashboard/ArtifactLibraryPanel';
import type { ArtifactRegistryRecord } from '../../app/lib/artifact-registry';
import { useSessionStore } from '../../app/stores/session-store';

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
    useSessionStore.setState({ session: null });
    fetchMock().mockReset();
    routerPushMock.mockReset();
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
    const handoff = JSON.parse(window.sessionStorage.getItem('sophia:artifact-library-open:v1') ?? '{}') as {
      artifactId?: string;
      threadId?: string;
      sessionId?: string | null;
      artifactPath?: string;
      rendererKind?: string;
      title?: string;
      filename?: string;
    };
    expect(handoff).toMatchObject({
      artifactId: 'artifact-1',
      threadId: 'thread-1',
      sessionId: 'session-1',
      artifactPath: 'mnt/user-data/outputs/launch.html',
      rendererKind: 'html',
      title: 'Launch Page',
      filename: 'launch.html',
    });
    expect(routerPushMock).toHaveBeenCalledWith('/session');
    expect(useSessionStore.getState().session).toMatchObject({
      sessionId: 'session-1',
      threadId: 'thread-1',
    });
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
