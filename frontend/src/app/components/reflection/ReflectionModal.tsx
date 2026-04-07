"use client"

import { Sparkles, Heart, Send, Check, Loader2, X, ChevronDown, RefreshCw, Quote, Eye, Shield } from "lucide-react"
import { useEffect, useMemo, useState, useCallback } from "react"

import { useTranslation } from "../../copy"
import { useFocusTrap } from "../../hooks/useFocusTrap"
import { type ReflectionChunk } from "../../hooks/useReflectionPrompt"
import { createReflection, type ReflectionAction } from "../../lib/api/reflections"
import { emitTelemetry } from "../../lib/telemetry"

type ReflectionModalProps = {
  conversationId: string
  chunks: ReflectionChunk[]
  onClose: () => void
}

type SubmitState = "idle" | "saving" | "sharing" | "success" | "error"
type ViewMode = "select" | "preview"

export function ReflectionModal({ conversationId, chunks, onClose }: ReflectionModalProps) {
  const { t } = useTranslation()

  const [selected, setSelected] = useState<string | null>(chunks[0]?.id ?? null)
  const [submitState, setSubmitState] = useState<SubmitState>("idle")
  const [error, setError] = useState<string>()
  const [lastAction, setLastAction] = useState<ReflectionAction | null>(null)
  const [showPrivacyNote, setShowPrivacyNote] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>("select")
  const { containerRef, restoreFocus } = useFocusTrap()

  // Animate in on mount
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50)
    return () => clearTimeout(timer)
  }, [])

  // Update selection when chunks change
  useEffect(() => {
    if (chunks.length > 0 && !chunks.find(c => c.id === selected)) {
      setSelected(chunks[0]?.id ?? null)
    }
  }, [chunks, selected])

  // Handle Escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && submitState === "idle") {
        handleClose()
      }
    }
    document.addEventListener("keydown", handleEscape)
    return () => document.removeEventListener("keydown", handleEscape)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitState])

  const handleClose = useCallback(() => {
    setIsVisible(false)
    setTimeout(() => {
      restoreFocus()
      onClose()
    }, 200)
  }, [restoreFocus, onClose])

  // Close on overlay click
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget && submitState === "idle") {
      handleClose()
    }
  }, [handleClose, submitState])

  const handleSubmit = async (action: ReflectionAction) => {
    if (!selected || (submitState !== "idle" && submitState !== "error")) return
    
    const newState = action === "save" ? "saving" : "sharing"
    setSubmitState(newState)
    setLastAction(action)
    setError(undefined)
    emitTelemetry("reflection.submit", { action, chunk_id: selected })
    
    try {
      await createReflection({ conversationId, chunkId: selected, action })
      emitTelemetry("reflection.submit_ok", { action, chunk_id: selected })
      setSubmitState("success")
      
      // Auto-close after success with nice animation
      setTimeout(() => {
        handleClose()
      }, 1800)
    } catch (err) {
      emitTelemetry("reflection.submit_err", { action, chunk_id: selected })
      setError((err as Error).message ?? t("reflectionModal.errorDefault"))
      setSubmitState("error")
      // Don't auto-reset - let user click retry
    }
  }

  const handleRetry = () => {
    if (lastAction) {
      void handleSubmit(lastAction)
    }
  }

  const handlePreview = (action: ReflectionAction) => {
    if (!selected) return
    setLastAction(action)
    setViewMode("preview")
  }

  const handleBackToSelect = () => {
    setViewMode("select")
  }

  const selectedChunk = useMemo(() => 
    chunks.find(c => c.id === selected), 
    [chunks, selected]
  )

  // Keyboard navigation for options
  const handleKeyDown = useCallback((e: React.KeyboardEvent, chunkId: string, index: number) => {
    const chunksCount = chunks.length
    
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault()
      const nextIndex = (index + 1) % chunksCount
      setSelected(chunks[nextIndex].id)
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault()
      const prevIndex = (index - 1 + chunksCount) % chunksCount
      setSelected(chunks[prevIndex].id)
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      setSelected(chunkId)
    }
  }, [chunks])

  const sortedChunks = useMemo(() => chunks.slice(0, 3), [chunks])
  const isSubmitting = submitState === "saving" || submitState === "sharing"
  const isSuccess = submitState === "success"

  return (
    <div
      className={`fixed inset-0 z-50 flex items-end justify-center px-4 pb-4 pt-16 sm:items-center sm:p-6 transition-all duration-300 ${
        isVisible ? "bg-sophia-bg/70 backdrop-blur-sm" : "bg-transparent"
      }`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reflection-modal-title"
      onClick={handleOverlayClick}
    >
      <div
        ref={containerRef}
        className={`relative w-full max-w-md transform transition-all duration-300 ease-out ${
          isVisible 
            ? "translate-y-0 opacity-100 scale-100" 
            : "translate-y-8 opacity-0 scale-95"
        }`}
      >
        {/* Main card with elegant styling */}
        <div className="overflow-hidden rounded-3xl bg-sophia-surface shadow-soft border border-sophia-surface-border">
          
          {/* Decorative gradient header */}
          <div className="relative bg-gradient-to-br from-sophia-purple/20 via-sophia-purple/10 to-transparent px-6 pb-4 pt-6">
            {/* Close button */}
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="absolute right-4 top-4 rounded-xl p-2 text-sophia-text2 transition-all hover:bg-sophia-purple/10 hover:text-sophia-purple disabled:opacity-50 border border-transparent hover:border-sophia-purple/20"
              aria-label={t("reflectionModal.closeAriaLabel")}
            >
              <X className="h-5 w-5" />
            </button>

            {/* Sparkle icon with glow effect */}
            <div className="mb-4 inline-flex items-center justify-center rounded-2xl bg-gradient-to-br from-sophia-purple to-sophia-glow p-3 shadow-soft">
              <Sparkles className="h-6 w-6 text-sophia-bg" />
            </div>
            
            {/* Title and subtitle */}
            <h2 
              id="reflection-modal-title" 
              className="text-xl font-semibold tracking-tight text-sophia-text"
            >
              {t("reflectionModal.title")}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-sophia-text2">
              {t("reflectionModal.subtitle")}
            </p>
          </div>

          {/* Content area */}
          <div className="px-6 pb-6">
            
            {/* Success state - beautiful celebration */}
            {isSuccess && (
              <div className="py-8 text-center animate-fadeIn">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-sophia-purple to-sophia-glow shadow-soft">
                  <Check className="h-8 w-8 text-sophia-bg" strokeWidth={3} />
                </div>
                <p className="text-lg font-medium text-sophia-text">
                  {lastAction === "share_discord"
                    ? t("reflectionModal.success.sharedTitle")
                    : t("reflectionModal.success.savedTitle")}
                </p>
                <p className="mt-1 text-sm text-sophia-text2">
                  {lastAction === "share_discord"
                    ? t("reflectionModal.success.sharedBody")
                    : t("reflectionModal.success.savedBody")}
                </p>
              </div>
            )}

            {/* Error state with Retry */}
            {submitState === "error" && error && (
              <div className="my-4 rounded-2xl border border-sophia-error/30 bg-sophia-error/10 px-4 py-4 animate-fadeIn">
                <p className="text-sm text-sophia-error mb-3">{error}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="flex items-center gap-2 rounded-xl bg-sophia-error px-4 py-2 text-sm font-medium text-sophia-bg transition-all hover:brightness-105"
                  >
                    <RefreshCw className="h-4 w-4" />
                    {t("reflectionModal.tryAgain")}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSubmitState("idle"); setViewMode("select"); }}
                    className="rounded-xl px-4 py-2 text-sm font-medium text-sophia-error transition-all hover:bg-sophia-error/20"
                  >
                    {t("reflectionModal.chooseDifferent")}
                  </button>
                </div>
              </div>
            )}

            {/* Preview Mode - Shows selected chunk as a card preview */}
            {viewMode === "preview" && !isSuccess && submitState !== "error" && selectedChunk && (
              <div className="mt-4 animate-fadeIn">
                {/* Back button */}
                <button
                  type="button"
                  onClick={handleBackToSelect}
                  disabled={isSubmitting}
                  className="mb-4 flex items-center gap-1 text-sm text-sophia-text2 transition-colors hover:text-sophia-purple disabled:opacity-50"
                >
                  <ChevronDown className="h-4 w-4 rotate-90" />
                  {t("reflectionModal.backToOptions")}
                </button>

                {/* Preview Card */}
                <div className="relative overflow-hidden rounded-2xl border border-sophia-surface-border bg-sophia-surface p-5 shadow-soft">
                    {/* Quote icon */}
                    <Quote className="mb-3 h-8 w-8 text-sophia-purple/30" />
                    
                    {/* The wisdom text */}
                    <p className="text-lg font-medium leading-relaxed text-sophia-text">
                      &ldquo;{selectedChunk.text}&rdquo;
                    </p>
                    
                    {/* Footer with branding */}
                    <div className="mt-4 flex items-center justify-between border-t border-sophia-surface-border pt-4">
                      <div className="flex items-center gap-2">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-sophia-purple to-sophia-glow">
                          <Sparkles className="h-3 w-3 text-sophia-bg" />
                        </div>
                        <span className="text-xs font-medium text-sophia-text2">{t("reflectionModal.preview.headerLabel")}</span>
                      </div>
                      {selectedChunk.reason && selectedChunk.reason !== "reflection" && (
                        <span className="rounded-full bg-sophia-purple/10 px-2.5 py-0.5 text-xs font-medium text-sophia-purple">
                          {selectedChunk.reason.replace(/_/g, " ")}
                        </span>
                      )}
                    </div>
                </div>

                {/* Preview info */}
                <p className="mt-3 text-center text-xs text-sophia-text2">
                  {lastAction === "share_discord" 
                    ? t("reflectionModal.preview.sharedHint")
                    : t("reflectionModal.preview.savedHint")}
                </p>

                {/* Confirm action */}
                <div className="mt-5 flex gap-2.5">
                  <button
                    type="button"
                    onClick={handleBackToSelect}
                    disabled={isSubmitting}
                    className="flex-1 rounded-2xl border-2 border-sophia-surface-border px-5 py-3 text-sm font-semibold text-sophia-text transition-all hover:border-sophia-purple/30 disabled:opacity-50"
                  >
                    {t("reflectionModal.preview.changeSelection")}
                  </button>
                  <button
                    type="button"
                    onClick={() => lastAction && handleSubmit(lastAction)}
                    disabled={isSubmitting}
                    className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-sophia-purple to-sophia-glow px-5 py-3 text-sm font-semibold text-sophia-bg shadow-soft transition-all hover:shadow-soft disabled:opacity-50"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>
                          {lastAction === "share_discord"
                            ? t("reflectionModal.preview.sharing")
                            : t("reflectionModal.preview.saving")}
                        </span>
                      </>
                    ) : (
                      <>
                        {lastAction === "share_discord" ? <Send className="h-4 w-4" /> : <Heart className="h-4 w-4" />}
                        <span>{t("reflectionModal.preview.confirm")}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Selection Mode - Wisdom chunks selection */}
            {viewMode === "select" && !isSuccess && submitState !== "error" && (
              <>
                <div 
                  className="mt-4 space-y-2.5" 
                  role="radiogroup" 
                  aria-label={t("reflectionModal.selectionAriaLabel")}
                >
                  {sortedChunks.map((chunk, index) => {
                    const isSelected = selected === chunk.id
                    return (
                      <button
                        key={chunk.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        tabIndex={isSelected ? 0 : -1}
                        onClick={() => setSelected(chunk.id)}
                        onKeyDown={(e) => handleKeyDown(e, chunk.id, index)}
                        disabled={isSubmitting}
                        className={`group relative w-full text-left rounded-2xl border-2 p-4 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2 shadow-soft ${
                          isSelected 
                            ? "border-sophia-purple bg-sophia-purple/5 shadow-soft" 
                            : "border-sophia-surface-border bg-sophia-button/50 hover:border-sophia-purple/30 hover:bg-sophia-purple/5"
                        } ${isSubmitting ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
                      >
                        {/* Selection indicator */}
                        <div className={`absolute right-4 top-4 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all ${
                          isSelected 
                            ? "border-sophia-purple bg-sophia-purple scale-100" 
                            : "border-sophia-surface-border scale-90 group-hover:border-sophia-purple/40 group-hover:scale-100"
                        }`}>
                          {isSelected && <Check className="h-3 w-3 text-sophia-bg" />}
                        </div>

                        {/* Chunk content */}
                        <p className="pr-8 text-sm font-medium leading-relaxed text-sophia-text">
                          &ldquo;{chunk.text}&rdquo;
                        </p>
                        
                        {/* Insight tag and timestamp */}
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          {chunk.reason && chunk.reason !== "reflection" && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-sophia-purple/10 px-2.5 py-0.5 text-xs font-medium text-sophia-purple">
                              <Sparkles className="h-3 w-3" />
                              {chunk.reason.replace(/_/g, " ")}
                            </span>
                          )}
                          {chunk.ts && (
                            <span className="text-xs text-sophia-text2/60">
                              {new Date(chunk.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>

                {/* Privacy note (collapsible) - Always visible info */}
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setShowPrivacyNote(!showPrivacyNote)}
                    className="flex w-full items-center justify-between rounded-xl bg-sophia-purple/5 px-3 py-2.5 text-xs text-sophia-text2 transition-colors hover:bg-sophia-purple/10"
                  >
                    <span className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-sophia-purple" />
                      <span className="font-medium">{t("reflectionModal.privacy.title")}</span>
                    </span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${showPrivacyNote ? "rotate-180" : ""}`} />
                  </button>
                  
                  {showPrivacyNote && (
                    <div className="mt-2 space-y-2 rounded-xl bg-sophia-surface p-3 text-xs leading-relaxed text-sophia-text2 animate-fadeIn border border-sophia-purple/10">
                      <p className="font-medium text-sophia-text">{t("reflectionModal.privacy.detailsTitle")}</p>
                      <ul className="space-y-1.5 pl-1">
                        <li className="flex items-start gap-2">
                          <span className="text-sophia-purple mt-0.5">•</span>
                          <span>
                            <strong>{t("reflectionModal.privacy.bullet1Strong")}</strong> — {t("reflectionModal.privacy.bullet1Body")}
                          </span>
                        </li>
                        <li className="flex items-start gap-2">
                          <span className="text-sophia-purple mt-0.5">•</span>
                          <span>
                            <strong>{t("reflectionModal.privacy.bullet2Strong")}</strong> — {t("reflectionModal.privacy.bullet2Body")}
                          </span>
                        </li>
                        <li className="flex items-start gap-2">
                          <span className="text-sophia-purple mt-0.5">•</span>
                          <span>
                            <strong>{t("reflectionModal.privacy.bullet3Strong")}</strong> — {t("reflectionModal.privacy.bullet3Body")}
                          </span>
                        </li>
                      </ul>
                      <p className="text-sophia-text2/80 italic mt-2">{t("reflectionModal.privacy.footer")}</p>
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
                  {/* Save privately - secondary */}
                  <button
                    type="button"
                    onClick={() => handleSubmit("save")}
                    disabled={!selected || isSubmitting}
                    className="flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-sophia-surface-border bg-transparent px-5 py-3 text-sm font-semibold text-sophia-text transition-all hover:border-sophia-purple/30 hover:bg-sophia-purple/5 shadow-soft disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitState === "saving" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{t("reflectionModal.saving")}</span>
                      </>
                    ) : (
                      <>
                        <Heart className="h-4 w-4" />
                        <span>{t("reflectionModal.keepPrivately")}</span>
                      </>
                    )}
                  </button>
                  
                  {/* Share - primary (shows preview first) */}
                  <button
                    type="button"
                    onClick={() => handlePreview("share_discord")}
                    disabled={!selected || isSubmitting}
                    className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-sophia-purple px-5 py-3 text-sm font-semibold text-sophia-bg shadow-soft transition-all hover:brightness-105 hover:shadow-soft hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                  >
                    <Eye className="h-4 w-4" />
                    <span>{t("reflectionModal.previewAndShare")}</span>
                  </button>
                </div>

                {/* Skip link */}
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={isSubmitting}
                  className="mt-3 w-full py-2 text-center text-xs text-sophia-text2/70 transition-colors hover:text-sophia-text disabled:opacity-50"
                >
                  {t("reflectionModal.maybeLater")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

