/**
 * Browser download and copy helpers for diagnostics exports.
 *
 * Some browsers ignore `anchor.click()` on a detached anchor, and revoking the
 * object URL synchronously can cancel the download before it starts. The
 * anchor is attached for the click and the URL is revoked on a timer.
 */

export const DOWNLOAD_URL_REVOKE_DELAY_MS = 30_000

export type DownloadTextFileResult = {
  ok: boolean
  bytes: number
}

export function downloadTextFile(input: {
  text: string
  filename: string
  mimeType?: string
}): DownloadTextFileResult {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    return { ok: false, bytes: 0 }
  }

  const blob = new Blob([input.text], { type: input.mimeType ?? 'application/json' })
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = input.filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'

  try {
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(href), DOWNLOAD_URL_REVOKE_DELAY_MS)
  }

  return { ok: true, bytes: blob.size }
}

/**
 * Copy text with the async clipboard API, falling back to a temporary
 * selected textarea and `execCommand('copy')`. Returns false when both fail,
 * so the caller can show the text for manual selection.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Clipboard permission denied or document not focused; try the fallback.
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  try {
    document.body.appendChild(textarea)
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
