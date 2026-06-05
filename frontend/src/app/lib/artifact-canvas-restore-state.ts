import type { ArtifactRendererKind } from "./artifact-renderers"
import { buildCoreviewArtifactStableIdentity, normalizeCoreviewArtifactPath } from "./coreview-artifact-identity"

export const ARTIFACT_CANVAS_RESTORE_STORAGE_VERSION = 1

export type ArtifactCanvasRestoreResult =
  | "unavailable"
  | "empty"
  | "closed"
  | "corrupt"
  | "context_mismatch"
  | "invalid_artifact"
  | "restored"
  | "saved"
  | "cleared"
  | "failed"

export interface ArtifactCanvasRestoreContext {
  userId?: string | null
  threadId?: string | null
  sessionId?: string | null
}

export interface ArtifactCanvasOpenStateInput {
  artifactPath?: string | null
  rendererKind?: ArtifactRendererKind | string | null
  stableArtifactIdentity?: string | null
  openedAt?: number
  updatedAt?: number
}

export interface ArtifactCanvasOpenStateV1 {
  version: 1
  open: boolean
  userId: string | null
  threadId: string | null
  sessionId: string | null
  stableArtifactIdentity: string
  stableArtifactIdentityHash: string
  normalizedArtifactPath: string
  rendererKind: string
  openedAt: number
  updatedAt: number
}

export interface ArtifactCanvasRestoreReadResult {
  state: ArtifactCanvasOpenStateV1 | null
  result: ArtifactCanvasRestoreResult
  storageKeyHash: string | null
}

export interface ArtifactCanvasRestoreWriteResult {
  state: ArtifactCanvasOpenStateV1 | null
  result: ArtifactCanvasRestoreResult
  storageKeyHash: string | null
}

const STORAGE_PREFIX = "sophia:artifact-canvas-open:v1:"

export function persistArtifactCanvasOpenState(
  context: ArtifactCanvasRestoreContext,
  input: ArtifactCanvasOpenStateInput,
): ArtifactCanvasRestoreWriteResult {
  const storageKey = buildArtifactCanvasRestoreStorageKey(context)
  const storage = getLocalStorage()
  if (!storage || !storageKey.key) {
    return { state: null, result: storageKey.key ? "unavailable" : "invalid_artifact", storageKeyHash: storageKey.hash }
  }

  const normalizedArtifactPath = normalizeCoreviewArtifactPath(input.artifactPath)
  const rendererKind = normalizeToken(input.rendererKind)
  if (!normalizedArtifactPath || !rendererKind) {
    return { state: null, result: "invalid_artifact", storageKeyHash: storageKey.hash }
  }

  const normalizedContext = normalizeContext(context)
  const now = Date.now()
  const stableArtifactIdentity = normalizeStableArtifactIdentity(input.stableArtifactIdentity)
    ?? buildCoreviewArtifactStableIdentity({
      userId: normalizedContext.userId,
      threadId: normalizedContext.threadId,
      artifactPath: normalizedArtifactPath,
      rendererKind,
    }).key
  const openedAt = normalizeTimestamp(input.openedAt) ?? now
  const state: ArtifactCanvasOpenStateV1 = {
    version: ARTIFACT_CANVAS_RESTORE_STORAGE_VERSION,
    open: true,
    userId: normalizedContext.userId,
    threadId: normalizedContext.threadId,
    sessionId: normalizedContext.sessionId,
    stableArtifactIdentity,
    stableArtifactIdentityHash: stableHash(stableArtifactIdentity),
    normalizedArtifactPath,
    rendererKind,
    openedAt,
    updatedAt: normalizeTimestamp(input.updatedAt) ?? now,
  }

  try {
    storage.setItem(storageKey.key, JSON.stringify(state))
    return { state, result: "saved", storageKeyHash: storageKey.hash }
  } catch {
    return { state: null, result: "failed", storageKeyHash: storageKey.hash }
  }
}

export function clearArtifactCanvasOpenState(
  context: ArtifactCanvasRestoreContext,
): ArtifactCanvasRestoreWriteResult {
  const storageKey = buildArtifactCanvasRestoreStorageKey(context)
  const storage = getLocalStorage()
  if (!storage || !storageKey.key) {
    return { state: null, result: storageKey.key ? "unavailable" : "empty", storageKeyHash: storageKey.hash }
  }

  try {
    storage.removeItem(storageKey.key)
    return { state: null, result: "cleared", storageKeyHash: storageKey.hash }
  } catch {
    return { state: null, result: "failed", storageKeyHash: storageKey.hash }
  }
}

