import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearDiagnosticsRing,
  DIAG_LOG_PREFIX,
  DIAG_RING_CAPACITY,
  diagErrorType,
  diagLog,
  diagnosticsRingToNdjson,
  readDiagnosticsRing,
  sanitizeDiagFields,
} from '../../app/lib/diag-log'

const UUID = '0190f2a3-4b5c-7d6e-8f90-a1b2c3d4e5f6'

function parseLine(call: unknown[]): Record<string, unknown> {
  expect(call).toHaveLength(1)
  expect(typeof call[0]).toBe('string')
  const line = call[0] as string
  expect(line.startsWith(DIAG_LOG_PREFIX)).toBe(true)
  return JSON.parse(line.slice(DIAG_LOG_PREFIX.length)) as Record<string, unknown>
}

describe('diagLog', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearDiagnosticsRing()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('emits one string argument with the envelope first', () => {
    diagLog('voice_builder.outcome', { call: UUID, ok: true, waited_ms: 12.6 })

    expect(warn).toHaveBeenCalledTimes(1)
    const record = parseLine(warn.mock.calls[0])
    expect(Object.keys(record).slice(0, 4)).toEqual(['v', 'ev', 'at', 'mono'])
    expect(record).toMatchObject({ v: 1, ev: 'voice_builder.outcome', call: UUID, ok: true, waited_ms: 13 })
    expect(typeof record.at).toBe('string')
    expect(Number.isNaN(Date.parse(record.at as string))).toBe(false)
    expect(Number.isInteger(record.mono)).toBe(true)
  })

  it('keeps only allowlisted keys with numbers, booleans, null, codes, UUIDs and _at timestamps', () => {
    const fields = sanitizeDiagFields({
      call: UUID,
      outcome: 'builder_start_unconfirmed',
      status: null,
      ok: false,
      lag_ms: -41.2,
      occurred_at: '2026-10-03T21:27:24.947123+00:00',
      received_at: '2026-10-03T21:27:25.001Z',
      // Free text, URLs, uppercase, objects, arrays, non-finite numbers.
      reason: 'The user said something private',
      outcome_detail: 'not allowlisted',
      task_id: 'https://example.test/x?token=abc',
      run_id: 'Run-With-Caps',
      kind: { nested: true },
      patterns: ['a', 'b'],
      sequence: Number.NaN,
      // A timestamp is only accepted for *_at keys.
      state: '2026-10-03T21:27:25.001Z',
      user_id: 'user-1',
      message: 'hello',
      v: 9,
      ev: 'spoofed',
    })

    expect(fields).toEqual({
      call: UUID,
      outcome: 'builder_start_unconfirmed',
      status: null,
      ok: false,
      lag_ms: -41,
      occurred_at: '2026-10-03T21:27:24.947123+00:00',
      received_at: '2026-10-03T21:27:25.001Z',
    })
  })

  it('cannot let fields override the envelope', () => {
    diagLog('voice_audio.context_state', { at: 'later', mono: 'x', v: 2, ev: 'other', state: 'running' } as Record<string, unknown>)

    const record = parseLine(warn.mock.calls[0])
    expect(record.v).toBe(1)
    expect(record.ev).toBe('voice_audio.context_state')
    expect(record.at).not.toBe('later')
    expect(record.state).toBe('running')
  })

  it('drops an event with an invalid name and never throws', () => {
    diagLog('Bad Event Name', { ok: true })
    diagLog('', { ok: true })
    expect(warn).not.toHaveBeenCalled()

    warn.mockImplementation(() => {
      throw new Error('console unavailable')
    })
    expect(() => diagLog('voice_builder.call', { ok: true })).not.toThrow()

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => diagLog('voice_builder.call', circular)).not.toThrow()
    expect(() => diagLog('voice_builder.call', null as unknown as Record<string, unknown>)).not.toThrow()
  })

  it('keeps a bounded ring with drop counters and exports NDJSON', () => {
    for (let index = 0; index < DIAG_RING_CAPACITY + 25; index += 1) {
      diagLog('builder_canvas.event', { sequence: index })
    }

    const ring = readDiagnosticsRing()
    expect(ring).toMatchObject({ capacity: 200, totalProduced: 225, droppedCount: 25 })
    expect(ring.events).toHaveLength(200)
    expect(ring.events[0]?.sequence).toBe(25)

    const lines = diagnosticsRingToNdjson(ring).trimEnd().split('\n')
    expect(lines).toHaveLength(200)
    expect(JSON.parse(lines[199])).toMatchObject({ ev: 'builder_canvas.event', sequence: 224 })

    clearDiagnosticsRing()
    expect(readDiagnosticsRing()).toMatchObject({ totalProduced: 0, droppedCount: 0, events: [] })
    expect(diagnosticsRingToNdjson()).toBe('')
  })

  it('reduces an error to its class code, never its message', () => {
    expect(diagErrorType(new TypeError('secret detail'))).toBe('type_error')
    expect(diagErrorType(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('abort_error')
    expect(diagErrorType('boom')).toBe('unknown')
  })
})
