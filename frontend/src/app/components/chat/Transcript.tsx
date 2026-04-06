"use client"

import { ArrowDown } from "lucide-react"
import { Fragment, useEffect, useRef, useState, useCallback, useMemo } from "react"
import type { UIEvent } from "react"
import { useShallow } from "zustand/react/shallow"

import { useCopy } from "../../copy"
import { useHaptics } from "../../hooks/useHaptics"
import { useSessionPersistence } from "../../hooks/useSessionPersistence"
import { logger } from "../../lib/error-logger"
import { formatError } from "../../lib/error-messages"
import { useChatStore } from "../../stores/chat-store"
import { selectTranscriptState } from "../../stores/selectors"
import { WelcomeBack } from "../WelcomeBack"

import { EmptyState } from "./EmptyState"
import { MessageBubble } from "./MessageBubble"
import { StreamingIndicator } from "./StreamingIndicator"

type TranscriptProps = {
  onPromptSelect: (prompt: string) => void
  compact?: boolean
}

export function Transcript({ onPromptSelect, compact }: TranscriptProps) {
  const copy = useCopy()
  const { haptic } = useHaptics()

  // Combined selector for transcript state
  const { messages, isLocked, lastError } = useChatStore(
    useShallow(selectTranscriptState)
  )
  const markAsInterrupted = useChatStore((s) => s.markAsInterrupted)
  
  // Phase 4 Week 4: Detect mid-stream restore on mount
  // If there's a streaming message but no active AbortController, it was interrupted
  const checkedForInterrupted = useRef(false)
  useEffect(() => {
    if (checkedForInterrupted.current) return
    checkedForInterrupted.current = true
    
    // Check if there's a streaming message with no abort controller
    const hasStreamingMessage = messages.some(m => m.status === "streaming")
    const abortController = useChatStore.getState().abortController
    
    if (hasStreamingMessage && !abortController) {
      logger.debug("Transcript", "Detected interrupted stream on mount, marking as interrupted")
      markAsInterrupted()
    }
  }, [messages, markAsInterrupted])
  const scrollAnchorRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [shouldStickToBottom, setShouldStickToBottom] = useState(true)
  const [showFab, setShowFab] = useState(false)
  const [showWelcome, setShowWelcome] = useState(true)
  const { restoreSession } = useSessionPersistence()
  
  const scrollToBottom = useCallback(() => {
    haptic("light")
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
    setShouldStickToBottom(true)
    setShowFab(false)
  }, [haptic])

  useEffect(() => {
    if (shouldStickToBottom) {
      scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
    }
  }, [messages.length, isLocked, shouldStickToBottom])
  
  // Hide welcome when messages exist
  useEffect(() => {
    if (messages.length > 0) {
      setShowWelcome(false)
    }
  }, [messages.length])
  
  // Listen for go-home event to show WelcomeBack again
  useEffect(() => {
    const handleGoHome = () => setShowWelcome(true)
    window.addEventListener("sophia:go-home", handleGoHome)
    return () => window.removeEventListener("sophia:go-home", handleGoHome)
  }, [])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    const isNearBottom = distanceFromBottom < 80
    setShouldStickToBottom(isNearBottom)
    // Show FAB when scrolled up and there are messages
    setShowFab(!isNearBottom && messages.length > 0)
  }, [messages.length])
  
  const handleContinue = useCallback(() => {
    restoreSession()
    setShowWelcome(false)
  }, [restoreSession])
  
  const handleStartNew = useCallback(() => {
    setShowWelcome(false)
  }, [])

  // Format error message with personality
  const errorMessage = useMemo(() => {
    if (!lastError) return null
    const formatted = formatError(copy, lastError)
    return formatted.message
  }, [copy, lastError])

  const maxHeight = compact ? "40vh" : "65vh"
  const minHeight = compact ? "200px" : "360px"

  // In compact mode (Voice Focus), don't show anything if no messages yet
  if (compact && messages.length === 0) {
    return null
  }

  return (
    <div className="relative rounded-3xl bg-sophia-surface p-4 shadow-soft">
      <div
        ref={scrollContainerRef}
        role="log"
        aria-label={copy.chat.transcriptAriaLabel}
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={isLocked}
        onScroll={handleScroll}
        className="flex flex-col gap-4 overflow-y-auto pr-2"
        style={{ maxHeight, minHeight }}
      >
        {messages.length === 0 && showWelcome ? (
          <WelcomeBack 
            onContinue={handleContinue} 
            onStartNew={handleStartNew} 
            onPromptSelect={onPromptSelect} 
          />
        ) : messages.length === 0 ? (
          <EmptyState onPromptSelect={onPromptSelect} />
        ) : (
          <Fragment>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {isLocked && <StreamingIndicator />}
          </Fragment>
        )}
        <div ref={scrollAnchorRef} />
      </div>
      {errorMessage && (
        <p className="mt-3 rounded-2xl bg-sophia-error/10 px-4 py-3 text-sm text-sophia-text" role="status">
          {errorMessage}
        </p>
      )}
      
      {/* Scroll to bottom FAB */}
      {showFab && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-6 right-6 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-sophia-purple text-white shadow-lg transition-all duration-300 hover:scale-105 hover:bg-sophia-purple/90 active:scale-95 animate-scaleIn"
          aria-label={copy.chat.scrollToBottom || "Scroll to bottom"}
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      )}
    </div>
  )
}
