import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import RealtimeDogfoodPage from '../../app/debug/realtime/page'
import {
  DOGFOOD_RUN_RECORDER_STORAGE_KEY,
  createDefaultRunRecorderDraft,
} from '../../app/debug/realtime/run-recorder'

class MockBlob {
  readonly parts: BlobPart[]
  readonly type: string

  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    this.parts = parts
    this.type = options?.type ?? ''
  }

  async text() {
    return this.parts.join('')
  }
}

describe('Realtime comparative dogfood page', () => {
  const clipboardWriteText = vi.fn()

  beforeEach(() => {
    clipboardWriteText.mockReset()
    clipboardWriteText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    })

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:realtime-dogfood-run'),
    })

    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })

    Object.defineProperty(globalThis, 'Blob', {
      configurable: true,
      value: MockBlob,
    })

    localStorage.clear()
  })

  it('renders the title and provider launch links', () => {
    render(<RealtimeDogfoodPage />)

    expect(screen.getByRole('heading', { name: 'Realtime Provider Dogfood' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open OpenAI dogfood' })).toHaveAttribute('href', '/debug/realtime/openai')
    expect(screen.getByRole('link', { name: 'Open Gemini dogfood' })).toHaveAttribute('href', '/debug/realtime/gemini')
  })

  it('lets the operator change the selected provider', () => {
    render(<RealtimeDogfoodPage />)

    const geminiRadio = screen.getByRole('radio', { name: /Gemini Live/i })
    fireEvent.click(geminiRadio)

    expect(geminiRadio).toBeChecked()
    expect(screen.getAllByText('Browser WSS + backend relay').length).toBeGreaterThan(0)
  })

  it('toggles a scenario and keeps compact notes for it', async () => {
    render(<RealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('checkbox', { name: /S01.*Standard Greeting/i }))

    const notesField = await screen.findByLabelText('Notes for S01')
    fireEvent.change(notesField, { target: { value: 'Fast greeting, clean SSE.' } })

    expect((notesField as HTMLTextAreaElement).value).toBe('Fast greeting, clean SSE.')
  })

  it('updates rubric scores', () => {
    render(<RealtimeDogfoodPage />)

    fireEvent.change(screen.getByLabelText('Perceived TTFA'), { target: { value: '5' } })

    expect(screen.getByLabelText('Perceived TTFA')).toHaveValue('5')
  })

  it('exports JSON with the selected provider and recorded fields', async () => {
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    render(<RealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('radio', { name: /Gemini Live/i }))
    fireEvent.change(screen.getByLabelText('Tester'), { target: { value: 'Edward' } })
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'feat/realtime-comparative-launcher-phase-9-7-hub' } })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemini-3.1-flash-live-preview' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /S01.*Standard Greeting/i }))
    fireEvent.change(screen.getByLabelText('sophia.* event count'), { target: { value: '24' } })

    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }))

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1))

    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as MockBlob
    const exported = JSON.parse(await blob.text())

    expect(exported.provider).toBe('gemini_live')
    expect(exported.branch).toBe('feat/realtime-comparative-launcher-phase-9-7-hub')
    expect(exported.model).toBe('gemini-3.1-flash-live-preview')
    expect(exported.scenario_ids_executed).toContain('S01')
    expect(exported.event_health.sophia_event_count).toBe(24)
    expect(anchorClickSpy).toHaveBeenCalledTimes(1)
  })

  it('copies a compact markdown summary', async () => {
    render(<RealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('radio', { name: /Gemini Live/i }))
    fireEvent.change(screen.getByLabelText('Run notes'), {
      target: { value: 'Gemini felt natural but relay observability still needs work.' },
    })
    fireEvent.change(screen.getByLabelText('Overall recommendation'), {
      target: { value: 'block' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown summary' }))

    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1))
    const copiedSummary = clipboardWriteText.mock.calls[0][0] as string

    expect(copiedSummary).toContain('Provider: Gemini Live')
    expect(copiedSummary).toContain('Recommendation: block')
    expect(copiedSummary).toContain('Gemini felt natural but relay observability still needs work.')
  })

  it('restores and resets a saved draft from localStorage', async () => {
    const storedDraft = createDefaultRunRecorderDraft()
    storedDraft.provider = 'gemini_live'
    storedDraft.tester = 'Edward'
    storedDraft.branch = 'feat/realtime-comparative-launcher-phase-9-7-hub'
    storedDraft.scenarios.S03.executed = true
    storedDraft.scenarios.S03.notes = 'Long answer stayed coherent.'

    localStorage.setItem(DOGFOOD_RUN_RECORDER_STORAGE_KEY, JSON.stringify(storedDraft))

    render(<RealtimeDogfoodPage />)

    await waitFor(() => expect(screen.getByLabelText('Tester')).toHaveValue('Edward'))
    expect(screen.getByRole('radio', { name: /Gemini Live/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /S03.*Long Reflective Answer/i })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Reset draft' }))

    await waitFor(() => expect(screen.getByLabelText('Tester')).toHaveValue(''))
    expect(screen.getByRole('radio', { name: /OpenAI Realtime/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /S03.*Long Reflective Answer/i })).not.toBeChecked()
  })
})