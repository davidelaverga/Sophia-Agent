"use client"

import { useConsentStore } from "../stores/consent-store"
import { debugLog, debugWarn } from "./debug-logger"

type TelemetryEvent = {
  name: string
  payload?: Record<string, unknown>
  timestamp: number
}

const TELEMETRY_ENDPOINT =
  typeof window !== "undefined" ? process.env.NEXT_PUBLIC_TELEMETRY_URL ?? "" : ""

const queue: TelemetryEvent[] = []
const BATCH_DELAY_MS = 5000
let flushTimer: number | null = null

const flushQueue = (opts?: { sync?: boolean }) => {
  if (!queue.length) return
  if (!TELEMETRY_ENDPOINT) {
    if (process.env.NODE_ENV !== "production") {
      debugLog("telemetry", "queued events", queue)
    }
    queue.length = 0
    return
  }
  const batch = queue.splice(0, queue.length)
  const body = JSON.stringify({ events: batch })

  if (opts?.sync && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      navigator.sendBeacon(TELEMETRY_ENDPOINT, body)
      return
    } catch {
      // fallthrough to fetch
    }
  }

  fetch(TELEMETRY_ENDPOINT, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
    },
    keepalive: true,
  }).catch((error) => {
    debugWarn("telemetry", "send failed", { error })
  })
}

const scheduleFlush = () => {
  if (flushTimer !== null) return
  if (typeof window === "undefined") return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    flushQueue()
    if (queue.length > 0) {
      scheduleFlush()
    }
  }, BATCH_DELAY_MS)
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        flushQueue({ sync: true })
      }
    },
    { passive: true },
  )
  window.addEventListener(
    "pagehide",
    () => {
      flushQueue({ sync: true })
    },
    { passive: true },
  )
}

export const emitTelemetry = (name: string, payload?: Record<string, unknown>) => {
  if (typeof window === "undefined") return
  // 🔒 PRIVACY: Respect user's analytics consent preference
  if (!useConsentStore.getState().analytics) return
  queue.push({
    name,
    payload,
    timestamp: Date.now(),
  })
  scheduleFlush()
}

export const emitTiming = (
  name: string,
  startedAtMs: number,
  payload?: Record<string, unknown>,
) => {
  if (!Number.isFinite(startedAtMs)) return
  const durationMs = Math.max(0, Date.now() - startedAtMs)
  emitTelemetry(name, {
    ...payload,
    duration_ms: durationMs,
  })
}

