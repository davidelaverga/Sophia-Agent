"use client"

import { useState, useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import { postFeedback } from "../lib/api/feedback"
import { useChatStore } from "../stores/chat-store"
import { selectSessionFeedbackState } from "../stores/selectors"
import { emitTelemetry } from "../lib/telemetry"
import { useTranslation } from "../copy"

export function SessionFeedbackToast() {
  const { t } = useTranslation()
  const { sessionFeedback, closeSessionFeedback: closeToast, acknowledgeFeedback: acknowledge } = useChatStore(
    useShallow(selectSessionFeedbackState)
  )
  const turnId = sessionFeedback?.turnId
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (sessionFeedback?.open && turnId) {
      emitTelemetry("feedback.shown", { gated: false, turn_id: turnId })
    }
  }, [sessionFeedback?.open, turnId])

  if (!sessionFeedback?.open || !turnId) return null

  const handleSubmit = async (helpful: boolean) => {
    setSubmitting(true)
    setError(undefined)
    try {
      await postFeedback({ turnId, helpful })
      emitTelemetry("feedback.submit", { helpful, turn_id: turnId })
      acknowledge(turnId)
      closeToast()
    } catch (err) {
      setError((err as Error).message ?? t("sessionFeedbackToast.unableToSend"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="pointer-events-auto fixed bottom-4 left-0 right-0 z-40 flex justify-center px-4">
      <div
        className="flex w-full max-w-md items-center justify-between rounded-2xl border border-sophia-surface-border bg-sophia-surface p-4 text-sm shadow-soft motion-safe:animate-fadeIn"
        role="status"
        aria-live="polite"
      >
        <div>
          <p className="font-semibold text-sophia-text">{t("sessionFeedbackToast.prompt")}</p>
          {error && (
            <p className="mt-1 text-xs text-sophia-error" role="alert">
              {error} —{" "}
              <button type="button" className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple rounded" onClick={() => {
                acknowledge(turnId)
                closeToast()
              }}>
                {t("sessionFeedbackToast.skipFeedback")}
              </button>
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={submitting}
            aria-label="Rate helpful"
            className="rounded-full border border-sophia-surface-border px-3 py-1 text-xs font-medium text-sophia-text transition hover:border-sophia-purple/40 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
            onClick={() => handleSubmit(true)}
          >
            👍
          </button>
          <button
            type="button"
            disabled={submitting}
            aria-label="Rate unhelpful"
            className="rounded-full border border-sophia-surface-border px-3 py-1 text-xs font-medium text-sophia-text transition hover:border-sophia-purple/40 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
            onClick={() => handleSubmit(false)}
          >
            👎
          </button>
          <button
            type="button"
            aria-label="Skip feedback"
            className="rounded-full border border-transparent px-2 py-1 text-xs underline text-sophia-text2 hover:text-sophia-text focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
            onClick={() => {
              acknowledge(turnId)
              closeToast()
            }}
          >
            {t("sessionFeedbackToast.skip")}
          </button>
        </div>
      </div>
    </div>
  )
}


