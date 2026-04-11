/**
 * Conversation Response Route - Adapted for V4 Backend
 * =====================================================
 * 
 * This route proxies chat requests to the LangGraph v4 backend.
 * 
 * Key Changes from V1:
 * - V4 backend returns JSON (not SSE streaming)
 * - We simulate streaming in frontend for UX continuity
 * - Removed dependency on /text-chat/stream endpoint
 * 
 * Backend Endpoint Used:
 * - POST /api/v4/chat
 */

import { type NextRequest, NextResponse } from "next/server"

import { getUserScopedAuthToken } from "../../../lib/auth/server-auth"

// ============================================================================
// TYPES
// ============================================================================

interface V1ChatRequest {
  message: string
  session_id?: string
  metadata?: Record<string, unknown>
}

interface V1ChatResponse {
  session_id: string
  response: string
  emotion?: {
    label: string
    confidence: number
  }
  timestamp: number
  tokens_used?: number
  artifacts?: {
    takeaway?: string
    reflection_candidate?: string | { prompt?: string; why?: string }
    memory_candidates?: Array<{ content?: string; text?: string; tags?: string[] }>
  }
}

// Keep V4 types for compatibility
interface V4ChatResponse {
  response: string
  skill_used: string
  skill_reasoning: string
  suggested_skill: string
  llm_provider: string
  emotion_detected: string
  memories_count: number
  crisis_detected: boolean
  processing_time_ms: number
  graph_nodes_executed: string[]
}

interface ClientRequest {
  message: string
  conversationId?: string
  user_id?: string
}

// ============================================================================
// SSE HELPERS
// ============================================================================

const encoder = new TextEncoder()

function formatSSE(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data)
  return `event: ${event}\ndata: ${payload}\n\n`
}

/**
 * Simulates token-by-token streaming from a complete response.
 * This maintains the typing animation UX while using a JSON backend.
 * 
 * Strategy:
 * - Split response into words (more natural than characters)
 * - Send in small chunks with minimal delay
 * - Much faster than real streaming, feels instant but animated
 */
function* tokenizeResponse(text: string): Generator<string> {
  // Split by spaces but preserve punctuation
  const tokens = text.split(/(\s+)/)
  
  for (const token of tokens) {
    if (token) {
      yield token
    }
  }
}

function extractJsonObject(input: string): Record<string, unknown> | null {
  const start = input.indexOf("{")
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < input.length; index += 1) {
    const char = input[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed = JSON.parse(input.slice(start, index + 1))
          return typeof parsed === "object" && parsed ? parsed as Record<string, unknown> : null
        } catch {
          return null
        }
      }
    }
  }

  return null
}

