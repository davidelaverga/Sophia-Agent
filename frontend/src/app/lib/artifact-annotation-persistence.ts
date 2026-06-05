import type {
  ArtifactAnnotation,
  ArtifactAnnotationColor,
  ArtifactAnnotationKind,
  ArtifactAnnotationSource,
  NormalizedArtifactLine,
  NormalizedArtifactPoint,
  NormalizedArtifactRect,
} from "../types/artifact-annotations"

import { normalizeCoreviewArtifactPath } from "./coreview-artifact-identity"

export const ARTIFACT_ANNOTATION_STORAGE_VERSION = 1

export type ArtifactAnnotationPersistenceStatus =
  | "unavailable"
  | "empty"
  | "restored"
  | "corrupt"
  | "saved"
  | "failed"

export interface ArtifactAnnotationStorageIdentityInput {
  artifactStableIdentity?: string | null
  threadId?: string | null
  artifactId?: string | null
  artifactPath?: string | null
  rendererKind?: string | null
}

export interface ArtifactAnnotationWorkspaceIdentity {
  stableArtifactIdentity: string | null
  storageKey: string | null
  storageKeyHash: string | null
}

export interface ArtifactAnnotationWorkspaceStateV1 {
  version: 1
  stableArtifactIdentity: string | null
  annotations: ArtifactAnnotation[]
  updatedAt?: number
}

export interface ArtifactAnnotationRestoreResult {
  annotations: ArtifactAnnotation[]
  status: ArtifactAnnotationPersistenceStatus
  restoreCount: number
  version: number
}

export interface ArtifactAnnotationPersistResult {
  status: ArtifactAnnotationPersistenceStatus
  persistedCount: number
  version: number
}

const STORAGE_PREFIX = "sophia:artifact-review-annotations:v1:"
const MAX_PERSISTED_ANNOTATIONS = 500
const MAX_COMMENT_TEXT_LENGTH = 180

export function buildArtifactAnnotationWorkspaceIdentity(
  input: ArtifactAnnotationStorageIdentityInput,
): ArtifactAnnotationWorkspaceIdentity {
  const artifactPath = normalizeCoreviewArtifactPath(input.artifactPath) ?? normalizeToken(input.artifactPath)
  const stableIdentity = normalizeStableArtifactIdentity(input.artifactStableIdentity)
  const rendererKind = normalizeToken(input.rendererKind)
  const artifactId = normalizeToken(input.artifactId)
  const threadId = normalizeToken(input.threadId)

  if (!stableIdentity && !artifactPath && !artifactId) {
    return {
      stableArtifactIdentity: null,
      storageKey: null,
      storageKeyHash: null,
    }
  }

  const stableArtifactIdentity = stableIdentity ?? [
    `user:unknown`,
    `thread:${threadId ?? "unknown"}`,
    `path:${artifactPath ?? "unknown"}`,
    `renderer:${rendererKind ?? "unknown"}`,
    artifactId ? `artifact:${artifactId}` : null,
  ].filter((part): part is string => Boolean(part)).join("|")
  const storageKeyHash = stableHash(stableArtifactIdentity)

  return {
    stableArtifactIdentity,
    storageKey: `${STORAGE_PREFIX}${storageKeyHash}`,
    storageKeyHash,
  }
}

export function buildArtifactAnnotationStorageKey(
  input: ArtifactAnnotationStorageIdentityInput,
): string | null {
  return buildArtifactAnnotationWorkspaceIdentity(input).storageKey
}

export function hashArtifactAnnotationStorageKey(storageKey: string | null): string | null {
  const normalized = normalizeToken(storageKey)
  if (!normalized) {
    return null
  }
  return normalized.startsWith(STORAGE_PREFIX)
    ? normalized.slice(STORAGE_PREFIX.length)
    : stableHash(normalized)
}

export function restoreArtifactAnnotations(
  storageKey: string | null,
  stableArtifactIdentity: string | null = null,
): ArtifactAnnotationRestoreResult {
  const storage = getLocalStorage()
  if (!storage || !storageKey) {
    return {
      annotations: [],
      status: storageKey ? "unavailable" : "empty",
      restoreCount: 0,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    }
  }

  const raw = safeGetItem(storage, storageKey)
  if (!raw) {
    return {
      annotations: [],
      status: "empty",
      restoreCount: 0,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    }
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const annotations = annotationsFromStoragePayload(parsed, stableArtifactIdentity)
    if (!annotations) {
      safeRemoveItem(storage, storageKey)
      return {
        annotations: [],
        status: "corrupt",
        restoreCount: 0,
        version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
      }
    }
    return {
      annotations,
      status: annotations.length > 0 ? "restored" : "empty",
      restoreCount: annotations.length,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    }
  } catch {
    safeRemoveItem(storage, storageKey)
    return {
      annotations: [],
      status: "corrupt",
      restoreCount: 0,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    }
  }
}

