import { describe, expect, it } from 'vitest';

import { parseAndValidateChatPayload } from '../../app/api/chat/_lib/chat-request';
import { buildAttachmentPrompt } from '../../app/stores/attachment-prompt';

const VALID_SESSION_ID = '01234567-89ab-4cde-9012-3456789abcde';

function makePayload(extra: Record<string, unknown> = {}) {
  return {
    message: 'what is in this image?',
    session_id: VALID_SESSION_ID,
    ...extra,
  };
}

describe('parseAndValidateChatPayload — attached_files', () => {
  it('defaults to an empty array when no attached_files is provided', () => {
    const result = parseAndValidateChatPayload(makePayload());
    if (result.kind !== 'valid') throw new Error('expected valid');
    expect(result.data.attachedFiles).toEqual([]);
  });

  it('passes through bare filenames', () => {
    const result = parseAndValidateChatPayload(
      makePayload({ attached_files: ['photo.png', 'report.pdf'] }),
    );
    if (result.kind !== 'valid') throw new Error('expected valid');
    expect(result.data.attachedFiles).toEqual(['photo.png', 'report.pdf']);
  });

  it('strips entries containing path separators (defense in depth)', () => {
    const result = parseAndValidateChatPayload(
      makePayload({ attached_files: ['../etc/passwd', 'foo\\bar.png', 'ok.png'] }),
    );
    if (result.kind !== 'valid') throw new Error('expected valid');
    expect(result.data.attachedFiles).toEqual(['ok.png']);
  });

  it('strips hidden-file entries and ./..', () => {
    const result = parseAndValidateChatPayload(
      makePayload({ attached_files: ['.DS_Store', '.', '..', 'visible.png'] }),
    );
    if (result.kind !== 'valid') throw new Error('expected valid');
    expect(result.data.attachedFiles).toEqual(['visible.png']);
  });

  it('deduplicates exact-match filenames', () => {
    const result = parseAndValidateChatPayload(
      makePayload({ attached_files: ['photo.png', 'photo.png', 'photo.png'] }),
    );
    if (result.kind !== 'valid') throw new Error('expected valid');
    expect(result.data.attachedFiles).toEqual(['photo.png']);
  });

  it('caps the list at 12 entries to bound prompt-token spend', () => {
    const many = Array.from({ length: 20 }, (_, i) => `file${i}.png`);
    const result = parseAndValidateChatPayload(
      makePayload({ attached_files: many }),
    );
    if (result.kind !== 'valid') throw new Error('expected valid');
    expect(result.data.attachedFiles).toHaveLength(12);
    expect(result.data.attachedFiles[0]).toBe('file0.png');
    expect(result.data.attachedFiles[11]).toBe('file11.png');
  });

  it('coerces a non-array attached_files into []', () => {
    const result = parseAndValidateChatPayload(
      makePayload({ attached_files: 'not-an-array' }),
    );
    if (result.kind !== 'valid') throw new Error('expected valid');
    expect(result.data.attachedFiles).toEqual([]);
  });
});

describe('buildAttachmentPrompt', () => {
  it('returns empty string for empty input', () => {
    expect(buildAttachmentPrompt([])).toBe('');
  });

  it('names both companion tools so Sophia knows the routing rule', () => {
    const prompt = buildAttachmentPrompt(['photo.png']);
    expect(prompt).toContain('view_user_image');
    expect(prompt).toContain('read_user_document');
  });

  it('lists each filename on its own dash-prefixed line', () => {
    const prompt = buildAttachmentPrompt(['a.png', 'b.pdf']);
    expect(prompt).toContain('- a.png');
    expect(prompt).toContain('- b.pdf');
  });

  it('explicitly tells the model to pass bare filenames (matches tool contracts)', () => {
    const prompt = buildAttachmentPrompt(['x.png']);
    expect(prompt).toContain('bare filename');
  });
});
