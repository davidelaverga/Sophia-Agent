"use client"

import { apiRequestVoid } from "./client"

export type ReflectionAction = "save" | "share_discord"

export type CreateReflectionPayload = {
  conversationId: string
  chunkId: string
  action: ReflectionAction
}

export const createReflection = async ({ conversationId, chunkId, action }: CreateReflectionPayload): Promise<void> => {
  await apiRequestVoid("/api/reflections/create", {
    method: "POST",
    body: {
      conversation_id: conversationId,
      chunk_id: chunkId,
      action,
    },
    errorMessage: "Unable to save reflection.",
  })
}