export function persistArtifactAnnotations(
  storageKey: string | null,
  annotations: ArtifactAnnotation[],
  options: { stableArtifactIdentity?: string | null; actorId?: string | null } = {},
): ArtifactAnnotationPersistResult {
  const storage = getLocalStorage()
  if (!storage || !storageKey) {
    return {
      status: storageKey ? "unavailable" : "empty",
      persistedCount: 0,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    }
  }

  const normalized = annotations
    .map((annotation) => normalizeStoredAnnotation(annotation, options.stableArtifactIdentity, options.actorId))
    .filter((annotation): annotation is ArtifactAnnotation => annotation !== null)
    .slice(0, MAX_PERSISTED_ANNOTATIONS)

  try {
    if (normalized.length === 0) {
      safeRemoveItem(storage, storageKey)
    } else {
      storage.setItem(storageKey, JSON.stringify({
        version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
        stableArtifactIdentity: normalizeToken(options.stableArtifactIdentity),
        annotations: normalized,
        updatedAt: Date.now(),
      } satisfies ArtifactAnnotationWorkspaceStateV1))
    }
    return {
      status: "saved",
      persistedCount: normalized.length,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    }
  } catch {
    return {
      status: "failed",
      persistedCount: 0,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    }
  }
}

function annotationsFromStoragePayload(
  value: unknown,
  fallbackStableArtifactIdentity: string | null,
): ArtifactAnnotation[] | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.version !== ARTIFACT_ANNOTATION_STORAGE_VERSION) {
    return null
  }
  if (!Array.isArray(value.annotations)) {
    return null
  }

  const annotations: ArtifactAnnotation[] = []
  const stableArtifactIdentity = normalizeToken(value.stableArtifactIdentity) ?? normalizeToken(fallbackStableArtifactIdentity)
  for (const entry of value.annotations.slice(0, MAX_PERSISTED_ANNOTATIONS)) {
    const annotation = normalizeStoredAnnotation(entry, stableArtifactIdentity)
    if (annotation) {
      annotations.push(annotation)
    }
  }
  return annotations
}

function normalizeStoredAnnotation(
  value: unknown,
  fallbackStableArtifactIdentity: string | null = null,
  fallbackActorId: string | null = null,
): ArtifactAnnotation | null {
  if (!isRecord(value)) {
    return null
  }
  const id = normalizeToken(value.id)
  const kind = normalizeAnnotationKind(value.kind)
  const pageIndex = normalizePageIndex(value.pageIndex)
  const createdAt = normalizeTimestamp(value.createdAt)
  if (!id || !kind || pageIndex === null || createdAt === null) {
    return null
  }

  const color = normalizeAnnotationColor(value.color)
  const source = normalizeAnnotationSource(value.source)
  const artifactStableIdentity = normalizeToken(value.artifactStableIdentity) ?? normalizeToken(fallbackStableArtifactIdentity)
  const actorId = normalizeToken(value.actorId) ?? normalizeToken(fallbackActorId)
  const updatedAt = normalizeTimestamp(value.updatedAt) ?? createdAt
  const base = {
    id,
    kind,
    artifactStableIdentity,
    ...(actorId ? { actorId } : {}),
    pageIndex,
    ...(color ? { color } : {}),
    source: source ?? "user",
    createdAt,
    updatedAt,
    version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
  }

  if (kind === "highlight" || kind === "underline") {
    const rect = normalizeRect(value.rect)
    return rect ? { ...base, kind, rect } : null
  }
  if (kind === "comment") {
    const point = normalizePoint(value.point)
    if (!point) {
      return null
    }
    return {
      ...base,
      kind,
      point,
      text: normalizeCommentText(value.text),
    }
  }

  const line = normalizeLine(value.line)
  return line ? { ...base, kind: "arrow", line } : null
}

function normalizeAnnotationKind(value: unknown): ArtifactAnnotationKind | null {
  return value === "highlight"
    || value === "comment"
    || value === "underline"
    || value === "arrow"
    ? value
    : null
}

function normalizeAnnotationColor(value: unknown): ArtifactAnnotationColor | null {
  return value === "yellow" || value === "purple" || value === "blue" || value === "pink"
    ? value
    : null
}

function normalizeAnnotationSource(value: unknown): ArtifactAnnotationSource | null {
  return value === "sophia" || value === "user" ? value : null
}

function normalizeRect(value: unknown): NormalizedArtifactRect | null {
  if (!isRecord(value)) {
    return null
  }
  const x = clampNormalizedNumber(value.x)
  const y = clampNormalizedNumber(value.y)
  const width = clampNormalizedNumber(value.width)
  const height = clampNormalizedNumber(value.height)
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null
  }
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y),
  }
}

function normalizePoint(value: unknown): NormalizedArtifactPoint | null {
  if (!isRecord(value)) {
    return null
  }
  const x = clampNormalizedNumber(value.x)
  const y = clampNormalizedNumber(value.y)
  return x === null || y === null ? null : { x, y }
}

function normalizeLine(value: unknown): NormalizedArtifactLine | null {
  if (!isRecord(value)) {
    return null
  }
  const start = normalizePoint(value.start)
  const end = normalizePoint(value.end)
  if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y) <= 0.001) {
    return null
  }
  return { start, end }
}

function normalizeCommentText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\r\n\t]+/gu, " ").slice(0, MAX_COMMENT_TEXT_LENGTH)
    : ""
}

function normalizePageIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.floor(value)
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return Math.floor(value)
}

function clampNormalizedNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null
  }
  return Math.min(1, Math.max(0, value))
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
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

function safeRemoveItem(storage: Storage, key: string) {
  try {
    storage.removeItem(key)
  } catch {
    // Storage cleanup is best-effort.
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
