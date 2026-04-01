/**
 * Tests for Input Sanitization Utilities
 */
import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  sanitizeText,
  sanitizeUrl,
  safeJsonParse,
  safeJsonStringify,
  sanitizeName,
  sanitizeEmail,
  sanitizeNumber,
  containsXss,
  containsSqlInjection,
  chatSanitizer,
} from '../../app/lib/sanitize';

describe('sanitize', () => {
  // ==========================================================================
  // escapeHtml
  // ==========================================================================
  describe('escapeHtml', () => {
    it('should escape HTML special characters', () => {
      expect(escapeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;'
      );
    });

    it('should escape ampersands', () => {
      expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('should escape quotes and backticks', () => {
      expect(escapeHtml('Say "hello" and `goodbye`')).toBe(
        'Say &quot;hello&quot; and &#x60;goodbye&#x60;'
      );
    });

    it('should handle empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('should handle non-string input', () => {
      expect(escapeHtml(null as unknown as string)).toBe('');
      expect(escapeHtml(undefined as unknown as string)).toBe('');
      expect(escapeHtml(123 as unknown as string)).toBe('');
    });

    it('should not double-escape already escaped content', () => {
      const input = '&lt;div&gt;';
      const result = escapeHtml(input);
      expect(result).toBe('&amp;lt;div&amp;gt;');
    });
  });

  // ==========================================================================
  // sanitizeText
  // ==========================================================================
  describe('sanitizeText', () => {
    it('should remove control characters', () => {
      expect(sanitizeText('Hello\x00World\x1F!')).toBe('HelloWorld!');
    });

    it('should remove zero-width characters', () => {
      expect(sanitizeText('Hello\u200BWorld')).toBe('HelloWorld');
      expect(sanitizeText('Test\uFEFFValue')).toBe('TestValue');
    });

    it('should normalize newlines', () => {
      expect(sanitizeText('Line1\r\nLine2\rLine3')).toBe('Line1\nLine2\nLine3');
    });

    it('should remove newlines when not allowed', () => {
      expect(sanitizeText('Line1\nLine2', { allowNewlines: false })).toBe(
        'Line1 Line2'
      );
    });

    it('should normalize multiple spaces', () => {
      expect(sanitizeText('Hello    World')).toBe('Hello World');
    });

    it('should normalize multiple newlines', () => {
      expect(sanitizeText('Hello\n\n\n\n\nWorld')).toBe('Hello\n\nWorld');
    });

    it('should trim whitespace', () => {
      expect(sanitizeText('  Hello World  ')).toBe('Hello World');
    });

    it('should not trim when option is false', () => {
      expect(
        sanitizeText('  Hello  ', { trim: false, normalizeWhitespace: false })
      ).toBe('  Hello  ');
    });

    it('should truncate to maxLength', () => {
      expect(sanitizeText('Hello World', { maxLength: 5 })).toBe('Hello');
    });

    it('should allow emojis by default', () => {
      expect(sanitizeText('Hello 😀 World')).toBe('Hello 😀 World');
    });

    it('should remove emojis when not allowed', () => {
      expect(sanitizeText('Hello 😀 World', { allowEmojis: false })).toBe(
        'Hello World'
      );
    });

    it('should handle null/undefined input', () => {
      expect(sanitizeText(null)).toBe('');
      expect(sanitizeText(undefined)).toBe('');
    });

    it('should convert non-string to string', () => {
      expect(sanitizeText(123)).toBe('123');
      expect(sanitizeText(true)).toBe('true');
    });
  });

  // ==========================================================================
  // sanitizeUrl
  // ==========================================================================
  describe('sanitizeUrl', () => {
    it('should allow http URLs', () => {
      expect(sanitizeUrl('http://example.com')).toBe('http://example.com/');
    });

    it('should allow https URLs', () => {
      expect(sanitizeUrl('https://example.com/path?q=1')).toBe(
        'https://example.com/path?q=1'
      );
    });

    it('should allow mailto URLs', () => {
      expect(sanitizeUrl('mailto:test@example.com')).toBe(
        'mailto:test@example.com'
      );
    });

    it('should allow tel URLs', () => {
      expect(sanitizeUrl('tel:+1234567890')).toBe('tel:+1234567890');
    });

    it('should block javascript: URLs', () => {
      expect(sanitizeUrl('javascript:alert("xss")')).toBe('');
      expect(sanitizeUrl('JAVASCRIPT:alert("xss")')).toBe('');
    });

    it('should block data: URLs', () => {
      expect(sanitizeUrl('data:text/html,<script>alert("xss")</script>')).toBe(
        ''
      );
    });

    it('should block vbscript: URLs', () => {
      expect(sanitizeUrl('vbscript:msgbox("xss")')).toBe('');
    });

    it('should allow relative URLs', () => {
      expect(sanitizeUrl('/path/to/page')).toBe('/path/to/page');
      expect(sanitizeUrl('relative/path')).toBe('relative/path');
    });

    it('should trim whitespace', () => {
      expect(sanitizeUrl('  https://example.com  ')).toBe(
        'https://example.com/'
      );
    });

    it('should handle non-string input', () => {
      expect(sanitizeUrl(null)).toBe('');
      expect(sanitizeUrl(undefined)).toBe('');
      expect(sanitizeUrl(123)).toBe('');
    });

    it('should handle empty string', () => {
      expect(sanitizeUrl('')).toBe('');
      expect(sanitizeUrl('   ')).toBe('');
    });
  });

  // ==========================================================================
  // safeJsonParse / safeJsonStringify
  // ==========================================================================
  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      expect(safeJsonParse('{"key":"value"}')).toEqual({ key: 'value' });
      expect(safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
      expect(safeJsonParse('null')).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      expect(safeJsonParse('not json')).toBeNull();
      expect(safeJsonParse('{invalid}')).toBeNull();
      expect(safeJsonParse('')).toBeNull();
    });
  });

  describe('safeJsonStringify', () => {
    it('should stringify valid objects', () => {
      expect(safeJsonStringify({ key: 'value' })).toBe('{"key":"value"}');
      expect(safeJsonStringify([1, 2, 3])).toBe('[1,2,3]');
    });

    it('should handle circular references', () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      const result = safeJsonStringify(obj);
      expect(result).toBe('{"a":1,"self":"[Circular]"}');
    });

    it('should support space parameter', () => {
      expect(safeJsonStringify({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
    });
  });

  // ==========================================================================
  // sanitizeName
  // ==========================================================================
  describe('sanitizeName', () => {
    it('should allow letters and spaces', () => {
      expect(sanitizeName('John Doe')).toBe('John Doe');
    });

    it('should allow accented characters', () => {
      expect(sanitizeName('José García')).toBe('José García');
      expect(sanitizeName('François Müller')).toBe('François Müller');
    });

    it('should allow hyphens and apostrophes', () => {
      expect(sanitizeName("Mary-Jane O'Connor")).toBe("Mary-Jane O'Connor");
    });

    it('should remove numbers', () => {
      expect(sanitizeName('John123')).toBe('John');
    });

    it('should remove special characters', () => {
      expect(sanitizeName('John@Doe!')).toBe('JohnDoe');
    });

    it('should normalize multiple spaces', () => {
      expect(sanitizeName('John    Doe')).toBe('John Doe');
    });

    it('should truncate to maxLength', () => {
      expect(sanitizeName('John Doe', 4)).toBe('John');
    });

    it('should handle non-string input', () => {
      expect(sanitizeName(null)).toBe('');
      expect(sanitizeName(123)).toBe('');
    });
  });

  // ==========================================================================
  // sanitizeEmail
  // ==========================================================================
  describe('sanitizeEmail', () => {
    it('should lowercase email', () => {
      expect(sanitizeEmail('John.Doe@Example.COM')).toBe('john.doe@example.com');
    });

    it('should trim whitespace', () => {
      expect(sanitizeEmail('  test@example.com  ')).toBe('test@example.com');
    });

    it('should handle non-string input', () => {
      expect(sanitizeEmail(null)).toBe('');
      expect(sanitizeEmail(undefined)).toBe('');
    });
  });

  // ==========================================================================
  // sanitizeNumber
  // ==========================================================================
  describe('sanitizeNumber', () => {
    it('should pass through valid numbers', () => {
      expect(sanitizeNumber(42)).toBe(42);
      expect(sanitizeNumber(3.14)).toBe(3.14);
    });

    it('should parse string numbers', () => {
      expect(sanitizeNumber('42')).toBe(42);
      expect(sanitizeNumber('3.14')).toBe(3.14);
    });

    it('should return fallback for invalid input', () => {
      expect(sanitizeNumber('not a number')).toBe(0);
      expect(sanitizeNumber('not a number', { fallback: -1 })).toBe(-1);
    });

    it('should clamp to min/max', () => {
      expect(sanitizeNumber(150, { max: 100 })).toBe(100);
      expect(sanitizeNumber(-50, { min: 0 })).toBe(0);
      expect(sanitizeNumber(50, { min: 0, max: 100 })).toBe(50);
    });

    it('should handle NaN', () => {
      expect(sanitizeNumber(NaN)).toBe(0);
      expect(sanitizeNumber(NaN, { fallback: 10 })).toBe(10);
    });
  });

  // ==========================================================================
  // containsXss
  // ==========================================================================
  describe('containsXss', () => {
    it('should detect script tags', () => {
      expect(containsXss('<script>alert("xss")</script>')).toBe(true);
      expect(containsXss('<SCRIPT>alert("xss")</SCRIPT>')).toBe(true);
    });

    it('should detect javascript: protocol', () => {
      expect(containsXss('javascript:alert("xss")')).toBe(true);
    });

    it('should detect event handlers', () => {
      expect(containsXss('<img src="x" onerror="alert(1)">')).toBe(true);
      expect(containsXss('<div onclick="evil()">')).toBe(true);
      expect(containsXss('onmouseover = "bad()"')).toBe(true);
    });

    it('should detect iframe/object/embed tags', () => {
      expect(containsXss('<iframe src="evil.com">')).toBe(true);
      expect(containsXss('<object data="evil.swf">')).toBe(true);
      expect(containsXss('<embed src="evil.swf">')).toBe(true);
    });

    it('should not flag normal text', () => {
      expect(containsXss('Hello World')).toBe(false);
      expect(containsXss('Check out this script tutorial')).toBe(false);
      expect(containsXss('The onclick button works')).toBe(false);
    });

    it('should handle non-string input', () => {
      expect(containsXss(null as unknown as string)).toBe(false);
      expect(containsXss(123 as unknown as string)).toBe(false);
    });
  });

  // ==========================================================================
  // containsSqlInjection
  // ==========================================================================
  describe('containsSqlInjection', () => {
    it('should detect classic SQL injection patterns', () => {
      expect(containsSqlInjection("' OR '1'='1")).toBe(true);
      expect(containsSqlInjection("' OR 1=1")).toBe(true);
      expect(containsSqlInjection("'; DROP TABLE users--")).toBe(true);
    });

    it('should detect union attacks', () => {
      expect(containsSqlInjection('UNION SELECT * FROM users')).toBe(true);
    });

    it('should not flag normal text', () => {
      expect(containsSqlInjection('Hello World')).toBe(false);
      expect(containsSqlInjection("It's a beautiful day")).toBe(false);
      expect(containsSqlInjection('SELECT your favorite color')).toBe(false);
    });

    it('should handle non-string input', () => {
      expect(containsSqlInjection(null as unknown as string)).toBe(false);
    });
  });

  // ==========================================================================
  // chatSanitizer
  // ==========================================================================
  describe('chatSanitizer', () => {
    it('should sanitize chat messages', () => {
      expect(chatSanitizer.sanitize('  Hello World  ')).toBe('Hello World');
    });

    it('should preserve emojis', () => {
      expect(chatSanitizer.sanitize('I feel great! 😊')).toBe('I feel great! 😊');
    });

    it('should enforce max length of 4000', () => {
      const longMessage = 'a'.repeat(5000);
      expect(chatSanitizer.sanitize(longMessage).length).toBe(4000);
    });

    it('should validate non-empty messages', () => {
      expect(chatSanitizer.isValid('Hello')).toBe(true);
      expect(chatSanitizer.isValid('')).toBe(false);
      expect(chatSanitizer.isValid('   ')).toBe(false);
    });

    it('should validateAndSanitize correctly', () => {
      expect(chatSanitizer.validateAndSanitize('  Hello  ')).toBe('Hello');
      expect(chatSanitizer.validateAndSanitize('')).toBeNull();
      expect(chatSanitizer.validateAndSanitize('   ')).toBeNull();
    });
  });
});
