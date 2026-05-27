import { beforeEach, describe, expect, it } from 'vitest';

import {
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

  it('uploadedFilenames() returns only successfully-uploaded items', () => {
    useAttachmentsStore.getState().add(
      makeAttachment({ clientId: 'a', filename: 'done.png', status: 'uploaded' }),
    );
    useAttachmentsStore.getState().add(
      makeAttachment({ clientId: 'b', filename: 'pending.png', status: 'uploading' }),
    );
    useAttachmentsStore.getState().add(
      makeAttachment({ clientId: 'c', filename: 'failed.png', status: 'error' }),
    );
    expect(useAttachmentsStore.getState().uploadedFilenames()).toEqual(['done.png']);
  });
});
