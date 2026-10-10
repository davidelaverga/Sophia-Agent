/**
 * Single-line, content-free diagnostics.
 *
 * Every event is one `console.warn` call with ONE string argument:
 * `[sophia-diag] {"v":1,"ev":...,"at":...,"mono":...,...}`. Multi-argument
 * console calls were flattened to "Object" by log readers, and production
 * builds keep only warn and error (`removeConsole` in next.config.js).
 *
 * Fields pass a key allowlist, and values are limited to finite numbers,
 * booleans, null, short lowercase codes, UUID-like ids and (for `*_at` keys)
 * ISO timestamps. Anything else is dropped, so message text, transcripts,
 * titles, URLs and user ids cannot reach the line. diagLog never throws.
 *
 * In the browser each record is also kept in a dedicated 200-entry ring that
 * provider and audio capture events never share, so a session export still
 * holds the Builder and send diagnostics after a long voice session.
 */

export const DIAG_LOG_PREFIX = '[sophia-diag] '
export const DIAG_RING_CAPACITY = 200

const EVENT_NAME_RE = /^[a-z0-9_.]{1,64}$/u
const CODE_RE = /^[a-z0-9_.:-]{1,64}$/u
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u

/** Every key a diagnostics field may use. `v`, `ev`, `at` and `mono` are set by diagLog. */
export const DIAG_FIELD_KEYS: ReadonlySet<string> = new Set([
  // Join ids
  'call',
  'tool',
  'tool_call_id',
  'thread_id',
  'parent_thread_id',
  'message_id',
  'task_id',
  'run_id',
  'response_id',
  'active_task_id',
  'active_run_id',
  // Codes and flags
  'ok',
  'outcome',
  'reason',
  'send_error',
  'status',
  'active_status',
  'kind',
  'state',
  'error_type',
  'enabled',
  'send_pending',
  'active_artifact_review',
  'protected_existing_state',
  'artifact_path_present',
  'patterns',
  'pattern_count',
  'sequence',
  'recent_events',
  'http_status',
  'upstream_status',
  // Times and waits
  'received_at',
  'occurred_at',
  'lag_ms',
  'late_ms',
  'waited_ms',
  'pre_send_ms',
  'app_version_ms',
  'source_record_ms',
  'send_settle_ms',
  'confirm_wait_ms',
  'boundary_ms',
  'session_ms',
  'token_ms',
  'authority_ms',
  'ownership_ms',
  'upstream_headers_ms',
  'total_ms',
])

export type DiagValue = number | boolean | string | null
export type DiagFields = Record<string, unknown>
export type SophiaDiagRecord = {
  v: 1
  ev: string
  at: string
  mono: number | null
  [key: string]: DiagValue
}

export type SophiaDiagnosticsRingExport = {
  capacity: number
  totalProduced: number
  droppedCount: number
  events: SophiaDiagRecord[]
}

type DiagnosticsRingState = {
  totalProduced: number
  droppedCount: number
  events: SophiaDiagRecord[]
}

declare global {
  interface Window {
    __sophiaDiagnosticsRing?: DiagnosticsRingState
  }
}

/** A monotonic clock reading in milliseconds (wall clock when unavailable). */
export function diagNow(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }
  } catch {
    // Fall through to the wall clock.
  }
  return Date.now()
}

/** Whole milliseconds since a diagNow() reading. */
export function diagElapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(diagNow() - startedAt))
}

/** A short error class code (`TypeError` -> `type_error`); never the message. */
export function diagErrorType(error: unknown): string {
  const name = error instanceof Error && typeof error.name === 'string' ? error.name : ''
  const code = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, '_')
    .slice(0, 64)
  return CODE_RE.test(code) ? code : 'unknown'
}

function sanitizeValue(key: string, value: unknown): DiagValue | undefined {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return key.endsWith('_ms') ? Math.round(value) : value
  }
  if (typeof value !== 'string') return undefined
  if (CODE_RE.test(value) || UUID_RE.test(value)) return value
  if ((key === 'at' || key.endsWith('_at')) && ISO_TIMESTAMP_RE.test(value)) return value
  return undefined
}

/** The allowlisted, value-checked subset of fields. Exposed for tests. */
export function sanitizeDiagFields(fields: DiagFields | null | undefined): Record<string, DiagValue> {
  const sanitized: Record<string, DiagValue> = {}
  if (!fields || typeof fields !== 'object') return sanitized
  for (const [key, value] of Object.entries(fields)) {
    if (!DIAG_FIELD_KEYS.has(key)) continue
    const clean = sanitizeValue(key, value)
    if (clean !== undefined) sanitized[key] = clean
  }
  return sanitized
}

function getRing(): DiagnosticsRingState | null {
  if (typeof window === 'undefined') return null
  const existing = window.__sophiaDiagnosticsRing
  if (existing && Array.isArray(existing.events)) return existing
  const created: DiagnosticsRingState = { totalProduced: 0, droppedCount: 0, events: [] }
  window.__sophiaDiagnosticsRing = created
  return created
}

function pushToRing(record: SophiaDiagRecord): void {
  const ring = getRing()
  if (!ring) return
  ring.events.push(record)
  ring.totalProduced += 1
  if (ring.events.length > DIAG_RING_CAPACITY) {
    const dropped = ring.events.length - DIAG_RING_CAPACITY
    ring.events.splice(0, dropped)
    ring.droppedCount += dropped
  }
}

/**
 * Emit one diagnostics line and keep it in the browser diagnostics ring.
 * An invalid event name drops the event. Never throws.
 */
export function diagLog(ev: string, fields: DiagFields = {}): void {
  try {
    if (typeof ev !== 'string' || !EVENT_NAME_RE.test(ev)) return
    const mono = diagNow()
    const record: SophiaDiagRecord = {
      v: 1,
      ev,
      at: new Date().toISOString(),
      mono: Number.isFinite(mono) ? Math.round(mono) : null,
      ...sanitizeDiagFields(fields),
    }
    pushToRing(record)
    console.warn(DIAG_LOG_PREFIX + JSON.stringify(record))
  } catch {
    // Diagnostics never change behaviour.
  }
}

/** A copy of the diagnostics ring with its drop counters. */
export function readDiagnosticsRing(): SophiaDiagnosticsRingExport {
  try {
    const ring = getRing()
    return {
      capacity: DIAG_RING_CAPACITY,
      totalProduced: ring?.totalProduced ?? 0,
      droppedCount: ring?.droppedCount ?? 0,
      events: (ring?.events ?? []).map((event) => ({ ...event })),
    }
  } catch {
    return { capacity: DIAG_RING_CAPACITY, totalProduced: 0, droppedCount: 0, events: [] }
  }
}

/** One JSON record per line; empty when nothing was recorded. */
export function diagnosticsRingToNdjson(ring: SophiaDiagnosticsRingExport = readDiagnosticsRing()): string {
  if (ring.events.length === 0) return ''
  return `${ring.events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

export function clearDiagnosticsRing(): void {
  if (typeof window === 'undefined') return
  window.__sophiaDiagnosticsRing = { totalProduced: 0, droppedCount: 0, events: [] }
}
