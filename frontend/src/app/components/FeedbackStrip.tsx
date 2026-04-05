"use client"

import { useEffect, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { postFeedback, type FeedbackTag } from "../lib/api/feedback"
import { useChatStore } from "../stores/chat-store"
import { selectFeedbackState } from "../stores/selectors"
import { emitTelemetry } from "../lib/telemetry"
import { useTranslation } from "../copy"

const TAGS = [
  { id: "clarity", key: "feedback.tags.clarity" },
  { id: "empathy", key: "feedback.tags.care" },
  { id: "grounding", key: "feedback.tags.grounding" },
  { id: "confusing", key: "feedback.tags.confusing" },
  { id: "slow", key: "feedback.tags.tooSlow" },
] as const

type FeedbackStripProps = {
  turnId: string
}

export function FeedbackStrip({ turnId }: FeedbackStripProps) {
  const { t } = useTranslation()

  const { feedbackGate: gate, acknowledgeFeedback: acknowledge } = useChatStore(
    useShallow(selectFeedbackState)
  )
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState<boolean | null>(null)
  const [error, setError] = useState<string>()
  const [selectedTag, setSelectedTag] = useState<string>()

  const visible = gate?.allowed && gate.turnId === turnId

  useEffect(() => {
    if (visible) {
      emitTelemetry("feedback.shown", { gated: true, turn_id: turnId })
    }
  }, [visible, turnId])

  if (!visible) return null

  const handleSubmit = async (helpful: boolean, tag?: FeedbackTag) => {
    setSubmitting(true)
    setError(undefined)
    try {
      await postFeedback({ turnId, helpful, tag })
      emitTelemetry("feedback.submit", { helpful, tag, turn_id: turnId })
      setSubmitted(helpful)
      acknowledge(turnId)
    } catch (err) {
      setError((err as Error).message ?? t("feedback.errorDefault"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-3 rounded-2xl border border-sophia-surface-border bg-sophia-surface/80 px-3 py-2 text-sm text-sophia-text">
      {!submitted ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-sophia-text2">{t("feedback.prompt")}</span>
          <button
            type="button"
            className="rounded-xl bg-sophia-user px-3 py-1 text-xs font-medium text-sophia-text transition hover:bg-sophia-user/70 disabled:opacity-50"
            disabled={submitting}
            onClick={() => handleSubmit(true)}
          >
            {t("feedback.yes")}
          </button>
          <button
            type="button"
            className="rounded-xl bg-sophia-user px-3 py-1 text-xs font-medium text-sophia-text transition hover:bg-sophia-user/70 disabled:opacity-50"
            disabled={submitting}
            onClick={() => handleSubmit(false)}
          >
            {t("feedback.no")}
          </button>
          {error && (
            <span className="text-xs text-sophia-error">
              {error} —{" "}
              <button
                type="button"
                className="underline"
                onClick={() => acknowledge(turnId)}
              >
                {t("feedback.skip")}
              </button>
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-sophia-text2">{t("feedback.thanks")}</p>
          <div className="flex flex-wrap gap-2">
            {TAGS.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  selectedTag === tag.id
                    ? "border-sophia-purple bg-sophia-purple text-white"
                    : "border-sophia-surface-border bg-sophia-button text-sophia-text"
                }`}
                disabled={submitting}
                onClick={() => {
                  setSelectedTag(tag.id)
                  handleSubmit(submitted, tag.id)
                }}
              >
                {t(tag.key)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}


