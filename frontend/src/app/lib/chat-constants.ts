/**
 * Shared chat-pipeline constants.
 *
 * Single source of truth for caps and limits that BOTH the client
 * composer UI and the server-side `/api/chat` post-handler need to
 * agree on. Keeping them in one module prevents the two sides from
 * drifting — a future bump on one side without the other would
 * silently truncate attachments / messages post-send and the user
 * would see chips disappear without knowing why.
 */

/**
 * Maximum number of uploaded filenames carried on a single chat turn
 * via `attached_files`. The server-side post-handler caps at this
 * number after sanitization (`parseAndValidateChatPayload`); the
 * AttachmentBar enforces the same cap at file-pick time so chips
 * over the limit are surfaced as errors instead of silently uploading
 * and then being dropped from the request payload.
 *
 * Why 12: generous for typical "look at these screenshots" UX
 * (1–3 files), bounded enough that a malicious client can't blow
 * the system prompt budget naming files. Codex P2 review on PR #132
 * is the rationale for client-side enforcement matching the
 * server-side cap exactly.
 */
export const MAX_ATTACHED_FILES_PER_TURN = 12;
