/**
 * Pending-attachments store for the Sophia chat composer.
 *
 * Tracks files the user has uploaded but not yet sent. The chat
 * route's runtime reads from this store before posting so Sophia
 * (via the /api/chat post-handler) learns which filenames it can call
 * `view_user_image` / `read_user_document` on. After a successful
 * send the store clears.
 *
 * Kept separate from `chat-store.ts` so the upload UX is decoupled
 * from streaming/conversation state — a future refactor that swaps
 * the chat route runtime doesn't touch this surface.
 */

import { create } from "zustand"

export { buildAttachmentPrompt } from "./attachment-prompt"

export type AttachmentStatus = "uploading" | "uploaded" | "error"

export type PendingAttachment = {
  /** Bare filename — what the model needs to call view_user_image. */
  filename: string
  /** Size in bytes (post-upload). */
  size: number
  /** MIME type from the upload response. */
  mimeType?: string
  /** Upload progress / outcome. */
  status: AttachmentStatus
  /** Human-readable error if status === "error". */
  error?: string
  /** Stable client-side id used for chip keys + removal targeting. */
  clientId: string
  /** True if the backend converted a doc to markdown for read_user_document. */
  hasMarkdownConversion: boolean
}

type AttachmentsState = {
  items: PendingAttachment[]
  add: (item: PendingAttachment) => void
  update: (clientId: string, patch: Partial<PendingAttachment>) => void
  remove: (clientId: string) => void
  clear: () => void
  /** Filenames of successfully-uploaded attachments — what to send to Sophia. */
  uploadedFilenames: () => string[]
}

export const useAttachmentsStore = create<AttachmentsState>((set, get) => ({
  items: [],
  add: (item) => set((state) => ({ items: [...state.items, item] })),
  update: (clientId, patch) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.clientId === clientId ? { ...item, ...patch } : item
      ),
    })),
  remove: (clientId) =>
    set((state) => ({
      items: state.items.filter((item) => item.clientId !== clientId),
    })),
  clear: () => set({ items: [] }),
  uploadedFilenames: () =>
    get()
      .items.filter((item) => item.status === "uploaded")
      .map((item) => item.filename),
}))