export function restoreArtifactCanvasOpenState(
  context: ArtifactCanvasRestoreContext,
): ArtifactCanvasRestoreReadResult {
  const storageKey = buildArtifactCanvasRestoreStorageKey(context)
  const storage = getLocalStorage()
  if (!storage || !storageKey.key) {
    return { state: null, result: storageKey.key ? "unavailable" : "empty", storageKeyHash: storageKey.hash }
  }

  const raw = safeGetItem(storage, storageKey.key)
  if (!raw) {
    return { state: null, result: "empty", storageKeyHash: storageKey.hash }
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const state = normalizeStoredCanvasState(parsed)
    if (!state) {
      storage.removeItem(storageKey.key)
      return { state: null, result: "corrupt", storageKeyHash: storageKey.hash }
    }
    if (!state.open) {
      return { state: null, result: "closed", storageKeyHash: storageKey.hash }
    }
    if (!canvasRestoreContextMatches(context, state)) {
      return { state: null, result: "context_mismatch", storageKeyHash: storageKey.hash }
    }
    return { state, result: "restored", storageKeyHash: storageKey.hash }
  } catch {
    try {
      storage.removeItem(storageKey.key)
    } catch {
      // Storage cleanup is best-effort.
    }
    return { state: null, result: "corrupt", storageKeyHash: storageKey.hash }
  }
}

export function hashArtifactCanvasRestoreIdentity(value: string | null | undefined): string | null {
  const normalized = normalizeToken(value)
  return normalized ? stableHash(normalized) : null
}

function buildArtifactCanvasRestoreStorageKey(context: ArtifactCanvasRestoreContext): {
  key: string | null
  hash: string | null
} {
  const normalized = normalizeContext(context)
  if (!normalized.threadId && !normalized.sessionId) {
    return { key: null, hash: null }
  }
  const contextKey = [
    `user:${normalized.userId ?? "unknown"}`,
    `thread:${normalized.threadId ?? "unknown"}`,
    `session:${normalized.sessionId ?? "unknown"}`,
  ].join("|")
  const hash = stableHash(contextKey)
  return {
    key: `${STORAGE_PREFIX}${hash}`,
    hash,
  }
}

function normalizeStoredCanvasState(value: unknown): ArtifactCanvasOpenStateV1 | null {
  if (!isRecord(value) || value.version !== ARTIFACT_CANVAS_RESTORE_STORAGE_VERSION) {
    return null
  }
  const normalizedArtifactPath = normalizeCoreviewArtifactPath(normalizeToken(value.normalizedArtifactPath))
  const rendererKind = normalizeToken(value.rendererKind)
  const stableArtifactIdentity = normalizeStableArtifactIdentity(value.stableArtifactIdentity)
  const openedAt = normalizeTimestamp(value.openedAt)
  const updatedAt = normalizeTimestamp(value.updatedAt)
  if (!normalizedArtifactPath || !rendererKind || !stableArtifactIdentity || openedAt === null || updatedAt === null) {
    return null
  }
  return {
    version: ARTIFACT_CANVAS_RESTORE_STORAGE_VERSION,
    open: value.open === true,
    userId: normalizeToken(value.userId),
    threadId: normalizeToken(value.threadId),
    sessionId: normalizeToken(value.sessionId),
    stableArtifactIdentity,
    stableArtifactIdentityHash: stableHash(stableArtifactIdentity),
    normalizedArtifactPath,
    rendererKind,
    openedAt,
    updatedAt,
  }
}

function canvasRestoreContextMatches(
  context: ArtifactCanvasRestoreContext,
  state: ArtifactCanvasOpenStateV1,
): boolean {
  const normalized = normalizeContext(context)
  return normalized.userId === state.userId
    && normalized.threadId === state.threadId
    && normalized.sessionId === state.sessionId
}

function normalizeContext(context: ArtifactCanvasRestoreContext): Required<ArtifactCanvasRestoreContext> {
  return {
    userId: normalizeToken(context.userId),
    threadId: normalizeToken(context.threadId),
    sessionId: normalizeToken(context.sessionId),
  }
}

function normalizeStableArtifactIdentity(value: unknown): string | null {
  const normalized = normalizeToken(value)
  if (!normalized) {
    return null
  }
  const parts = normalized.split("|")
  let changed = false
  const canonicalParts = parts.map((part) => {
    if (!part.startsWith("path:")) {
      return part
    }
    const canonicalPath = normalizeCoreviewArtifactPath(part.slice("path:".length))
    if (!canonicalPath || canonicalPath === part.slice("path:".length)) {
      return part
    }
    changed = true
    return `path:${canonicalPath}`
  })
  return changed ? canonicalParts.join("|") : normalized
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function safeGetItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function stableHash(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
