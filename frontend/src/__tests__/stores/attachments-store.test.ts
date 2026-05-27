import { beforeEach, describe, expect, it } from 'vitest';

import {
  selectHasUploadsInFlight,
  selectItemsForThread,
  selectUploadedFilenamesForThread,
  useAttachmentsStore,
  type PendingAttachment,
} from '../../app/stores/attachments-store';

function makeAttachment(
  overrides: Partial<PendingAttachment> = {},
): PendingAttachment {
  return {
    clientId: `att-${Math.random().toString(36).slice(2)}`,
    filename: 'photo.png',
    size: 1234,
    status: 'uploading',
    hasMarkdownConversion: false,
    threadId: 'thread-default',
    ...overrides,
  };
}

describe('useAttachmentsStore', () => {
  beforeEach(() => {
    useAttachmentsStore.getState().clear();
  });

  it('adds new items and exposes them in insertion order', () => {
    const a = makeAttachment({ clientId: 'a', filename: 'a.png' });
    const b = makeAttachment({ clientId: 'b', filename: 'b.png' });
    useAttachmentsStore.getState().add(a);
    useAttachmentsStore.getState().add(b);
    const items = useAttachmentsStore.getState().items;
    expect(items.map((item) => item.clientId)).toEqual(['a', 'b']);
  });

  it('updates a specific item by clientId', () => {
    const a = makeAttachment({ clientId: 'a', filename: 'a.png', status: 'uploading' });
    useAttachmentsStore.getState().add(a);
    useAttachmentsStore.getState().update('a', { status: 'uploaded' });
    expect(useAttachmentsStore.getState().items[0]?.status).toBe('uploaded');
  });

  it('removes an item by clientId', () => {
    const a = makeAttachment({ clientId: 'a' });
    const b = makeAttachment({ clientId: 'b' });
    useAttachmentsStore.getState().add(a);
    useAttachmentsStore.getState().add(b);
    useAttachmentsStore.getState().remove('a');
    const items = useAttachmentsStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.clientId).toBe('b');
  });

  it('clear() empties the list', () => {
    useAttachmentsStore.getState().add(makeAttachment({ clientId: 'a' }));
    useAttachmentsStore.getState().add(makeAttachment({ clientId: 'b' }));
    useAttachmentsStore.getState().clear();
    expect(useAttachmentsStore.getState().items).toHaveLength(0);
  });
});

// ─── Thread-scope (Codex P2 PR #132) ──────────────────────────────────

describe('thread-scoped selectors and clearForThread', () => {
  beforeEach(() => {
    useAttachmentsStore.getState().clear();
  });

  it('selectItemsForThread returns only items for the given thread', () => {
    useAttachmentsStore.getState().add(makeAttachment({ clientId: 'a1', threadId: 'thread-A' }));
    useAttachmentsStore.getState().add(makeAttachment({ clientId: 'b1', threadId: 'thread-B' }));
    useAttachmentsStore.getState().add(makeAttachment({ clientId: 'a2', threadId: 'thread-A' }));

    const aItems = selectItemsForThread('thread-A')(useAttachmentsStore.getState());
    const bItems = selectItemsForThread('thread-B')(useAttachmentsStore.getState());

    expect(aItems.map((i) => i.clientId)).toEqual(['a1', 'a2']);
    expect(bItems.map((i) => i.clientId)).toEqual(['b1']);
  });

  it('selectItemsForThread returns [] for null/undefined threadId (no leakage)', () => {
    useAttachmentsStore.getState().add(makeAttachment({ threadId: 'thread-X' }));
    expect(selectItemsForThread(null)(useAttachmentsStore.getState())).toEqual([]);
    expect(selectItemsForThread(undefined)(useAttachmentsStore.getState())).toEqual([]);
    expect(selectItemsForThread('')(useAttachmentsStore.getState())).toEqual([]);
  });

  it('selectUploadedFilenamesForThread filters by thread AND by uploaded status', () => {
    useAttachmentsStore.getState().add(
      makeAttachment({ clientId: 'a1', filename: 'done-A.png', status: 'uploaded', threadId: 'thread-A' }),
    );
    useAttachmentsStore.getState().add(
      makeAttachment({ clientId: 'a2', filename: 'pending-A.png', status: 'uploading', threadId: 'thread-A' }),
    );
    useAttachmentsStore.getState().add(
      makeAttachment({ clientId: 'b1', filename: 'done-B.png', status: 'uploaded', threadId: 'thread-B' }),
    );

    const aNames = selectUploadedFilenamesForThread('thread-A')(useAttachmentsStore.getState());
    const bNames = selectUploadedFilenamesForThread('thread-B')(useAttachmentsStore.getState());

    expect(aNames).toEqual(['done-A.png']);
    expect(bNames).toEqual(['done-B.png']);
  });

  it('selectUploadedFilenamesForThread returns [] for null/undefined threadId', () => {
    useAttachmentsStore.getState().add(
      makeAttachment({ filename: 'leaky.png', status: 'uploaded', threadId: 'thread-X' }),
    );
    expect(selectUploadedFilenamesForThread(null)(useAttachmentsStore.getState())).toEqual([]);
    expect(selectUploadedFilenamesForThread(undefined)(useAttachmentsStore.getState())).toEqual([]);
  });

  it('selectHasUploadsInFlight is true only when an uploading item matches the thread', () => {
    useAttachmentsStore.getState().add(
      makeAttachment({ clientId: 'a1', status: 'uploaded', threadId: 'thread-A' }),
    );
    useAttachmentsStore.getState().add(
      makeAttachment({ clientId: 'b1', status: 'uploading', threadId: 'thread-B' }),
    );

    // Thread A has only uploaded items → false.
    expect(selectHasUploadsInFlight('thread-A')(useAttachmentsStore.getState())).toBe(false);
    // Thread B has an uploading item → true.
    expect(selectHasUploadsInFlight('thread-B')(useAttachmentsStore.getState())).toBe(true);
    // Null thread → never true (defense against missing-threadId bugs).
    expect(selectHasUploadsInFlight(null)(useAttachmentsStore.getState())).toBe(false);
  });

  it('clearForThread removes only items in the named thread', () => {
    useAttachmentsStore.getState().add(makeAttachment({ clientId: 'a1', threadId: 'thread-A' }));
    useAttachmentsStore.getState().add(makeAttachment({ clientId: 'a2', threadId: 'thread-A' }));
    useAttachmentsStore.getState().add(makeAttachment({ clientId: 'b1', threadId: 'thread-B' }));

    useAttachmentsStore.getState().clearForThread('thread-A');

    const remaining = useAttachmentsStore.getState().items;
    expect(remaining.map((i) => i.clientId)).toEqual(['b1']);
  });

  it('cross-thread leakage regression: A-only uploads must not bleed into B', () => {
    // The scenario Codex flagged: user uploads in thread A, switches
    // to B before sending, submits in B. Without the per-thread
    // filter, A's filenames would be in attached_files for the B
    // request, view_user_image would fail to find them in B's
    // sandbox.
    useAttachmentsStore.getState().add(
      makeAttachment({
        clientId: 'leaked',
        filename: 'private-A.png',
        status: 'uploaded',
        threadId: 'thread-A',
      }),
    );

    // Posting to thread B — must not see A's file.
    const filenamesForB = selectUploadedFilenamesForThread('thread-B')(
      useAttachmentsStore.getState(),
    );
    expect(filenamesForB).toEqual([]);
    expect(filenamesForB).not.toContain('private-A.png');
  });
});
