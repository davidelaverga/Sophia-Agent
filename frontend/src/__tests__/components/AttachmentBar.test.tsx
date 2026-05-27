/**
 * AttachmentBar — regression tests for the file-pick gates.
 *
 * Focused on behavior that's load-bearing for the security /
 * correctness story:
 *
 * 1. Per-turn cap is enforced at file-pick time (Codex P2 PR #132)
 *    so attached_files truncation server-side doesn't silently
 *    swallow files the user thinks were uploaded.
 *
 * 2. Items added during a selection carry the bar's ``threadId``
 *    prop so cross-thread leakage is impossible.
 *
 * Tests interact with the bar via DOM events (file input change)
 * and observe the store directly — that keeps the assertion surface
 * close to user-visible behavior without depending on the chip CSS.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentBar } from '../../app/components/chat/AttachmentBar';
import { MAX_ATTACHED_FILES_PER_TURN } from '../../app/lib/chat-constants';
import { useAttachmentsStore } from '../../app/stores/attachments-store';

function makeFile(name: string, sizeBytes = 1024, type = 'image/png'): File {
  const blob = new Blob([new Uint8Array(sizeBytes)], { type });
  return new File([blob], name, { type });
}

function dispatchFilesOnto(input: HTMLInputElement, files: File[]) {
  // jsdom doesn't ship a real DataTransfer; build a FileList-like
  // structure that satisfies the array iteration the bar uses
  // (``Array.from(filesList)`` + ``.length`` check + ``.value = ""``
  // reset). React's onChange handler reads ``event.target.files``,
  // so the property has to be set on the input element itself.
  const fileList: FileList = Object.assign(files, {
    item: (index: number) => files[index] ?? null,
  }) as unknown as FileList;
  Object.defineProperty(input, 'files', {
    value: fileList,
    writable: true,
    configurable: true,
  });
  fireEvent.change(input);
}

describe('AttachmentBar — Codex P2 per-turn cap', () => {
  beforeEach(() => {
    useAttachmentsStore.getState().clear();
  });

  it('marks files over MAX_ATTACHED_FILES_PER_TURN as errored at selection time', () => {
    render(<AttachmentBar threadId="thread-A" />);
    const input = screen.getByTestId('attachment-bar-file-input') as HTMLInputElement;

    // Pick one MORE than the cap in a single selection.
    const tooMany = Array.from({ length: MAX_ATTACHED_FILES_PER_TURN + 3 }, (_, i) =>
      makeFile(`file${i}.png`, 1024)
    );
    dispatchFilesOnto(input, tooMany);

    const items = useAttachmentsStore.getState().items;
    const accepted = items.filter((item) => item.status !== 'error');
    const rejected = items.filter((item) => item.status === 'error');

    expect(accepted).toHaveLength(MAX_ATTACHED_FILES_PER_TURN);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect(r.error).toMatch(/Max 12 attachments per message/i);
    }
  });

  it('counts already-present non-error chips against the cap across selections', () => {
    // Pre-seed the store as if a previous selection had filled most of
    // the quota — 10 items, all status="uploaded", on thread-A.
    for (let i = 0; i < 10; i += 1) {
      useAttachmentsStore.getState().add({
        clientId: `pre-${i}`,
        filename: `seeded${i}.png`,
        size: 1024,
        status: 'uploaded',
        hasMarkdownConversion: false,
        threadId: 'thread-A',
      });
    }

    render(<AttachmentBar threadId="thread-A" />);
    const input = screen.getByTestId('attachment-bar-file-input') as HTMLInputElement;

    // Pick 5 more — only 2 slots remain (12 - 10).
    const newFiles = Array.from({ length: 5 }, (_, i) =>
      makeFile(`new${i}.png`, 1024)
    );
    dispatchFilesOnto(input, newFiles);

    const items = useAttachmentsStore.getState().items;
    // Total 10 pre + 5 new = 15 chips, but only first 2 of the new
    // batch should be eligible (uploading), the remaining 3 errored.
    expect(items).toHaveLength(15);
    const newOnes = items.filter((item) => item.filename.startsWith('new'));
    const newAccepted = newOnes.filter((item) => item.status !== 'error');
    const newRejected = newOnes.filter((item) => item.status === 'error');
    expect(newAccepted).toHaveLength(2);
    expect(newRejected).toHaveLength(3);
  });

  it('does NOT count items from OTHER threads against this thread\'s cap', () => {
    // Pre-seed 12 items on thread-B — they should not consume the
    // quota for thread-A.
    for (let i = 0; i < MAX_ATTACHED_FILES_PER_TURN; i += 1) {
      useAttachmentsStore.getState().add({
        clientId: `B-${i}`,
        filename: `other${i}.png`,
        size: 1024,
        status: 'uploaded',
        hasMarkdownConversion: false,
        threadId: 'thread-B',
      });
    }

    render(<AttachmentBar threadId="thread-A" />);
    const input = screen.getByTestId('attachment-bar-file-input') as HTMLInputElement;

    // Picking 3 files on thread-A should ALL be accepted.
    const newFiles = [makeFile('a.png'), makeFile('b.png'), makeFile('c.png')];
    dispatchFilesOnto(input, newFiles);

    const aThreadAccepted = useAttachmentsStore.getState().items.filter(
      (item) => item.threadId === 'thread-A' && item.status !== 'error',
    );
    expect(aThreadAccepted).toHaveLength(3);
  });

  it('errored items do NOT count against the cap (so removing them frees slots)', () => {
    // Pre-seed 12 errored items on thread-A — they should not block
    // new uploads.
    for (let i = 0; i < MAX_ATTACHED_FILES_PER_TURN; i += 1) {
      useAttachmentsStore.getState().add({
        clientId: `err-${i}`,
        filename: `failed${i}.png`,
        size: 1024,
        status: 'error',
        error: 'simulated error',
        hasMarkdownConversion: false,
        threadId: 'thread-A',
      });
    }

    render(<AttachmentBar threadId="thread-A" />);
    const input = screen.getByTestId('attachment-bar-file-input') as HTMLInputElement;

    const newFiles = [makeFile('fresh.png')];
    dispatchFilesOnto(input, newFiles);

    const accepted = useAttachmentsStore.getState().items.filter(
      (item) => item.threadId === 'thread-A' && item.status !== 'error',
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.filename).toBe('fresh.png');
  });

  it('removing an uploaded chip fires DELETE to the backend file (Codex P2)', async () => {
    // Pre-seed an uploaded item — simulates a file that's already
    // on disk in the thread's uploads dir.
    useAttachmentsStore.getState().add({
      clientId: 'uploaded-1',
      filename: 'photo.png',
      size: 1024,
      status: 'uploaded',
      hasMarkdownConversion: false,
      threadId: 'thread-Z',
    });

    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(<AttachmentBar threadId="thread-Z" />);
    const removeBtn = screen.getByLabelText('Remove photo.png');
    fireEvent.click(removeBtn);

    // DELETE must be fired — without this, _copy_parent_uploaded_images
    // could later surface the discarded file to the builder.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/threads/thread-Z/uploads/photo.png');
    expect(init?.method).toBe('DELETE');

    // Wait for the DELETE-then-remove promise chain to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAttachmentsStore.getState().items).toHaveLength(0);
  });

  it('removing an uploading chip does NOT fire DELETE (nothing to delete yet)', () => {
    useAttachmentsStore.getState().add({
      clientId: 'pending-1',
      filename: 'inflight.png',
      size: 1024,
      status: 'uploading',
      hasMarkdownConversion: false,
      threadId: 'thread-Z',
    });
    const fetchMock = vi.spyOn(global, 'fetch');

    render(<AttachmentBar threadId="thread-Z" />);
    const removeBtn = screen.getByLabelText('Remove inflight.png');
    fireEvent.click(removeBtn);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAttachmentsStore.getState().items).toHaveLength(0);
  });

  it('removing an errored chip does NOT fire DELETE (no file on disk to remove)', () => {
    useAttachmentsStore.getState().add({
      clientId: 'err-1',
      filename: 'failed.png',
      size: 1024,
      status: 'error',
      error: 'simulated',
      hasMarkdownConversion: false,
      threadId: 'thread-Z',
    });
    const fetchMock = vi.spyOn(global, 'fetch');

    render(<AttachmentBar threadId="thread-Z" />);
    const removeBtn = screen.getByLabelText('Remove failed.png');
    fireEvent.click(removeBtn);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAttachmentsStore.getState().items).toHaveLength(0);
  });

  it('keeps the chip with an error when the DELETE fails (file still on disk)', async () => {
    useAttachmentsStore.getState().add({
      clientId: 'uploaded-2',
      filename: 'stuck.png',
      size: 1024,
      status: 'uploaded',
      hasMarkdownConversion: false,
      threadId: 'thread-Z',
    });

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    );

    render(<AttachmentBar threadId="thread-Z" />);
    fireEvent.click(screen.getByLabelText('Remove stuck.png'));

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const item = useAttachmentsStore.getState().items[0];
    expect(item).toBeDefined();
    expect(item?.status).toBe('error');
    expect(item?.error).toMatch(/Couldn't remove from server/i);
    // Important: chip is NOT auto-removed. The user sees the failure
    // and can retry; the file is still on disk and we'd rather show
    // the inconsistency than silently lose track of it.
  });

  it('tags each accepted item with the threadId prop', () => {
    render(<AttachmentBar threadId="thread-X" />);
    const input = screen.getByTestId('attachment-bar-file-input') as HTMLInputElement;
    dispatchFilesOnto(input, [makeFile('only.png')]);

    const item = useAttachmentsStore.getState().items[0];
    expect(item?.threadId).toBe('thread-X');
  });
});
