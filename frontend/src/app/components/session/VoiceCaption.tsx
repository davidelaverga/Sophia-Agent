"use client"

import { useEffect, useRef } from "react"
import { useCaptionQueue } from "../../hooks/useCaptionQueue"
import type { UIMessage } from "./MessageBubble"

interface VoiceCaptionProps {
  /** All messages in the conversation */
  messages: UIMessage[]
  /** Whether currently in voice mode */
  isVoiceMode: boolean
  /** Called on mode switch voice→text to flush immediately */
  onFlush?: () => void
}

/**
 * Ephemeral voice caption — fixed bottom-center overlay.
 *
 * Shows the latest assistant AND user message text as fading captions during voice mode.
 * Sophia's responses: centered, rgba(232,228,239,0.55).
 * User's speech: centered, dimmer rgba(232,228,239,0.30), slightly smaller.
 * Fade-in 0.8s, hold 4s, fade-out 2s.
 */
export function VoiceCaption({ messages, isVoiceMode }: VoiceCaptionProps) {
  // Sophia caption (assistant messages)
  const sophia = useCaptionQueue()
  // User caption (user messages — dimmer, shorter hold)
  const user = useCaptionQueue({ holdMs: 2500 })

  const lastAssistantContentRef = useRef<string>("")
  const lastAssistantIdRef = useRef<string>("")
  const lastUserContentRef = useRef<string>("")
  const lastUserIdRef = useRef<string>("")

  // Track assistant messages
  useEffect(() => {
    if (!isVoiceMode) {
      sophia.flush()
      return
    }

    const assistantMessages = messages.filter((m) => m.role === "assistant")
    if (assistantMessages.length <= 1) return // skip initial greeting
    const last = assistantMessages[assistantMessages.length - 1]

    const content = last.content?.trim()
    if (!content) return

    if (last.id !== lastAssistantIdRef.current || content !== lastAssistantContentRef.current) {
      lastAssistantIdRef.current = last.id
      lastAssistantContentRef.current = content
      sophia.showCaption(content)
    }
  }, [messages, isVoiceMode, sophia.showCaption, sophia.flush])

  // Track user messages
  useEffect(() => {
    if (!isVoiceMode) {
      user.flush()
      return
    }

    const userMessages = messages.filter((m) => m.role === "user")
    if (userMessages.length === 0) return
    const last = userMessages[userMessages.length - 1]

    const content = last.content?.trim()
    if (!content) return

    if (last.id !== lastUserIdRef.current || content !== lastUserContentRef.current) {
      lastUserIdRef.current = last.id
      lastUserContentRef.current = content
      user.showCaption(content)
    }
  }, [messages, isVoiceMode, user.showCaption, user.flush])

  if (!isVoiceMode) return null
  if (!sophia.isVisible && !user.isVisible) return null

  return (
    <div
      className="fixed bottom-[140px] left-1/2 -translate-x-1/2 z-30 text-center pointer-events-none max-w-[600px] w-[90vw] flex flex-col items-center gap-3"
      role="status"
      aria-live="polite"
      aria-label="Voice captions"
    >
      {/* User speech — dimmer, smaller */}
      {user.isVisible && (
        <p
          className="font-sans text-[13px] font-light leading-[1.6] tracking-[0.01em]"
          style={{
            color: `rgba(232, 228, 239, ${user.opacity * 0.30})`,
            opacity: user.opacity,
            transition: user.transition,
            textShadow: "0 1px 8px rgba(0, 0, 0, 0.3)",
          }}
        >
          {user.text}
        </p>
      )}

      {/* Sophia response — brighter, larger */}
      {sophia.isVisible && (
        <p
          className="font-sans text-[15px] font-light leading-[1.7] tracking-[0.01em]"
          style={{
            color: `rgba(232, 228, 239, ${sophia.opacity * 0.55})`,
            opacity: sophia.opacity,
            transition: sophia.transition,
            textShadow: "0 1px 8px rgba(0, 0, 0, 0.3)",
          }}
        >
          {sophia.text}
        </p>
      )}
    </div>
  )
}
