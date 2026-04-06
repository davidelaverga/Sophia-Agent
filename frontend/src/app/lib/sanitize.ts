/**
 * Input Sanitization Utilities
 * Prevención de XSS y sanitización de user inputs
 */

import { logger } from './error-logger';

// ============================================================================
// HTML Entity Encoding
// ============================================================================

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

const HTML_ENTITY_REGEX = /[&<>"'`=/]/g;

/**
 * Escapa caracteres HTML para prevenir XSS
 * Usar cuando se renderiza texto en HTML sin React
 */
export function escapeHtml(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  return input.replace(HTML_ENTITY_REGEX, (char) => HTML_ENTITIES[char] || char);
}

/**
 * Decodifica entidades HTML de vuelta a caracteres
 */
export function unescapeHtml(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  const doc = new DOMParser().parseFromString(input, 'text/html');
  return doc.documentElement.textContent || '';
}

// ============================================================================
// Text Sanitization
// ============================================================================

/**
 * Opciones de sanitización para texto
 */
export interface SanitizeTextOptions {
  /** Longitud máxima (default: 10000) */
  maxLength?: number;
  /** Permitir saltos de línea (default: true) */
  allowNewlines?: boolean;
  /** Permitir emojis (default: true) */
  allowEmojis?: boolean;
  /** Trim whitespace (default: true) */
  trim?: boolean;
  /** Normalizar espacios múltiples (default: true) */
  normalizeWhitespace?: boolean;
}

// Regex para detectar caracteres de control (excepto newline y tab)
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Regex para detectar caracteres Unicode peligrosos (zero-width, directionality)
const DANGEROUS_UNICODE_REGEX = /[\u200B-\u200F\u2028-\u202F\uFEFF]/g;

// Regex para normalizar múltiples espacios/newlines
const MULTIPLE_SPACES_REGEX = /[ \t]+/g;
const MULTIPLE_NEWLINES_REGEX = /\n{3,}/g;

/**
 * Sanitiza texto de usuario para prevenir XSS y contenido malicioso
 * Principal función para inputs de chat/mensajes
 */
export function sanitizeText(
  input: unknown,
  options: SanitizeTextOptions = {}
): string {
  const {
    maxLength = 10000,
    allowNewlines = true,
    allowEmojis = true,
    trim = true,
    normalizeWhitespace = true,
  } = options;

  // Asegurar string
  if (input === null || input === undefined) {
    return '';
  }
  
  let text = String(input);

  // 1. Remover caracteres de control peligrosos
  text = text.replace(CONTROL_CHARS_REGEX, '');

  // 2. Remover caracteres Unicode peligrosos (zero-width, etc.)
  text = text.replace(DANGEROUS_UNICODE_REGEX, '');

  // 3. Manejar newlines
  if (!allowNewlines) {
    text = text.replace(/[\r\n]+/g, ' ');
  } else {
    // Normalizar line endings a \n
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  // 4. Remover emojis si no están permitidos
  if (!allowEmojis) {
    // Regex compatible con ES5 usando surrogate pairs
     
    text = text.replace(
      /[\uD83C-\uDBFF\uDC00-\uDFFF]+|[\u2600-\u26FF\u2700-\u27BF]/g,
      ''
    );
  }

  // 5. Normalizar whitespace
  if (normalizeWhitespace) {
    text = text.replace(MULTIPLE_SPACES_REGEX, ' ');
    if (allowNewlines) {
      text = text.replace(MULTIPLE_NEWLINES_REGEX, '\n\n');
    }
  }

  // 6. Trim
  if (trim) {
    text = text.trim();
  }

  // 7. Truncar a longitud máxima
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
  }

  return text;
}

// ============================================================================
// URL Sanitization
// ============================================================================

const SAFE_URL_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * Sanitiza URLs para prevenir javascript: y otros protocolos peligrosos
 */
export function sanitizeUrl(url: unknown): string {
  if (typeof url !== 'string') {
    return '';
  }

  const trimmed = url.trim();
  
  // Empty o solo whitespace
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    
    // Solo permitir protocolos seguros
    if (!SAFE_URL_PROTOCOLS.includes(parsed.protocol)) {
      return '';
    }
    
    return parsed.href;
  } catch {
    // URL relativa - verificar que no empiece con javascript:
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('data:') ||
      lower.startsWith('vbscript:')
    ) {
      return '';
    }
    
    // Devolver URL relativa tal cual
    return trimmed;
  }
}

// ============================================================================
// JSON Sanitization
// ============================================================================

