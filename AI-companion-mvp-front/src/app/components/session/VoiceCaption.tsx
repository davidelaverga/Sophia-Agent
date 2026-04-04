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
 * Shows the latest assistant message text as a fading caption during voice mode.
 * Matches prototype: Inter 15px weight 300, rgba(232,228,239,0.55), centered.
 * Fade-in 0.8s, hold 4s, fade-out 2s.
 */
export function VoiceCaption({ messages, isVoiceMode }: VoiceCaptionProps) {
  const { text, opacity, isVisible, showCaption, flush, transition } = useCaptionQueue()
  const lastContentRef = useRef<string>("")
  const lastMessageIdRef = useRef<string>("")

  // Track the latest assistant message and trigger captions
  useEffect(() => {
    if (!isVoiceMode) {
      flush()
      return
    }

    // Find the last assistant message
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
    if (!lastAssistant) return

    const content = lastAssistant.content?.trim()
    if (!content) return

    // Show caption when: new message arrives OR content changes (streaming)
    if (
      lastAssistant.id !== lastMessageIdRef.current ||
      content !== lastContentRef.current
    ) {
      lastMessageIdRef.current = lastAssistant.id
      lastContentRef.current = content
      showCaption(content)
    }
  }, [messages, isVoiceMode, showCaption, flush])

  if (!isVoiceMode || !isVisible) return null

  return (
    <div
      className="fixed bottom-[140px] left-1/2 -translate-x-1/2 z-30 text-center pointer-events-none max-w-[600px] w-[90vw]"
      role="status"
      aria-live="polite"
      aria-label="Voice caption"
    >
      <p
        className="font-sans text-[15px] font-light leading-[1.7] tracking-[0.01em]"
        style={{
          color: `rgba(232, 228, 239, ${opacity * 0.55})`,
          opacity,
          transition,
          textShadow: "0 1px 8px rgba(0, 0, 0, 0.3)",
        }}
      >
        {text}
      </p>
    </div>
  )
}
