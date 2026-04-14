/**
 * Session API Response Schemas
 * P0 - Runtime validation with Zod
 * 
 * Validates all backend responses to prevent crashes from malformed data.
 * Used at API boundaries before data enters the app.
 */

import { z } from 'zod';

import { debugWarn } from '../debug-logger';
import { logger } from '../error-logger';

// =============================================================================
// COMMON SCHEMAS
// =============================================================================

export const UUIDSchema = z.string().uuid().or(z.string().min(1)); // Allow non-UUID IDs for backward compat

export const ISODateSchema = z.string().refine(
  (val) => !isNaN(Date.parse(val)),
  { message: 'Invalid ISO date string' }
);

export const BriefingSourceSchema = z.enum(['openmemory', 'mem0', 'fallback', 'none']);

export const SessionTypeSchema = z.enum(['prepare', 'debrief', 'reset', 'vent', 'chat', 'open', 'open_chat']);

export const ContextModeSchema = z.enum(['gaming', 'work', 'life']);

export const SessionStatusSchema = z.enum(['active', 'ended', 'paused', 'pending_debrief']);

// =============================================================================
// MEMORY HIGHLIGHT
// =============================================================================

export const MemoryHighlightSchema = z.object({
  id: z.string(),
  text: z.string().max(500), // Allow longer for safety
  category: z.string().optional(),
  salience: z.number().min(0).max(1).optional(),
  recency_label: z.preprocess(
    (value) => value === null ? undefined : value,
    z.string().optional()
  ),
});

export type MemoryHighlightValidated = z.infer<typeof MemoryHighlightSchema>;

// =============================================================================
// SESSION START
// =============================================================================

export const SessionStartResponseSchema = z.object({
  session_id: UUIDSchema,
  thread_id: UUIDSchema,
  greeting_message: z.string().default('Hey! Ready to get started?'),
  message_id: z.string().default(() => `msg_${Date.now()}`),
  memory_highlights: z.array(MemoryHighlightSchema).default([]),
  is_resumed: z.boolean().default(false),
  briefing_source: BriefingSourceSchema.default('fallback'),
  has_memory: z.boolean().default(false),
  session_type: z.string(),
  preset_context: z.string(),
  started_at: ISODateSchema,
});

export type SessionStartResponseValidated = z.infer<typeof SessionStartResponseSchema>;

// =============================================================================
// SESSION END
// =============================================================================

export const RecapArtifactsSchema = z.object({
  takeaway: z.string().optional(),
  session_takeaway: z.string().optional(),
  reflection: z.union([
    z.string(),
    z.object({
      prompt: z.string().optional(),
      tag: z.string().optional(),
    }),
  ]).optional(),
  reflection_candidate: z.object({
    prompt: z.string().optional(),
    tag: z.string().optional(),
  }).optional(),
  memory_candidates: z.array(z.object({
    id: z.string().optional(),
    candidate_id: z.string().optional(),
    text: z.string().optional(),
    memory: z.string().optional(),
    category: z.string().optional(),
    confidence: z.number().optional(),
    reason: z.string().optional(),
    source: z.string().optional(),
  })).optional(),
  builder_artifact: z.object({
    artifactPath: z.string().optional(),
    artifactType: z.string().default('unknown'),
    artifactTitle: z.string().default('Builder deliverable'),
    supportingFiles: z.array(z.string()).optional(),
    stepsCompleted: z.number().optional(),
    decisionsMade: z.array(z.string()).default([]),
    sourcesUsed: z.array(z.string()).optional(),
    companionSummary: z.string().optional(),
    companionToneHint: z.string().optional(),
    userNextAction: z.string().optional(),
    confidence: z.number().optional(),
  }).optional(),
  memories_created: z.number().optional(),
  status: z.string().optional(),
}).nullable().optional();

export const SessionEndResponseSchema = z.object({
  session_id: UUIDSchema,
  ended_at: ISODateSchema,
  duration_minutes: z.number().min(0).default(0),
  turn_count: z.number().min(0).default(0),
  recap_artifacts: RecapArtifactsSchema,
  offer_debrief: z.boolean().default(false),
  debrief_prompt: z.string().optional(),
});

export type SessionEndResponseValidated = z.infer<typeof SessionEndResponseSchema>;

// =============================================================================
// ACTIVE SESSION
// =============================================================================

export const SessionInfoSchema = z.object({
  session_id: UUIDSchema,
  thread_id: UUIDSchema,
  session_type: z.string(),
  preset_context: z.string(),
  status: SessionStatusSchema,
  started_at: ISODateSchema,
  turn_count: z.number().min(0).default(0),
  intention: z.string().optional(),
  focus_cue: z.string().optional(),
});

export const ActiveSessionResponseSchema = z.object({
  has_active_session: z.boolean(),
  session: SessionInfoSchema.nullable().optional(),
});

export type ActiveSessionResponseValidated = z.infer<typeof ActiveSessionResponseSchema>;

