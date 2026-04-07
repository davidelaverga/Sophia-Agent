"use client"

import { RefreshCw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { useCopy, useTranslation } from "../../copy"
import { useChatStore } from "../../stores/chat-store"
import { usePresenceStore } from "../../stores/presence-store"

export function StreamingIndicator() {
  const copy = useCopy()
  const { t } = useTranslation()

  const presenceStatus = usePresenceStore((state) => state.status)
  const cancelStream = useChatStore((state) => state.cancelStream)
  const streamStatus = useChatStore((state) => state.streamStatus)
  const streamAttempt = useChatStore((state) => state.streamAttempt)

  // Use a deterministic initial index to keep SSR/CSR text identical during hydration.
  const [messageIndex, setMessageIndex] = useState(0)
  
  // Check if reconnecting
  const isReconnecting = streamStatus === "reconnecting"
  
  // Select a random message based on presence status
  const messages = useMemo(
    () =>
      presenceStatus === "reflecting"
        ? copy.chat.streamingMessages.reflecting
        : copy.chat.streamingMessages.thinking,
    [copy, presenceStatus],
  )

  useEffect(() => {
    if (!messages.length) return
    setMessageIndex(Math.floor(Math.random() * messages.length))
  }, [messages, presenceStatus])

  const message = useMemo(() => {
    if (!messages.length) return ""
    return messages[messageIndex % messages.length]
  }, [messages, messageIndex])
  
  // Reconnecting message with attempt count
  const reconnectMessage = useMemo(() => {
    if (!isReconnecting) return ""
    const template = t("chat.reconnectingAttempt") || "Attempt {attempt} of {max}"
    return template
      .replace("{attempt}", String(streamAttempt))
      .replace("{max}", "2") // maxRetries from stream-conversation
  }, [isReconnecting, streamAttempt, t])
  
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-sophia-text2 animate-fadeIn">
      <div className="flex items-center gap-3">
        {isReconnecting ? (
          // Reconnecting state - spinning icon
          <>
            <RefreshCw className="h-5 w-5 text-sophia-purple animate-spin" />
            <div className="flex flex-col">
              <span className="font-medium text-sophia-purple">{t("chat.reconnecting")}</span>
              <span className="text-xs text-sophia-text2">{reconnectMessage}</span>
            </div>
          </>
        ) : (
          // Normal streaming state - dots animation
          <>
            <div className="flex gap-2">
              <span 
                className="inline-block h-3 w-3 rounded-full bg-gradient-to-br from-sophia-purple to-sophia-glow animate-glowBreathe" 
                style={{ animationDelay: "0ms" }} 
              />
              <span 
                className="inline-block h-3 w-3 rounded-full bg-gradient-to-br from-sophia-purple to-sophia-glow animate-glowBreathe" 
                style={{ animationDelay: "400ms" }} 
              />
              <span 
                className="inline-block h-3 w-3 rounded-full bg-gradient-to-br from-sophia-purple to-sophia-glow animate-glowBreathe" 
                style={{ animationDelay: "800ms" }} 
              />
            </div>
            <span className="animate-pulse">{message}</span>
          </>
        )}
      </div>
      {!isReconnecting && (
        <button
          type="button"
          onClick={cancelStream}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-sophia-text2 transition-all hover:bg-sophia-surface hover:text-sophia-purple hover:shadow-sm active:scale-95"
          aria-label={t("chat.cancelResponseAriaLabel")}
        >
          {t("chat.cancel")}
        </button>
      )}
    </div>
  )
}
