"use client"

import { Volume2, Square, Mic, Check } from "lucide-react"
import { memo, useState, useRef, useEffect, useCallback } from "react"

import { useCopy, useTranslation } from "../../copy"
import { useHaptics } from "../../hooks/useHaptics"
import { debugWarn } from "../../lib/debug-logger"
import { errorCopy } from "../../lib/error-copy"
import type { ChatMessage } from "../../stores/chat-store"
import { useChatStore } from "../../stores/chat-store"
import { FeedbackStrip } from "../FeedbackStrip"
import { RetryAction } from "../ui/RetryAction"

export const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const copy = useCopy()
  const { t } = useTranslation()
  const { haptic } = useHaptics()
  const retryStream = useChatStore((s) => s.retryStream)
  const dismissInterrupted = useChatStore((s) => s.dismissInterrupted)

  const isUser = message.role === "user"
  const alignment = isUser ? "justify-end" : "justify-start"
  
  // Determine bubble style based on status
  const isCancelledOrInterrupted = message.status === "cancelled" || message.status === "interrupted"
  const bubbleClasses = isUser
    ? "bg-sophia-user text-sophia-text"
    : message.status === "error"
      ? "bg-sophia-error/10 text-sophia-text"
      : isCancelledOrInterrupted
        ? "bg-sophia-surface-alt border border-dashed border-sophia-text2/30 text-sophia-text2"
        : "bg-sophia-reply text-sophia-text"

  const [isPlaying, setIsPlaying] = useState(false)
  const [copied, setCopied] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  
  // Long-press to copy
  const handleTouchStart = useCallback(() => {
    longPressRef.current = setTimeout(() => {
      if (!message.content) {
        return
      }

      void navigator.clipboard.writeText(message.content)
        .then(() => {
          haptic("success")
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
        .catch(() => {
          haptic("error")
        })
    }, 500) // 500ms long-press
  }, [message.content, haptic])
  
  const handleTouchEnd = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
  }, [])
  
  const handleTouchMove = useCallback(() => {
    // Cancel long-press if user moves finger
    if (longPressRef.current) {
      clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
  }, [])

  const handleAudio = useCallback(async () => {
    if (!message.audioUrl) return
    
    // If already playing, stop it
    if (isPlaying && audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      setIsPlaying(false)
      return
    }

    try {
      // Stop any other audio that might be playing
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
      }

      const audio = new Audio(message.audioUrl)
      audioRef.current = audio
      
      audio.onplay = () => setIsPlaying(true)
      audio.onended = () => {
        setIsPlaying(false)
        audioRef.current = null
      }
      audio.onerror = () => {
        setIsPlaying(false)
        audioRef.current = null
        debugWarn("conversation", "Audio playback failed")
      }
      audio.onpause = () => {
        if (audio.currentTime === 0) {
          setIsPlaying(false)
        }
      }

      await audio.play()
    } catch (error) {
      debugWarn("conversation", "Audio playback failed", { error })
      setIsPlaying(false)
      audioRef.current = null
    }
  }, [message.audioUrl, isPlaying])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  // Determine if Sophia is actively streaming this message
  const isStreaming = !isUser && message.status === "streaming"

  return (
    <div
      className={`flex w-full gap-3 ${alignment} animate-fadeIn`}
      role="article"
      aria-label={isUser ? t("chat.aria.youSaid") : t("chat.aria.sophiaReplied")}
    >
      {!isUser && (
        <div className={`mt-1 flex h-8 w-8 sm:h-10 sm:w-10 flex-shrink-0 items-center justify-center rounded-full ${isCancelledOrInterrupted ? 'bg-sophia-text2/20' : 'bg-sophia-purple'} text-xs sm:text-sm font-semibold text-white shadow-md transition-all duration-300 ${isStreaming ? 'animate-pulse-reply' : 'animate-breatheSlow'}`}>
          {copy.brand.initial}
        </div>
      )}
      <div className="max-w-[85%] xs:max-w-[80%] space-y-2 min-w-0">
        <div 
          className={`relative rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-soft/30 transition-all duration-300 ease-out select-none ${bubbleClasses} ${copied ? 'ring-2 ring-sophia-purple/50' : ''}`}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchMove}
          onTouchCancel={handleTouchEnd}
        >
          {/* Copied indicator */}
          {copied && (
            <div className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-sophia-purple text-white shadow-md animate-scaleIn">
              <Check className="h-3.5 w-3.5" />
            </div>
          )}
          <div className="flex items-start gap-2">
            {message.source === "voice" && (
              <Mic className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${isUser ? "text-sophia-text/50" : "text-sophia-purple/70"}`} />
            )}
            <span className="flex-1">
              {/* Cancelled/Interrupted state */}
              {isCancelledOrInterrupted ? (
                <span className="italic text-sophia-text2">
                  {message.status === "cancelled" ? t("chat.cancelled") : t("chat.interrupted")}
                </span>
              ) : (
                message.content || <span className="text-sophia-text2 animate-breathe">{t("chat.loading")}</span>
              )}
            </span>
          </div>
        </div>
        
        {/* Retry/Dismiss buttons for cancelled/interrupted */}
        {isCancelledOrInterrupted && (
          <RetryAction
            message={message.status === "interrupted" ? errorCopy.responseInterrupted : errorCopy.responseCancelled}
            onRetry={() => {
              haptic("light")
              retryStream()
            }}
            onDismiss={() => {
              haptic("light")
              dismissInterrupted()
            }}
          />
        )}
        
        {!isUser && message.turnId && !isCancelledOrInterrupted && <FeedbackStrip turnId={message.turnId} />}
        {message.audioUrl && !isCancelledOrInterrupted && (
          <button
            type="button"
            onClick={handleAudio}
            onMouseDown={(e) => e.preventDefault()} // Prevent focus loss
            className="flex items-center gap-2 text-xs font-medium text-sophia-purple transition-all duration-300 hover:scale-105 hover:text-sophia-purple/80 active:scale-95"
          >
            {isPlaying ? (
              <>
                <Square className="h-4 w-4 fill-current" />
                <span>{t("chat.stopAudio")}</span>
              </>
            ) : (
              <>
                <Volume2 className="h-4 w-4" />
                {t("chat.audioButton")}
              </>
            )}
          </button>
        )}
      </div>
      {isUser && (
        <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-full border border-sophia-surface-border text-base">
          👤
        </div>
      )}
    </div>
  )
})
