"use client"

import { apiRequestVoid } from "./client"

export type FeedbackTag = "clarity" | "empathy" | "grounding" | "confusing" | "slow"

export type FeedbackPayload = {
  turnId: string
  helpful: boolean
  tag?: FeedbackTag
}

export const postFeedback = async ({ turnId, helpful, tag }: FeedbackPayload): Promise<void> => {
  await apiRequestVoid("/api/conversation/feedback", {
    method: "POST",
    body: {
      turn_id: turnId,
      helpful,
      tag,
    },
    errorMessage: "Failed to submit feedback",
  })
}


