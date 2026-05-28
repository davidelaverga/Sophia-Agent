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
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from "react"
// ``useEffect`` is imported because ``openPickerRef`` wiring uses it.

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

// Mirrors the server-side ``SAFE_PROMPT_FILENAME`` allow-list used by
// ``chat-request.ts::sanitizeAttachedFilename`` and the renderer in
// ``attachment-prompt.ts``. Filenames outside this set are stripped
// from ``attached_files`` server-side, so we normalize HERE on the
// client to keep the upload and the prompt in sync (Codex P2 PR #132).
//
// Without normalization a user who picks
// ``Screenshot 2026-05-27 at 10.00.png`` (spaces) sees an
// ``uploaded`` chip but Sophia never gets the synthesized hint
// (server drops the unsafe filename), so the file appears attached
// but is silently ignored. Auto-renaming on upload keeps the chip,
// the on-disk filename, and the ``attached_files`` entry all in
// agreement.
const PROMPT_SAFE_FILENAME_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Normalize a picked filename into the allow-list shape the chat
 * post-handler's ``SAFE_PROMPT_FILENAME`` accepts. Replaces unsafe
 * characters with ``_``, collapses runs, strips leading dots, and
 * falls back to ``file<ext>`` when the result would be empty.
 */
function toPromptSafeFilename(name: string): string {
  if (PROMPT_SAFE_FILENAME_PATTERN.test(name)) return name

  // Split off the extension FIRST so a pathological basename (only
  // parens / spaces / etc.) doesn't end up eating ".png" in the
  // leading-dot strip below. Without this, ``(( )).png`` would
  // collapse all the way to ``png`` (no dot) and the upload wouldn't
  // be recognized as an image.
  const lastDot = name.lastIndexOf(".")
  const hasExt = lastDot > 0 && lastDot < name.length - 1
  const rawStem = hasExt ? name.slice(0, lastDot) : name
  const rawExt = hasExt ? name.slice(lastDot + 1) : ""

  const safeStem = rawStem
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "") // hidden-file leader is dropped by the sanitizer
    .replace(/_+$/g, "")

  const safeExt = rawExt.replace(/[^A-Za-z0-9]+/g, "")

  const stem = safeStem || "file"
  if (safeExt) return `${stem}.${safeExt}`
  // Original had no extension (or the extension was all unsafe chars):
  // keep the stem, ``.bin`` only when even the stem fell back to "file".
  return stem === "file" ? "file.bin" : stem
}

/**
 * Make ``name`` unique against ``claimed`` by appending ``-1`` /
 * ``-2`` / ... to the stem until a free slot is found.
 *
 * Codex P2 PR #132 (later iteration). The gateway upload route stores
 * each file under its bare filename in
 * ``backend/.deer-flow/threads/{thread_id}/user-data/uploads/``, and
 * the chat post-handler's ``parseAndValidateChatPayload`` deduplicates
 * ``attached_files`` by exact-match string. So two picked files that
 * normalize to the same ``safeName`` (e.g. ``a b.png`` and ``a?b.png``,
 * or two ``image.png`` files from different folders) would silently
 * collapse to one file on disk and one entry in ``attached_files``,
 * leaving the user with multiple chips but only one file Sophia can
 * actually read.
 *
 * ``claimed`` is seeded with the safeNames of non-error chips already
 * in this thread's store, then each successful chip's safeName is
 * added after creation — so collisions within a single multi-select
 * batch AND collisions against pre-existing chips both get resolved.
 *
 * Safety hatch: if 1000 sequential candidates all collide (truly
 * pathological) fall back to a timestamp suffix. This keeps the loop
 * bounded under adversarial input.
 */
