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
 * Sophia's responses: centered, brighter cosmic text.
 * User's speech: centered, dimmer cosmic text, slightly smaller.
 * Fade-in 0.8s, hold 4s, fade-out 2s.
 */
export function VoiceCaption({ messages, isVoiceMode }: VoiceCaptionProps) {
  // Sophia caption (assistant messages)
  const {
    flush: flushSophiaCaption,
    isVisible: isSophiaVisible,
    opacity: sophiaOpacity,
    showCaption: showSophiaCaption,
    text: sophiaText,
    transition: sophiaTransition,
  } = useCaptionQueue()
  // User caption (user messages — dimmer, shorter hold)
  const {
    flush: flushUserCaption,
    isVisible: isUserVisible,
    opacity: userOpacity,
    showCaption: showUserCaption,
    text: userText,
    transition: userTransition,
  } = useCaptionQueue({ holdMs: 2500 })

  const lastAssistantContentRef = useRef<string>("")
  const lastAssistantIdRef = useRef<string>("")
  const lastUserContentRef = useRef<string>("")
  const lastUserIdRef = useRef<string>("")
  // Snapshot message count at the moment voice mode activates
  // so we don't replay text-mode messages as voice captions
  const voiceEntryCountRef = useRef<{ assistant: number; user: number }>({ assistant: 0, user: 0 })
  const prevVoiceModeRef = useRef(isVoiceMode)

  // When switching TO voice, record how many messages already exist
  useEffect(() => {
    if (isVoiceMode && !prevVoiceModeRef.current) {
      voiceEntryCountRef.current = {
        assistant: messages.filter((m) => m.role === "assistant").length,
        user: messages.filter((m) => m.role === "user").length,
      }
    }
    prevVoiceModeRef.current = isVoiceMode
  }, [isVoiceMode, messages])

  // Track assistant messages
  useEffect(() => {
    if (!isVoiceMode) {
      flushSophiaCaption()
      return
    }

    const assistantMessages = messages.filter((m) => m.role === "assistant")
    if (assistantMessages.length <= 1) return // skip initial greeting
    // Only show captions for messages that arrived AFTER entering voice mode
    if (assistantMessages.length <= voiceEntryCountRef.current.assistant) return
    const last = assistantMessages[assistantMessages.length - 1]

    const content = last.content?.trim()
    if (!content) return

    if (last.id !== lastAssistantIdRef.current || content !== lastAssistantContentRef.current) {
      lastAssistantIdRef.current = last.id
      lastAssistantContentRef.current = content
      showSophiaCaption(content)
    }
  }, [flushSophiaCaption, isVoiceMode, messages, showSophiaCaption])

  // Track user messages
  useEffect(() => {
    if (!isVoiceMode) {
      flushUserCaption()
      return
    }

    const userMessages = messages.filter((m) => m.role === "user")
    if (userMessages.length === 0) return
    // Only show captions for messages that arrived AFTER entering voice mode
    if (userMessages.length <= voiceEntryCountRef.current.user) return
    const last = userMessages[userMessages.length - 1]

    const content = last.content?.trim()
    if (!content) return

    if (last.id !== lastUserIdRef.current || content !== lastUserContentRef.current) {
      lastUserIdRef.current = last.id
      lastUserContentRef.current = content
      showUserCaption(content)
    }
  }, [flushUserCaption, isVoiceMode, messages, showUserCaption])

  if (!isVoiceMode) return null
  if (!isSophiaVisible && !isUserVisible) return null

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-20 text-center pointer-events-none max-w-[600px] w-[90vw] flex flex-col items-center gap-3 transition-[bottom] duration-700 ease-out"
      style={{ bottom: 'var(--voice-caption-bottom, 140px)' }}
      role="status"
      aria-live="polite"
      aria-label="Voice captions"
    >
      {/* User speech — dimmer, smaller */}
      {isUserVisible && (
        <p
          className="font-sans text-[13px] font-light leading-[1.6] tracking-[0.01em]"
          style={{
            color: `color-mix(in srgb, var(--cosmic-text) ${userOpacity * 30}%, transparent)`,
            opacity: userOpacity,
            transition: userTransition,
            textShadow: '0 1px 8px color-mix(in srgb, var(--bg) 30%, transparent)',
          }}
        >
          {userText}
        </p>
      )}

      {/* Sophia response — brighter, larger */}
      {isSophiaVisible && (
        <p
          className="font-sans text-[15px] font-light leading-[1.7] tracking-[0.01em]"
          style={{
            color: `color-mix(in srgb, var(--cosmic-text-strong) ${sophiaOpacity * 55}%, transparent)`,
            opacity: sophiaOpacity,
            transition: sophiaTransition,
            textShadow: '0 1px 8px color-mix(in srgb, var(--bg) 30%, transparent)',
          }}
        >
          {sophiaText}
        </p>
      )}
    </div>
  )
}
