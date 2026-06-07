/**
 * Long-message → attachment spill for the chat route.
 *
 * Replaces the old silent 2000-char truncation in ``sanitizeMessage``.
 * When a sent chat message exceeds ``SPILL_THRESHOLD``, we persist the
 * FULL text as a thread upload (``chat-message-<id>.md``) via the same
 * gateway endpoint the AttachmentBar uses — which also mirrors it to
 * Supabase, so the langgraph-side ``read_user_document`` tool can read it
 * cross-service. The forwarded inline message becomes a bounded head
 * preview + a pointer; the companion reads the rest on demand (paging via
 * the tool's ``offset`` parameter). Nothing is truncated.
 *
 * Best-effort: if there is no thread to attach to (new-session bootstrap)
 * or the upload fails, we fall back to forwarding the full message inline
 * — we never re-introduce the silent cut, and never point the model at a
 * file that isn't there.
 *
 * Mirrors the gateway-upload call shape in
 * ``app/api/threads/[threadId]/uploads/route.ts::forwardUploadToGateway``
 * (fresh FormData, Bearer auth, NO manual Content-Type so fetch sets the
 * multipart boundary).
 */

import { secureLog } from './config';
import { HEAD_PREVIEW_CHARS, SPILL_THRESHOLD } from './request-validation';

const SPILL_FILE_PREFIX = 'chat-message-';

export type SpillResult = {
  /** True when the full message was persisted as an attachment. */
  spilled: boolean;
  /**
   * The message body to forward inline. When spilled, a bounded head
   * preview + a pointer telling the model to read the attachment;
   * otherwise the full message unchanged.
   */
  primaryMessage: string;
  /**
   * The full, unmodified message. The backend client uses this on the
   * stale-thread recovery path (which forces ``attached_files=[]``) so
   * the recovered turn still carries the complete content inline rather
   * than a dangling ``read_user_document`` instruction.
   */
  rawMessage: string;
  /** ``attachedFiles`` with the spilled filename appended on success. */
  attachedFiles: string[];
};

/**
 * A prompt-safe, per-turn-unique filename matching the server
 * ``attached_files`` allow-list ``^[A-Za-z0-9._-]+$`` (and well under the
 * 255-char cap). ``.md`` keeps ``read_user_document`` on its fast direct
 * UTF-8 read path (no markitdown conversion).
 */
function buildSpillFilename(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${SPILL_FILE_PREFIX}${stamp}-${rand}.md`;
}

function buildPrimaryMessage(fullMessage: string, filename: string): string {
  const head = fullMessage.slice(0, HEAD_PREVIEW_CHARS);
  return (
    `${head}\n\n` +
    `[This message is ${fullMessage.length} characters long; only the first ` +
    `${head.length} are shown above. The complete text was saved as the ` +
    `attachment "${filename}". Call read_user_document('${filename}') to read ` +
    `the rest (pass the offset from each footer to page through it if needed).]`
  );
}

async function uploadSpillDocument(
  fullMessage: string,
  filename: string,
  threadId: string,
  apiKey: string | null,
  gatewayUrl: string,
): Promise<boolean> {
  const form = new FormData();
  const file = new File([fullMessage], filename, { type: 'text/plain' });
  form.append('files', file, filename);
  // NOTE: do NOT set Content-Type — fetch auto-sets the multipart
  // boundary when the body is FormData (see the uploads proxy route).
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const targetUrl = `${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}/uploads`;
  try {
    const upstream = await fetch(targetUrl, { method: 'POST', headers, body: form });
    if (!upstream.ok) {
      secureLog('[/api/chat] message spill upload failed', { status: upstream.status });
      return false;
    }
    return true;
  } catch (error) {
    secureLog('[/api/chat] message spill upload threw', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

export async function maybeSpillLongMessage(params: {
  fullMessage: string;
  threadId: string | undefined;
  attachedFiles: string[];
  apiKey: string | null;
  gatewayUrl: string;
}): Promise<SpillResult> {
  const { fullMessage, threadId, attachedFiles, apiKey, gatewayUrl } = params;

  const noSpill: SpillResult = {
    spilled: false,
    primaryMessage: fullMessage,
    rawMessage: fullMessage,
    attachedFiles,
  };

  // Short messages, or no thread to attach to (new-session bootstrap),
  // go inline verbatim — no truncation either way.
  if (fullMessage.length <= SPILL_THRESHOLD) return noSpill;
  if (typeof threadId !== 'string' || !threadId) return noSpill;

  const filename = buildSpillFilename();
  const ok = await uploadSpillDocument(fullMessage, filename, threadId, apiKey, gatewayUrl);
  if (!ok) {
    // Upload failed / Supabase unavailable: fall back to inline so we
    // never tell the model to read a file that isn't there.
    return noSpill;
  }

  secureLog('[/api/chat] spilled long message to attachment', {
    chars: fullMessage.length,
    filename,
  });
  return {
    spilled: true,
    primaryMessage: buildPrimaryMessage(fullMessage, filename),
    rawMessage: fullMessage,
    attachedFiles: [...attachedFiles, filename],
  };
}