function uniquifyFilename(name: string, claimed: Set<string>): string {
  if (!claimed.has(name)) return name
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem}-${n}${ext}`
    if (!claimed.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

/**
 * Mutable ref the bar populates with an ``openPicker`` callback. Lets
 * a parent component (e.g. the Composer's bottom action row) render
 * its own paperclip button that triggers the bar's hidden file input.
 *
 * B4 of the silent-attach fix (2026-05-28): in production the
 * AttachmentBar's own paperclip button sits in its own row above the
 * composer, so the Attach button and the Send button can't share a
 * horizontal baseline. With this ref, the page-level layout can host
 * the paperclip alongside the Send button in the same flex row and
 * delegate the click back to the bar's file input.
 */
export type AttachmentPickerRef = { current: (() => void) | null }

type AttachmentBarProps = {
  /** Thread the uploads land under. */
  threadId: string | null | undefined
  /** Disable interactions (e.g. while a session is read-only). */
  disabled?: boolean
  /** Custom className for the outer container. */
  className?: string
  /**
   * If true, hides the bar's own paperclip button so a parent can
   * render an alignment-friendly equivalent. The file input + chip
   * row + status banner remain owned by the bar. Use together with
   * ``openPickerRef`` to wire the parent button to the bar's input.
   */
  hideInternalPaperclip?: boolean
  /**
   * Mutable ref populated with a function the parent can call to
   * trigger the file picker. Null until the bar has mounted; null
   * again when the bar unmounts.
   */
  openPickerRef?: AttachmentPickerRef
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

type Registration = { file: File; item: PendingAttachment; skip: boolean }

/**
 * Build the chip-store registration for a single picked file:
 * either an "uploading" item (slot consumed) OR an "error" item
 * (oversized / cap-exceeded) that won't be uploaded.
 *
 * Extracted out of ``handleFileSelection`` so the bar's main change
 * handler stays simple enough to keep its cyclomatic complexity
 * below the Sentrux gate.
 */
function buildRegistration(
  file: File,
  threadId: string,
  remainingSlots: number,
  claimed: Set<string>,
): Registration {
  // Normalize the picked filename to the allow-list shape
  // ``sanitizeAttachedFilename`` (server-side) accepts. Without
  // this the user picks ``Screenshot 2026-05-27 at 10.00.png``, the
  // upload succeeds, but the chat post-handler strips the filename
  // from ``attached_files`` → chip shows uploaded → Sophia never
  // hears about the file. Codex P2 PR #132.
  //
  // Uniquify after normalization (Codex P2 PR #132 later iteration)
  // so two picks that collide on safeName (or against an existing
  // chip in this thread) don't overwrite each other on disk +
  // dedupe in ``attached_files``. The caller adds the chosen name
  // to ``claimed`` after registration so subsequent picks in the
  // same batch see the new occupant.
  const safeName = uniquifyFilename(toPromptSafeFilename(file.name), claimed)
  const fileForUpload =
    safeName === file.name
      ? file
      : new File([file], safeName, { type: file.type, lastModified: file.lastModified })

  const cap = maxBytesFor(safeName)
  if (file.size > cap) {
    const kind = isImage(safeName) ? "image" : "document"
    return {
      file: fileForUpload,
      skip: true,
      item: {
        clientId: makeClientId(),
        filename: safeName,
        size: file.size,
        status: "error",
        error: `${kind === "image" ? "Image" : "File"} too large (${formatBytes(file.size)}). Max ${formatBytes(cap)} for ${kind}s.`,
        hasMarkdownConversion: false,
        threadId,
      },
    }
  }
  if (remainingSlots <= 0) {
    return {
      file: fileForUpload,
      skip: true,
      item: {
        clientId: makeClientId(),
        filename: safeName,
        size: file.size,
        status: "error",
        error: `Max ${MAX_ATTACHED_FILES_PER_TURN} attachments per message. Remove some before adding more.`,
        hasMarkdownConversion: false,
        threadId,
      },
    }
  }
  return {
    file: fileForUpload,
    skip: false,
    item: {
      clientId: makeClientId(),
      filename: safeName,
      size: file.size,
      status: "uploading",
      hasMarkdownConversion: false,
      threadId,
    },
  }
}

/**
 * Fetch the list of filenames already on disk for ``threadId`` so
 * the uniquifier can seed its claimed-names set with files that
 * outlived their chip.
 *
 * Codex P2 PR #132 (later iteration). After a turn sends, the
 * outbound-send hook clears the attachment chips from the Zustand
 * store, but the bytes remain in
 * ``backend/.deer-flow/threads/{threadId}/user-data/uploads/``. A
 * later pick of the same name in the same thread would see an empty
 * store, skip the uniquifier, and silently overwrite the earlier
 * upload. ``view_user_image`` / ``read_user_document`` calls that
 * reference filenames mentioned earlier in the conversation would
 * then read the NEW bytes while the model thinks it's inspecting
 * the OLD ones.
 *
 * Returns an empty set on any error path. Graceful degradation —
 * worst case the uniquifier loses server-truth coverage and falls
 * back to in-store-only behavior. Better than blocking the user's
 * pick when the gateway is briefly slow.
 */
/**
 * Build the set of filenames the uniquifier should treat as already
 * claimed for ``threadId``. Two sources are merged (Codex P2 PR
 * #132 latest iteration):
 *
 * 1. Non-error chips already in the local store for this thread —
 *    covers within-batch and still-on-screen collisions. Error
 *    chips are excluded; they hold no file on disk.
 * 2. Server-side filenames in
 *    ``backend/.deer-flow/threads/{threadId}/user-data/uploads/`` —
 *    covers files that outlived their chip (chip cleared by the
 *    outbound-send hook after a turn sends, bytes remain on disk).
 *
 * The server lookup is done ONCE per file-selection batch (not per
 * file). Failure returns an empty set so a transient gateway error
 * degrades gracefully to in-store-only uniquification rather than
 * blocking the user's pick.
 *
 * Extracted out of ``handleFileSelection`` so that callback stays
 * below the Sentrux complex-function threshold (CC < 16).
 */
/**
 * Synchronous portion of the claimed-names set. Covers within-batch
 * and still-on-screen chip collisions. Excludes error chips (no file
 * on disk to collide with).
 *
 * Split out of ``buildClaimedFilenameSet`` (B1 of the silent-attach
 * fix, 2026-05-28): the chip-add path now runs this synchronously
 * BEFORE any await, so a hung ``/uploads/list`` fetch can't block
 * the user from seeing their chip. Server-truth seeding still
 * happens — see ``fetchExistingUploadFilenames`` + the post-hoc
 * rename loop inside ``handleFileSelection``.
 */
function buildInStoreClaimedSet(
  currentItems: PendingAttachment[],
): Set<string> {
  const claimed = new Set<string>()
  for (const item of currentItems) {
    if (item.status !== "error") claimed.add(item.filename)
  }
  return claimed
}

/**
 * Synchronous chip-creation pass — turns a FileList into a list of
 * Registrations, calls ``add(reg.item)`` for each so chips render
 * immediately, and decrements remainingSlots/claimed as it goes so
 * within-batch collisions get uniquified.
 *
 * Extracted from ``handleFileSelection`` so the callback stays under
 * Sentrux's CC ≥ 16 threshold (B5 extraction after Sentrux regression
 * on the first commit of the silent-attach fix).
 */
/**
 * Returns true when every registration in the batch was rejected
 * (e.g., all over the per-turn cap). Lets ``handleFileSelection``
 * short-circuit to a single banner without inlining the filter +
 * length check (saves CC).
 */
function allRejected(registrations: Registration[]): boolean {
  for (const reg of registrations) {
    if (!reg.skip) return false
  }
  return registrations.length > 0
}

/**
 * Glue: reads the current-thread chips out of the store, computes
 * remainingSlots + claimed-names, and delegates to
 * ``createRegistrationsForBatch``. Extracted so handleFileSelection's
 * cyclomatic complexity stays well below Sentrux's CC ≥ 16 gate.
 */
function preparePickedFiles(
  filesList: FileList,
  threadId: string,
  add: (item: PendingAttachment) => void,
): Registration[] {
  const currentItems = selectItemsForThread(threadId)(
    useAttachmentsStore.getState(),
  )
  const existingCounted = countNonError(currentItems)
  const remainingSlots = Math.max(MAX_ATTACHED_FILES_PER_TURN - existingCounted, 0)
  const claimed = buildInStoreClaimedSet(currentItems)
  return createRegistrationsForBatch(filesList, threadId, remainingSlots, claimed, add)
}

function countNonError(items: PendingAttachment[]): number {
  let n = 0
  for (const it of items) {
    if (it.status !== "error") n += 1
  }
  return n
}

/**
 * Post-hoc rename pass — after chips are visible and the server-truth
 * list arrives, rename any chip whose name collides with bytes-still-
 * on-disk from a prior turn. Mutates ``registrations`` in place +
 * fires store updates. B1 of the silent-attach fix.
 */
function applyServerTruthRenames(
  registrations: Registration[],
  serverNames: Set<string>,
  update: (clientId: string, patch: Partial<PendingAttachment>) => void,
): void {
  if (serverNames.size === 0) return
  const inBatch = new Set<string>()
  for (const reg of registrations) {
    if (!reg.skip) inBatch.add(reg.item.filename)
  }
  for (const reg of registrations) {
    if (reg.skip) continue
    if (!serverNames.has(reg.item.filename)) continue
    const merged = new Set<string>([...serverNames, ...inBatch])
    const renamed = uniquifyFilename(reg.item.filename, merged)
    if (renamed === reg.item.filename) continue
    inBatch.delete(reg.item.filename)
    inBatch.add(renamed)
    reg.file = new File([reg.file], renamed, {
      type: reg.file.type,
      lastModified: reg.file.lastModified,
    })
    reg.item = { ...reg.item, filename: renamed }
    update(reg.item.clientId, { filename: renamed })
  }
}

function createRegistrationsForBatch(
  filesList: FileList,
  threadId: string,
  initialRemainingSlots: number,
  claimed: Set<string>,
  add: (item: PendingAttachment) => void,
): Registration[] {
  let remainingSlots = initialRemainingSlots
  const registrations: Registration[] = []
  for (const file of Array.from(filesList)) {
    const reg = buildRegistration(file, threadId, remainingSlots, claimed)
    add(reg.item)
    if (!reg.skip) {
      remainingSlots -= 1
      // Subsequent picks in this batch must see this name as taken
      // (within-batch collision: two ``image.png`` files picked
      // together).
      claimed.add(reg.item.filename)
    }
    registrations.push(reg)
  }
  return registrations
}

/**
 * Post-hoc rename pass — after chips are already in the store and
 * the server-truth list arrives, rename any chip whose name collides
 * with an on-disk file the user can't see in their store anymore
 * (chip cleared by ``useSessionOutboundSend`` after a previous turn,
 * bytes left on disk).
 *
 * Mutates ``registrations`` in place: each affected registration gets
 * a new ``filename`` on its item, and ``file`` is reconstructed with
 * the new name so the multipart body matches. Also fires
 * ``update(clientId, {filename})`` so the chip text updates.
 *
 * Extracted from ``handleFileSelection`` so the callback stays under
 * Sentrux's CC ≥ 16 threshold (B5 follow-up after Sentrux regression
 * surfaced on first commit of the silent-attach fix).
 */

// 4-second cap on the server-truth uploads-list lookup. Production
// evidence (2026-05-28 silent-attach incident): zero ``/uploads*``
// activity in gateway logs at the user's session timestamp, suggesting
// either a hung Vercel fetch or a never-resolved await. Without an
// abort cap, ``fetchExistingUploadFilenames`` could block any caller
// that awaits it. The chip-add path now no longer awaits this helper
// (see ``handleFileSelection`` below), so the cap is defense-in-depth
// for the post-hoc rename path AND any future caller that does block.
const UPLOADS_LIST_TIMEOUT_MS = 4000

async function fetchExistingUploadFilenames(threadId: string): Promise<Set<string>> {
  // ``AbortSignal.timeout`` is available in all modern browsers and in
  // Node 18+. If the upstream proxy hangs, the controller aborts the
  // fetch and the catch branch returns an empty set — same outcome as
  // a 500 or a network error.
  const signal = AbortSignal.timeout(UPLOADS_LIST_TIMEOUT_MS)
  try {
    const res = await fetch(
      `/api/threads/${encodeURIComponent(threadId)}/uploads/list`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
    )
    if (!res.ok) return new Set()
    const data = (await res.json()) as { files?: Array<{ filename?: unknown }> }
    if (!Array.isArray(data.files)) return new Set()
    const names = new Set<string>()
    for (const entry of data.files) {
      if (entry && typeof entry.filename === "string") {
        names.add(entry.filename)
      }
    }
    return names
  } catch {
    return new Set()
  }
}

/**
 * Fire ``DELETE`` against the backend uploads directory for a
 * specific filename in a thread. Returns ``true`` on 2xx; ``false``
 * on any failure. Doesn't touch the store — caller decides what
 * to do with the result.
 */
async function deleteUploadedFile(threadId: string, filename: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/threads/${encodeURIComponent(threadId)}/uploads/${encodeURIComponent(filename)}`,
      { method: "DELETE" },
    )
    return res.ok
  } catch {
    return false
  }
}

