"use client"

/**
 * Sophia chat attachment bar.
 *
 * Renders above the message composer:
 * - A paperclip button that opens a file picker.
 * - One chip per pending attachment (uploading / uploaded / error states).
 * - A per-chip × button to discard before sending.
 *
 * On file selection it POSTs each file to
 * `/api/threads/{threadId}/uploads` (which proxies to the Sophia gateway).
 * The resulting filenames live in `useAttachmentsStore`; the chat route's
 * runtime reads them on send so Sophia knows which `view_user_image` /
 * `read_user_document` calls are available this turn.
 *
 * Designed to be self-contained: drop one of these above the composer
 * and the rest of the wiring (store ↔ chat route ↔ backend) Just Works.
 */

import { FileText, ImageIcon, Loader2, Paperclip, X } from "lucide-react"
import { useCallback, useId, useRef, type ChangeEvent } from "react"

import { MAX_ATTACHED_FILES_PER_TURN } from "../../lib/chat-constants"
import {
  selectItemsForThread,
  useAttachmentsStore,
  type PendingAttachment,
} from "../../stores/attachments-store"

// File extensions the upstream view_image_tool accepts (kept in sync with
// the backend's _BUILDER_COPY_IMAGE_EXTENSIONS — see PR #132 Codex P3).
// Anything else is treated as a document and routed to read_user_document.
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"])

// What the file picker will accept. Matches CONVERTIBLE_EXTENSIONS in
// backend/packages/harness/deerflow/utils/file_conversion.py plus the
// image set and a few common plain-text formats.
const ACCEPTED_FILE_TYPES =
  ".jpg,.jpeg,.png,.webp,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml"

// Per-file size caps. Images are tighter than documents because the
// vision tool base64-injects raw bytes into the next model request —
// a 10 MiB image becomes ~13.4 MiB of base64, leaving comfortable
// headroom under Anthropic's 32 MB request envelope. The Python-side
// guard in `view_user_image.MAX_VIEWABLE_IMAGE_BYTES` (10 MiB) is the
// hard enforcement; this client-side cap just gives the user
// immediate feedback at file-pick time so they don't wait for upload
// + tool call to learn the file's too big. Codex P2 on PR #132.
//
// Documents stay at 25 MiB because read_user_document extracts TEXT
// (via markitdown) before the model sees anything — image bytes never
// hit the request envelope, so a 20 MiB PPTX with embedded images is
// safe to upload.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

function maxBytesFor(filename: string): number {
  return isImage(filename) ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
}

type AttachmentBarProps = {
  /** Thread the uploads land under. */
  threadId: string | null | undefined
  /** Disable interactions (e.g. while a session is read-only). */
  disabled?: boolean
  /** Custom className for the outer container. */
  className?: string
}