function normalizeArtifacts(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null
  const payload = raw as Record<string, unknown>
  const normalized: Record<string, unknown> = {}

  if (typeof payload.takeaway === "string" && payload.takeaway.trim()) {
    normalized.takeaway = payload.takeaway.trim()
  }

  const reflection = payload.reflection_candidate
  if (typeof reflection === "string" && reflection.trim()) {
    normalized.reflection_candidate = reflection.trim()
  } else if (reflection && typeof reflection === "object") {
    const rc = reflection as Record<string, unknown>
    const prompt = typeof rc.prompt === "string" ? rc.prompt.trim() : ""
    const why = typeof rc.why === "string" ? rc.why.trim() : ""
    if (prompt || why) {
      normalized.reflection_candidate = { ...(prompt ? { prompt } : {}), ...(why ? { why } : {}) }
    }
  }

  if (Array.isArray(payload.memory_candidates)) {
    const memories = payload.memory_candidates
      .map((item) => {
        if (!item || typeof item !== "object") return null
        const record = item as Record<string, unknown>
        const content = typeof record.content === "string"
          ? record.content
          : typeof record.text === "string"
            ? record.text
            : ""
        if (!content.trim()) return null
        return { content: content.trim() }
      })
      .filter((item) => item !== null)

    if (memories.length > 0) {
      normalized.memory_candidates = memories
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null
}

function sanitizeResponse(responseText: string): { text: string; artifacts: Record<string, unknown> | null } {
  const normalized = (responseText || "").replace(/\r\n/g, "\n")
  const markers = ["---ARTIFACTS---", "ARTIFACTS_JSON:"]
  const indexes = markers.map((marker) => normalized.indexOf(marker)).filter((index) => index >= 0)
  const splitIndex = indexes.length > 0 ? Math.min(...indexes) : -1

  const responsePart = splitIndex >= 0 ? normalized.slice(0, splitIndex).trimEnd() : normalized.trim()
  const artifactsPart = splitIndex >= 0 ? normalized.slice(splitIndex) : ""

  let cleaned = responsePart
    .replace(/^\s*(USER(?:\s*_?\s*MESSAGE)?|SYSTEM|INPUT|PROMPT|CONTEXT)\s*:\s*.*\n?/gim, "")
    .trim()

  const assistantMatch = cleaned.match(/\bASSISTANT\s*:\s*/i)
  if (assistantMatch?.index !== undefined) {
    cleaned = cleaned.slice(assistantMatch.index + assistantMatch[0].length).trim()
  }

  const parsedArtifacts = normalizeArtifacts(extractJsonObject(artifactsPart))
  return { text: cleaned, artifacts: parsedArtifacts }
}


// ============================================================================
// MAIN HANDLER
// ============================================================================

export async function POST(request: NextRequest) {
  // 1. Validate Configuration
  const apiBase = process.env.BACKEND_API_URL

  if (!apiBase) {
    return NextResponse.json(
      { error: "Server configuration incomplete" },
      { status: 500 }
    )
  }

  const apiKey = await getUserScopedAuthToken()
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 }
    )
  }

  // 2. Parse Request
  let body: ClientRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    )
  }

  if (!body.message?.trim()) {
    return NextResponse.json(
      { error: "Missing message" },
      { status: 400 }
    )
  }

  const conversationId = body.conversationId || crypto.randomUUID()
  const sessionId = conversationId

  // 4. Call V1 Backend (JSON response with usage tracking)
  let backendData: V1ChatResponse
  try {
    const backendUrl = `${apiBase.replace(/\/$/, '')}/api/v1/chat/text`
    
    const v1Request: V1ChatRequest = {
      message: body.message,
      session_id: sessionId,
    }

    const backendResponse = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(v1Request),
    })

    if (!backendResponse.ok) {
      if (backendResponse.status === 429 || backendResponse.status === 403) {
        const errorPayload = await backendResponse.json().catch(() => ({} as Record<string, unknown>))
        const detail =
          (typeof errorPayload.detail === "string" && errorPayload.detail) ||
          (typeof errorPayload.error === "string" && errorPayload.error) ||
          `Backend error: ${backendResponse.status}`

        return NextResponse.json(
          {
            error: "USAGE_LIMIT_REACHED",
            code: "RATE_LIMIT_EXCEEDED",
            reason: detail.toLowerCase().includes("voice") ? "voice" : "text",
            message: detail,
            conversationId,
          },
          { status: backendResponse.status }
        )
      }

      // Return error as SSE stream for client compatibility
      return createErrorStream(conversationId, `Backend error: ${backendResponse.status}`)
    }

    backendData = await backendResponse.json()

  } catch (error) {
    return createErrorStream(
      conversationId,
      error instanceof Error ? error.message : "Backend unavailable"
    )
  }

  // 5. Create SSE Stream (simulated from JSON response)
  // Convert V1 response to V4 format for stream compatibility
  const { text: cleanedResponse, artifacts: extractedArtifacts } = sanitizeResponse(backendData.response)

  const v4CompatibleData: V4ChatResponse = {
    response: cleanedResponse,
    skill_used: "",
    skill_reasoning: "",
    suggested_skill: "",
    llm_provider: "",
    emotion_detected: backendData.emotion?.label || "neutral",
    memories_count: 0,
    crisis_detected: false,
    processing_time_ms: 0,
    graph_nodes_executed: [],
  }
  const stream = createChatStream(conversationId, {
    ...v4CompatibleData,
    response: cleanedResponse,
    extractedArtifacts,
  } as V4ChatResponse & { extractedArtifacts?: Record<string, unknown> | null })

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

// ============================================================================
// STREAM CREATORS
// ============================================================================

/**
 * Creates an SSE stream that simulates token-by-token delivery
 * from a complete JSON response.
 */
function createChatStream(
  conversationId: string,
  data: V4ChatResponse & { extractedArtifacts?: Record<string, unknown> | null }
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const enqueue = (event: string, payload: unknown) => {
        try {
          if (controller.desiredSize !== null) {
            controller.enqueue(encoder.encode(formatSSE(event, payload)))
          }
        } catch {
          // Stream closed, ignore
        }
      }

      // 1. Send initial meta (listening state)
      enqueue("meta", {
        conversationId,
        presence: { status: "listening" },
      })

      // 2. Small delay to simulate "thinking"
      await delay(100)
      enqueue("meta", {
        conversationId,
        presence: { status: "thinking" },
      })

      // 3. Stream tokens (fast, word-by-word)
      // Backend now handles artifact filtering
      const responseText = data.response || ""
      const tokens = Array.from(tokenizeResponse(responseText))
      for (const token of tokens) {
        enqueue("token", token)
        // Minimal delay between tokens for smooth animation
        await delay(15)
      }

      // 4. Send reflecting state
      await delay(50)
      enqueue("meta", {
        conversationId,
        presence: { status: "reflecting" },
      })

      // 5. Send completion with full response
      enqueue("done", {
        conversationId,
        message: responseText,
        artifacts: data.extractedArtifacts || null,
        skill_used: data.skill_used,
        emotion_detected: data.emotion_detected,
        crisis_detected: data.crisis_detected,
        llm_provider: data.llm_provider,
        // Note: No audio_url from v4/chat - voice uses different endpoint
      })

      // 6. Final state
      enqueue("meta", {
        conversationId,
        presence: { status: "resting" },
      })

      controller.close()
    },
  })
}

/**
 * Creates an SSE stream that delivers an error message.
 */
function createErrorStream(conversationId: string, message: string): NextResponse {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(formatSSE("error", { message, conversationId }))
      )
      controller.enqueue(
        encoder.encode(formatSSE("meta", {
          conversationId,
          presence: { status: "resting" },
        }))
      )
      controller.close()
    },
  })

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  })
}

// ============================================================================
// UTILITIES
// ============================================================================

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