/**
 * Handle the × click on a chip.
 *
 * Codex P2 PR #132 (two-part):
 *
 * - status === "uploaded": file is already on disk. Transition the
 *   chip to ``deleting`` (Loader2 visible, send-gate stays on),
 *   fire DELETE, remove on 2xx; flip to ``error`` on failure so
 *   the user knows the file is still on disk.
 *
 * - status === "uploading": THE UPLOAD IS STILL IN FLIGHT. We MUST
 *   keep the chip in the store with a "still in flight" status
 *   (``deleting``) so ``selectHasUploadsInFlight`` continues to
 *   gate the composer. ``uploadOneFile`` will see the ``deleting``
 *   status when its fetch settles and act accordingly: DELETE the
 *   resulting file if upload succeeded, just drop the chip if it
 *   failed. If we instead removed the chip here, the upload would
 *   still complete (writing bytes to the sandbox) and the user
 *   could submit a turn or start a builder task with an orphaned
 *   file on disk that ``_copy_parent_uploaded_images`` would later
 *   surface.
 *
 * - status === "deleting": already discarded; ignore the click.
 *
 * - status === "error": no file on disk; just remove locally.
 */
async function handleChipDiscard(
  item: PendingAttachment,
  threadId: string,
  remove: (clientId: string) => void,
  update: (clientId: string, patch: Partial<PendingAttachment>) => void,
): Promise<void> {
  if (item.status === "deleting") return
  if (item.status === "error") {
    remove(item.clientId)
    return
  }
  if (item.status === "uploading") {
    // Don't remove from the store — uploadOneFile will read the
    // current status when its fetch settles and DELETE / drop as
    // appropriate. Just flip the status so the gate stays honest
    // and the chip spinner reflects the discard intent.
    update(item.clientId, { status: "deleting", error: undefined })
    return
  }
  // status === "uploaded"
  update(item.clientId, { status: "deleting", error: undefined })
  const ok = await deleteUploadedFile(threadId, item.filename)
  if (ok) {
    remove(item.clientId)
    return
  }
  update(item.clientId, {
    status: "error",
    error: "Couldn't remove from server. The file may still be in this session's uploads.",
  })
}

