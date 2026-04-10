/**
 * Browser Audio Unlock Utility
 * ============================
 *
 * All modern browsers (Chrome, Safari, Firefox) block audio playback until
 * an AudioContext is created/resumed during a user gesture (click/tap).
 *
 * Call `unlockAudioPlayback()` synchronously from a click handler — before
 * any `await` — to unlock the page's audio policy. Once unlocked, all
 * subsequent `<audio autoplay>` elements and WebRTC audio tracks will play.
 *
 * This is idempotent and safe to call multiple times.
 */

import { getAudioContextClass } from "../hooks/voice/voice-utils"

let _ctx: AudioContext | null = null

/**
 * Unlock browser audio playback by creating/resuming an AudioContext
 * during a user gesture. Must be called synchronously from a click handler,
 * BEFORE any async work (fetch, setState, etc.).
 */
export function unlockAudioPlayback(): void {
  try {
    const AudioCtx = getAudioContextClass()

    if (!_ctx || _ctx.state === "closed") {
      _ctx = new AudioCtx()
    }

    if (_ctx.state === "suspended") {
      // Fire-and-forget: the synchronous constructor call above is what
      // registers the user gesture. resume() confirms it asynchronously.
      void _ctx.resume()
    }
  } catch {
    // Best-effort: if AudioContext creation fails, Stream SDK may still
    // handle audio via its own unlock mechanism.
  }
}
