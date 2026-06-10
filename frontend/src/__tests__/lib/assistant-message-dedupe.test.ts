import { describe, expect, it } from 'vitest';

import {
  collapseRepeatedAssistantText,
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

describe('collapseRepeatedAssistantText', () => {
  const sentence = "Starting the build now — I'll have it back to you shortly.";
  const curlySentence = 'Starting the build now — I’ll have it back to you shortly.';

  it('collapses the doubled build-start sentence with no separator', () => {
    expect(collapseRepeatedAssistantText(`${sentence}${sentence}`)).toBe(sentence);
  });

  it('collapses straight + curly apostrophe copies, keeping the first', () => {
    expect(collapseRepeatedAssistantText(`${sentence}${curlySentence}`)).toBe(sentence);
  });

  it('collapses doubled copies separated by whitespace', () => {
    expect(collapseRepeatedAssistantText(`${sentence} ${sentence}`)).toBe(sentence);
    expect(collapseRepeatedAssistantText(`${sentence}\n${sentence}`)).toBe(sentence);
  });

  it('collapses a tripled sentence to one copy', () => {
    expect(collapseRepeatedAssistantText(`${sentence}${sentence}${sentence}`)).toBe(sentence);
  });

  it('collapses a doubled multi-sentence reply as a whole run', () => {
    const reply = "The page is taking shape nicely. I'll send it over in a few minutes.";
    expect(collapseRepeatedAssistantText(`${reply}${reply}`)).toBe(reply);
  });

  it('collapses doubled paragraphs and drops the duplicate separator', () => {
    const paragraph = 'Here is the plan for tonight, step by step.';
    expect(collapseRepeatedAssistantText(`${paragraph}\n\n${paragraph}`)).toBe(paragraph);
  });

  it('keeps genuinely different sentences intact', () => {
    const text = 'Starting the build now. Your page is ready — take a look!';
    expect(collapseRepeatedAssistantText(text)).toBe(text);
  });

  it('keeps deliberate short emphasis untouched', () => {
    expect(collapseRepeatedAssistantText('No. No.')).toBe('No. No.');
    expect(collapseRepeatedAssistantText('Yes! Yes!')).toBe('Yes! Yes!');
  });

  it('passes through empty and whitespace-only text unchanged', () => {
    expect(collapseRepeatedAssistantText('')).toBe('');
    expect(collapseRepeatedAssistantText('   ')).toBe('   ');
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