/**
 * Read the current store status for ``clientId`` — needed because
 * the user can transition a chip to ``deleting`` (via × click)
 * while its upload is still in flight. ``uploadOneFile`` re-reads
 * after the fetch settles so it can DELETE the resulting file
 * instead of silently marking it ``uploaded``. Codex P2 PR #132.
 */
function readChipStatus(clientId: string): PendingAttachment["status"] | null {
  const item = useAttachmentsStore
    .getState()
    .items.find((entry) => entry.clientId === clientId)
  return item ? item.status : null
}

/**
 * Upload one file and apply the resulting store patch.
 *
 * Codex P2 PR #132 — race handling: between the time we POST and
 * the time we get a response, the user can click × on the chip.
 * ``handleChipDiscard`` flips the chip's status to ``deleting``
 * but DOES NOT remove it (so ``selectHasUploadsInFlight`` keeps the
 * send-gate on). When this function's fetch resolves, it checks
 * the current chip status:
 *
 * - status is still ``uploading``: normal happy path → mark
 *   ``uploaded`` (or ``error``).
 * - status is ``deleting``: user discarded mid-upload. If the
 *   upload succeeded (file now on disk), fire DELETE on it; either
 *   way drop the chip from the store. Without this branch the file
 *   would stay on disk and a later ``start_builder_task`` would
 *   surface it to the builder despite the user's discard.
 */
