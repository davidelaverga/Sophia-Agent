/**
 * Parser for incoming WebSocket voice messages from the V4 backend.
 */

export type VoiceWebSocketMessage =
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "rate_limited" }
  | { type: "barge_in_ack" }
  | { type: "unsupported_format" }
  | { type: "unknown"; raw: string }

export function parseIncomingVoiceWebSocketMessage(raw: string): VoiceWebSocketMessage {
  // Handle simple control tokens
  const trimmed = raw.trim()
  if (trimmed === "RATE_LIMITED") return { type: "rate_limited" }
  if (trimmed === "BARGE_IN_ACK") return { type: "barge_in_ack" }
  if (trimmed === "UNSUPPORTED_FORMAT") return { type: "unsupported_format" }

  // Try JSON parse
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null) {
      if (parsed.type === "error" && typeof parsed.message === "string") {
        return { type: "error", message: parsed.message }
      }
      if (parsed.type === "text" && typeof parsed.text === "string") {
        return { type: "text", text: parsed.text }
      }
      if (typeof parsed.type === "string") {
        if (parsed.type === "rate_limited") return { type: "rate_limited" }
        if (parsed.type === "barge_in_ack") return { type: "barge_in_ack" }
        if (parsed.type === "unsupported_format") return { type: "unsupported_format" }
      }
    }
  } catch {
    // Not JSON — treat as plain text
    if (trimmed.length > 0) {
      return { type: "text", text: trimmed }
    }
  }

  return { type: "unknown", raw }
}