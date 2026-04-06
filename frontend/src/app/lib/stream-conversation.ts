import type { UsageLimitError } from "../types/rate-limits"

import { debugLog, debugWarn } from "./debug-logger"
import { parseUsageLimitPayload, toUsageLimitError } from "./usage-limit-parser"

type StreamHandlers = {
  onToken?: (token: string) => void
  onMeta?: (payload: Record<string, unknown>) => void
  onDone?: (payload?: Record<string, unknown>) => void
  onError?: (payload?: { message?: string }) => void
  onUsageLimit?: (error: UsageLimitError) => void
  onCancel?: () => void
  // Phase 4 Week 4: Reconnect callbacks
  onReconnecting?: (attempt: number, maxRetries: number) => void
  onReconnected?: () => void
}

export type StreamConversationOptions = {
  body: Record<string, unknown>
  url?: string
  headers?: HeadersInit
  maxRetries?: number
  signal?: AbortSignal
}

const defaultUrl = "/api/conversation/respond"
const defaultHeaders: HeadersInit = {
  "Content-Type": "application/json",
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const safeJsonParse = (input: string) => {
  try {
    return JSON.parse(input)
  } catch (error) {
    debugWarn("conversation", "Failed to parse SSE payload", { error })
    return undefined
  }
}

const extractTextFromPayload = (payload: unknown): string | undefined => {
  if (!payload) return undefined
  if (typeof payload === "string") return payload
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>
    const candidate = record.reply ?? record.message ?? record.text ?? record.content
    return typeof candidate === "string" ? candidate : undefined
  }
  return undefined
}

const deliverJsonPayload = (payload: unknown, handlers: StreamHandlers) => {
  if (typeof payload === "undefined" || payload === null) return
  const derivedText = extractTextFromPayload(payload)
  if (derivedText) {
    handlers.onToken?.(derivedText)
  }
  if (typeof payload === "object") {
    handlers.onDone?.(payload as Record<string, unknown>)
  } else {
    handlers.onDone?.({ raw: payload })
  }
}

const requestJsonFallback = async (
  url: string,
  body: Record<string, unknown>,
  headers: HeadersInit | undefined,
  handlers: StreamHandlers,
) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...defaultHeaders, ...headers, Accept: "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) return false
    const payload = await response.json().catch(() => undefined)
    if (typeof payload === "undefined") return false
    deliverJsonPayload(payload, handlers)
    return true
  } catch (error) {
    debugWarn("conversation", "JSON fallback failed", { error })
    return false
  }
}

async function readStream(reader: ReadableStreamDefaultReader<Uint8Array>, handlers: StreamHandlers) {
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let currentEvent: string | null = null
  let currentData: string[] = []

  const flush = () => {
    if (!currentEvent) {
      currentData = []
      return
    }
    const payload = currentData.join("\n")

    switch (currentEvent) {
      case "token":
        handlers.onToken?.(payload)
        break
      case "meta":
        handlers.onMeta?.(safeJsonParse(payload) ?? { raw: payload })
        break
      case "done":
        handlers.onDone?.(safeJsonParse(payload) ?? { raw: payload })
        break
      case "error": {
        const errorPayload = safeJsonParse(payload) ?? { message: payload }
        const parsedUsageLimit = parseUsageLimitPayload(errorPayload)
        if (parsedUsageLimit) {
          handlers.onUsageLimit?.(toUsageLimitError(parsedUsageLimit))
        } else {
          handlers.onError?.(errorPayload)
        }
        break
      }
      default:
        debugLog("conversation", "Unhandled SSE event", { currentEvent })
        break
    }

    currentEvent = null
    currentData = []
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      flush()
      break
    }

    buffer += decoder.decode(value, { stream: true })
    let newlineIndex: number

    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)

      if (line.startsWith("event:")) {
        flush()
        currentEvent = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        currentData.push(line.slice(5).trim())
      } else if (line.trim() === "") {
        flush()
      } else {
        currentData.push(line)
      }
    }
  }
}

export async function streamConversation(options: StreamConversationOptions, handlers: StreamHandlers = {}) {
  const { body, headers, maxRetries = 2, url = defaultUrl, signal } = options

  let attempt = 0
  let lastError: unknown

  while (attempt <= maxRetries) {
    // Check if cancelled before attempting
    if (signal?.aborted) {
      handlers.onCancel?.()
      return undefined
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...defaultHeaders, ...headers },
        body: JSON.stringify(body),
        signal,
      })

      const contentType = response.headers.get("content-type") ?? ""

      if (!response.ok) {
        // Check if it's a usage limit error before fallback
        if (response.status === 429 || response.status === 403) {
          const errorData = await response.json().catch(() => null)
          const parsedUsageLimit = parseUsageLimitPayload(errorData, response.status)
          if (parsedUsageLimit) {
            handlers.onUsageLimit?.(toUsageLimitError(parsedUsageLimit))
            return undefined
          }
        }
        const handled = await requestJsonFallback(url, body, headers, handlers)
        if (handled) {
          lastError = undefined
          break
        }
        throw new Error(`Conversation request failed: ${response.status} ${response.statusText}`)
      }

      if (contentType.includes("application/json")) {
        const payload = await response.json().catch(() => undefined)
        if (typeof payload === "undefined") {
          throw new Error("Conversation returned invalid JSON payload")
        }
        deliverJsonPayload(payload, handlers)
        lastError = undefined
        break
      }

      if (!response.body) {
        const handled = await requestJsonFallback(url, body, headers, handlers)
        if (handled) {
          lastError = undefined
          break
        }
        throw new Error("Conversation stream unavailable")
      }

      const reader = response.body.getReader()
      await readStream(reader, handlers)
      lastError = undefined
      // Phase 4 Week 4: Signal reconnected if this was a retry
      if (attempt > 0) {
        handlers.onReconnected?.()
      }
      break
    } catch (error) {
      // Handle abort gracefully - not an error
      if (error instanceof DOMException && error.name === "AbortError") {
        handlers.onCancel?.()
        return undefined
      }
      
      lastError = error
      if (attempt === maxRetries) {
        const handled = await requestJsonFallback(url, body, headers, handlers)
        if (handled) {
          lastError = undefined
          break
        }
        handlers.onError?.({ message: error instanceof Error ? error.message : "Unknown streaming error" })
        throw error
      }
      attempt += 1
      // Phase 4 Week 4: Notify about reconnect attempt
      handlers.onReconnecting?.(attempt, maxRetries)
      await sleep(300 * attempt)
    }
  }

  return lastError
}
