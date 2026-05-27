/**
 * Pending-attachments store for the Sophia chat composer.
 *
 * Tracks files the user has uploaded but not yet sent. The chat
 * route's runtime reads from this store before posting so Sophia
 * (via the /api/chat post-handler) learns which filenames it can call
 * `view_user_image` / `read_user_document` on. After a successful
 * send the entries for that thread clear.
 *
 * Thread-scoped (Codex P2 on PR #132): every PendingAttachment carries
 * the threadId it was uploaded under. Reads/clears filter by threadId
 * so a user who uploads in session A, switches to B, and submits
 * doesn't have A's filenames leak into B's request (the bytes
 * physically live in A's sandbox — Sophia in B would call
 * view_user_image on a filename that doesn't exist there).
 *
 * Kept separate from `chat-store.ts` so the upload UX is decoupled
 * from streaming/conversation state — a future refactor that swaps
 * the chat route runtime doesn't touch this surface.
 */

import { create } from "zustand"

export { buildAttachmentPrompt } from "./attachment-prompt"

export type AttachmentStatus = "uploading" | "uploaded" | "deleting" | "error"

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
  /**
   * Thread the file was uploaded under. Used to scope chip display
   * and ``attached_files`` payload composition to the current session
   * — files uploaded to thread A must never be sent to thread B.
   * Codex P2 on PR #132.
   */
  threadId: string
}

type AttachmentsState = {
  items: PendingAttachment[]
  add: (item: PendingAttachment) => void
  update: (clientId: string, patch: Partial<PendingAttachment>) => void
  remove: (clientId: string) => void
  /** Remove every item — use sparingly; prefer ``clearForThread``. */
  clear: () => void
  /** Remove only items owned by the given thread (post-send cleanup). */
  clearForThread: (threadId: string) => void
}

export const useAttachmentsStore = create<AttachmentsState>((set) => ({
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
  clearForThread: (threadId) =>
    set((state) => ({
      items: state.items.filter((item) => item.threadId !== threadId),
    })),
}))


// ─── Selectors (use in components via useAttachmentsStore(selector)) ───

/** Items belonging to ``threadId`` only — preserves insertion order. */
export function selectItemsForThread(
  threadId: string | null | undefined,
): (state: AttachmentsState) => PendingAttachment[] {
  return (state) =>
    threadId
      ? state.items.filter((item) => item.threadId === threadId)
      : []
}

/**
 * True if any item for ``threadId`` is still mid-upload OR mid-
 * delete. ``deleting`` counts here because we don't want the user
 * submitting a turn while we're still trying to purge a discarded
 * file from the server — if the DELETE is still in flight when the
 * model runs, the builder copy path might still see the file.
 */
export function selectHasUploadsInFlight(
  threadId: string | null | undefined,
): (state: AttachmentsState) => boolean {
  return (state) =>
    Boolean(threadId) &&
    state.items.some(
      (item) =>
        item.threadId === threadId &&
        (item.status === "uploading" || item.status === "deleting"),
    )
}

/**
 * Successfully-uploaded filenames for ``threadId`` — what to send to
 * Sophia in ``chatRequestBody.attached_files``. Always returns an
 * empty list when ``threadId`` is missing, so a misconfigured page
 * can't accidentally leak filenames from another thread.
 */
export function selectUploadedFilenamesForThread(
  threadId: string | null | undefined,
): (state: AttachmentsState) => string[] {
  return (state) =>
    threadId
      ? state.items
          .filter(
            (item) => item.threadId === threadId && item.status === "uploaded",
          )
          .map((item) => item.filename)
      : []
}
