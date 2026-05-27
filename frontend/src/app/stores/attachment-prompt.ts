/**
 * Build the synthesized prefix the /api/chat post-handler prepends to
 * the user's message when they've uploaded files via AttachmentBar.
 *
 * Kept in its own dependency-free module (no React, no Zustand) so the
 * server-side post-handler can import it without dragging the client
 * store into its bundle. The client-side AttachmentBar pulls it
 * indirectly via `attachments-store.ts` re-export.
 *
 * Both the post-handler and tests share the exact same format string —
 * if we change the wording, both move in lockstep.
 */

/**
 * Allow-list mirroring ``chat-request.ts::SAFE_PROMPT_FILENAME``
 * and the builder-side ``_SAFE_UPLOADED_IMAGE_PATH``. Defense in
 * depth (Codex P2 PR #132): even if the sanitizer in
 * ``parseAndValidateChatPayload`` is ever weakened or bypassed (a
 * future refactor, a test fixture that constructs the payload
 * directly, etc.), this filter at the render seam guarantees that
 * tag-breakout payloads can't reach the model.
 *
 * Filenames that fail this filter are silently dropped from the
 * rendered list — better to under-tell the model than to inject
 * a sanitized-but-uncertain string into its prompt context.
 */
const SAFE_PROMPT_FILENAME = /^[A-Za-z0-9._-]+$/

export function buildAttachmentPrompt(filenames: string[]): string {
  const safe = filenames.filter((name) => SAFE_PROMPT_FILENAME.test(name))
  if (safe.length === 0) return ""
  const list = safe.map((name) => `- ${name}`).join("\n")
  return (
    `[The user has uploaded ${safe.length} file(s) for this turn.\n` +
    `Use view_user_image(image_filename) for images or read_user_document(document_filename) for documents — ` +
    `passing just the bare filename, no path. Only inspect the file(s) actually relevant to their question.\n` +
    `${list}]`
  )
}
