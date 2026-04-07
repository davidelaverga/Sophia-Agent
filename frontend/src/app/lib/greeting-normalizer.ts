import type { MemoryHighlight } from '../types/session';

const MAX_GREETING_CHARS = 120;

type NormalizeInput = {
  greeting: string;
  isResumed?: boolean;
  sessionType?: string;
  contextMode?: string;
  memoryHighlights?: MemoryHighlight[];
};

const SESSION_FALLBACKS: Record<string, string> = {
  prepare: 'Hey! Ready to lock in and make this session count?',
  debrief: 'Welcome back. Want to reflect on how your session went?',
  reset: "Hey, let's take a breath and reset together.",
  vent: "I'm here with you. What's on your mind?",
  chat: "Hey, good to see you. What's on your mind today?",
  open: "Hey, good to see you. What's on your mind today?",
};

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function overlapScore(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let shared = 0;
  tokensA.forEach((token) => {
    if (tokensB.has(token)) shared += 1;
  });

  return shared / Math.min(tokensA.size, tokensB.size);
}

function isLikelyMemoryDump(greeting: string): boolean {
  const text = cleanText(greeting);
  const commaCount = (text.match(/,/g) || []).length;

  return (
    /^hey!?\s+user\b/i.test(text) ||
    /^user\b/i.test(text) ||
    /\b(user feels|user wants|user is|user has)\b/i.test(text) ||
    commaCount >= 3 ||
    text.length > MAX_GREETING_CHARS
  );
}

function fallbackGreeting(sessionType?: string): string {
  const key = (sessionType || 'chat').toLowerCase();
  return SESSION_FALLBACKS[key] || SESSION_FALLBACKS.chat;
}

function trimGreeting(text: string): string {
  const cleaned = cleanText(text);
  if (cleaned.length <= MAX_GREETING_CHARS) return cleaned;

  const sentenceEnd = cleaned.slice(0, MAX_GREETING_CHARS).search(/[.!?](?=\s|$)/);
  if (sentenceEnd > 0) {
    return cleaned.slice(0, sentenceEnd + 1);
  }

  return `${cleaned.slice(0, MAX_GREETING_CHARS - 1).trimEnd()}…`;
}

export function normalizeGreetingForDisplay(input: NormalizeInput): string {
  const cleanedGreeting = cleanText(input.greeting || '');
  if (!cleanedGreeting) return fallbackGreeting(input.sessionType);

  if (input.isResumed) {
    return trimGreeting(cleanedGreeting);
  }

  const topMemory = input.memoryHighlights?.[0]?.text || '';
  const hasHighOverlap = topMemory ? overlapScore(cleanedGreeting, topMemory) >= 0.6 : false;

  if (isLikelyMemoryDump(cleanedGreeting) || hasHighOverlap) {
    return fallbackGreeting(input.sessionType);
  }

  return trimGreeting(cleanedGreeting);
}