async function uploadOneFile(
  reg: Registration,
  threadId: string,
  update: (clientId: string, patch: Partial<PendingAttachment>) => void,
  remove: (clientId: string) => void,
): Promise<void> {
  const fd = new FormData()
  fd.append("files", reg.file, reg.file.name)
  try {
    const res = await fetch(
      `/api/threads/${encodeURIComponent(threadId)}/uploads`,
      { method: "POST", body: fd },
    )
    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      // Whether the chip is still ``uploading`` or already
      // ``deleting``, there's nothing on disk to clean up — drop
      // the chip if discarded, mark error otherwise.
      if (readChipStatus(reg.item.clientId) === "deleting") {
        remove(reg.item.clientId)
        return
      }
      update(reg.item.clientId, {
        status: "error",
        error: `Upload failed (${res.status}). ${errText.slice(0, 120)}`,
      })
      return
    }
    const data = (await res.json()) as UploadResponseShape
    const echo =
      data.files?.find((entry) => entry.filename === reg.file.name) ??
      data.files?.[0]
    if (!echo) {
      // Upload succeeded but echo missing — server's behavior is
      // ambiguous. Safer to leave the chip in error than to assume
      // anything about disk state.
      if (readChipStatus(reg.item.clientId) === "deleting") {
        remove(reg.item.clientId)
        return
      }
      update(reg.item.clientId, {
        status: "error",
        error: "Upload succeeded but server returned no file metadata.",
      })
      return
    }
    // Upload landed. Did the user discard during the upload?
    if (readChipStatus(reg.item.clientId) === "deleting") {
      // File is on disk. Fire DELETE; on failure leave an error
      // chip so the user knows the file is stranded.
      const deleted = await deleteUploadedFile(threadId, echo.filename)
      if (deleted) {
        remove(reg.item.clientId)
      } else {
        update(reg.item.clientId, {
          status: "error",
          error: "Couldn't remove the uploaded file from the server. It may still be in this session's uploads.",
        })
      }
      return
    }
    // Normal happy path.
    update(reg.item.clientId, {
      status: "uploaded",
      filename: echo.filename,
      size: Number(echo.size) || reg.item.size,
      hasMarkdownConversion: Boolean(echo.markdown_file),
    })
  } catch (error) {
    if (readChipStatus(reg.item.clientId) === "deleting") {
      remove(reg.item.clientId)
      return
    }
    const message = error instanceof Error ? error.message : "Network error"
    update(reg.item.clientId, { status: "error", error: message })
  }
}

