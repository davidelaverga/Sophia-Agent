import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  copyTextToClipboard,
  DOWNLOAD_URL_REVOKE_DELAY_MS,
  downloadTextFile,
} from '../../app/lib/download-file'

describe('downloadTextFile', () => {
  const createObjectURL = vi.fn(() => 'blob:test')
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
  })

  it('clicks an attached anchor and revokes the URL only after a delay', () => {
    let attachedOnClick = false
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        attachedOnClick = document.body.contains(this)
      })

    const result = downloadTextFile({ text: '{"a":1}', filename: 'report.json' })

    expect(result).toEqual({ ok: true, bytes: 7 })
    expect(click).toHaveBeenCalledTimes(1)
    expect(attachedOnClick).toBe(true)
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revokeObjectURL).not.toHaveBeenCalled()

    vi.advanceTimersByTime(DOWNLOAD_URL_REVOKE_DELAY_MS)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })
})

describe('copyTextToClipboard', () => {
  const originalClipboard = navigator.clipboard

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
    vi.restoreAllMocks()
  })

  it('uses the async clipboard when it accepts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await expect(copyTextToClipboard('abc')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('abc')
  })

  it('falls back to execCommand when the clipboard rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })

    await expect(copyTextToClipboard('abc')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('returns false when both paths fail', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true })

    await expect(copyTextToClipboard('abc')).resolves.toBe(false)
  })
})
