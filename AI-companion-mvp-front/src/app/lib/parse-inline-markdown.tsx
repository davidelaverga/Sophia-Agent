/**
 * Inline Markdown Parser
 * 
 * Lightweight parser for chat messages - no heavy dependencies.
 * Supports: **bold**, *italic*, `code`, and combinations.
 * 
 * Does NOT support block elements (headers, lists, etc.) - 
 * those don't belong in chat bubbles anyway.
 */

import React from 'react';

// Token types for parsing
type TokenType = 'text' | 'bold' | 'italic' | 'code' | 'bolditalic';

interface Token {
  type: TokenType;
  content: string;
}

/**
 * Parse inline markdown to tokens
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let remaining = text;
  
  // Regex patterns (order matters - most specific first)
  const patterns: { regex: RegExp; type: TokenType }[] = [
    // ***bold italic*** or ___bold italic___
    { regex: /^\*\*\*(.+?)\*\*\*/, type: 'bolditalic' },
    { regex: /^___(.+?)___/, type: 'bolditalic' },
    // **bold** or __bold__
    { regex: /^\*\*(.+?)\*\*/, type: 'bold' },
    { regex: /^__(.+?)__/, type: 'bold' },
    // *italic* or _italic_ (but not inside words for underscore)
    { regex: /^\*([^*]+?)\*/, type: 'italic' },
    { regex: /^_([^_]+?)_(?![a-zA-Z0-9])/, type: 'italic' },
    // `code`
    { regex: /^`([^`]+?)`/, type: 'code' },
  ];
  
  while (remaining.length > 0) {
    let matched = false;
    
    for (const { regex, type } of patterns) {
      const match = remaining.match(regex);
      if (match) {
        tokens.push({ type, content: match[1] });
        remaining = remaining.slice(match[0].length);
        matched = true;
        break;
      }
    }
    
    if (!matched) {
      // No pattern matched - consume one character as text
      // But optimize by consuming all text until next potential marker
      const nextMarker = remaining.slice(1).search(/[*_`]/);
      if (nextMarker === -1) {
        // No more markers - consume all
        tokens.push({ type: 'text', content: remaining });
        break;
      } else {
        // Consume text up to next marker
        const textChunk = remaining.slice(0, nextMarker + 1);
        tokens.push({ type: 'text', content: textChunk });
        remaining = remaining.slice(nextMarker + 1);
      }
    }
  }
  
  // Merge adjacent text tokens
  const merged: Token[] = [];
  for (const token of tokens) {
    if (token.type === 'text' && merged.length > 0 && merged[merged.length - 1].type === 'text') {
      merged[merged.length - 1].content += token.content;
    } else {
      merged.push(token);
    }
  }
  
  return merged;
}

/**
 * Render tokens to React elements
 */
function renderTokens(tokens: Token[]): React.ReactNode[] {
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'bold':
        return <strong key={i} className="font-semibold">{token.content}</strong>;
      case 'italic':
        return <em key={i} className="italic">{token.content}</em>;
      case 'bolditalic':
        return <strong key={i} className="font-semibold italic">{token.content}</strong>;
      case 'code':
        return (
          <code 
            key={i} 
            className="px-1.5 py-0.5 rounded bg-sophia-surface text-sophia-purple text-[0.9em] font-mono"
          >
            {token.content}
          </code>
        );
      case 'text':
      default:
        return <span key={i}>{token.content}</span>;
    }
  });
}

/**
 * Parse and render inline markdown
 * 
 * @example
 * parseInlineMarkdown("This is **bold** and *italic*")
 * // Returns: <>This is <strong>bold</strong> and <em>italic</em></>
 */
export function parseInlineMarkdown(text: string): React.ReactNode {
  if (!text) return null;
  
  const tokens = tokenize(text);
  const rendered = renderTokens(tokens);
  
  return <>{rendered}</>;
}

/**
 * Check if text contains markdown syntax
 */
export function hasMarkdown(text: string): boolean {
  return /\*\*|__|\*[^*]|_[^_]|`[^`]/.test(text);
}

/**
 * Strip markdown syntax from text (for plain text needs)
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*([^*]+?)\*/g, '$1')
    .replace(/_([^_]+?)_/g, '$1')
    .replace(/`([^`]+?)`/g, '$1');
}
