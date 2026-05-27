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

export function buildAttachmentPrompt(filenames: string[]): string {
  if (filenames.length === 0) return ""
  const list = filenames.map((name) => `- ${name}`).join("\n")
  return (
    `[The user has uploaded ${filenames.length} file(s) for this turn.\n` +
    `Use view_user_image(image_filename) for images or read_user_document(document_filename) for documents — ` +
    `passing just the bare filename, no path. Only inspect the file(s) actually relevant to their question.\n` +
    `${list}]`
  )
}