function makeClientId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isImage(filename: string): boolean {
  const idx = filename.lastIndexOf(".")
  if (idx < 0) return false
  return IMAGE_EXTENSIONS.has(filename.slice(idx).toLowerCase())
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type UploadedFileResponse = {
  filename: string
  size: string
  virtual_path?: string
  markdown_file?: string
}

type UploadResponseShape = {
  success?: boolean
  files?: UploadedFileResponse[]
  error?: string
}

export function AttachmentBar({ threadId, disabled = false, className }: AttachmentBarProps) {
  // Show only chips owned by the current thread (Codex P2 PR #132).
  // If a user uploaded in thread A and switched to B, A's chips
  // disappear here — they reappear when the user navigates back to A.
  const items = useAttachmentsStore(selectItemsForThread(threadId))
  const add = useAttachmentsStore((state) => state.add)
  const update = useAttachmentsStore((state) => state.update)
  const remove = useAttachmentsStore((state) => state.remove)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const inputId = useId()

  const isInteractive = !disabled && Boolean(threadId)

  const handlePaperclipClick = useCallback(() => {
    if (!isInteractive) return
    inputRef.current?.click()
  }, [isInteractive])

  const handleFileSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const filesList = event.target.files
      // Reset immediately so picking the same file twice in a row works.
      event.target.value = ""
      if (!filesList || filesList.length === 0 || !threadId) return

      const files = Array.from(filesList)

      // Enforce the same per-turn cap as the server-side post-handler
      // BEFORE we upload anything — otherwise files over the cap
      // upload successfully but get silently dropped from
      // attached_files when parseAndValidateChatPayload truncates
      // at MAX_ATTACHED_FILES_PER_TURN, then clearForThread wipes
      // the chips post-dispatch and the user is left wondering why
      // Sophia ignored some uploads. Codex P2 on PR #132.
      //
      // We count items already in the store for this thread that
      // could plausibly land in attached_files (uploaded + still-
      // uploading). Errored items don't count — they won't be sent.
      // Read items fresh from the store rather than from the closure
      // to avoid a stale-snapshot race when the user picks files
      // faster than the render loop.
      const currentItems = selectItemsForThread(threadId)(
        useAttachmentsStore.getState()
      )
      const existingCounted = currentItems.filter(
        (item) => item.status !== "error"
      ).length
      let remainingSlots = Math.max(MAX_ATTACHED_FILES_PER_TURN - existingCounted, 0)

      // Pre-register each file as "uploading" before kicking off the
      // network call so the chips appear instantly. Tag each item
      // with the current threadId so the store can scope display +
      // cleanup to this session (Codex P2 PR #132).
      const registrations = files.map((file) => {
        const cap = maxBytesFor(file.name)
        if (file.size > cap) {
          const kind = isImage(file.name) ? "image" : "document"
          const item: PendingAttachment = {
            clientId: makeClientId(),
            filename: file.name,
            size: file.size,
            status: "error",
            error: `${kind === "image" ? "Image" : "File"} too large (${formatBytes(file.size)}). Max ${formatBytes(cap)} for ${kind}s.`,
            hasMarkdownConversion: false,
            threadId,
          }
          add(item)
          return { file, item, skip: true }
        }
        if (remainingSlots <= 0) {
          const item: PendingAttachment = {
            clientId: makeClientId(),
            filename: file.name,
            size: file.size,
            status: "error",
            error: `Max ${MAX_ATTACHED_FILES_PER_TURN} attachments per message. Remove some before adding more.`,
            hasMarkdownConversion: false,
            threadId,
          }
          add(item)
          return { file, item, skip: true }
        }
        remainingSlots -= 1
        const item: PendingAttachment = {
          clientId: makeClientId(),
          filename: file.name,
          size: file.size,
          status: "uploading",
          hasMarkdownConversion: false,
          threadId,
        }
        add(item)
        return { file, item, skip: false }
      })

      // Upload one at a time to keep error attribution simple and the
      // backend's per-thread sandbox dir from racing on parallel writes.
      for (const reg of registrations) {
        if (reg.skip) continue
        const fd = new FormData()
        fd.append("files", reg.file, reg.file.name)

        try {
          const res = await fetch(
            `/api/threads/${encodeURIComponent(threadId)}/uploads`,
            { method: "POST", body: fd }
          )
          if (!res.ok) {
            const errText = await res.text().catch(() => "")
            update(reg.item.clientId, {
              status: "error",
              error: `Upload failed (${res.status}). ${errText.slice(0, 120)}`,
            })
            continue
          }
          const data = (await res.json()) as UploadResponseShape
          // The backend echoes one entry per uploaded file. We sent one,
          // so we take the first; we still match by filename to be safe.
          const echo = data.files?.find((entry) => entry.filename === reg.file.name) ?? data.files?.[0]
          if (!echo) {
            update(reg.item.clientId, {
              status: "error",
              error: "Upload succeeded but server returned no file metadata.",
            })
            continue
          }
          update(reg.item.clientId, {
            status: "uploaded",
            filename: echo.filename,
            size: Number(echo.size) || reg.item.size,
            hasMarkdownConversion: Boolean(echo.markdown_file),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : "Network error"
          update(reg.item.clientId, { status: "error", error: message })
        }
      }
    },
    [threadId, add, update]
  )

  const tooltip = isInteractive
    ? "Attach an image or document"
    : threadId
      ? "Attachments unavailable in this session"
      : "Start a session to attach files"

  // Nothing to render at all when bar is empty and disabled — the
  // composer stays uncluttered until the user has a reason to attach.
  if (!isInteractive && items.length === 0) {
    return null
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}
      data-testid="attachment-bar"
    >
      <button
        type="button"
        onClick={handlePaperclipClick}
        disabled={!isInteractive}
        title={tooltip}
        aria-label={tooltip}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-sophia-input-border bg-sophia-surface px-3 text-xs font-medium text-sophia-text2 transition-colors hover:bg-sophia-purple/10 hover:text-sophia-purple disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Paperclip className="h-3.5 w-3.5" />
        <span>Attach</span>
      </button>

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept={ACCEPTED_FILE_TYPES}
        onChange={handleFileSelection}
        className="hidden"
        data-testid="attachment-bar-file-input"
      />

      {items.map((item) => {
        const Icon = isImage(item.filename) ? ImageIcon : FileText
        const baseChipClass =
          "inline-flex h-8 max-w-[14rem] items-center gap-1.5 rounded-full border px-3 text-xs"
        const statusClass =
          item.status === "error"
            ? "border-red-400/60 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
            : item.status === "uploading"
              ? "border-sophia-input-border bg-sophia-surface text-sophia-text2"
              : "border-sophia-purple/40 bg-sophia-purple/10 text-sophia-purple"
        return (
          <span
            key={item.clientId}
            className={`${baseChipClass} ${statusClass}`}
            title={item.error ?? `${item.filename} (${formatBytes(item.size)})`}
            data-testid="attachment-chip"
            data-status={item.status}
          >
            {item.status === "uploading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Icon className="h-3.5 w-3.5" />
            )}
            <span className="truncate">{item.filename}</span>
            <button
              type="button"
              onClick={() => remove(item.clientId)}
              aria-label={`Remove ${item.filename}`}
              className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      })}
    </div>
  )
}