export function AttachmentBar({
  threadId,
  disabled = false,
  className,
  hideInternalPaperclip = false,
  openPickerRef,
}: AttachmentBarProps) {
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

  // Transient status banner for the silent-failure cases the chip row
  // can't itself communicate (B3 of the silent-attach fix, 2026-05-28):
  // - ``threadId`` was null at file-pick time → "session not ready"
  // - Every pick in the batch was cap-rejected → "limit reached"
  //
  // The banner stays visible until the user picks again (the setter
  // is called fresh each pick) or refreshes; no auto-dismiss timer
  // because adding one trips Sentrux's complex-function gate.
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const handlePaperclipClick = useCallback(() => {
    if (!isInteractive) {
      // The button shouldn't even be clickable in this state, but if
      // somehow the disabled gate is bypassed (focus + Enter on a
      // stale render, etc.) surface why nothing happened.
      if (!threadId) {
        setStatusMessage("Can't attach — session not ready. Try again in a moment.")
      }
      return
    }
    inputRef.current?.click()
  }, [isInteractive, threadId])

  // Expose the picker trigger upward so an externally-rendered
  // paperclip button (e.g. in the Composer's bottom action row) can
  // share its alignment with the Send button while still using the
  // bar's hidden file input. B4 of the silent-attach fix.
  useEffect(() => {
    if (!openPickerRef) return
    openPickerRef.current = handlePaperclipClick
    return () => {
      openPickerRef.current = null
    }
  }, [openPickerRef, handlePaperclipClick])

  const handleRemoveChip = useCallback(
    (item: PendingAttachment) => {
      if (!threadId) {
        remove(item.clientId)
        return
      }
      void handleChipDiscard(item, threadId, remove, update)
    },
    [threadId, remove, update],
  )

  const handleFileSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const filesList = event.target.files
      // Reset immediately so picking the same file twice in a row works.
      event.target.value = ""
      if (!filesList || filesList.length === 0) return
      if (!threadId) {
        // Surface the "session not ready" early-return instead of
        // silently swallowing the pick (B3 of silent-attach fix).
        setStatusMessage("Can't attach — session not ready. Try again in a moment.")
        return
      }
      const registrations = preparePickedFiles(filesList, threadId, add)
      // Cap-reached toast: if EVERY pick was rejected, surface why.
      if (allRejected(registrations)) {
        setStatusMessage(
          `Attachment limit reached (${MAX_ATTACHED_FILES_PER_TURN} per turn). Send your message first, then attach more.`,
        )
      }
      // Phase 2: server-truth uniquify (post-hoc rename). Bounded by
      // ``UPLOADS_LIST_TIMEOUT_MS`` (4s); failure → no renames →
      // chips ship with in-store-only names.
      applyServerTruthRenames(
        registrations,
        await fetchExistingUploadFilenames(threadId),
        update,
      )
      // Phase 3: upload one at a time so error attribution stays
      // simple and parallel writes to the same sandbox dir don't race.
      for (const reg of registrations) {
        if (reg.skip) continue
        await uploadOneFile(reg, threadId, update, remove)
      }
    },
    [threadId, add, update, remove],
  )

  const tooltip = isInteractive
    ? "Attach an image or document"
    : threadId
      ? "Attachments unavailable in this session"
      : "Start a session to attach files"

  // Nothing to render at all when bar is empty and disabled — the
  // composer stays uncluttered until the user has a reason to attach.
  // Exception: if a status banner is queued (B3 of the silent-attach
  // fix), render so the user sees the feedback even if no chip was
  // created (e.g., "session not ready" early-return).
  if (!isInteractive && items.length === 0 && !statusMessage) {
    return null
  }

  return (
    <div
      className={`flex flex-col gap-1 ${className ?? ""}`}
      data-testid="attachment-bar"
    >
      {statusMessage ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="attachment-bar-status"
          className="rounded-md bg-sophia-purple/10 px-3 py-1.5 text-xs text-sophia-text2"
        >
          {statusMessage}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
      {hideInternalPaperclip ? null : (
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
      )}

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
        const isInFlight = item.status === "uploading" || item.status === "deleting"
        const statusClass =
          item.status === "error"
            ? "border-red-400/60 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
            : isInFlight
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
            {isInFlight ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Icon className="h-3.5 w-3.5" />
            )}
            <span className="truncate">{item.filename}</span>
            <button
              type="button"
              onClick={() => handleRemoveChip(item)}
              aria-label={`Remove ${item.filename}`}
              disabled={item.status === "deleting"}
              className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      })}
      </div>
    </div>
  )
}