/**
 * Parsea JSON de forma segura, devolviendo null si falla
 */
export function safeJsonParse<T = unknown>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

/**
 * Stringifica objetos de forma segura, manejando referencias circulares
 */
export function safeJsonStringify(
  value: unknown,
  space?: number
): string | null {
  const seen = new WeakSet();
  
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) {
            return '[Circular]';
          }
          seen.add(val);
        }
        return val;
      },
      space
    );
  } catch {
    return null;
  }
}

// ============================================================================
// Form Input Sanitization
// ============================================================================

/**
 * Sanitiza input de nombre (sin números ni caracteres especiales)
 */
export function sanitizeName(input: unknown, maxLength = 100): string {
  if (typeof input !== 'string') {
    return '';
  }
  
  return input
    .trim()
    .replace(/[^a-zA-ZÀ-ÿ\u00f1\u00d1\s'-]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

/**
 * Sanitiza input de email (lowercase, trim)
 */
export function sanitizeEmail(input: unknown): string {
  if (typeof input !== 'string') {
    return '';
  }
  
  return input.trim().toLowerCase();
}

/**
 * Sanitiza input numérico
 */
export function sanitizeNumber(
  input: unknown,
  options: { min?: number; max?: number; fallback?: number } = {}
): number {
  const { min = -Infinity, max = Infinity, fallback = 0 } = options;
  
  const num = typeof input === 'number' ? input : parseFloat(String(input));
  
  if (isNaN(num)) {
    return fallback;
  }
  
  return Math.max(min, Math.min(max, num));
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Verifica si un string contiene posible contenido XSS
 */
export function containsXss(input: string): boolean {
  if (typeof input !== 'string') {
    return false;
  }
  
  const dangerous = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i, // onclick=, onerror=, etc.
    /<iframe/i,
    /<object/i,
    /<embed/i,
    /<link/i,
    /expression\s*\(/i, // CSS expression
    /url\s*\(\s*['"]?\s*data:/i, // data: URLs in CSS
  ];
  
  return dangerous.some((regex) => regex.test(input));
}

/**
 * Verifica si un string parece ser un intento de inyección SQL
 * (Para logging/alertas, no como único mecanismo de defensa)
 */
export function containsSqlInjection(input: string): boolean {
  if (typeof input !== 'string') {
    return false;
  }
  
  const suspicious = [
    /'\s*or\s+'?1'?\s*=\s*'?1/i,
    /'\s*or\s+''='/i,
    /;\s*drop\s+table/i,
    /;\s*delete\s+from/i,
    /union\s+select/i,
    /insert\s+into/i,
    /--\s*$/,
  ];
  
  return suspicious.some((regex) => regex.test(input));
}

// ============================================================================
// React-specific Helpers
// ============================================================================

/**
 * Crea un manejador de cambio sanitizado para inputs
 * Uso: <input onChange={createSanitizedChangeHandler(setValue)} />
 */
export function createSanitizedChangeHandler(
  setter: (value: string) => void,
  options?: SanitizeTextOptions
) {
  return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setter(sanitizeText(e.target.value, options));
  };
}

/**
 * Hook helper para sanitizar valor antes de enviarlo
 */
export function sanitizeBeforeSubmit(
  value: string,
  options?: SanitizeTextOptions
): string {
  const sanitized = sanitizeText(value, options);
  
  // Log si se detecta contenido sospechoso (para monitoreo)
    if (containsXss(value)) {
      logger.warn('Potential XSS content detected and sanitized', {
        component: 'sanitize',
        action: 'sanitize_before_submit',
      });
  }
  
  return sanitized;
}

// ============================================================================
// Export Default Sanitizer
// ============================================================================

/**
 * Sanitizador por defecto para mensajes de chat
 * Pre-configurado con opciones óptimas para Sophia
 */
export const chatSanitizer = {
  /** Sanitiza mensaje de usuario antes de enviar */
  sanitize: (input: string) =>
    sanitizeText(input, {
      maxLength: 4000, // Límite razonable para un mensaje
      allowNewlines: true,
      allowEmojis: true,
      trim: true,
      normalizeWhitespace: true,
    }),

  /** Verifica si el input es válido (no vacío después de sanitizar) */
  isValid: (input: string) => {
    const sanitized = chatSanitizer.sanitize(input);
    return sanitized.length > 0;
  },

  /** Sanitiza y valida, devolviendo null si inválido */
  validateAndSanitize: (input: string) => {
    const sanitized = chatSanitizer.sanitize(input);
    return sanitized.length > 0 ? sanitized : null;
  },
};
