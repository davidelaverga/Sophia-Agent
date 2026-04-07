"use client"

import { Eye, EyeOff } from "lucide-react"
import { useRef, useEffect, useState, useMemo, useCallback, memo } from "react"

import { useCopy, useTranslation } from "../copy"
import { useChatStore } from "../stores/chat-store"
import type { ChatMessage } from "../stores/chat-store"

import { MessageBubble } from "./chat/MessageBubble"

const STORAGE_KEY = "sophia-voice-transcript-visible"

type VoiceTranscriptProps = {
  partialReply?: string
  finalReply?: string
}

export const VoiceTranscript = memo(function VoiceTranscript({ partialReply, finalReply: _finalReply }: VoiceTranscriptProps) {
  const copy = useCopy()
  const { t } = useTranslation()

  // Use unified chat store for seamless context
  const allMessages = useChatStore((state) => state.messages)
  const scrollRef = useRef<HTMLDivElement>(null)
  
  // State for showing/hiding transcript
  const [isVisible, setIsVisible] = useState(true)
  
  // Load visibility preference from localStorage
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored !== null) {
        setIsVisible(stored === "true")
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [])
  
  // Memoize toggle function to prevent re-creation on every render
  const toggleVisibility = useCallback(() => {
    setIsVisible((prev) => {
      const newValue = !prev
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(STORAGE_KEY, String(newValue))
        } catch {
          // Ignore localStorage errors
        }
      }
      return newValue
    })
  }, [])
  
  // Memoize filtered messages - show voice messages from both user and Sophia
  const voiceMessages = useMemo(
    () => allMessages.filter((msg) => msg.source === "voice"),
    [allMessages]
  )

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [voiceMessages.length, partialReply])

  // Only show partialReply as "active" (streaming)
  // finalReply is already saved in history, so don't show it separately
  // Also don't show activeReply if it matches the last message in history (already added)
  const lastVoiceMessage = voiceMessages[voiceMessages.length - 1]
  const isReplyAlreadyInHistory = lastVoiceMessage?.role === "sophia" && 
    lastVoiceMessage?.content === partialReply
  const activeReply = isReplyAlreadyInHistory ? undefined : partialReply

  // Don't show anything if no history and no current reply
  if (voiceMessages.length === 0 && !activeReply) {
    return null
  }

  return (
    <div className="rounded-2xl bg-sophia-surface p-4 shadow-sm border border-sophia-surface-border animate-fadeIn">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-sophia-purple animate-breathe" />
          <p className="text-xs font-medium text-sophia-purple uppercase tracking-wide">
            {copy.chat.transcriptLabel}
          </p>
        </div>
        
        {/* Subtle toggle button */}
        <button
          type="button"
          onClick={toggleVisibility}
          className="rounded-lg p-1.5 text-sophia-text2 transition-all hover:bg-sophia-purple/10 hover:text-sophia-purple active:scale-95"
          aria-label={isVisible ? t("voiceTranscript.toggleHide") : t("voiceTranscript.toggleShow")}
          title={isVisible ? t("voiceTranscript.toggleHide") : t("voiceTranscript.toggleShow")}
        >
          {isVisible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {isVisible && (
        <div
          ref={scrollRef}
          className="space-y-4 max-h-[280px] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-sophia-purple/20 scrollbar-track-transparent animate-fadeIn"
        >
        {/* Voice conversation history - reuse MessageBubble for consistency */}
        {voiceMessages.map((message: ChatMessage) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {/* Current streaming reply (only while streaming, not final) */}
        {activeReply && (
          <MessageBubble 
            message={{
              id: "streaming-reply",
              role: "sophia",
              content: activeReply,
              source: "voice",
              status: "streaming",
              createdAt: Date.now(),
            }} 
          />
        )}
      </div>
      )}
    </div>
  )
})

