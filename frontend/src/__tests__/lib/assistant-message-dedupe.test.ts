import { describe, expect, it } from 'vitest';

import {
  hasRenderableAssistantText,
  isEquivalentAssistantText,
  normalizeAssistantTextForDedupe,
} from '../../app/lib/assistant-message-dedupe';

describe('normalizeAssistantTextForDedupe', () => {
  it('normalizes curly apostrophes and quotes to straight quotes', () => {
    expect(normalizeAssistantTextForDedupe('I’ll be here')).toBe("I'll be here");
    expect(normalizeAssistantTextForDedupe('“quoted” text')).toBe('"quoted" text');
  });

  it('collapses whitespace runs, newlines, and non-breaking spaces', () => {
    expect(normalizeAssistantTextForDedupe('  hello\n\n  wide\tworld  ')).toBe('hello wide world');
    expect(normalizeAssistantTextForDedupe('hello world')).toBe('hello world');
  });

  it('unifies dash and ellipsis variants', () => {
    expect(normalizeAssistantTextForDedupe('wait — here')).toBe('wait - here');
    expect(normalizeAssistantTextForDedupe('thinking…')).toBe('thinking');
  });

  it('ignores trailing terminal punctuation', () => {
    expect(normalizeAssistantTextForDedupe('Hello.')).toBe('Hello');
    expect(normalizeAssistantTextForDedupe('Hello!!')).toBe('Hello');
    expect(normalizeAssistantTextForDedupe('Hello')).toBe('Hello');
  });

  it('returns empty for null, undefined, and whitespace-only input', () => {
    expect(normalizeAssistantTextForDedupe(null)).toBe('');
    expect(normalizeAssistantTextForDedupe(undefined)).toBe('');
    expect(normalizeAssistantTextForDedupe('   \n ')).toBe('');
  });
});

describe('hasRenderableAssistantText', () => {
  it('is false for blank and punctuation-only text', () => {
    expect(hasRenderableAssistantText('')).toBe(false);
    expect(hasRenderableAssistantText('   ')).toBe(false);
    expect(hasRenderableAssistantText(null)).toBe(false);
  });

  it('is true for visible text', () => {
    expect(hasRenderableAssistantText('Hey!')).toBe(true);
  });
});

describe('isEquivalentAssistantText', () => {
  it('treats curly vs straight apostrophe variants as the same reply', () => {
    expect(isEquivalentAssistantText(
      "Starting the build now — I'll have it back to you shortly.",
      'Starting the build now — I’ll have it back to you shortly.',
    )).toBe(true);
  });

  it('treats a reply already contained in a longer visible message as duplicate', () => {
    const sentence = "Starting the build now — I'll have it back to you shortly.";
    expect(isEquivalentAssistantText(`${sentence} ${sentence}`, sentence)).toBe(true);
  });

  it('does not merge short acknowledgements into longer replies', () => {
    expect(isEquivalentAssistantText('ok', 'ok, starting the build right away for you')).toBe(false);
    expect(isEquivalentAssistantText('Yes.', 'Yes, the report is ready for review now')).toBe(false);
  });

  it('keeps genuinely different replies separate', () => {
    expect(isEquivalentAssistantText(
      'Starting the build now.',
      'Your page is ready — take a look!',
    )).toBe(false);
  });

  it('never matches blank text', () => {
    expect(isEquivalentAssistantText('', '')).toBe(false);
    expect(isEquivalentAssistantText('hello there friend', '')).toBe(false);
  });
});
