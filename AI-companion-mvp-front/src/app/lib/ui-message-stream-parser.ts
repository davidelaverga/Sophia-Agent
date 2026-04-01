type UiMessageChunk = {
  type?: string;
  delta?: string;
};

const LEAKED_USER_MESSAGE_BLOCK = /(?:^|\n)\s*USER(?:\s*_?\s*MESSAGE)?\s*:[\s\S]*$/i;
const NATURAL_RESPONSE_PLACEHOLDER_LINE = /(?:^|\n)\s*\[Natural response above\]\s*(?=\n|$)/gi;

function sanitizeLeakedPromptText(value: string): string {
  if (!value) return value;

  const leakageMatch = value.match(LEAKED_USER_MESSAGE_BLOCK);
  let sanitized =
    leakageMatch && typeof leakageMatch.index === 'number'
      ? value.slice(0, leakageMatch.index)
      : value;

  sanitized = sanitized.replace(NATURAL_RESPONSE_PLACEHOLDER_LINE, '');
  return sanitized.trimEnd();
}

function parseChunk(line: string): UiMessageChunk | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;

  try {
    const parsed = JSON.parse(payload) as UiMessageChunk;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isUiMessageStreamDump(value: string): boolean {
  if (!value) return false;
  return /(^|\n)\s*data:\s*\{"type"/m.test(value);
}

export function extractTextFromUiMessageStreamDump(value: string): string {
  if (!isUiMessageStreamDump(value)) return sanitizeLeakedPromptText(value);

  const chunks = value
    .split(/\r?\n/)
    .map(parseChunk)
    .filter((chunk): chunk is UiMessageChunk => chunk !== null);

  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta' && typeof chunk.delta === 'string')
    .map((chunk) => chunk.delta as string)
    .join('');

  const extracted = text.trim().length > 0 ? text : value;
  return sanitizeLeakedPromptText(extracted);
}
