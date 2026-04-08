"use client"

import { Send, Loader2 } from "lucide-react"
import { useCallback, useMemo, useState, useEffect, type RefObject, type KeyboardEventHandler, type ClipboardEventHandler } from "react"
import { useShallow } from "zustand/react/shallow"

import { useCopy, useTranslation } from "../../copy"
import { haptic } from "../../hooks/useHaptics"
import { getRandomPlaceholder } from "../../lib/time-greetings"
import { useChatStore } from "../../stores/chat-store"
import { getPresenceCopyKey, usePresenceStore } from "../../stores/presence-store"
import { selectComposerState, selectPresenceDisplay, selectIsModalOpen } from "../../stores/selectors"
import { useUsageLimitStore } from "../../stores/usage-limit-store"
import { InputModeIndicator } from "../InputModeIndicator"
import { UsageHint } from "../UsageHint"

type ComposerProps = {
  textareaRef: RefObject<HTMLTextAreaElement>
  onFocusChange?: (hasFocus: boolean) => void
}

export function Composer({ textareaRef, onFocusChange }: ComposerProps) {
  const copy = useCopy()
  const { t } = useTranslation()

  // Combined selectors with shallow comparison for fewer re-renders
  const { composerValue: value, setComposerValue: setValue, sendMessage, isLocked } = useChatStore(
    useShallow(selectComposerState)
  )
  const { status: presenceStatus, detail: presenceDetail } = usePresenceStore(
    useShallow(selectPresenceDisplay)
  )
  
  // Block interaction if usage limit modal is open
  const isModalOpen = useUsageLimitStore(selectIsModalOpen)

  // Random placeholder - selected once on mount for consistency during session
  const [placeholder, setPlaceholder] = useState<string>(copy.chat.placeholder)
  
  useEffect(() => {
    // Only run on client side to avoid hydration mismatch
    setPlaceholder(getRandomPlaceholder(copy))
  }, [copy])

  const MAX_CHARS = copy.chat.characterLimit.max
  const WARNING_THRESHOLD = copy.chat.characterLimit.warningThreshold

  // Character limit state
  const charCount = value.length
  const isApproachingLimit = charCount >= WARNING_THRESHOLD && charCount <= MAX_CHARS
  const isOverLimit = charCount > MAX_CHARS
  const showCounter = charCount >= WARNING_THRESHOLD

  // Determine border color based on character count
  const borderClass = useMemo(() => {
    if (isOverLimit) return "border-red-400/70 focus:border-red-400"
    if (isApproachingLimit) return "border-amber-400/70 focus:border-amber-400"
    return "border-sophia-input-border focus:border-sophia-purple/60"
  }, [isOverLimit, isApproachingLimit])

  // Counter color (MAX_CHARS is a constant, not needed in deps)
  const counterClass = useMemo(() => {
    if (isOverLimit) return "text-red-500"
    if (charCount >= MAX_CHARS - 100) return "text-amber-500"
    return "text-sophia-text2"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOverLimit, charCount])

  const handleSend = useCallback(() => {
    // Block sending if modal is open or over limit
    if (isModalOpen || isOverLimit) return
    // Haptic feedback on send
    haptic('medium')
    void sendMessage()
  }, [isModalOpen, isOverLimit, sendMessage])

  const onKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback((event) => {
    // Block keyboard interaction if modal is open
    if (isModalOpen) {
      event.preventDefault()
      return
    }
    // Block send if over limit
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (!isOverLimit) {
        handleSend()
      }
    }
  }, [isModalOpen, isOverLimit, handleSend])

  // Handle paste - prevent pasting text that would exceed limit
  const onPaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback((event) => {
    const pastedText = event.clipboardData.getData("text")
    const currentText = value
    const selectionStart = event.currentTarget.selectionStart || 0
    const selectionEnd = event.currentTarget.selectionEnd || 0
    
    // Calculate what the new text would be
    const newText = currentText.slice(0, selectionStart) + pastedText + currentText.slice(selectionEnd)
    
    // If it would exceed the limit, truncate the pasted text
    if (newText.length > MAX_CHARS) {
      event.preventDefault()
      const availableSpace = MAX_CHARS - (currentText.length - (selectionEnd - selectionStart))
      if (availableSpace > 0) {
        const truncatedPaste = pastedText.slice(0, availableSpace)
        const truncatedNewText = currentText.slice(0, selectionStart) + truncatedPaste + currentText.slice(selectionEnd)
        setValue(truncatedNewText)
      }
    }
  }, [value, setValue, MAX_CHARS])

  const handleFocus = useCallback(() => {
    onFocusChange?.(true)
  }, [onFocusChange])

  const handleBlur = useCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    // Only blur if focus is moving outside the composer area
    // Don't blur if clicking on buttons within the chat (like play audio)
    const relatedTarget = e.relatedTarget as HTMLElement
    if (relatedTarget?.closest('.composer-container')) {
      return
    }
    onFocusChange?.(false)
  }, [onFocusChange])

  return (
    <div className="space-y-2 composer-container">
      {/* Voice fallback indicator */}
      <InputModeIndicator />
      
      <div className="rounded-2xl bg-sophia-surface p-4 shadow-soft transition-all duration-300">
        <div className="flex flex-col gap-3">
          {/* Textarea with dynamic border */}
          <div className="relative">
            <textarea
              ref={textareaRef}
              rows={2}
              value={value}
              placeholder={isModalOpen ? "Please close the limit modal to continue" : placeholder}
              disabled={isLocked || isModalOpen}
              onChange={(event) => {
                if (isModalOpen) return
                setValue(event.target.value)
                // Auto-resize textarea
                const target = event.target
                target.style.height = 'auto'
                target.style.height = `${Math.min(target.scrollHeight, 150)}px`
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onFocus={handleFocus}
              onBlur={handleBlur}
              inputMode="text"
              enterKeyHint="send"
              autoComplete="off"
              autoCorrect="on"
              spellCheck="true"
              style={{ backgroundColor: 'var(--input-bg)' }}
              className={`w-full resize-none rounded-xl border px-4 py-3 text-base text-sophia-text placeholder:text-sophia-text2 outline-none transition-all duration-300 ease-out focus:shadow-sm min-h-[52px] max-h-[150px] ${borderClass} ${
                isModalOpen ? "opacity-50 cursor-not-allowed" : ""
              }`}
            />
          </div>

          {/* Character counter and limit message */}
          {showCounter && (
            <div className="flex items-center gap-2 animate-fadeIn">
              <span 
                key={charCount >= MAX_CHARS - 50 ? charCount : 'stable'}
                className={`text-xs font-medium tabular-nums transition-all duration-300 ease-out ${counterClass} ${charCount >= MAX_CHARS - 20 ? 'animate-counter-pop' : ''}`}
              >
                {charCount} / {MAX_CHARS}
              </span>
              {isOverLimit && (
                <span className="text-xs text-sophia-text2 italic">
                  — {copy.chat.characterLimit.exceeded}
                </span>
              )}
              {isApproachingLimit && !isOverLimit && charCount >= MAX_CHARS - 100 && (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  — {copy.chat.characterLimit.approaching}
                </span>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-sm text-sophia-text2 transition-all duration-300">
              {isModalOpen ? "Usage limit reached" : (presenceDetail ?? t(getPresenceCopyKey(presenceStatus)))}
            </p>
            <button
              type="button"
              onClick={handleSend}
              disabled={!value.trim() || isLocked || isModalOpen || isOverLimit}
              className="inline-flex h-12 items-center gap-2 rounded-full bg-sophia-purple px-5 text-sm font-medium text-white shadow-md transition-all duration-300 ease-out hover:scale-[1.02] hover:shadow-lg active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
            >
              {isLocked ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              <span>{isLocked ? t("chat.sending") : t("chat.send")}</span>
            </button>
          </div>
        </div>
      </div>
      <UsageHint />
    </div>
  )
}