// =============================================================================
// MICRO BRIEFING
// =============================================================================

export const MicroBriefingResponseSchema = z.object({
  message_id: z.string(),
  assistant_text: z.string(),
  highlights: z.array(MemoryHighlightSchema).default([]),
  ui_cards: z.array(z.unknown()).nullable().optional(),
  briefing_source: BriefingSourceSchema.default('fallback'),
  has_memory: z.boolean().default(false),
});

export type MicroBriefingResponseValidated = z.infer<typeof MicroBriefingResponseSchema>;

// =============================================================================
// SESSION CONTEXT
// =============================================================================

export const SessionContextSchema = z.object({
  session_id: UUIDSchema,
  thread_id: UUIDSchema,
  session_type: z.string(),
  preset_context: z.string(),
  intention: z.string().optional(),
  focus_cue: z.string().optional(),
  turn_count: z.number().min(0).default(0),
  duration_minutes: z.number().min(0).default(0),
});

export type SessionContextValidated = z.infer<typeof SessionContextSchema>;

// =============================================================================
// INTERRUPT PAYLOADS
// =============================================================================

export const InterruptKindSchema = z.enum(['DEBRIEF_OFFER', 'RESET_OFFER', 'NUDGE_OFFER', 'MICRO_DIALOG']);

export const InterruptOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'secondary', 'ghost']).optional(),
});

export const InterruptPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('DEBRIEF_OFFER'),
    title: z.string(),
    message: z.string(),
    options: z.array(InterruptOptionSchema),
    snooze: z.boolean().optional(),
    expiresAt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('RESET_OFFER'),
    title: z.string(),
    message: z.string(),
    options: z.array(InterruptOptionSchema),
    snooze: z.boolean().optional(),
    expiresAt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('NUDGE_OFFER'),
    title: z.string(),
    message: z.string(),
    options: z.array(InterruptOptionSchema),
    snooze: z.boolean().optional(),
    expiresAt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('MICRO_DIALOG'),
    dialogKind: z.string(),
    title: z.string(),
    message: z.string(),
    options: z.array(InterruptOptionSchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type InterruptPayloadValidated = z.infer<typeof InterruptPayloadSchema>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  issues?: z.ZodIssue[];
}

function describeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return { kind: 'array', length: value.length };
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return {
      kind: 'object',
      keys: Object.keys(record).slice(0, 12),
    };
  }
  return String(value);
}

function previewData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return describeValue(data);
  if (Array.isArray(data)) {
    return {
      kind: 'array',
      length: data.length,
      first_item: describeValue(data[0]),
    };
  }

  const record = data as Record<string, unknown>;
  const preview: Record<string, unknown> = {};
  const keys = Object.keys(record).slice(0, 20);
  for (const key of keys) {
    preview[key] = describeValue(record[key]);
  }
  return preview;
}

function getValueAtPath(data: unknown, path: Array<string | number>): unknown {
  let current: unknown = data;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function summarizeIssues(issues: z.ZodIssue[], data: unknown): Array<Record<string, unknown>> {
  return issues.slice(0, 12).map((issue) => {
    const issueWithDetails = issue as z.ZodIssue & {
      received?: unknown;
      expected?: unknown;
    };
    const actualValue = getValueAtPath(data, issue.path as Array<string | number>);

    return {
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      code: issue.code,
      message: issue.message,
      expected: issueWithDetails.expected,
      received: issueWithDetails.received,
      actual: describeValue(actualValue),
    };
  });
}

/**
 * Safely parse and validate API response data
 * Returns typed data or null with error info
 */
export function validateResponse<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context?: string
): ValidationResult<T> {
  const result = schema.safeParse(data);
  
  if (result.success) {
    return { success: true, data: result.data };
  }
  
  // Log validation errors in development
  if (process.env.NODE_ENV === 'development') {
    debugWarn('Schema Validation', `${context || 'Unknown'} failed`, {
      issue_count: result.error.issues.length,
      issues: summarizeIssues(result.error.issues, data),
      payload_preview: previewData(data),
    });
  }
  
  return {
    success: false,
    error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    issues: result.error.issues,
  };
}

/**
 * Parse with fallback - returns default value on failure
 */
export function parseWithFallback<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  fallback: T,
  context?: string
): T {
  const result = validateResponse(schema, data, context);
  return result.success ? result.data : fallback;
}

/**
 * Parse or throw - for cases where invalid data should halt execution
 */
export function parseOrThrow<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context?: string
): T {
  const result = schema.safeParse(data);
  
  if (!result.success) {
    const errorMsg = `[${context || 'Validation'}] Invalid response: ${result.error.message}`;
    logger.logError(new Error(errorMsg), {
      component: 'session-schemas',
      action: 'parse_or_throw',
      metadata: { data, errors: result.error.issues },
    });
    throw new Error(errorMsg);
  }
  
  return result.data;
}
