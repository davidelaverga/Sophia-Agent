import { describe, expect, it } from 'vitest';
import { extractTextFromUiMessageStreamDump, isUiMessageStreamDump } from '../../app/lib/ui-message-stream-parser';

describe('ui-message-stream-parser', () => {
  it('detects ui-message stream dump signature', () => {
    const dump = 'data: {"type":"start","messageId":"m1"}\n\ndata: [DONE]';
    expect(isUiMessageStreamDump(dump)).toBe(true);
  });

  it('extracts readable text from text-delta chunks', () => {
    const dump = [
      'data: {"type":"start","messageId":"m1"}',
      '',
      'data: {"type":"text-start","id":"m1"}',
      '',
      'data: {"type":"text-delta","id":"m1","delta":"Hey"}',
      '',
      'data: {"type":"text-delta","id":"m1","delta":" there"}',
      '',
      'data: {"type":"data-sophia_meta","data":{"skill_used":"active_listening"}}',
      '',
      'data: [DONE]',
    ].join('\n');

    expect(extractTextFromUiMessageStreamDump(dump)).toBe('Hey there');
  });

  it('returns original text when input is not a dump', () => {
    const plain = 'Normal assistant response.';
    expect(extractTextFromUiMessageStreamDump(plain)).toBe(plain);
  });

  it('removes leaked USER_MESSAGE tail from plain text payload', () => {
    const plain = [
      'Real answer line.',
      '',
      'USER_MESSAGE:',
      '[Natural response above]',
    ].join('\n');

    expect(extractTextFromUiMessageStreamDump(plain)).toBe('Real answer line.');
  });

  it('removes standalone natural response placeholder line', () => {
    const plain = [
      'Real answer line.',
      '',
      '[Natural response above]',
    ].join('\n');

    expect(extractTextFromUiMessageStreamDump(plain)).toBe('Real answer line.');
  });
});
